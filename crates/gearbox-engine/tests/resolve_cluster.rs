//! Steps 7 and 8: which backend answers each cluster primitive.
//!
//! The provider table these tests use is the real one, copied from what the
//! resolver projects out of the cluster gear's registry. Two facts about it do
//! most of the work here, and both are awkward: `standalone` is process-local,
//! and **neither provider registers leader election**. A test suite built on an
//! invented table would have neither problem and would prove nothing.
//!
//! The rule worth the most is `GBX0503`. A process-local backend spread across
//! processes is a correctness bug the runtime starts without complaint.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::{Path, PathBuf};

use gearbox_engine::resolve::resolve;
use gearbox_engine::{SourceRoot, load_catalogue};
use gearbox_ir::{
    Catalogue, ClusterPrimitive, ClusterResolution, DiagnosticCode, Discovery, Preference,
    ProductIntent, ProfileId, RuntimeCap, SourceId,
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

fn pid(s: &str) -> ProfileId {
    ProfileId::new(s).unwrap()
}

fn codes(r: &gearbox_engine::resolve::Resolution) -> Vec<DiagnosticCode> {
    r.diagnostics.iter().map(|d| d.code).collect()
}

/// One process, so nothing is spread.
fn single(cat: &Catalogue, intent: &ProductIntent) -> gearbox_engine::resolve::Resolution {
    resolve(cat, intent, &pid("dev"))
}

#[test]
fn a_product_with_no_cluster_requirement_resolves_nothing() {
    // The real slice: no gear requires a cluster primitive, so the step is inert.
    // Asserting it keeps an accidental default from appearing later.
    let Some(root) = gears_rust() else {
        eprintln!("skipping: ../gears-rust not present");
        return;
    };
    let source = SourceRoot::open(SourceId::new("gears-rust").unwrap(), root).unwrap();
    let cat = load_catalogue(&[source]).catalogue;
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../products/payments-demo/product.gdl")
        .canonicalize()
        .unwrap();
    let intent = gearbox_engine::product::load_product(&path, None)
        .intent
        .unwrap();

    for profile in ["dev", "local", "prod"] {
        let r = resolve(&cat, &intent, &pid(profile));
        assert!(r.cluster.is_empty(), "{profile}: {:?}", r.cluster);
    }
}

#[test]
fn one_process_gets_the_process_local_cache() {
    // `standalone` sorts before nothing and after nothing; with one process it is
    // not penalised, and it wins on the name against `postgres`... except it does
    // not, because `p` sorts before `s`. The point of the assertion is that the
    // answer is *stable and explained*, not that it is a particular name.
    let cat = support::cluster_catalogue(vec![(
        ClusterPrimitive::Cache,
        "main",
        &["cluster.cache.linearizable"],
    )]);
    let r = single(&cat, &support::intent(&["app"]));

    let binding = r.cluster.first().expect("one binding");
    assert_eq!(binding.primitive, ClusterPrimitive::Cache);
    assert_eq!(binding.resolved.effective_provider(), Some("postgres"));
    assert!(codes(&r).contains(&DiagnosticCode::ClusterAutoSelected));

    let help = r
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::ClusterAutoSelected)
        .and_then(|d| d.help.clone())
        .expect("the ranking is explained");
    assert!(help.contains("candidates were"), "{help}");
    assert!(help.contains("ties broke on the name"), "{help}");
}

#[test]
fn a_process_local_backend_across_processes_is_an_error() {
    // The single most valuable rule here. `standalone`'s cache lives in one
    // process's memory, so two processes get two caches — a lock that locks
    // nothing, and leader election that elects a leader per replica. The runtime
    // starts this happily.
    let cat = support::cluster_catalogue(vec![(
        ClusterPrimitive::Cache,
        "main",
        &["cluster.cache.linearizable"],
    )]);
    let mut intent = support::host_workers(&["app"], Discovery::Static, Some("t"));
    support::bind_cluster(&mut intent, "main", "standalone", None);
    support::pin(&mut intent, "worker", "cluster", 1);

    let r = resolve(&cat, &intent, &pid("local"));
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::ClusterProcessLocalInMultiProcess)
        .expect("GBX0503");
    assert!(
        d.help
            .as_deref()
            .unwrap_or_default()
            .contains("leader per replica"),
        "the help must name the actual consequence: {:?}",
        d.help
    );
    assert!(d.severity.is_error());
}

