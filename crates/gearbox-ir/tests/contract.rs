//! Contract classification and compatibility.
//!
//! The classification rules mirror
//! `toolkit_contract_macros::{model::ContractKind::from_suffix,
//! support::strip_version_suffix, support::version_marker}` in `gears-rust`.
//! Gearbox must classify a trait name exactly as the macro does, because a
//! disagreement means `gearbox validate` blesses a contract the compiler will
//! reject, or rejects one it accepts.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers `#[test]` functions but not the \
              helpers in this file; a fixture builder that propagates errors instead of \
              panicking obscures the assertion it exists to support"
)]

use std::collections::BTreeSet;

use gearbox_ir::{
    CargoRef, ContractDescriptor, ContractId, ContractKind, ContractVersion, GearId,
    ProviderDescriptor, RelPath, Transport, strip_version_suffix, version_marker,
};

#[test]
fn strips_only_a_genuine_major_marker() {
    // Digits must be present, preceded by `V`, and leave something to classify.
    assert_eq!(strip_version_suffix("PaymentApiV2"), "PaymentApi");
    assert_eq!(strip_version_suffix("PaymentApiV10"), "PaymentApi");
    assert_eq!(strip_version_suffix("PaymentApi"), "PaymentApi");

    // No digits, so nothing to strip.
    assert_eq!(strip_version_suffix("PaymentApiV"), "PaymentApiV");
    // Nothing would remain in front of the `V`.
    assert_eq!(strip_version_suffix("V2"), "V2");
    // The digits are not preceded by `V`.
    assert_eq!(strip_version_suffix("Api2"), "Api2");
    // Lowercase `v` is not a marker.
    assert_eq!(strip_version_suffix("Paymentv2"), "Paymentv2");
}

#[test]
fn reads_the_major_marker_lowercased() {
    assert_eq!(version_marker("PaymentApiV2").as_deref(), Some("v2"));
    assert_eq!(version_marker("PaymentApiV10").as_deref(), Some("v10"));
    assert_eq!(version_marker("PaymentApi"), None);
    assert_eq!(version_marker("V2"), None);
}

#[test]
fn classifies_by_suffix_ignoring_the_major_marker() {
    use ContractKind::{Api, Backend, Embedded, Extension};
    for (name, expected) in [
        // The contracts that actually exist in gears-rust today.
        ("PaymentApi", Api),
        ("PaymentApiV2", Api),
        ("PaymentsAuditApi", Api),
        // The other three kinds are implemented in the runtime but unused there.
        ("TypesRegistryEmbedded", Embedded),
        ("StorageBackend", Backend),
        ("StorageBackendV3", Backend),
        ("AuditExtension", Extension),
    ] {
        assert_eq!(
            ContractKind::from_trait_name(name),
            Some(expected),
            "`{name}` classified wrongly"
        );
    }
}

#[test]
fn rejects_trait_names_with_no_recognised_suffix() {
    // The macro makes this a compile error, so Gearbox must not accept it.
    for name in [
        "PaymentClient",
        "PaymentApiRest",
        "Payment",
        "PaymentService",
    ] {
        assert_eq!(
            ContractKind::from_trait_name(name),
            None,
            "`{name}` should not classify as any contract kind"
        );
    }
}

#[test]
fn kind_determines_direction_and_reach() {
    use ContractKind::{Api, Backend, Embedded, Extension};

    // Provided vs required, and the placement constraint.
    for (kind, provides, requires, remote) in [
        (Api, true, false, true),
        (Embedded, true, false, false),
        (Backend, false, true, true),
        (Extension, false, true, false),
    ] {
        assert_eq!(kind.provides(), provides, "{kind:?}.provides()");
        assert_eq!(kind.requires(), requires, "{kind:?}.requires()");
        assert_eq!(kind.remote_capable(), remote, "{kind:?}.remote_capable()");
        // Every kind either provides or requires, never both, never neither.
        assert_ne!(kind.provides(), kind.requires());
    }

    // Round-trip: a kind's suffix classifies back to that kind.
    for kind in ContractKind::ALL {
        let synthetic = format!("Some{}", kind.suffix());
        assert_eq!(ContractKind::from_trait_name(&synthetic), Some(*kind));
    }
}

