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
    /// Initializers that are there but could not be read, by field name.
    ///
    /// The distinction `None` alone cannot carry. A missing default is what the
    /// vendor-mismatch check keys on, so "the config declares none" and "the
    /// default is there and this parser could not read it" have to be different
    /// answers -- otherwise a field written as `vendor: some_call()` reports as
    /// a gear that compiled in no vendor at all.
    pub unreadable: Vec<String>,
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
pub(crate) fn str_literal(expr: &syn::Expr) -> Option<String> {
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
pub(crate) fn int_literal(expr: &syn::Expr) -> Option<i64> {
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

pub(crate) fn last_segment(path: &syn::Path) -> String {
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
///
/// The same argument is why [`VendorDefault::unreadable`] exists rather than a
/// `Result`: an initializer that is there and cannot be read is a third answer,
/// and it must not collapse into either of the other two. A failure to read one
/// field is no reason to withhold the other, which a `Result` would force.
#[must_use]
pub fn project_vendor_default(files: &[RustFile]) -> VendorDefault {
    let mut from_impl = vendor_from_default_impl(files);
    if from_impl.vendor.is_some() || from_impl.priority.is_some() {
        // Sorted and deduplicated wherever it is returned, so a catalogue built
        // from the same tree is byte-identical.
        from_impl.unreadable.sort();
        from_impl.unreadable.dedup();
        return from_impl;
    }
    // Nothing readable in an `impl Default`: the other spelling may still carry
    // it. An initializer this could not read travels either way, so "the config
    // declares no default" is never reported for a default that is there.
    let mut from_serde = vendor_from_serde_default(files);
    from_serde.unreadable.extend(from_impl.unreadable);
    from_serde.unreadable.sort();
    from_serde.unreadable.dedup();
    from_serde
}

/// The string a `const` initializer yields, through the wrappers
/// [`str_literal`] peels.
///
/// `vendor: DEFAULT_VENDOR.to_owned()` is the shape, and the one `str_literal`
/// has to refuse: a path is a name, not a value.
/// [`crate::cluster::resolve_str_const`] already resolves exactly this for
/// provider names, so the same shape is readable here rather than reported as
/// "no default".
fn str_const(files: &[RustFile], expr: &syn::Expr) -> Option<String> {
    match expr {
        syn::Expr::Path(p) => crate::cluster::resolve_str_const(files, &last_segment(&p.path)),
        syn::Expr::MethodCall(call)
            if matches!(
                call.method.to_string().as_str(),
                "to_owned" | "to_string" | "into"
            ) =>
        {
            str_const(files, &call.receiver)
        }
        syn::Expr::Call(call) => {
            let is_from = matches!(&*call.func, syn::Expr::Path(p) if p.path.segments.last()
                    .is_some_and(|s| s.ident == "from"));
            if is_from && call.args.len() == 1 {
                str_const(files, call.args.first()?)
            } else {
                None
            }
        }
        _ => None,
    }
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
                "vendor" if out.vendor.is_none() => {
                    match str_literal(field.1).or_else(|| str_const(files, field.1)) {
                        Some(value) => out.vendor = Some(value),
                        None => out.unreadable.push("vendor".to_owned()),
                    }
                }
                "priority" if out.priority.is_none() => match int_literal(field.1) {
                    Some(value) => out.priority = Some(value),
                    None => out.unreadable.push("priority".to_owned()),
                },
                _ => {}
            }
        }
    }
    out
}

/// The `Self { .. }` fields of a `fn default()` body.
pub(crate) fn struct_literal_fields(imp: &syn::ItemImpl) -> Vec<(String, &syn::Expr)> {
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
            let read = serde_default_fn(&field.attrs);
            let Some(fn_name) = read.name else {
                // A `serde` attribute this could not read to its end may have
                // carried the `default = "fn"` past the point it stopped, and
                // that is not the same answer as a field with no default.
                if read.truncated {
                    out.unreadable.push(ident);
                }
                continue;
            };
            let Some(body) = free_fn_body(files, &fn_name) else {
                out.unreadable.push(ident);
                continue;
            };
            match ident.as_str() {
                "vendor" if out.vendor.is_none() => {
                    match str_literal(body).or_else(|| str_const(files, body)) {
                        Some(value) => out.vendor = Some(value),
                        None => out.unreadable.push(ident),
                    }
                }
                "priority" if out.priority.is_none() => match int_literal(body) {
                    Some(value) => out.priority = Some(value),
                    None => out.unreadable.push(ident),
                },
                _ => {}
            }
        }
    }
    out
}

/// What reading `#[serde(default = "name")]` off a field yielded.
pub(crate) struct SerdeDefault {
    pub name: Option<String>,
    /// True when a `serde` attribute could not be read to its end.
    ///
    /// `parse_nested_meta` stops at the first meta form it cannot model and
    /// everything after it in the same attribute is lost with it, so a
    /// `default = "fn"` written after such a form is never seen. Dropping the
    /// error made that look like "no default fn" -- and a missing default is
    /// exactly what the vendor-mismatch check keys on, so it came back as a
    /// wrong answer rather than a gap.
    pub truncated: bool,
}

/// The function name in `#[serde(default = "name")]`, if present.
pub(crate) fn serde_default_fn(attrs: &[syn::Attribute]) -> SerdeDefault {
    let mut truncated = false;
    for attr in attrs {
        if !attr.path().is_ident("serde") {
            continue;
        }
        let mut found = None;
        let read = attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("default")
                && let Ok(value) = meta.value()
                && let Ok(lit) = value.parse::<syn::LitStr>()
            {
                found = Some(lit.value());
            } else if meta.input.peek(syn::Token![=]) {
                // Consume `rename = "..."`, `skip_serializing_if = "..."` and
                // any other `key = expr` so they do not abort the rest of the
                // list before `default = "fn"` is seen.
                let _ = meta.value()?.parse::<syn::Expr>()?;
            }
            Ok(())
        });
        // A bare `#[serde(default)]` also lands here, which is why this is a
        // signal and not an error: the caller decides whether a truncated read
        // matters for what it was looking for.
        truncated |= read.is_err() && found.is_none();
        if found.is_some() {
            return SerdeDefault {
                name: found,
                truncated,
            };
        }
    }
    SerdeDefault {
        name: None,
        truncated,
    }
}

/// The trailing expression of a free `fn name() -> _`.
pub(crate) fn free_fn_body<'a>(files: &'a [RustFile], name: &str) -> Option<&'a syn::Expr> {
    // Inline `mod` blocks included: the config projection's root discovery walks
    // them, so a lookup that stopped at the file's top level would disagree with
    // it about which functions exist.
    files
        .iter()
        .flat_map(crate::scan::items)
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
