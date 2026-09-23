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

use std::path::{Path, PathBuf};

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
    /// Every attribute on that item, `#[toolkit::gear]` included.
    ///
    /// Carried because the facts a gear declares are spread across sibling
    /// attributes: `#[toolkit::provides]` states which transports *this
    /// provider* actually wires up, which is a different fact from which
    /// transports the contract could support.
    pub item_attrs: &'a [syn::Attribute],
    /// Whether a `mod` declaration on the way to this file carries a `#[cfg]`.
    ///
    /// Computed here rather than by the caller because it takes the whole
    /// scanned tree to answer: [`crate::scan::scan_crate`] discovers files by
    /// walking directories and never reads the `mod` declarations, so a gear in
    /// a file reached by `#[cfg(feature = "x")] mod gear;` carries no `cfg` of
    /// its own and would read as unconditional. That is precisely the claim
    /// [`crate::gear::ProjectedGear::conditional`] exists to avoid making.
    pub module_gated: bool,
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

/// Whether an attribute is one of ours, spelled `name`, `toolkit::name` or
/// `gears_toolkit::name`.
///
/// Mirrors `is_gears_module_path` in the macro crate: both spellings appear in
/// the wild, and matching only the qualified one would miss real gears.
///
/// One rule in one place. It used to be written out in four functions across
/// two modules, so a fifth spelling had to be added four times and a copy that
/// missed it made those facts read as absent rather than as an error. The idents
/// are compared in place: `all_sites` asks this of every attribute on every
/// struct and enum in the tree, doc comments included, so collecting the
/// segments into a `Vec<String>` first allocated far more than the number of
/// attributes that could ever match.
pub(crate) fn is_toolkit_attribute(attr: &syn::Attribute, name: &str) -> bool {
    let mut segments = attr.path().segments.iter();
    let Some(first) = segments.next() else {
        return false;
    };
    match (segments.next(), segments.next()) {
        (None, _) => first.ident == name,
        (Some(second), None) => {
            (first.ident == "toolkit" || first.ident == "gears_toolkit") && second.ident == name
        }
        _ => false,
    }
}

/// Whether an attribute's *last* segment is `name`, whatever qualifies it.
///
/// The looser sibling of [`is_toolkit_attribute`], and deliberately a second
/// rule rather than a divergence hiding in another module: the GTS attributes
/// are re-exported from `toolkit_gts`, and the tree writes
/// `#[toolkit_gts::gts_type_schema(..)]`, which the strict rule would read as
/// somebody else's attribute. Both rules live here so the difference is a
/// stated choice instead of two copies that drifted.
pub(crate) fn is_attribute_named(attr: &syn::Attribute, name: &str) -> bool {
    attr.path()
        .segments
        .last()
        .is_some_and(|segment| segment.ident == name)
}

fn is_gear_attribute(attr: &syn::Attribute) -> bool {
    is_toolkit_attribute(attr, "gear")
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
/// Every `#[toolkit::gear]` in a scanned crate.
///
/// Public because a crate with no `gear.gdl` still has to be searchable: GBX0208
/// asks "does any crate declare this gear", which cannot go through
/// [`locate_gear_attribute`] -- that one requires exactly one attribute and a
/// crate declaring three (`gears/mini-chat/mini-chat`) would come back as an
/// error rather than as three candidates.
#[must_use]
pub fn gear_attribute_sites(files: &[RustFile]) -> Vec<AttributeSite<'_>> {
    all_sites(files)
}

