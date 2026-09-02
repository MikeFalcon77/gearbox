//! Steps 9 and 10: the lock, and the graph that explains it.
//!
//! The claim under test is the one the whole project is measured by: the same
//! description resolves to three different products, each reproducible byte for
//! byte. A hash that changed when nothing did would make the lock worthless, and
//! a hash that stayed the same when the topology changed would make it a lie.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use gearbox_engine::resolve::{product, resolve};
use gearbox_engine::{SourceRoot, load_catalogue};
use gearbox_ir::{
    Catalogue, ProductIntent, ProfileId, ProvenanceKind, ResolvedProduct, ResolvedSource, SourceId,
    SourceKind,
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

fn fixtures() -> Option<(Catalogue, ProductIntent)> {
    let root = gears_rust()?;
    let source = SourceRoot::open(SourceId::new("gears-rust").unwrap(), root).ok()?;
    let catalogue = load_catalogue(&[source]).catalogue;
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../products/payments-demo/product.gdl")
        .canonicalize()
        .ok()?;
    let intent = gearbox_engine::product::load_product(&path, None).intent?;
    Some((catalogue, intent))
}

macro_rules! require {
    ($cat:ident, $prod:ident) => {
        let (Some(($cat, $prod)), ()) = (fixtures(), ()) else {
            eprintln!("skipping: ../gears-rust or the product description is not present");
            return;
        };
    };
}

fn sources() -> BTreeMap<SourceId, ResolvedSource> {
    let id = SourceId::new("gears-rust").unwrap();
    [(
        id.clone(),
        ResolvedSource {
            id,
            kind: SourceKind::Path,
            location: "../gears-rust".to_owned(),
            digest: "path:../gears-rust".to_owned(),
        },
    )]
    .into_iter()
    .collect()
}

fn lock(cat: &Catalogue, intent: &ProductIntent, profile: &str) -> ResolvedProduct {
    let r = resolve(cat, intent, &ProfileId::new(profile).unwrap());
    product::assemble(cat, intent, &r, sources())
}

#[test]
fn one_description_gives_three_different_locks() {
    require!(cat, prod);
    let dev = lock(&cat, &prod, "dev");
    let local = lock(&cat, &prod, "local");
    let production = lock(&cat, &prod, "prod");

    let hashes = [
        dev.product.lock_hash.as_str(),
        local.product.lock_hash.as_str(),
        production.product.lock_hash.as_str(),
    ];
    let distinct: std::collections::BTreeSet<&str> = hashes.iter().copied().collect();
    assert_eq!(
        distinct.len(),
        3,
        "three topologies, three locks: {hashes:?}"
    );
    for h in hashes {
        assert!(h.starts_with("blake3:"), "{h}");
    }

    assert_eq!(dev.processes.len(), 1);
    assert_eq!(local.processes.len(), 2);
    assert_eq!(production.processes.len(), 3);
    // The gear set is the same in all three: co-location is link-time, and no
    // profile can change what a binary must contain.
    assert_eq!(dev.gears.len(), local.gears.len());
    assert_eq!(dev.gears.len(), production.gears.len());
}

#[test]
fn resolving_twice_gives_the_same_bytes() {
    // The property the lock exists for. Anything that made this fail — an
    // iteration order, a timestamp, a path — would make "did it change" a
    // judgement instead of a comparison.
    require!(cat, prod);
    for profile in ["dev", "local", "prod"] {
        let a = lock(&cat, &prod, profile);
        let b = lock(&cat, &prod, profile);
        assert_eq!(a.product.lock_hash, b.product.lock_hash, "{profile}");
        assert_eq!(
            gearbox_lock::write_canonical(&a).unwrap(),
            gearbox_lock::write_canonical(&b).unwrap(),
            "{profile}"
        );
    }
}

#[test]
fn the_hash_covers_the_body_and_not_itself() {
    // Elided before hashing, so writing the hash into the document cannot change
    // it. Without that, the value would never stabilise.
    require!(cat, prod);
    let mut product = lock(&cat, &prod, "prod");
    let recorded = product.product.lock_hash.clone();
    let recomputed = gearbox_lock::compute_hash(&product).unwrap();
    assert_eq!(recorded, recomputed, "the recorded hash is self-consistent");

    product.processes[0].replicas += 1;
    assert_ne!(
        gearbox_lock::compute_hash(&product).unwrap(),
        recorded,
        "a change to the body must change the hash"
    );
}

#[test]
fn the_lock_round_trips() {
    require!(cat, prod);
    let written = gearbox_lock::write_canonical(&lock(&cat, &prod, "local")).unwrap();
    let read = gearbox_lock::read(&written).unwrap();
    assert_eq!(
        gearbox_lock::write_canonical(&read).unwrap(),
        written,
        "reading and rewriting must be a fixed point"
    );
}

#[test]
fn the_lock_carries_a_generated_header() {
    require!(cat, prod);
    let written = gearbox_lock::write_canonical(&lock(&cat, &prod, "dev")).unwrap();
    assert!(
        written.starts_with("# GENERATED by gearbox"),
        "{written:.80}"
    );
    assert!(written.contains("do not edit"));
}

#[test]
fn every_gear_records_why_it_is_in_the_product() {
    require!(cat, prod);
    let product = lock(&cat, &prod, "dev");
    for (id, gear) in &product.gears {
        assert!(!gear.selected_by.is_empty(), "{id} has no reason");
        assert_eq!(&gear.id, id);
    }
}

#[test]
fn the_explanation_names_the_gear_that_pulled_each_one_in() {
    // The question this graph exists to answer. `grpc-hub` is in the product
    // only because `api-gateway` reaches it, and the edge says so.
    require!(cat, prod);
    let r = resolve(&cat, &prod, &ProfileId::new("dev").unwrap());
    let graph = product::explain(&cat, &prod, &r);

    let colocated: Vec<&str> = graph
        .edges
        .iter()
        .filter(|e| e.kind == ProvenanceKind::ColocatedBy)
        .map(|e| e.because.as_str())
        .collect();
    assert!(
        colocated
            .iter()
            .any(|why| why.contains("`api-gateway` declares `grpc-hub`")),
        "{colocated:#?}"
    );
    assert!(
        colocated.iter().all(|why| why.contains("cannot be cut")),
        "each one must say why the edge is not severable"
    );
}

#[test]
fn a_downgraded_binding_points_at_the_code_that_downgraded_it() {
    // "You asked for X and got Y, because GBXnnnn" — the edge Explain renders.
    let cat = support::catalogue_with_declared_edge();
    let mut intent = support::intent(&["host", "provider"]);
    intent.bindings.push(gearbox_ir::BindingIntent {
        consumer: gearbox_ir::GearId::new("host").unwrap(),
        contract: gearbox_ir::ContractId::new("provider/Thing@v1").unwrap(),
        mode: gearbox_ir::BindingMode::Remote,
        transport: None,
        endpoint: None,
        profiles: std::collections::BTreeSet::new(),
        declared_at: None,
    });

    let r = resolve(&cat, &intent, &ProfileId::new("dev").unwrap());
    let graph = product::explain(&cat, &intent, &r);
    let edge = graph
        .edges
        .iter()
        .find(|e| e.kind == ProvenanceKind::DowngradedBy)
        .expect("a downgrade edge");
    assert!(
        edge.to.as_str().starts_with("diagnostic:GBX"),
        "{:?}",
        edge.to
    );
    assert!(edge.because.contains("not honoured"), "{}", edge.because);
}

#[test]
fn the_graph_is_byte_stable() {
    // Node ids are derived from what they name rather than from a counter, so
    // two runs produce the same graph and a diff of two locks shows only real
    // change.
    require!(cat, prod);
    let r = resolve(&cat, &prod, &ProfileId::new("prod").unwrap());
    let a = product::explain(&cat, &prod, &r);
    let b = product::explain(&cat, &prod, &r);
    assert_eq!(a.nodes, b.nodes);
    assert_eq!(a.edges, b.edges);
    assert!(
        a.nodes.keys().all(|id| !id.as_str().ends_with(":0")),
        "an id ending in a counter would give this away"
    );
}

#[test]
fn a_blocked_cut_appears_in_the_graph_as_well_as_the_diagnostics() {
    // "Why is this one process" is answered by what could not be separated, so
    // the constraint belongs in the graph and not only in a warning list.
    let cat = support::catalogue_with_declared_edge_and_dep();
    let intent = support::intent(&["host", "provider"]);
    let r = resolve(&cat, &intent, &ProfileId::new("dev").unwrap());
    let graph = product::explain(&cat, &intent, &r);
    assert!(
        graph
            .edges
            .iter()
            .any(|e| e.kind == ProvenanceKind::ConstrainedBy
                && e.because.contains("ColocationClosure")),
        "{:#?}",
        graph.edges
    );
}

#[test]
fn explanation_nodes_carry_declaration_origins() {
    // Selected gears point at use_gear in the product; colocated gears point at
    // gear(...) in their own description. Without both, most "why" steps stay mute.
    require!(cat, prod);
    let r = resolve(&cat, &prod, &ProfileId::new("dev").unwrap());
    let graph = product::explain(&cat, &prod, &r);

    let gateway = graph
        .nodes
        .get(&gearbox_ir::NodeId::new("gear:api-gateway").unwrap())
        .expect("api-gateway node");
    let gateway_origin = gateway.origin.as_ref().expect("selected gear has origin");
    assert!(
        gateway_origin.uri.contains("product.gdl"),
        "{}",
        gateway_origin.uri
    );
    assert!(
        gateway_origin.range.start.line > 0,
        "must not point at the first line of the file: {gateway_origin:?}"
    );

    let types = graph
        .nodes
        .get(&gearbox_ir::NodeId::new("gear:types-registry").unwrap())
        .expect("types-registry node");
    let types_origin = types.origin.as_ref().expect("colocated gear has origin");
    assert!(
        types_origin.uri.contains("gear.gdl"),
        "{}",
        types_origin.uri
    );
}

#[path = "support/resolve_fixtures.rs"]
mod support;
