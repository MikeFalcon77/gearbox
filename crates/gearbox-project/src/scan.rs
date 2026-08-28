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
    Parse(PathBuf, #[source] syn::Error),

    /// A `src/` that is a symlink, or a directory under it that could not be
    /// walked.
    ///
    /// Separate from [`ScanError::Read`] because the remedy is different: a read
    /// failure is about one file, this is about the shape of the tree.
    #[error("cannot walk `{}`", .0.display())]
    Walk(PathBuf, String),
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
/// Returns [`ScanError`] when `src/` is absent or a symlink, a directory under
/// it cannot be walked, a file cannot be read, or a file is not valid Rust.
pub fn scan_crate(crate_dir: &Path) -> Result<Vec<RustFile>, ScanError> {
    let src = crate_dir.join("src");
    // `symlink_metadata` rather than `is_dir`, which follows the link: a
    // symlinked `src/` would let a description reach a tree outside its own
    // source root, and `follow_links(false)` does not cover the *root* of the
    // walk (walkdir's `follow_root_links` defaults to true).
    match std::fs::symlink_metadata(&src) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(ScanError::Walk(
                src,
                "src/ is a symlink; a crate may only be read through a real directory inside \
                 its source root"
                    .to_owned(),
            ));
        }
        Ok(meta) if meta.is_dir() => {}
        _ => return Err(ScanError::NoSrc(crate_dir.to_path_buf())),
    }

    // Walk errors are *not* dropped. An unreadable subdirectory would otherwise
    // yield `Ok` with a short file list, and the projection would then report
    // the contracts and gears in it as absent -- a permission problem wearing
    // the costume of a description mistake.
    let mut paths: Vec<PathBuf> = Vec::new();
    for entry in walkdir::WalkDir::new(&src)
        .follow_links(false)
        .follow_root_links(false)
    {
        let entry = entry.map_err(|e| {
            let at = e.path().unwrap_or(&src).to_path_buf();
            ScanError::Walk(at, e.to_string())
        })?;
        if entry.file_type().is_file() && entry.path().extension().is_some_and(|x| x == "rs") {
            paths.push(entry.into_path());
        }
    }
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
