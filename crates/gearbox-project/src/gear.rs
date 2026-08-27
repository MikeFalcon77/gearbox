//! Parsing `#[toolkit::gear(...)]`.
//!
//! Mirrors the argument grammar in `libs/toolkit-macros/src/lib.rs`: `name`,
//! `deps`, `capabilities`, `client`, `ctor`, and a nested `lifecycle(...)`.
//! Anything else is a compile error there, so anything else here is a fact we
//! do not understand and must say so about rather than ignore.
//!
//! `ctor` is read and discarded: it is an arbitrary Rust expression, it is
//! unprojectable, and nothing in the product model needs it.

use syn::parse::{Parse, ParseStream};
use syn::punctuated::Punctuated;
use syn::{Expr, Ident, LitBool, LitStr, Token};

/// What `lifecycle(...)` said.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectedLifecycle {
    pub entry: Option<String>,
    pub stop_timeout: Option<String>,
    pub await_ready: bool,
}

/// The facts `#[toolkit::gear]` owns.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectedGear {
    /// `name = "..."`, already kebab-case.
    pub name: String,
    /// `deps = [snake_idents]`, converted to the kebab gear names the runtime
    /// uses. These are link-time co-location edges: the macro emits a hidden
    /// re-export per entry, so the crate is physically in the binary.
    pub colocated_deps: Vec<String>,
    /// `capabilities = [...]`, spelled as the macro spells them.
    pub runtime_caps: Vec<String>,
    /// `client = path::To::Trait`.
    pub client_trait: Option<String>,
    pub lifecycle: Option<ProjectedLifecycle>,
    /// The annotated item's identifier.
    ///
    /// `#[toolkit::consumes]` derives its endpoint-override config key from the
    /// kebab-case of this, *not* from `name`, so a mismatch silently breaks that
    /// override. That is the one cross-check the projected catalogue still needs
    /// (GBX0206).
    pub struct_ident: String,
    /// Arguments the macro accepts but this parser does not model.
    ///
    /// Recorded rather than dropped so a future macro argument surfaces as a
    /// known gap instead of a silent omission.
    pub unmodelled: Vec<String>,
    /// True when the attribute sits under a `#[cfg(...)]` this crate cannot
    /// evaluate, so its presence in a build is conditional.
    pub conditional: bool,
}

/// A `lifecycle(...)` clause: a bare flag, or `key = value` pairs.
struct LifecycleArgs(ProjectedLifecycle);

impl Parse for LifecycleArgs {
    fn parse(input: ParseStream<'_>) -> syn::Result<Self> {
        let mut out = ProjectedLifecycle::default();
        while !input.is_empty() {
            let key: Ident = input.parse()?;
            let name = key.to_string();

            if input.peek(Token![=]) {
                input.parse::<Token![=]>()?;
                match name.as_str() {
                    "entry" => out.entry = Some(input.parse::<LitStr>()?.value()),
                    "stop_timeout" => out.stop_timeout = Some(input.parse::<LitStr>()?.value()),
                    "await_ready" => out.await_ready = input.parse::<LitBool>()?.value(),
                    _ => {
                        // Consume the value so parsing can continue.
                        let _: Expr = input.parse()?;
                    }
                }
            } else if name == "await_ready" {
                // The bare-flag form, which is how every real gear writes it.
                out.await_ready = true;
            }

            if input.peek(Token![,]) {
                input.parse::<Token![,]>()?;
            }
        }
        Ok(Self(out))
    }
}

/// The whole `#[toolkit::gear(...)]` argument list.
struct GearArgs(ProjectedGear);

