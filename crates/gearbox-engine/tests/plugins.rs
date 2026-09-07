//! Plugin selection, resolved against the real catalogue.
//!
//! These need both halves -- the catalogue says what each gear fills, the
//! product says what is linked -- so they live here rather than in either crate
//! alone. The product is evaluated from a string literal; only the catalogue
//! comes from the sibling checkout.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::{Path, PathBuf};

use gearbox_engine::{SourceRoot, check_plugins, load_catalogue};
use gearbox_gdl::{FileIdentity, GdlEngine};
use gearbox_ir::{Catalogue, DiagnosticCode, Diagnostics, RelPath, SourceId};

fn gears_rust() -> Option<PathBuf> {
    let mut dir: &Path = Path::new(env!("CARGO_MANIFEST_DIR"));
    loop {
        let candidate = dir.join("gears-rust");
        if candidate.join("gears").is_dir() {
            return candidate.canonicalize().ok();
        }
        dir = dir.parent()?;
    }
}

fn catalogue() -> Option<Catalogue> {
    let root = gears_rust()?;
    let source = SourceRoot::open(SourceId::new("gears-rust").unwrap(), root).ok()?;
    Some(load_catalogue(&[source]).catalogue)
}

macro_rules! require {
    () => {
        match catalogue() {
            Some(c) => c,
            None => {
                eprintln!("skipping: ../gears-rust not present");
                return;
            }
        }
    };
}

/// A product with one host and whatever plugin clause is under test.
fn product(profiles: &str, default: &str, gears: &str) -> String {
    format!(
        r#"
product(
    id = "t", version = "0.1.0",
    sources = [source(id = "gears-rust", at = path("../gears-rust"))],
    profiles = [{profiles}],
    default_profile = "{default}",
    gears = [{gears}],
)
"#
    )
}

/// Evaluate the product, then check it against the catalogue.
fn check(catalogue: &Catalogue, src: &str) -> (Vec<DiagnosticCode>, String) {
    let identity = FileIdentity {
        uri: "file:///t/product.gdl".to_owned(),
        source: SourceId::new("product").unwrap(),
        gdl_path: RelPath::new("product.gdl").unwrap(),
        load_paths: None,
    };
    let outcome = GdlEngine::new().eval_product(&identity, src);
    let intent = outcome.value.unwrap_or_else(|| {
        panic!(
            "product did not evaluate: {:?}",
            outcome.diagnostics.as_slice()
        )
    });

    let mut diagnostics = Diagnostics::new();
    check_plugins(
        catalogue,
        &intent,
        "file:///t/product.gdl",
        &mut diagnostics,
    );
    diagnostics.finish();

    let codes = diagnostics.iter().map(|d| d.code).collect();
    let messages = diagnostics
        .iter()
        .map(|d| d.message.clone())
        .collect::<Vec<_>>()
        .join(" | ");
    (codes, messages)
}

const AUTHN: &str = r#"use_gear("authn-resolver", source = "gears-rust""#;

