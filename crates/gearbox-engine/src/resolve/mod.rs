//! Turning a catalogue plus an intent into a resolved product.
//!
//! Pure: no I/O, no clock, no environment. Deterministic by construction --
//! every map is a `BTreeMap`, every set a `BTreeSet`, and every output vector is
//! sorted by its identity tuple before it leaves. That is not tidiness. The lock
//! is hashed, and a hash that changes when nothing did is a hash nobody trusts.
//!
//! Errors do **not** abort. A product that fails one check still resolves as far
//! as it can, because a partial graph with three diagnostics is more useful than
//! one diagnostic and nothing to look at. Refusing to *write* the lock is a
//! separate decision, made by the caller.

pub mod bindings;
pub mod closure;
pub mod cuts;
pub mod partition;
pub mod profile;
pub mod structural;

use gearbox_ir::{
    Catalogue, Diagnostic, DiagnosticCode, Diagnostics, Location, ProductIntent, ProfileId,
};

/// A profile the description does not declare.
///
/// Reported rather than defaulted: resolving the wrong topology silently is the
/// one outcome worse than refusing.
fn unknown_profile(intent: &ProductIntent, profile: &ProfileId, uri: &str) -> Diagnostic {
    let declared = intent
        .profiles
        .keys()
        .map(ProfileId::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    Diagnostic::error(
        DiagnosticCode::GdlUnknownProfile,
        format!("`{profile}` is not a profile this product declares"),
        format!("the description declares: {declared}"),
    )
    .at(Location::file(uri.to_owned()))
}

/// Everything one resolution produced.
pub struct Resolution {
    /// Which profile this is for.
    pub profile: ProfileId,
    /// The closure of gears, with why each is present.
    pub closure: closure::Closure,
    /// Which edges a process boundary may run through, and which may not.
    pub cuts: cuts::Cuts,
    /// The processes. Deliberately not a partition: closures overlap.
    pub partition: partition::Partition,
    /// How each severable edge is actually established.
    pub bindings: Vec<gearbox_ir::ResolvedBinding>,
    pub diagnostics: Diagnostics,
}

impl Resolution {
    #[must_use]
    pub fn has_errors(&self) -> bool {
        self.diagnostics.has_errors()
    }
}

/// Resolve `intent` against `catalogue` for one deployment profile.
///
/// # Panics
/// Never. An unknown profile is a diagnostic, not a panic.
#[must_use]
pub fn resolve(catalogue: &Catalogue, intent: &ProductIntent, profile: &ProfileId) -> Resolution {
    let mut diagnostics = Diagnostics::new();

    // Step 1 -- narrow to the profile. Done first because everything after it
    // reads the narrowed view, and because a duplicate that only appears once
    // narrowed is a contradiction the description could not have shown.
    let scoped = profile::scope(intent, profile, &mut diagnostics);

    // Step 2 -- the co-location closure.
    let closure = closure::expand(catalogue, intent, &mut diagnostics);

    // Step 3 -- which edges could carry a boundary.
    let uri = format!("file://{}", intent.gdl_path.as_str());
    let cuts = cuts::classify(catalogue, &closure, &uri, &mut diagnostics);

    // Step 4 -- processes. An unknown profile is reported rather than assumed,
    // because guessing `embedded` would silently resolve the wrong topology.
    let selected = intent
        .selected_gears
        .iter()
        .map(|s| s.gear.clone())
        .collect();
    let input = partition::Inputs {
        catalogue,
        closure: &closure,
        cuts: &cuts,
        scoped: &scoped,
        selected: &selected,
    };
    let partition = if let Some(declaration) = intent.profiles.get(profile) {
        let partition = partition::partition(&input, declaration, &uri, &mut diagnostics);
        // Step 5 -- what the runtime will refuse, said before a binary exists.
        structural::check(catalogue, &partition, declaration, &uri, &mut diagnostics);
        partition
    } else {
        diagnostics.push(unknown_profile(intent, profile, &uri));
        partition::Partition::default()
    };

    // Step 6 -- bindings, derived from placement rather than declared.
    let bindings = intent.profiles.get(profile).map_or_else(Vec::new, |d| {
        let derived = bindings::derive(
            catalogue,
            &cuts,
            &partition,
            &scoped,
            d,
            &uri,
            &mut diagnostics,
        );
        bindings::report_env_limits(catalogue, &derived, &uri, &mut diagnostics);
        derived
    });

    diagnostics.finish();
    Resolution {
        profile: profile.clone(),
        closure,
        cuts,
        partition,
        bindings,
        diagnostics,
    }
}
