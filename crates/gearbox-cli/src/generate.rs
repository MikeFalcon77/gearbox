//! `gearbox generate` -- resolve, then write (or preview) the artefact tree.
//!
//! The command resolves rather than reading an existing lock, so a `--dry-run`
//! can never be answering about a stale one. The lock it produces is written
//! into the output root as part of the same file set, which is what makes
//! `gearbox lock gears` answerable from inside a generated tree.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use gearbox_engine::generate::{GenerateInput, base_root_for, summarize};
use gearbox_ir::{Diagnostic, FileAction, FilePlan, ProfileId};

use crate::{Format, open_roots, report};

/// Where generated output goes, relative to the working directory.
const OUTPUT_DIR: &str = ".gearbox";

/// Resolve `product` for `profile` and generate its artefacts.
///
/// # Errors
/// Returns an error when a source root cannot be opened, when the product
/// cannot be evaluated, or when generation or writing fails.
#[allow(
    clippy::too_many_arguments,
    reason = "one argument per command-line flag; bundling them into a struct would put the \
              clap definition and its consumer out of sight of one another"
)]
pub fn run(
    roots: &[PathBuf],
    source_id: Option<&str>,
    product_file: &Path,
    profile: Option<&str>,
    out: Option<&Path>,
    dry_run: bool,
    format: Format,
) -> anyhow::Result<ExitCode> {
    let opened = open_roots(roots, source_id)?;
    let scan = gearbox_engine::load_catalogue(&opened);

    let product_file = product_file
        .canonicalize()
        .unwrap_or_else(|_| product_file.to_path_buf());
    let product_scan = gearbox_engine::load_product(&product_file, None);
    let mut diagnostics: Vec<Diagnostic> = product_scan.diagnostics.as_slice().to_vec();
    let Some(intent) = product_scan.intent else {
        report(&diagnostics);
        anyhow::bail!("`{}` could not be evaluated", product_file.display());
    };

    let profile = match profile {
        Some(id) => ProfileId::new(id)?,
        None => intent.default_profile.clone(),
    };

    let resolution = gearbox_engine::resolve::resolve_at(
        &scan.catalogue,
        &intent,
        &profile,
        Some(&product_file),
    );
    let sources = gearbox_engine::lock_sources(&opened, &scan.catalogue, &product_file);
    let lock =
        gearbox_engine::resolve::product::assemble(&scan.catalogue, &intent, &resolution, sources);
    diagnostics.extend(lock.diagnostics.as_slice().iter().cloned());

    // A lock with errors in it describes a topology the resolver could not
    // finish deciding. Generating from it would produce a tree that compiles
    // into something nobody asked for, which is worse than producing nothing.
    if !lock.is_writable() {
        report(&diagnostics);
        anyhow::bail!("resolution reported errors; nothing was generated");
    }

    let out_root = absolute(out.map_or_else(
        || {
            Path::new(OUTPUT_DIR)
                .join(lock.product.id.as_str())
                .join(profile.as_str())
        },
        Path::to_path_buf,
    ))?;
    let base_root = base_root_for(&out_root);

    let source_roots: BTreeMap<_, _> = opened
        .iter()
        .map(|root| (root.id.clone(), root.root.clone()))
        .collect();
    let generated = gearbox_engine::generate(&GenerateInput {
        lock: &lock,
        source_roots: &source_roots,
        out_root: &out_root,
    })?;

    let (plans, apply_diagnostics, written) = if dry_run {
        let (plans, diagnostics) =
            gearbox_engine::generate::plan(&generated.files, &out_root, &base_root)?;
        (plans, diagnostics, 0)
    } else {
        let outcome = gearbox_engine::apply_generate(&generated.files, &out_root, &base_root)?;
        (outcome.plans, outcome.diagnostics, outcome.written)
    };
    diagnostics.extend(apply_diagnostics.as_slice().iter().cloned());

    match format {
        // stdout: the machine-readable contract, and the whole of it. A client
        // asking for the plan gets the plan, not the plan plus a summary line.
        Format::Json => println!("{}", serde_json::to_string_pretty(&plans)?),
        Format::Text => print_plans(&plans, &out_root, dry_run, written),
    }

    report(&diagnostics);
    Ok(if diagnostics.iter().any(|d| d.severity.is_error()) {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    })
}

/// Resolve a path against the working directory without requiring it to exist.
///
/// `canonicalize` is not usable here: the output root is usually a directory
/// generation is about to create.
fn absolute(path: PathBuf) -> anyhow::Result<PathBuf> {
    if path.is_absolute() {
        return Ok(path);
    }
    Ok(std::env::current_dir()?.join(path))
}

fn print_plans(plans: &[FilePlan], out_root: &Path, dry_run: bool, written: usize) {
    println!(
        "{} {}",
        if dry_run {
            "would write into"
        } else {
            "wrote into"
        },
        out_root.display()
    );
    for plan in plans {
        println!(
            "  {:<9} {:<15} {}",
            plan.action.as_str(),
            plan.ownership.as_str(),
            plan.path
        );
    }

    let counts = summarize(plans);
    let rendered: Vec<String> = counts
        .iter()
        .map(|(action, count)| format!("{count} {action}"))
        .collect();
    println!("  {}", rendered.join(", "));
    if !dry_run {
        println!("  {written} file(s) written");
    }
    if counts.contains_key(&FileAction::Conflict) {
        println!("  nothing was written: resolve the conflicts above and re-run");
    }
}
