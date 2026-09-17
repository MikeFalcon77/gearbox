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

use gearbox_ir::{IdError, ProfileId};

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

/// Why a cluster profile could not be projected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProfileProjectionError {
    /// `NAME` is there, as the trait requires, but not in a shape this can read.
    ///
    /// Reported rather than skipped: a dropped profile makes `check_profiles`
    /// raise `ClusterProfileNotImplemented` against a crate that does implement
    /// it, which points the reader at the wrong file entirely.
    #[error("`impl ClusterProfile for {marker_ident}` in `{}`: {reason}", .relative.display())]
    UnreadableName {
        marker_ident: String,
        relative: PathBuf,
        reason: String,
    },

    /// `NAME` reads, but is not a profile id.
    ///
    /// The name becomes a `ClientScope` segment -- the SDK resolves
    /// `ClientScope::new("cluster:{name}")` -- so one containing `:` resolves
    /// into a different scope namespace than the one it declares.
    /// `gearbox_ir::ProfileId` already states the shape; this is where it gets
    /// applied.
    #[error("`impl ClusterProfile for {marker_ident}` in `{}` declares an unusable NAME", .relative.display())]
    InvalidName {
        marker_ident: String,
        relative: PathBuf,
        #[source]
        source: IdError,
    },
}

/// The `const NAME` in an impl block, as a string literal or a `&str` const.
///
/// A const path is resolved the way [`crate::cluster::project_provider_name`]
/// resolves a provider's `PROVIDER_NAME`: both plugins spell their names that
/// way, and there is no reason a profile marker may not.
fn name_const(files: &[RustFile], imp: &syn::ItemImpl) -> Result<String, String> {
    let Some(expr) = imp.items.iter().find_map(|item| match item {
        syn::ImplItem::Const(c) if c.ident == "NAME" => Some(&c.expr),
        _ => None,
    }) else {
        return Err("the trait requires `const NAME`, and this impl declares none".to_owned());
    };
    match expr {
        syn::Expr::Lit(syn::ExprLit {
            lit: syn::Lit::Str(s),
            ..
        }) => Ok(s.value()),
        syn::Expr::Path(p) => {
            let ident = crate::plugin::last_segment(&p.path);
            crate::cluster::resolve_str_const(files, &ident).ok_or_else(|| {
                format!("`NAME` is `{ident}`, which is not a `&str` const in this crate")
            })
        }
        _ => Err(
            "`NAME` is neither a string literal nor a path to a `&str` const in this crate"
                .to_owned(),
        ),
    }
}

/// Project every `impl ClusterProfile` under a crate's `src/`.
///
/// Sorted by profile name so a diagnostic's candidate list is stable.
///
/// # Errors
/// Returns [`ProfileProjectionError`] for an impl whose `NAME` cannot be read,
/// or whose `NAME` is not a valid profile id. Both used to be silent skips, and
/// a skip here is indistinguishable from a crate that implements no profile --
/// which is the one answer that makes the consuming check blame the wrong
/// crate.
pub fn project_cluster_profiles(
    files: &[RustFile],
) -> Result<Vec<ProjectedProfile>, ProfileProjectionError> {
    let mut out: Vec<ProjectedProfile> = Vec::new();

    for file in files {
        for item in &file.ast.items {
            let syn::Item::Impl(imp) = item else { continue };
            let Some((_, trait_path, _)) = imp.trait_.as_ref() else {
                continue;
            };
            if trait_path
                .segments
                .last()
                .is_none_or(|s| s.ident != "ClusterProfile")
            {
                continue;
            }
            let syn::Type::Path(self_path) = &*imp.self_ty else {
                continue;
            };
            let Some(marker_ident) = self_path.path.segments.last().map(|s| s.ident.to_string())
            else {
                continue;
            };

            let name = name_const(files, imp).map_err(|reason| {
                ProfileProjectionError::UnreadableName {
                    marker_ident: marker_ident.clone(),
                    relative: file.relative.clone(),
                    reason,
                }
            })?;
            // Validated where it is read, not where it is used: by the time the
            // name reaches `ClientScope` it is a bare string several crates away.
            ProfileId::new(name.clone()).map_err(|source| ProfileProjectionError::InvalidName {
                marker_ident: marker_ident.clone(),
                relative: file.relative.clone(),
                source,
            })?;

            out.push(ProjectedProfile {
                marker_ident,
                name,
                relative: file.relative.clone(),
                // proc-macro2 reports 1-based lines, matching every editor.
                line: trait_path.segments[0].ident.span().start().line,
            });
        }
    }

    out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.line.cmp(&b.line)));
    Ok(out)
}

#[cfg(test)]
#[path = "profile_tests.rs"]
mod profile_tests;
