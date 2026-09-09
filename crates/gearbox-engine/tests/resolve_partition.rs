//! Step 4: which gears end up in which process.
//!
//! The name *partition* is inherited from the plan and is wrong in the way that
//! matters: a process is the co-location closure of what it holds, and closures
//! overlap, so one gear is routinely linked into several binaries. Several tests
//! here exist only to pin that down, because a resolver that assigned each gear
//! to exactly one process would look tidier and be unable to represent any real
//! product.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use gearbox_engine::resolve::resolve;
use gearbox_engine::{SourceRoot, load_catalogue};
use gearbox_ir::{
    Catalogue, DiagnosticCode, GearId, ProcessKind, ProductIntent, ProfileId, SourceId,
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
fn the_embedded_profile_holds_the_whole_product() {
    // Not the anchor's closure: a selected gear that nothing depends on still has
    // to run, and in one process there is nowhere else for it to be. Getting this
    // wrong drops `gear-orchestrator` and `api-contracts` silently.
    require!(cat, prod);
    let r = resolve(&cat, &prod, &pid("dev"));

    assert_eq!(r.partition.processes.len(), 1);
    let process = &r.partition.processes[0];
    let placed: BTreeSet<&GearId> = process.gears.iter().collect();
    let expected: BTreeSet<&GearId> = r.closure.members.keys().collect();
    assert_eq!(placed, expected, "every gear in the product must be in it");
    assert_eq!(process.kind, ProcessKind::Host);
    assert_eq!(process.rest_host.as_ref(), Some(&gid("api-gateway")));
}

#[test]
fn nothing_is_ever_orphaned() {
    require!(cat, prod);
    for profile in ["dev", "local", "prod"] {
        let r = resolve(&cat, &prod, &pid(profile));
        let orphans: Vec<&str> = r
            .diagnostics
            .iter()
            .filter(|d| d.code == DiagnosticCode::TopologyOrphanGear)
            .map(|d| d.message.as_str())
            .collect();
        assert!(orphans.is_empty(), "{profile}: {orphans:?}");
    }
}

#[test]
fn gears_come_after_everything_they_depend_on() {
    // The order the registry builds them in. A gear before its dependency would
    // produce a binary that fails at startup rather than at generation.
    require!(cat, prod);
    for profile in ["dev", "local", "prod"] {
        let r = resolve(&cat, &prod, &pid(profile));
        for process in &r.partition.processes {
            for (index, gear) in process.gears.iter().enumerate() {
                let Some(descriptor) = cat.gears.get(gear) else {
                    continue;
                };
                for dep in &descriptor.colocated_deps {
                    if let Some(at) = process.gears.iter().position(|g| g == dep) {
                        assert!(
                            at < index,
                            "{profile}/{}: {gear} at {index} precedes its dependency {dep} at {at}",
                            process.name
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn the_severable_edge_actually_moves_a_gear_out() {
    // The payoff of step 3. `api-contracts` is the provider of the one severable
    // edge in the slice, so a multi-process profile puts it in its own binary --
    // and the same product in `dev` does not.
    require!(cat, prod);

    let dev = resolve(&cat, &prod, &pid("dev"));
    assert_eq!(dev.partition.processes.len(), 1);

    let local = resolve(&cat, &prod, &pid("local"));
    let names: Vec<String> = local
        .partition
        .processes
        .iter()
        .map(|p| p.name.to_string())
        .collect();
    assert_eq!(names, vec!["gateway", "api-contracts"]);

    let worker = &local.partition.processes[1];
    assert_eq!(worker.kind, ProcessKind::Worker);
    assert_eq!(worker.gears, vec![gid("api-contracts")]);
}

#[test]
fn the_host_process_takes_its_name_from_the_profile() {
    // `host = "gateway"` names a *process*, not a gear, and no gear is called
    // that. Reading it as a gear id sends the anchor search off a cliff and every
    // other gear ends up orphaned.
    require!(cat, prod);
    let r = resolve(&cat, &prod, &pid("local"));
    let host = r.partition.processes.first().expect("a host");
    assert_eq!(host.name.to_string(), "gateway");
    assert_eq!(host.anchor, gid("api-gateway"), "anchored on the REST host");
    assert_eq!(host.bin_name, "gbx-gateway");
}

#[test]
fn a_pinned_process_keeps_its_name_and_replicas() {
    require!(cat, prod);
    let r = resolve(&cat, &prod, &pid("prod"));
    let audit = r
        .partition
        .processes
        .iter()
        .find(|p| p.name.as_str() == "audit")
        .expect("the pinned process");
    assert_eq!(audit.anchor, gid("api-contracts-consumer"));
    assert_eq!(audit.replicas, 2);
    assert_eq!(audit.kind, ProcessKind::Worker);
}

#[test]
fn a_pin_only_applies_to_the_profiles_it_names() {
    // `process("audit", ..., profiles = ["prod"])`. In `local` it must not exist,
    // which is step 1 doing its job and step 4 honouring it.
    require!(cat, prod);
    let local = resolve(&cat, &prod, &pid("local"));
    assert!(
        !local
            .partition
            .processes
            .iter()
            .any(|p| p.name.as_str() == "audit"),
        "the pin is scoped to prod"
    );
}

#[test]
fn processes_overlap_and_that_is_correct() {
    // The finding, made concrete. `shared` is a co-location dependency of both
    // `host` and `provider`, and `provider` moves into its own process — so
    // `shared` is linked into both binaries. A partition could not express this.
    let cat = support::catalogue_with_overlap();
    let intent = support::self_hosted_intent(&["host", "provider"]);
    let r = resolve(&cat, &intent, &pid("local"));

    assert_eq!(r.partition.processes.len(), 2, "{:#?}", r.partition);
    let holding: Vec<String> = r
        .partition
        .processes
        .iter()
        .filter(|p| p.contains(&gid("shared")))
        .map(|p| p.name.to_string())
        .collect();
    assert_eq!(holding.len(), 2, "`shared` belongs to both: {holding:?}");
    assert!(
        !r.partition.share_a_process(&gid("host"), &gid("provider")),
        "the severable edge did separate them"
    );
    assert!(
        r.partition.share_a_process(&gid("host"), &gid("shared")),
        "and `shared` stayed with the host as well"
    );
    assert!(
        r.partition.sole_process(&gid("shared")).is_none(),
        "asking which single process holds an overlapping gear has no answer"
    );
}

#[test]
fn an_embedded_profile_says_what_it_is_declining_to_do() {
    // Two severable edges exist and the profile is using neither. Silence here
    // would read as "nothing was separable", which is a different and more
    // discouraging fact than the true one.
    require!(cat, prod);
    let r = resolve(&cat, &prod, &pid("dev"));
    let note = r
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::TopologyEmbeddedViolation)
        .expect("GBX0307");
    assert!(note.message.contains("severable edge"), "{}", note.message);
    assert!(
        !note.severity.is_error(),
        "a single-process product is still buildable"
    );
}

#[test]
fn an_unknown_profile_is_refused_rather_than_defaulted() {
    // Resolving `embedded` when someone asked for `prod` would produce a
    // plausible product with the wrong topology — worse than producing nothing.
    require!(cat, prod);
    let r = resolve(&cat, &prod, &pid("staging"));
    assert!(
        r.diagnostics
            .iter()
            .any(|d| d.code == DiagnosticCode::GdlUnknownProfile),
        "{:#?}",
        r.diagnostics
    );
    assert!(r.partition.processes.is_empty());
}

#[test]
fn the_partition_is_stable_across_runs() {
    require!(cat, prod);
    for profile in ["dev", "local", "prod"] {
        let a = resolve(&cat, &prod, &pid(profile));
        let b = resolve(&cat, &prod, &pid(profile));
        assert_eq!(a.partition.processes, b.partition.processes, "{profile}");
    }
}

#[test]
fn kubernetes_fills_the_chart_fields_and_binds_every_interface() {
    // image / subchart / service_port exist only when the profile builds
    // images. BIND_HOST is 0.0.0.0 here because a Service cannot deliver a
    // packet to 127.0.0.1 inside the pod -- and that fact belongs in the lock,
    // not in a template.
    require!(cat, prod);
    let local = resolve(&cat, &prod, &pid("local"));
    for process in &local.partition.processes {
        assert!(process.image.is_none(), "{process:?}");
        assert!(process.subchart.is_none(), "{process:?}");
        assert!(process.service_port.is_none(), "{process:?}");
        for endpoint in &process.listens {
            assert!(
                endpoint.address.starts_with("127.0.0.1:"),
                "{}",
                endpoint.address
            );
        }
    }

    let prod_ = resolve(&cat, &prod, &pid("prod"));
    let gateway = prod_
        .partition
        .processes
        .iter()
        .find(|p| p.anchor.as_str() == "api-gateway")
        .expect("the host");
    let image = gateway
        .image
        .as_ref()
        .expect("a kubernetes profile builds images");
    // Asserted in parts, not as the joined reference: keeping the registry out of
    // `repository` is the whole point, and a test on `reference()` alone would
    // pass just as well with them folded back together.
    assert_eq!(
        image.registry.as_deref(),
        Some("registry.example.com/payments")
    );
    assert_eq!(image.repository, "gbx-api-gateway");
    assert_eq!(image.tag, "0.1.0");
    assert_eq!(
        image.reference(),
        "registry.example.com/payments/gbx-api-gateway:0.1.0"
    );
    assert_eq!(gateway.subchart.as_deref(), Some(gateway.name.as_str()));
    assert_eq!(
        gateway.service_port,
        Some(8087),
        "neighbours dial REST, not the gRPC hub: listens={:?}",
        gateway.listens
    );
    for endpoint in &gateway.listens {
        assert!(
            endpoint.address.starts_with("0.0.0.0:"),
            "{}",
            endpoint.address
        );
        assert!(!endpoint.allow_loopback_advertise);
    }

    let worker = prod_
        .partition
        .processes
        .iter()
        .find(|p| p.is_worker() && p.anchor.as_str() == "api-contracts")
        .expect("the contracts worker");
    let serve = worker.serve.as_ref().expect("a worker serves");
    assert!(!serve.allow_loopback_advertise);
    assert!(
        serve.advertise_uri.contains(&format!(
            "{}.payments.svc.cluster.local:",
            worker.subchart.as_deref().unwrap()
        )),
        "{}",
        serve.advertise_uri
    );
}

#[path = "support/resolve_fixtures.rs"]
mod support;
