//! Assembling a [`GearDescriptor`] from its two halves.
//!
//! Under ADR `cpt-gearbox-adr-macro-projected-catalogue` each fact has exactly
//! one author. The Rust attributes own the gear's identity, capabilities,
//! co-location dependencies, lifecycle and client trait, plus the identity,
//! version and kind of every contract. The description owns presentation, the
//! crate reference, transports, projections, endpoints, cluster requirements
//! and criticality. This module is the only place the two meet, which is why
//! the split is legible here rather than smeared across the codebase.
//!
//! Nothing in here *compares* the halves, because there is nothing to compare:
//! that was the old cross-check design, and its diagnostics (GBX0201-0205) are
//! retired.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use gearbox_gdl::GearDecl;
use gearbox_gdl::engine::FileIdentity;
use gearbox_ir::contract::{GrpcProjection, RestProjection, RestVisibility};
use gearbox_ir::requirement::ClusterPrimitive;
use gearbox_ir::{
    CapabilityId, CargoRef, ContractDescriptor, ContractId, ContractVersion, DeclaredRole,
    Diagnostic, DiagnosticCode, Diagnostics, EndpointDecl, GearDescriptor, GearId, LifecycleDecl,
    Location, ProviderDescriptor, RelPath, Requirement, RequirementId, RequirementKind, RuntimeCap,
    Transport, Visibility,
};
use gearbox_project::{ProjectedContract, ProjectedGear};

/// A gear plus the contracts its description referenced.
#[derive(Debug)]
pub struct MergedGear {
    pub gear: GearDescriptor,
    pub contracts: Vec<ContractDescriptor>,
}

/// An error attributable to the description.
fn invalid(uri: &str, message: impl Into<String>, help: impl Into<String>) -> Diagnostic {
    Diagnostic::error(DiagnosticCode::GdlEval, message, help).at(Location::file(uri.to_owned()))
}

