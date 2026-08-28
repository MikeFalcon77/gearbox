//! Finding a gear's documents, by convention and by declaration.
//!
//! The platform keeps them at `gears/<name>/docs/`, while a `gear.gdl` sits in a
//! crate subdirectory one level below -- `gears/system/cluster/cluster/gear.gdl`
//! against `gears/system/cluster/docs/`. So the search looks beside the
//! description first and then in its parent, which covers 35 of 35 cases without
//! a line written in any description.
//!
//! A declared path always wins and is always checked: a hand-written path that
//! points nowhere is a typo (GBX0109). A file merely *not found* by convention is
//! not reported at all -- a gear may genuinely have no PRD, and warning about
//! that would put noise on 40 gears to catch nothing.

use std::path::{Path, PathBuf};

use gearbox_gdl::GearDecl;
use gearbox_gdl::engine::FileIdentity;
use gearbox_ir::{Diagnostic, DiagnosticCode, Diagnostics, GearDocs, Location, RelPath};

/// The `OpenAPI` locations that actually occur in the platform.
///
/// Two shapes, both real: `docs/openapi.json` (mini-chat) and
/// `docs/api/openapi.yaml` (credstore). Only four gears of about forty check one
/// in at all -- the rest build the spec at runtime from their REST projections --
/// so absence here is the ordinary answer.
const OPENAPI_CANDIDATES: &[&str] = &[
    "docs/openapi.json",
    "docs/openapi.yaml",
    "docs/api/openapi.json",
    "docs/api/openapi.yaml",
];

/// Locate this gear's documents.
///
/// `gdl_dir` is the absolute directory holding the description; `root` is the
/// source root every returned path is made relative to.
pub fn project(
    root: &Path,
    gdl_dir: &Path,
    identity: &FileIdentity,
    decl: &GearDecl,
    diagnostics: &mut Diagnostics,
) -> Option<GearDocs> {
    let uri = identity.uri.as_str();
    let declared = decl.docs.as_ref();

    // Beside the description, then one level up. Order matters: a gear that
    // keeps its own `docs/` should not be shadowed by the family's.
    let mut bases = vec![gdl_dir.to_path_buf()];
    if let Some(parent) = gdl_dir.parent().filter(|p| is_own_family(p, gdl_dir)) {
        bases.push(parent.to_path_buf());
    }

    let docs = GearDocs {
        prd: resolve_one(
            root,
            gdl_dir,
            &bases,
            declared.and_then(|d| d.prd.as_deref()),
            &["docs/PRD.md"],
            uri,
            diagnostics,
        ),
        design: resolve_one(
            root,
            gdl_dir,
            &bases,
            declared.and_then(|d| d.design.as_deref()),
            &["docs/DESIGN.md"],
            uri,
            diagnostics,
        ),
        adr: resolve_adr(root, gdl_dir, &bases, declared, uri, diagnostics),
        openapi: resolve_one(
            root,
            gdl_dir,
            &bases,
            declared.and_then(|d| d.openapi.as_deref()),
            OPENAPI_CANDIDATES,
            uri,
            diagnostics,
        ),
    };

    (!docs.is_empty()).then_some(docs)
}

/// Whether `parent` is this gear's own family directory rather than a bucket of
/// unrelated gears.
///
/// The guard matters because the climb is what makes the convention work at all:
/// `gears/system/cluster/cluster/gear.gdl` needs `gears/system/cluster/docs/`.
/// But `gears/system/api-gateway/gear.gdl` has `gears/system/` as its parent,
/// and a `gears/system/docs/` would then be claimed by whichever gear asked
/// first. No such directory exists today; this keeps it from becoming a silent
/// mis-attribution if one appears.
///
/// The test is structural: a family directory holds exactly one gear, so if any
/// *sibling* directory also holds a `gear.gdl`, the parent is a bucket.
fn is_own_family(parent: &Path, gdl_dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return false;
    };
    !entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .any(|p| p.is_dir() && p != gdl_dir && p.join(crate::catalogue::GEAR_FILE).is_file())
}

/// A declared path if given, else the first candidate that exists.
fn resolve_one(
    root: &Path,
    gdl_dir: &Path,
    bases: &[PathBuf],
    declared: Option<&str>,
    candidates: &[&str],
    uri: &str,
    diagnostics: &mut Diagnostics,
) -> Option<RelPath> {
    if let Some(declared) = declared {
        let absolute = gdl_dir.join(declared);
        if absolute.is_file() {
            return relative_to(root, &absolute);
        }
        diagnostics.push(
            Diagnostic::error(
                DiagnosticCode::GdlMissingDocPath,
                format!("`docs(... = \"{declared}\")` points at no file"),
                "the path is relative to the description's own directory; drop the field to \
                 let the `docs/` convention find it",
            )
            .at(Location::file(uri.to_owned())),
        );
        return None;
    }

    bases
        .iter()
        .flat_map(|base| candidates.iter().map(move |c| base.join(c)))
        .find(|p| p.is_file())
        .and_then(|p| relative_to(root, &p))
}

/// Declared ADR paths, else every `*.md` in the first `docs/ADR/` found.
fn resolve_adr(
    root: &Path,
    gdl_dir: &Path,
    bases: &[PathBuf],
    declared: Option<&gearbox_gdl::records::DocsRecord>,
    uri: &str,
    diagnostics: &mut Diagnostics,
) -> Vec<RelPath> {
    if let Some(paths) = declared.map(|d| &d.adr).filter(|a| !a.is_empty()) {
        let mut out = Vec::new();
        for declared in paths {
            let absolute = gdl_dir.join(declared);
            if absolute.is_file() {
                out.extend(relative_to(root, &absolute));
            } else {
                diagnostics.push(
                    Diagnostic::error(
                        DiagnosticCode::GdlMissingDocPath,
                        format!("`docs(adr = [\"{declared}\"])` points at no file"),
                        "the path is relative to the description's own directory",
                    )
                    .at(Location::file(uri.to_owned())),
                );
            }
        }
        return out;
    }

    let Some(dir) = bases
        .iter()
        .map(|b| b.join("docs/ADR"))
        .find(|p| p.is_dir())
    else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "md"))
        .collect();
    // Sorted so the catalogue is byte-identical across runs.
    found.sort();
    found.iter().filter_map(|p| relative_to(root, p)).collect()
}

/// Make an absolute path relative to the source root, forward-slashed.
///
/// Returns `None` when the file sits outside the root, which a `docs(...)`
/// climbing out of the tree could do. Silently dropping is right here: the path
/// exists, so it is not the typo GBX0109 reports, and a lock cannot carry it.
fn relative_to(root: &Path, absolute: &Path) -> Option<RelPath> {
    let canonical = absolute.canonicalize().ok()?;
    let relative = canonical.strip_prefix(root).ok()?;
    let text = relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    RelPath::new(text).ok()
}
