//! Architectural boundaries, asserted rather than reviewed.
//!
//! Two rules the PRD relies on:
//!
//! - The engine must not depend on any client (`cpt-gearbox-nfr-engine-has-no-frontend-deps`).
//!   Every client is a peer; a dependency pointing the other way is how product
//!   semantics leak into a renderer.
//! - Only `gearbox-gdl` may name `starlark`. It is pre-1.0 and 0.14 broke hard
//!   from 0.13, so containment is what keeps an upgrade from reaching the
//!   resolver and the generators.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::process::Command;

/// `cargo metadata` for the whole workspace, as parsed JSON.
fn metadata() -> serde_json::Value {
    let out = Command::new(env!("CARGO"))
        .args(["metadata", "--format-version", "1", "--no-deps"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("run cargo metadata");
    assert!(out.status.success(), "cargo metadata failed");
    serde_json::from_slice(&out.stdout).expect("parse cargo metadata")
}

/// The direct dependency names of one workspace member.
fn deps_of(meta: &serde_json::Value, package: &str) -> Vec<String> {
    meta["packages"]
        .as_array()
        .expect("packages")
        .iter()
        .find(|p| p["name"] == package)
        .unwrap_or_else(|| panic!("no package named {package}"))["dependencies"]
        .as_array()
        .expect("dependencies")
        .iter()
        .map(|d| d["name"].as_str().unwrap_or_default().to_owned())
        .collect()
}

#[test]
fn engine_depends_on_no_client() {
    let meta = metadata();
    let deps = deps_of(&meta, "gearbox-engine");
    for forbidden in ["gearbox-cli", "gearbox-rpc"] {
        assert!(
            !deps.iter().any(|d| d == forbidden),
            "gearbox-engine must not depend on {forbidden}; clients are peers of the engine, \
             not the reverse. Found: {deps:?}"
        );
    }
}

#[test]
fn only_the_gdl_crate_names_starlark() {
    let meta = metadata();
    for package in [
        "gearbox-ir",
        "gearbox-lock",
        "gearbox-engine",
        "gearbox-cli",
    ] {
        let deps = deps_of(&meta, package);
        let starlark: Vec<&String> = deps.iter().filter(|d| d.starts_with("starlark")).collect();
        assert!(
            starlark.is_empty(),
            "{package} names {starlark:?}; starlark is pre-1.0 and must stay contained in \
             gearbox-gdl so an upgrade cannot reach the resolver or the generators"
        );
    }

    // And the containment is real, not vacuous: gearbox-gdl really does use it.
    let gdl = deps_of(&meta, "gearbox-gdl");
    assert!(
        gdl.iter().any(|d| d == "starlark"),
        "gearbox-gdl should be the crate that depends on starlark; got {gdl:?}"
    );
}

#[test]
fn only_the_gdl_crate_waives_unsafe_code() {
    // The workspace sets `unsafe_code = "deny"` rather than "forbid" purely so
    // gearbox-gdl can waive it for starlark's ProvidesStaticType derive. That
    // concession must not spread.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .expect("workspace root")
        .join("crates");

    for entry in std::fs::read_dir(&root).expect("read crates/") {
        let dir = entry.expect("dir entry").path();
        let name = dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        if name == "gearbox-gdl" {
            continue;
        }
        let src = dir.join("src");
        if !src.exists() {
            continue;
        }
        for file in walkdir::WalkDir::new(&src)
            .into_iter()
            .filter_map(Result::ok)
        {
            if file.file_type().is_file() && file.path().extension().is_some_and(|e| e == "rs") {
                let text = std::fs::read_to_string(file.path()).expect("read source");
                assert!(
                    !text.contains("unsafe_code"),
                    "{} waives unsafe_code; only gearbox-gdl may, and only for starlark's \
                     ProvidesStaticType derive",
                    file.path().display()
                );
            }
        }
    }
}
