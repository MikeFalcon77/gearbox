//! Projecting the GTS types a gear exposes.
//!
//! The rules are not invented here. `gears-rust/tools/gts-analyze` already
//! defines them, and its README is the normative statement: a type is *defined*
//! by a `#[gts_type_schema]` attribute on a struct, by a `*.schema.json` whose
//! `$id` is a GTS identifier, or by the `struct_to_gts_schema!` macro. Reusing
//! that list rather than writing a fourth rule is the point -- two tools
//! disagreeing about what counts as a GTS type would be worse than either.
//!
//! The distinction that carries the weight is **defined** versus **referenced**.
//! `gts_id!` appears over a thousand times in the tree, overwhelmingly as a
//! reference and often in tests; none of those is a declaration. "Which types
//! does this gear expose" means the ones declared in its SDK crate, because that
//! is what another gear can depend on.

use crate::scan::RustFile;

/// A GTS type declared in a scanned crate.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct GtsType {
    /// The identifier, e.g. `cf.toolkit.plugins.plugin.v1~cf.core.cluster.plugin.v1~`.
    pub type_id: String,
    pub description: Option<String>,
    /// Where it was declared, relative to the crate's `src/` (or its root, for a
    /// JSON schema).
    pub relative: String,
}

/// Why a GTS declaration could not be read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GtsError {
    #[error(
        "`struct_to_gts_schema!` in {relative} is not supported yet; no crate in gears-rust \
         uses it, so support would have no live example to check against"
    )]
    UnsupportedMacro { relative: String },

    #[error("`#[gts_type_schema]` in {relative} has no readable `type_id`")]
    UnreadableTypeId { relative: String },

    #[error("schema `{relative}` is not valid JSON: {message}")]
    InvalidJson { relative: String, message: String },
}

/// Whether an attribute is `gts_type_schema`, however it is qualified.
///
/// By last segment, and through the shared helper in [`crate::attribute`] so
/// the rule is not a fifth private copy: the tree writes
/// `#[toolkit_gts::gts_type_schema(..)]`, which the stricter
/// `toolkit::`/`gears_toolkit::` rule the gear and contract attributes use
/// would read as somebody else's attribute.
fn is_schema_attribute(attr: &syn::Attribute) -> bool {
    crate::attribute::is_attribute_named(attr, "gts_type_schema")
}

/// Unwrap `gts_id!("...")`, or a plain string literal.
///
/// The tree writes `type_id = gts_id!("cf...")`, where the macro validates the
/// identifier at compile time. Reading the literal inside is what makes the
/// projected id the same string the compiler checked.
fn gts_literal(expr: &syn::Expr) -> Option<String> {
    match expr {
        syn::Expr::Lit(syn::ExprLit {
            lit: syn::Lit::Str(s),
            ..
        }) => Some(s.value()),
        syn::Expr::Macro(mac) => {
            let name = mac.mac.path.segments.last()?.ident.to_string();
            if name != "gts_id" && name != "gts_uri" {
                return None;
            }
            // The macro body is a single string literal.
            syn::parse2::<syn::LitStr>(mac.mac.tokens.clone())
                .ok()
                .map(|l| l.value())
        }
        _ => None,
    }
}

/// Every GTS type declared by `#[gts_type_schema]` in a scanned crate.
///
/// # Errors
/// Returns [`GtsError`] for a declaration it cannot read, rather than skipping
/// it. A silently dropped type would make a gear look like it exposes less than
/// it does, which is the kind of wrong answer that only shows up much later.
pub fn project_gts_types(files: &[RustFile]) -> Result<Vec<GtsType>, GtsError> {
    let mut out = Vec::new();

    for file in files {
        let relative = file.relative.display().to_string();

        for item in &file.ast.items {
            let attrs = match item {
                syn::Item::Struct(s) => &s.attrs,
                syn::Item::Enum(e) => &e.attrs,
                _ => continue,
            };
            for attr in attrs.iter().filter(|a| is_schema_attribute(a)) {
                let mut type_id = None;
                let mut description = None;

                // Errors from shapes this does not model are swallowed here and
                // turned into `UnreadableTypeId` below, so the message names the
                // file rather than a token position inside a macro argument.
                drop(attr.parse_nested_meta(|meta| {
                    let key = meta
                        .path
                        .segments
                        .last()
                        .map(|s| s.ident.to_string())
                        .unwrap_or_default();
                    if let Ok(value) = meta.value()
                        && let Ok(expr) = value.parse::<syn::Expr>()
                    {
                        match key.as_str() {
                            "type_id" => type_id = gts_literal(&expr),
                            "description" => description = gts_literal(&expr),
                            _ => {}
                        }
                    }
                    Ok(())
                }));

                let type_id = type_id.ok_or_else(|| GtsError::UnreadableTypeId {
                    relative: relative.clone(),
                })?;
                out.push(GtsType {
                    type_id,
                    description,
                    relative: relative.clone(),
                });
            }
        }

        // Reported rather than ignored: see `GtsError::UnsupportedMacro`.
        if file_uses_unsupported_macro(file) {
            return Err(GtsError::UnsupportedMacro { relative });
        }
    }

    out.sort();
    out.dedup();
    Ok(out)
}

