//! Reading a crate's `src/` tree.

use std::path::{Path, PathBuf};

/// Why a crate's source could not be read.
#[derive(Debug, thiserror::Error)]
pub enum ScanError {
    #[error("crate directory `{}` has no src/ directory", .0.display())]
    NoSrc(PathBuf),

    #[error("cannot read `{}`", .0.display())]
    Read(PathBuf, #[source] std::io::Error),

    #[error("cannot parse `{}`", .0.display())]
    Parse(PathBuf, syn::Error),
}

/// One parsed Rust file, with the path to blame in a diagnostic.
pub struct RustFile {
    /// Absolute path on disk.
    pub path: PathBuf,
    /// Path relative to the crate's `src/`, which is what `attr` narrows on and
    /// what a diagnostic should show -- an absolute path from someone else's
    /// machine is noise.
    pub relative: PathBuf,
    pub ast: syn::File,
}

/// Parse every `.rs` file under `crate_dir/src`, sorted by path.
///
/// A directory walk rather than a `mod`-tree walk from `lib.rs`. That is what
/// `cpt-gearbox-fr-attribute-location` specifies, and it is the more robust
/// choice here: a `mod` tree behind `#[cfg(feature = ...)]` would make
/// discovery depend on feature selection, and feature selection is downstream
/// of the catalogue. The cost is that a file not reachable by any `mod` is
/// still scanned; in practice such a file is dead code.
///
/// # Errors
/// Returns [`ScanError`] when `src/` is absent, a file cannot be read, or a
/// file is not valid Rust.
pub fn scan_crate(crate_dir: &Path) -> Result<Vec<RustFile>, ScanError> {
    let src = crate_dir.join("src");
    if !src.is_dir() {
        return Err(ScanError::NoSrc(crate_dir.to_path_buf()));
    }

    let mut paths: Vec<PathBuf> = walkdir::WalkDir::new(&src)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && e.path().extension().is_some_and(|x| x == "rs"))
        .map(walkdir::DirEntry::into_path)
        .collect();
    // Sorted so the candidate list in an ambiguity diagnostic is stable.
    paths.sort();

    let mut files = Vec::with_capacity(paths.len());
    for path in paths {
        let text = std::fs::read_to_string(&path).map_err(|e| ScanError::Read(path.clone(), e))?;
        let ast = syn::parse_file(&text).map_err(|e| ScanError::Parse(path.clone(), e))?;
        let relative = path.strip_prefix(&src).unwrap_or(&path).to_path_buf();
        files.push(RustFile {
            path,
            relative,
            ast,
        });
    }
    Ok(files)
}

/// Interpret a description's narrowing path against a crate's scanned files.
///
/// A narrowing path is written relative to the crate root and includes `src/`
/// (`src/gear.rs`), while [`RustFile::relative`] is keyed relative to `src/`.
/// This reconciles the two and refuses anything that would reach outside the
/// crate -- `..` in a narrowing path is never what a description means.
///
/// # Errors
/// Returns the offending spec when it is absolute or contains `..`.
pub fn narrowing_path(spec: &str) -> Result<PathBuf, String> {
    let as_path = Path::new(spec);
    if as_path.is_absolute()
        || as_path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(spec.to_owned());
    }
    Ok(as_path.strip_prefix("src").unwrap_or(as_path).to_path_buf())
}
