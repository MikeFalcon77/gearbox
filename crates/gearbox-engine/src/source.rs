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
