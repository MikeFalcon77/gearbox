//! `cpt-gearbox-nfr-determinism`: the written lock must not depend on the
//! order the resolver happened to produce its collections in.
//!
//! This is the actual enforcement of that requirement, not a restatement of
//! it: 1000 independently shuffled orderings of the same resolved product
//! must all produce the byte-identical `product.lock`.

#![allow(
    clippy::unwrap_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers `#[test]` functions but not the \
              helpers in this file"
)]

mod support;

const ITERATIONS: u64 = 1000;

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
fn shuffling_actually_exercises_different_orderings() {
    // A guard against the shuffle helper silently becoming a no-op (e.g. if
    // fisher_yates were ever miswired to not mutate its argument) and the
    // test above passing for the wrong reason.
    let base = support::fixture();
    let mut any_reordered = false;

    for seed in 0..20 {
        let mut shuffled = support::fixture();
        support::shuffle_orderings(&mut shuffled, seed);
        if shuffled.provenance != base.provenance || shuffled.cluster != base.cluster {
            any_reordered = true;
            break;
        }
    }

    assert!(
        any_reordered,
        "no seed among the first 20 produced any reordering at all"
    );
}

#[test]
fn repeated_writes_of_the_same_product_are_identical() {
    let product = support::fixture();
    let first = gearbox_lock::write_canonical(&product).unwrap();
    for _ in 0..10 {
        assert_eq!(gearbox_lock::write_canonical(&product).unwrap(), first);
    }
}
