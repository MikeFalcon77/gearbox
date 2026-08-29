//! Step 6: how each severable edge is actually established.
//!
//! The claim these tests exist to check is the project's headline one: **one
//! description, three topologies, and nothing in the description says which**.
//! The same edge is local in `dev`, remote over the directory in `local`, and
//! remote over static wiring in `prod` — derived from where the gears ended up,
//! not from anything anyone wrote.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::{Path, PathBuf};

use gearbox_engine::resolve::resolve;
use gearbox_engine::{SourceRoot, load_catalogue};
use gearbox_ir::{
    BindingMechanism, BindingMode, Catalogue, DiagnosticCode, Discovery, GearId, ProductIntent,
    ProfileId, ResolvedBindingMode, SourceId, Transport,
};

fn gears_rust() -> Option<PathBuf> {
    // Walks up instead of counting `..`, and the difference is not cosmetic.
    // `CARGO_MANIFEST_DIR/../../../gears-rust` is the sibling of the *repository*
    // root, so from a git worktree -- `.claude/worktrees/<name>/crates/...` -- it
    // resolved to nothing. Every real-tree test then skipped, printed a reason
    // nobody reads, and the suite went green having touched none of the corpus.
    // An agent working in a worktree got that silently.
    let mut dir: &Path = Path::new(env!("CARGO_MANIFEST_DIR"));
    loop {
        let candidate = dir.join("gears-rust");
        if candidate.join("gears").is_dir() {
            return candidate.canonicalize().ok();
        }
        dir = dir.parent()?;
    }
}

fn catalogue() -> Option<Catalogue> {
    let root = gears_rust()?;
    let source = SourceRoot::open(SourceId::new("gears-rust").unwrap(), root).ok()?;
    Some(load_catalogue(&[source]).catalogue)
}

fn product() -> Option<ProductIntent> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../products/payments-demo/product.gdl")
        .canonicalize()
        .ok()?;
    gearbox_engine::product::load_product(&path, None).intent
}

macro_rules! require {
    ($cat:ident, $prod:ident) => {
        let (Some($cat), Some($prod)) = (catalogue(), product()) else {
            eprintln!("skipping: ../gears-rust or the product description is not present");
            return;
        };
    };
}

fn gid(s: &str) -> GearId {
    GearId::new(s).unwrap()
}

fn pid(s: &str) -> ProfileId {
    ProfileId::new(s).unwrap()
}

#[test]
fn one_description_gives_three_different_bindings() {
    // The headline claim, checked on the one edge in the slice that can carry a
    // boundary. Nothing in `product.gdl` says local or remote for `dev`; the
    // answer follows from placement.
    require!(cat, prod);

    let dev = resolve(&cat, &prod, &pid("dev"));
    let v1 = dev
        .bindings
        .iter()
        .find(|b| b.contract.as_str().ends_with("@v1"))
        .expect("the v1 edge");
    assert_eq!(v1.mode, ResolvedBindingMode::Local);
    assert_eq!(v1.transport, Transport::Local);
    assert_eq!(v1.mechanism, BindingMechanism::ColocatedLocal);

    let local = resolve(&cat, &prod, &pid("local"));
    let v1 = local
        .bindings
        .iter()
        .find(|b| b.contract.as_str().ends_with("@v1"))
        .expect("the v1 edge");
    assert_eq!(v1.mode, ResolvedBindingMode::Remote);
    assert_eq!(v1.mechanism, BindingMechanism::ConsumesDirectory);

    let prod_ = resolve(&cat, &prod, &pid("prod"));
    let v1 = prod_
        .bindings
        .iter()
        .find(|b| b.contract.as_str().ends_with("@v1"))
        .expect("the v1 edge");
    assert_eq!(v1.mode, ResolvedBindingMode::Remote);
    assert_eq!(v1.mechanism, BindingMechanism::ConsumesStatic);
}

#[test]
fn a_local_binding_carries_no_endpoint() {
    // Deliberately absent rather than empty. The client hub finds the in-process
    // instance and short-circuits before any resolver runs, so an address here
    // would be a value the runtime never reads — a lie recorded in the lock.
    require!(cat, prod);
    let dev = resolve(&cat, &prod, &pid("dev"));
    for binding in &dev.bindings {
        assert_eq!(binding.mode, ResolvedBindingMode::Local);
        assert!(binding.endpoint_source.is_none(), "{binding:?}");
        assert!(binding.endpoint.is_none(), "{binding:?}");
        assert!(
            !binding.gates_readiness(),
            "a co-located binding has nothing to wait for"
        );
    }
}

