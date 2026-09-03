//! Tests for the config type check.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::collections::{BTreeMap, BTreeSet};

use gearbox_ir::{ConfigFieldDecl, ConfigSchema, GearDescriptor, GearId, SourceId};

use super::*;

fn field(name: &str, ty: ConfigFieldType) -> ConfigFieldDecl {
    ConfigFieldDecl {
        name: name.to_owned(),
        ty,
        required: false,
        default: None,
        doc: None,
        secret: false,
    }
}

/// A catalogue of one gear exposing three fields of different shapes.
fn catalogue() -> Catalogue {
    let mut gear = GearDescriptor {
        config_schema: Some(ConfigSchema {
            rust: "DemoConfig".to_owned(),
            fields: vec![
                field("bind_addr", ConfigFieldType::Str),
                field("enable_docs", ConfigFieldType::Bool),
                field("port", ConfigFieldType::Int),
                field("ratio", ConfigFieldType::Float),
                field(
                    "mode",
                    ConfigFieldType::Enum {
                        variants: vec!["accept_all".to_owned(), "static_tokens".to_owned()],
                    },
                ),
                field("nested", ConfigFieldType::Complex),
            ],
        }),
        ..demo_descriptor()
    };
    gear.id = GearId::new("demo").unwrap();

    let mut catalogue = Catalogue::default();
    catalogue.gears.insert(GearId::new("demo").unwrap(), gear);
    catalogue
}

fn demo_descriptor() -> GearDescriptor {
    GearDescriptor {
        id: GearId::new("demo").unwrap(),
        display_name: "Demo".to_owned(),
        description: None,
        category: None,
        visibility: gearbox_ir::Visibility::Internal,
        source: SourceId::new("s").unwrap(),
        gdl_path: gearbox_ir::RelPath::new("demo/gear.gdl").unwrap(),
        package: gearbox_ir::CargoRef {
            crate_name: "demo".to_owned(),
            lib_ident: "demo".to_owned(),
            path: gearbox_ir::RelPath::new("demo").unwrap(),
            features: Vec::new(),
            default_features: true,
            link: Vec::new(),
        },
        runtime_caps: BTreeSet::default(),
        colocated_deps: BTreeSet::default(),
        lifecycle: None,
        provides: Vec::new(),
        consumes: Vec::new(),
        requires: Vec::new(),
        serves: Vec::new(),
        client_trait: None,
        cluster_providers: Vec::new(),
        extension_points: Vec::new(),
        fills: None,
        vendor_selector: None,
        declared_roles: Vec::new(),
        config_schema: None,
        docs: None,
        gts_types: Vec::new(),
        declared_at: None,
    }
}

/// An intent setting `key` to `value` on the demo gear.
fn intent(key: &str, value: serde_json::Value) -> ProductIntent {
    let dev = gearbox_ir::ProfileId::new("dev").unwrap();
    let mut selection = gearbox_ir::GearSelection {
        gear: GearId::new("demo").unwrap(),
        source: SourceId::new("s").unwrap(),
        features: Vec::new(),
        config: BTreeMap::default(),
        plugins: Vec::new(),
        declared_at: None,
    };
    selection.config.insert(key.to_owned(), value);
    ProductIntent {
        id: "fixture".to_owned(),
        display_name: "Fixture".to_owned(),
        version: "0.0.0".to_owned(),
        gdl_path: gearbox_ir::RelPath::new("product.gdl").unwrap(),
        sources: BTreeMap::default(),
        profiles: [(
            dev.clone(),
            gearbox_ir::DeploymentProfileDecl::Embedded {
                id: dev.clone(),
                declared_at: None,
            },
        )]
        .into_iter()
        .collect(),
        default_profile: dev,
        selected_gears: vec![selection],
        bindings: Vec::new(),
        cluster_scopes: Vec::new(),
        process_pins: Vec::new(),
        preferences: Vec::new(),
    }
}

fn codes(key: &str, value: serde_json::Value) -> Vec<DiagnosticCode> {
    let mut diagnostics = Diagnostics::default();
    check(
        &catalogue(),
        &intent(key, value),
        "file:///p.gdl",
        &mut diagnostics,
    );
    diagnostics.iter().map(|d| d.code).collect()
}

