//! Tests for the in-place editor, and the first one is the point of the module.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use starlark::syntax::AstModule;

use gearbox_ir::DiagnosticCode;

use super::*;

/// The identity the round-trip test evaluates a product under.
fn product_identity() -> crate::FileIdentity {
    crate::FileIdentity {
        uri: URI.to_owned(),
        source: gearbox_ir::SourceId::new("product").unwrap(),
        gdl_path: gearbox_ir::RelPath::new("product.gdl").unwrap(),
        load_paths: None,
    }
}

/// A string config value, which is what every case below writes.
fn str_value(s: &str) -> gearbox_ir::ConfigValue {
    gearbox_ir::ConfigValue::Str(s.to_owned())
}

const URI: &str = "file:///product.gdl";

/// A product shaped like the real one: comments carrying the reasoning, one
/// entry per line, and a comment *inside* the list.
const COMMENTED: &str = r#"# The Payments Demo product.
#
# All three deployment profiles are declared as DATA.

product(
    id = "payments-demo",
    name = "Payments Demo",

    # Note what is NOT listed: grpc-hub and types-registry arrive through the
    # colocated_deps closure, which is a link-time fact.
    gears = [
        use_gear("api-gateway", source = "gears-rust"),
        use_gear("api-contracts", source = "gears-rust"),
    ],

    preferences = [prefer.fewer_processes()],
)
"#;

#[test]
fn every_comment_survives_an_insertion() {
    // The reason this module exists. Evaluating and re-printing the description
    // would produce something equivalent to the machine and useless to the next
    // reader, because the comments are where the decisions are written down.
    let edited = add_gear(URI, COMMENTED, "cluster", "gears-rust")
        .expect("editable")
        .changed()
        .expect("changed")
        .to_owned();

    for comment in [
        "# The Payments Demo product.",
        "# All three deployment profiles are declared as DATA.",
        "# Note what is NOT listed: grpc-hub and types-registry arrive through the",
        "# colocated_deps closure, which is a link-time fact.",
    ] {
        assert!(edited.contains(comment), "lost `{comment}`\n{edited}");
    }
}

#[test]
fn only_one_line_changes() {
    // Stated as a line diff rather than as "it contains the new entry": an edit
    // that also reflowed the file would pass the weaker assertion.
    let edited = add_gear(URI, COMMENTED, "cluster", "gears-rust")
        .expect("editable")
        .changed()
        .expect("changed")
        .to_owned();

    let before: Vec<&str> = COMMENTED.lines().collect();
    let after: Vec<&str> = edited.lines().collect();
    assert_eq!(
        after.len(),
        before.len() + 1,
        "expected exactly one new line"
    );

    let added: Vec<&&str> = after.iter().filter(|line| !before.contains(line)).collect();
    assert_eq!(
        added,
        vec![&"        use_gear(\"cluster\", source = \"gears-rust\"),"],
        "the only new line should be the entry, indented like its neighbours"
    );
}

#[test]
fn the_indentation_comes_from_the_neighbours() {
    // Two spaces, not the four the demo uses: read off the file rather than
    // assumed, so a differently formatted product keeps its own shape.
    let source = "product(\n  gears = [\n    use_gear(\"a\", source = \"s\"),\n  ],\n)\n";
    let edited = add_gear(URI, source, "b", "s")
        .expect("editable")
        .changed()
        .expect("changed")
        .to_owned();
    assert!(
        edited.contains("\n    use_gear(\"b\", source = \"s\"),\n"),
        "expected four-space indent to match the existing entry:\n{edited}"
    );
}

#[test]
fn a_one_line_list_stays_on_one_line() {
    let source = "product(gears = [use_gear(\"a\", source = \"s\")])\n";
    let edited = add_gear(URI, source, "b", "s")
        .expect("editable")
        .changed()
        .expect("changed")
        .to_owned();
    assert_eq!(
        edited,
        "product(gears = [use_gear(\"a\", source = \"s\"), use_gear(\"b\", source = \"s\")])\n"
    );
}

