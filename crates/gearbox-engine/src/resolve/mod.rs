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

pub mod closure;
pub mod profile;

use gearbox_ir::{Catalogue, Diagnostics, ProductIntent, ProfileId};

/// Everything one resolution produced.
pub struct Resolution {
    /// Which profile this is for.
    pub profile: ProfileId,
    /// The closure of gears, with why each is present.
    pub closure: closure::Closure,
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
    let _scoped = profile::scope(intent, profile, &mut diagnostics);

    // Step 2 -- the co-location closure.
    let closure = closure::expand(catalogue, intent, &mut diagnostics);

    diagnostics.finish();
    Resolution {
        profile: profile.clone(),
        closure,
        diagnostics,
    }
}
