//! Path arithmetic the generated manifests depend on.
//!
//! Pure: these functions compare path *components*, they never ask the
//! filesystem anything. That matters because the generated tree does not exist
//! yet when the relative dependency paths inside it are computed.

use std::path::{Component, Path, PathBuf};

use gearbox_ir::RelPath;

use super::GenerateError;

/// `target` expressed relative to `from`, both absolute.
///
/// Returns `None` when no relative path exists -- different Windows drive
/// prefixes, or either side not absolute. The caller then has to fall back to an
/// absolute path rather than emit `../..` guesswork that resolves somewhere
/// unrelated.
///
/// Written out rather than taken from a crate: the only candidates
/// (`pathdiff`, `relative-path`) each add a dependency to this workspace for
/// twenty lines, and the semantics of the fallback -- which is the part that
/// actually matters here -- would still be ours to decide.
pub fn relative(from: &Path, target: &Path) -> Option<PathBuf> {
    if !from.is_absolute() || !target.is_absolute() {
        return None;
    }

    let mut from_parts = from.components().peekable();
    let mut target_parts = target.components().peekable();

    // The prefix and root must agree, or the two paths are in different
    // filesystems and no number of `..` connects them.
    while let (Some(a), Some(b)) = (from_parts.peek(), target_parts.peek()) {
        if a != b {
            break;
        }
        if matches!(a, Component::Prefix(_) | Component::RootDir) {
            // Consumed as part of the shared root; keep going.
        }
        from_parts.next();
        target_parts.next();
    }

    let mut out = PathBuf::new();
    for component in from_parts {
        match component {
            Component::Normal(_) => out.push(".."),
            // A `..` still in an absolute path means the caller handed us a
            // path it never canonicalized. Refusing beats emitting a relative
            // path that is wrong in a way nothing will notice until `cargo
            // build` looks for a directory that is not there.
            Component::ParentDir => return None,
            Component::CurDir | Component::Prefix(_) | Component::RootDir => {}
        }
    }
    for component in target_parts {
        out.push(component);
    }

    if out.as_os_str().is_empty() {
        out.push(".");
    }
    Some(out)
}

/// A path inside the generated tree, as a `RelPath`.
///
/// Always `/`-separated, whatever the host: the generated manifests and the
/// `FilePlan` a client renders are the same text on every platform, and a
/// backslash in a Cargo `path =` is not portable.
///
/// # Errors
/// Returns [`GenerateError::BadPath`] when the joined path is not a valid
/// relative path -- which for a generator means a process name that escaped
/// validation, so it is a refusal rather than a sanitization.
pub fn rel(parts: &[&str]) -> Result<RelPath, GenerateError> {
    let joined = parts.join("/");
    RelPath::new(&joined).map_err(|_| GenerateError::BadPath { path: joined })
}

/// A slash-separated rendering of `path`, for a Cargo manifest.
///
/// `Path::display` would emit backslashes on Windows, and Cargo accepts them,
/// but the generated file would then differ byte for byte between two machines
/// generating from the same lock -- which is exactly the determinism the lock
/// hash exists to guarantee.
pub fn to_slash(path: &Path) -> String {
    path.components()
        .map(|c| match c {
            Component::Normal(part) => part.to_string_lossy().into_owned(),
            Component::ParentDir => "..".to_owned(),
            Component::CurDir => ".".to_owned(),
            // The root's own component contributes nothing but the separator
            // `join` puts in front of the next one.
            Component::RootDir => String::new(),
            Component::Prefix(prefix) => prefix.as_os_str().to_string_lossy().into_owned(),
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_walks_up_then_down() {
        let from = Path::new("/a/b/c/d");
        let target = Path::new("/a/x/y");
        assert_eq!(relative(from, target), Some(PathBuf::from("../../../x/y")));
    }

    #[test]
    fn relative_to_self_is_dot() {
        let path = Path::new("/a/b");
        assert_eq!(relative(path, path), Some(PathBuf::from(".")));
    }

    #[test]
    fn relative_refuses_a_relative_input() {
        assert!(relative(Path::new("a/b"), Path::new("/a")).is_none());
        assert!(relative(Path::new("/a"), Path::new("a/b")).is_none());
    }

    #[test]
    fn relative_refuses_an_uncanonicalized_from() {
        // `/a/b/../c` and `/a/c` are the same directory, but only after the
        // filesystem is consulted -- and this function may not consult it.
        assert!(relative(Path::new("/a/b/../c"), Path::new("/a/d")).is_none());
    }

    #[test]
    fn to_slash_never_emits_a_backslash() {
        let rendered = to_slash(Path::new("../../gears-rust/libs/toolkit"));
        assert_eq!(rendered, "../../gears-rust/libs/toolkit");
        assert!(!rendered.contains('\\'));
    }

    #[test]
    fn rel_refuses_an_escaping_component() {
        // `RelPath` rejects `..`; the generator must never produce a path that
        // writes outside the output root (GBX0702's condition).
        assert!(rel(&["..", "escape"]).is_err());
    }
}
