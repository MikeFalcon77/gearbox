//! Step 5: constraints the runtime imposes, checked before a binary exists.
//!
//! Each of these mirrors something the platform does. Two mirror things it does
//! *silently*, and those are the ones worth having: a REST host inside a worker
//! starts, reports healthy, and answers nothing; a host with directory discovery
//! and no gRPC hub blocks at startup rather than failing.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::{Path, PathBuf};

use gearbox_engine::resolve::resolve;
use gearbox_engine::{SourceRoot, load_catalogue};
use gearbox_ir::{
    Catalogue, DiagnosticCode, Discovery, ProductIntent, ProfileId, RuntimeCap, SourceId,
};

fn gears_rust() -> Option<PathBuf> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../gears-rust")
        .canonicalize()
        .ok()
        .filter(|p| p.join("gears").is_dir())
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

fn pid(s: &str) -> ProfileId {
    ProfileId::new(s).unwrap()
}

fn codes(r: &gearbox_engine::resolve::Resolution) -> Vec<DiagnosticCode> {
    r.diagnostics.iter().map(|d| d.code).collect()
}

#[test]
fn the_real_product_satisfies_every_structural_constraint() {
    let (Some(cat), Some(prod)) = (catalogue(), product()) else {
        eprintln!("skipping: ../gears-rust or the product description is not present");
        return;
    };
    for profile in ["dev", "local", "prod"] {
        let r = resolve(&cat, &prod, &pid(profile));
        let errors: Vec<String> = r
            .diagnostics
            .errors()
            .map(|d| format!("[{}] {}", d.code, d.message))
            .collect();
        assert!(errors.is_empty(), "{profile}: {errors:#?}");
    }
}

#[test]
fn host_workers_says_it_is_one_machine() {
    // Not a defect in the product: the runtime implements exactly one spawn
    // backend and it starts local processes. Said out loud so a multi-process
    // topology is not mistaken for a distributed one.
    let (Some(cat), Some(prod)) = (catalogue(), product()) else {
        eprintln!("skipping: fixtures not present");
        return;
    };
    let local = resolve(&cat, &prod, &pid("local"));
    assert!(codes(&local).contains(&DiagnosticCode::GapNoRemoteSpawnBackend));

    // Kubernetes does not spawn at all, so the note would be wrong there.
    let prod_ = resolve(&cat, &prod, &pid("prod"));
    assert!(!codes(&prod_).contains(&DiagnosticCode::GapNoRemoteSpawnBackend));
}

#[test]
fn two_rest_hosts_in_one_process_is_refused() {
    // The registry refuses the second at startup, so this is a binary that does
    // not boot.
    let cat = support::catalogue_of(vec![
        support::gear_with_caps("first", &[RuntimeCap::RestHost], &[]),
        support::gear_with_caps("second", &[RuntimeCap::RestHost], &[]),
    ]);
    let r = resolve(&cat, &support::intent(&["first", "second"]), &pid("dev"));

    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::TopologyMultipleRestHost)
        .expect("GBX0303");
    assert!(d.message.contains("first"), "{}", d.message);
    assert!(
        d.message.contains("second"),
        "both offenders must be named, not just the count: {}",
        d.message
    );
}

#[test]
fn two_grpc_hubs_in_one_process_is_refused() {
    let cat = support::catalogue_of(vec![
        support::gear_with_caps("first", &[RuntimeCap::GrpcHub], &[]),
        support::gear_with_caps("second", &[RuntimeCap::GrpcHub], &[]),
    ]);
    let r = resolve(&cat, &support::intent(&["first", "second"]), &pid("dev"));
    assert!(codes(&r).contains(&DiagnosticCode::TopologyMultipleGrpcHub));
}

#[test]
fn a_rest_host_in_a_worker_is_refused() {
    // The worker starts, reports healthy, and never receives a request, because
    // it serves through its own out-of-process router rather than the composed
    // gateway. Silent success is why this is an error.
    let cat = support::catalogue_of(vec![
        support::gear_with_caps("host", &[], &[]),
        support::gear_with_caps("moved", &[RuntimeCap::RestHost], &[]),
    ]);
    let mut intent = support::host_workers(&["host", "moved"], Discovery::Static, Some("target"));
    support::pin(&mut intent, "worker", "moved", 1);

    let r = resolve(&cat, &intent, &pid("local"));
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::TopologyRestHostInWorker)
        .expect("GBX0312");
    assert!(d.message.contains("worker"), "{}", d.message);
}

