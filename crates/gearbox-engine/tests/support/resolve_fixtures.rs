//! Hand-built catalogues and intents for resolver cases the real tree cannot show.
//!
//! Used only for shapes that do not and should not exist in `gears-rust` — a
//! co-location cycle, for instance, which the runtime's own topological sort
//! refuses at startup. Everything the real tree *can* demonstrate is tested
//! against the real tree instead, because a fixture agreeing with itself proves
//! nothing about the platform.

#![allow(dead_code, reason = "each resolver stage uses a different subset")]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not helpers"
)]

use std::collections::BTreeMap;

use gearbox_ir::{
    CargoRef, GearDescriptor, GearId, GearSelection, ProductIntent, ProfileId, RelPath, SourceId,
    Visibility,
};

pub fn gid(id: &str) -> GearId {
    GearId::new(id).unwrap()
}

pub fn source() -> SourceId {
    SourceId::new("fixture").unwrap()
}

/// The minimum a gear needs to take part in resolution.
///
/// Every optional field is left empty on purpose: a test that needs contracts or
/// capabilities sets them explicitly, so what a case depends on is visible in the
/// case rather than inherited from a fixture.
pub fn descriptor(id: &str) -> GearDescriptor {
    GearDescriptor {
        id: gid(id),
        display_name: id.to_owned(),
        description: None,
        category: None,
        visibility: Visibility::default(),
        source: source(),
        gdl_path: RelPath::new(format!("{id}/gear.gdl")).unwrap(),
        package: CargoRef {
            crate_name: format!("cf-{id}"),
            lib_ident: id.replace('-', "_"),
            path: RelPath::new(".").unwrap(),
            features: Vec::new(),
            default_features: true,
            link: Vec::new(),
        },
        runtime_caps: [].into_iter().collect(),
        colocated_deps: [].into_iter().collect(),
        lifecycle: None,
        provides: Vec::new(),
        consumes: Vec::new(),
        requires: Vec::new(),
        serves: Vec::new(),
        client_trait: None,
        cluster_providers: Vec::new(),
        extension_points: Vec::new(),
        fills: None,
        vendor_selector: None,
        declared_roles: Vec::new(),
        config_schema: None,
        docs: None,
        gts_types: Vec::new(),
    }
}

/// A product selecting exactly `gears`, with one embedded profile.
pub fn intent(gears: &[&str]) -> ProductIntent {
    let dev = ProfileId::new("dev").unwrap();
    ProductIntent {
        id: "fixture".to_owned(),
        display_name: "Fixture".to_owned(),
        version: "0.0.0".to_owned(),
        gdl_path: RelPath::new("product.gdl").unwrap(),
        sources: BTreeMap::new(),
        profiles: [(
            dev.clone(),
            gearbox_ir::DeploymentProfileDecl::Embedded { id: dev.clone() },
        )]
        .into_iter()
        .collect(),
        default_profile: dev,
        selected_gears: gears
            .iter()
            .map(|g| GearSelection {
                gear: gid(g),
                source: source(),
                features: Vec::new(),
                config: BTreeMap::new(),
                plugins: Vec::new(),
            })
            .collect(),
        bindings: Vec::new(),
        cluster_scopes: Vec::new(),
        process_pins: Vec::new(),
        preferences: Vec::new(),
    }
}

// -------------------------------------------------------------- cut fixtures
//
// Six catalogues for step 3. Each is the smallest shape that exercises one
// branch, because the real slice can demonstrate only two of them: it holds
// exactly one provider and exactly one declared edge.

use std::collections::BTreeSet;

use gearbox_ir::{
    Catalogue, ContractDescriptor, ContractId, ContractKind, ContractVersion, ProviderDescriptor,
    Requirement, RequirementId, RequirementKind, Transport,
};

fn cid(id: &str) -> ContractId {
    ContractId::new(id).unwrap()
}

