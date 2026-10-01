//! Resolving every `DiagnosticCode::prevents` against the real `gears-rust`.
//!
//! This is the check the column exists for. A reference that no longer resolves
//! is a claim the tool is still making about a runtime that has moved, and
//! prose could never fail out loud about it.
//!
//! **Skipping is a real risk here, not a formality.** `test_corpus`'s own
//! comment records a suite that reported success having exercised none of the
//! corpus, from a git worktree, silently. So the skip prints, and
//! `GEARBOX_CORPUS_REQUIRED=1` turns it into a failure for the runs that are
//! supposed to be authoritative.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use gearbox_ir::{DiagnosticCode, RuntimeErrorRef};

use crate::error_enum::{ProjectedErrorEnum, project_error_enums};
use crate::manifest::project_manifest;
use crate::scan::scan_crate;
use crate::test_corpus::corpus_root;

/// Every package name in the corpus, mapped to the directory declaring it.
///
/// By walking for `Cargo.toml` rather than asking `cargo metadata`: no
/// toolchain invocation, no network, no lockfile, and it works on a checkout
/// that does not build. The reference names a *package*, so this is the index
/// that answers it.
fn packages(root: &Path) -> BTreeMap<String, PathBuf> {
    let mut found = BTreeMap::new();
    let walk = walkdir::WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            !matches!(
                entry.file_name().to_str(),
                Some("target" | ".git" | "node_modules")
            )
        });
    for entry in walk.flatten() {
        if entry.file_name() != "Cargo.toml" {
            continue;
        }
        let Some(dir) = entry.path().parent() else {
            continue;
        };
        // A virtual workspace manifest declares no `[package]`, which
        // `project_manifest` reports as an error. Not every `Cargo.toml` is a
        // package, so that is a skip rather than a failure.
        if let Ok(manifest) = project_manifest(dir) {
            found
                .entry(manifest.package_name)
                .or_insert_with(|| dir.to_path_buf());
        }
    }
    found
}

/// The enums a crate declares, by identifier, with duplicates kept.
///
/// Kept rather than collapsed because two enums of one name in one crate make
/// the lookup ambiguous, and the caller must refuse instead of picking.
fn by_ident(enums: Vec<ProjectedErrorEnum>) -> BTreeMap<String, Vec<ProjectedErrorEnum>> {
    let mut out: BTreeMap<String, Vec<ProjectedErrorEnum>> = BTreeMap::new();
    for item in enums {
        out.entry(item.ident.clone()).or_default().push(item);
    }
    out
}

/// Check one reference, returning a complaint rather than panicking.
///
/// Collected rather than asserted so that a `gears-rust` bump renaming three
/// things reports all three in one run. Finding out about the second only after
/// fixing the first is how a dependency bump becomes an afternoon.
fn complain(
    code: DiagnosticCode,
    reference: RuntimeErrorRef,
    enums: &BTreeMap<String, Vec<ProjectedErrorEnum>>,
) -> Option<String> {
    let declared = enums.get(reference.ty)?;
    let found = declared.first()?;
    if declared.len() > 1 {
        return Some(format!(
            "`{code}` names `{}`, and `{}` declares {} enums of that name",
            reference.ty,
            reference.krate,
            declared.len()
        ));
    }

    let Some(variant) = found
        .variants
        .iter()
        .find(|variant| variant.ident == reference.variant)
    else {
        let known: Vec<&str> = found.variants.iter().map(|v| v.ident.as_str()).collect();
        return Some(format!(
            "`{code}` names `{}::{}`, which `{}` no longer declares. It has: {}",
            reference.ty,
            reference.variant,
            reference.krate,
            known.join(", ")
        ));
    };

    let canonical = reference.canonical?;

    // The wire code is looked up across the whole crate, not on the enum above:
    // in `cluster-sdk` the `#[derive(ContractError)]` sits on a *twin* of the
    // enum the prose names, paired with it by hand. Requiring the variant
    // identifiers to match is what holds that hand-maintained pairing together.
    let carriers: Vec<(
        &ProjectedErrorEnum,
        &crate::error_enum::ProjectedErrorVariant,
    )> = enums
        .values()
        .flatten()
        .flat_map(|item| item.variants.iter().map(move |variant| (item, variant)))
        .filter(|(_, variant)| variant.code.as_deref() == Some(canonical.code))
        .collect();

    match carriers.as_slice() {
        [] => Some(format!(
            "`{code}` names error code `{}`, which nothing in `{}` carries",
            canonical.code, reference.krate
        )),
        [(owner, wire)] => {
            if wire.domain.as_deref() != Some(canonical.domain) {
                return Some(format!(
                    "`{code}` names `{}`/`{}`, but `{}::{}` carries domain {:?}",
                    canonical.domain, canonical.code, owner.ident, wire.ident, wire.domain
                ));
            }
            if wire.ident != variant.ident {
                return Some(format!(
                    "`{code}` names `{}::{}` and code `{}`, but that code is on \
                     `{}::{}` -- the local error and its wire twin have stopped agreeing",
                    reference.ty, reference.variant, canonical.code, owner.ident, wire.ident
                ));
            }
            None
        }
        many => Some(format!(
            "`{code}` names error code `{}`, which {} variants in `{}` carry",
            canonical.code,
            many.len(),
            reference.krate
        )),
    }
}