#[test]
fn rest_gears_with_no_host_are_refused() {
    let cat = support::catalogue_of(vec![support::gear_with_caps(
        "api",
        &[RuntimeCap::Rest],
        &[],
    )]);
    let r = resolve(&cat, &support::intent(&["api"]), &pid("dev"));
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::TopologyRestWithoutHost)
        .expect("GBX0305");
    assert!(d.message.contains("api"), "{}", d.message);
}

#[test]
fn directory_discovery_without_the_directory_server_is_refused() {
    let cat = support::catalogue_of(vec![
        support::gear_with_caps("host", &[], &[]),
        support::gear_with_caps("grpc-hub", &[RuntimeCap::GrpcHub], &[]),
        support::gear_with_caps("moved", &[], &[]),
    ]);
    let mut intent = support::host_workers(
        &["host", "grpc-hub", "moved"],
        Discovery::Directory,
        Some("target"),
    );
    support::pin(&mut intent, "worker", "moved", 1);

    let r = resolve(&cat, &intent, &pid("local"));
    assert!(codes(&r).contains(&DiagnosticCode::TopologyNoOrchestrator));
    assert!(
        !codes(&r).contains(&DiagnosticCode::TopologyNoGrpcHub),
        "the hub is present; only the directory server is missing"
    );
}

#[test]
fn directory_discovery_without_the_grpc_hub_is_refused() {
    // The failure this prevents is the least debuggable one available: the spawn
    // phase waits for the hub's endpoint, so the host blocks at startup instead
    // of reporting anything.
    let cat = support::catalogue_of(vec![
        support::gear_with_caps("host", &[], &[]),
        support::gear_with_caps("gear-orchestrator", &[], &[]),
        support::gear_with_caps("moved", &[], &[]),
    ]);
    let mut intent = support::host_workers(
        &["host", "gear-orchestrator", "moved"],
        Discovery::Directory,
        Some("target"),
    );
    support::pin(&mut intent, "worker", "moved", 1);

    let r = resolve(&cat, &intent, &pid("local"));
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::TopologyNoGrpcHub)
        .expect("GBX0309");
    assert!(
        d.help.as_deref().unwrap_or_default().contains("blocks"),
        "the help has to say what actually happens: {:?}",
        d.help
    );
}

#[test]
fn a_single_process_never_needs_discovery() {
    // Nothing moved out, so nothing is discovered, so the prerequisites do not
    // apply. Reporting them here would be noise on a product that works.
    let cat = support::catalogue_of(vec![support::gear_with_caps("only", &[], &[])]);
    let intent = support::host_workers(&["only"], Discovery::Directory, Some("target"));

    let r = resolve(&cat, &intent, &pid("local"));
    assert!(!codes(&r).contains(&DiagnosticCode::TopologyNoOrchestrator));
    assert!(!codes(&r).contains(&DiagnosticCode::TopologyNoGrpcHub));
    assert!(!codes(&r).contains(&DiagnosticCode::GapNoRemoteSpawnBackend));
}

#[test]
fn a_worker_with_no_target_dir_has_no_path() {
    let cat = support::catalogue_of(vec![
        support::gear_with_caps("host", &[], &[]),
        support::gear_with_caps("moved", &[], &[]),
    ]);
    let mut intent = support::host_workers(&["host", "moved"], Discovery::Static, None);
    support::pin(&mut intent, "worker", "moved", 1);

    let r = resolve(&cat, &intent, &pid("local"));
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::TopologyNoTargetDir)
        .expect("GBX0310");
    assert!(d.message.contains("worker"), "{}", d.message);
}

#[test]
fn target_dir_is_only_needed_when_something_moved() {
    let cat = support::catalogue_of(vec![support::gear_with_caps("only", &[], &[])]);
    let intent = support::host_workers(&["only"], Discovery::Static, None);
    let r = resolve(&cat, &intent, &pid("local"));
    assert!(!codes(&r).contains(&DiagnosticCode::TopologyNoTargetDir));
}

#[path = "support/resolve_fixtures.rs"]
mod support;
