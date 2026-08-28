//! Finding `gear.gdl` files and assembling them into a [`Catalogue`].

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use gearbox_gdl::GdlEngine;
use gearbox_gdl::engine::FileIdentity;
use gearbox_ir::{
    Catalogue, ContractDescriptor, ContractId, Diagnostic, DiagnosticCode, Diagnostics, GearId,
    Location, RelPath,
};

use crate::source::SourceRoot;

/// The name a gear's description must have, so discovery is a filename match
/// rather than a heuristic.
pub const GEAR_FILE: &str = "gear.gdl";

/// Directory names never worth descending into.
///
/// `target` alone would save most of the time, but a `node_modules` under
/// `ide/` and a `.git` object store are both large enough to matter and can
/// never contain a gear description.
const SKIP_DIRS: &[&str] = &["target", "node_modules", ".git", ".gearbox"];

/// A catalogue plus everything that went wrong building it.
#[derive(Debug)]
pub struct CatalogueScan {
    pub catalogue: Catalogue,
    /// The description files that were read, in the order they were evaluated.
    pub files: Vec<PathBuf>,
}

/// Find and evaluate every `gear.gdl` under each root, in one catalogue.
///
/// Discovery is sorted before evaluation, so the catalogue does not depend on
/// the order the filesystem happens to hand back directory entries
/// (`cpt-gearbox-nfr-determinism`). Ordered maps do the rest.
///
/// A file that fails to evaluate contributes its diagnostics and is otherwise
/// skipped: one malformed description should not hide the other seven.
#[must_use]
pub fn load_catalogue(roots: &[SourceRoot]) -> CatalogueScan {
    let gdl = GdlEngine::new();
    let mut catalogue = Catalogue::default();
    let mut diagnostics = Diagnostics::new();
    let mut files = Vec::new();

    for root in roots {
        catalogue
            .sources
            .insert(root.id.clone(), root.to_resolved());

        for path in discover(&root.root) {
            files.push(path.clone());

            let Some(identity) = identity_for(root, &path, &mut diagnostics) else {
                continue;
            };

            let source = match std::fs::read_to_string(&path) {
                Ok(s) => s,
                Err(e) => {
                    diagnostics.push(
                        Diagnostic::error(
                            DiagnosticCode::GdlEval,
                            format!("cannot read `{}`: {e}", path.display()),
                            "check the file's permissions",
                        )
                        .at(Location::file(identity.uri.clone())),
                    );
                    continue;
                }
            };

            let outcome = gdl.eval_gear(&identity, &source);
            diagnostics.extend(outcome.diagnostics);

            let Some(decl) = outcome.value else { continue };

            // The declared half is in hand; now project the half the Rust
            // attributes own and merge. A projection failure is fatal for this
            // gear -- under ADR `cpt-gearbox-adr-macro-projected-catalogue` the
            // catalogue cannot be assembled without it, which is a deliberate
            // trade recorded in the PRD's risk table.
            let Some(merged) = project_and_merge(root, &identity, &decl, &mut diagnostics) else {
                continue;
            };

            let id = merged.gear.id.clone();
            if let Some(previous) = catalogue.gears.insert(id.clone(), merged.gear) {
                diagnostics.push(
                    Diagnostic::error(
                        DiagnosticCode::GdlCardinality,
                        format!(
                            "gear `{id}` is declared twice: `{}` and `{}`",
                            previous.gdl_path, identity.gdl_path
                        ),
                        "one of the descriptions points at the wrong crate, or names the wrong                          attribute with `attr = \"...\"`",
                    )
                    .at(Location::file(identity.uri.clone())),
                );
            }
            merge_contracts(&mut catalogue.contracts, merged.contracts, &id);
        }
    }

    diagnostics.finish();
    catalogue.diagnostics = diagnostics;
    CatalogueScan { catalogue, files }
}