#[test]
fn a_filled_point_is_clean() {
    let cat = require!();
    let (codes, messages) = check(
        &cat,
        &product(
            r#"embedded(id = "dev")"#,
            "dev",
            &format!(r#"{AUTHN}, plugins = [plugin("static-authn-plugin")])"#),
        ),
    );
    assert!(codes.is_empty(), "{codes:?} {messages}");
}

#[test]
fn an_unfilled_point_is_an_error_naming_the_alternatives() {
    let cat = require!();
    let (codes, messages) = check(
        &cat,
        &product(r#"embedded(id = "dev")"#, "dev", &format!("{AUTHN})")),
    );
    assert!(
        codes.contains(&DiagnosticCode::PluginPointUnfilled),
        "{codes:?} {messages}"
    );
    assert!(
        messages.contains("static-authn-plugin") && messages.contains("oidc-authn-plugin"),
        "the message must list what could fill it: {messages}"
    );
}

#[test]
fn a_vendor_mismatch_is_an_error_naming_both_sides() {
    // The motivating failure: both sides read `vendor` from their own config, so
    // overriding one and not the other leaves the host resolving nothing --
    // silently, at runtime.
    let cat = require!();
    let (codes, messages) = check(
        &cat,
        &product(
            r#"embedded(id = "dev")"#,
            "dev",
            &format!(
                r#"{AUTHN}, plugins = [plugin("static-authn-plugin", config = {{"vendor": "acme"}})])"#
            ),
        ),
    );
    assert!(
        codes.contains(&DiagnosticCode::PluginVendorMismatch),
        "{codes:?} {messages}"
    );
    assert!(
        messages.contains("constructorfabric") && messages.contains("acme"),
        "the message must name what the host wants and what the plugin offers: {messages}"
    );
}

#[test]
fn overriding_the_vendor_on_both_sides_is_clean() {
    // The refusal must be surgical: matching overrides are legitimate.
    let cat = require!();
    let (codes, messages) = check(
        &cat,
        &product(
            r#"embedded(id = "dev")"#,
            "dev",
            &format!(
                r#"{AUTHN}, config = {{"vendor": "acme"}},
                   plugins = [plugin("static-authn-plugin", config = {{"vendor": "acme"}})])"#
            ),
        ),
    );
    assert!(codes.is_empty(), "{codes:?} {messages}");
}

// ---------------------------------------------------------------- profiles

const TWO_PROFILES: &str = r#"embedded(id = "dev"), kubernetes(id = "prod", discovery = "static")"#;

#[test]
fn different_plugins_in_different_profiles_do_not_collide() {
    // The canonical case, and the reason `plugin(...)` takes `profiles`.
    let cat = require!();
    let (codes, messages) = check(
        &cat,
        &product(
            TWO_PROFILES,
            "dev",
            &format!(
                r#"{AUTHN}, plugins = [
                     plugin("static-authn-plugin", profiles = ["dev"]),
                     plugin("oidc-authn-plugin", profiles = ["prod"]),
                   ])"#
            ),
        ),
    );
    assert!(codes.is_empty(), "{codes:?} {messages}");
}

#[test]
fn a_point_unfilled_in_only_one_profile_is_still_an_error() {
    // Scoping to dev leaves prod empty. Checking once, globally, would miss it.
    let cat = require!();
    let (codes, messages) = check(
        &cat,
        &product(
            TWO_PROFILES,
            "dev",
            &format!(r#"{AUTHN}, plugins = [plugin("static-authn-plugin", profiles = ["dev"])])"#),
        ),
    );
    assert!(
        codes.contains(&DiagnosticCode::PluginPointUnfilled),
        "{codes:?} {messages}"
    );
    assert!(
        messages.contains("profile `prod`"),
        "the message must name the profile that is short: {messages}"
    );
}

#[test]
fn the_same_plugin_twice_in_one_profile_collides() {
    // No catalogue needed, and so no skip guard: whether one implementation is
    // named twice for one host in one profile is a question the product file
    // answers on its own.
    let identity = FileIdentity {
        uri: "file:///t/product.gdl".to_owned(),
        source: SourceId::new("product").unwrap(),
        gdl_path: RelPath::new("product.gdl").unwrap(),
        load_paths: None,
    };
    let src = product(
        r#"embedded(id = "dev")"#,
        "dev",
        &format!(
            r#"{AUTHN}, plugins = [
                 plugin("static-authn-plugin"),
                 plugin("static-authn-plugin"),
               ])"#
        ),
    );
    let outcome = GdlEngine::new().eval_product(&identity, &src);
    let codes: Vec<DiagnosticCode> = outcome.diagnostics.iter().map(|d| d.code).collect();
    assert!(
        codes.contains(&DiagnosticCode::GdlDuplicateProfileScoped),
        "the product file can answer this one on its own: {codes:?}"
    );
}

// ---------------------------------------------------------------- ambiguity

#[test]
fn a_priority_tie_is_reported_as_undefined_not_decided() {
    // static-authn and oidc-authn both default to priority 100. The host takes
    // the lowest priority from whatever types-registry returns, and nothing
    // orders equal priorities -- so naming a winner would claim more than the
    // runtime guarantees.
    let cat = require!();
    let (codes, messages) = check(
        &cat,
        &product(
            r#"embedded(id = "dev")"#,
            "dev",
            &format!(
                r#"{AUTHN}, plugins = [
                     plugin("static-authn-plugin"), plugin("oidc-authn-plugin")
                   ])"#
            ),
        ),
    );
    assert!(
        codes.contains(&DiagnosticCode::PluginVendorAmbiguous),
        "{codes:?} {messages}"
    );
    assert!(
        messages.contains("undefined"),
        "a tie must be reported as undefined: {messages}"
    );
}

