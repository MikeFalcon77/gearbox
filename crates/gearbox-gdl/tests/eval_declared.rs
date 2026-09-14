//! Evaluating a `gear.gdl` into the facts it declares.
//!
//! This crate produces only the *declared* half. The gear's identity,
//! capabilities, co-location dependencies, lifecycle and client trait are
//! projected from Rust by `gearbox-project`, and the two halves are merged in
//! `gearbox-engine` -- so there is deliberately no `GearDescriptor` here to
//! assert against.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use gearbox_gdl::{FileIdentity, GdlEngine, GearDecl};
use gearbox_ir::{DiagnosticCode, RelPath, SourceId};

fn identity() -> FileIdentity {
    FileIdentity {
        uri: "file:///repo/gears/demo/gear.gdl".to_owned(),
        source: SourceId::new("gears-rust").unwrap(),
        gdl_path: RelPath::new("gears/demo/gear.gdl").unwrap(),
        load_paths: None,
    }
}

fn eval(src: &str) -> (Option<GearDecl>, Vec<DiagnosticCode>) {
    let out = GdlEngine::new().eval_gear(&identity(), src);
    let codes = out.diagnostics.iter().map(|d| d.code).collect();
    (out.value, codes)
}

/// The real api-contracts description, post-ADR: no id, no caps, no deps.
const API_CONTRACTS: &str = r#"
PAYMENT_SDK = cargo(
    crate_name = "cf-api-contracts-sdk",
    lib = "cf_api_contracts_sdk",
    path = "../api-contracts-sdk",
    features = ["rest-client"],
)

gear(
    name = "Payments (example provider)",
    category = "example",
    visibility = "public",
    package = cargo(crate_name = "cf-api-contracts", lib = "cf_api_contracts", path = "."),
    provides = [
        provide(
            contract = "PaymentApi",
            rust = "api_contracts_sdk::PaymentApi",
            sdk = PAYMENT_SDK,
            local = "Self::build_local",
            rest = rest(base_path = "/api-contracts/v1"),
        ),
    ],
    serves = [endpoint(name = "rest", via = "rest_host")],
)
"#;

#[test]
fn evaluates_the_declared_half() {
    let (value, codes) = eval(API_CONTRACTS);
    assert!(codes.is_empty(), "unexpected diagnostics: {codes:?}");
    let decl = value.expect("a declaration");

    assert_eq!(decl.name.as_deref(), Some("Payments (example provider)"));
    assert_eq!(decl.category.as_deref(), Some("example"));
    assert_eq!(decl.visibility.as_deref(), Some("public"));

    // The lib ident is taken as declared, never derived: cf-api-contracts has
    // no [lib] section, so deriving would produce `api_contracts` and emit a
    // link line that does not compile.
    let package = decl.package.expect("package");
    assert_eq!(package.lib_ident, "cf_api_contracts");
    assert_ne!(package.lib_ident, "api_contracts");
    assert!(package.attr.is_none(), "omitted attr means scan src/");

    // `contract` is a join key against #[toolkit::contract], not a declaration
    // of identity -- so there is no version or kind to assert here.
    assert_eq!(decl.provides.len(), 1);
    assert_eq!(decl.provides[0].contract, "PaymentApi");
    assert_eq!(decl.provides[0].rust, "api_contracts_sdk::PaymentApi");
    // No transports to assert either: which ones exist follows from the
    // `<Base>Rest`/`<Base>Grpc` traits in the sdk crate, and is projected.
    assert_eq!(
        decl.provides[0].rest.as_ref().unwrap().base_path,
        "/api-contracts/v1"
    );
    // The sdk reference is what lets the projector find the contract attribute.
    assert_eq!(decl.provides[0].sdk.lib_ident, "cf_api_contracts_sdk");

    assert_eq!(decl.serves.len(), 1);
    assert_eq!(decl.serves[0].via.as_deref(), Some("rest_host"));
}

#[test]
fn a_top_level_assignment_shares_an_sdk() {
    // Binding a name is legal; it is control flow that is forbidden.
    let (value, codes) = eval(API_CONTRACTS);
    assert!(codes.is_empty(), "{codes:?}");
    assert_eq!(
        value.unwrap().provides[0].sdk.features,
        ["rest-client"],
        "the shared SDK record carried its features through the binding"
    );
}

#[test]
fn consume_declares_the_product_level_facts_only() {
    let src = r#"
SDK = cargo(crate_name = "s", lib = "s")
gear(
    package = cargo(crate_name = "c", lib = "c"),
    consumes = [
        consume(contract = "PaymentApi", rust = "s::PaymentApi", sdk = SDK,
                critical = True),
    ],
)
"#;
    let (value, codes) = eval(src);
    assert!(codes.is_empty(), "{codes:?}");
    let decl = value.unwrap();
    assert_eq!(decl.consumes.len(), 1);
    // Whether it gates readiness is a product judgement and stays here. Which
    // gear supplies it is not: `#[toolkit::consumes(from = ...)]` owns that.
    assert!(decl.consumes[0].critical);
}

