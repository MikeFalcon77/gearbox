//! Our contract-shape rules against the macro's own test vectors.
//!
//! GBX0207 was retired because `toolkit-contract-macros` rejects both halves of
//! it at compile time, which means Gearbox *relies* on the macro's rules rather
//! than checking them. That reliance has a cost: if our table of suffixes or our
//! version-marker rule drifts from the macro's, a contract the platform accepts
//! is silently skipped by our projector -- and a skipped contract is a provider
//! that appears to offer nothing.
//!
//! So the check moves here. Every case below is lifted from the macro crate's
//! own unit tests (`libs/toolkit-contract-macros/src/support.rs` and
//! `.../model.rs`) and asserted against our re-implementation. Named cases
//! rather than parsing the macro's source: the interface that has to agree is
//! "name in, outcome out", and comparing logic would break on a refactor that
//! changed nothing observable.

use gearbox_ir::ContractKind;
use gearbox_ir::contract::{strip_version_suffix, version_marker};

#[test]
fn stripping_matches_the_macros_vectors() {
    // From `leaves_unversioned_names_untouched` and
    // `does_not_strip_partial_or_whole_name_matches`.
    for (input, expected) in [
        ("PaymentApiV2", "PaymentApi"),
        ("FooBackendV10", "FooBackend"),
        ("PaymentApi", "PaymentApi"),
        ("EventProducerEmbedded", "EventProducerEmbedded"),
        // No `V` before the digits.
        ("Api2", "Api2"),
        // Digits absent: a bare trailing `V` is not a marker.
        ("PaymentApiV", "PaymentApiV"),
        // Nothing would remain to classify.
        ("V2", "V2"),
        ("", ""),
    ] {
        assert_eq!(
            strip_version_suffix(input),
            expected,
            "strip_version_suffix({input:?}) disagrees with the macro"
        );
    }
}

#[test]
fn classification_matches_the_macros_vectors() {
    // From `stripping_keeps_the_suffix_rule_strict` and
    // `classifies_versioned_names_by_contract_type`.
    for (input, expected) in [
        ("PaymentApiV2", Some(ContractKind::Api)),
        ("PaymentApi", Some(ContractKind::Api)),
        ("FooBackendV10", Some(ContractKind::Backend)),
        ("FooEmbeddedV2", Some(ContractKind::Embedded)),
        ("FooExtensionV2", Some(ContractKind::Extension)),
        // A versioned name whose base still lacks a contract-type suffix must
        // stay unclassifiable -- stripping must not widen it.
        ("PaymentServiceV2", None),
    ] {
        assert_eq!(
            ContractKind::from_trait_name(input),
            expected,
            "from_trait_name({input:?}) disagrees with the macro's from_suffix"
        );
    }
}

#[test]
fn version_markers_match_the_macros_vectors() {
    // From `extracts_lowercased_version_marker`. Lowercased so it compares
    // directly against the `version = "vN"` spelling.
    for (input, expected) in [
        ("PaymentApiV2", Some("v2")),
        ("FooBackendV10", Some("v10")),
        ("PaymentApi", None),
        ("V2", None),
    ] {
        assert_eq!(
            version_marker(input).as_deref(),
            expected,
            "version_marker({input:?}) disagrees with the macro"
        );
    }
}

#[test]
fn the_case_the_macro_leaves_open_is_still_open() {
    // An unmarked name is unconstrained by the declared version: ADR-0007 keeps
    // a v1 contract's name unmarked when v2 is added beside it. Recording it as
    // a test rather than as a diagnostic, because reporting it would contradict
    // the platform's own decision -- and if the macro ever tightens this, this
    // assertion is what will notice.
    assert_eq!(
        version_marker("PaymentApi"),
        None,
        "no marker means nothing to compare `version` against, so `PaymentApi` \
         with version = \"v2\" compiles and Gearbox accepts it"
    );
}
