//! Layer 1 (dialect) and layer 2 (token scan).
//!
//! The load-bearing assertions here are `dialect_admits_*`: they *measure* that
//! the dialect does not reject comprehensions and ternaries, which is the only
//! reason layer 2 exists. If a future starlark version starts rejecting them,
//! these fail and layer 2 can be reconsidered rather than carried forever on a
//! stale assumption.

use gearbox_gdl::declarative::{dialect, scan_forbidden_tokens};
use gearbox_ir::DiagnosticCode;
use starlark::syntax::AstModule;

fn parses(src: &str) -> bool {
    AstModule::parse("t.gdl", src.to_owned(), &dialect()).is_ok()
}

fn codes(src: &str) -> Vec<DiagnosticCode> {
    scan_forbidden_tokens("file:///t.gdl", src)
        .iter()
        .map(|d| d.code)
        .collect()
}

#[test]
fn dialect_rejects_function_definitions() {
    assert!(!parses("def f():\n  pass\n"), "def must not parse");
    assert!(!parses("f = lambda x: x\n"), "lambda must not parse");
}

#[test]
fn dialect_rejects_top_level_control_flow() {
    assert!(
        !parses("if True:\n  x = 1\n"),
        "top-level if must not parse"
    );
    assert!(
        !parses("for x in []:\n  pass\n"),
        "top-level for must not parse"
    );
}

#[test]
fn dialect_admits_top_level_assignment() {
    // The gear.gdl files rely on this for `SDK = cargo(...)` bindings.
    assert!(
        parses("X = 1\nY = [X, 2]\n"),
        "top-level assignment must parse"
    );
}

#[test]
fn dialect_admits_comprehensions_which_is_why_layer_two_exists() {
    assert!(
        parses("x = [c for c in [1, 2]]\n"),
        "measured: the dialect does NOT reject comprehensions, so the token scan must"
    );
    assert_eq!(
        codes("x = [c for c in [1, 2]]\n").len(),
        2,
        "for + in both flagged"
    );
}

#[test]
fn dialect_admits_ternaries_which_is_why_layer_two_exists() {
    assert!(
        parses("x = 1 if True else 2\n"),
        "measured: the dialect does NOT reject ternaries, so the token scan must"
    );
    assert_eq!(
        codes("x = 1 if True else 2\n").len(),
        2,
        "if + else both flagged"
    );
}

#[test]
fn token_scan_flags_every_decision_encoding_construct() {
    for src in [
        "x = a and b\n",
        "x = a or b\n",
        "x = not a\n",
        "x = a in b\n",
        "x = 1 if c else 2\n",
        "x = [i for i in y]\n",
    ] {
        let found = codes(src);
        assert!(!found.is_empty(), "nothing flagged in {src:?}");
        assert!(
            found
                .iter()
                .all(|c| *c == DiagnosticCode::GdlForbiddenConstruct),
            "expected only GBX0103 in {src:?}, got {found:?}"
        );
    }
}

#[test]
fn token_scan_leaves_ordinary_gdl_alone() {
    // The vocabulary itself must survive the scan untouched.
    let src = "\
SDK = cargo(crate = \"cf-api-contracts-sdk\", lib = \"api_contracts_sdk\")
gear(
    id = \"api-contracts\",
    runtime_caps = [cap.rest],
    provides = [provide(contract = \"PaymentApi\", version = \"v1\")],
)
";
    assert!(codes(src).is_empty(), "clean GDL flagged: {:?}", codes(src));
}

#[test]
fn keywords_inside_strings_are_not_flagged() {
    // The lexer yields string contents as Token::String, so prose in a
    // description field cannot trip the scan.
    let src =
        "gear(id = \"a\", description = \"use this if you need for-loops and not much else\")\n";
    assert!(
        codes(src).is_empty(),
        "string contents flagged: {:?}",
        codes(src)
    );
}

#[test]
fn forbidden_constructs_carry_a_usable_span() {
    let diags = scan_forbidden_tokens("file:///t.gdl", "x = 1\ny = a and b\n");
    assert_eq!(diags.len(), 1);
    let loc = diags[0].location.as_ref().expect("a span");
    assert_eq!(loc.uri, "file:///t.gdl");
    // 0-based, matching LSP: `and` is on the second line.
    assert_eq!(loc.range.start.line, 1, "0-based line");
    assert!(loc.range.start.character > 0, "a real column");
    // And the diagnostic satisfies the PRD's own invariants.
    assert!(diags[0].validate().is_ok(), "{:?}", diags[0].validate());
}
