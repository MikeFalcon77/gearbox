//! Projecting plugin extension points and their implementations.
//!
//! The chain is: a host gear's SDK crate declares a plugin-API trait; plugin
//! gears implement it; the host picks one at runtime by matching a `vendor`
//! string and taking the lowest `priority`. Both sides read that string from
//! their own config, so both have a compiled-in default, and a product that
//! overrides one side and not the other breaks silently -- which is the whole
//! reason this projection exists.
//!
//! What is read here, and what is not:
//!
//! - the extension points are **read** from the SDK crate the description
//!   locates, never derived from a gear's name;
//! - which point a plugin fills is **read** from its `impl`, so a plugin that
//!   stops implementing the trait stops being a plugin;
//! - the `vendor`/`priority` defaults are **read** from the config type, in
//!   *both* spellings the tree actually uses.
//!
//! The trait's identity is its ident as written. Deriving a short name would
//! repeat the mistake `ClusterProfile` already taught:
//! `to_kebab_case("AuthNResolverPluginClient")` gives `auth-n-resolver-plugin-client`,
//! the same `AuthN` -> `auth-n` split GBX0206 exists to catch.

use crate::scan::RustFile;

/// A plugin-API trait declared by a host gear's SDK crate.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ExtensionPoint {
    /// The trait ident as written, e.g. `AuthNResolverPluginClient`.
    pub trait_ident: String,
    /// Path relative to the SDK crate's `src/`, for a diagnostic to point at.
    pub relative: std::path::PathBuf,
    /// 1-based line of the `trait` keyword.
    pub line: usize,
}

/// The `vendor` / `priority` a config type compiles in as its defaults.
///
/// Both are `Option` because a config may default one and require the other,
/// and reporting "no default" is very different from reporting a wrong one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VendorDefault {
    pub vendor: Option<String>,
    pub priority: Option<i64>,
}

impl VendorDefault {
    fn is_empty(&self) -> bool {
        self.vendor.is_none() && self.priority.is_none()
    }
}

/// Why a plugin's extension point could not be determined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginImplError {
    /// No `impl <point> for T` for any point the SDK declares.
    NotFound { points: Vec<String> },
    /// Several points implemented; which one this gear *is* is ambiguous.
    Ambiguous { points: Vec<String> },
}

