//! Gear metadata: categories, documents, GTS types.
//!
//! All three came from wanting to absorb the `gear.toml` files the platform team
//! committed. Two of them (`docs`, `gts_types`) are new; `category` existed but
//! as a free string, and the twelve descriptions in the slice all held a value no
//! gear in the platform uses.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::{Path, PathBuf};

use gearbox_engine::{SourceRoot, load_catalogue};
use gearbox_ir::{Catalogue, GearId, Severity, SourceId};

fn gears_rust() -> Option<PathBuf> {
    let candidate = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(|p| p.join("../gears-rust"))?;
    candidate
        .canonicalize()
        .ok()
        .filter(|p| p.join("gears").is_dir())
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

fn gear<'a>(c: &'a Catalogue, id: &str) -> &'a gearbox_ir::GearDescriptor {
    c.gear(&GearId::new(id).unwrap())
        .unwrap_or_else(|| panic!("no gear `{id}`"))
}

// ---------------------------------------------------------------- category

/// The categories the platform's own `gear.toml` files carry, for the slice gears
/// that have one.
///
/// Written down here rather than read from disk on purpose: `gear.toml` landed on
/// `main` after this checkout, so the values were taken from the repository and
/// pinned. If they change, this test is where the disagreement surfaces.
const PLATFORM_CATEGORIES: &[(&str, &str)] = &[
    ("api-gateway", "api-ingress"),
    ("authn-resolver", "core-platform-integration"),
    ("cluster", "serverless"),
    ("gear-orchestrator", "core-functionality"),
    ("grpc-hub", "core-functionality"),
    ("tenant-resolver", "core-platform-integration"),
    ("types-registry", "core-functionality"),
];

#[test]
fn categories_match_the_platforms_own_gear_toml() {
    let c = require!();
    for (id, expected) in PLATFORM_CATEGORIES {
        assert_eq!(
            gear(&c, id).category.as_deref(),
            Some(*expected),
            "`{id}` must carry the category the platform assigned it, not one we invented"
        );
    }
}

#[test]
fn no_gear_in_the_slice_uses_an_unknown_category() {
    // The twelve that previously said "platform" -- a value no gear in the
    // platform uses -- are what this guards against coming back.
    let c = require!();
    let unknown: Vec<String> = c
        .diagnostics
        .iter()
        .filter(|d| d.code == gearbox_ir::DiagnosticCode::GdlUnknownCategory)
        .map(|d| d.message.clone())
        .collect();
    assert!(unknown.is_empty(), "{unknown:#?}");
}

#[test]
fn an_unknown_category_warns_rather_than_failing() {
    // Warning, not error: the taxonomy is visibly unsettled (`cluster` is filed
    // under `serverless`), so refusing would claim the set is closed.
    let code = gearbox_ir::DiagnosticCode::GdlUnknownCategory;
    assert_eq!(code.default_severity(), Severity::Warning);
    assert!(!code.requires_evidence());
}

// ---------------------------------------------------------------- docs

#[test]
fn documents_are_found_one_level_above_the_crate() {
    // The whole reason the search climbs: the platform keeps documents at
    // `gears/<name>/docs/` while a `gear.gdl` sits in a crate directory below.
    let c = require!();
    let docs = gear(&c, "cluster").docs.as_ref().expect("cluster has docs");
    assert_eq!(
        docs.prd.as_ref().map(gearbox_ir::RelPath::as_str),
        Some("gears/system/cluster/docs/PRD.md")
    );
    assert_eq!(
        docs.design.as_ref().map(gearbox_ir::RelPath::as_str),
        Some("gears/system/cluster/docs/DESIGN.md")
    );
    assert!(!docs.adr.is_empty(), "cluster has ADRs");
}

#[test]
fn a_gear_with_its_own_docs_directory_uses_that_one() {
    // Order matters: beside the description before its parent.
    let c = require!();
    let docs = gear(&c, "oidc-authn-plugin")
        .docs
        .as_ref()
        .expect("this plugin keeps its own docs");
    assert!(
        docs.prd
            .as_ref()
            .is_some_and(|p| p.as_str().contains("oidc-authn-plugin/docs/")),
        "got {:?}",
        docs.prd
    );
}

#[test]
fn a_gear_with_no_documents_reports_none_rather_than_empty() {
    // Absence is ordinary, not a gap, so there is no diagnostic and no empty
    // block to render.
    let c = require!();
    assert!(gear(&c, "grpc-hub").docs.is_none());
}

#[test]
fn no_gear_claims_an_openapi_spec_it_does_not_have() {
    // Four gears in the platform check one in, none of them in the slice. A
    // convention that matched too eagerly would show up right here.
    let c = require!();
    let claimed: Vec<&str> = c
        .gears
        .values()
        .filter(|g| g.docs.as_ref().is_some_and(|d| d.openapi.is_some()))
        .map(|g| g.id.as_str())
        .collect();
    assert!(claimed.is_empty(), "unexpected openapi: {claimed:?}");
}

// ---------------------------------------------------------------- gts

#[test]
fn a_gts_type_is_attributed_to_its_sdks_owner_only() {
    // The bug this catches: a plugin points at its host's SDK, so projecting
    // naively made one type declared once in `authn-resolver-sdk` show up on the
    // host and on every plugin alike.
    let c = require!();
    let authn = "cf.toolkit.plugins.plugin.v1~cf.core.authn_resolver.plugin.v1~";

    let owners: Vec<&str> = c
        .gears
        .values()
        .filter(|g| g.gts_types.iter().any(|t| t.type_id == authn))
        .map(|g| g.id.as_str())
        .collect();
    assert_eq!(
        owners,
        vec!["authn-resolver"],
        "declared once, owned once -- not by each implementation"
    );
}

#[test]
fn plugins_expose_no_gts_types_of_their_own() {
    let c = require!();
    for id in [
        "static-authn-plugin",
        "oidc-authn-plugin",
        "static-tr-plugin",
    ] {
        assert!(
            gear(&c, id).gts_types.is_empty(),
            "`{id}` points at its host's SDK; the types there are the host's"
        );
    }
}

#[test]
fn a_gear_with_no_sdk_exposes_no_gts_types() {
    let c = require!();
    assert!(gear(&c, "api-gateway").gts_types.is_empty());
}