#[test]
fn distinct_priorities_do_decide_a_winner() {
    // tenant-resolver's three plugins default to 50 / 100 / 1000, so this one is
    // genuinely determined and the report should say so.
    let cat = require!();
    let (codes, messages) = check(
        &cat,
        &product(
            r#"embedded(id = "dev")"#,
            "dev",
            r#"use_gear("tenant-resolver", source = "gears-rust", plugins = [
                 plugin("static-tr-plugin"), plugin("rg-tr-plugin")
               ])"#,
        ),
    );
    assert!(
        codes.contains(&DiagnosticCode::PluginVendorAmbiguous),
        "{codes:?} {messages}"
    );
    assert!(
        messages.contains("`rg-tr-plugin` wins on priority") && !messages.contains("undefined"),
        "priority 50 beats 100, and that is determined: {messages}"
    );
}

// ---------------------------------------------------------------- orphans

#[test]
fn a_plugin_without_its_host_is_reported() {
    let cat = require!();
    let (codes, messages) = check(
        &cat,
        &product(
            r#"embedded(id = "dev")"#,
            "dev",
            r#"use_gear("static-authn-plugin", source = "gears-rust")"#,
        ),
    );
    assert!(
        codes.contains(&DiagnosticCode::PluginHostNotSelected),
        "{codes:?} {messages}"
    );
}

#[test]
fn a_gear_with_no_extension_points_is_left_alone() {
    let cat = require!();
    let (codes, messages) = check(
        &cat,
        &product(
            r#"embedded(id = "dev")"#,
            "dev",
            r#"use_gear("api-gateway", source = "gears-rust")"#,
        ),
    );
    assert!(codes.is_empty(), "{codes:?} {messages}");
}

/// The gap `PluginHostNotSelected` leaves, and the whole reason GBX0518 exists.
///
/// A plugin listed under a host that does not declare its point passed every
/// check while meaning nothing: `report_orphan_plugins` asks whether *some*
/// selected gear expects the point, and here one does -- `authn-resolver` is in
/// the product. So the misplacement was invisible, and the Add Gear panel
/// offered it because nothing refused it.
#[test]
fn a_plugin_under_the_wrong_host_is_an_error_naming_both() {
    let cat = require!();
    let (codes, messages) = check(
        &cat,
        &product(
            r#"embedded(id = "dev")"#,
            "dev",
            &format!(
                "{AUTHN}, plugins = [plugin(\"static-authn-plugin\")]), \
                 use_gear(\"types-registry\", source = \"gears-rust\", \
                 plugins = [plugin(\"oidc-authn-plugin\")])"
            ),
        ),
    );
    assert!(
        codes.contains(&DiagnosticCode::PluginPointNotDeclared),
        "{codes:?} {messages}"
    );
    assert!(
        messages.contains("types-registry") && messages.contains("oidc-authn-plugin"),
        "the message must name the host and the plugin: {messages}"
    );
    assert!(
        messages.contains("declares no extension point"),
        "and say what the host does declare: {messages}"
    );
}

/// Host declares *some* points, just not the one this plugin fills.
///
/// The empty-host branch (`declares no extension point`) is covered above;
/// this is the other formatting arm -- naming what the host *does* declare.
#[test]
fn a_plugin_under_a_host_with_other_points_names_them() {
    let cat = require!();
    let (codes, messages) = check(
        &cat,
        &product(
            r#"embedded(id = "dev")"#,
            "dev",
            &format!(
                "{AUTHN}, plugins = [plugin(\"static-authn-plugin\")]), \
                 use_gear(\"tenant-resolver\", source = \"gears-rust\", \
                 plugins = [plugin(\"oidc-authn-plugin\")])"
            ),
        ),
    );
    assert!(
        codes.contains(&DiagnosticCode::PluginPointNotDeclared),
        "{codes:?} {messages}"
    );
    assert!(
        messages.contains("tenant-resolver") && messages.contains("oidc-authn-plugin"),
        "the message must name the host and the plugin: {messages}"
    );
    assert!(
        messages.contains("declares ") && !messages.contains("declares no extension point"),
        "name the points the host has, not the empty-host sentence: {messages}"
    );
}

/// The negative case, which is the one that makes the check worth having: a
/// plugin under the host that *does* declare its point is silent.
#[test]
fn a_plugin_under_its_own_host_is_clean() {
    let cat = require!();
    let (codes, messages) = check(
        &cat,
        &product(
            r#"embedded(id = "dev")"#,
            "dev",
            &format!(r#"{AUTHN}, plugins = [plugin("oidc-authn-plugin")])"#),
        ),
    );
    assert!(
        !codes.contains(&DiagnosticCode::PluginPointNotDeclared),
        "{codes:?} {messages}"
    );
}