impl Parse for GearArgs {
    fn parse(input: ParseStream<'_>) -> syn::Result<Self> {
        let mut out = ProjectedGear::default();

        while !input.is_empty() {
            let key: Ident = input.parse()?;
            let name = key.to_string();

            // `lifecycle(...)` is the one argument that takes a nested list
            // rather than `= value`.
            if name == "lifecycle" && input.peek(syn::token::Paren) {
                let inner;
                syn::parenthesized!(inner in input);
                out.lifecycle = Some(inner.parse::<LifecycleArgs>()?.0);
                if input.peek(Token![,]) {
                    input.parse::<Token![,]>()?;
                }
                continue;
            }

            input.parse::<Token![=]>()?;

            match name.as_str() {
                "name" => out.name = input.parse::<LitStr>()?.value(),

                "deps" => {
                    let list = bracketed_idents(input)?;
                    // The macro derives the runtime gear name by replacing `_`
                    // with `-`; reproducing that here rather than guessing.
                    out.colocated_deps = list.into_iter().map(|i| i.replace('_', "-")).collect();
                }

                "capabilities" => {
                    // Bare idents or string literals; both appear in the wild.
                    out.runtime_caps = bracketed_idents(input)?;
                }

                "client" => {
                    let path: syn::Path = input.parse()?;
                    out.client_trait = Some(path_to_string(&path));
                }

                // Read and discarded: an arbitrary Rust expression with no
                // product meaning.
                "ctor" => {
                    let _: Expr = input.parse()?;
                }

                other => {
                    out.unmodelled.push(other.to_owned());
                    let _: Expr = input.parse()?;
                }
            }

            if input.peek(Token![,]) {
                input.parse::<Token![,]>()?;
            }
        }

        Ok(Self(out))
    }
}

/// Parse `[a, b, c]` where each element is a bare ident or a string literal.
fn bracketed_idents(input: ParseStream<'_>) -> syn::Result<Vec<String>> {
    let inner;
    syn::bracketed!(inner in input);
    let items = Punctuated::<Expr, Token![,]>::parse_terminated(&inner)?;
    Ok(items
        .into_iter()
        .filter_map(|expr| match expr {
            Expr::Path(p) => Some(path_to_string(&p.path)),
            Expr::Lit(syn::ExprLit {
                lit: syn::Lit::Str(s),
                ..
            }) => Some(s.value()),
            _ => None,
        })
        .collect())
}

/// Render a path as source text without the whitespace `quote` would insert.
fn path_to_string(path: &syn::Path) -> String {
    let leading = if path.leading_colon.is_some() {
        "::"
    } else {
        ""
    };
    let segments: Vec<String> = path.segments.iter().map(|s| s.ident.to_string()).collect();
    format!("{leading}{}", segments.join("::"))
}

/// Whether any attribute on the same item is a `cfg`.
///
/// A gear behind a feature gate is genuinely conditional, and the catalogue
/// cannot tell whether a given build enables it. Recording the fact is honest;
/// silently treating it as unconditional would make the catalogue claim more
/// than it knows.
fn has_cfg(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|a| a.path().is_ident("cfg"))
}

/// Project the facts `#[toolkit::gear]` owns.
///
/// # Errors
/// Returns a [`syn::Error`] when the attribute's arguments do not parse, which
/// would mean the crate does not compile either.
pub fn project_gear(site: &crate::attribute::AttributeSite<'_>) -> syn::Result<ProjectedGear> {
    let mut projected: ProjectedGear = site.attr.parse_args::<GearArgs>()?.0;
    projected.struct_ident.clone_from(&site.struct_ident);
    // The cfg check looks at the item's other attributes, which the site does
    // not carry; callers that need it set it. Kept here for shape.
    projected.conditional = false;
    Ok(projected)
}

/// Project, additionally recording whether the item is `cfg`-gated.
///
/// # Errors
/// Returns a [`syn::Error`] when the attribute's arguments do not parse.
pub fn project_gear_with_attrs(
    site: &crate::attribute::AttributeSite<'_>,
    item_attrs: &[syn::Attribute],
) -> syn::Result<ProjectedGear> {
    let mut projected = project_gear(site)?;
    projected.conditional = has_cfg(item_attrs);
    Ok(projected)
}
