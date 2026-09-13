//! Curating a gear's Cargo features, and saying where each one belongs.
//!
//! The second instance of the split `config.rs` makes, and it is worth stating
//! why it is a split at all rather than one list. Cargo says which features
//! *exist* — that is projected into `available_features` and ADR
//! `cpt-gearbox-adr-macro-projected-catalogue` gives Cargo every fact Cargo
//! already expresses. The description contributes the two judgements a
//! `[features]` table has no way to hold:
//!
//!   * **which of them is worth offering.** The corpus answers this loudly:
//!     `types-registry`'s only feature is `integration`, which wants a Docker
//!     daemon; `oidc-authn-plugin`'s only one is `e2e-diagnostics`; and three
//!     crates declare `default`, which is not a choice an integrator makes. A
//!     wizard offering those is offering a build that should not be built.
//!
//!   * **where each one belongs.** `k8s-auth` is not merely available for a
//!     Kubernetes deployment — it is what that deployment needs, and what a
//!     local one must not have, because it reads a service-account token from a
//!     path that exists only in a pod. Nothing in `Cargo.toml` can say that.
//!
//! **Checked, not trusted**, exactly as `exposes` is. A curation names Cargo
//! facts, so it can drift from them, and a name that stopped matching would
//! offer a feature `cargo build --features` rejects. That is `GBX0213`, and the
//! check is the whole reason a curated list is not a second copy of the table.

use std::collections::BTreeSet;

use gearbox_gdl::GearDecl;
use gearbox_gdl::engine::FileIdentity;
use gearbox_ir::{CargoFeature, Diagnostic, DiagnosticCode, Diagnostics, Location};

/// The deployment kind a `gear.gdl` spelling names, as the IR spells it.
///
/// GDL writes `self_hosted`, because that is the constructor a profile is
/// declared with and a description should read the same way throughout;
/// `DeploymentProfileDecl::kind` answers `self-hosted`, because that is what the
/// lock and the CLI show. Converting once, here at the boundary, is what keeps
/// every comparison downstream a plain string equality — the alternative is two
/// spellings travelling together and a mismatch that only shows up on one
/// profile.
fn kind_of(gdl_spelling: &str) -> &str {
    match gdl_spelling {
        "self_hosted" => "self-hosted",
        other => other,
    }
}

/// The curated feature list for one gear, checked against what the crate has.
///
/// `available` is the projected `[features]` table. `None` means the description
/// curates nothing and a client should fall back to that table; `Some([])` means
/// it curates deliberately to nothing.
pub fn project(
    identity: &FileIdentity,
    decl: &GearDecl,
    available: &BTreeSet<String>,
    diagnostics: &mut Diagnostics,
) -> Option<Vec<CargoFeature>> {
    let declared_list = decl.cargo_features.as_ref()?;
    let mut out = Vec::with_capacity(declared_list.len());
    let mut seen = BTreeSet::new();

    for declared in declared_list {
        if !available.contains(&declared.name) {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::ValidateFeatureUnknown,
                    format!(
                        "the Cargo feature `{}` is offered, but `{}` does not declare it",
                        declared.name,
                        decl.package
                            .as_ref()
                            .map_or("the crate", |p| p.crate_name.as_str())
                    ),
                    if available.is_empty() {
                        "the crate declares no `[features]` at all, so there is nothing to \
                         offer: drop `cargo_features`, or add the feature to `Cargo.toml`"
                            .to_owned()
                    } else {
                        format!(
                            "the crate declares: {}. Correct the name, or add the feature to \
                             `Cargo.toml`",
                            available
                                .iter()
                                .map(|f| format!("`{f}`"))
                                .collect::<Vec<_>>()
                                .join(", ")
                        )
                    },
                )
                .at(Location::file(identity.uri.as_str().to_owned())),
            );
            continue;
        }

        // A repeat is dropped rather than reported: the list is an ordering as
        // much as a filter, the first mention is the position the author meant,
        // and a duplicate changes nothing about what is offered.
        if !seen.insert(declared.name.clone()) {
            continue;
        }

        out.push(CargoFeature {
            name: declared.name.clone(),
            kinds: declared
                .kinds
                .iter()
                .map(|k| kind_of(k).to_owned())
                .collect(),
        });
    }

    Some(out)
}
