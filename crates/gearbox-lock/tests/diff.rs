//! Structural diffing: minimal, deterministic, and sorted -- not a
//! reformatted-everything text diff (`cpt-gearbox-nfr-lock-diff-minimal`).

#![allow(
    clippy::unwrap_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers `#[test]` functions but not the \
              helpers in this file"
)]

mod support;

use gearbox_ir::{ClusterPrimitive, ContractId, GearId, ProcessId};

#[test]
fn identical_products_diff_to_nothing() {
    let a = support::fixture();
    let b = support::fixture();
    let d = gearbox_lock::diff(&a, &b);
    assert!(d.is_empty(), "{d:?}");
    assert!(d.summary().is_empty());
}

#[test]
fn diff_is_order_independent() {
    // The whole reason to diff structures instead of text: shuffling one
    // side must not manufacture spurious changes.
    let a = support::fixture();
    let mut b = support::fixture();
    support::shuffle_orderings(&mut b, 7);

    let d = gearbox_lock::diff(&a, &b);
    assert!(d.is_empty(), "{d:?}");
}

#[test]
fn detects_an_added_gear() {
    let before = support::fixture();
    let mut after = support::fixture();

    // Adding gear-orchestrator as a new, unrelated gear and process (not
    // wired into any binding) isolates the "added" case from "changed".
    let id = GearId::new("gear-orchestrator").unwrap();
    let mut gear = after
        .gears
        .get(&GearId::new("api-contracts").unwrap())
        .unwrap()
        .clone();
    gear.id = id.clone();
    after.gears.insert(id, gear);

    let d = gearbox_lock::diff(&before, &after);
    assert_eq!(
        d.gears_added,
        vec![GearId::new("gear-orchestrator").unwrap()]
    );
    assert!(d.gears_removed.is_empty());
    assert!(d.gears_changed.is_empty());
    assert!(!d.is_empty());
}

#[test]
fn detects_a_removed_gear() {
    let before = support::fixture();
    let mut after = support::fixture();
    after.gears.remove(&GearId::new("types-registry").unwrap());

    let d = gearbox_lock::diff(&before, &after);
    assert_eq!(
        d.gears_removed,
        vec![GearId::new("types-registry").unwrap()]
    );
    assert!(d.gears_added.is_empty());
}

#[test]
fn detects_a_changed_gear() {
    let before = support::fixture();
    let mut after = support::fixture();
    after
        .gears
        .get_mut(&GearId::new("cluster").unwrap())
        .unwrap()
        .runtime_caps
        .insert(gearbox_ir::RuntimeCap::Db);

    let d = gearbox_lock::diff(&before, &after);
    assert_eq!(d.gears_changed, vec![GearId::new("cluster").unwrap()]);
    assert!(d.gears_added.is_empty());
    assert!(d.gears_removed.is_empty());
}

#[test]
fn detects_process_and_binding_changes() {
    let before = support::fixture();
    let mut after = support::fixture();

    after
        .processes
        .iter_mut()
        .find(|p| p.name == ProcessId::new("payments-audit").unwrap())
        .unwrap()
        .replicas = 2;
    after.bindings[0].critical = true;

    let d = gearbox_lock::diff(&before, &after);
    assert_eq!(
        d.processes_changed,
        vec![ProcessId::new("payments-audit").unwrap()]
    );
    assert!(d.processes_added.is_empty());
    assert!(d.processes_removed.is_empty());

    assert_eq!(d.bindings_changed.len(), 1);
    assert_eq!(
        d.bindings_changed[0].consumer,
        GearId::new("payments-audit").unwrap()
    );
    assert_eq!(
        d.bindings_changed[0].contract,
        ContractId::new("api-contracts/PaymentApi@v1").unwrap()
    );
}

#[test]
fn detects_cluster_changes_keyed_by_scope_and_primitive() {
    let before = support::fixture();
    let mut after = support::fixture();
    after
        .cluster
        .iter_mut()
        .find(|c| c.primitive == ClusterPrimitive::Cache)
        .unwrap()
        .secret_ref = Some("existingSecret:different".to_owned());

    let d = gearbox_lock::diff(&before, &after);
    assert_eq!(d.cluster_changed.len(), 1);
    assert_eq!(d.cluster_changed[0].scope, "default");
    assert_eq!(d.cluster_changed[0].primitive, ClusterPrimitive::Cache);
    assert!(d.cluster_added.is_empty());
    assert!(d.cluster_removed.is_empty());
}

#[test]
fn detects_a_profile_change() {
    let before = support::fixture();
    let mut after = support::fixture();
    after.product.profile = gearbox_ir::ProfileId::new("prod").unwrap();

    let d = gearbox_lock::diff(&before, &after);
    assert_eq!(
        d.profile_changed,
        Some(("local".to_owned(), "prod".to_owned()))
    );
}

#[test]
fn summary_lines_are_sorted_and_readable() {
    let before = support::fixture();
    let mut after = support::fixture();
    after.gears.remove(&GearId::new("types-registry").unwrap());
    after.bindings[0].critical = true;

    let d = gearbox_lock::diff(&before, &after);
    let summary = d.summary();

    assert!(summary.iter().any(|l| l == "- gear types-registry"));
    assert!(
        summary
            .iter()
            .any(|l| l.starts_with("~ binding payments-audit -> "))
    );
}
