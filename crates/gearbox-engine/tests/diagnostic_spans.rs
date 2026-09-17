//! Where a diagnostic points, asserted from a real description.
//!
//! **Not from a literal `ProductIntent`, and that is the whole reason this file
//! exists separately.** Every fixture in `tests/support/resolve_fixtures.rs`
//! sets `declared_at: None`, so a test built that way exercises the *fallback*
//! path -- it would pass unchanged if every span in the engine were deleted. A
//! span only exists if the description text was evaluated, so these tests
//! evaluate text.
//!
//! **No corpus, deliberately.** The sibling real-tree tests skip when
//! `../gears-rust` is absent, and a skipping test proves nothing. Every product
//! here names gears no catalogue has, which is exactly what makes the
//! unknown-gear checks fire against an empty `Catalogue`.
//!
//! Each assertion is the *exact* line the declaration is written on, found from
//! the fixture text rather than hard-coded, so editing a fixture cannot quietly
//! turn a real span into a passing `> 0`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here; \
              a fixture builder that propagates errors instead of panicking obscures the \
              assertion it exists to support"
)]

use std::path::Path;

use gearbox_engine::product::eval_product_text;
use gearbox_engine::resolve::resolve_at;
use gearbox_ir::{Catalogue, Diagnostic, ProductIntent, ProfileId, Range};

/// Where the fixture pretends to live, so the URI is absolute and openable.
const PRODUCT_PATH: &str = "/gbx-spans/product.gdl";

/// The zero-based line holding `needle`. Panics rather than returning an
/// `Option`: a fixture that no longer contains what a test anchors on is a
/// broken test, not a skipped one.
fn line_of(text: &str, needle: &str) -> u32 {
    let found: Vec<u32> = text
        .lines()
        .enumerate()
        .filter(|(_, line)| line.contains(needle))
        .map(|(i, _)| u32::try_from(i).expect("fixtures are short"))
        .collect();
    assert_eq!(
        found.len(),
        1,
        "`{needle}` must appear on exactly one line of the fixture, found {found:?}"
    );
    found[0]
}

fn intent(text: &str) -> ProductIntent {
    let scan = eval_product_text(Path::new(PRODUCT_PATH), None, text);
    scan.intent
        .unwrap_or_else(|| panic!("fixture must evaluate: {:#?}", scan.diagnostics))
}

/// Resolve against an empty catalogue, which is what makes every named gear
/// unknown.
fn diagnostics_of(text: &str, profile: &str) -> Vec<Diagnostic> {
    let intent = intent(text);
    let resolution = resolve_at(
        &Catalogue::default(),
        &intent,
        &ProfileId::new(profile).expect("kebab profile id"),
        Some(Path::new(PRODUCT_PATH)),
    );
    resolution.diagnostics.iter().cloned().collect()
}

fn find<'a>(diagnostics: &'a [Diagnostic], needle: &str) -> &'a Diagnostic {
    diagnostics
        .iter()
        .find(|d| d.message.contains(needle))
        .unwrap_or_else(|| {
            panic!(
                "no diagnostic mentioning `{needle}`; got {:#?}",
                diagnostics.iter().map(|d| &d.message).collect::<Vec<_>>()
            )
        })
}

/// Assert the diagnostic is anchored on the line `needle` is written on.
fn assert_anchored(diagnostic: &Diagnostic, text: &str, needle: &str) {
    let location = diagnostic
        .location
        .as_ref()
        .unwrap_or_else(|| panic!("`{}` carries no location", diagnostic.message));
    assert!(
        location.uri.ends_with(PRODUCT_PATH),
        "must point at the description, not `{}`",
        location.uri
    );
    assert_ne!(
        location.range,
        Range::whole_file(),
        "the whole-file sentinel is not published to an editor at all: {diagnostic:#?}"
    );
    assert_eq!(
        location.range.start.line,
        line_of(text, needle),
        "`{}` must be anchored on the line holding `{needle}`",
        diagnostic.message
    );
}

const UNKNOWN_GEAR: &str = r#"product(
    id = "spans-probe",
    name = "Spans Probe",
    version = "0.1.0",
    sources = [source(id = "somewhere", at = path("."))],
    profiles = [embedded(id = "dev")],
    default_profile = "dev",
    gears = [
        use_gear("not-in-any-catalogue", source = "somewhere"),
    ],
)
"#;

/// `use_gear("x")` naming nothing points at that `use_gear`, not at line 1.
///
/// The case the CLI used to render as `product.gdl:1` for every unknown gear in
/// a description, however far down the file it was written.
#[test]
fn an_unknown_gear_is_anchored_on_its_use_gear() {
    let diagnostics = diagnostics_of(UNKNOWN_GEAR, "dev");
    let diagnostic = find(&diagnostics, "not-in-any-catalogue");
    assert_anchored(
        diagnostic,
        UNKNOWN_GEAR,
        "use_gear(\"not-in-any-catalogue\"",
    );
}

const UNHONOURED_ENDPOINT: &str = r#"product(
    id = "spans-probe",
    name = "Spans Probe",
    version = "0.1.0",
    sources = [source(id = "somewhere", at = path("."))],
    profiles = [embedded(id = "dev")],
    default_profile = "dev",
    gears = [
        use_gear("consumer", source = "somewhere"),
    ],
    bindings = [
        bind(
            consumer = "consumer",
            contract = "provider/Api@v1",
            mode = binding_mode.remote,
            transport = transport.rest,
            endpoint = "http://elsewhere",
        ),
    ],
)
"#;

/// `bind(endpoint = ...)` is refused at the `bind(...)` that wrote it.
#[test]
fn an_unhonoured_endpoint_is_anchored_on_its_bind() {
    let diagnostics = diagnostics_of(UNHONOURED_ENDPOINT, "dev");
    let diagnostic = find(&diagnostics, "endpoint");
    assert_anchored(diagnostic, UNHONOURED_ENDPOINT, "bind(");
}

/// A declaration with no recorded span still gets an answer, and it is the file.
///
/// The fallback is permanent, not a gap: a product built in a test carries no
/// spans at all, and `spans::declared_or_file` is what keeps those callers
/// working. Pinned so the fallback is not "simplified" away once most
/// declarations have spans.
#[test]
fn a_declaration_with_no_span_falls_back_to_the_file() {
    let mut intent = intent(UNKNOWN_GEAR);
    for selection in &mut intent.selected_gears {
        selection.declared_at = None;
    }
    let resolution = resolve_at(
        &Catalogue::default(),
        &intent,
        &ProfileId::new("dev").unwrap(),
        Some(Path::new(PRODUCT_PATH)),
    );
    let diagnostics: Vec<Diagnostic> = resolution.diagnostics.iter().cloned().collect();
    let location = find(&diagnostics, "not-in-any-catalogue")
        .location
        .as_ref()
        .expect("the fallback is a location, not the absence of one");
    assert!(location.uri.ends_with(PRODUCT_PATH), "{}", location.uri);
    assert_eq!(location.range, Range::whole_file());
}
