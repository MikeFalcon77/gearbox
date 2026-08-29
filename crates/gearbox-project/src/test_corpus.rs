//! Finding the real gear tree, for the tests that project from it.
//!
//! Every locator here used to spell the corpus as
//! `$CARGO_MANIFEST_DIR/../../../gears-rust`, which is the sibling of the
//! *repository* root. From a git worktree -- `.claude/worktrees/<name>/crates/…`
//! -- that resolves to nothing, so every test that projects from real gears
//! skipped, printed a reason nobody reads, and the suite reported success having
//! exercised none of the corpus. An agent working in a worktree got that
//! silently, which is the whole problem: the skip was designed for a checkout
//! without the sibling repository, and it quietly covered a second case it was
//! never meant to.
//!
//! Walking up finds the corpus from either layout, and stops at the filesystem
//! root rather than guessing a depth.

use std::path::{Path, PathBuf};

/// The `gears-rust` checkout, if one is reachable from here.
///
/// Identified by containing a `gears/` directory, the same test the counted-`..`
/// version used -- so a stray directory of that name higher up is still not
/// mistaken for the corpus.
pub fn corpus_root() -> Option<PathBuf> {
    let mut dir: &Path = Path::new(env!("CARGO_MANIFEST_DIR"));
    loop {
        let candidate = dir.join("gears-rust");
        if candidate.join("gears").is_dir() {
            return candidate.canonicalize().ok();
        }
        dir = dir.parent()?;
    }
}

/// A path inside the corpus, canonicalized. `None` when the corpus is absent.
pub fn corpus(relative: &str) -> Option<PathBuf> {
    corpus_root()?.join(relative).canonicalize().ok()
}
