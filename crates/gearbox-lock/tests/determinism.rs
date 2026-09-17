//! `cpt-gearbox-nfr-determinism`: the written lock must not depend on the
//! order the resolver happened to produce its collections in.
//!
//! This is the actual enforcement of that requirement, not a restatement of
//! it: 1000 independently shuffled orderings of the same resolved product
//! must all produce the byte-identical `product.lock`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers `#[test]` functions but not the \
              helpers in this file"
)]

mod support;

const ITERATIONS: u64 = 1000;

/// One collection of the fixture, and how to read its order out of a product.
type Probe = (&'static str, fn(&gearbox_ir::ResolvedProduct) -> String);

#[test]
fn byte_stable_across_a_thousand_shuffled_orderings() {
    let canonical_text = gearbox_lock::write_canonical(&support::fixture()).unwrap();

    for seed in 0..ITERATIONS {
        let mut shuffled = support::fixture();
        support::shuffle_orderings(&mut shuffled, seed);

        let text = gearbox_lock::write_canonical(&shuffled).unwrap();
        assert_eq!(
            text, canonical_text,
            "seed {seed} produced a different product.lock from a mere reordering \
             of the resolver's output"
        );
    }
}

#[test]
fn shuffling_actually_exercises_every_collection_it_claims_to() {
    // A guard against the shuffle helper silently becoming a no-op (e.g. if
    // fisher_yates were ever miswired to not mutate its argument) and the
    // test above passing for the wrong reason.
    //
    // Per collection, not OR-ed across two of them: the earlier version of
    // this guard inspected `provenance` and `cluster` and broke out on the
    // first seed that moved either, so the shuffle could have stopped
    // touching the other six and the determinism test above would have been
    // proving nothing about them.
    let base = support::fixture();

    // Every collection `shuffle_orderings` reorders, and the host
    // application's nested lists, which it reorders per application.
    let probes: [Probe; 8] = [
        ("applications", |p| {
            describe(&p.applications, |a| a.name.to_string())
        }),
        ("listens", |p| {
            describe(&host(p).listens, |l| l.name.clone())
        }),
        ("spawns", |p| {
            describe(&host(p).spawns, |s| s.gear.to_string())
        }),
        ("bindings", |p| {
            describe(&p.bindings, |b| b.consumer.to_string())
        }),
        ("cluster", |p| {
            describe(&p.cluster, |c| c.primitive.to_string())
        }),
        ("cuttable_if_declared", |p| {
            describe(&p.cuttable_if_declared, |c| c.provider.to_string())
        }),
        ("provenance", |p| {
            describe(&p.provenance, |e| e.because.clone())
        }),
        ("diagnostics", |p| {
            describe(p.diagnostics.as_slice(), |d| d.message.clone())
        }),
    ];

    for (collection, probe) in probes {
        let before = probe(&base);
        let reordered = (0..20).any(|seed| {
            let mut shuffled = support::fixture();
            support::shuffle_orderings(&mut shuffled, seed);
            probe(&shuffled) != before
        });
        assert!(
            reordered,
            "no seed among the first 20 reordered `{collection}`, so the \
             determinism test proves nothing about it"
        );
    }
}

/// The host application, whose nested lists the shuffle also reorders.
fn host(product: &gearbox_ir::ResolvedProduct) -> &gearbox_ir::ResolvedApplication {
    product
        .applications
        .iter()
        .find(|a| a.name.as_str() == "gateway")
        .expect("the fixture has a gateway application")
}

fn describe<T>(items: &[T], render: impl Fn(&T) -> String) -> String {
    items.iter().map(render).collect::<Vec<_>>().join(",")
}

#[test]
fn repeated_writes_of_the_same_product_are_identical() {
    let product = support::fixture();
    let first = gearbox_lock::write_canonical(&product).unwrap();
    for _ in 0..10 {
        assert_eq!(gearbox_lock::write_canonical(&product).unwrap(), first);
    }
}
