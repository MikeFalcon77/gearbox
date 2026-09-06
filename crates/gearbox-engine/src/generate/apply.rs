//! The only writer.
//!
//! Two functions, and the split between them is the whole safety story.
//! [`plan`] reads the output tree and reports what applying would do; it writes
//! nothing, which is what makes `--dry-run` and `gearbox/generate/plan` a
//! preview of the real thing rather than a description of it
//! (`cpt-gearbox-fr-generate-preview`). [`apply_generate`] performs that plan.
//!
//! **The apply is staged.** Every file is prepared in memory -- including the
//! three-way merges, which are where a failure is actually likely -- and
//! nothing is written until every one of them has succeeded. ADR
//! `cpt-gearbox-adr-authoring-ownership-tiers` requires this, and the reason it
//! requires it is that the alternative leaves a tree that is half of one product
//! and half of another, which nothing downstream can detect.
//!
//! **The merge base.** An `OperatorOwned` file is reconciled against the copy of
//! *our previous output* cached in `.gearbox/<product>/.base/`, not against the
//! operator's file and not against nothing. That is what lets the merge tell
//! "the operator changed this line" from "we changed this line": without a base,
//! any difference looks like both.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use gearbox_ir::{
    Diagnostic, DiagnosticCode, Diagnostics, FileAction, FileEntry, FilePlan, FileSet, Location,
    Ownership, RelPath,
};

use super::GenerateError;

/// Where the previous run's output is cached, relative to `<product>/`.
///
/// A sibling of the profile directories rather than a child, because the base
/// is per file path and the same operator file is not regenerated per profile.
const BASE_DIR: &str = ".base";

/// What one file would become, with the bytes to prove it.
struct Staged {
    path: RelPath,
    entry: FileEntry,
    action: FileAction,
    /// The bytes to write, which for a merged file are neither the proposal nor
    /// what is on disk.
    final_bytes: Vec<u8>,
}

/// What an apply did.
pub struct ApplyOutcome {
    pub plans: Vec<FilePlan>,
    pub diagnostics: Diagnostics,
    /// How many files were actually written.
    pub written: usize,
}

/// What applying `files` under `out_root` would do, without doing it.
///
/// # Errors
/// Returns [`GenerateError::Io`] when the existing tree cannot be read. A file
/// that cannot be read is not treated as absent: that would turn a permissions
/// problem into a silent overwrite.
pub fn plan(
    files: &FileSet,
    out_root: &Path,
    base_root: &Path,
) -> Result<(Vec<FilePlan>, Diagnostics), GenerateError> {
    let (staged, diagnostics) = stage(files, out_root, base_root)?;
    Ok((staged.iter().map(to_plan).collect(), diagnostics))
}

/// Write `files` under `out_root`, staging every byte first.
///
/// # Errors
/// Returns [`GenerateError::Io`] when the tree cannot be read or written.
/// Errors during staging leave the tree untouched; an error during the write
/// phase is reported with the path that failed.
pub fn apply_generate(
    files: &FileSet,
    out_root: &Path,
    base_root: &Path,
) -> Result<ApplyOutcome, GenerateError> {
    let (staged, diagnostics) = stage(files, out_root, base_root)?;

    // Refuse to write anything if any file conflicted. A partial apply beside
    // an unresolved conflict is the state ADR
    // `cpt-gearbox-adr-authoring-ownership-tiers` calls a half-written
    // repository, and the operator cannot tell it from a finished one.
    if diagnostics.has_errors() {
        return Ok(ApplyOutcome {
            plans: staged.iter().map(to_plan).collect(),
            diagnostics,
            written: 0,
        });
    }

    let staging = out_root.join(".apply-staging");
    let staging_base = base_root.join(".apply-staging");
    clear_tree(&staging);
    clear_tree(&staging_base);

    let published = publish_staged(&staged, out_root, base_root, &staging, &staging_base);

    clear_tree(&staging);
    clear_tree(&staging_base);

    Ok(ApplyOutcome {
        plans: staged.iter().map(to_plan).collect(),
        diagnostics,
        written: published?,
    })
}

