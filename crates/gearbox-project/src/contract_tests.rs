//! Tests for contract projection, and especially for transports.
//!
//! Transports are the interesting half: they are projected from which
//! projection traits exist beside the base, which the contract-binding design
//! calls a compile-time guarantee. A contract with no `*Rest` trait is provably
//! local, and no amount of description can make it remote.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::{Path, PathBuf};

use gearbox_ir::Transport;

use super::*;
use crate::scan::scan_crate;

fn file(src: &str) -> RustFile {
    RustFile {
        path: PathBuf::from("fixture.rs"),
        relative: PathBuf::from("fixture.rs"),
        ast: syn::parse_file(src).expect("fixture parses"),
    }
}

fn transports_of(contracts: &[ProjectedContract], ident: &str) -> Vec<&'static str> {
    contracts
        .iter()
        .find(|c| c.trait_ident == ident)
        .unwrap_or_else(|| panic!("no contract `{ident}`"))
        .transports
        .iter()
        .map(|t| t.as_str())
        .collect()
}

/// The api-contracts SDK from the sibling checkout, if present.
fn api_contracts_sdk() -> Option<Vec<RustFile>> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../gears-rust/examples/toolkit/api-contracts/api-contracts-sdk")
        .canonicalize()
        .ok()?;
    scan_crate(&dir).ok()
}

#[test]
fn a_contract_with_no_projection_is_local_only() {
    let src = r#"
        #[toolkit::contract(gear = "g", version = "v1")]
        pub trait ThingExtension: Send + Sync {}
    "#;
    let contracts = project_contracts(&[file(src)]).expect("parse");
    assert_eq!(
        transports_of(&contracts, "ThingExtension"),
        vec!["local"],
        "no projection trait means provably local; the structure of the code \
         rules out a remote binding, so the catalogue must too"
    );
}

#[test]
fn a_rest_projection_adds_rest() {
    let src = r#"
        #[toolkit::contract(gear = "g", version = "v1")]
        pub trait ThingApi: Send + Sync {}
        pub trait ThingApiRest: ThingApi {}
    "#;
    let contracts = project_contracts(&[file(src)]).expect("parse");
    assert_eq!(transports_of(&contracts, "ThingApi"), vec!["local", "rest"]);
}

#[test]
fn a_projection_must_actually_extend_the_base() {
    // A coincidentally-named trait that does not extend the base is not a
    // projection. Believing it were would put a transport in the catalogue that
    // no client can be generated for.
    let src = r#"
        #[toolkit::contract(gear = "g", version = "v1")]
        pub trait ThingApi: Send + Sync {}
        pub trait ThingApiRest: Send + Sync {}
    "#;
    let contracts = project_contracts(&[file(src)]).expect("parse");
    assert_eq!(transports_of(&contracts, "ThingApi"), vec!["local"]);
}

#[test]
fn versioned_projections_attach_to_their_own_major() {
    // `PaymentApiV2Rest` belongs to `PaymentApiV2`, not to `PaymentApi`. Getting
    // this wrong would give v1 a transport that only v2 has.
    let src = r#"
        #[toolkit::contract(gear = "g", version = "v1")]
        pub trait ThingApi: Send + Sync {}
        #[toolkit::contract(gear = "g", version = "v2")]
        pub trait ThingApiV2: Send + Sync {}
        pub trait ThingApiV2Rest: ThingApiV2 {}
    "#;
    let contracts = project_contracts(&[file(src)]).expect("parse");
    assert_eq!(transports_of(&contracts, "ThingApi"), vec!["local"]);
    assert_eq!(
        transports_of(&contracts, "ThingApiV2"),
        vec!["local", "rest"]
    );
}

#[test]
fn real_tree_v1_has_grpc_and_v2_does_not() {
    // The decisive case, and the reason transports must not be declared:
    // api-contracts-sdk has PaymentApiRest, PaymentApiGrpc and PaymentApiV2Rest
    // -- but no PaymentApiV2Grpc.
    let Some(files) = api_contracts_sdk() else {
        eprintln!("skipping: ../gears-rust not present");
        return;
    };
    let contracts = project_contracts(&files).expect("parse");

    assert_eq!(
        transports_of(&contracts, "PaymentApi"),
        vec!["local", "rest", "grpc"],
        "v1 has both projections"
    );
    assert_eq!(
        transports_of(&contracts, "PaymentApiV2"),
        vec!["local", "rest"],
        "v2 has no gRPC projection, so gRPC is not available for it"
    );
}