#[test]
fn adding_a_gear_that_is_already_there_changes_nothing() {
    // ADR-0010's "idempotent by content", and it costs nothing: the same rule the
    // workspace `members` entry follows.
    assert_eq!(
        add_gear(URI, COMMENTED, "api-gateway", "gears-rust").expect("editable"),
        Edit::Unchanged
    );
}

#[test]
fn an_empty_list_is_filled_rather_than_refused() {
    let source = "product(\n    gears = [\n    ],\n)\n";
    let edited = add_gear(URI, source, "a", "s")
        .expect("editable")
        .changed()
        .expect("changed")
        .to_owned();
    assert!(
        edited.contains("use_gear(\"a\", source = \"s\"),"),
        "{edited}"
    );
}

#[test]
fn removing_takes_the_comma_and_the_line_with_it() {
    let edited = remove_gear(URI, COMMENTED, "api-contracts")
        .expect("editable")
        .changed()
        .expect("changed")
        .to_owned();
    assert!(!edited.contains("api-contracts"), "{edited}");
    assert!(
        !edited.contains(",\n\n    ],"),
        "an orphaned comma or blank line was left behind:\n{edited}"
    );
    assert_eq!(edited.lines().count(), COMMENTED.lines().count() - 1);
    // And the comment above the list is not collateral damage.
    assert!(edited.contains("# Note what is NOT listed"), "{edited}");
}

#[test]
fn removing_a_gear_takes_every_matching_entry() {
    let source = r#"product(
    gears = [
        use_gear("twice", source = "a"),
        use_gear("keep", source = "a"),
        use_gear("twice", source = "b"),
    ],
)
"#;
    let edited = remove_gear(URI, source, "twice")
        .expect("editable")
        .changed()
        .expect("changed")
        .to_owned();
    assert!(!edited.contains("twice"), "{edited}");
    assert!(edited.contains("keep"), "{edited}");
}

#[test]
fn a_shape_refusal_is_not_a_parse_error() {
    let diagnostics = add_gear(URI, "gear(name = \"g\")\n", "a", "s").expect_err("not a product");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|d| d.code == DiagnosticCode::GdlCardinality && d.location.is_some()),
        "{diagnostics:?}"
    );
}

#[test]
fn removing_a_gear_that_is_not_there_changes_nothing() {
    assert_eq!(
        remove_gear(URI, COMMENTED, "not-in-the-product").expect("editable"),
        Edit::Unchanged
    );
}

#[test]
fn a_gears_list_that_is_not_a_literal_is_refused_rather_than_guessed_at() {
    // The honest failure. A list produced by a helper has no span to insert into,
    // and an approximation here would be a silently wrong description.
    let source = "load(\"//lib.gdl\", \"chosen\")\nproduct(gears = chosen())\n";
    let diagnostics = add_gear(URI, source, "a", "s").expect_err("not editable");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|d| d.message.contains("not a list literal")),
        "{diagnostics:?}"
    );
}

#[test]
fn a_product_without_gears_is_refused_by_name() {
    let source = "product(id = \"p\")\n";
    let diagnostics = add_gear(URI, source, "a", "s").expect_err("not editable");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|d| d.message.contains("no `gears` argument")),
        "{diagnostics:?}"
    );
}

#[test]
fn a_file_that_is_not_a_product_is_refused_by_name() {
    let source = "gear(name = \"g\")\n";
    let diagnostics = add_gear(URI, source, "a", "s").expect_err("not editable");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|d| d.message.contains("no top-level `product(...)` call")),
        "{diagnostics:?}"
    );
}

#[test]
fn the_result_still_parses_and_still_says_what_it_said() {
    // The edit is text surgery, so the only real proof it produced a description
    // is to parse the result -- and the round trip has to agree about the gears.
    let edited = add_gear(URI, COMMENTED, "cluster", "gears-rust")
        .expect("editable")
        .changed()
        .expect("changed")
        .to_owned();
    let reparsed = gears_list(URI, &edited).expect("the edited file is still editable");
    assert_eq!(reparsed.entries.len(), 3);
    for gear in ["api-gateway", "api-contracts", "cluster"] {
        assert!(
            reparsed
                .entries
                .iter()
                .any(|entry| names_gear(&edited, *entry, gear)),
            "lost `{gear}` after the round trip"
        );
    }
}

