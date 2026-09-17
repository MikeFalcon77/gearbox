//! Tests for GTS type projection.
//!
//! The theme: a declaration is not a reference. `gts_id!` appears over a
//! thousand times in `gears-rust`, and almost none of those are declarations.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::PathBuf;

use super::*;
use crate::scan::scan_crate;
use crate::test_corpus::require;

fn file(src: &str) -> RustFile {
    RustFile {
        path: PathBuf::from("gts.rs"),
        relative: PathBuf::from("gts.rs"),
        ast: syn::parse_file(src).expect("fixture parses"),
    }
}

fn tree(rel: &str) -> Option<Vec<RustFile>> {
    let dir = crate::test_corpus::corpus(rel)?;
    Some(scan_crate(&dir).unwrap_or_else(|e| panic!("scan {rel}: {e}")))
}

/// Verbatim from `cluster-sdk/src/gts.rs`.
const CLUSTER: &str = r#"
    #[gts_type_schema(
        dir_path = "schemas",
        base = PluginV1,
        type_id = gts_id!("cf.toolkit.plugins.plugin.v1~cf.core.cluster.plugin.v1~"),
        description = "Cluster plugin specification",
        properties = "",
    )]
    pub struct ClusterPluginSpecV1;
"#;

#[test]
fn a_schema_attribute_declares_a_type() {
    let got = project_gts_types(&[file(CLUSTER)]).unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(
        got[0].type_id, "cf.toolkit.plugins.plugin.v1~cf.core.cluster.plugin.v1~",
        "the id is the literal inside gts_id!, which is what the compiler validated"
    );
    assert_eq!(
        got[0].description.as_deref(),
        Some("Cluster plugin specification")
    );
}

#[test]
fn a_reference_is_not_a_declaration() {
    // The distinction the whole projection rests on. These are the shapes that
    // make up the bulk of the tree's ~1200 `gts_id!` uses.
    let src = r#"
        const GTS: &str = gts_id!("cf.fstorage.file.type.v1~x.test.file.type.v1~");
        #[resource_error(gts_id!("cf.file_parser.parser.file.v1~"))]
        pub struct SomeError;
        fn f() { let _ = gts_id!("cf.whatever.v1~"); }
    "#;
    assert!(
        project_gts_types(&[file(src)]).unwrap().is_empty(),
        "none of these declares a type"
    );
}

#[test]
fn an_unsupported_macro_inside_a_function_is_still_found() {
    let src = r#"
        fn declare() {
            struct_to_gts_schema!(Thing, "cf.thing.v1~");
        }
    "#;
    let err = project_gts_types(&[file(src)]).unwrap_err();
    assert!(
        matches!(err, GtsError::UnsupportedMacro { .. }),
        "got {err}"
    );
}

#[test]
fn an_unsupported_macro_is_reported_not_skipped() {
    // Zero uses in gears-rust, so supporting it would be code with no live
    // example. Refusing keeps the gap visible instead of quietly under-reporting.
    let src = r#"struct_to_gts_schema!(Thing, "cf.thing.v1~");"#;
    let err = project_gts_types(&[file(src)]).unwrap_err();
    assert!(
        matches!(err, GtsError::UnsupportedMacro { .. }),
        "got {err}"
    );
}

#[test]
fn an_unreadable_type_id_is_reported() {
    let src = r#"
        #[gts_type_schema(dir_path = "schemas", description = "no id here")]
        pub struct Thing;
    "#;
    let err = project_gts_types(&[file(src)]).unwrap_err();
    assert!(
        matches!(err, GtsError::UnreadableTypeId { .. }),
        "got {err}"
    );
}

#[test]
fn declarations_are_sorted_and_deduplicated() {
    // The third declaration repeats `cf.a.v1~`, so the `dedup()` half actually
    // runs. Two distinct ids only ever exercised the sort.
    let src = r#"
        #[gts_type_schema(type_id = gts_id!("cf.b.v1~"))]
        pub struct B;
        #[gts_type_schema(type_id = gts_id!("cf.a.v1~"))]
        pub struct A;
        #[gts_type_schema(type_id = gts_id!("cf.a.v1~"))]
        pub struct AlsoA;
    "#;
    let got = project_gts_types(&[file(src)]).unwrap();
    assert_eq!(
        got.iter().map(|t| t.type_id.as_str()).collect::<Vec<_>>(),
        vec!["cf.a.v1~", "cf.b.v1~"],
        "sorted, so the catalogue is byte-identical across runs, and one entry \
         per id however many structs declare it"
    );
}