#[test]
fn a_value_of_the_declared_type_passes() {
    for (key, value) in [
        ("bind_addr", serde_json::json!("0.0.0.0:8087")),
        ("enable_docs", serde_json::json!(true)),
        ("port", serde_json::json!(8087)),
        ("ratio", serde_json::json!(1.5)),
        // An integer is a perfectly good float, and it is how YAML writes one.
        ("ratio", serde_json::json!(1)),
        ("mode", serde_json::json!("accept_all")),
    ] {
        assert_eq!(codes(key, value.clone()), [], "for {key} = {value}");
    }
}

#[test]
fn a_value_of_the_wrong_type_is_reported() {
    for (key, value) in [
        ("bind_addr", serde_json::json!(true)),
        ("enable_docs", serde_json::json!("yes")),
        ("port", serde_json::json!("8087")),
        // A fractional number is not an integer, and truncating silently is how
        // a port becomes a different port.
        ("port", serde_json::json!(1.5)),
        ("mode", serde_json::json!("nope")),
    ] {
        assert_eq!(
            codes(key, value.clone()),
            [DiagnosticCode::GdlConfigTypeMismatch],
            "for {key} = {value}"
        );
    }
}

#[test]
fn the_message_names_the_key_the_struct_and_what_was_expected() {
    let mut diagnostics = Diagnostics::default();
    check(
        &catalogue(),
        &intent("mode", serde_json::json!("nope")),
        "file:///p.gdl",
        &mut diagnostics,
    );
    let message = diagnostics.iter().next().unwrap().message.clone();
    for part in ["mode", "DemoConfig", "accept_all", "static_tokens"] {
        assert!(message.contains(part), "missing `{part}` in: {message}");
    }
}

/// The projector could not read a shape, so there is no expectation to enforce.
/// Inventing one would refuse descriptions that were always correct.
#[test]
fn a_complex_field_accepts_anything() {
    for value in [
        serde_json::json!("a"),
        serde_json::json!(1),
        serde_json::json!({"a": 1}),
        serde_json::json!([1, 2]),
    ] {
        assert_eq!(codes("nested", value.clone()), [], "for {value}");
    }
}

/// `exposes` is a curated subset, so a key it omits may still be one the gear
/// reads. Reporting those would punish a description for being selective.
#[test]
fn a_key_outside_the_exposed_set_is_not_reported() {
    assert_eq!(codes("not_exposed", serde_json::json!(true)), []);
}

/// A key the generator derives is overwritten, and the whole point of the
/// warning is that it is not overwritten in silence.
#[test]
fn setting_a_derived_key_warns_without_failing() {
    let mut catalogue = catalogue();
    catalogue
        .gears
        .get_mut(&GearId::new("demo").unwrap())
        .unwrap()
        .serves = vec![gearbox_ir::EndpointDecl {
        name: "rest".to_owned(),
        config_key: Some("bind_addr".to_owned()),
        default_port: Some(8087),
        via: None,
    }];

    let mut diagnostics = Diagnostics::default();
    check(
        &catalogue,
        &intent("bind_addr", serde_json::json!("0.0.0.0:9999")),
        "file:///p.gdl",
        &mut diagnostics,
    );
    let reported: Vec<_> = diagnostics.iter().collect();
    assert_eq!(reported.len(), 1);
    assert_eq!(reported[0].code, DiagnosticCode::GdlConfigKeyDerived);
    // A warning: the product still builds, the value is simply not the one used.
    assert_eq!(reported[0].severity, gearbox_ir::Severity::Warning);
    assert!(
        reported[0].message.contains("bind_addr"),
        "{:?}",
        reported[0]
    );
    assert!(reported[0].help.is_some());
}

#[test]
fn a_gear_without_a_schema_is_not_checked() {
    let mut catalogue = catalogue();
    catalogue
        .gears
        .get_mut(&GearId::new("demo").unwrap())
        .unwrap()
        .config_schema = None;
    let mut diagnostics = Diagnostics::default();
    check(
        &catalogue,
        &intent("bind_addr", serde_json::json!(true)),
        "file:///p.gdl",
        &mut diagnostics,
    );
    assert!(diagnostics.is_empty());
}