/// The repository's own product description.
///
/// Always present, unlike the `gears-rust` corpus: it lives in this repository,
/// two levels above the crate.
fn real_product() -> Option<String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../products/payments-demo/product.gdl");
    std::fs::read_to_string(path).ok()
}

#[test]
fn the_real_product_takes_one_line_and_keeps_every_comment() {
    // The acid test. `products/payments-demo/product.gdl` is roughly a hundred
    // lines of which most are comments, and those comments are where the
    // reasoning lives -- why `vendor` is left alone, why `grpc-hub` is not
    // listed, why the profiles are data. An editor that cannot survive this file
    // is not usable on any real one.
    let Some(source) = real_product() else {
        eprintln!("skipping: products/payments-demo/product.gdl not present");
        return;
    };

    let comments_before = source
        .lines()
        .filter(|l| l.trim_start().starts_with('#'))
        .count();
    // A guard on the test rather than on the code: comment preservation is only
    // worth asserting against a file that has comments to lose. Stated as a share
    // of the file so it describes itself instead of holding a number somebody
    // has to re-derive -- today that is 29 lines in 105.
    let total = source.lines().count();
    assert!(
        comments_before * 4 >= total,
        "expected a heavily commented file; {comments_before} of {total} lines are comments"
    );

    let edited = add_gear(URI, &source, "cluster", "gears-rust")
        .expect("the real product is editable")
        .changed()
        .expect("adding a gear it does not have should change it")
        .to_owned();

    let comments_after = edited
        .lines()
        .filter(|l| l.trim_start().starts_with('#'))
        .count();
    assert_eq!(
        comments_after, comments_before,
        "a comment was lost or moved"
    );
    assert_eq!(
        edited.lines().count(),
        source.lines().count() + 1,
        "exactly one line should have appeared"
    );

    // And it is idempotent on the file it just produced.
    assert_eq!(
        add_gear(URI, &edited, "cluster", "gears-rust").expect("editable"),
        Edit::Unchanged
    );

    // Removing it again returns the file to what it was, byte for byte. That is
    // the strongest statement available about surgery: the inverse edit is exact.
    assert_eq!(
        remove_gear(URI, &edited, "cluster")
            .expect("editable")
            .changed()
            .expect("changed"),
        source,
        "remove did not undo add exactly"
    );
}

const WITH_CONFIG: &str = r#"# Keep this comment.
product(
    gears = [
        # gear rationale
        use_gear("api-gateway", source = "gears-rust", config = {"demo_mode": "off"}),
    ],
    profiles = [
        embedded(id = "dev"),
    ],
)
"#;

/// The name check protects against a credential typed into a form, and only a
/// string can be one. Before typing, a `bool` named `mtls_key` was unwritable
/// for a reason that never applied to it.
#[test]
fn the_secret_rule_refuses_strings_and_leaves_other_types_alone() {
    use gearbox_ir::ConfigValue;

    let refused = set_gear_config(
        URI,
        WITH_CONFIG,
        "api-gateway",
        "api_key",
        Some(&str_value("sk-live-1")),
    )
    .expect_err("a string under a secret-looking key is refused");
    assert!(
        refused
            .as_slice()
            .iter()
            .any(|d| d.message.contains("api_key")),
        "{refused:?}"
    );

    // Same key name, a bool: nothing to protect, so nothing is refused.
    set_gear_config(
        URI,
        WITH_CONFIG,
        "api-gateway",
        "mtls_key",
        Some(&ConfigValue::Bool(true)),
    )
    .expect("a bool cannot carry a credential");

    // Removal was always allowed and stays allowed.
    set_gear_config(URI, WITH_CONFIG, "api-gateway", "api_key", None)
        .expect("removing a secret-looking key is not a write of one");
}