/// Merge the projected and declared halves.
///
/// Returns `None` only when the gear has no usable identity. Anything else is
/// reported and skipped, so one bad contract reference does not hide the rest of
/// the file.
pub fn merge(
    identity: &FileIdentity,
    decl: &GearDecl,
    projected: &ProjectedGear,
    contracts_by_trait: &BTreeMap<String, ProjectedContract>,
    cluster: &crate::cluster::ClusterProjection,
    diagnostics: &mut Diagnostics,
) -> Option<MergedGear> {
    let uri = identity.uri.as_str();

    // Projected: `#[toolkit::gear(name = "...")]`. `GearId::new` enforces
    // exactly the rule the macro enforces, so a name the macro would reject
    // cannot enter the catalogue.
    let id = match GearId::new(&projected.name) {
        Ok(id) => id,
        Err(e) => {
            diagnostics.push(invalid(
                uri,
                format!(
                    "the gear attribute declares name `{}`, which is not a valid gear id: {e}",
                    projected.name
                ),
                "fix `#[toolkit::gear(name = \"...\")]` in the gear's source",
            ));
            return None;
        }
    };

    // The one cross-check the projected catalogue still needs, and it only
    // applies to gears that consume: `#[toolkit::consumes]` derives its
    // endpoint-override config key from the kebab-case of the struct
    // identifier, not from `name`, so a mismatch makes that key unreachable and
    // the runtime only warns. Gears that consume nothing are unaffected --
    // three of the eight slice gears differ here harmlessly.
    if !decl.consumes.is_empty() {
        use heck::ToKebabCase;
        let derived = projected.struct_ident.to_kebab_case();
        if derived != projected.name {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::ValidateOwnerGearMismatch,
                    format!(
                        "gear `{id}` declares contract consumption, but kebab-case of its struct \
                         `{}` is `{derived}`, not `{}`. #[toolkit::consumes] derives the \
                         consumer_wiring config key from the struct identifier, so the override \
                         key would be unreachable.",
                        projected.struct_ident, projected.name
                    ),
                    format!(
                        "rename the struct to match, or set name = \"{derived}\" in \
                         #[toolkit::gear]"
                    ),
                )
                .at(Location::file(uri.to_owned()))
                .with_evidence("libs/toolkit-contract-macros/src/consumes.rs:183"),
            );
        }
    }

    let Some(package_record) = decl.package.as_ref() else {
        // eval_gear already reported this; defensive.
        return None;
    };
    let package = cargo_ref(package_record);

    // Projected: the closed set of seven, parsed through the IR's own parser so
    // the spellings cannot drift from the macro's.
    let mut runtime_caps = BTreeSet::new();
    for spelling in &projected.runtime_caps {
        match RuntimeCap::parse(spelling) {
            Some(cap) => {
                runtime_caps.insert(cap);
            }
            None => diagnostics.push(invalid(
                uri,
                format!(
                    "the gear attribute declares capability `{spelling}`, which is not one of the \
                     seven the runtime defines"
                ),
                "fix `capabilities = [...]` in the gear's source",
            )),
        }
    }

    // Projected: link-time co-location. The macro emits a hidden re-export per
    // entry, so a missing dependency is a hard registry error at startup, and
    // the resolver can never sever these edges.
    let mut colocated_deps = BTreeSet::new();
    for dep in &projected.colocated_deps {
        match GearId::new(dep) {
            Ok(dep) => {
                colocated_deps.insert(dep);
            }
            Err(e) => diagnostics.push(invalid(
                uri,
                format!("the gear attribute declares dependency `{dep}`, which is not a valid gear id: {e}"),
                "fix `deps = [...]` in the gear's source",
            )),
        }
    }

    let mut contracts = Vec::new();
    let mut provides = Vec::new();
    for record in &decl.provides {
        let Some(projected_contract) =
            lookup(&record.contract, contracts_by_trait, uri, diagnostics)
        else {
            continue;
        };
        if let Some((provider, contract)) =
            build_provider(uri, &id, record, projected_contract, diagnostics)
        {
            provides.push(provider);
            contracts.push(contract);
        }
    }

    let mut consumes = Vec::new();
    for (ordinal, record) in decl.consumes.iter().enumerate() {
        let Some(projected_contract) =
            lookup(&record.contract, contracts_by_trait, uri, diagnostics)
        else {
            continue;
        };
        if let Some((requirement, contract)) =
            build_consumer(uri, &id, record, projected_contract, ordinal, diagnostics)
        {
            consumes.push(requirement);
            contracts.push(contract);
        }
    }

    let mut requires = Vec::new();
    for (ordinal, record) in decl.requires.iter().enumerate() {
        match cluster_requirement(&id, record, ordinal) {
            Ok(requirement) => requires.push(requirement),
            Err(e) => diagnostics.push(invalid(uri, e, "check the cluster requirement")),
        }
    }
    crate::cluster::check_profiles(uri, &id, &requires, cluster, diagnostics);
    report_cluster_colocation(uri, &id, &requires, projected, diagnostics);

    let declared_roles: Vec<DeclaredRole> = decl
        .declared_roles
        .iter()
        .map(|r| DeclaredRole {
            name: r.name.clone(),
            directory_name: r.directory_name.clone(),
            sharded: r.sharded,
            instance_addressable: r.instance_addressable,
        })
        .collect();
    report_role_gaps(uri, &id, &declared_roles, diagnostics);

    let visibility = match decl.visibility.as_deref() {
        None | Some("internal") => Visibility::Internal,
        Some("public") => Visibility::Public,
        Some(other) => {
            diagnostics.push(invalid(
                uri,
                format!("unknown visibility `{other}`"),
                "use \"public\" or \"internal\"",
            ));
            Visibility::Internal
        }
    };

    let gear = GearDescriptor {
        display_name: decl.name.clone().unwrap_or_else(|| id.to_string()),
        id,
        description: decl.description.clone(),
        category: decl.category.clone(),
        visibility,
        source: identity.source.clone(),
        gdl_path: identity.gdl_path.clone(),
        package,
        runtime_caps,
        colocated_deps,
        // Projected.
        lifecycle: projected.lifecycle.as_ref().map(|l| LifecycleDecl {
            entry: l.entry.clone(),
            stop_timeout: l.stop_timeout.clone(),
            await_ready: l.await_ready,
        }),
        provides,
        consumes,
        requires,
        serves: decl
            .serves
            .iter()
            .map(|e| EndpointDecl {
                name: e.name.clone(),
                config_key: e.config_key.clone(),
                default_port: e.default_port,
                via: e.via.clone(),
            })
            .collect(),
        // Projected.
        client_trait: projected.client_trait.clone(),
        // Projected from `provider_registry()` plus the plugin crates
        // `cluster_plugins` locates.
        cluster_providers: cluster.providers.clone(),
        declared_roles,
        config_schema: decl
            .config_schema
            .as_deref()
            .and_then(|p| RelPath::new(p).ok()),
    };

    Some(MergedGear { gear, contracts })
}