/// The files of a crate that belong to the gear whose attribute is at `site`.
///
/// One crate can declare several gears: `cf-gears-mini-chat` declares its host
/// and two plugins, each attribute in its own directory under
/// `src/infra/plugins/`. Read whole for each of them, the host finds three
/// config structs (GBX0112) and each plugin sees the other's trait impl.
///
/// A file belongs to the gear whose attribute sits in the deepest directory
/// enclosing it; a file no attribute directory encloses is visible to every
/// gear, which is what reading the whole crate already did. `None` means
/// nothing narrows -- one attribute directory, or this gear already owns every
/// file -- so the ordinary single-gear crate costs no copy.
#[must_use]
pub fn files_owned_by(files: &[RustFile], site: &Path) -> Option<Vec<RustFile>> {
    let dirs: std::collections::BTreeSet<PathBuf> = gear_attribute_sites(files)
        .iter()
        .map(|s| s.relative.parent().unwrap_or(Path::new("")).to_path_buf())
        .collect();
    if dirs.len() < 2 {
        return None;
    }
    let mine = site.parent().unwrap_or(Path::new(""));
    let owned: Vec<RustFile> = files
        .iter()
        .filter(|file| {
            dirs.iter()
                .filter(|d| file.relative.starts_with(d))
                .max_by_key(|d| d.components().count())
                .is_none_or(|d| d == mine)
        })
        .cloned()
        .collect();
    (owned.len() < files.len()).then_some(owned)
}

/// Whether any attribute in a list is a `cfg`.
///
/// A gear behind a feature gate is genuinely conditional, and the catalogue
/// cannot tell whether a given build enables it. Recording the fact is honest;
/// silently treating it as unconditional would make the catalogue claim more
/// than it knows.
pub(crate) fn has_cfg(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|a| a.path().is_ident("cfg"))
}

/// The module idents a scanned file sits under, outermost first.
///
/// `gear.rs` is `["gear"]`, `domain/mod.rs` is `["domain"]`, and
/// `domain/cluster.rs` is `["domain", "cluster"]`. The crate root itself is
/// under nothing, so `lib.rs` and `main.rs` yield an empty chain.
fn module_chain(relative: &std::path::Path) -> Vec<String> {
    let mut chain: Vec<String> = relative
        .parent()
        .into_iter()
        .flat_map(std::path::Path::components)
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => part.to_str().map(str::to_owned),
            _ => None,
        })
        .collect();
    match relative.file_stem().and_then(|stem| stem.to_str()) {
        // `mod.rs` *is* the module its directory names, so it adds nothing, and
        // a path with no stem names no module either.
        Some("mod") | None => {}
        // Only at the top is `lib.rs` the crate root; deeper down it is an
        // ordinary module that happens to be spelled that way.
        Some("lib" | "main") if chain.is_empty() => {}
        Some(stem) => chain.push(stem.to_owned()),
    }
    chain
}

/// The files that may declare `mod <name>;` for a module nested under `parents`.
///
/// Two candidates at every depth because both spellings are legal, and the
/// scan cannot know which one a crate chose.
fn declaring_files(parents: &[String]) -> Vec<PathBuf> {
    if parents.is_empty() {
        return vec![PathBuf::from("lib.rs"), PathBuf::from("main.rs")];
    }
    let dir: PathBuf = parents.iter().collect();
    let mut sibling = dir.clone().into_os_string();
    sibling.push(".rs");
    vec![PathBuf::from(sibling), dir.join("mod.rs")]
}

/// Whether a `mod` declaration on the path to `relative` carries a `#[cfg]`.
///
/// Read from the declaring file's top-level items only: reaching a file from a
/// `mod` nested inside an inline `mod` requires an explicit `#[path]`, which no
/// gear crate uses and which this scan does not follow anyway.
fn module_path_is_gated(files: &[RustFile], relative: &std::path::Path) -> bool {
    let chain = module_chain(relative);
    (0..chain.len()).any(|depth| {
        declaring_files(&chain[..depth]).iter().any(|candidate| {
            files
                .iter()
                .filter(|file| &file.relative == candidate)
                .any(|file| {
                    file.ast.items.iter().any(|item| match item {
                        syn::Item::Mod(module) => {
                            module.ident == chain[depth].as_str() && has_cfg(&module.attrs)
                        }
                        _ => false,
                    })
                })
        })
    })
}

fn all_sites(files: &[RustFile]) -> Vec<AttributeSite<'_>> {
    let mut sites = Vec::new();
    for file in files {
        let module_gated = module_path_is_gated(files, &file.relative);
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
                        item_attrs: attrs,
                        module_gated,
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
