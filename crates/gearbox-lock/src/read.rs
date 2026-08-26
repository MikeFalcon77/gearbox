//! Reading a `product.lock` back.

use gearbox_ir::{LOCK_SCHEMA_VERSION, ResolvedProduct};
use serde::Deserialize;

use crate::canonical::{canonicalize_order, compute_hash};
use crate::error::LockError;

/// Reads only the one field needed to decide whether the rest of the
/// document is even worth parsing against the current schema.
///
/// Checking this first, rather than parsing straight into
/// [`ResolvedProduct`] and inspecting `schema_version` afterwards, is what
/// turns "a future schema added a required field" into a clear
/// [`LockError::UnsupportedSchemaVersion`] instead of a confusing
/// missing-field parse error.
#[derive(Deserialize)]
struct VersionProbe {
    schema_version: u32,
}

/// Parse `input` as a `product.lock` and verify that its recorded hash
/// matches its own content.
///
/// TOML comments are ignored by the parser, so the generated header needs no
/// special handling here.
///
/// Verification re-canonicalizes the parsed product before hashing, so a
/// lock whose collections happen to be in a different order than
/// [`write_canonical`](crate::write_canonical) would choose -- but whose
/// *content* is identical -- still verifies. A lock whose content actually
/// changed does not, which is the point:
/// [`LockError::HashMismatch`] is how a hand edit is caught rather than
/// silently taking effect.
///
/// # Errors
/// Returns [`LockError::UnsupportedSchemaVersion`] if the lock declares a
/// version this build does not understand, [`LockError::Parse`] if it is not
/// valid TOML or does not match the resolved-product schema, or
/// [`LockError::HashMismatch`] if its content does not match its own
/// recorded hash.
pub fn read(input: &str) -> Result<ResolvedProduct, LockError> {
    let probe: VersionProbe = toml::from_str(input)?;
    if probe.schema_version != LOCK_SCHEMA_VERSION {
        return Err(LockError::UnsupportedSchemaVersion {
            found: probe.schema_version,
            supported: LOCK_SCHEMA_VERSION,
        });
    }

    let product: ResolvedProduct = toml::from_str(input)?;
    let expected = product.product.lock_hash.clone();

    let mut canonical = product.clone();
    canonicalize_order(&mut canonical);
    let found = compute_hash(&canonical)?;

    if found != expected {
        return Err(LockError::HashMismatch { expected, found });
    }

    Ok(product)
}