/// Find the projected contract a `provide`/`consume` joins to by trait name.
fn lookup<'a>(
    trait_name: &str,
    contracts: &'a BTreeMap<String, ProjectedContract>,
    uri: &str,
    diagnostics: &mut Diagnostics,
) -> Option<&'a ProjectedContract> {
    let found = contracts.get(trait_name);
    if found.is_none() {
        let mut known: Vec<&str> = contracts.keys().map(String::as_str).collect();
        known.sort_unstable();
        diagnostics.push(invalid(
            uri,
            format!(
                "no `#[toolkit::contract]` trait named `{trait_name}` was found in the declared \
                 sdk crate(s)"
            ),
            if known.is_empty() {
                "check that `sdk = cargo(...)` points at the crate declaring the contract"
                    .to_owned()
            } else {
                format!("traits found: {}", known.join(", "))
            },
        ));
    }
    found
}

fn cargo_ref(record: &gearbox_gdl::records::CargoRecord) -> CargoRef {
    CargoRef {
        crate_name: record.crate_name.clone(),
        lib_ident: record.lib_ident.clone(),
        path: RelPath::new(&record.path).unwrap_or_else(|_| RelPath::here()),
        features: record.features.clone(),
        default_features: record.default_features,
        link: if record.link.is_empty() {
            vec![record.lib_ident.clone()]
        } else {
            record.link.clone()
        },
    }
}

/// Build the contract id from the projected identity.
fn contract_id(projected: &ProjectedContract) -> Result<(ContractId, ContractVersion), String> {
    let version = ContractVersion::parse(&projected.version).map_err(|e| {
        format!(
            "`#[toolkit::contract(version = \"{}\")]` on `{}` is not a version Gearbox can \
             order: {e}",
            projected.version, projected.trait_ident
        )
    })?;
    let id = ContractId::new(format!(
        "{}/{}@{}",
        projected.gear, projected.base_name, version.declared
    ))
    .map_err(|e| {
        format!(
            "cannot build a contract id for `{}`: {e}",
            projected.trait_ident
        )
    })?;
    Ok((id, version))
}

fn build_provider(
    uri: &str,
    owner: &GearId,
    record: &gearbox_gdl::records::ProvideRecord,
    projected: &ProjectedContract,
    diagnostics: &mut Diagnostics,
) -> Option<(ProviderDescriptor, ContractDescriptor)> {
    let (id, version) = match contract_id(projected) {
        Ok(parts) => parts,
        Err(e) => {
            diagnostics.push(invalid(
                uri,
                e,
                "fix the contract attribute in the SDK crate",
            ));
            return None;
        }
    };

    let mut transports = BTreeSet::new();
    for spelling in &record.transports {
        match spelling.as_str() {
            "local" => transports.insert(Transport::Local),
            "rest" => transports.insert(Transport::Rest),
            "grpc" => transports.insert(Transport::Grpc),
            other => {
                diagnostics.push(invalid(
                    uri,
                    format!("unknown transport `{other}`"),
                    "use a `transport.*` member",
                ));
                false
            }
        };
    }
    // A provider always has an in-process form.
    transports.insert(Transport::Local);

    let provider = ProviderDescriptor {
        contract: id.clone(),
        provider_gear: owner.clone(),
        local_factory: record.local.clone(),
        transports,
        policies: record.policies.clone(),
    };

    let contract = ContractDescriptor {
        id,
        // Projected: the contract belongs to whichever gear its attribute names.
        owner: GearId::new(&projected.gear).unwrap_or_else(|_| owner.clone()),
        base_name: projected.base_name.clone(),
        version,
        kind: projected.kind,
        rust_path: record.rust.clone(),
        sdk: cargo_ref(&record.sdk),
        rest: record.rest.as_ref().map(|r| RestProjection {
            base_path: r.base_path.clone(),
            visibility: match r.visibility.as_deref() {
                Some("internal") => RestVisibility::Internal,
                _ => RestVisibility::Exposed,
            },
            require_full_coverage: r.require_full_coverage,
        }),
        grpc: record.grpc.as_ref().map(|g| GrpcProjection {
            package: g.package.clone(),
            service: g.service.clone(),
            stubs_module: g.stubs_module.clone(),
        }),
    };

    Some((provider, contract))
}

