//! Parsing each crate once per catalogue load.
//!
//! Crates are named by more than one gear, so a naive load parses the same files
//! repeatedly. Measured on the 14-gear slice: `tenant-resolver-sdk` is declared
//! as `sdk` by its host and three plugins, so it was read four times, and
//! `authn-resolver-sdk` three. That is ~90 files of SDK re-parsed for nothing on
//! a slice; the full tree holds 2658 `.rs` files under `gears/`.
//!
//! The cache lives in the engine rather than in `gearbox-project` on purpose.
//! `scan_crate` answers "what is in this directory" and should stay a pure
//! function of the filesystem; only the engine knows what "one load" means and
//! when the answer may be reused.
//!
//! It is also a precondition for staged loading rather than an optimisation of
//! it: a later stage that re-parses shared crates cannot be cheap no matter how
//! it is scheduled.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use gearbox_project::{CrateManifest, RustFile};

/// The result of one crate scan, shared by every gear that named it.
///
/// `Arc<[RustFile]>` rather than `Arc<Vec<_>>`: one allocation instead of two,
/// and it derefs straight to the `&[RustFile]` every consumer wants. The error
/// is a `String` because the same failure is handed to every caller, and
/// `ScanError` carries a non-cloneable `syn::Error`.
///
/// Flattening to a string is where the *cause* used to be lost: `ScanError`'s
/// own `Display` says `cannot parse <path>` and nothing about what rustc would
/// have said, so an operator saw the file and not the mistake in it. [`chain`]
/// keeps the whole source chain.
type ScanResult = Result<Arc<[RustFile]>, String>;

/// The result of one manifest read, shared the same way a scan is.
///
/// Cached for the same reason and with more force: `mini-chat` declares three
/// gears out of one crate, so without this its `Cargo.toml` would be read three
/// times to answer the same question.
type ManifestResult = Result<Arc<CrateManifest>, String>;

/// One load's worth of crate scans.
///
/// No `Debug`: `RustFile` holds a `syn::File`, and printing a cache of parsed
/// syntax trees would be pages of noise rather than the two numbers that matter.
#[derive(Default)]
pub struct CrateScans {
    /// Keyed by canonical path, so `a/../b` and `b` are one entry.
    ///
    /// Failures are cached too: a crate with no `src/` should be reported once,
    /// not once per gear that names it.
    cache: HashMap<PathBuf, ScanResult>,
    /// Manifests, keyed the same way and for the same reason.
    manifests: HashMap<PathBuf, ManifestResult>,
    /// How many times a scan was asked for, cache hits included.
    ///
    /// Counted so the saving is measurable rather than asserted: the difference
    /// between this and the cache size *is* the work avoided.
    requests: usize,
}

/// An error and every cause beneath it, joined with `: `.
///
/// The whole point of caching a `String`: whatever is not in it here is gone
/// for good, and the rustc-quality parse message under a `ScanError::Parse` is
/// exactly the part worth keeping.
fn chain(error: &dyn std::error::Error) -> String {
    let mut out = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        out.push_str(": ");
        out.push_str(&cause.to_string());
        source = cause.source();
    }
    out
}

impl CrateScans {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The files in `dir`, parsed at most once per load.
    ///
    /// # Errors
    /// Returns the scan error's message; see [`ScanResult`].
    pub fn get(&mut self, dir: &Path) -> ScanResult {
        // Canonicalizing is what makes the sharing work: the same SDK reached
        // from a host and from a plugin arrives as two different relative paths.
        self.requests += 1;
        let key = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
        self.cache
            .entry(key)
            .or_insert_with(|| {
                gearbox_project::scan_crate(dir)
                    .map(Arc::from)
                    .map_err(|e| chain(&e))
            })
            .clone()
    }

    /// The `Cargo.toml` in `dir`, read at most once per load.
    ///
    /// # Errors
    /// Returns the projection error's message; see [`ManifestResult`].
    pub fn manifest(&mut self, dir: &Path) -> ManifestResult {
        let key = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
        self.manifests
            .entry(key)
            .or_insert_with(|| {
                gearbox_project::project_manifest(dir)
                    .map(Arc::new)
                    .map_err(|e| chain(&e))
            })
            .clone()
    }

    /// How many distinct crates were parsed.
    ///
    /// Exposed so a test can assert the sharing actually happens: without it,
    /// the cache is invisible -- the catalogue is identical either way, which is
    /// exactly the point.
    #[must_use]
    pub fn distinct_crates(&self) -> usize {
        self.cache.len()
    }

    /// How many scans were asked for in total.
    #[must_use]
    pub const fn scan_requests(&self) -> usize {
        self.requests
    }
}
