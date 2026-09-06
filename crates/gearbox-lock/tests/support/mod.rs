//! Shared test fixture: a compact two-process resolved product modelled on
//! the `payments-demo` slice from `docs/plans/gearbox-builder-prototype.md`
//! §I -- real gear and contract shapes, small enough to hand-build.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "this module has no #[test] functions of its own -- it is fixture-building code \
              shared by every test file in this crate, compiled separately into each one -- \
              and a fixture builder that propagates errors instead of panicking obscures the \
              assertion it exists to support"
)]

use std::collections::{BTreeMap, BTreeSet};

use gearbox_ir::*;

fn gid(s: &str) -> GearId {
    GearId::new(s).unwrap()
}

fn pid(s: &str) -> ProcessId {
    ProcessId::new(s).unwrap()
}

fn sid(s: &str) -> SourceId {
    SourceId::new(s).unwrap()
}

fn cap(s: &str) -> CapabilityId {
    CapabilityId::new(s).unwrap()
}

/// The contract `payments-audit` consumes from `api-contracts` in every test
/// that needs to name it, so both the fixture and its tests can refer to the
/// same value without hand-typing the string twice.
#[must_use]
pub fn payment_api_v1() -> ContractId {
    ContractId::new("api-contracts/PaymentApi@v1").unwrap()
}

fn resolved_gear(
    id: &str,
    caps: &[RuntimeCap],
    deps: &[&str],
    selected_by: InclusionReason,
) -> ResolvedGear {
    let ident = id.replace('-', "_");
    ResolvedGear {
        id: gid(id),
        source: sid("gears-rust"),
        gdl_path: RelPath::new(format!("gears/{id}/gear.gdl")).unwrap(),
        package: CargoRef::new(format!("cf-gears-{id}"), ident, RelPath::here()),
        crate_dir: RelPath::new(format!("gears/{id}")).unwrap(),
        runtime_caps: caps.iter().copied().collect(),
        colocated_deps: deps.iter().map(|d| gid(d)).collect(),
        config: std::collections::BTreeMap::new(),
        selected_by: vec![selected_by],
    }
}

fn gears() -> BTreeMap<GearId, ResolvedGear> {
    use RuntimeCap::{Rest, RestHost, Stateful};

    BTreeMap::from([
        (
            gid("types-registry"),
            resolved_gear(
                "types-registry",
                &[Rest],
                &[],
                InclusionReason::ColocatedBy {
                    gear: gid("api-gateway"),
                },
            ),
        ),
        (
            gid("api-gateway"),
            resolved_gear(
                "api-gateway",
                &[RestHost, Rest, Stateful],
                &["types-registry"],
                InclusionReason::Selected,
            ),
        ),
        (
            gid("api-contracts"),
            resolved_gear("api-contracts", &[Rest], &[], InclusionReason::Selected),
        ),
        (
            gid("cluster"),
            resolved_gear(
                "cluster",
                &[Stateful],
                &[],
                InclusionReason::ColocatedBy {
                    gear: gid("payments-audit"),
                },
            ),
        ),
        (
            gid("payments-audit"),
            resolved_gear(
                "payments-audit",
                &[Rest, Stateful],
                &["cluster"],
                InclusionReason::Selected,
            ),
        ),
    ])
}

fn gateway_process() -> ResolvedProcess {
    ResolvedProcess {
        name: pid("gateway"),
        kind: ProcessKind::Host,
        anchor: gid("api-gateway"),
        gears: vec![
            gid("types-registry"),
            gid("api-gateway"),
            gid("api-contracts"),
        ],
        replicas: 1,
        entrypoint: Entrypoint::RunServer,
        bin_name: "gbx-gateway".to_owned(),
        crate_name: "gbx-payments-demo-gateway".to_owned(),
        listens: vec![ResolvedEndpoint {
            name: "rest".to_owned(),
            gear: gid("api-gateway"),
            config_key: "bind_addr".to_owned(),
            address: "127.0.0.1:8087".to_owned(),
            advertise_uri: None,
            allow_loopback_advertise: false,
        }],
        rest_host: Some(gid("api-gateway")),
        grpc_hub: None,
        needs_db: false,
        cargo_features: BTreeSet::new(),
        spawns: vec![SpawnSpec {
            gear: gid("payments-audit"),
            bin_name: "gbx-payments-audit".to_owned(),
            args: vec![
                "--config".to_owned(),
                "config/payments-audit.yaml".to_owned(),
            ],
            working_directory: None,
            environment: BTreeMap::new(),
        }],
        serve: None,
        image: None,
        subchart: None,
        service_port: None,
    }
}