/// Unwrap the string a literal expression yields.
///
/// Accepts the four spellings the tree uses: a bare literal, `.to_owned()`,
/// `.to_string()`, `.into()`, and `String::from("...")`. Anything else is not a
/// compile-time constant and must not be guessed at.
fn str_literal(expr: &syn::Expr) -> Option<String> {
    match expr {
        syn::Expr::Lit(syn::ExprLit {
            lit: syn::Lit::Str(s),
            ..
        }) => Some(s.value()),
        syn::Expr::MethodCall(call) => {
            let method = call.method.to_string();
            if matches!(method.as_str(), "to_owned" | "to_string" | "into") {
                str_literal(&call.receiver)
            } else {
                None
            }
        }
        // `String::from("...")`
        syn::Expr::Call(call) => {
            let is_from = matches!(&*call.func, syn::Expr::Path(p) if p.path.segments.last()
                    .is_some_and(|s| s.ident == "from"));
            if is_from && call.args.len() == 1 {
                str_literal(call.args.first()?)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Unwrap the integer a literal expression yields, including a negative one.
fn int_literal(expr: &syn::Expr) -> Option<i64> {
    match expr {
        syn::Expr::Lit(syn::ExprLit {
            lit: syn::Lit::Int(i),
            ..
        }) => i.base10_parse::<i64>().ok(),
        syn::Expr::Unary(u) if matches!(u.op, syn::UnOp::Neg(_)) => {
            int_literal(&u.expr).map(|v| -v)
        }
        syn::Expr::MethodCall(call) if call.method == "into" => int_literal(&call.receiver),
        _ => None,
    }
}

fn last_segment(path: &syn::Path) -> String {
    path.segments
        .last()
        .map(|s| s.ident.to_string())
        .unwrap_or_default()
}

/// Every plugin-API trait a scanned SDK crate declares.
///
/// The rule is "a public trait with `Plugin` in its ident". Deliberately a
/// shape rather than a fixed list: the real names are versioned
/// (`CredStorePluginClientV1`, `MiniChatAuditPluginClientV1`), so a list would
/// rot on the next major. A crate may declare several -- `mini-chat-sdk`
/// declares two -- so this returns all of them.
#[must_use]
pub fn project_extension_points(sdk_files: &[RustFile]) -> Vec<ExtensionPoint> {
    let mut out: Vec<ExtensionPoint> = sdk_files
        .iter()
        .flat_map(|file| {
            file.ast.items.iter().filter_map(move |item| {
                let syn::Item::Trait(t) = item else {
                    return None;
                };
                if !matches!(t.vis, syn::Visibility::Public(_)) {
                    return None;
                }
                let ident = t.ident.to_string();
                if !ident.contains("Plugin") {
                    return None;
                }
                Some(ExtensionPoint {
                    trait_ident: ident,
                    relative: file.relative.clone(),
                    line: t.trait_token.span.start().line,
                })
            })
        })
        .collect();

    out.sort();
    out.dedup();
    out
}

/// Which extension point a gear's crate implements, if any.
///
/// `points` comes from the SDK crate the description locates. Returns `Ok(None)`
/// when the gear implements none of them, which is the ordinary case: most gears
/// are not plugins.
///
/// # Errors
/// Returns [`PluginImplError::Ambiguous`] when a crate implements more than one
/// point, because then "which plugin is this" has no single answer and guessing
/// would put the gear under the wrong extension point.
pub fn project_plugin_impl(
    files: &[RustFile],
    points: &[ExtensionPoint],
) -> Result<Option<String>, PluginImplError> {
    let mut found: Vec<String> = files
        .iter()
        .flat_map(|file| file.ast.items.iter())
        .filter_map(|item| {
            let syn::Item::Impl(imp) = item else {
                return None;
            };
            let (_, path, _) = imp.trait_.as_ref()?;
            let ident = last_segment(path);
            points
                .iter()
                .any(|p| p.trait_ident == ident)
                .then_some(ident)
        })
        .collect();

    found.sort();
    found.dedup();

    match found.len() {
        0 => Ok(None),
        1 => Ok(found.into_iter().next()),
        _ => Err(PluginImplError::Ambiguous { points: found }),
    }
}

/// The `vendor` / `priority` defaults a crate compiles in.
///
/// **Two spellings exist in the tree and both must be read.** Most configs use
/// `impl Default`, but `oidc-authn-plugin` and `keycloak-idp-plugin` use only
/// `#[serde(default = "default_vendor")]` plus a free function. Reading just the
/// first would silently report "no default" for them -- and a missing default is
/// what the vendor-mismatch check keys on, so that would be a wrong answer, not
/// a gap.
#[must_use]
pub fn project_vendor_default(files: &[RustFile]) -> VendorDefault {
    let from_impl = vendor_from_default_impl(files);
    if !from_impl.is_empty() {
        return from_impl;
    }
    vendor_from_serde_default(files)
}

/// Shape 1: `impl Default for XConfig { fn default() -> Self { Self { vendor: .. } } }`
fn vendor_from_default_impl(files: &[RustFile]) -> VendorDefault {
    let mut out = VendorDefault::default();

    for item in files.iter().flat_map(|f| f.ast.items.iter()) {
        let syn::Item::Impl(imp) = item else { continue };
        let implements_default = imp
            .trait_
            .as_ref()
            .is_some_and(|(_, path, _)| last_segment(path) == "Default");
        let on_a_config = matches!(&*imp.self_ty, syn::Type::Path(p)
            if last_segment(&p.path).ends_with("Config"));
        if !implements_default || !on_a_config {
            continue;
        }

        for field in struct_literal_fields(imp) {
            match field.0.as_str() {
                "vendor" => out.vendor = out.vendor.or_else(|| str_literal(field.1)),
                "priority" => out.priority = out.priority.or_else(|| int_literal(field.1)),
                _ => {}
            }
        }
    }
    out
}

/// The `Self { .. }` fields of a `fn default()` body.
fn struct_literal_fields(imp: &syn::ItemImpl) -> Vec<(String, &syn::Expr)> {
    let Some(func) = imp.items.iter().find_map(|i| match i {
        syn::ImplItem::Fn(f) if f.sig.ident == "default" => Some(f),
        _ => None,
    }) else {
        return Vec::new();
    };
    let Some(syn::Stmt::Expr(syn::Expr::Struct(lit), None)) = func.block.stmts.last() else {
        return Vec::new();
    };
    lit.fields
        .iter()
        .filter_map(|f| match &f.member {
            syn::Member::Named(ident) => Some((ident.to_string(), &f.expr)),
            syn::Member::Unnamed(_) => None,
        })
        .collect()
}

/// Shape 2: `#[serde(default = "default_vendor")]` on the field, plus the fn.
fn vendor_from_serde_default(files: &[RustFile]) -> VendorDefault {
    let mut out = VendorDefault::default();

    for item in files.iter().flat_map(|f| f.ast.items.iter()) {
        let syn::Item::Struct(s) = item else { continue };
        for field in &s.fields {
            let Some(ident) = field.ident.as_ref().map(ToString::to_string) else {
                continue;
            };
            if ident != "vendor" && ident != "priority" {
                continue;
            }
            let Some(fn_name) = serde_default_fn(&field.attrs) else {
                continue;
            };
            let Some(body) = free_fn_body(files, &fn_name) else {
                continue;
            };
            match ident.as_str() {
                "vendor" => out.vendor = out.vendor.or_else(|| str_literal(body)),
                "priority" => out.priority = out.priority.or_else(|| int_literal(body)),
                _ => {}
            }
        }
    }
    out
}

/// The function name in `#[serde(default = "name")]`, if present.
fn serde_default_fn(attrs: &[syn::Attribute]) -> Option<String> {
    for attr in attrs {
        if !attr.path().is_ident("serde") {
            continue;
        }
        let mut found = None;
        // `parse_nested_meta` returns Err on the forms it does not understand
        // (`#[serde(default)]` with no value, `rename_all = ...`); that is not a
        // failure worth reporting, it just means this attribute has no fn name.
        drop(attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("default")
                && let Ok(value) = meta.value()
                && let Ok(lit) = value.parse::<syn::LitStr>()
            {
                found = Some(lit.value());
            }
            Ok(())
        }));
        if found.is_some() {
            return found;
        }
    }
    None
}

/// The trailing expression of a free `fn name() -> _`.
fn free_fn_body<'a>(files: &'a [RustFile], name: &str) -> Option<&'a syn::Expr> {
    files
        .iter()
        .flat_map(|f| f.ast.items.iter())
        .find_map(|item| match item {
            syn::Item::Fn(f) if f.sig.ident == name => match f.block.stmts.last() {
                Some(syn::Stmt::Expr(expr, None)) => Some(expr),
                _ => None,
            },
            _ => None,
        })
}

#[cfg(test)]
#[path = "plugin_tests.rs"]
mod plugin_tests;