/// The typed twin of `config_edit_keeps_comments_and_is_inverse`, and the reason
/// the wire stopped carrying strings: a checkbox that wrote `"True"` would be
/// writing a string that happens to read like a boolean.
#[test]
fn typed_values_render_as_starlark_literals_not_as_strings() {
    use gearbox_ir::ConfigValue;

    for (value, expected) in [
        (ConfigValue::Bool(true), r#""demo_mode": True"#),
        (ConfigValue::Bool(false), r#""demo_mode": False"#),
        (ConfigValue::Int(8087), r#""demo_mode": 8087"#),
        (ConfigValue::Int(-1), r#""demo_mode": -1"#),
        // `{:?}` keeps the `.0`, so a float stays a float on the next read.
        (ConfigValue::Float(1.5), r#""demo_mode": 1.5"#),
        (ConfigValue::Float(8087.0), r#""demo_mode": 8087.0"#),
        (ConfigValue::Str("on".to_owned()), r#""demo_mode": "on""#),
    ] {
        let edited = set_gear_config(URI, WITH_CONFIG, "api-gateway", "demo_mode", Some(&value))
            .expect("editable")
            .changed()
            .expect("changed")
            .to_owned();
        assert!(
            edited.contains(expected),
            "expected `{expected}` in:\n{edited}"
        );

        // Writing the same value again is textually idempotent for every shape,
        // which is what keeps a panel from rewriting a file it did not change.
        assert_eq!(
            set_gear_config(URI, &edited, "api-gateway", "demo_mode", Some(&value))
                .expect("editable"),
            Edit::Unchanged,
            "re-writing `{expected}` should change nothing"
        );
    }
}

/// A typed value must survive the evaluator, not just the editor. Before this,
/// `to_json_at` knew no floats and capped integers at `i32`, so a number control
/// could write a description that parsed and then refused to evaluate.
#[test]
fn typed_values_survive_a_round_trip_through_the_evaluator() {
    use gearbox_ir::ConfigValue;

    // A well-formed product, unlike the surgery fixtures above: this one has to
    // survive the evaluator, not just the editor.
    const VALID: &str = r#"
product(
    id = "demo", version = "0.1.0",
    sources = [source(id = "gears-rust", at = path("../gears-rust"))],
    profiles = [embedded(id = "dev")],
    default_profile = "dev",
    gears = [use_gear("api-gateway", source = "gears-rust", config = {"demo_mode": "off"})],
)
"#;

    for value in [
        ConfigValue::Bool(true),
        ConfigValue::Int(8087),
        ConfigValue::Int(5_000_000_000),
        ConfigValue::Float(1.5),
        ConfigValue::Str("on".to_owned()),
    ] {
        let edited = set_gear_config(URI, VALID, "api-gateway", "demo_mode", Some(&value))
            .expect("editable")
            .changed()
            .expect("changed")
            .to_owned();

        let out = crate::GdlEngine::new().eval_product(&product_identity(), &edited);
        assert!(
            out.value.is_some(),
            "`{value}` produced a description that does not evaluate: {:?}",
            out.diagnostics
        );
        let intent = out.value.expect("evaluated");
        let selection = intent
            .selected_gears
            .iter()
            .find(|g| g.gear.as_str() == "api-gateway")
            .expect("the gear is selected");
        let written = selection
            .config
            .get("demo_mode")
            .expect("the key was written");
        let expected = match &value {
            ConfigValue::Bool(b) => serde_json::Value::Bool(*b),
            ConfigValue::Int(i) => serde_json::Value::from(*i),
            ConfigValue::Float(f) => serde_json::Value::from(*f),
            ConfigValue::Str(s) => serde_json::Value::String(s.clone()),
        };
        assert_eq!(written, &expected, "for `{value}`");
    }
}

#[test]
fn config_edit_keeps_comments_and_is_inverse() {
    let edited = set_gear_config(
        URI,
        WITH_CONFIG,
        "api-gateway",
        "demo_mode",
        Some(&str_value("on")),
    )
    .expect("editable")
    .changed()
    .expect("changed")
    .to_owned();
    assert!(edited.contains("# Keep this comment."), "{edited}");
    assert!(edited.contains("# gear rationale"), "{edited}");
    assert!(edited.contains("\"demo_mode\": \"on\""), "{edited}");

    assert_eq!(
        set_gear_config(
            URI,
            &edited,
            "api-gateway",
            "demo_mode",
            Some(&str_value("on"))
        )
        .expect("editable"),
        Edit::Unchanged
    );

    let restored = set_gear_config(
        URI,
        &edited,
        "api-gateway",
        "demo_mode",
        Some(&str_value("off")),
    )
    .expect("editable")
    .changed()
    .expect("changed")
    .to_owned();
    assert_eq!(restored, WITH_CONFIG);
}

#[test]
fn config_key_inside_a_string_is_not_matched_by_find() {
    // A comment and a string value both contain the substring `config = `; surgery
    // must use the named-argument span, not `text.find`.
    let source = r#"product(
    gears = [
        use_gear("g", source = "s", note = "mentions config = nowhere", config = {"a": "1"}),
    ],
)
"#;
    let edited = set_gear_config(URI, source, "g", "a", Some(&str_value("2")))
        .expect("editable")
        .changed()
        .expect("changed")
        .to_owned();
    assert!(
        edited.contains("note = \"mentions config = nowhere\""),
        "{edited}"
    );
    assert!(edited.contains("\"a\": \"2\""), "{edited}");
}

#[test]
fn quoted_values_survive_escaping() {
    let source = r#"product(
    gears = [
        use_gear("g", source = "s"),
    ],
)
"#;
    let edited = set_gear_config(URI, source, "g", "msg", Some(&str_value(r#"He said "hi""#)))
        .expect("editable")
        .changed()
        .expect("changed")
        .to_owned();
    assert!(edited.contains(r#""msg": "He said \"hi\"""#), "{edited}");
    gears_list(URI, &edited).expect("escaped config must still parse");
}

#[test]
fn render_template_escapes_and_parses() {
    let text = render_product_template(&CreateProductParams {
        id: "x".into(),
        name: r#"He said "hi""#.into(),
        version: "0.1.0".into(),
        sources: vec![("gears-rust".into(), "gears".into())],
        profile_kind: "embedded".into(),
        profile_id: "dev".into(),
    });
    assert!(text.contains(r#"name = "He said \"hi\"""#), "{text}");
    AstModule::parse(URI, text, &crate::declarative::dialect()).expect("template must parse");
}

#[test]
fn clone_keeps_comments_byte_exact_elsewhere() {
    let Some(source) = real_product() else {
        eprintln!("skipping: products/payments-demo/product.gdl not present");
        return;
    };
    let comments_before = source
        .lines()
        .filter(|l| l.trim_start().starts_with('#'))
        .count();
    let cloned =
        clone_product_text(URI, &source, "clone-id", "Clone Name", None).expect("cloneable");
    let comments_after = cloned
        .lines()
        .filter(|l| l.trim_start().starts_with('#'))
        .count();
    assert_eq!(comments_after, comments_before);
    assert!(cloned.contains(r#"id = "clone-id""#), "{cloned}");
    assert!(cloned.contains(r#"name = "Clone Name""#), "{cloned}");
}

#[test]
fn clone_stamps_version_when_provided() {
    let source = r#"# keep me
product(
    id = "src",
    name = "Src",
    version = "0.1.0",
    sources = [source(id = "s", at = path("."))],
    profiles = [embedded(id = "dev")],
    default_profile = "dev",
    gears = [],
)
"#;
    let cloned = clone_product_text(URI, source, "clone-id", "Clone Name", Some("2.0.0"))
        .expect("cloneable");
    assert!(cloned.contains(r#"id = "clone-id""#), "{cloned}");
    assert!(cloned.contains(r#"name = "Clone Name""#), "{cloned}");
    assert!(cloned.contains(r#"version = "2.0.0""#), "{cloned}");
    assert!(!cloned.contains(r#"version = "0.1.0""#), "{cloned}");
    assert!(cloned.contains("# keep me"), "{cloned}");
    assert!(
        cloned.contains(r#"source(id = "s", at = path("."))"#),
        "{cloned}"
    );
}

#[test]
fn profile_add_remove_is_byte_exact_inverse() {
    let added = add_profile(
        URI,
        WITH_CONFIG,
        "kubernetes",
        "prod",
        &[("namespace".into(), "pay".into())],
    )
    .expect("editable")
    .changed()
    .expect("changed")
    .to_owned();
    assert!(
        added.contains("kubernetes(id = \"prod\", namespace = \"pay\")"),
        "{added}"
    );
    assert_eq!(
        add_profile(URI, &added, "kubernetes", "prod", &[]).expect("editable"),
        Edit::Unchanged
    );
    assert_eq!(
        remove_profile(URI, &added, "prod")
            .expect("editable")
            .changed()
            .expect("changed"),
        WITH_CONFIG
    );
}

#[test]
fn computed_profiles_list_is_refused() {
    let source = "load(\"//lib.gdl\", \"chosen\")\nproduct(profiles = chosen())\n";
    let diagnostics = add_profile(URI, source, "embedded", "dev", &[]).expect_err("not editable");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|d| d.message.contains("not a list literal")),
        "{diagnostics:?}"
    );
}

#[test]
fn quote_string_escapes_control_chars() {
    assert_eq!(quote_string("a\"b\\c"), r#""a\"b\\c""#);
    assert_eq!(quote_string("a\nb"), "\"a\\nb\"");
}

#[test]
fn add_gear_quotes_injection_payloads() {
    let payloads = [r#"x"), use_gear("y"#, "a\"b", "a\nb"];
    for gear in payloads {
        let edited = add_gear(URI, COMMENTED, gear, "gears-rust")
            .expect("editable")
            .changed()
            .expect("changed")
            .to_owned();
        assert!(
            edited.contains(&quote_string(gear)),
            "payload `{gear:?}` was not quoted:\n{edited}"
        );
        gears_list(URI, &edited).expect("quoted add_gear must still parse");
        assert!(
            !edited.contains(r#"use_gear("y""#),
            "payload `{gear:?}` injected an extra call:\n{edited}"
        );
    }
}

#[test]
fn add_profile_refuses_constructor_injection() {
    let diagnostics = add_profile(
        URI,
        WITH_CONFIG,
        r#"kubernetes), use_gear("x""#,
        "prod",
        &[],
    )
    .expect_err("injected constructor");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|d| d.message.contains("not a deployment profile constructor")),
        "{diagnostics:?}"
    );
}

#[test]
fn add_profile_refuses_field_injection() {
    let diagnostics = add_profile(
        URI,
        WITH_CONFIG,
        "kubernetes",
        "prod",
        &[(r#"ns), use_gear("x""#.into(), "pay".into())],
    )
    .expect_err("injected field name");
    assert!(
        diagnostics
            .as_slice()
            .iter()
            .any(|d| d.message.contains("not a valid profile field identifier")),
        "{diagnostics:?}"
    );
}

#[test]
fn render_template_does_not_interpolate_an_injected_kind() {
    let text = render_product_template(&CreateProductParams {
        id: "x".into(),
        name: "n".into(),
        version: "0.1.0".into(),
        sources: vec![("gears-rust".into(), "gears".into())],
        profile_kind: r#"kubernetes), use_gear("evil""#.into(),
        profile_id: "dev".into(),
    });
    assert!(
        !text.contains("use_gear"),
        "injected constructor reached the template:\n{text}"
    );
    assert!(
        text.contains("embedded(id = \"dev\")"),
        "unknown kinds must fall back to a real constructor:\n{text}"
    );
    AstModule::parse(URI, text, &crate::declarative::dialect()).expect("template must parse");
}

#[test]
fn set_gear_plugins_writes_plugin_list() {
    let source = r#"product(
    gears = [
        use_gear("authn-resolver", source = "gears-rust"),
    ],
)
"#;
    let edited = set_gear_plugins(
        URI,
        source,
        "authn-resolver",
        &[
            "static-authn-plugin".to_owned(),
            "oidc-authn-plugin".to_owned(),
        ],
    )
    .expect("editable")
    .changed()
    .expect("changed")
    .to_owned();
    assert!(
        edited
            .contains(r#"plugins = [plugin("static-authn-plugin"), plugin("oidc-authn-plugin")]"#),
        "{edited}"
    );
    assert_eq!(
        set_gear_plugins(
            URI,
            &edited,
            "authn-resolver",
            &[
                "static-authn-plugin".to_owned(),
                "oidc-authn-plugin".to_owned()
            ],
        )
        .expect("editable"),
        Edit::Unchanged
    );
}