#[test]
fn versions_parse_and_compare_on_the_major_only() {
    let v1 = ContractVersion::parse("v1").unwrap();
    let v2 = ContractVersion::parse("v2").unwrap();
    assert_eq!(v1.major, 1);
    assert_eq!(v1.declared, "v1");
    assert_eq!(ContractVersion::parse("v10").unwrap().major, 10);

    // Compatibility is exact major equality: parallel majors coexist by design
    // and there is no adapter between them.
    assert!(v1.satisfied_by(&v1));
    assert!(!v1.satisfied_by(&v2));
    assert!(!v2.satisfied_by(&v1));

    // The declared spelling is preserved, because it appears in a REST path.
    assert_eq!(ContractVersion::from_major(3).declared, "v3");
    assert_eq!(v2.to_string(), "v2");
}

#[test]
fn refuses_version_spellings_it_cannot_order() {
    // Legal in the macro for an unmarked trait name, but Gearbox cannot order
    // them, so it refuses rather than guessing a major.
    for bad in ["1", "v", "v01", "v1beta1", "beta", "", "V1"] {
        assert!(
            ContractVersion::parse(bad).is_err(),
            "ContractVersion accepted `{bad}`"
        );
    }
}

#[test]
fn only_rest_can_carry_a_severed_edge() {
    // The consumption macro emits a REST resolving client and has no gRPC
    // branch, so gRPC on a severed edge would be configuration that does
    // nothing.
    assert!(Transport::Rest.usable_on_severed_edge());
    assert!(!Transport::Grpc.usable_on_severed_edge());
    assert!(!Transport::Local.usable_on_severed_edge());

    assert!(Transport::Rest.is_remote());
    assert!(Transport::Grpc.is_remote());
    assert!(!Transport::Local.is_remote());
}

#[test]
fn transports_serialize_as_lowercase_names() {
    // These strings end up in a product.lock and in generated configuration,
    // where they must match the runtime's own spelling.
    for (t, s) in [
        (Transport::Local, "\"local\""),
        (Transport::Rest, "\"rest\""),
        (Transport::Grpc, "\"grpc\""),
    ] {
        assert_eq!(serde_json::to_string(&t).unwrap(), s);
        assert_eq!(serde_json::from_str::<Transport>(s).unwrap(), t);
    }
}

fn sdk_ref() -> CargoRef {
    CargoRef::new(
        "cf-api-contracts-sdk",
        "api_contracts_sdk",
        RelPath::new("../api-contracts-sdk").unwrap_or_else(|_| RelPath::here()),
    )
}

fn descriptor(rust_path: &str, version: &str) -> ContractDescriptor {
    let trait_ident = rust_path.rsplit_once("::").unwrap().1;
    ContractDescriptor {
        id: ContractId::new(format!(
            "api-contracts/{}@{version}",
            strip_version_suffix(trait_ident)
        ))
        .unwrap(),
        owner: GearId::new("api-contracts").unwrap(),
        base_name: strip_version_suffix(trait_ident).to_owned(),
        version: ContractVersion::parse(version).unwrap(),
        kind: ContractKind::from_trait_name(trait_ident).unwrap(),
        rust_path: rust_path.to_owned(),
        sdk: sdk_ref(),
        rest: None,
        grpc: None,
    }
}

#[test]
fn descriptor_exposes_the_versioned_trait_and_its_wiring_key() {
    let v2 = descriptor("api_contracts_sdk::PaymentApiV2", "v2");

    // Generated code names the versioned trait, marker and all.
    assert_eq!(v2.trait_ident(), "PaymentApiV2");
    assert_eq!(v2.base_name, "PaymentApi");
    assert!(v2.remote_capable());

    // The runtime keys client wiring by the snake_case trait identifier.
    assert_eq!(v2.wiring_key(), "payment_api_v2");
    assert_eq!(
        descriptor("api_contracts_sdk::PaymentApi", "v1").wiring_key(),
        "payment_api"
    );
}

