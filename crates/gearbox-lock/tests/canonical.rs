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
    let mut product = support::fixture();
    let before = recorded_hash(&gearbox_lock::write_canonical(&product).unwrap());

    product.product.version = "0.2.0".to_owned();
    let after = recorded_hash(&gearbox_lock::write_canonical(&product).unwrap());

    // The two hashes, not the two documents: the documents differ because
    // `version` sits in the body, so comparing them passed even against a
    // `compute_hash` that returned a constant -- the one thing this checks.
    assert_ne!(
        before, after,
        "changing product content must change the recorded hash"
    );
    assert!(before.starts_with("blake3:"), "{before}");
}

/// The `lock_hash` a written document records, read back out of it.
fn recorded_hash(lock: &str) -> String {
    gearbox_lock::read(lock).unwrap().product.lock_hash
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
        gearbox_lock::LockError::HashMismatch {
            expected,
            found,
            gearbox_version,
        } => {
            assert_ne!(expected, found);
            // The writing version, so a mismatch caused by serialization
            // drift inside one schema_version has a visible cause rather than
            // being reported as a hand edit.
            assert_eq!(gearbox_version, "0.1.0");
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
fn canonicalize_order_drops_the_duplicate_provenance_edge() {
    let mut product = support::fixture();
    assert_eq!(
        product.provenance.len(),
        4,
        "the fixture builds the ColocatedBy edge twice on purpose"
    );

    gearbox_lock::canonicalize_order(&mut product);

    assert_eq!(
        product.provenance.len(),
        3,
        "the duplicate edge must be gone: {:?}",
        product.provenance
    );
    let colocated = product
        .provenance
        .iter()
        .filter(|e| e.kind == gearbox_ir::ProvenanceKind::ColocatedBy)
        .count();
    assert_eq!(colocated, 1, "{:?}", product.provenance);
}

#[test]
fn canonicalize_order_sorts_applications_their_endpoints_and_spawns() {
    let mut product = support::fixture();
    gearbox_lock::canonicalize_order(&mut product);

    assert_eq!(
        names(&product.applications, |a| a.name.to_string()),
        ["audit-archive", "gateway", "payments-audit"]
    );
    let gateway = product
        .application(&gearbox_ir::ApplicationId::new("gateway").unwrap())
        .unwrap();
    assert_eq!(
        names(&gateway.listens, |l| l.name.clone()),
        ["admin", "rest"]
    );
    assert_eq!(
        names(&gateway.spawns, |s| s.gear.to_string()),
        ["audit-archive", "payments-audit"]
    );
}

#[test]
fn canonicalize_order_sorts_bindings_cluster_and_cut_candidates() {
    let mut product = support::fixture();
    gearbox_lock::canonicalize_order(&mut product);

    assert_eq!(
        names(&product.bindings, |b| b.consumer.to_string()),
        ["audit-archive", "payments-audit"]
    );
    assert_eq!(
        names(&product.cluster, |c| format!("{}.{}", c.scope, c.primitive)),
        ["default.cache", "default.leader-election"]
    );
    assert_eq!(
        names(&product.cuttable_if_declared, |c| format!(
            "{} -> {}",
            c.consumer, c.provider
        )),
        [
            "api-gateway -> payments-audit",
            "api-gateway -> types-registry"
        ]
    );
}

#[test]
fn canonicalize_order_sorts_inclusion_reasons_and_cluster_requesters() {
    let mut product = support::fixture();
    gearbox_lock::canonicalize_order(&mut product);

    let types_registry = &product.gears[&gearbox_ir::GearId::new("types-registry").unwrap()];
    assert_eq!(
        types_registry.selected_by,
        vec![
            gearbox_ir::InclusionReason::Selected,
            gearbox_ir::InclusionReason::ColocatedBy {
                gear: gearbox_ir::GearId::new("api-gateway").unwrap()
            },
        ],
        "the fixture lists these the other way round"
    );

    let cache = product
        .cluster
        .iter()
        .find(|c| c.primitive == gearbox_ir::ClusterPrimitive::Cache)
        .unwrap();
    assert_eq!(
        names(&cache.requesters, ToString::to_string),
        ["audit-archive", "payments-audit"]
    );
}

fn names<T>(items: &[T], render: impl Fn(&T) -> String) -> Vec<String> {
    items.iter().map(render).collect()
}

#[test]
fn rejects_malformed_toml() {
    // The common corruption of a generated file nobody is supposed to edit: a
    // truncated write.
    let text = gearbox_lock::write_canonical(&support::fixture()).unwrap();
    let cut = text.find("lock_hash").unwrap() + 14;
    let truncated = &text[..cut];

    let err = gearbox_lock::read(truncated).unwrap_err();
    assert!(
        matches!(err, gearbox_lock::LockError::Parse(_)),
        "expected Parse, got {err}"
    );

    let err = gearbox_lock::read("schema_version = = 1\n").unwrap_err();
    assert!(
        matches!(err, gearbox_lock::LockError::Parse(_)),
        "expected Parse, got {err}"
    );
}

#[test]
fn rejects_valid_toml_that_is_not_a_resolved_product() {
    // Valid TOML, right schema version, and `product.version` missing: the
    // version probe passes and the full parse is what has to refuse it.
    let text = format!(
        "schema_version = {LOCK_SCHEMA_VERSION}\n\n[product]\nid = \"x\"\n\
         profile = \"local\"\nprofile_kind = \"self-hosted\"\n\
         gearbox_version = \"0.1.0\"\nlock_hash = \"blake3:00\"\n"
    );

    let err = gearbox_lock::read(&text).unwrap_err();
    assert!(
        matches!(err, gearbox_lock::LockError::Parse(_)),
        "expected Parse, got {err}"
    );
}

#[test]
fn rejects_a_key_the_schema_does_not_read() {
    // An ignored key never reaches the hash, so a lock carrying one would
    // report as verified while saying something this build cannot see.
    let text = gearbox_lock::write_canonical(&support::fixture()).unwrap();
    let smuggled = text.replacen("[product]", "smuggled = \"value\"\n\n[product]", 1);
    assert_ne!(smuggled, text, "the insertion should have found its target");

    let err = gearbox_lock::read(&smuggled).unwrap_err();
    match err {
        gearbox_lock::LockError::UnknownField { path } => assert_eq!(path, "smuggled"),
        other => panic!("expected UnknownField, got {other}"),
    }
}

#[test]
fn rejects_a_duplicated_provenance_edge() {
    // Canonicalization erases this before hashing, so without an explicit
    // refusal the edit verifies and `read` reports a file it did not check.
    let text = gearbox_lock::write_canonical(&support::fixture()).unwrap();
    let duplicated = format!("{text}\n{}", last_provenance_block(&text));

    let err = gearbox_lock::read(&duplicated).unwrap_err();
    match err {
        gearbox_lock::LockError::DuplicateEntry { collection, .. } => {
            assert_eq!(collection, "provenance");
        }
        other => panic!("expected DuplicateEntry, got {other}"),
    }
}

/// The text of the last `[[provenance]]` table in a written lock.
fn last_provenance_block(lock: &str) -> String {
    let start = lock.rfind("[[provenance]]").unwrap();
    let rest = &lock[start..];
    let end = rest[2..].find("\n[").map_or(rest.len(), |i| i + 2);
    rest[..end].to_owned()
}

#[test]
fn rejects_a_layout_that_is_not_one_path_segment() {
    // The lock is the one way into the generator that skips the GDL front
    // end's check, and `layout` is joined onto the output root.
    let mut product = support::fixture();
    product.product.layout = "../../etc".to_owned();
    let text = gearbox_lock::write_canonical(&product).unwrap();

    let err = gearbox_lock::read(&text).unwrap_err();
    match err {
        gearbox_lock::LockError::InvalidContent { field, .. } => {
            assert_eq!(field, "product.layout");
        }
        other => panic!("expected InvalidContent, got {other}"),
    }
}

#[test]
fn rejects_a_spawn_bin_name_that_names_a_path() {
    // A spawn's bin_name becomes a binary the host starts.
    let mut product = support::fixture();
    product.applications[0].spawns[0].bin_name = "../../../usr/bin/env".to_owned();
    let text = gearbox_lock::write_canonical(&product).unwrap();

    let err = gearbox_lock::read(&text).unwrap_err();
    match err {
        gearbox_lock::LockError::InvalidContent { field, .. } => {
            assert_eq!(field, "applications.gateway.spawns.bin_name");
        }
        other => panic!("expected InvalidContent, got {other}"),
    }
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