fn payments_audit_process() -> ResolvedProcess {
    ResolvedProcess {
        name: pid("payments-audit"),
        kind: ProcessKind::Worker,
        anchor: gid("payments-audit"),
        gears: vec![gid("cluster"), gid("payments-audit")],
        replicas: 1,
        entrypoint: Entrypoint::RunOopWithOptions,
        bin_name: "gbx-payments-audit".to_owned(),
        crate_name: "gbx-payments-demo-payments-audit".to_owned(),
        listens: vec![],
        rest_host: None,
        grpc_hub: None,
        needs_db: false,
        cargo_features: BTreeSet::new(),
        spawns: vec![],
        serve: None,
        image: None,
        subchart: None,
        service_port: None,
    }
}

fn binding() -> ResolvedBinding {
    ResolvedBinding {
        consumer: gid("payments-audit"),
        consumer_process: pid("payments-audit"),
        contract: payment_api_v1(),
        provider: gid("api-contracts"),
        provider_process: pid("gateway"),
        mode: ResolvedBindingMode::Remote,
        transport: Transport::Rest,
        mechanism: BindingMechanism::ConsumesDirectory,
        endpoint_source: Some("directory:gear-orchestrator/api-contracts".to_owned()),
        endpoint: None,
        critical: false,
        selected: Selected::honoured(BindingRequest {
            mode: BindingMode::Remote,
            transport: Some(Transport::Rest),
        }),
    }
}

fn cluster_bindings() -> Vec<ResolvedClusterBinding> {
    let cache = ResolvedClusterBinding {
        scope: "default".to_owned(),
        primitive: ClusterPrimitive::Cache,
        required_capabilities: BTreeSet::from([cap("cluster.cache.linearizable")]),
        requesters: vec![gid("payments-audit")],
        selected: Selected::honoured("postgres".to_owned()),
        resolved: ClusterResolution::Provider {
            name: "postgres".to_owned(),
        },
        options: BTreeMap::from([(
            "connection_string".to_owned(),
            serde_json::Value::String("postgres://payments@${PG_HOST}:5432/payments".to_owned()),
        )]),
        secret_ref: Some("existingSecret:payments-demo-pg".to_owned()),
    };

    let leader_election = ResolvedClusterBinding {
        scope: "default".to_owned(),
        primitive: ClusterPrimitive::LeaderElection,
        required_capabilities: BTreeSet::new(),
        requesters: vec![gid("payments-audit")],
        selected: Selected::auto(),
        resolved: ClusterResolution::SdkCasDefault {
            over_cache: "postgres".to_owned(),
        },
        options: BTreeMap::new(),
        secret_ref: None,
    };

    vec![cache, leader_election]
}

fn cuttable_candidates() -> Vec<CutCandidate> {
    vec![CutCandidate {
        consumer: gid("api-gateway"),
        provider: gid("payments-audit"),
        contract: None,
        blocked_by: CutBlocker::UndeclaredHubEdge,
        suggested_edit: Some(
            "#[toolkit::consumes(contract = payments_audit_sdk::PaymentsAuditApi, from = \"payments-audit\")]"
                .to_owned(),
        ),
        file: Some(RelPath::new("gears/api-gateway/src/gear.rs").unwrap()),
        estimated_savings: CutSavings::default(),
    }]
}

fn provenance() -> Vec<ProvenanceEdge> {
    // The ColocatedBy edge is deliberately duplicated: the same structural
    // fact is often reached from more than one direction during resolution,
    // and canonicalize_order is what is responsible for deduplicating it.
    let dup = ProvenanceEdge::new(
        NodeId::new("gear:payments-audit").unwrap(),
        NodeId::new("gear:cluster").unwrap(),
        ProvenanceKind::ColocatedBy,
        "payments-audit declares cluster as a co-location dependency",
    );

    vec![
        ProvenanceEdge::new(
            NodeId::new("gear:api-gateway").unwrap(),
            NodeId::new("source:gears-rust").unwrap(),
            ProvenanceKind::Declared,
            "api-gateway's gear.gdl was read from the gears-rust source",
        ),
        dup.clone(),
        dup,
        ProvenanceEdge::new(
            NodeId::new("decision:cut:payments-audit->api-contracts").unwrap(),
            NodeId::new("binding:payments-audit->api-contracts/PaymentApi@v1").unwrap(),
            ProvenanceKind::DerivedFrom,
            "api-contracts is not in payments-audit's co-location closure, so the edge is severable",
        ),
    ]
}

fn diagnostics() -> Diagnostics {
    let mut d = Diagnostics::new();
    d.push(
        Diagnostic::new(
            DiagnosticCode::ClusterSdkDefault,
            "leader_election resolved to the SDK compare-and-swap default over postgres",
        )
        .with_evidence("gears/system/cluster/cluster/src/gear.rs:47-53"),
    );
    d.push(
        Diagnostic::new(
            DiagnosticCode::GapNoK8sDnsResolver,
            "not applicable to host-workers, included for fixture coverage",
        )
        .with_evidence("libs/toolkit/src/discovery.rs:117-134"),
    );
    d
}

