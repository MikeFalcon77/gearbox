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
use std::path::PathBuf;

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
    root: &crate::SourceRoot,
    identity: &FileIdentity,
    decl: &GearDecl,
    files: &[RustFile],
    scans: &mut crate::scans::CrateScans,
    diagnostics: &mut Diagnostics,
) -> ClusterProjection {
    // An unreadable or invalid `const NAME` is reported rather than dropped: a
    // dropped profile reads as a crate that implements none, which makes
    // `check_profiles` raise ClusterProfileNotImplemented against a crate that
    // does implement it.
    let profiles = match gearbox_project::project_cluster_profiles(files) {
        Ok(found) => found.into_iter().map(|p| p.name).collect(),
        Err(e) => {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::ClusterProviderUnprojectable,
                    format!("a cluster profile marker cannot be read: {e}"),
                    "`ClusterProfile::NAME` must be a string literal or a `&str` const in the \
                     same crate, and must be a valid profile id (kebab-case): the SDK turns it \
                     into `ClientScope::new(\"cluster:{name}\")`",
                )
                .at(Location::file(identity.uri.as_str().to_owned())),
            );
            Vec::new()
        }
    };

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
    /// The struct each primitive's options are deserialized into, if declared.
    options: BTreeMap<ClusterPrimitive, String>,
    /// Which option carries the credential, if the plugin says.
    credential_option: Option<String>,
    files: std::sync::Arc<[RustFile]>,
}

/// The three `*_options` names a `cluster_plugin(...)` may carry, by primitive.
fn declared_options(
    record: &gearbox_gdl::records::ClusterPluginRecord,
) -> BTreeMap<ClusterPrimitive, String> {
    let mut out = BTreeMap::new();
    for (primitive, declared) in [
        (ClusterPrimitive::Cache, &record.cache_options),
        (
            ClusterPrimitive::LeaderElection,
            &record.leader_election_options,
        ),
        (ClusterPrimitive::Lock, &record.lock_options),
    ] {
        if let Some(root) = declared {
            out.insert(primitive, root.clone());
        }
    }
    out
}

fn providers(
    root: &crate::SourceRoot,
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
        let dir = match crate::merge::crate_dir(
            root,
            &identity.gdl_path,
            &record.package.path,
            &record.package.crate_name,
        ) {
            Ok(dir) => dir,
            Err(e) => {
                diagnostics.push(crate::merge::bad_crate_path(
                    uri,
                    "cluster_plugin.package",
                    &record.package.path,
                    &e,
                    record.package.declared_at.as_ref(),
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
                        options: declared_options(record),
                        credential_option: record.credential_option.clone(),
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

    let registrations = match gearbox_project::project_provider_registry(files, uri) {
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

        let read = match gearbox_project::project_backend_capabilities(
            &plugin.files,
            reg.primitive,
            &scanned,
            plugin.backend.as_deref(),
        ) {
            Ok(read) => read,
            Err(e) => {
                diagnostics.push(unprojectable(uri, &e));
                continue;
            }
        };

        // A capability the backend computes is recorded on the provider rather
        // than reported here. Reporting at projection time would put three
        // permanent `info`s on every catalogue load, about a provider no product
        // need ever name -- and the corpus is held to loading with no
        // diagnostics at all. The resolver says it where it bites instead.
        let capabilities = read.declared;

        // **The options schema, from the struct the backend already reads.**
        // Projected here rather than declared again: every one of them is a
        // `#[derive(Deserialize)]` with `#[serde(deny_unknown_fields)]`, so the
        // authority for what a key may be exists in Rust and only the join key
        // was missing. A declaration naming a struct that cannot be read is an
        // error rather than a fall back to the untyped bag -- falling back would
        // make every option validate, silently, because nothing was checking.
        let options = match plugin.options.get(&reg.primitive) {
            None => None,
            Some(root) => match gearbox_project::project_config_fields(&plugin.files, root) {
                Ok(fields) => Some(crate::config::schema_of(root.clone(), &fields)),
                Err(e) => {
                    diagnostics.push(
                        Diagnostic::error(
                            DiagnosticCode::ClusterProviderOptionsUnprojectable,
                            format!(
                                "`{}_options = \"{root}\"` on the `{}` plugin cannot be read: {e}",
                                reg.primitive.config_key(),
                                reg.plugin_lib
                            ),
                            "the name is resolved against that plugin crate alone; check the \
                             spelling, and that the struct has named fields and serde attributes \
                             this can read to their end",
                        )
                        .at(Location::file(uri.to_owned())),
                    );
                    None
                }
            },
        };

        let entry = by_name
            .entry(name.clone())
            .or_insert_with(|| ClusterProviderDecl {
                name,
                primitives: std::collections::BTreeSet::new(),
                capabilities: BTreeMap::new(),
                process_local: plugin.process_local,
                needs_credentials: plugin.needs_credentials,
                runtime_determined: std::collections::BTreeSet::new(),
                options: BTreeMap::new(),
                gated_by: BTreeMap::new(),
                credential_option: plugin.credential_option.clone(),
            });
        entry.primitives.insert(reg.primitive);
        // Recorded per primitive, because one provider can register some
        // unconditionally and others behind a feature -- which is not
        // hypothetical: if the k8s plugin ever registered a cache in every
        // build and its leader election only under the feature, a
        // provider-level flag would have to lie about one of them.
        match &reg.gated_by {
            gearbox_project::FeatureGate::Always => {}
            gearbox_project::FeatureGate::Feature(name) => {
                entry.gated_by.insert(
                    reg.primitive,
                    gearbox_ir::FeatureGate::Feature(name.clone()),
                );
            }
            gearbox_project::FeatureGate::Unreadable(cfg) => {
                entry.gated_by.insert(
                    reg.primitive,
                    gearbox_ir::FeatureGate::Unreadable(cfg.clone()),
                );
            }
        }
        entry.capabilities.insert(reg.primitive, capabilities);
        if let Some(schema) = options {
            entry.options.insert(reg.primitive, schema);
        }
        if !read.runtime_determined.is_empty() {
            entry.runtime_determined.insert(reg.primitive);
        }
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