fn build_consumer(
    uri: &str,
    consumer: &GearId,
    record: &gearbox_gdl::records::ConsumeRecord,
    projected: &ProjectedContract,
    ordinal: usize,
    diagnostics: &mut Diagnostics,
) -> Option<(Requirement, ContractDescriptor)> {
    let (id, version) = match contract_id(projected) {
        Ok(parts) => parts,
        Err(e) => {
            diagnostics.push(invalid(
                uri,
                e,
                "fix the contract attribute in the SDK crate",
            ));
            return None;
        }
    };

    // Projected: the owner is whichever gear the contract attribute names. The
    // declared `from_` is the product-level statement of which gear is expected
    // to supply it, and the two can legitimately differ if a description points
    // at a different provider of the same contract.
    let owner = match GearId::new(&projected.gear) {
        Ok(id) => id,
        Err(e) => {
            diagnostics.push(invalid(
                uri,
                format!(
                    "contract `{}` names owner `{}`, which is not a valid gear id: {e}",
                    projected.trait_ident, projected.gear
                ),
                "fix `#[toolkit::contract(gear = \"...\")]`",
            ));
            return None;
        }
    };

    let from = match GearId::new(&record.from) {
        Ok(id) => id,
        Err(e) => {
            diagnostics.push(invalid(
                uri,
                format!("invalid `from_` gear `{}`: {e}", record.from),
                "name the providing gear by its kebab-case id",
            ));
            return None;
        }
    };

    let requirement_id =
        match RequirementId::new(format!("{consumer}#contract.consumes[{ordinal}]")) {
            Ok(rid) => rid,
            Err(e) => {
                diagnostics.push(invalid(uri, format!("internal: {e}"), "report this"));
                return None;
            }
        };

    let requirement = Requirement {
        id: requirement_id,
        requester: consumer.clone(),
        kind: RequirementKind::Contract {
            contract: id.clone(),
            from,
            resolving_client: record.resolving_client.clone(),
        },
        capabilities: BTreeSet::new(),
        critical: record.critical,
    };

    let contract = ContractDescriptor {
        id,
        owner,
        base_name: projected.base_name.clone(),
        version,
        kind: projected.kind,
        rust_path: record.rust.clone(),
        sdk: cargo_ref(&record.sdk),
        rest: None,
        grpc: None,
    };

    Some((requirement, contract))
}

fn cluster_requirement(
    requester: &GearId,
    record: &gearbox_gdl::records::ClusterRequireRecord,
    ordinal: usize,
) -> Result<Requirement, String> {
    let primitive = ClusterPrimitive::ALL
        .iter()
        .copied()
        .find(|p| p.slug() == record.primitive)
        .ok_or_else(|| format!("unknown cluster primitive `{}`", record.primitive))?;

    let id = RequirementId::new(format!(
        "{requester}#cluster.{}[{ordinal}]",
        primitive.slug()
    ))
    .map_err(|e| format!("internal: {e}"))?;

    let capabilities = record
        .capabilities
        .iter()
        .map(|c| CapabilityId::new(c).map_err(|e| format!("invalid capability `{c}`: {e}")))
        .collect::<Result<BTreeSet<_>, _>>()?;

    Ok(Requirement {
        id,
        requester: requester.clone(),
        kind: RequirementKind::Cluster {
            primitive,
            scope: record.scope.clone(),
        },
        capabilities,
        critical: false,
    })
}

