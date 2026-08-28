//! Step 1: narrowing the intent to one deployment profile.
//!
//! A product description declares every profile it supports and scopes the
//! declarations that differ with `profiles = [...]`. GDL has no `if`, so this
//! list *is* the conditional -- which means resolving for a profile begins by
//! evaluating it.
//!
//! An empty list means "all profiles". That is not a default filled in for
//! convenience: most declarations are the same everywhere, and requiring each to
//! enumerate the profiles would make the common case noisy and the exceptional
//! one invisible.

use std::collections::BTreeSet;

use gearbox_ir::{
    BindingIntent, ClusterScopeIntent, Diagnostic, DiagnosticCode, Diagnostics, Location,
    ProcessPin, ProductIntent, ProfileId,
};

/// The intent with everything that does not apply to this profile removed.
///
/// Borrowed rather than cloned: the resolver reads these and never mutates them,
/// and the intent outlives the resolution.
#[derive(Debug)]
pub struct ProfileScoped<'a> {
    pub bindings: Vec<&'a BindingIntent>,
    pub cluster_scopes: Vec<&'a ClusterScopeIntent>,
    pub process_pins: Vec<&'a ProcessPin>,
}

/// Whether a `profiles = [...]` list admits this profile.
fn applies(profiles: &BTreeSet<ProfileId>, profile: &ProfileId) -> bool {
    profiles.is_empty() || profiles.contains(profile)
}

/// Filter the intent to `profile`, reporting keys that collide once narrowed.
///
/// The collision check is the reason this is a step rather than three `filter`
/// calls. Two declarations that name the same key are legal in the description as
/// long as they apply to different profiles -- that is how a product says "REST
/// here, gRPC there". They become a contradiction only after narrowing, so this
/// is the one place the check can be made.
pub fn scope<'a>(
    intent: &'a ProductIntent,
    profile: &ProfileId,
    diagnostics: &mut Diagnostics,
) -> ProfileScoped<'a> {
    let uri = format!("file://{}", intent.gdl_path.as_str());

    let bindings: Vec<&BindingIntent> = intent
        .bindings
        .iter()
        .filter(|b| applies(&b.profiles, profile))
        .collect();
    report_duplicates(
        bindings
            .iter()
            .map(|b| format!("{}/{}", b.consumer, b.contract)),
        "bind",
        profile,
        &uri,
        diagnostics,
    );

    let cluster_scopes: Vec<&ClusterScopeIntent> = intent
        .cluster_scopes
        .iter()
        .filter(|s| applies(&s.profiles, profile))
        .collect();
    report_duplicates(
        cluster_scopes.iter().map(|s| s.scope.clone()),
        "cluster_profile",
        profile,
        &uri,
        diagnostics,
    );

    let process_pins: Vec<&ProcessPin> = intent
        .process_pins
        .iter()
        .filter(|p| applies(&p.profiles, profile))
        .collect();
    report_duplicates(
        process_pins.iter().map(|p| p.name.to_string()),
        "process",
        profile,
        &uri,
        diagnostics,
    );

    ProfileScoped {
        bindings,
        cluster_scopes,
        process_pins,
    }
}

/// Report each key that appears more than once after narrowing.
///
/// Reports the key, not the pair, and once per key however many times it repeats:
/// three declarations of the same binding are one mistake, not two.
fn report_duplicates(
    keys: impl Iterator<Item = String>,
    what: &str,
    profile: &ProfileId,
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    let mut seen = BTreeSet::new();
    let mut duplicated = BTreeSet::new();
    for key in keys {
        if !seen.insert(key.clone()) {
            duplicated.insert(key);
        }
    }
    for key in duplicated {
        diagnostics.push(
            Diagnostic::error(
                DiagnosticCode::GdlDuplicateProfileScoped,
                format!("two `{what}` declarations for `{key}` both apply to profile `{profile}`"),
                "scope them to different profiles with `profiles = [...]`, or delete one; \
                 a declaration with no `profiles` applies to every profile, so it collides with \
                 any scoped one for the same key",
            )
            .at(Location::file(uri.to_owned())),
        );
    }
}
