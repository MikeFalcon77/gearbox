//! Finding `gear.gdl` files and assembling them into a [`Catalogue`].

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use gearbox_gdl::GdlEngine;
use gearbox_gdl::engine::FileIdentity;
use gearbox_ir::{
    Catalogue, ContractDescriptor, ContractId, Diagnostic, DiagnosticCode, Diagnostics,
    GearDescriptor, GearId, LoadStage, Location, PendingGear, RelPath,
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
    /// How many distinct crates were parsed.
    ///
    /// Reported because the cache is otherwise invisible: the catalogue is
    /// identical with or without it, which is the point, so this is the only
    /// thing a test can hold on to.
    pub crates_scanned: usize,
    /// How many scans were asked for, cache hits included.
    ///
    /// The gap between this and `crates_scanned` is the parsing avoided.
    pub scan_requests: usize,
    /// Gears declared but not projected.
    ///
    /// **Empty when a load runs to completion.** Non-empty only when the event
    /// callback asked to stop, which is what makes a cancelled load degrade to a
    /// smaller catalogue rather than to none. If this is ever non-empty after an
    /// uninterrupted load, gears are going missing silently.
    pub pending: Vec<PendingGear>,
}

/// What happened during a staged load.
///
/// Borrowed rather than owned: an event is handed to the callback while the load
/// still holds the value, so forwarding one over RPC means serializing it, not
/// taking it. That keeps the loader from paying for clones a caller may not want.
#[derive(Debug)]
pub enum LoadEvent<'a> {
    /// Discovery finished. `total` descriptions were found across all roots.
    ///
    /// First and once, so a progress bar has a denominator before any work that
    /// could take a while.
    Discovered { total: usize },

    /// One description was evaluated. Its declared facts are now known.
    Declared(&'a PendingGear),

    /// Every description has been evaluated; parsing is about to begin.
    ///
    /// The boundary between the two passes, and a real one rather than a
    /// convenience: it is the moment a registry view has its whole shape and
    /// none of its badges. A consumer that needs to answer "the tree is ready"
    /// would otherwise have to infer it from the first `Projected`, which does
    /// not arrive at all when every gear fails to project.
    DeclarationComplete { declared: usize },

    /// One gear finished projection and entered the catalogue.
    Projected(&'a GearDescriptor),
}

/// Whether the load should keep going.
///
/// Returned by the event callback, which is what makes `$/cancelRequest`
/// implementable without the loader knowing anything about RPC. Stopping leaves
/// what is already projected valid and the rest in `CatalogueScan::pending`,
/// rather than discarding the work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Continue {
    Yes,
    Stop,
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
    load_catalogue_staged(roots, &mut |_| Continue::Yes)
}