/// A contract owned by `provider`, remote-capable unless told otherwise.
fn contract(base: &str, major: u32, kind: ContractKind) -> ContractDescriptor {
    let version = ContractVersion::from_major(major);
    ContractDescriptor {
        id: cid(&format!("provider/{base}@{}", version.declared)),
        owner: gid("provider"),
        base_name: base.to_owned(),
        version,
        kind,
        rust_path: format!("provider_sdk::{base}"),
        sdk: CargoRef {
            crate_name: "cf-provider-sdk".to_owned(),
            lib_ident: "provider_sdk".to_owned(),
            path: RelPath::new("provider-sdk").unwrap(),
            features: Vec::new(),
            default_features: true,
            link: Vec::new(),
        },
        rest: None,
        grpc: None,
    }
}

fn provides(contract: &ContractDescriptor, transports: &[Transport]) -> ProviderDescriptor {
    ProviderDescriptor {
        contract: contract.id.clone(),
        provider_gear: gid("provider"),
        local_factory: Some("Self::build_local".to_owned()),
        transports: transports.iter().copied().collect::<BTreeSet<_>>(),
        policies: Vec::new(),
    }
}

fn consumes(contract: &ContractId) -> Requirement {
    Requirement {
        id: RequirementId::new("host#contract.consumes[0]").unwrap(),
        requester: gid("host"),
        kind: RequirementKind::Contract {
            contract: contract.clone(),
            from: gid("provider"),
            resolving_client: None,
        },
        capabilities: BTreeSet::new(),
        critical: true,
    }
}

/// Assemble a two-gear catalogue from parts.
fn two_gears(
    contracts: Vec<ContractDescriptor>,
    provider_provides: Vec<ProviderDescriptor>,
    host_consumes: Vec<Requirement>,
    host_deps: &[&str],
) -> Catalogue {
    let mut catalogue = Catalogue::default();

    let mut host = descriptor("host");
    host.consumes = host_consumes;
    host.colocated_deps = host_deps.iter().map(|d| gid(d)).collect();
    catalogue.gears.insert(gid("host"), host);

    let mut provider = descriptor("provider");
    provider.provides = provider_provides;
    catalogue.gears.insert(gid("provider"), provider);

    for c in contracts {
        catalogue.contracts.insert(c.id.clone(), c);
    }
    catalogue
}

/// `host` pulls `provider` in with `deps` and declares nothing.
pub fn catalogue_with_provider_as_dep() -> Catalogue {
    let c = contract("Thing", 1, ContractKind::Api);
    let p = provides(&c, &[Transport::Local, Transport::Rest]);
    two_gears(vec![c], vec![p], Vec::new(), &["provider"])
}

/// The same pair with the edge declared and no `deps`.
pub fn catalogue_with_declared_edge() -> Catalogue {
    let c = contract("Thing", 1, ContractKind::Api);
    let p = provides(&c, &[Transport::Local, Transport::Rest]);
    let r = consumes(&c.id);
    two_gears(vec![c], vec![p], vec![r], &[])
}

/// Declared *and* co-located: the local lookup wins whatever the config says.
pub fn catalogue_with_declared_edge_and_dep() -> Catalogue {
    let c = contract("Thing", 1, ContractKind::Api);
    let p = provides(&c, &[Transport::Local, Transport::Rest]);
    let r = consumes(&c.id);
    two_gears(vec![c], vec![p], vec![r], &["provider"])
}

/// `host` consumes a contract nobody provides.
pub fn catalogue_missing_provider() -> Catalogue {
    let c = contract("Thing", 1, ContractKind::Api);
    let r = consumes(&c.id);
    two_gears(vec![c], Vec::new(), vec![r], &[])
}

