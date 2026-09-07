//! Projecting a crate's identity out of its `Cargo.toml`.
//!
//! Two facts are read, and both are declared in `gear.gdl` because neither can
//! be derived from the other:
//!
//! - the **package name**, which is what a generated `[dependencies]` entry has
//!   to spell;
//! - the **library identifier**, which is what a generated `use ... as _;` line
//!   has to spell.
//!
//! They are not the same string and not mechanically related. A crate with an
//! explicit `[lib] name` uses that; a crate without one takes its library
//! identifier from the package name with dashes turned into underscores, so
//! `cf-api-contracts` is `cf_api_contracts` -- not `api_contracts`, which is
//! what a reader guesses from the directory. Getting it wrong emits a link line
//! that does not compile, which is why the description declares it and this
//! module checks the declaration.
//!
//! A third fact is read and is not checked against anything: the **names in
//! `[features]`**. `use_gear(..., features = [...])` writes Cargo features, and
//! until this was projected the Studio had no way to know which names were
//! real -- so it offered a free-text box, and a typo became a `Cargo.toml`
//! feature that does not exist and a build failure two steps later. Measured
//! before building it: 7 of the 14 gear crates in the corpus declare a
//! `[features]` table, of 2 to 4 entries; the other 7 declare none, which is an
//! answer rather than a gap.

use std::collections::BTreeSet;
use std::path::Path;

/// A crate's identity as its own manifest states it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrateManifest {
    /// `[package] name`.
    pub package_name: String,
    /// `[lib] name` when present, otherwise the package name with `-` as `_`.
    pub lib_ident: String,
    /// Whether the identifier came from an explicit `[lib]` section.
    ///
    /// Kept because it changes the advice: a mismatch on a crate that declares
    /// `[lib] name` means the description copied the wrong string, while a
    /// mismatch on one that does not means someone derived the identifier from
    /// the directory instead of from the package name.
    pub lib_is_explicit: bool,

    /// The names in `[features]`, in sorted order.
    ///
    /// Every name, uncurated, including the ones a crate declares for its own
    /// test matrix: `types-registry`'s only feature is `integration`, which
    /// gates tests that need a Docker daemon. Deciding which of these an
    /// integrator should be offered is a *declaration* -- the same split ADR
    /// `cpt-gearbox-adr-macro-projected-catalogue` makes for config fields,
    /// where the types are projected and only the selection is declared -- and
    /// there is no such declaration yet. So a client that shows these must say
    /// what they are rather than implying they are all appropriate.
    ///
    /// Empty means the crate declares no features. It is not "unknown": a
    /// manifest that could not be read is an error, not an empty set.
    pub features: BTreeSet<String>,
}

/// Why a manifest could not be read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ManifestError {
    #[error("cannot read `{path}`: {message}")]
    Unreadable { path: String, message: String },
    #[error("`{path}` is not valid TOML: {message}")]
    Malformed { path: String, message: String },
    /// No `[package] name`, which a workspace-root manifest legitimately lacks.
    #[error("`{path}` declares no `[package] name`")]
    NoPackage { path: String },
}

/// Read `<dir>/Cargo.toml`.
///
/// # Errors
/// Returns [`ManifestError`] when the file is missing, unparseable, or has no
/// `[package]` section. A virtual workspace manifest hits the last case, and
/// that is worth reporting rather than defaulting: a description pointing at a
/// workspace root instead of at a crate has named the wrong `path`.
pub fn project_manifest(dir: &Path) -> Result<CrateManifest, ManifestError> {
    let path = dir.join("Cargo.toml");
    let display = path.display().to_string();

    if let Ok(meta) = std::fs::symlink_metadata(&path)
        && meta.file_type().is_symlink()
    {
        return Err(ManifestError::Unreadable {
            path: display,
            message: "Cargo.toml is a symlink; a crate may only be read through a real \
                      manifest inside its source root"
                .to_owned(),
        });
    }

    let text = std::fs::read_to_string(&path).map_err(|e| ManifestError::Unreadable {
        path: display.clone(),
        message: e.to_string(),
    })?;
    let table: toml::Table =
        text.parse()
            .map_err(|e: toml::de::Error| ManifestError::Malformed {
                path: display.clone(),
                message: e.message().to_owned(),
            })?;

    let package_name = table
        .get("package")
        .and_then(|p| p.get("name"))
        .and_then(toml::Value::as_str)
        .ok_or(ManifestError::NoPackage { path: display })?
        .to_owned();

    // `[lib] name` is the only override Cargo honours for the library target's
    // identifier. `[[bin]]` names are irrelevant here: a gear is linked as a
    // library.
    let explicit = table
        .get("lib")
        .and_then(|l| l.get("name"))
        .and_then(toml::Value::as_str)
        .map(ToOwned::to_owned);

    // Computed before the literal so `package_name` can be read here and moved
    // there.
    let lib_is_explicit = explicit.is_some();
    let lib_ident = explicit.unwrap_or_else(|| package_name.replace('-', "_"));

    // Keys only. A feature's value is the list of dependencies it turns on,
    // which is cargo's business and not a fact about the product.
    let features = table
        .get("features")
        .and_then(toml::Value::as_table)
        .map(|features| features.keys().cloned().collect())
        .unwrap_or_default();

    Ok(CrateManifest {
        package_name,
        lib_ident,
        lib_is_explicit,
        features,
    })
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod manifest_tests;