/// The same load, reporting each stage as it completes.
///
/// Two passes, not one per gear, and the order is the point: **every description
/// is evaluated before any crate is parsed.** A registry view can therefore show
/// its whole shape -- names grouped by category -- while the expensive stage is
/// still running, instead of watching rows trickle in one complete gear at a
/// time. See ADR `cpt-gearbox-adr-staged-catalogue-loading` for the measured
/// costs; the second pass is roughly ten times the first on a real tree.
///
/// Synchronous, with a callback. Threads belong to whoever wants them: the RPC
/// server runs this on a worker and forwards events as notifications, and the
/// engine keeps no dependency on parallelism.
#[must_use]
pub fn load_catalogue_staged(
    roots: &[SourceRoot],
    on_event: &mut dyn FnMut(LoadEvent<'_>) -> Continue,
) -> CatalogueScan {
    let gdl = GdlEngine::new();
    let mut catalogue = Catalogue::default();
    let mut diagnostics = Diagnostics::new();
    // One cache per load: a crate named by several gears is parsed once.
    let mut scans = crate::scans::CrateScans::new();

    for root in roots {
        catalogue
            .sources
            .insert(root.id.clone(), root.to_resolved());
    }

    // ---- S0: discover -------------------------------------------------------
    let discovered: Vec<(&SourceRoot, PathBuf)> = roots
        .iter()
        .flat_map(|root| discover(&root.root).into_iter().map(move |p| (root, p)))
        .collect();

    let files: Vec<PathBuf> = discovered.iter().map(|(_, p)| p.clone()).collect();
    if on_event(LoadEvent::Discovered {
        total: discovered.len(),
    }) == Continue::Stop
    {
        diagnostics.finish();
        catalogue.diagnostics = diagnostics;
        return CatalogueScan {
            catalogue,
            files,
            crates_scanned: 0,
            scan_requests: 0,
            pending: Vec::new(),
        };
    }

    // ---- S1: evaluate every description ------------------------------------
    let mut declared: Vec<(&SourceRoot, FileIdentity, gearbox_gdl::GearDecl)> = Vec::new();
    let mut pending: Vec<PendingGear> = Vec::new();
    let mut stopped = false;

    for (root, path) in &discovered {
        let Some(identity) = identity_for(root, path, &mut diagnostics) else {
            continue;
        };

        let source = match std::fs::read_to_string(path) {
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

        let entry = PendingGear {
            source: root.id.clone(),
            gdl_path: identity.gdl_path.clone(),
            stage: LoadStage::Declared,
            display_name: decl.name.clone(),
            description: decl.description.clone(),
            category: decl.category.clone(),
        };
        if on_event(LoadEvent::Declared(&entry)) == Continue::Stop {
            stopped = true;
        }
        pending.push(entry);
        declared.push((root, identity, decl));

        if stopped {
            break;
        }
    }

    if !stopped
        && on_event(LoadEvent::DeclarationComplete {
            declared: declared.len(),
        }) == Continue::Stop
    {
        stopped = true;
    }

    // ---- S2..S4: project and merge -----------------------------------------
    if !stopped {
        for (root, identity, decl) in &declared {
            // The declared half is in hand; now project the half the Rust
            // attributes own and merge. A projection failure is fatal for this
            // gear -- under ADR `cpt-gearbox-adr-macro-projected-catalogue` the
            // catalogue cannot be assembled without it, which is a deliberate
            // trade recorded in the PRD's risk table.
            let merged = project_and_merge(root, identity, decl, &mut scans, &mut diagnostics);

            // Whether it projected or not, it is no longer in flight: a failure
            // is represented by its diagnostics, not by staying pending forever.
            pending.retain(|p| p.gdl_path != identity.gdl_path);

            let Some(merged) = merged else { continue };

            let id = merged.gear.id.clone();
            if let Some(previous) = catalogue.gears.insert(id.clone(), merged.gear) {
                diagnostics.push(
                    Diagnostic::error(
                        DiagnosticCode::GdlCardinality,
                        format!(
                            "gear `{id}` is declared twice: `{}` and `{}`",
                            previous.gdl_path, identity.gdl_path
                        ),
                        "one of the descriptions points at the wrong crate, or names the wrong \
                         attribute with `attr = \"...\"`",
                    )
                    .at(Location::file(identity.uri.clone())),
                );
            }
            merge_contracts(&mut catalogue.contracts, merged.contracts, &id);

            // Borrowed from the catalogue, so the callback sees the merged gear
            // rather than a copy made for its benefit.
            if let Some(stored) = catalogue.gears.get(&id)
                && on_event(LoadEvent::Projected(stored)) == Continue::Stop
            {
                break;
            }
        }
    }

    diagnostics.finish();
    catalogue.diagnostics = diagnostics;
    CatalogueScan {
        catalogue,
        files,
        crates_scanned: scans.distinct_crates(),
        scan_requests: scans.scan_requests(),
        pending,
    }
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
    scans: &mut crate::scans::CrateScans,
    diagnostics: &mut Diagnostics,
) -> Option<crate::merge::MergedGear> {
    let package = decl.package.as_ref()?;
    let crate_dir = crate::merge::crate_dir(&root.root, &identity.gdl_path, &package.path);
    let label = format!("{} ({})", package.crate_name, crate_dir.display());

    let files = match scans.get(&crate_dir) {
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
        match scans.get(&sdk_dir) {
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
    let cluster = crate::cluster::project(&root.root, identity, decl, &files, scans, diagnostics);
    // Plugin facts cost one SDK scan, and only for gears that declare `sdk`.
    // The SDK crate is scanned once and shared: both the plugin projection and
    // the GTS one read it, and it is the expensive step.
    let sdk_files = match decl.sdk.as_ref() {
        None => std::sync::Arc::from(Vec::new()),
        Some(sdk) => {
            let sdk_dir = crate::merge::crate_dir(&root.root, &identity.gdl_path, &sdk.path);
            match scans.get(&sdk_dir) {
                Ok(files) => files,
                Err(e) => {
                    diagnostics.push(
                        Diagnostic::error(
                            DiagnosticCode::GdlEval,
                            format!("cannot read the sdk crate `{}`: {e}", sdk_dir.display()),
                            "check `sdk = cargo(..., path = \"...\")`; the path is relative to \
                             the description's own directory",
                        )
                        .at(Location::file(identity.uri.clone())),
                    );
                    std::sync::Arc::from(Vec::new())
                }
            }
        }
    };

    let plugin = crate::plugin::project(identity, decl, &files, &sdk_files, diagnostics);

    // GTS types a gear *exposes* are the ones declared in its SDK; a type in the
    // main crate is internal and a `gts_id!` reference is not a declaration.
    //
    // A plugin points at its *host's* SDK, so the types declared there belong to
    // the host, not to each of its implementations. Without this, one plugin-spec
    // type declared once in `authn-resolver-sdk` would be reported by the host
    // and by all of its plugins alike.
    let sdk_is_the_hosts = plugin.fills.as_ref().is_some_and(|f| {
        decl.sdk
            .as_ref()
            .is_some_and(|sdk| f.point.sdk_lib == sdk.lib_ident)
    });

    let gts_types = if sdk_is_the_hosts {
        Vec::new()
    } else {
        match gearbox_project::project_gts_types(&sdk_files) {
            Ok(types) => types
                .into_iter()
                .map(|t| gearbox_ir::GtsTypeDecl {
                    type_id: t.type_id,
                    description: t.description,
                    relative: t.relative,
                })
                .collect(),
            Err(e) => {
                diagnostics.push(
                    Diagnostic::error(
                        DiagnosticCode::GdlEval,
                        format!("cannot project GTS types: {e}"),
                        "the declaration shape is not modelled; see gearbox-project's gts module",
                    )
                    .at(Location::file(identity.uri.clone())),
                );
                Vec::new()
            }
        }
    };

    // Documents: pure filesystem lookup, no parsing, so it costs a few stats.
    let gdl_dir = crate::merge::crate_dir(&root.root, &identity.gdl_path, ".");
    let docs = crate::docs::project(&root.root, &gdl_dir, identity, decl, diagnostics);

    crate::merge::merge(
        identity,
        decl,
        crate::merge::Projections {
            gear: &projected,
            contracts_by_trait: &contracts_by_trait,
            cluster: &cluster,
            plugin: &plugin,
            docs,
            gts_types,
        },
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
