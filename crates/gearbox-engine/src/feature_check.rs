//! Checking a product's selected Cargo features against the profiles it
//! declares.
//!
//! The join `features.rs` makes possible: a gear says which deployment kinds a
//! feature belongs to, and the product says which features it wants. Run from
//! `resolve` as well as from `validate`, for the reason `config_check` is: the
//! Add Gear panel resolves rather than validates, so a check only `validate`
//! performed would never reach the person ticking the box.
//!
//! **`use_gear` has no `profiles`, and that is what makes this checkable at
//! all.** A feature selected for a gear is selected for every profile the
//! product declares, so a product with an embedded profile can never
//! legitimately ask for `k8s-auth` — there is no scope in which that selection
//! is only sometimes wrong. `validate` therefore checks every declared profile
//! and `resolve` checks the one it is resolving, and both say the same thing.
//!
//! **Only a curated feature can be wrong here.** A gear with no `cargo_features`
//! has declared nothing about where its features belong, and silence is not a
//! constraint. A feature listed with no `kinds` is explicitly everywhere.
//!
//! **A feature the crate does not declare at all is deliberately not reported.**
//! It would fail `cargo build`, so the temptation is obvious, but the projector
//! reads one manifest and a feature can legitimately come from a workspace-level
//! table or a rename it does not follow — which is exactly why the Add Gear
//! panel keeps such a name and marks it rather than dropping it. A diagnostic
//! here would fire on that legitimate case, and an error nobody can act on is
//! worse than a build error that names the feature.

use gearbox_ir::{
    Catalogue, Diagnostic, DiagnosticCode, Diagnostics, ProductIntent, ProfileId,
};

/// Report every selected feature that belongs to none of `profiles`' kinds.
///
/// One diagnostic per gear and feature, naming the profiles it is wrong for
/// rather than one per pair: the remedy is the same sentence however many
/// profiles are affected, and repeating it per profile would bury it.
pub fn check(
    catalogue: &Catalogue,
    intent: &ProductIntent,
    profiles: &[&ProfileId],
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    for selection in &intent.selected_gears {
        let Some(gear) = catalogue.gears.get(&selection.gear) else {
            continue;
        };
        for wanted in &selection.features {
            let Some(declared) = gear
                .cargo_features
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|feature| &feature.name == wanted)
            else {
                continue;
            };
            if declared.kinds.is_empty() {
                continue;
            }

            let wrong: Vec<String> = profiles
                .iter()
                .filter_map(|id| {
                    let kind = intent.profiles.get(*id)?.kind();
                    (!declared.kinds.contains(kind)).then(|| format!("`{id}` (`{kind}`)"))
                })
                .collect();
            if wrong.is_empty() {
                continue;
            }

            let belongs = declared
                .kinds
                .iter()
                .map(|k| format!("`{k}`"))
                .collect::<Vec<_>>()
                .join(", ");
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::TopologyFeatureWrongKind,
                    format!(
                        "`{}` selects the Cargo feature `{wanted}`, which `{}` declares for \
                         {belongs}; {} {} not",
                        selection.gear,
                        gear.display_name,
                        wrong.join(", "),
                        if wrong.len() == 1 { "is" } else { "are" }
                    ),
                    format!(
                        "drop `{wanted}` from this gear's `features`, or stop declaring the \
                         profiles it does not suit. `use_gear` takes no `profiles`, so the \
                         feature is selected for every one of them. The gear declares where it \
                         belongs because the build cannot: it compiles either way and fails when \
                         it runs"
                    ),
                )
                .at(gearbox_ir::Location::or_file(selection.declared_at.as_ref(), uri)),
            );
        }
    }
}
