//! A bound provider that this build will not contain.
//!
//! The catalogue records which registrations sit behind a cargo feature (see
//! `ClusterProviderDecl::gated_by`). A product binding one of them is asking
//! for a backend that is linked only when the feature is selected, and nothing
//! else in the pipeline would notice: the provider resolves, the capabilities
//! match, the lock is written, and the process fails at startup with an unknown
//! provider -- or, for leader election, succeeds and elects one leader per
//! replica.
//!
//! **Checked here rather than in the resolver**, beside `feature_check`, which
//! already walks `selected_gears` against the profile kinds. The resolver has
//! the binding but not the selection; this pass has both, and the two questions
//! it asks -- is the feature selected, and is it selectable for this profile
//! kind -- belong next to each other.

use gearbox_ir::{
    Catalogue, ClusterPrimitive, Diagnostic, DiagnosticCode, Diagnostics, FeatureGate, GearId,
    Location, ProductIntent,
};

/// Report every cluster binding whose provider needs a feature nobody selected.
pub fn check(
    catalogue: &Catalogue,
    intent: &ProductIntent,
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    for scope in &intent.cluster_scopes {
        for primitive in ClusterPrimitive::ALL {
            let Some(binding) = scope.binding(*primitive) else {
                continue;
            };
            // The gear that declares the provider, found by what it declares
            // rather than by name: nothing here should know that the cluster
            // gear is called `cluster`.
            let Some((owner, provider)) = catalogue.gears.iter().find_map(|(id, gear)| {
                gear.cluster_providers
                    .iter()
                    .find(|p| p.name == binding.provider)
                    .map(|p| (id, p))
            }) else {
                continue;
            };
            let Some(gate) = provider.gated_by.get(primitive) else {
                continue;
            };
            let at = Location::or_file(
                binding.declared_at.as_ref().or(scope.declared_at.as_ref()),
                uri,
            );
            match gate {
                FeatureGate::Feature(feature) => {
                    if selects(intent, owner, feature) {
                        continue;
                    }
                    diagnostics.push(
                        Diagnostic::error(
                            DiagnosticCode::ClusterProviderNeedsFeature,
                            format!(
                                "`{}` provides {} for scope `{}` only under the Cargo feature \
                                 `{feature}`, which this product does not select on `{owner}`",
                                binding.provider,
                                primitive.config_key(),
                                scope.scope
                            ),
                            format!(
                                "add it where the gear is selected: \
                                 `use_gear(\"{owner}\", features = [\"{feature}\"])`. Without it \
                                 the backend is not linked, and the binding fails when the \
                                 process starts rather than here"
                            ),
                        )
                        .at(at),
                    );
                }
                FeatureGate::Unreadable(cfg) => {
                    // Not refused as missing, because nobody knows what to add.
                    // Reported because the alternative is treating "we could
                    // not read the condition" as "there is no condition".
                    diagnostics.push(
                        Diagnostic::error(
                            DiagnosticCode::ClusterProviderNeedsFeature,
                            format!(
                                "`{}` provides {} for scope `{}` under `cfg({cfg})`, which this \
                                 cannot reduce to a single Cargo feature",
                                binding.provider,
                                primitive.config_key(),
                                scope.scope
                            ),
                            "whether the backend is in a given build cannot be decided from \
                             here; simplify the `#[cfg(...)]` on the registration to one \
                             `feature = \"...\"`, or bind a provider that is always linked"
                                .to_owned(),
                        )
                        .at(at),
                    );
                }
            }
        }
    }
}

/// Whether the product selects `feature` on `gear`.
///
/// A gear that arrives only through the co-location closure has no `use_gear`
/// entry and therefore selects nothing -- which is the honest answer here: it
/// cannot enable the feature either, and the help says where to write it.
fn selects(intent: &ProductIntent, gear: &GearId, feature: &str) -> bool {
    intent
        .selected_gears
        .iter()
        .filter(|selection| &selection.gear == gear)
        .any(|selection| selection.features.iter().any(|f| f == feature))
}
