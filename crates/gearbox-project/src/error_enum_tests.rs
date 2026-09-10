//! The projector, against inline fixtures rather than the corpus.
//!
//! The corpus test in `error_enum_corpus_tests.rs` answers "does this reference
//! still resolve"; this answers "does the parser read the grammar", which has
//! to hold whether or not a checkout is reachable.

use super::*;

fn projected(source: &str) -> Vec<ProjectedErrorEnum> {
    let file = RustFile {
        path: "/tmp/lib.rs".into(),
        relative: "lib.rs".into(),
        ast: syn::parse_file(source).expect("fixture parses"),
    };
    project_error_enums(std::slice::from_ref(&file))
}

#[test]
fn a_plain_thiserror_enum_is_projected_with_no_domain() {
    // `ClusterError`'s shape: the variants a diagnostic names, and no wire
    // identity at all. Projecting it is the whole point -- a reference must be
    // resolvable against an enum that never travels.
    let found = projected(
        r"
        #[derive(Debug, Clone, Error)]
        pub enum ClusterError {
            ProfileNotBound { profile: String },
            CapabilityNotMet { primitive: &'static str },
        }
        ",
    );
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].ident, "ClusterError");
    assert!(!found[0].derives_contract_error);
    assert_eq!(found[0].domain, None);
    let variants: Vec<&str> = found[0].variants.iter().map(|v| v.ident.as_str()).collect();
    assert_eq!(variants, ["ProfileNotBound", "CapabilityNotMet"]);
    assert!(found[0].variants.iter().all(|v| v.code.is_none()));
}

#[test]
fn a_contract_error_enum_carries_its_domain_down_to_every_variant() {
    // The enum-level `#[error_domain]` is the default and the variants inherit
    // it. Reading the code without the domain would make a `(domain, code)`
    // reference unresolvable for every enum that declares the domain once,
    // which is all of them.
    let found = projected(
        r#"
        #[derive(Debug, Clone, Serialize, Deserialize, ContractError)]
        #[error_domain("cluster.v1")]
        pub enum ClusterWireError {
            #[error_code("profile_not_bound")]
            #[canonical(FailedPrecondition)]
            ProfileNotBound { profile: String },
        }
        "#,
    );
    assert_eq!(found.len(), 1);
    assert!(found[0].derives_contract_error);
    assert_eq!(found[0].domain.as_deref(), Some("cluster.v1"));
    let variant = &found[0].variants[0];
    assert_eq!(variant.code.as_deref(), Some("profile_not_bound"));
    assert_eq!(variant.domain.as_deref(), Some("cluster.v1"));
    assert_eq!(
        variant.canonical_category.as_deref(),
        Some("FailedPrecondition")
    );
}

#[test]
fn a_variant_may_override_the_enums_domain() {
    // The macro permits it, so the projector must read it; a variant reported
    // under the enum's domain when it declares its own would resolve a
    // reference that does not exist.
    let found = projected(
        r#"
        #[derive(ContractError)]
        #[error_domain("orders.v1")]
        pub enum E {
            #[error_domain("billing.v1")]
            #[error_code("rate_limited")]
            RateLimited,
            #[error_code("not_found")]
            NotFound,
        }
        "#,
    );
    assert_eq!(found[0].variants[0].domain.as_deref(), Some("billing.v1"));
    assert_eq!(found[0].variants[1].domain.as_deref(), Some("orders.v1"));
}

#[test]
fn an_enum_inside_an_inline_module_is_found_and_says_where_it_is() {
    // The one shape the sibling projectors would miss. Missing it here is not a
    // gap in a report -- the consuming check fails on "enum not found", so a
    // nested enum would produce a red that is entirely this parser's fault.
    let found = projected(
        r"
        pub mod outer {
            pub mod inner {
                pub enum Nested { One }
            }
        }
        ",
    );
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].ident, "Nested");
    assert_eq!(found[0].module, ["outer", "inner"]);
}

#[test]
fn a_fully_qualified_derive_still_counts() {
    // By last segment, because `#[derive(toolkit_contract::ContractError)]` is
    // the same derive spelled the other legal way, and answering "no" to it
    // would misreport the enum in a failure message.
    let found = projected(
        r"
        #[derive(toolkit_contract::ContractError)]
        pub enum E { A }
        ",
    );
    assert!(found[0].derives_contract_error);
}

#[test]
fn a_module_declaration_with_no_body_is_not_descended_into() {
    // `mod foo;` names a file the directory walk reaches on its own. Following
    // it here would be a second traversal with a different idea of the tree.
    let found = projected("pub mod elsewhere;\npub enum Here { A }");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].ident, "Here");
    assert!(found[0].module.is_empty());
}
