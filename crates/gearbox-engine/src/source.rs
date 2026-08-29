//! A declared source, resolved to a directory on disk.

use std::path::{Path, PathBuf};

use gearbox_ir::{ResolvedSource, SourceId, SourceKind};

/// Why a source root could not be opened.
#[derive(Debug, thiserror::Error)]
pub enum SourceRootError {
    #[error("source root `{}` does not exist", .0.display())]
    Missing(PathBuf),

    #[error("source root `{}` is not a directory", .0.display())]
    NotADirectory(PathBuf),

    #[error("cannot canonicalize source root `{}`", .0.display())]
    Canonicalize(PathBuf, #[source] std::io::Error),
}

/// Default ids for a set of source roots, in the order given.
///
/// The rule is the directory's own name, lowercased -- what a reader would guess
/// and what both the CLI and the RPC server have always used. What is added here
/// is that the *set* is made distinct: a repeat is suffixed `-2`, `-3`, matching
/// the convention [`gearbox_ir::ProcessId`] already documents for the same
/// problem.
///
/// Distinctness is not cosmetic. `~/a/gears` and `~/b/gears` are both `gears`,
/// which is the arrangement anyone keeping two checkouts side by side ends up
/// with, and the id is an identity: it is half the client's row key, and it is
/// what a `product.gdl` names in `sources`. Two roots sharing one id and the same
/// relative layout meant the second root's gears silently replaced the first's --
/// one tree, half the gears, and paths resolved against whichever root was
/// reported last, with no diagnostic anywhere.
///
/// Suffixed rather than refused, because a duplicate basename is a legitimate
/// layout and failing the second root would take a working setup away to enforce
/// a naming rule nobody agreed to.
///
/// Note that an id which is not valid kebab-case is returned unchanged: rejecting
/// it is [`SourceId`]'s job, and doing it here as well would mean two places that
/// have to agree on what a valid id is.
#[must_use]
pub fn default_source_ids(paths: &[impl AsRef<Path>]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::with_capacity(paths.len());
    for path in paths {
        let base = default_source_id(path.as_ref());
        let mut candidate = base.clone();
        let mut nth = 1_u32;
        while ids.contains(&candidate) {
            nth += 1;
            candidate = format!("{base}-{nth}");
        }
        ids.push(candidate);
    }
    ids
}

/// The directory's own name, lowercased, or `local` when it has none.
///
/// `local` rather than an error for the case a path has no final component at
/// all -- `/`, or a relative path that canonicalizes to nothing usable. It is a
/// last resort, not a default anyone should meet.
fn default_source_id(path: &Path) -> String {
    path.canonicalize()
        .ok()
        .as_deref()
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().to_lowercase())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "local".to_owned())
}

/// A source root: an id, and the directory its `gear.gdl` paths are relative to.
#[derive(Debug, Clone)]
pub struct SourceRoot {
    pub id: SourceId,
    /// Canonicalized, so every discovered path can be made relative to it
    /// without `..` ambiguity.
    pub root: PathBuf,
    /// The location as the operator wrote it, preserved for the lock.
    pub declared_location: String,
}

impl SourceRoot {
    /// Open `path` as the root of source `id`.
    ///
    /// # Errors
    /// Returns [`SourceRootError`] if the path is missing, is not a directory,
    /// or cannot be canonicalized.
    pub fn open(id: SourceId, path: impl AsRef<Path>) -> Result<Self, SourceRootError> {
        let path = path.as_ref();
        let declared_location = path.display().to_string();

        if !path.exists() {
            return Err(SourceRootError::Missing(path.to_path_buf()));
        }
        if !path.is_dir() {
            return Err(SourceRootError::NotADirectory(path.to_path_buf()));
        }
        let root = path
            .canonicalize()
            .map_err(|e| SourceRootError::Canonicalize(path.to_path_buf(), e))?;

        Ok(Self {
            id,
            root,
            declared_location,
        })
    }

    /// The `ResolvedSource` this root becomes in a catalogue or lock.
    ///
    /// The digest is left as `path:<location>` for now. A real content or commit
    /// digest is what makes a lock reproducible rather than merely repeatable,
    /// and it belongs with the resolver that writes the lock -- recording a
    /// fake one here would be worse than recording an obviously provisional one.
    #[must_use]
    pub fn to_resolved(&self) -> ResolvedSource {
        ResolvedSource {
            id: self.id.clone(),
            kind: SourceKind::Path,
            location: self.declared_location.clone(),
            digest: format!("path:{}", self.declared_location),
        }
    }
}
