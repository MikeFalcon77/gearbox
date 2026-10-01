//! Projecting the error enums a diagnostic can point at.
//!
//! `DiagnosticCode::prevents` names a `gears-rust` runtime error as
//! `(package, enum, variant)`, optionally with the frozen
//! `(error_domain, error_code)` pair it travels under. This is the half that
//! reads the other repository, so a reference can be resolved rather than
//! believed.
//!
//! The attribute grammar is not invented here. It is the one
//! `#[derive(ContractError)]` parses, in
//! `libs/toolkit-contract-macros/src/contract_error.rs`: `#[error_domain("...")]`
//! on the enum as the default, overridable per variant; `#[error_code("...")]`
//! per variant; `#[canonical(Category)]` per variant. Recorded, never
//! interpreted -- deciding what a category *means* is the platform's business.
//!
//! Two choices worth stating, because both look like omissions:
//!
//! **No name filtering.** Every `enum` is projected, not the ones whose names
//! look like errors. The only consumer looks up an exact identifier, so a
//! filter could never help and could silently lose one.
//!
//! **Inline `mod` blocks are walked.** The sibling projectors iterate
//! `file.ast.items` and stop there, which is right for them. Here it would mean
//! a nested enum reads as absent, and absent is a *failure* in the consuming
//! check -- so the one shape that produces a spurious red is the shape to
//! handle. Still a directory walk rather than a `mod`-tree walk from `lib.rs`,
//! for the reason [`crate::scan`] gives.

use std::path::PathBuf;

use crate::scan::RustFile;

/// One `enum` declared somewhere under a crate's `src/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedErrorEnum {
    /// The enum's identifier, e.g. `RegistryError`.
    pub ident: String,
    /// The inline-`mod` path containing it, outermost first. Empty at file level.
    pub module: Vec<String>,
    /// Path relative to the crate's `src/`, which is what a message should show.
    pub relative: PathBuf,
    /// 1-based, matching every editor.
    pub line: usize,
    /// `#[error_domain("...")]` on the enum: the per-variant default.
    pub domain: Option<String>,
    /// Whether the enum carries `#[derive(ContractError)]`.
    ///
    /// Recorded for the sake of the failure message rather than for the lookup:
    /// "the enum lost its derive" and "the variant lost its code" are different
    /// breaks and deserve different sentences.
    pub derives_contract_error: bool,
    pub variants: Vec<ProjectedErrorVariant>,
}

/// One variant of a projected enum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedErrorVariant {
    pub ident: String,
    /// 1-based.
    pub line: usize,
    /// `#[error_code("...")]`.
    pub code: Option<String>,
    /// The variant's own `#[error_domain("...")]`, else the enum's.
    pub domain: Option<String>,
    /// `#[canonical(Category)]`, as written. Recorded, not interpreted.
    pub canonical_category: Option<String>,
}

/// Project every `enum` under a crate's `src/`.
///
/// Sorted by identifier and then by line, so two enums of one name in one crate
/// -- which is legal and which the consumer must refuse rather than guess at --
/// arrive in a stable order.
#[must_use]
pub fn project_error_enums(files: &[RustFile]) -> Vec<ProjectedErrorEnum> {
    let mut out = Vec::new();
    for file in files {
        collect(&file.ast.items, &mut Vec::new(), file, &mut out);
    }
    out.sort_by(|a, b| {
        a.ident
            .cmp(&b.ident)
            .then_with(|| a.relative.cmp(&b.relative))
            .then_with(|| a.line.cmp(&b.line))
    });
    out
}

/// Walk one item list, descending into inline `mod` blocks.
fn collect(
    items: &[syn::Item],
    module: &mut Vec<String>,
    file: &RustFile,
    out: &mut Vec<ProjectedErrorEnum>,
) {
    for item in items {
        match item {
            syn::Item::Enum(item) => out.push(project_enum(item, module, file)),
            // `content` is `None` for `mod foo;`, whose body is a separate file
            // the directory walk reaches on its own.
            syn::Item::Mod(item) => {
                if let Some((_, inner)) = &item.content {
                    module.push(item.ident.to_string());
                    collect(inner, module, file, out);
                    module.pop();
                }
            }
            _ => {}
        }
    }
}

fn project_enum(item: &syn::ItemEnum, module: &[String], file: &RustFile) -> ProjectedErrorEnum {
    let domain = string_attr(&item.attrs, "error_domain");
    let variants = item
        .variants
        .iter()
        .map(|variant| ProjectedErrorVariant {
            ident: variant.ident.to_string(),
            line: variant.ident.span().start().line,
            code: string_attr(&variant.attrs, "error_code"),
            domain: string_attr(&variant.attrs, "error_domain").or_else(|| domain.clone()),
            canonical_category: ident_attr(&variant.attrs, "canonical"),
        })
        .collect();
    ProjectedErrorEnum {
        ident: item.ident.to_string(),
        module: module.to_vec(),
        relative: file.relative.clone(),
        line: item.ident.span().start().line,
        domain,
        derives_contract_error: derives(&item.attrs, "ContractError"),
        variants,
    }
}

/// `#[name("literal")]`, or `None` when the attribute is absent or shaped
/// otherwise.
///
/// Shaped otherwise is skipped rather than guessed at, for the reason
/// [`crate::profile`] skips a non-literal `NAME`: a shape this parser does not
/// model is not a value it may invent.
fn string_attr(attrs: &[syn::Attribute], name: &str) -> Option<String> {
    attrs
        .iter()
        .find(|attr| attr.path().is_ident(name))
        .and_then(|attr| attr.parse_args::<syn::LitStr>().ok())
        .map(|literal| literal.value())
}

/// `#[name(Ident)]`.
fn ident_attr(attrs: &[syn::Attribute], name: &str) -> Option<String> {
    attrs
        .iter()
        .find(|attr| attr.path().is_ident(name))
        .and_then(|attr| attr.parse_args::<syn::Ident>().ok())
        .map(|ident| ident.to_string())
}

/// Whether `#[derive(...)]` names `wanted`.
///
/// By last path segment, so a fully-qualified `toolkit_contract::ContractError`
/// counts. The alternative -- exact-string comparison -- would answer "no" to a
/// derive that is present and spelled the other legal way.
fn derives(attrs: &[syn::Attribute], wanted: &str) -> bool {
    attrs
        .iter()
        .filter(|attr| attr.path().is_ident("derive"))
        .any(|attr| {
            attr.parse_args_with(
                syn::punctuated::Punctuated::<syn::Path, syn::Token![,]>::parse_terminated,
            )
            .is_ok_and(|paths| {
                paths.iter().any(|path| {
                    path.segments
                        .last()
                        .is_some_and(|last| last.ident == wanted)
                })
            })
        })
}

#[cfg(test)]
#[path = "error_enum_tests.rs"]
mod error_enum_tests;

#[cfg(test)]
#[path = "error_enum_corpus_tests.rs"]
mod error_enum_corpus_tests;
