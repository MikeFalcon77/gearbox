//! Assembling cluster providers from the plugin crates a description locates.
//!
//! The pieces come from three crates, which is why this lives in the engine
//! rather than in `gearbox-project`: only the engine knows where crates are on
//! disk. `gearbox-project` answers questions about a parsed crate; this one
//! decides which crates to parse.
//!
//! The chain, for `standalone`:
//!
//! 1. the *cluster* crate's `provider_registry()` yields
//!    `(cache, standalone_cluster_plugin, StandaloneCacheProvider)`
//! 2. `cluster_plugins` in `gear.gdl` maps `standalone_cluster_plugin` to a
//!    directory -- the one hop nothing in Rust can supply
//! 3. that crate's `impl ClusterCacheProvider` yields the name `"standalone"`,
//!    and its unique `impl ClusterCacheBackend` yields the capabilities

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use gearbox_gdl::GearDecl;
use gearbox_gdl::engine::FileIdentity;
use gearbox_ir::{
    ClusterPrimitive, ClusterProviderDecl, Diagnostic, DiagnosticCode, Diagnostics, Location,
};
use gearbox_project::{ClusterProjectionError, RustFile};

/// The cluster half of one gear's projection.
#[derive(Debug, Default)]
pub struct ClusterProjection {
    /// Providers this gear registers, keyed and ordered by provider name.
    pub providers: Vec<ClusterProviderDecl>,
    /// The profile names this gear's own crate implements, sorted.
    ///
    /// A gear's cluster requirements join against this. Empty is the normal
    /// case: a profile marker only exists in a crate that actually resolves a
    /// cluster primitive.
    pub profiles: Vec<String>,
}

/// Project the cluster facts for one gear.
///
/// `files` is the gear's own crate, already scanned for the gear attribute, so
/// profiles cost no extra I/O. Providers cost one scan per declared plugin crate
/// and are skipped entirely when a description declares no `cluster_plugins` --
/// which is every gear but `cluster` itself.
pub fn project(
    root: &Path,
    identity: &FileIdentity,
    decl: &GearDecl,
    files: &[RustFile],
    scans: &mut crate::scans::CrateScans,
    diagnostics: &mut Diagnostics,
) -> ClusterProjection {
    let profiles = gearbox_project::project_cluster_profiles(files)
        .into_iter()
        .map(|p| p.name)
        .collect();

    if decl.cluster_plugins.is_empty() {
        return ClusterProjection {
            providers: Vec::new(),
            profiles,
        };
    }

    ClusterProjection {
        providers: providers(root, identity, decl, files, scans, diagnostics),
        profiles,
    }
}

/// One declared plugin: where its crate is, plus the facts Rust does not state.
struct Plugin {
    dir: PathBuf,
    process_local: bool,
    needs_credentials: bool,
    /// Optional narrowing path to the backend impl, when the crate holds more
    /// than one and the trait alone cannot pick.
    backend: Option<String>,
    files: std::sync::Arc<[RustFile]>,
}

