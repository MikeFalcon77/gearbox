//! Projecting `impl ClusterProfile for X { const NAME }`.
//!
//! A cluster profile is the routing key that decides *which* backend a given
//! gear's coordination calls land on: the SDK maps it to
//! `ClientScope::new("cluster:{name}")` and resolves the backend registered
//! under that scope. So the profile name is the join between a gear's
//! requirement and an operator's binding, and getting it wrong is not a
//! compile error -- it is a `ProfileNotBound` at startup.
//!
//! Two traps, both taken from the shape the platform's own cluster crate uses
//! for the `event-broker` scope (`cluster/src/domain/wiring_tests.rs`, and the
//! doc example on `ClusterProfile` itself). No *production* impl existed when
//! this was written -- `event-broker` imports the facades but its
//! `EventBrokerCluster::resolve` is still a `todo!()` -- so the traps come from
//! the code that does declare one:
//!
//! ```ignore
//! struct EventBrokerProfile;                        // not `pub`
//! impl ClusterProfile for EventBrokerProfile {
//!     const NAME: &'static str = "event-broker";    // not the kebab of the ident
//! }
//! ```
//!
//! So the name is **read from `NAME`**, never derived from the identifier -- a
//! derive rule would produce `event-broker-profile` and be wrong on the only
//! real instance -- and visibility is never required. The marker also lives in a
//! domain module rather than beside the gear struct, which is why the whole
//! crate `src/` is scanned rather than just the gear's own file.

use std::path::PathBuf;

use crate::scan::RustFile;

/// One `impl ClusterProfile`, with the location a diagnostic can point at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedProfile {
    /// The marker type's identifier, e.g. `EventBrokerProfile`. Reported so a
    /// diagnostic can name the type to edit; never used to derive [`Self::name`].
    pub marker_ident: String,
    /// `const NAME`, read literally. This is the operator-facing profile name.
    pub name: String,
    /// Path relative to the crate's `src/`.
    pub relative: PathBuf,
    /// 1-based line of the `impl`.
    pub line: usize,
}

/// The `const NAME: &str = "..."` in an impl block, if it is a string literal.
fn name_const(imp: &syn::ItemImpl) -> Option<String> {
    imp.items.iter().find_map(|item| match item {
        syn::ImplItem::Const(c) if c.ident == "NAME" => match &c.expr {
            syn::Expr::Lit(syn::ExprLit {
                lit: syn::Lit::Str(s),
                ..
            }) => Some(s.value()),
            _ => None,
        },
        _ => None,
    })
}

/// Project every `impl ClusterProfile` under a crate's `src/`.
///
/// Sorted by profile name so a diagnostic's candidate list is stable. An impl
/// whose `NAME` is not a string literal is skipped rather than guessed at: the
/// trait requires the const, so a non-literal means a shape this parser does not
/// model, and inventing a name would be worse than reporting none.
#[must_use]
pub fn project_cluster_profiles(files: &[RustFile]) -> Vec<ProjectedProfile> {
    let mut out: Vec<ProjectedProfile> = files
        .iter()
        .flat_map(|file| {
            file.ast.items.iter().filter_map(move |item| {
                let syn::Item::Impl(imp) = item else {
                    return None;
                };
                let (_, trait_path, _) = imp.trait_.as_ref()?;
                if trait_path.segments.last()?.ident != "ClusterProfile" {
                    return None;
                }
                let syn::Type::Path(self_path) = &*imp.self_ty else {
                    return None;
                };

                Some(ProjectedProfile {
                    marker_ident: self_path.path.segments.last()?.ident.to_string(),
                    name: name_const(imp)?,
                    relative: file.relative.clone(),
                    // proc-macro2 reports 1-based lines, matching every editor.
                    line: trait_path.segments[0].ident.span().start().line,
                })
            })
        })
        .collect();

    out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.line.cmp(&b.line)));
    out
}

#[cfg(test)]
#[path = "profile_tests.rs"]
mod profile_tests;
