//! Tests for the in-place editor, and the first one is the point of the module.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use starlark::syntax::AstModule;

use super::*;

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

#[test]
fn config_edit_keeps_comments_and_is_inverse() {
    let edited = set_gear_config(URI, WITH_CONFIG, "api-gateway", "demo_mode", Some("on"))
        .expect("editable")
        .changed()
        .expect("changed")
        .to_owned();
    assert!(edited.contains("# Keep this comment."), "{edited}");
    assert!(edited.contains("# gear rationale"), "{edited}");
    assert!(edited.contains("\"demo_mode\": \"on\""), "{edited}");

    assert_eq!(
        set_gear_config(URI, &edited, "api-gateway", "demo_mode", Some("on")).expect("editable"),
        Edit::Unchanged
    );

    let restored = set_gear_config(URI, &edited, "api-gateway", "demo_mode", Some("off"))
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
    let edited = set_gear_config(URI, source, "g", "a", Some("2"))
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
    let edited = set_gear_config(URI, source, "g", "msg", Some(r#"He said "hi""#))
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
    let cloned = clone_product_text(URI, &source, "clone-id", "Clone Name").expect("cloneable");
    let comments_after = cloned
        .lines()
        .filter(|l| l.trim_start().starts_with('#'))
        .count();
    assert_eq!(comments_after, comments_before);
    assert!(cloned.contains(r#"id = "clone-id""#), "{cloned}");
    assert!(cloned.contains(r#"name = "Clone Name""#), "{cloned}");
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