fn publish_staged(
    staged: &[Staged],
    out_root: &Path,
    base_root: &Path,
    staging: &Path,
    staging_base: &Path,
) -> Result<usize, GenerateError> {
    let mut written = 0;
    for file in staged {
        if !file.action.writes() {
            continue;
        }
        write_file(&staging.join(file.path.as_str()), &file.final_bytes)?;
        if matches!(file.entry.ownership, Ownership::OperatorOwned) {
            write_file(&staging_base.join(file.path.as_str()), &file.entry.bytes)?;
        }
        written += 1;
    }

    for file in staged {
        if !file.action.writes() {
            continue;
        }
        publish(
            &staging.join(file.path.as_str()),
            &out_root.join(file.path.as_str()),
        )?;
        if matches!(file.entry.ownership, Ownership::OperatorOwned) {
            publish(
                &staging_base.join(file.path.as_str()),
                &base_root.join(file.path.as_str()),
            )?;
        }
    }
    Ok(written)
}

/// Decide every file's fate and produce the bytes for it, touching nothing.
fn stage(
    files: &FileSet,
    out_root: &Path,
    base_root: &Path,
) -> Result<(Vec<Staged>, Diagnostics), GenerateError> {
    let mut diagnostics = Diagnostics::new();
    let mut staged = Vec::with_capacity(files.len());

    for entry in files {
        let target = out_root.join(entry.path.as_str());
        let existing = read_optional(&target)?;

        let (action, final_bytes) = match (entry.ownership, existing) {
            (_, None) => (FileAction::Create, entry.bytes.clone()),

            (Ownership::Generated, Some(current)) => {
                if current == entry.bytes {
                    (FileAction::Unchanged, current)
                } else {
                    (FileAction::Update, entry.bytes.clone())
                }
            }

            // The whole contract: written once, then it is the human's.
            (Ownership::GeneratedOnce, Some(current)) => (FileAction::Kept, current),

            (Ownership::OperatorOwned, Some(current)) => {
                let base = read_optional(&base_root.join(entry.path.as_str()))?;
                merge_operator_file(entry, &current, base.as_deref(), &mut diagnostics)
            }
        };

        staged.push(Staged {
            path: entry.path.clone(),
            entry: entry.clone(),
            action,
            final_bytes,
        });
    }

    diagnostics.finish();
    Ok((staged, diagnostics))
}

/// Reconcile an operator-owned file against the base we last wrote.
///
/// Three inputs, and the base is the one that carries the information: without
/// it every line that differs looks like it differs for both reasons at once,
/// and the only safe answer would be "conflict, always". With it, a line only
/// the operator moved is theirs, a line only we moved is ours, and a line both
/// moved is the genuine conflict `GBX0701` reports.
fn merge_operator_file(
    entry: &FileEntry,
    current: &[u8],
    base: Option<&[u8]>,
    diagnostics: &mut Diagnostics,
) -> (FileAction, Vec<u8>) {
    let conflict = |diagnostics: &mut Diagnostics, why: &str| {
        diagnostics.push(clobber(entry, why));
        (FileAction::Conflict, current.to_vec())
    };

    let Some(base) = base else {
        // No base means we have never written this file, yet it exists. It is
        // the operator's from before we arrived, and we have nothing to
        // attribute our own changes against. Refusing is the only honest
        // answer; adopting it would silently discard whatever they wrote.
        return if current == entry.bytes {
            (FileAction::Unchanged, current.to_vec())
        } else {
            conflict(
                diagnostics,
                "the file predates any output of ours, so there is no base to merge against",
            )
        };
    };

    if current == base {
        // Untouched since we wrote it, so it is ours to update.
        return if current == entry.bytes {
            (FileAction::Unchanged, current.to_vec())
        } else {
            (FileAction::Update, entry.bytes.clone())
        };
    }
    if base == entry.bytes {
        // We propose exactly what we proposed last time; every difference is
        // the operator's, so there is nothing to apply.
        return (FileAction::Unchanged, current.to_vec());
    }

    let (Ok(base_text), Ok(current_text), Ok(proposed_text)) = (
        std::str::from_utf8(base),
        std::str::from_utf8(current),
        std::str::from_utf8(&entry.bytes),
    ) else {
        return conflict(
            diagnostics,
            "the file is not UTF-8, so it cannot be merged line by line",
        );
    };

    match super::merge3::merge(base_text, current_text, proposed_text) {
        super::merge3::Merge::Merged(merged) if merged.as_bytes() == current => {
            (FileAction::Unchanged, current.to_vec())
        }
        super::merge3::Merge::Merged(merged) => (FileAction::Update, merged.into_bytes()),
        super::merge3::Merge::Conflict => conflict(
            diagnostics,
            "your edits and the regenerated content change the same lines",
        ),
    }
}