/// The `$id` of a `.schema.json` used to be accepted on the prefix check alone
/// and carried verbatim into `GtsTypeDecl`, which does not validate it either --
/// so this was the one identifier source with no charset or length check behind
/// it, while the Rust path gets `gts_id!`'s compile-time one.
#[test]
fn a_json_id_that_is_not_a_gts_identifier_is_not_a_declaration() {
    for id in [
        "cf.core.thing.v1~/../etc/passwd",
        "cf.core.Thing.v1~",
        "cf.core.thing-name.v1~",
        "cf.core..thing.v1~",
        "cf.core.thing.v1~~",
        "cf.core.thing.v1~ cf.other.v1~",
    ] {
        let text = format!(r#"{{"$id": "{id}"}}"#);
        assert!(
            gts_type_from_schema("thing.schema.json", &text)
                .expect("valid json")
                .is_none(),
            "`{id}` is not a GTS identifier and must not be projected as one"
        );
    }
}

#[test]
fn an_over_long_json_id_is_refused() {
    let id = format!("cf.core.{}.v1~", "a".repeat(1100));
    let text = format!(r#"{{"$id": "{id}"}}"#);
    assert!(
        gts_type_from_schema("thing.schema.json", &text)
            .expect("valid json")
            .is_none()
    );
}

/// The spellings the corpus actually carries, so the validation is not stricter
/// than the grammar it mirrors.
#[test]
fn the_real_json_id_spellings_are_accepted() {
    for id in [
        "gts://gts.cf.core.graph.edge.v1~",
        "gts://gts.cf.core.events.event.v1~cf.bss.ledger.entry_posted.v1",
        "gts://gts.cf.core.graph.edge.v1~cf.core.graph.analysis_edge.v1~",
        "cf.toolkit.plugins.plugin.v1~cf.core.cluster.plugin.v1~",
        "gts.cf.core.events.type.v1~x.commerce.orders.order_placed.v1.0~",
    ] {
        let text = format!(r#"{{"$id": "{id}"}}"#);
        assert!(
            gts_type_from_schema("thing.schema.json", &text)
                .expect("valid json")
                .is_some(),
            "`{id}` is a spelling the corpus uses"
        );
    }
}

// ---------------------------------------------------------------- json schema

#[test]
fn a_json_schema_with_a_gts_id_declares_a_type() {
    let text = r#"{"$id": "gts://cf.core.thing.v1~", "description": "A thing"}"#;
    let got = gts_type_from_schema("schemas/thing.schema.json", text)
        .expect("valid json")
        .expect("gts id");
    assert_eq!(
        got.type_id, "cf.core.thing.v1~",
        "the gts:// prefix is stripped"
    );
    assert_eq!(got.description.as_deref(), Some("A thing"));
}

#[test]
fn a_json_schema_without_a_gts_id_is_not_a_declaration() {
    let text = r#"{"$id": "https://example.com/thing.json"}"#;
    assert!(
        gts_type_from_schema("thing.json", text)
            .expect("valid json")
            .is_none()
    );
}

#[test]
fn malformed_json_is_an_error_not_a_missing_type() {
    let err = gts_type_from_schema("broken.json", "{ not json").unwrap_err();
    assert!(matches!(err, GtsError::InvalidJson { .. }), "got {err}");
}

#[test]
fn a_comment_or_string_mention_is_not_a_declaration() {
    let src = r#"
        // struct_to_gts_schema!(Thing, "cf.thing.v1~");
        const S: &str = "struct_to_gts_schema!";
        pub fn f() {}
    "#;
    assert!(
        project_gts_types(&[file(src)]).unwrap().is_empty(),
        "a mention outside a macro invocation is not a declaration"
    );
}

#[test]
fn nested_struct_to_gts_schema_is_refused() {
    let dir = std::env::temp_dir().join(format!("gearbox-gts-nested-{}", std::process::id()));
    drop(std::fs::remove_dir_all(&dir));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(
        dir.join("src/lib.rs"),
        r#"other_macro! { struct_to_gts_schema!(Thing, "cf.thing.v1~"); }"#,
    )
    .unwrap();
    let files = scan_crate(&dir).expect("scan");
    let err = project_gts_types(&files).unwrap_err();
    drop(std::fs::remove_dir_all(&dir));
    assert!(
        matches!(err, GtsError::UnsupportedMacro { .. }),
        "got {err}"
    );
}

// ---------------------------------------------------------------- real tree

#[test]
fn the_real_cluster_sdk_declares_its_plugin_type() {
    let files = require!(tree("gears/system/cluster/cluster-sdk"));
    let got = project_gts_types(&files).unwrap();
    assert!(
        got.iter()
            .any(|t| t.type_id == "cf.toolkit.plugins.plugin.v1~cf.core.cluster.plugin.v1~"),
        "got {:?}",
        got.iter().map(|t| &t.type_id).collect::<Vec<_>>()
    );
}

#[test]
fn a_gear_crate_full_of_references_declares_nothing() {
    // file-storage's tests are where `gts_id!` piles up. The main crate declares
    // no schema, and must therefore come back empty rather than with a dozen
    // spurious types.
    let files = require!(tree("gears/system/authn-resolver/authn-resolver"));
    assert!(project_gts_types(&files).unwrap().is_empty());
}