/// A resolved product for the `local` (host-workers) profile: a gateway host
/// process and a `payments-audit` worker, one severed binding between them,
/// two cluster primitives, one severable-if-declared report, a handful of
/// provenance edges (including a duplicate, to exercise dedup), and two
/// diagnostics.
#[must_use]
pub fn fixture() -> ResolvedProduct {
    ResolvedProduct {
        // The fixture models a `host_workers` product -- it has a spawn -- so it
        // carries the settings block too. `None` here would leave the golden
        // lock silent about a section every such product now writes.
        host_workers: Some(gearbox_ir::HostWorkersSettings {
            target_dir: Some("../../../gears-rust/target".to_owned()),
            discovery: gearbox_ir::Discovery::Directory,
        }),
        schema_version: LOCK_SCHEMA_VERSION,
        product: ResolvedProductHeader {
            id: "payments-demo".to_owned(),
            version: "0.1.0".to_owned(),
            profile: ProfileId::new("local").unwrap(),
            profile_kind: "host-workers".to_owned(),
            gearbox_version: "0.1.0".to_owned(),
            lock_hash: String::new(),
        },
        kubernetes: None,
        sources: BTreeMap::from([(
            sid("gears-rust"),
            ResolvedSource {
                id: sid("gears-rust"),
                kind: SourceKind::Path,
                location: "../../../gears-rust".to_owned(),
                digest: "git:8f3c1a9b7d2e4f60a1b5c8d3e9f04a7b6c2d1e85".to_owned(),
            },
        )]),
        gears: gears(),
        processes: vec![gateway_process(), payments_audit_process()],
        bindings: vec![binding()],
        cluster: cluster_bindings(),
        cuttable_if_declared: cuttable_candidates(),
        provenance: provenance(),
        diagnostics: diagnostics(),
    }
}

/// A tiny deterministic PRNG (splitmix64) so shuffles are reproducible
/// across runs without pulling in the `rand` crate for one test helper.
///
/// `support/mod.rs` is compiled separately into every test binary that
/// declares `mod support;`, and this is used by `diff.rs` and
/// `determinism.rs` but not `canonical.rs` -- genuinely unused from that
/// binary's perspective, hence the allow rather than a fight to satisfy it.
#[allow(
    dead_code,
    reason = "used by diff.rs and determinism.rs, not canonical.rs"
)]
struct SplitMix64(u64);

#[allow(
    dead_code,
    reason = "used by diff.rs and determinism.rs, not canonical.rs"
)]
impl SplitMix64 {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A uniform index in `[0, bound)`. `bound` is always a handful of
    /// vector elements, so the modulo bias this introduces is not worth the
    /// code to avoid, and a truncating cast is not worth an `expect`: on the
    /// rare target where `usize` is narrower than 64 bits, falling back to 0
    /// still produces a valid (merely less random) index.
    fn below(&mut self, bound: usize) -> usize {
        usize::try_from(self.next() % bound as u64).unwrap_or(0)
    }
}

#[allow(
    dead_code,
    reason = "used by diff.rs and determinism.rs, not canonical.rs"
)]
fn fisher_yates<T>(items: &mut [T], rng: &mut SplitMix64) {
    for i in (1..items.len()).rev() {
        items.swap(i, rng.below(i + 1));
    }
}

/// Reorder every collection on `product` that
/// `gearbox_lock::canonicalize_order` is responsible for sorting,
/// deterministically from `seed`. Used to prove that the writer's output
/// does not depend on the order the resolver happened to produce.
#[allow(
    dead_code,
    reason = "used by diff.rs and determinism.rs, not canonical.rs"
)]
pub fn shuffle_orderings(product: &mut ResolvedProduct, seed: u64) {
    let mut rng = SplitMix64(seed);
    fisher_yates(&mut product.processes, &mut rng);
    for process in &mut product.processes {
        fisher_yates(&mut process.listens, &mut rng);
        fisher_yates(&mut process.spawns, &mut rng);
    }
    fisher_yates(&mut product.bindings, &mut rng);
    fisher_yates(&mut product.cluster, &mut rng);
    fisher_yates(&mut product.cuttable_if_declared, &mut rng);
    fisher_yates(&mut product.provenance, &mut rng);
    // Diagnostics is a newtype without direct index access; a Vec round
    // trip is the simplest way to shuffle it too.
    let mut diags: Vec<Diagnostic> = product.diagnostics.clone().into_iter().collect();
    fisher_yates(&mut diags, &mut rng);
    product.diagnostics = diags.into_iter().collect();
}