/// Project the Rust half for one description and merge it with the declared half.
///
/// Returns `None` when the gear attribute cannot be located or parsed. Both are
/// reported: an unlocatable attribute is GBX0211 and lists the candidates plus
/// the `attr` line to add, which is the difference between an actionable error
/// and a dead end.
fn project_and_merge(
    root: &SourceRoot,
    identity: &FileIdentity,
    decl: &gearbox_gdl::GearDecl,
    diagnostics: &mut Diagnostics,
) -> Option<crate::merge::MergedGear> {
    let package = decl.package.as_ref()?;
    let crate_dir = crate::merge::crate_dir(&root.root, &identity.gdl_path, &package.path);
    let label = format!("{} ({})", package.crate_name, crate_dir.display());

    let files = match gearbox_project::scan_crate(&crate_dir) {
        Ok(files) => files,
        Err(e) => {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::GdlEval,
                    format!("cannot read the crate `{label}` this description points at: {e}"),
                    "check `package = cargo(..., path = \"...\")`; it is relative to the                      description's own directory",
                )
                .at(Location::file(identity.uri.clone())),
            );
            return None;
        }
    };

    let site = match gearbox_project::locate_gear_attribute(&files, &label, package.attr.as_deref())
    {
        Ok(site) => site,
        Err(e) => {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::ValidateAttributeAmbiguous,
                    e.to_string(),
                    "add `attr = \"src/....rs\"` to the description's `package = cargo(...)`                      to name which attribute this description describes",
                )
                .at(Location::file(identity.uri.clone()))
                .with_evidence("cpt-gearbox-fr-attribute-location"),
            );
            return None;
        }
    };

    let projected = match gearbox_project::project_gear(&site) {
        Ok(p) => p,
        Err(e) => {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::GdlEval,
                    format!("cannot read the gear attribute in `{label}`: {e}"),
                    "the attribute does not parse; the crate would not compile either",
                )
                .at(Location::file(identity.uri.clone())),
            );
            return None;
        }
    };

    // Contracts live in the SDK crates the description names, which is why
    // `sdk` stays declared: it locates them without restating them.
    let mut contracts_by_trait = BTreeMap::new();
    let mut sdk_dirs: Vec<std::path::PathBuf> = decl
        .provides
        .iter()
        .map(|p| &p.sdk)
        .chain(decl.consumes.iter().map(|c| &c.sdk))
        .map(|sdk| crate::merge::crate_dir(&root.root, &identity.gdl_path, &sdk.path))
        .collect();
    sdk_dirs.sort();
    sdk_dirs.dedup();

    for sdk_dir in sdk_dirs {
        match gearbox_project::scan_crate(&sdk_dir) {
            Ok(sdk_files) => {
                for contract in gearbox_project::project_contracts(&sdk_files) {
                    contracts_by_trait.insert(contract.trait_ident.clone(), contract);
                }
            }
            Err(e) => diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::GdlEval,
                    format!("cannot read the sdk crate `{}`: {e}", sdk_dir.display()),
                    "check `sdk = cargo(..., path = \"...\")`",
                )
                .at(Location::file(identity.uri.clone())),
            ),
        }
    }

    // Cluster: profiles come free from the crate scan above; providers cost one
    // extra scan per declared plugin crate, which only `cluster` itself declares.
    let cluster = crate::cluster::project(&root.root, identity, decl, &files, diagnostics);
    // Plugin facts cost one SDK scan, and only for gears that declare `sdk`.
    let plugin = crate::plugin::project(&root.root, identity, decl, &files, diagnostics);

    crate::merge::merge(
        identity,
        decl,
        &projected,
        &contracts_by_trait,
        &cluster,
        &plugin,
        diagnostics,
    )
}

/// Insert contracts, letting the owner's description win.
///
/// A contract is described twice on purpose: the provider declares it fully,
/// and each consumer restates its Rust path so the consumer's generated client
/// needs nothing from the provider's file. The provider's copy is the complete
/// one -- it carries the transport projections -- so it takes precedence, and a
/// consumer's copy only fills a gap when the provider is out of scope.
///
/// `declared_by` is the gear whose file these came from, which is what makes
/// "is this the owner's copy" an exact question rather than a guess about
/// whether a missing projection means absent or merely unstated.
fn merge_contracts(
    into: &mut BTreeMap<ContractId, ContractDescriptor>,
    contracts: Vec<ContractDescriptor>,
    declared_by: &GearId,
) {
    for contract in contracts {
        let from_owner = contract.owner == *declared_by;
        if from_owner || !into.contains_key(&contract.id) {
            into.insert(contract.id.clone(), contract);
        }
    }
}

/// Build the identity to record for a discovered file.
fn identity_for(
    root: &SourceRoot,
    path: &Path,
    diagnostics: &mut Diagnostics,
) -> Option<FileIdentity> {
    let uri = format!("file://{}", path.display());

    let relative = path.strip_prefix(&root.root).ok().and_then(|r| {
        // Forward slashes regardless of platform: the path goes into a lock
        // that must be byte-identical everywhere.
        let text = r
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        RelPath::new(text).ok()
    });

    let Some(gdl_path) = relative else {
        diagnostics.push(
            Diagnostic::error(
                DiagnosticCode::GdlEval,
                format!(
                    "`{}` is not inside its source root `{}`",
                    path.display(),
                    root.root.display()
                ),
                "move the description inside the declared source root",
            )
            .at(Location::file(uri)),
        );
        return None;
    };

    Some(FileIdentity {
        uri,
        source: root.id.clone(),
        gdl_path,
        // A `load()` resolves from the description's own directory and may not
        // climb above the source root.
        load_paths: Some(gearbox_gdl::engine::LoadPaths {
            base: path.parent().unwrap_or(&root.root).to_path_buf(),
            root: root.root.clone(),
        }),
    })
}

/// Every `gear.gdl` under `root`, sorted.
fn discover(root: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            // Keep files; prune only uninteresting directories.
            !entry.file_type().is_dir()
                || entry
                    .file_name()
                    .to_str()
                    .is_none_or(|name| !SKIP_DIRS.contains(&name))
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == GEAR_FILE)
        .map(walkdir::DirEntry::into_path)
        .collect();

    found.sort();
    found
}