fn providers(
    root: &Path,
    identity: &FileIdentity,
    decl: &GearDecl,
    files: &[RustFile],
    scans: &mut crate::scans::CrateScans,
    diagnostics: &mut Diagnostics,
) -> Vec<ClusterProviderDecl> {
    let uri = identity.uri.as_str();

    // Scan each declared plugin crate once, keyed by library identifier -- which
    // is what the registry names it by.
    let mut plugins: BTreeMap<String, Plugin> = BTreeMap::new();
    for record in &decl.cluster_plugins {
        let dir = match crate::merge::crate_dir(root, &identity.gdl_path, &record.package.path) {
            Ok(dir) => dir,
            Err(e) => {
                diagnostics.push(crate::merge::bad_crate_path(
                    uri,
                    "cluster_plugin.package",
                    &record.package.path,
                    &e,
                ));
                continue;
            }
        };
        match scans.get(&dir) {
            Ok(files) => {
                plugins.insert(
                    record.package.lib_ident.clone(),
                    Plugin {
                        dir,
                        process_local: record.process_local,
                        needs_credentials: record.needs_credentials,
                        backend: record.backend.clone(),
                        files,
                    },
                );
            }
            Err(e) => diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::ClusterProviderUnprojectable,
                    format!(
                        "cannot read the cluster plugin crate `{}`: {e}",
                        dir.display()
                    ),
                    "check `cluster_plugins = [cluster_plugin(package = cargo(..., path = \"...\"))]`; \
                     the path is relative to the description's own directory",
                )
                .at(Location::file(uri.to_owned())),
            ),
        }
    }

    let registrations = match gearbox_project::project_provider_registry(files) {
        Ok(registrations) => registrations,
        Err(e) => {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::ClusterProviderUnprojectable,
                    format!("`provider_registry()` cannot be read: {e}"),
                    "each `with_*_provider` takes a provider path, optionally wrapped in \
                     `Arc::new`/`Box::new`; anything else leaves the catalogue with a partial \
                     registry, which reads as a provider nobody registered",
                )
                .at(Location::file(uri.to_owned())),
            );
            return Vec::new();
        }
    };
    if registrations.is_empty() {
        diagnostics.push(
            Diagnostic::error(
                DiagnosticCode::ClusterProviderUnprojectable,
                "no `with_*_provider` registrations found in `provider_registry()`".to_owned(),
                "the description declares `cluster_plugins`, so this crate is expected to \
                 assemble a provider registry; check that `provider_registry()` still returns \
                 a `ProviderRegistry::new().with_*_provider(..)` chain",
            )
            .at(Location::file(uri.to_owned())),
        );
        return Vec::new();
    }

    // A provider name can register more than one primitive -- postgres supplies
    // both a cache and a lock -- so accumulate by name rather than by
    // registration.
    let mut by_name: BTreeMap<String, ClusterProviderDecl> = BTreeMap::new();

    for reg in registrations {
        let Some(plugin) = plugins.get(&reg.plugin_lib) else {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::ClusterProviderUnprojectable,
                    format!(
                        "`provider_registry()` registers `{}::{}`, but no `cluster_plugin` \
                         declares where the crate `{}` is",
                        reg.plugin_lib, reg.provider_type, reg.plugin_lib
                    ),
                    "add it to `cluster_plugins`; the registry names a library identifier and \
                     nothing in Rust says which directory that is",
                )
                .at(Location::file(uri.to_owned())),
            );
            continue;
        };

        let scanned = plugin.dir.display().to_string();

        let name = match gearbox_project::project_provider_name(&plugin.files, &reg.provider_type) {
            Ok(name) => name,
            Err(e) => {
                diagnostics.push(unprojectable(uri, &e));
                continue;
            }
        };

        let capabilities = match gearbox_project::project_backend_capabilities(
            &plugin.files,
            reg.primitive,
            &scanned,
            plugin.backend.as_deref(),
        ) {
            Ok(caps) => caps,
            Err(e) => {
                diagnostics.push(unprojectable(uri, &e));
                continue;
            }
        };

        let entry = by_name
            .entry(name.clone())
            .or_insert_with(|| ClusterProviderDecl {
                name,
                primitives: std::collections::BTreeSet::new(),
                capabilities: BTreeMap::new(),
                process_local: plugin.process_local,
                needs_credentials: plugin.needs_credentials,
            });
        entry.primitives.insert(reg.primitive);
        entry.capabilities.insert(reg.primitive, capabilities);
    }

    by_name.into_values().collect()
}

/// Map a projection failure onto the code that names its remedy.
///
/// Ambiguity gets its own code because it has its own fix -- narrow the backend
/// in the description -- whereas everything else means the projection itself
/// needs work.
fn unprojectable(uri: &str, error: &ClusterProjectionError) -> Diagnostic {
    let (code, help) = match error {
        ClusterProjectionError::BackendAmbiguous { .. } => (
            DiagnosticCode::ClusterBackendAmbiguous,
            "add `backend = \"src/....rs\"` to this plugin's `cluster_plugin(...)` to name \
             which implementation the provider builds",
        ),
        _ => (
            DiagnosticCode::ClusterProviderUnprojectable,
            "capabilities are read from the backend's `consistency()`/`features()`; if the \
             plugin's shape changed, `gearbox-project`'s cluster projection must be updated",
        ),
    };
    Diagnostic::error(code, error.to_string(), help).at(Location::file(uri.to_owned()))
}

/// Report a cluster requirement whose profile no `impl ClusterProfile` supplies.
///
/// Startup would fail with `ProfileNotBound`, since the SDK resolves the scope
/// `cluster:{name}` and finds nothing registered. Catching it here is the whole
/// value of treating the profile as a join key rather than free text.
pub fn check_profiles(
    uri: &str,
    gear: &gearbox_ir::GearId,
    requires: &[gearbox_ir::Requirement],
    projection: &ClusterProjection,
    diagnostics: &mut Diagnostics,
) {
    for requirement in requires {
        let gearbox_ir::RequirementKind::Cluster {
            primitive, scope, ..
        } = &requirement.kind
        else {
            continue;
        };
        if projection.profiles.iter().any(|p| p == scope) {
            continue;
        }

        let known = if projection.profiles.is_empty() {
            "this crate implements no `ClusterProfile` at all".to_owned()
        } else {
            format!("implemented profiles: {}", projection.profiles.join(", "))
        };

        diagnostics.push(
            Diagnostic::error(
                DiagnosticCode::ClusterProfileNotImplemented,
                format!(
                    "gear `{gear}` requires `cluster.{}(profile = \"{scope}\")`, but {known}",
                    primitive_key(*primitive)
                ),
                "add `impl ClusterProfile for <Marker> { const NAME: &'static str = \"...\"; }` \
                 to the gear's crate, or correct the `profile` to one it already implements",
            )
            .at(Location::file(uri.to_owned())),
        );
    }
}

const fn primitive_key(primitive: ClusterPrimitive) -> &'static str {
    match primitive {
        ClusterPrimitive::Cache => "cache",
        ClusterPrimitive::LeaderElection => "leader_election",
        ClusterPrimitive::Lock => "lock",
    }
}
