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

// --------------------------------------------------------------------------
// `plugin_interface`, checked against the SDK at catalogue-load time -- a
// different phase than the two sections above, which join a loaded catalogue
// against a product. This builds its own two-crate source root rather than
// using `check`/`product`, because the diagnostic under test
// (`PluginPointUndetermined`) fires while the catalogue itself is built.

const INTERFACE_SDK_MANIFEST: &str = "[package]\nname = \"thing-sdk\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n\
     [lib]\nname = \"thing_sdk\"\npath = \"src/lib.rs\"\n";

const INTERFACE_SDK_RS: &str = r"
pub trait ThingPluginClient: Send + Sync {}
";

const INTERFACE_GEAR_MANIFEST: &str = "[package]\nname = \"plugin-gear\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n\
     [lib]\nname = \"plugin_gear\"\npath = \"src/lib.rs\"\n";

const INTERFACE_GEAR_RS: &str = r#"
#[toolkit::gear(name = "plugin-gear", capabilities = [system])]
pub struct PluginGear;
"#;

/// A `plugin_interface` naming no trait the sdk declares.
const INTERFACE_GEAR_GDL: &str = r#"
gear(
    name = "Plugin Gear",
    description = "d",
    category = "core-functionality",
    visibility = "internal",
    package = cargo(crate_name = "plugin-gear", lib = "plugin_gear", path = "."),
    sdk = cargo(crate_name = "thing-sdk", lib = "thing_sdk", path = "../thing-sdk"),
    plugin_interface = "NoSuchInterface",
)
"#;

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

/// `plugin_interface` is an argument of `gear(...)`, not a call of its own, so
/// an unresolvable name has to fall back to the `gear(...)` span -- the finest
/// anchor that exists for it.
#[test]
fn an_unresolvable_plugin_interface_is_anchored_on_its_gear_call() {
    let root = std::env::temp_dir().join(format!("gbx-plugin-interface-{}", std::process::id()));
    drop(std::fs::remove_dir_all(&root));

    let sdk = root.join("thing-sdk");
    std::fs::create_dir_all(sdk.join("src")).unwrap();
    std::fs::write(sdk.join("Cargo.toml"), INTERFACE_SDK_MANIFEST).unwrap();
    std::fs::write(sdk.join("src/lib.rs"), INTERFACE_SDK_RS).unwrap();

    let gear = root.join("plugin-gear");
    std::fs::create_dir_all(gear.join("src")).unwrap();
    std::fs::write(gear.join("Cargo.toml"), INTERFACE_GEAR_MANIFEST).unwrap();
    std::fs::write(gear.join("src/lib.rs"), INTERFACE_GEAR_RS).unwrap();
    std::fs::write(gear.join("gear.gdl"), INTERFACE_GEAR_GDL).unwrap();

    let source = SourceRoot::open(SourceId::new("demo").unwrap(), &root).unwrap();
    let catalogue = load_catalogue(&[source]).catalogue;
    drop(std::fs::remove_dir_all(&root));

    let diagnostic = catalogue
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::PluginPointUndetermined)
        .expect("GBX0xxx (PluginPointUndetermined)");
    assert!(
        diagnostic.message.contains("NoSuchInterface"),
        "{}",
        diagnostic.message
    );

    let location = diagnostic
        .location
        .as_ref()
        .expect("the diagnostic carries a location");
    assert_ne!(
        location.range,
        gearbox_ir::Range::whole_file(),
        "must anchor on the gear(...) call, not the file: {diagnostic:#?}"
    );
    assert_eq!(
        location.range.start.line,
        line_of(INTERFACE_GEAR_GDL, "gear("),
        "must be anchored on the gear(...) line"
    );
}