#[test]
fn one_process_may_use_the_process_local_backend() {
    // The same binding, without the spread. Reporting it here would refuse a
    // product that works.
    let cat = support::cluster_catalogue(vec![(
        ClusterPrimitive::Cache,
        "main",
        &["cluster.cache.linearizable"],
    )]);
    let mut intent = support::intent(&["app"]);
    support::bind_cluster(&mut intent, "main", "standalone", None);

    let r = single(&cat, &intent);
    assert!(!codes(&r).contains(&DiagnosticCode::ClusterProcessLocalInMultiProcess));
}

#[test]
fn leader_election_always_falls_back_to_the_sdk_default() {
    // Not a gap in this code: zero leader-election providers are registered in
    // the runtime. Saying so is the point, because "leader election works" and
    // "leader election is compare-and-swap over your cache" are different
    // promises.
    let cat = support::cluster_catalogue(vec![
        (
            ClusterPrimitive::Cache,
            "main",
            &["cluster.cache.linearizable"],
        ),
        (ClusterPrimitive::LeaderElection, "main", &[]),
    ]);
    let mut intent = support::intent(&["app"]);
    support::bind_cluster(&mut intent, "main", "postgres", Some("secret/pg"));

    let r = single(&cat, &intent);
    let election = r
        .cluster
        .iter()
        .find(|b| b.primitive == ClusterPrimitive::LeaderElection)
        .expect("a leader-election binding");
    assert_eq!(
        election.resolved,
        ClusterResolution::SdkCasDefault {
            over_cache: "postgres".to_owned()
        }
    );
    assert!(codes(&r).contains(&DiagnosticCode::ClusterSdkDefault));
}

#[test]
fn an_unsatisfiable_requirement_shows_every_provider() {
    // `prefix-watch` exists only on `standalone`, and `standalone` does not
    // answer locks. A bare refusal would leave the reader guessing which of the
    // two facts blocked them.
    let cat = support::cluster_catalogue(vec![(
        ClusterPrimitive::Lock,
        "main",
        &["cluster.lock.prefix-watch"],
    )]);
    let r = single(&cat, &support::intent(&["app"]));

    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::ClusterUnsatisfiable)
        .expect("GBX0502");
    let help = d.help.as_deref().unwrap_or_default();
    assert!(help.contains("postgres: missing"), "{help}");
    assert!(
        help.contains("standalone: does not answer lock"),
        "the two providers fail for different reasons and the table must say so: {help}"
    );
    let lock = r
        .cluster
        .iter()
        .find(|b| b.primitive == ClusterPrimitive::Lock)
        .expect("a lock binding");
    assert_eq!(lock.resolved, ClusterResolution::Unsatisfied);
}

#[test]
fn an_unregistered_provider_is_named_against_the_registered_ones() {
    let cat = support::cluster_catalogue(vec![(
        ClusterPrimitive::Cache,
        "main",
        &["cluster.cache.linearizable"],
    )]);
    let mut intent = support::intent(&["app"]);
    support::bind_cluster(&mut intent, "main", "redis", None);

    let r = single(&cat, &intent);
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::ClusterUnregisteredProvider)
        .expect("GBX0505");
    assert!(d.help.as_deref().unwrap_or_default().contains("postgres"));
    assert!(d.help.as_deref().unwrap_or_default().contains("standalone"));
    let cache = r
        .cluster
        .iter()
        .find(|b| b.primitive == ClusterPrimitive::Cache)
        .expect("a cache binding");
    assert_eq!(
        cache.selected.downgraded_by,
        Some(DiagnosticCode::ClusterUnregisteredProvider)
    );
    assert_eq!(cache.resolved, ClusterResolution::Unsatisfied);
    assert_eq!(cache.resolved.effective_provider(), None);
}