/// Whether the file invokes `struct_to_gts_schema!` anywhere.
///
/// `syn::Visit` does not descend into `mac.tokens`, so a nested
/// `struct_to_gts_schema!(...)` inside another macro would be invisible on
/// path alone. Scanning those tokens (not the whole file text) still sees the
/// nested call without treating a mention in a comment or string as a
/// declaration.
fn file_uses_unsupported_macro(file: &RustFile) -> bool {
    /// Whether a token stream mentions the macro's ident anywhere, nesting
    /// included.
    ///
    /// Walked as tokens rather than rendered with `to_string()`: the arm runs
    /// for every macro that is *not* `struct_to_gts_schema`, which is every
    /// macro in the crate, and `gts_id!` alone appears over a thousand times in
    /// the tree -- so formatting each whole token stream to answer one ident
    /// test was the bulk of the work per scanned crate.
    fn mentions(tokens: &proc_macro2::TokenStream) -> bool {
        tokens.clone().into_iter().any(|token| match token {
            proc_macro2::TokenTree::Ident(ident) => ident == "struct_to_gts_schema",
            proc_macro2::TokenTree::Group(group) => mentions(&group.stream()),
            _ => false,
        })
    }

    struct Finder(bool);
    impl<'ast> syn::visit::Visit<'ast> for Finder {
        fn visit_macro(&mut self, mac: &'ast syn::Macro) {
            if mac
                .path
                .segments
                .last()
                .is_some_and(|s| s.ident == "struct_to_gts_schema")
                || mentions(&mac.tokens)
            {
                self.0 = true;
            }
            syn::visit::visit_macro(self, mac);
        }
    }
    let mut finder = Finder(false);
    syn::visit::Visit::visit_file(&mut finder, &file.ast);
    finder.0
}

/// The longest identifier the `gts-id` grammar admits.
const MAX_TYPE_ID_LEN: usize = 1024;

/// Whether a string is a GTS identifier by charset, structure and length.
///
/// The grammar `gts_id!` enforces through `gts-id`: chain segments separated by
/// `~`, each a `.`-separated list of tokens that start with `[a-z_]` and
/// continue with `[a-z0-9_]`, plus the bare numeric token a minor version is
/// written as (`...v1.0`). Lowercase throughout, no `-`, no empty segment, and
/// at most [`MAX_TYPE_ID_LEN`] characters.
///
/// A structural check rather than a call into `gts-id`: this crate parses trees
/// it does not build, and taking a dependency on the runtime's id crate to read
/// a JSON field would tie the projector's version to the corpus's.
fn is_gts_identifier(id: &str) -> bool {
    if id.is_empty() || id.len() > MAX_TYPE_ID_LEN {
        return false;
    }
    // A trailing `~` marks the last segment as a type and leaves nothing after
    // it; a `~` anywhere else separates two segments and both must be there.
    let body = id.strip_suffix('~').unwrap_or(id);
    !body.is_empty()
        && body
            .split('~')
            .all(|segment| !segment.is_empty() && segment.split('.').all(is_id_token))
}

fn is_id_token(token: &str) -> bool {
    let mut chars = token.chars();
    match chars.next() {
        // The minor version is a bare number, so a token of digits is legal
        // where a name would not be.
        Some(c) if c.is_ascii_digit() => token.chars().all(|c| c.is_ascii_digit()),
        Some(c) if c.is_ascii_lowercase() || c == '_' => {
            chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        }
        _ => false,
    }
}

/// A GTS type declared by a JSON schema file.
///
/// Separate from the Rust pass because `scan_crate` reads only `.rs`. Takes the
/// already-read text so the caller owns the I/O and this stays testable from a
/// literal.
/// # Errors
/// Returns [`GtsError::InvalidJson`] when `text` is not JSON. A schema that
/// parses but is not a GTS id is `Ok(None)`, not an error.
pub fn gts_type_from_schema(relative: &str, text: &str) -> Result<Option<GtsType>, GtsError> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| GtsError::InvalidJson {
            relative: relative.to_owned(),
            message: e.to_string(),
        })?;
    let Some(id) = value.get("$id").and_then(serde_json::Value::as_str) else {
        return Ok(None);
    };
    // `gts-analyze` accepts both spellings.
    let type_id = id.strip_prefix("gts://").unwrap_or(id);
    if !type_id.starts_with("gts.") && !type_id.starts_with("cf.") {
        return Ok(None);
    }
    // The prefix alone used to be the whole check, so everything after it went
    // verbatim into `GtsType::type_id` and on into `gearbox_ir::GtsTypeDecl`,
    // which does not validate it either. The Rust path gets `gts_id!`'s
    // compile-time check; a `$id` read out of an arbitrary `.schema.json` gets
    // this one, so the two identifier sources are held to the same grammar.
    if !is_gts_identifier(type_id) {
        return Ok(None);
    }
    Ok(Some(GtsType {
        type_id: type_id.to_owned(),
        description: value
            .get("description")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        relative: relative.to_owned(),
    }))
}

#[cfg(test)]
#[path = "gts_tests.rs"]
mod gts_tests;