#[test]
fn from_is_refused_because_the_attribute_owns_the_directory_key() {
    // The runtime reads the attribute's spelling as a directory key, so a
    // second copy here is a second place for it to be wrong. Refused rather
    // than cross-checked, which is what ADR
    // `cpt-gearbox-adr-macro-projected-catalogue` asks for everywhere else --
    // and refused under GBX0210, the code that names the owning attribute
    // instead of saying "unknown argument".
    let src = r#"
SDK = cargo(crate_name = "s", lib = "s")
gear(
    package = cargo(crate_name = "c", lib = "c"),
    consumes = [
        consume(contract = "PaymentApi", rust = "s::PaymentApi", sdk = SDK,
                from_ = "api-contracts"),
    ],
)
"#;
    let (value, codes) = eval(src);
    assert!(value.is_none());
    assert_eq!(codes, [DiagnosticCode::ValidateRestatement]);
}

#[test]
fn cluster_capabilities_resolve_against_their_primitive() {
    let src = r#"
gear(
    package = cargo(crate_name = "c", lib = "c"),
    requires = [
        cluster.cache(profile = "default", capabilities = [cluster_cap.linearizable]),
        cluster.leader_election(profile = "default"),
    ],
)
"#;
    let (value, codes) = eval(src);
    assert!(codes.is_empty(), "{codes:?}");
    let decl = value.unwrap();
    assert_eq!(decl.requires.len(), 2);
    assert_eq!(
        decl.requires[0].capabilities,
        ["cluster.cache.linearizable"],
        "the bare `linearizable` member resolved against the cache primitive"
    );
    assert!(decl.requires[1].capabilities.is_empty());
}

#[test]
fn prefix_watch_is_refused_on_a_lock_because_it_is_a_cache_property() {
    let src = r#"
gear(package = cargo(crate_name = "c", lib = "c"),
     requires = [cluster.lock(capabilities = [cluster_cap.prefix_watch])])
"#;
    let (value, codes) = eval(src);
    assert!(value.is_none());
    assert_eq!(codes, [DiagnosticCode::GdlEval]);
}

#[test]
fn a_value_from_the_wrong_namespace_is_refused() {
    // The namespace tag is what catches this: a bare string could not.
    let src = r#"
gear(package = cargo(crate_name = "c", lib = "c"),
     requires = [cluster.cache(capabilities = [transport.rest])])
"#;
    let (value, codes) = eval(src);
    assert!(value.is_none());
    assert_eq!(codes, [DiagnosticCode::GdlEval]);
}

#[test]
fn roles_are_recorded_but_refused_with_cited_evidence() {
    let src = r#"
gear(package = cargo(crate_name = "c", lib = "c"),
     roles = [role(name = "ingest", sharded = True, instance_addressable = True)])
"#;
    let (value, codes) = eval(src);
    // Roles must not prevent evaluation -- they are carried forward.
    let decl = value.expect("a declaration");
    assert_eq!(decl.declared_roles.len(), 1);
    assert!(decl.declared_roles[0].sharded);
    // The refusal happens at merge, so nothing here yet; the declaration simply
    // survives. (Gap diagnostics are asserted in gearbox-engine.)
    assert!(codes.is_empty(), "{codes:?}");
}

#[test]
fn a_missing_package_is_an_error_because_it_locates_the_crate_to_scan() {
    let (value, codes) = eval(r#"gear(name = "Demo")"#);
    assert!(value.is_none());
    // The macro rejects the call outright for a missing required argument.
    assert!(!codes.is_empty(), "a missing package must be reported");
}

#[test]
fn zero_and_two_declarations_are_both_cardinality_errors() {
    let (value, codes) = eval("X = 1\n");
    assert!(value.is_none());
    assert_eq!(codes, [DiagnosticCode::GdlCardinality]);

    let two = r#"
gear(package = cargo(crate_name = "a", lib = "a"))
gear(package = cargo(crate_name = "b", lib = "b"))
"#;
    let (_, codes) = eval(two);
    assert!(codes.contains(&DiagnosticCode::GdlCardinality), "{codes:?}");
}

#[test]
fn a_forbidden_construct_reports_every_occurrence() {
    let src = r#"gear(package = cargo(crate_name = "c" if True else "d", lib = "c"))"#;
    let (value, codes) = eval(src);
    assert!(value.is_none());
    assert!(
        codes
            .iter()
            .all(|c| *c == DiagnosticCode::GdlForbiddenConstruct),
        "{codes:?}"
    );
    assert_eq!(codes.len(), 2, "both `if` and `else`, not just the first");
}

#[test]
fn a_syntax_error_carries_a_span() {
    let out = GdlEngine::new().eval_gear(&identity(), "gear(package = \n");
    assert!(out.value.is_none());
    let diags = out.diagnostics.as_slice();
    assert_eq!(diags[0].code, DiagnosticCode::GdlParse);
    assert!(
        diags[0].location.is_some(),
        "a parse error must carry a span"
    );
}

#[test]
fn every_diagnostic_satisfies_the_prd_invariants() {
    for src in [
        API_CONTRACTS,
        "X = 1\n",
        r#"gear(package = cargo(crate_name = "c", lib = "c"), id = "x")"#,
        r#"gear(package = cargo(crate_name = "c", lib = "c"), nope = 1)"#,
    ] {
        let out = GdlEngine::new().eval_gear(&identity(), src);
        for d in &out.diagnostics {
            assert!(d.validate().is_ok(), "{:?} -> {:?}", d.code, d.validate());
        }
    }
}
