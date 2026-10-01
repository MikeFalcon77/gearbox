//! Pins the exact shape of a written `product.lock` down as a golden file.
//!
//! Unlike the behavioral tests in `canonical.rs`, this exists to catch an
//! *accidental* shape change -- a field renamed, a table nesting changed --
//! that every assertion elsewhere would still pass, because they check
//! properties of the output, not its literal text. The fixture is fully
//! deterministic, so the hash embedded in the snapshot is stable; if it
//! moves, something about serialization changed and the snapshot diff will
//! show exactly what.
//!
//! **Not the coverage for the ordering and dedup rules.** Those are asserted
//! by name in `canonical.rs` (`canonicalize_order_sorts_*`,
//! `canonicalize_order_drops_the_duplicate_provenance_edge`), so a broken
//! rule fails a test that says which rule broke. Here it would only move a
//! whole-document text diff -- which is also how an accidental ordering
//! change gets re-accepted alongside an intended one by a `cargo insta
//! accept`.

mod support;

#[test]
fn canonical_lock_matches_the_golden_snapshot() {
    let text = gearbox_lock::write_canonical(&support::fixture()).unwrap();
    insta::assert_snapshot!(text);
}
