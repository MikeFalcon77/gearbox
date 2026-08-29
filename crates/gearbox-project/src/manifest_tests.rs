//! Tests for manifest projection.
//!
//! The interesting case is the crate with no `[lib]` section, because that is
//! where a reader's guess and Cargo's rule diverge: `cf-api-contracts` links as
//! `cf_api_contracts`, not as `api_contracts`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::PathBuf;

use super::*;

/// Write a `Cargo.toml` into a fresh temporary directory.
fn crate_with(manifest: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "gearbox-manifest-{}-{:?}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("Cargo.toml"), manifest).unwrap();
    dir
}

#[test]
fn no_lib_section_means_the_package_name_with_underscores() {
    let dir = crate_with("[package]\nname = \"cf-api-contracts\"\nversion = \"0.1.0\"\n");
    let manifest = project_manifest(&dir).unwrap();
    assert_eq!(manifest.package_name, "cf-api-contracts");
    assert_eq!(
        manifest.lib_ident, "cf_api_contracts",
        "not `api_contracts`: Cargo derives from the package name, and the \
         directory name has no say in it"
    );
    assert!(!manifest.lib_is_explicit);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_explicit_lib_name_wins() {
    let dir = crate_with(
        "[package]\nname = \"cf-gears-api-gateway\"\nversion = \"0.1.0\"\n\n[lib]\nname = \"api_gateway\"\n",
    );
    let manifest = project_manifest(&dir).unwrap();
    assert_eq!(manifest.package_name, "cf-gears-api-gateway");
    assert_eq!(manifest.lib_ident, "api_gateway");
    assert!(manifest.lib_is_explicit);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_lib_section_without_a_name_falls_back() {
    // `[lib] path = ...` with no `name` is legal and leaves the identifier to
    // Cargo's default. Treating the section's presence as an override would
    // report a mismatch against `None`.
    let dir = crate_with(
        "[package]\nname = \"cf-gears-cluster\"\nversion = \"0.1.0\"\n\n[lib]\npath = \"src/lib.rs\"\n",
    );
    let manifest = project_manifest(&dir).unwrap();
    assert_eq!(manifest.lib_ident, "cf_gears_cluster");
    assert!(!manifest.lib_is_explicit);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_virtual_workspace_manifest_is_reported_not_defaulted() {
    // A description whose `path` points at a workspace root instead of a crate.
    // Defaulting here would invent a package name and let the mistake through to
    // a generated dependency line that cannot resolve.
    let dir = crate_with("[workspace]\nmembers = [\"crates/*\"]\n");
    let err = project_manifest(&dir).unwrap_err();
    assert!(
        matches!(err, ManifestError::NoPackage { .. }),
        "got {err:?}"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_missing_manifest_is_an_error() {
    let dir = std::env::temp_dir().join("gearbox-manifest-definitely-absent");
    let err = project_manifest(&dir).unwrap_err();
    assert!(
        matches!(err, ManifestError::Unreadable { .. }),
        "got {err:?}"
    );
}

#[test]
fn malformed_toml_says_so() {
    let dir = crate_with("[package\nname = ");
    let err = project_manifest(&dir).unwrap_err();
    assert!(
        matches!(err, ManifestError::Malformed { .. }),
        "got {err:?}"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_real_tree_agrees_with_what_the_descriptions_declare() {
    // The baseline: 25 `cargo(...)` blocks across 14 descriptions, all correct.
    // This asserts the projection reproduces the two cases the tree contains --
    // explicit `[lib]` for the platform gears, derived for the examples.
    let Some(base) = crate::test_corpus::corpus_root() else {
        eprintln!("skipping: ../gears-rust not present");
        return;
    };

    let gateway = project_manifest(&base.join("gears/system/api-gateway")).unwrap();
    assert_eq!(gateway.package_name, "cf-gears-api-gateway");
    assert_eq!(gateway.lib_ident, "api_gateway");
    assert!(gateway.lib_is_explicit);

    let example =
        project_manifest(&base.join("examples/toolkit/api-contracts/api-contracts")).unwrap();
    assert_eq!(example.package_name, "cf-api-contracts");
    assert_eq!(example.lib_ident, "cf_api_contracts");
    assert!(
        !example.lib_is_explicit,
        "this is the crate the whole check exists for: no [lib] section, so the \
         identifier is cf_api_contracts and a reader guessing api_contracts \
         would emit a link line that does not compile"
    );
}