#[test]
fn a_remote_binding_names_where_its_address_comes_from() {
    // The source, not the value: an address is a deployment concern, and pinning
    // one would make the lock environment-specific.
    require!(cat, prod);

    let directory = resolve(&cat, &prod, &pid("local"));
    let source = directory.bindings[0]
        .endpoint_source
        .as_deref()
        .expect("a source");
    assert!(source.starts_with("directory:"), "{source}");

    let static_ = resolve(&cat, &prod, &pid("prod"));
    let source = static_.bindings[0]
        .endpoint_source
        .as_deref()
        .expect("a source");
    assert_eq!(
        source,
        "gears.api-contracts-consumer.consumer_wiring.payment_api"
    );
    assert!(
        static_.bindings[0].endpoint.is_none(),
        "the value belongs to the deployment, not the lock"
    );
}

#[test]
fn the_two_majors_get_distinct_wiring_keys() {
    // Parallel majors coexist by design, so their overrides must not collide.
    require!(cat, prod);
    let r = resolve(&cat, &prod, &pid("prod"));
    let keys: Vec<&str> = r
        .bindings
        .iter()
        .filter_map(|b| b.endpoint_source.as_deref())
        .collect();
    assert_eq!(
        keys,
        vec![
            "gears.api-contracts-consumer.consumer_wiring.payment_api",
            "gears.api-contracts-consumer.consumer_wiring.payment_api_v2",
        ]
    );
}

#[test]
fn a_honoured_request_is_recorded_as_honoured() {
    // The description asks for `binding_mode.remote` on v1. It was honoured in
    // `local`, and recording that is what lets Explain distinguish "you got what
    // you asked for" from "the resolver happened to agree".
    require!(cat, prod);
    let r = resolve(&cat, &prod, &pid("local"));
    let v1 = r
        .bindings
        .iter()
        .find(|b| b.contract.as_str().ends_with("@v1"))
        .expect("v1");
    assert!(!v1.selected.was_downgraded());
    assert!(v1.selected.selected.explicit().is_some(), "asked for");

    let v2 = r
        .bindings
        .iter()
        .find(|b| b.contract.as_str().ends_with("@v2"))
        .expect("v2");
    assert!(v2.selected.selected.is_auto(), "nobody asked about v2");
}

#[test]
fn a_request_scoped_away_from_a_profile_is_not_a_downgrade() {
    // The description asks for remote on v1 with `profiles = ["local", "prod"]`,
    // so in `dev` there is no request at all — step 1 removed it. Recording a
    // downgrade here would invent a disappointment nobody expressed, which is
    // exactly what profile scoping exists to prevent.
    require!(cat, prod);
    let r = resolve(&cat, &prod, &pid("dev"));
    let v1 = r
        .bindings
        .iter()
        .find(|b| b.contract.as_str().ends_with("@v1"))
        .expect("v1");
    assert!(v1.selected.selected.is_auto(), "{:?}", v1.selected);
    assert!(!v1.selected.was_downgraded());
    assert!(
        !r.diagnostics
            .iter()
            .any(|d| d.code == DiagnosticCode::BindingForcedLocal),
        "nothing was asked for, so nothing was refused"
    );
}

#[test]
fn asking_for_remote_in_a_single_process_profile_is_recorded_as_a_downgrade() {
    // The mechanism the real product deliberately avoids by scoping its request.
    // Without the record, the lock would show a local binding with no sign that
    // anyone wanted otherwise.
    let cat = support::catalogue_with_declared_edge();
    let mut intent = support::intent(&["host", "provider"]);
    intent.bindings.push(gearbox_ir::BindingIntent {
        consumer: gid("host"),
        contract: gearbox_ir::ContractId::new("provider/Thing@v1").unwrap(),
        mode: BindingMode::Remote,
        transport: None,
        endpoint: None,
        profiles: std::collections::BTreeSet::new(),
    });

    let r = resolve(&cat, &intent, &pid("dev"));
    let binding = r.bindings.first().expect("one binding");
    assert_eq!(
        binding.mode,
        ResolvedBindingMode::Local,
        "one process, so local"
    );
    assert_eq!(
        binding.selected.downgraded_by,
        Some(DiagnosticCode::BindingForcedLocal)
    );
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::BindingForcedLocal)
        .expect("and reported, not only recorded");
    assert!(
        d.help.as_deref().unwrap_or_default().contains("ignored"),
        "the help must say the address would be ignored rather than rejected: {:?}",
        d.help
    );
}