/// What to do about the corpus.
///
/// Separated from *finding* it so the decision can be tested. On a machine that
/// has the checkout -- which is every machine this test is interesting on --
/// the skip arm is unreachable, and an unreachable arm that decides whether a
/// suite reports anything is exactly the kind that quietly stops working. The
/// filesystem half stays untested here and does not need to be: sixteen other
/// corpus tests exercise `corpus_root` on every run.
#[derive(Debug, PartialEq, Eq)]
enum Corpus {
    /// Resolve the references against this checkout.
    Resolve(PathBuf),
    /// No checkout, and none was demanded: say so and pass.
    Skip,
    /// No checkout, and the run said it required one.
    Demanded,
}

fn decide(root: Option<PathBuf>, required: bool) -> Corpus {
    match (root, required) {
        (Some(root), _) => Corpus::Resolve(root),
        (None, true) => Corpus::Demanded,
        (None, false) => Corpus::Skip,
    }
}

#[test]
fn a_checkout_is_resolved_against_whether_or_not_it_was_demanded() {
    let root = PathBuf::from("/somewhere/gears-rust");
    assert_eq!(
        decide(Some(root.clone()), false),
        Corpus::Resolve(root.clone())
    );
    assert_eq!(decide(Some(root.clone()), true), Corpus::Resolve(root));
}

#[test]
fn a_missing_checkout_skips_unless_the_run_demanded_one() {
    // The arm that cannot be reached from a working checkout, and the reason
    // this decision is a function. `test_corpus`'s own comment records a suite
    // that reported success having exercised none of the corpus; the demand
    // switch is the defence, so it is the thing to test.
    assert_eq!(decide(None, false), Corpus::Skip);
    assert_eq!(decide(None, true), Corpus::Demanded);
}

#[test]
fn every_prevented_error_still_exists_in_gears_rust() {
    let required = std::env::var("GEARBOX_CORPUS_REQUIRED").is_ok();
    let root = match decide(corpus_root(), required) {
        Corpus::Resolve(root) => root,
        Corpus::Demanded => {
            panic!("GEARBOX_CORPUS_REQUIRED is set and no `gears-rust` checkout is reachable")
        }
        Corpus::Skip => {
            eprintln!(
                "SKIP every_prevented_error_still_exists_in_gears_rust: no `gears-rust` \
                 checkout reachable, so no `prevents` reference was resolved. Set \
                 GEARBOX_CORPUS_REQUIRED=1 to make this a failure."
            );
            return;
        }
    };

    let referenced: Vec<(DiagnosticCode, RuntimeErrorRef)> = DiagnosticCode::ALL
        .iter()
        .filter_map(|code| code.prevents().as_ref().map(|reference| (*code, reference)))
        .collect();
    // Asserted rather than a silent return. An empty reference set is exactly
    // the regression this file exists to catch -- it means the `prevents` column
    // stopped being populated -- and returning made losing the column read as a
    // pass having resolved nothing.
    assert!(
        !referenced.is_empty(),
        "no `DiagnosticCode` carries a `prevents()` reference, so nothing was resolved; the \
         column this test exists for has stopped being populated"
    );

    let packages = packages(&root);
    let mut scanned: BTreeMap<&str, BTreeMap<String, Vec<ProjectedErrorEnum>>> = BTreeMap::new();
    let mut problems: Vec<String> = Vec::new();

    for (code, reference) in referenced {
        if !scanned.contains_key(reference.krate) {
            let Some(dir) = packages.get(reference.krate) else {
                // A package that no longer exists under that name is exactly
                // the break being watched, so this is a failure and not a skip.
                problems.push(format!(
                    "`{code}` names package `{}`, which the corpus does not declare",
                    reference.krate
                ));
                continue;
            };
            match scan_crate(dir) {
                Ok(files) => {
                    scanned.insert(reference.krate, by_ident(project_error_enums(&files)));
                }
                Err(error) => {
                    problems.push(format!(
                        "`{code}` names package `{}`, whose sources could not be read: {error}",
                        reference.krate
                    ));
                    continue;
                }
            }
        }
        let Some(enums) = scanned.get(reference.krate) else {
            continue;
        };
        if !enums.contains_key(reference.ty) {
            let known: Vec<&str> = enums.keys().map(String::as_str).collect();
            problems.push(format!(
                "`{code}` names enum `{}`, which `{}` does not declare. It declares {} enums: {}",
                reference.ty,
                reference.krate,
                known.len(),
                known.join(", ")
            ));
            continue;
        }
        problems.extend(complain(code, reference, enums));
    }

    assert!(
        problems.is_empty(),
        "`prevents` references that no longer resolve against `gears-rust`:\n  {}",
        problems.join("\n  ")
    );
}