/// `GBX0701`.
fn clobber(entry: &FileEntry, why: &str) -> Diagnostic {
    Diagnostic::error(
        DiagnosticCode::GenClobberOperatorFile,
        format!("`{}` was left untouched: {why}", entry.path),
        "the file is operator-owned, so generation never overwrites it; reconcile it by hand, \
         or delete it to accept the generated content wholesale",
    )
    .at(Location::file(format!("file://{}", entry.path)))
}

fn to_plan(staged: &Staged) -> FilePlan {
    FilePlan {
        path: staged.path.clone(),
        action: staged.action,
        ownership: staged.entry.ownership,
        kind: staged.entry.kind,
        blake3: format!("blake3:{}", blake3::hash(&staged.final_bytes).to_hex()),
        preview_available: std::str::from_utf8(&staged.final_bytes).is_ok(),
    }
}

/// The bytes at `path`, or `None` if nothing is there.
///
/// Only `NotFound` becomes `None`. A permissions error or a directory in the
/// way is returned, because treating either as absence would make the next step
/// an overwrite.
fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, GenerateError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(GenerateError::Io {
            what: "cannot read",
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), GenerateError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|source| GenerateError::Io {
            what: "cannot create",
            path: parent.to_path_buf(),
            source,
        })?;
    }
    std::fs::write(path, bytes).map_err(|source| GenerateError::Io {
        what: "cannot write",
        path: path.to_path_buf(),
        source,
    })
}

fn publish(from: &Path, to: &Path) -> Result<(), GenerateError> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|source| GenerateError::Io {
            what: "cannot create",
            path: parent.to_path_buf(),
            source,
        })?;
    }
    std::fs::rename(from, to).map_err(|source| GenerateError::Io {
        what: "cannot publish",
        path: to.to_path_buf(),
        source,
    })
}

fn clear_tree(path: &Path) {
    if path.is_file() {
        drop(std::fs::remove_file(path));
    } else {
        drop(std::fs::remove_dir_all(path));
    }
}

/// The base cache directory for a product, given its output root.
///
/// `.gearbox/<product>/<profile>/` -> `.gearbox/<product>/.base/`. Returns the
/// output root itself if it has no parent, which cannot happen for a path this
/// module builds but is a better answer than a panic.
#[must_use]
pub fn base_root_for(out_root: &Path) -> PathBuf {
    out_root
        .parent()
        .map_or_else(|| out_root.join(BASE_DIR), |product| product.join(BASE_DIR))
}

/// Group a plan by action, for a one-line summary.
#[must_use]
pub fn summarize(plans: &[FilePlan]) -> BTreeMap<FileAction, usize> {
    let mut counts = BTreeMap::new();
    for plan in plans {
        *counts.entry(plan.action).or_insert(0) += 1;
    }
    counts
}