#[test]
fn asking_for_grpc_across_a_boundary_is_downgraded_to_rest() {
    // `#[toolkit::consumes]` emits a REST resolving client and nothing else. The
    // gRPC in the runtime is hand-written wiring the generator does not produce,
    // so a severed edge has no gRPC path at all.
    let cat = support::catalogue_with_declared_edge();
    let mut intent = support::host_workers(&["host", "provider"], Discovery::Static, Some("t"));
    support::pin(&mut intent, "worker", "provider", 1);
    intent.bindings.push(gearbox_ir::BindingIntent {
        consumer: gid("host"),
        contract: gearbox_ir::ContractId::new("provider/Thing@v1").unwrap(),
        mode: BindingMode::Remote,
        transport: Some(Transport::Grpc),
        endpoint: None,
        profiles: std::collections::BTreeSet::new(),
    });

    let r = resolve(&cat, &intent, &pid("local"));
    let binding = r.bindings.first().expect("one binding");
    assert_eq!(binding.mode, ResolvedBindingMode::Remote);
    assert_eq!(binding.transport, Transport::Rest, "downgraded");
    assert_eq!(
        binding.selected.downgraded_by,
        Some(DiagnosticCode::BindingGrpcUnsupported)
    );
    assert!(
        r.diagnostics
            .iter()
            .any(|d| d.code == DiagnosticCode::BindingGrpcUnsupported)
    );
}

#[test]
fn a_nested_wiring_key_cannot_come_from_the_environment() {
    // The runtime's environment remapping converts underscores to hyphens only in
    // the segment right after the gears prefix, so `payment_api` nested under
    // `consumer_wiring` can never be matched by a variable. An operator planning
    // to set it at deploy time needs telling.
    require!(cat, prod);
    let r = resolve(&cat, &prod, &pid("prod"));
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::BindingEnvCannotExpressWiring)
        .expect("GBX0409");
    assert!(
        d.help
            .as_deref()
            .unwrap_or_default()
            .contains("payment_api"),
        "the key itself has to appear: {:?}",
        d.help
    );

    // Directory discovery does not read a wiring key at all, so the warning
    // would be false there.
    let local = resolve(&cat, &prod, &pid("local"));
    assert!(
        !local
            .diagnostics
            .iter()
            .any(|d| d.code == DiagnosticCode::BindingEnvCannotExpressWiring)
    );
}

#[test]
fn readiness_gating_follows_criticality_and_placement_together() {
    // `critical` defaults to false and the slice's consumer does not set it, so
    // nothing in the real product gates readiness. Asserting that keeps the
    // default visible: a change to it would show up here rather than as a
    // product that suddenly refuses to become ready.
    require!(cat, prod);
    let r = resolve(&cat, &prod, &pid("prod"));
    assert!(
        r.bindings.iter().all(|b| !b.gates_readiness()),
        "no consumed contract in the slice is declared critical: {:?}",
        r.bindings
    );

    // A critical remote binding does gate; a critical *local* one does not,
    // because there is nothing to wait for.
    let cat = support::catalogue_with_declared_edge();
    let mut intent = support::host_workers(&["host", "provider"], Discovery::Static, Some("t"));
    support::pin(&mut intent, "worker", "provider", 1);
    let remote = resolve(&cat, &intent, &pid("local"));
    assert!(
        remote
            .bindings
            .iter()
            .all(gearbox_ir::ResolvedBinding::gates_readiness),
        "{:?}",
        remote.bindings
    );

    let local = resolve(&cat, &support::intent(&["host", "provider"]), &pid("dev"));
    assert!(local.bindings.iter().all(|b| !b.gates_readiness()));
}

#[test]
fn bindings_are_stable_across_runs() {
    require!(cat, prod);
    for profile in ["dev", "local", "prod"] {
        let a = resolve(&cat, &prod, &pid(profile));
        let b = resolve(&cat, &prod, &pid(profile));
        assert_eq!(a.bindings, b.bindings, "{profile}");
    }
}

#[path = "support/resolve_fixtures.rs"]
mod support;
