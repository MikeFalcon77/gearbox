//! Locating a gear's `#[toolkit::gear]` attribute.
//!
//! The attribute's location is not uniform: of the 44 in `gears-rust`, 34 sit
//! at `src/gear.rs`, 8 at `src/module.rs`, and the rest deeper. A fixed
//! filename would be wrong for a quarter of them.
//!
//! More importantly one crate may declare several gears -- `gears/mini-chat/mini-chat`
//! declares three -- so scanning alone is not always enough, and a description
//! may narrow with `package = cargo(..., attr = "src/...")`. Projection is
//! meaningless until exactly one attribute is identified, so zero matches and
//! several matches are both errors rather than guesses
//! (`cpt-gearbox-fr-attribute-location`).

use std::path::PathBuf;

use crate::scan::RustFile;

/// One `#[toolkit::gear]` found in a crate.
pub struct AttributeSite<'a> {
    /// Path relative to the crate's `src/`, which is what `attr` narrows on.
    pub relative: PathBuf,
    /// 1-based line, for a diagnostic a human will read.
    pub line: usize,
    /// The attribute itself.
    pub attr: &'a syn::Attribute,
    /// The item it is attached to -- the struct whose kebab-case identifier
    /// `#[toolkit::consumes]` derives its config key from.
    pub struct_ident: String,
}

// Hand-written rather than derived: deriving would dump the attribute's whole
// token stream, which is noise in a test failure. The location and the item are
// what identify a site.
impl std::fmt::Debug for AttributeSite<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AttributeSite")
            .field("relative", &self.relative)
            .field("line", &self.line)
            .field("struct_ident", &self.struct_ident)
            .finish_non_exhaustive()
    }
}

/// Why an attribute could not be located.
#[derive(Debug, thiserror::Error)]
pub enum LocateError {
    #[error("no #[toolkit::gear] attribute found in `{scanned}`")]
    NotFound { scanned: String },

    #[error(
        "`{scanned}` declares {} gears; narrow the description with `attr = \"...\"`. Candidates: {}",
        candidates.len(),
        candidates.join(", ")
    )]
    Ambiguous {
        scanned: String,
        candidates: Vec<String>,
    },

    #[error("`attr = \"{0}\"` escapes the crate root")]
    AttrEscapes(String),
}

/// Whether an attribute path is `gear` or `toolkit::gear`.
///
/// Mirrors `is_gears_module_path` in the macro crate: both spellings appear in
/// the wild, and matching only the qualified one would miss real gears.
fn is_gear_attribute(attr: &syn::Attribute) -> bool {
    let segments: Vec<String> = attr
        .path()
        .segments
        .iter()
        .map(|s| s.ident.to_string())
        .collect();
    match segments.as_slice() {
        [one] => one == "gear",
        [first, second] => (first == "toolkit" || first == "gears_toolkit") && second == "gear",
        _ => false,
    }
}

/// The identifier of the item an attribute is attached to.
fn item_ident(item: &syn::Item) -> Option<String> {
    match item {
        syn::Item::Struct(s) => Some(s.ident.to_string()),
        syn::Item::Enum(e) => Some(e.ident.to_string()),
        _ => None,
    }
}

/// Every `#[toolkit::gear]` in `files`, in scan order.
fn all_sites(files: &[RustFile]) -> Vec<AttributeSite<'_>> {
    let mut sites = Vec::new();
    for file in files {
        for item in &file.ast.items {
            let attrs = match item {
                syn::Item::Struct(s) => &s.attrs,
                syn::Item::Enum(e) => &e.attrs,
                _ => continue,
            };
            for attr in attrs {
                if is_gear_attribute(attr) {
                    sites.push(AttributeSite {
                        relative: file.relative.clone(),
                        // proc-macro2 reports 1-based lines with the
                        // span-locations feature, which is what a reader wants.
                        line: attr.path().segments[0].ident.span().start().line,
                        attr,
                        struct_ident: item_ident(item).unwrap_or_default(),
                    });
                }
            }
        }
    }
    sites
}

/// Find the one `#[toolkit::gear]` this description refers to.
///
/// `attr` narrows the search to a single file, relative to the crate root (so
/// `src/gear.rs`, not `gear.rs`). Omitting it means "scan the whole tree and
/// require exactly one".
///
/// # Errors
/// Returns [`LocateError`] when the scan yields zero or several attributes, or
/// when `attr` escapes the crate root.
pub fn locate_gear_attribute<'a>(
    files: &'a [RustFile],
    crate_label: &str,
    attr: Option<&str>,
) -> Result<AttributeSite<'a>, LocateError> {
    let narrowed: Option<PathBuf> = match attr {
        Some(spec) => Some(crate::scan::narrowing_path(spec).map_err(LocateError::AttrEscapes)?),
        None => None,
    };

    let scanned = match attr {
        Some(spec) => format!("{crate_label} ({spec})"),
        None => format!("{crate_label} (src/)"),
    };

    let mut sites = all_sites(files);
    if let Some(want) = &narrowed {
        sites.retain(|s| &s.relative == want);
    }

    match sites.len() {
        0 => Err(LocateError::NotFound { scanned }),
        1 => Ok(sites.remove(0)),
        _ => {
            let candidates = sites
                .iter()
                .map(|s| format!("src/{} ({})", s.relative.display(), s.struct_ident))
                .collect();
            Err(LocateError::Ambiguous {
                scanned,
                candidates,
            })
        }
    }
}