#[test]
fn transport_order_is_stable() {
    // The set is ordered by the IR's own enum order, not by declaration order,
    // so a catalogue built from the same tree is byte-identical.
    let a = r#"
        #[toolkit::contract(gear = "g", version = "v1")]
        pub trait ThingApi: Send + Sync {}
        pub trait ThingApiGrpc: ThingApi {}
        pub trait ThingApiRest: ThingApi {}
    "#;
    let b = r#"
        #[toolkit::contract(gear = "g", version = "v1")]
        pub trait ThingApi: Send + Sync {}
        pub trait ThingApiRest: ThingApi {}
        pub trait ThingApiGrpc: ThingApi {}
    "#;
    assert_eq!(
        transports_of(&project_contracts(&[file(a)]).expect("parse"), "ThingApi"),
        transports_of(&project_contracts(&[file(b)]).expect("parse"), "ThingApi"),
    );
    assert_eq!(
        transports_of(&project_contracts(&[file(a)]).expect("parse"), "ThingApi"),
        vec![
            Transport::Local.as_str(),
            Transport::Rest.as_str(),
            Transport::Grpc.as_str()
        ],
    );
}

// ---------------------------------------------------------------- provides

fn provides(src: &str) -> Vec<ProjectedProvide> {
    let file = syn::parse_file(src).expect("fixture parses");
    let attrs = match file.items.first().expect("one item") {
        syn::Item::Struct(s) => s.attrs.clone(),
        other => panic!("expected a struct, got {other:?}"),
    };
    project_provides(&attrs).expect("attributes parse")
}

#[test]
fn a_provider_states_the_transports_it_wires_up() {
    // Distinct from what the contract *could* support: the sdk may declare a
    // gRPC projection while this provider leaves it behind an opt-in feature.
    let got = provides(
        r"
        #[toolkit::provides(
            contract   = api_contracts_sdk::PaymentApi,
            local      = Self::build_local,
            transports = [local, rest],
        )]
        pub struct ApiContracts;
    ",
    );
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].contract_ident, "PaymentApi");
    assert_eq!(
        got[0]
            .transports
            .iter()
            .map(|t| t.as_str())
            .collect::<Vec<_>>(),
        vec!["local", "rest"]
    );
}

#[test]
fn stacked_provides_are_read_separately() {
    let got = provides(
        r"
        #[toolkit::provides(contract = sdk::PaymentApi, transports = [local, rest])]
        #[toolkit::provides(contract = sdk::PaymentApiV2, transports = [local])]
        pub struct ApiContracts;
    ",
    );
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].contract_ident, "PaymentApi");
    assert_eq!(got[1].contract_ident, "PaymentApiV2");
}

#[test]
fn a_provider_always_has_a_local_form() {
    let got = provides(
        r"
        #[toolkit::provides(contract = sdk::ThingApi, transports = [rest])]
        pub struct G;
    ",
    );
    assert!(got[0].transports.contains(&Transport::Local));
}

#[test]
fn an_unreadable_provides_is_an_error_not_a_silent_local_only() {
    // The failure mode this guards: an earlier draft swallowed the parse error
    // and returned a provider with only `local`, which looks plausible and is
    // wrong. Refusing is what makes the mistake visible.
    let file = syn::parse_file(
        r"
        #[toolkit::provides(transports = [local, rest])]
        pub struct G;
    ",
    )
    .unwrap();
    let attrs = match file.items.first().unwrap() {
        syn::Item::Struct(s) => s.attrs.clone(),
        _ => unreachable!(),
    };
    let err = project_provides(&attrs).unwrap_err();
    assert!(err.to_string().contains("contract"), "got: {err}");
}

#[test]
fn the_real_provider_offers_less_than_the_contract_allows() {
    // The case that caught the original mistake. api-contracts-sdk declares
    // PaymentApiGrpc, so gRPC is possible for v1 -- but the gear's own attribute
    // says `[local, rest]`, because the gRPC client is behind an opt-in feature.
    // Projecting the contract's possibilities as the provider's offer would put
    // a binding in the catalogue that the build does not produce.
    let Some(files) = api_contracts_sdk() else {
        eprintln!("skipping: ../gears-rust not present");
        return;
    };
    let contracts = project_contracts(&files).expect("parse");
    assert!(
        transports_of(&contracts, "PaymentApi").contains(&"grpc"),
        "the contract can support gRPC"
    );

    let gear = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../gears-rust/examples/toolkit/api-contracts/api-contracts")
        .canonicalize()
        .expect("gear crate");
    let gear_files = scan_crate(&gear).expect("scan");
    let attrs: Vec<syn::Attribute> = gear_files
        .iter()
        .flat_map(|f| f.ast.items.iter())
        .filter_map(|i| match i {
            syn::Item::Struct(s) => Some(s.attrs.clone()),
            _ => None,
        })
        .flatten()
        .collect();
    let offered = project_provides(&attrs).expect("attributes parse");

    let v1 = offered
        .iter()
        .find(|p| p.contract_ident == "PaymentApi")
        .expect("v1 is provided");
    assert!(
        !v1.transports.contains(&Transport::Grpc),
        "the provider does not wire gRPC, whatever the contract allows"
    );
}
