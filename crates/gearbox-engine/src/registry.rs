//! Fetching gears from a package registry, by letting cargo do it.
//!
//! A published gear crate carries `src/` with its `#[toolkit::gear]` attribute
//! and `gear.gdl` beside its `Cargo.toml`, and cargo unpacks it into
//! `~/.cargo/registry/src/<registry>/<name>-<version>/`. That directory is,
//! in shape, exactly what [`SourceRoot`] wants -- so the whole catalogue,
//! including everything ADR-0002 projects out of Rust, works on a registry gear
//! without a line of special handling.
//!
//! **No crates.io client of our own.** A synthesised manifest plus
//! `cargo metadata` buys the download, the unpack, authentication, offline mode,
//! version resolution and any corporate mirror the machine is configured with.
//! Measured, not assumed: a package absent from the cache before the call is
//! present after it, and its reported `manifest_path` points inside the unpack
//! directory. A second `cargo fetch` is not needed.
//!
//! **The closure arrives with it.** A gear's co-location dependencies are real
//! Cargo dependencies, so naming the gears a product uses fetches everything
//! they need in one pass -- no fetch, scan, discover, fetch again.
//!
//! This module reads the world, and that is why it lives at the edge: the CLI
//! and the RPC server call it where they already call [`SourceRoot::open`], and
//! `generate` never sees it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use gearbox_ir::{GearId, SourceDecl, SourceId};

use crate::source::{SourceRoot, SourceRootError};

/// What a fetch produced.
pub struct Fetched {
    /// One root per fetched package that carries a `gear.gdl`.
    pub roots: Vec<SourceRoot>,

    /// Every fetched package, by crate name.
    ///
    /// The table that replaces a relative path. A `gear.gdl` inside a package
    /// points at its SDK with `path = "../../authn-resolver-sdk"`, which is true
    /// in the monorepo and meaningless in an unpacked crate -- but the same
    /// declaration carries `crate_name`, and the SDK is its own published
    /// package sitting in this map.
    pub crates: BTreeMap<String, FetchedCrate>,
}

/// One package, as cargo unpacked it.
pub struct FetchedCrate {
    pub dir: PathBuf,
    pub version: String,
}

/// A gear the product wants from a registry.
pub struct Wanted {
    pub gear: GearId,
    /// `use_gear(version = ...)`, a requirement in Cargo's spelling.
    pub version: Option<String>,
    /// `use_gear(package = ...)`, when the source's prefix does not name it.
    pub package: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("cannot prepare the registry cache at `{path}`")]
    Cache {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("`cargo metadata` failed for the registry source `{id}`")]
    Metadata {
        id: SourceId,
        #[source]
        source: Box<cargo_metadata::Error>,
    },

    #[error("source `{id}` resolved no package for gear `{gear}` (looked for `{package}`)")]
    Missing {
        id: SourceId,
        gear: GearId,
        package: String,
    },

    #[error("a fetched package directory is unusable")]
    Root(#[from] SourceRootError),
}

/// The package a gear id names under this source.
///
/// The prefix is a convention with an exit, not magic: `api-gateway` becomes
/// `cf-gears-api-gateway`, and a gear that does not follow the house naming says
/// so with `use_gear(package = ...)`. A wrong guess is not silent -- the fetched
/// crate's own `gear.gdl` declares its `crate_name`, and GBX0209 checks that
/// against the real `Cargo.toml`.
#[must_use]
pub fn package_name(prefix: Option<&str>, wanted: &Wanted) -> String {
    if let Some(explicit) = &wanted.package {
        return explicit.clone();
    }
    match prefix {
        Some(prefix) => format!("{prefix}{}", wanted.gear),
        None => wanted.gear.to_string(),
    }
}

/// Fetch every wanted gear and everything it depends on.
///
/// # Errors
/// Returns [`RegistryError`] when the cache cannot be written, when cargo fails,
/// or when a named package is not in the resolved graph.
pub fn fetch(
    id: &SourceId,
    decl: &SourceDecl,
    wanted: &[Wanted],
    cache_dir: &Path,
) -> Result<Fetched, RegistryError> {
    let SourceDecl::Registry { prefix, .. } = decl else {
        return Ok(Fetched {
            roots: Vec::new(),
            crates: BTreeMap::new(),
        });
    };

    let manifest = write_seed_manifest(id, prefix.as_deref(), wanted, cache_dir)?;
    let metadata = cargo_metadata::MetadataCommand::new()
        .manifest_path(&manifest)
        .exec()
        .map_err(|source| RegistryError::Metadata {
            id: id.clone(),
            source: Box::new(source),
        })?;

    let mut crates = BTreeMap::new();
    for package in &metadata.packages {
        let Some(dir) = package.manifest_path.parent() else {
            continue;
        };
        // The seed itself is in the graph and is not a gear.
        if dir.as_std_path() == cache_dir {
            continue;
        }
        crates.insert(
            package.name.to_string(),
            FetchedCrate {
                dir: dir.as_std_path().to_path_buf(),
                version: package.version.to_string(),
            },
        );
    }

    for want in wanted {
        let package = package_name(prefix.as_deref(), want);
        if !crates.contains_key(&package) {
            return Err(RegistryError::Missing {
                id: id.clone(),
                gear: want.gear.clone(),
                package,
            });
        }
    }

    // A root per package that actually describes a gear. **Its id is the crate
    // name, not the declared source id**, and the difference is worth stating:
    // a registry source is not one directory, it is a place to fetch from, so
    // several roots come out of one declaration. Recording the package each gear
    // came from is more precise than recording that they all came from "cf", and
    // it keeps root ids unique without inventing a spelling.
    let mut roots = Vec::new();
    for (name, fetched) in &crates {
        if !fetched.dir.join("gear.gdl").is_file() {
            continue;
        }
        let Ok(root_id) = SourceId::new(name.clone()) else {
            continue;
        };
        let mut root = SourceRoot::open(root_id, &fetched.dir)?;
        // Every fetched package, not just this one's declared siblings: a
        // description names an SDK by crate, and which of the fetched packages
        // that is, is a question the table answers without anyone enumerating
        // edges.
        root.siblings = crates
            .iter()
            .map(|(name, fetched)| (name.clone(), fetched.dir.clone()))
            .collect();
        roots.push(root);
    }

    Ok(Fetched { roots, crates })
}