#[test]
fn a_provider_that_needs_credentials_must_be_told_where_they_are() {
    let cat = support::cluster_catalogue(vec![(
        ClusterPrimitive::Cache,
        "main",
        &["cluster.cache.linearizable"],
    )]);
    let mut intent = support::intent(&["app"]);
    support::bind_cluster(&mut intent, "main", "postgres", None);

    let r = single(&cat, &intent);
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::ClusterNoCredentialSource)
        .expect("GBX0506");
    assert!(
        d.help
            .as_deref()
            .unwrap_or_default()
            .contains("never enters"),
        "the help must say the credential itself stays out: {:?}",
        d.help
    );

    // With a reference, silence.
    let mut ok = support::intent(&["app"]);
    support::bind_cluster(&mut ok, "main", "postgres", Some("secret/pg"));
    assert!(!codes(&single(&cat, &ok)).contains(&DiagnosticCode::ClusterNoCredentialSource));
}

#[test]
fn existing_infrastructure_is_preferred_within_a_scope() {
    // The preference may only order candidates that are already valid, so it can
    // never make an invalid product valid. Here both answer the lock; the one
    // already carrying the cache wins.
    let cat = support::cluster_catalogue(vec![
        (
            ClusterPrimitive::Cache,
            "main",
            &["cluster.cache.linearizable"],
        ),
        (ClusterPrimitive::Lock, "main", &[]),
    ]);
    let mut intent = support::intent(&["app"]);
    intent.preferences.push(Preference::ExistingInfrastructure);
    support::bind_cluster(&mut intent, "main", "postgres", Some("secret/pg"));

    let r = single(&cat, &intent);
    let lock = r
        .cluster
        .iter()
        .find(|b| b.primitive == ClusterPrimitive::Lock)
        .expect("a lock binding");
    assert_eq!(lock.resolved.effective_provider(), Some("postgres"));
}

#[test]
fn a_replicated_stateful_gear_without_election_is_reported() {
    // Step 8. Two copies both reconciling is not something the runtime notices.
    let mut cat = support::cluster_catalogue(Vec::new());
    let mut app = support::gear_with_caps("app", &[RuntimeCap::Stateful], &[]);
    app.id = gearbox_ir::GearId::new("app").unwrap();
    cat.gears.insert(app.id.clone(), app);

    let mut intent = support::host_workers(&["app", "cluster"], Discovery::Static, Some("t"));
    support::pin(&mut intent, "app", "app", 3);

    let r = resolve(&cat, &intent, &pid("local"));
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::ClusterStatefulReplicasWithoutElection)
        .expect("GBX0507");
    assert!(d.message.contains("3 copies"), "{}", d.message);
    assert!(
        !d.severity.is_error(),
        "a warning: it may be exactly what was wanted"
    );
}

#[test]
fn cluster_resolution_is_stable_across_runs() {
    let cat = support::cluster_catalogue(vec![
        (
            ClusterPrimitive::Cache,
            "main",
            &["cluster.cache.linearizable"],
        ),
        (ClusterPrimitive::Lock, "main", &[]),
        (ClusterPrimitive::LeaderElection, "main", &[]),
    ]);
    let mut intent = support::intent(&["app"]);
    support::bind_cluster(&mut intent, "main", "postgres", Some("secret/pg"));

    let a = single(&cat, &intent);
    let b = single(&cat, &intent);
    assert_eq!(a.cluster, b.cluster);
}

#[path = "support/resolve_fixtures.rs"]
mod support;