/// Roles are recorded for forward compatibility and refused, with evidence.
fn report_role_gaps(uri: &str, id: &GearId, roles: &[DeclaredRole], diagnostics: &mut Diagnostics) {
    if roles.is_empty() {
        return;
    }
    diagnostics.push(
        Diagnostic::new(
            DiagnosticCode::GapRoles,
            format!(
                "gear `{id}` declares {} role(s), recorded but excluded from resolution: the \
                 runtime takes a worker's directory identity from a name fixed in its binary, \
                 with no configuration override",
                roles.len()
            ),
        )
        .at(Location::file(uri.to_owned()))
        .with_evidence("libs/toolkit/src/bootstrap/oop.rs (OopRunOptions.gear_name)")
        .with_help("remove the roles, or keep them knowing they do nothing today"),
    );
    if roles.iter().any(|r| r.sharded || r.instance_addressable) {
        diagnostics.push(
            Diagnostic::new(
                DiagnosticCode::GapShards,
                format!("gear `{id}` requests sharding or per-instance addressing, which the runtime cannot express"),
            )
            .at(Location::file(uri.to_owned()))
            .with_evidence("libs/system-sdks/sdks/directory/src/labels.rs (equality-only selectors; in-process gears carry no labels)")
            .with_help("drop `sharded`/`instance_addressable`"),
        );
    }
}

/// Record that a cluster requirement is a co-location constraint today.
///
/// Not a complaint about the description -- `deps = [cluster]` is the correct and
/// only way to express this right now. The hint exists because the constraint is
/// invisible in the description: nothing in `cluster.cache(...)` hints that it
/// pins the consumer into the cluster gear's process, and a reader planning a
/// multi-process topology needs to know before the resolver refuses.
///
/// The decided direction is a separately deployable cluster gear, which would
/// make this edge severable. That design is unimplemented, so this states
/// today's constraint and cites where the other one is written down.
fn report_cluster_colocation(
    uri: &str,
    id: &GearId,
    requires: &[Requirement],
    projected: &ProjectedGear,
    diagnostics: &mut Diagnostics,
) {
    if requires.is_empty() {
        return;
    }
    // Only meaningful for a consumer, not for the cluster gear itself.
    if !projected
        .colocated_deps
        .iter()
        .any(|d| d == CLUSTER_GEAR_NAME)
    {
        return;
    }

    diagnostics.push(
        Diagnostic::new(
            DiagnosticCode::GapClusterNotDeployable,
            format!(
                "gear `{id}` requires {} cluster primitive(s), which pins it into the same \
                 process as `{CLUSTER_GEAR_NAME}`: the cluster gear registers backends in the \
                 process-local `ClientHub` and exposes no remote surface, so a consumer in \
                 another process resolves nothing",
                requires.len()
            ),
        )
        .at(Location::file(uri.to_owned()))
        .with_evidence(
            "gears/system/cluster/cluster-sdk/src/cache/resolver.rs (scoped ClientHub lookup, \
             no remote path); gears/system/cluster/docs/DESIGN-DEPLOYABLE-GEAR.md (deployable \
             cluster is proposed, not implemented)",
        )
        .with_help("keep `deps = [cluster]`; it is what makes the requirement resolvable today"),
    );
}

/// The cluster gear's runtime name, as `#[toolkit::gear(name = ...)]` spells it.
const CLUSTER_GEAR_NAME: &str = "cluster";

/// Resolve the crate directory a description's `package` points at.
#[must_use]
pub fn crate_dir(source_root: &Path, gdl_path: &RelPath, package_path: &str) -> std::path::PathBuf {
    let gdl_dir = gdl_path.parent();
    let joined = gdl_dir
        .resolve(package_path)
        .unwrap_or_else(|_| gdl_dir.clone());
    if joined.is_here() {
        source_root.to_path_buf()
    } else {
        source_root.join(joined.as_str())
    }
}