/// The manifest cargo resolves against.
///
/// Kept on disk rather than in a temporary directory so its `Cargo.lock` sits
/// beside it: that file is what makes a second fetch resolve the same versions
/// as the first, which is the difference between a reproducible product and one
/// that drifts whenever a dependency publishes.
fn write_seed_manifest(
    id: &SourceId,
    prefix: Option<&str>,
    wanted: &[Wanted],
    cache_dir: &Path,
) -> Result<PathBuf, RegistryError> {
    let mut body = String::from(
        "# GENERATED by gearbox -- the manifest `cargo metadata` resolves a\n\
         # registry source against. Not a product; delete it and it comes back.\n\
         [package]\n\
         name = \"gearbox-registry-seed\"\n\
         version = \"0.0.0\"\n\
         edition = \"2021\"\n\
         publish = false\n\n\
         [dependencies]\n",
    );
    for want in wanted {
        let package = package_name(prefix, want);
        let version = want.version.as_deref().unwrap_or("*");
        body.push_str(&package);
        body.push_str(" = \"");
        body.push_str(version);
        body.push_str("\"\n");
    }

    let src = cache_dir.join("src");
    std::fs::create_dir_all(&src).map_err(|source| RegistryError::Cache {
        path: src.clone(),
        source,
    })?;
    // Cargo wants a target to exist before it will resolve anything.
    std::fs::write(src.join("lib.rs"), "").map_err(|source| RegistryError::Cache {
        path: src.join("lib.rs"),
        source,
    })?;
    let manifest = cache_dir.join("Cargo.toml");
    std::fs::write(&manifest, body).map_err(|source| RegistryError::Cache {
        path: manifest.clone(),
        source,
    })?;
    let _ = id;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The prefix is a convention; `package` is the way out of it.
    #[test]
    fn a_gear_id_becomes_a_package_name() {
        let want = |gear: &str, package: Option<&str>| Wanted {
            gear: GearId::new(gear).unwrap(),
            version: None,
            package: package.map(str::to_owned),
        };
        assert_eq!(
            package_name(Some("cf-gears-"), &want("api-gateway", None)),
            "cf-gears-api-gateway"
        );
        // No prefix means the id is the package, which is what a source outside
        // the house naming looks like.
        assert_eq!(
            package_name(None, &want("api-gateway", None)),
            "api-gateway"
        );
        // And an explicit package wins over both, for the gear that follows
        // neither convention.
        assert_eq!(
            package_name(Some("cf-gears-"), &want("weird", Some("acme-weird"))),
            "acme-weird"
        );
    }

    /// A path source is untouched by the registry rule.
    ///
    /// The table is consulted only where it has the name, so a directory root --
    /// whose table is empty -- resolves exactly as it always did. That is not a
    /// detail: resolving by name everywhere would let a description with a wrong
    /// path and a right crate name start working, and GBX0209 exists to catch
    /// precisely that.
    #[test]
    fn an_empty_sibling_table_leaves_path_resolution_alone() {
        let dir = std::env::temp_dir().join(format!("gbx-siblings-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("crates/thing")).unwrap();
        let root = SourceRoot::open(SourceId::new("local").unwrap(), &dir).unwrap();
        assert!(root.siblings.is_empty());

        let gdl = gearbox_ir::RelPath::new("crates/thing/gear.gdl").unwrap();
        let here = crate::merge::crate_dir(&root, &gdl, ".", "cf-thing").unwrap();
        assert_eq!(here, root.root.join("crates/thing"));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A named sibling wins, and the path is not consulted at all.
    ///
    /// This is the whole of the registry fix: `../../authn-resolver-sdk` is true
    /// in the monorepo and unresolvable in an unpacked package, where the SDK is
    /// a separate published crate somewhere else entirely.
    #[test]
    fn a_named_sibling_is_found_where_the_path_could_not_reach() {
        let dir = std::env::temp_dir().join(format!("gbx-named-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let elsewhere = dir.join("cf-gears-authn-resolver-sdk-0.3.32");
        std::fs::create_dir_all(&elsewhere).unwrap();

        let mut root = SourceRoot::open(SourceId::new("plugin").unwrap(), &dir).unwrap();
        root.siblings
            .insert("cf-gears-authn-resolver-sdk".to_owned(), elsewhere.clone());

        let gdl = gearbox_ir::RelPath::new("gear.gdl").unwrap();
        // The path escapes the root and would be refused outright; the name is
        // what makes this resolvable.
        let found = crate::merge::crate_dir(
            &root,
            &gdl,
            "../../authn-resolver-sdk",
            "cf-gears-authn-resolver-sdk",
        )
        .unwrap();
        assert_eq!(found, elsewhere);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