/// `host` wants v1; `provider` offers v2 of the same family.
pub fn catalogue_wrong_major() -> Catalogue {
    let wanted = contract("Thing", 1, ContractKind::Api);
    let offered = contract("Thing", 2, ContractKind::Api);
    let p = provides(&offered, &[Transport::Local, Transport::Rest]);
    let r = consumes(&wanted.id);
    two_gears(vec![wanted, offered], vec![p], vec![r], &[])
}

/// Declared and remote-capable by kind, but the provider wires up no REST.
pub fn catalogue_local_only_provider() -> Catalogue {
    let c = contract("Thing", 1, ContractKind::Api);
    let p = provides(&c, &[Transport::Local]);
    let r = consumes(&c.id);
    two_gears(vec![c], vec![p], vec![r], &[])
}

/// Two gears sharing a co-located dependency, with a severable edge between them.
///
/// The shape the real slice cannot produce, and the one the whole design exists
/// for: `shared` ends up in **both** binaries, because a process is a closure and
/// closures overlap.
pub fn catalogue_with_overlap() -> Catalogue {
    let c = contract("Thing", 1, ContractKind::Api);
    let mut catalogue = Catalogue::default();

    let mut host = descriptor("host");
    host.consumes = vec![consumes(&c.id)];
    host.colocated_deps = [gid("shared")].into_iter().collect();
    catalogue.gears.insert(gid("host"), host);

    let mut provider = descriptor("provider");
    provider.provides = vec![provides(&c, &[Transport::Local, Transport::Rest])];
    provider.colocated_deps = [gid("shared")].into_iter().collect();
    catalogue.gears.insert(gid("provider"), provider);

    catalogue.gears.insert(gid("shared"), descriptor("shared"));
    catalogue.contracts.insert(c.id.clone(), c);
    catalogue
}

/// `intent`, but for a profile that can hold several processes.
pub fn host_workers_intent(gears: &[&str]) -> ProductIntent {
    let mut intent = intent(gears);
    let local = ProfileId::new("local").unwrap();
    intent.profiles.insert(
        local.clone(),
        gearbox_ir::DeploymentProfileDecl::HostWorkers {
            id: local,
            host: gearbox_ir::ProcessId::new("gateway").unwrap(),
            discovery: gearbox_ir::Discovery::Static,
            target_dir: None,
        },
    );
    intent
}

// ------------------------------------------------------- structural fixtures

use gearbox_ir::RuntimeCap;

/// A gear carrying the given runtime capabilities.
pub fn gear_with_caps(id: &str, caps: &[RuntimeCap], deps: &[&str]) -> GearDescriptor {
    let mut g = descriptor(id);
    g.runtime_caps = caps.iter().copied().collect();
    g.colocated_deps = deps.iter().map(|d| gid(d)).collect();
    g
}

/// Build a catalogue from a list of gears.
pub fn catalogue_of(gears: Vec<GearDescriptor>) -> Catalogue {
    let mut catalogue = Catalogue::default();
    for g in gears {
        catalogue.gears.insert(g.id.clone(), g);
    }
    catalogue
}

/// An intent with one `host_workers` profile, tunable.
pub fn host_workers(
    gears: &[&str],
    discovery: gearbox_ir::Discovery,
    target_dir: Option<&str>,
) -> ProductIntent {
    let mut intent = intent(gears);
    let local = ProfileId::new("local").unwrap();
    intent.profiles.insert(
        local.clone(),
        gearbox_ir::DeploymentProfileDecl::HostWorkers {
            id: local,
            host: gearbox_ir::ProcessId::new("host").unwrap(),
            discovery,
            target_dir: target_dir.map(ToOwned::to_owned),
        },
    );
    intent
}

/// Force a second process by pinning a gear to one.
pub fn pin(intent: &mut ProductIntent, name: &str, anchor: &str, replicas: u32) {
    intent.process_pins.push(gearbox_ir::ProcessPin {
        name: gearbox_ir::ProcessId::new(name).unwrap(),
        anchor: gid(anchor),
        replicas,
        profiles: BTreeSet::new(),
    });
}
