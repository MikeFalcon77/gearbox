//! `write_canonical`: header, hash format, and round-tripping through `read`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers `#[test]` functions but not the \
              helpers in this file"
)]

mod support;

use gearbox_ir::LOCK_SCHEMA_VERSION;

#[test]
fn header_names_the_gearbox_version_and_warns_against_editing() {
    let text = gearbox_lock::write_canonical(&support::fixture()).unwrap();
    let first_line = text.lines().next().unwrap();
    assert!(
        first_line.starts_with('#'),
        "first line should be a comment: {first_line}"
    );
    assert!(first_line.contains("gearbox 0.1.0"), "{first_line}");
    assert!(first_line.contains("do not edit"), "{first_line}");
    assert!(first_line.contains("gearbox resolve"), "{first_line}");
}

#[test]
fn body_starts_with_schema_version() {
    let text = gearbox_lock::write_canonical(&support::fixture()).unwrap();
    let second_line = text.lines().nth(1).unwrap();
    assert_eq!(
        second_line,
        format!("schema_version = {LOCK_SCHEMA_VERSION}")
    );
}

#[test]
fn hash_is_blake3_hex() {
    let product = support::fixture();
    let text = gearbox_lock::write_canonical(&product).unwrap();
    let parsed = gearbox_lock::read(&text).unwrap();
    let hash = &parsed.product.lock_hash;

    let hex = hash
        .strip_prefix("blake3:")
        .unwrap_or_else(|| panic!("expected a blake3: prefix, got {hash}"));
    assert_eq!(
        hex.len(),
        64,
        "a 32-byte BLAKE3 digest is 64 hex characters: {hex}"
    );
    assert!(hex.bytes().all(|b| b.is_ascii_hexdigit()), "{hex}");
}

#[test]
fn hash_changes_when_content_changes() {
    let mut a = support::fixture();
    let hash_a = gearbox_lock::write_canonical(&a).unwrap();

    a.product.version = "0.2.0".to_owned();
    let hash_b = gearbox_lock::write_canonical(&a).unwrap();

    assert_ne!(
        hash_a, hash_b,
        "changing product content must change the written lock"
    );
}

#[test]
fn write_then_read_round_trips_and_verifies() {
    let original = support::fixture();
    let text = gearbox_lock::write_canonical(&original).unwrap();
    let parsed = gearbox_lock::read(&text).unwrap();

    // write_canonical sorts and dedups (the fixture deliberately has a
    // duplicate provenance edge), so the round trip is compared against a
    // canonicalized copy of the original, not the original as constructed.
    let mut expected = original;
    gearbox_lock::canonicalize_order(&mut expected);
    expected.product.lock_hash = parsed.product.lock_hash.clone();
    assert_eq!(parsed, expected);
}

#[test]
fn rejects_an_unsupported_schema_version() {
    let mut product = support::fixture();
    product.schema_version = LOCK_SCHEMA_VERSION + 1;

    let err = gearbox_lock::write_canonical(&product).unwrap_err();
    assert!(
        matches!(
            err,
            gearbox_lock::LockError::UnsupportedSchemaVersion { .. }
        ),
        "{err}"
    );

    // A reader must refuse to guess at a version it does not understand,
    // rather than silently misreading a future format.
    let text = format!(
        "schema_version = {}\n\n[product]\nid = \"x\"\nversion = \"0\"\nprofile = \"dev\"\n\
         profile_kind = \"embedded\"\ngearbox_version = \"0.1.0\"\nlock_hash = \"blake3:00\"\n",
        LOCK_SCHEMA_VERSION + 1
    );
    let err = gearbox_lock::read(&text).unwrap_err();
    assert!(
        matches!(
            err,
            gearbox_lock::LockError::UnsupportedSchemaVersion { .. }
        ),
        "{err}"
    );
}

#[test]
fn rejects_a_hand_edited_lock() {
    let text = gearbox_lock::write_canonical(&support::fixture()).unwrap();

    // Change one value without updating the hash -- exactly what a hand edit
    // looks like, since the hash is meant to be opaque and untouched.
    let tampered = text.replacen("\"127.0.0.1:8087\"", "\"0.0.0.0:9999\"", 1);
    assert_ne!(
        tampered, text,
        "the replacement should have found its target"
    );

    let err = gearbox_lock::read(&tampered).unwrap_err();
    match err {
        gearbox_lock::LockError::HashMismatch { expected, found } => {
            assert_ne!(expected, found);
        }
        other => panic!("expected HashMismatch, got {other}"),
    }
}

#[test]
fn toml_comments_do_not_confuse_the_parser() {
    let text = gearbox_lock::write_canonical(&support::fixture()).unwrap();
    assert!(
        text.starts_with('#'),
        "sanity: the header really is a TOML comment"
    );
    // read() must succeed despite the leading comment line -- TOML comments
    // need no special stripping, but this pins the assumption down.
    gearbox_lock::read(&text).unwrap();
}

#[test]
fn read_returns_canonical_collections() {
    let mut canonical = support::fixture();
    gearbox_lock::canonicalize_order(&mut canonical);
    canonical.product.lock_hash = gearbox_lock::compute_hash(&canonical).unwrap();

    // Seed 8 moves both the process list and the diagnostics. That is not a
    // detail: with two processes a shuffle leaves them in place half the time,
    // and an earlier version of this test used a seed that did exactly that --
    // it passed against the defect it was written to catch. The assertion below
    // is total for the same reason, so no future seed can make it vacuous.
    let mut shuffled = canonical.clone();
    support::shuffle_orderings(&mut shuffled, 8);
    let text = toml::to_string_pretty(&shuffled).unwrap();
    assert_ne!(
        text,
        toml::to_string_pretty(&canonical).unwrap(),
        "the shuffle must actually reorder something, or this test proves nothing"
    );

    let parsed = gearbox_lock::read(&text).unwrap();
    assert_eq!(
        parsed, canonical,
        "read() must return the ordering it hashed, not the one the file happened to carry"
    );
}