#[test]
fn two_majors_are_one_family_with_distinct_ids() {
    let v1 = descriptor("api_contracts_sdk::PaymentApi", "v1");
    let v2 = descriptor("api_contracts_sdk::PaymentApiV2", "v2");

    assert_eq!(v1.base_name, v2.base_name, "same contract family");
    assert_ne!(v1.id, v2.id, "distinct identities");
    assert_eq!(v1.id.as_str(), "api-contracts/PaymentApi@v1");
    assert_eq!(v2.id.as_str(), "api-contracts/PaymentApi@v2");
    assert!(!v1.version.satisfied_by(&v2.version));
}

#[test]
fn cargo_ref_never_derives_the_library_identifier() {
    // cf-api-contracts has no [lib] section, so its library identifier comes
    // from the package name and is NOT the gear name in snake_case. Deriving it
    // would emit a link line that does not compile.
    let awkward = CargoRef::new("cf-api-contracts", "cf_api_contracts", RelPath::here());
    assert_eq!(awkward.lib_ident, "cf_api_contracts");
    assert_ne!(awkward.lib_ident, "api_contracts");
    assert_eq!(awkward.link_idents(), ["cf_api_contracts"]);
}

#[test]
fn cargo_ref_link_set_supports_nested_plugin_modules() {
    // A gear's plugins are separate registrations inside the same crate; each
    // needs its own `use ... as _;` line.
    let mut with_plugins = CargoRef::new("cf-gears-mini-chat", "mini_chat", RelPath::here());
    with_plugins
        .link
        .push("mini_chat::infra::plugins::static_audit".to_owned());
    assert_eq!(
        with_plugins.link_idents(),
        ["mini_chat", "mini_chat::infra::plugins::static_audit"]
    );

    // An empty link set still yields the library itself.
    let mut bare = CargoRef::new("cf-gears-cluster", "cluster", RelPath::here());
    bare.link.clear();
    assert_eq!(bare.link_idents(), ["cluster"]);
}

#[test]
fn provider_serves_remotely_only_with_rest() {
    let contract = ContractId::new("api-contracts/PaymentApi@v1").unwrap();
    let gear = GearId::new("api-contracts").unwrap();

    let make = |transports: &[Transport]| ProviderDescriptor {
        contract: contract.clone(),
        provider_gear: gear.clone(),
        local_factory: Some("Self::build_local".to_owned()),
        transports: transports.iter().copied().collect(),
        policies: Vec::new(),
    };

    assert!(make(&[Transport::Local, Transport::Rest]).serves_remotely());
    assert!(!make(&[Transport::Local]).serves_remotely());
    // gRPC alone is not enough: a severed edge cannot use it.
    assert!(!make(&[Transport::Local, Transport::Grpc]).serves_remotely());
}

#[test]
fn transport_sets_order_canonically() {
    // Ordered sets throughout the model are what make output byte-identical.
    let set: BTreeSet<Transport> = [Transport::Grpc, Transport::Local, Transport::Rest]
        .into_iter()
        .collect();
    let ordered: Vec<&str> = set.iter().map(|t| t.as_str()).collect();
    assert_eq!(ordered, ["local", "rest", "grpc"]);
}

#[test]
fn descriptors_round_trip_through_json() {
    let original = descriptor("api_contracts_sdk::PaymentApiV2", "v2");
    let json = serde_json::to_string(&original).unwrap();
    assert_eq!(
        serde_json::from_str::<ContractDescriptor>(&json).unwrap(),
        original
    );
    // Absent projections leave no keys behind.
    assert!(!json.contains("rest"));
    assert!(!json.contains("grpc"));
}
