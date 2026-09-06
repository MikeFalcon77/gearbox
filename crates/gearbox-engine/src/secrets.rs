//! What counts as a credential, and what to write instead of one.
//!
//! **One home for a contract two stages share.** The description check refuses a
//! literal in a `secret` field and tells the author which environment variable to
//! name; the generator replaces one it finds in a lock with exactly that name. If
//! the two disagreed, the refusal would advise a variable the generator never
//! reads -- so the predicate and the name live here, once.
//!
//! The signal is projected, never guessed: `ConfigField.secret` comes from the
//! Rust type (`secrecy::SecretString`), so a field is a credential because its
//! author declared it one, not because its key looks like a password.

use std::borrow::Cow;
use std::collections::BTreeMap;

use gearbox_ir::{
    Catalogue, Diagnostic, DiagnosticCode, Diagnostics, GearId, Location, ResolvedProduct,
};
use serde_json::Value;

/// Whether `raw` defers to the environment rather than carrying a value.
///
/// **A default disqualifies it, and that is the point.** `${PG_PASSWORD:-hunter2}`
/// looks like a reference and is a password sitting in the file: the runtime
/// expands the default when the variable is unset, so the literal half is live.
/// A secret may only be named, never defaulted.
#[must_use]
pub fn is_env_placeholder(raw: &str) -> bool {
    let trimmed = raw.trim();
    let Some(inner) = trimmed
        .strip_prefix("${")
        .and_then(|rest| rest.strip_suffix('}'))
    else {
        return false;
    };
    is_env_name(inner)
}

fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_uppercase() || c == '_' => {
            chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        }
        _ => false,
    }
}

/// The environment variable a given gear's secret field is read from.
///
/// Derived rather than chosen so the same field always names the same variable,
/// whichever stage is speaking about it.
#[must_use]
pub fn secret_env_name(gear: &GearId, field: &str) -> String {
    let mut name = String::new();
    for part in [gear.as_str(), field] {
        if !name.is_empty() {
            name.push('_');
        }
        for c in part.chars() {
            if c.is_ascii_alphanumeric() {
                name.push(c.to_ascii_uppercase());
            } else {
                name.push('_');
            }
        }
    }
    if name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_uppercase() || c == '_')
    {
        name
    } else {
        format!("_{name}")
    }
}

/// The secret fields a gear declares, in schema order.
///
/// Empty when the gear has no `config_schema` -- a gear that never said which of
/// its fields are credentials has none this can act on, and guessing would be the
/// heuristic this module exists to avoid.
fn secret_fields<'a>(catalogue: &'a Catalogue, gear: &GearId) -> Vec<&'a str> {
    catalogue
        .gear(gear)
        .and_then(|descriptor| descriptor.config_schema.as_ref())
        .map(|schema| {
            schema
                .fields
                .iter()
                .filter(|field| field.secret)
                .map(|field| field.name.as_str())
                .collect()
        })
        .unwrap_or_default()
}

/// The lock with every literal credential replaced by an environment reference.
///
/// **Belt and braces, and it should never have work to do.** `GBX0116` refuses a
/// literal in the description, so a lock resolved by this build cannot carry one.
/// A lock written by an earlier build can, and generating from it used to copy the
/// credential into `config/<p>.yaml`, the image, *and* the `product.lock` beside
/// them. So the whole product is rewritten once, here, rather than one section
/// deep inside the configuration generator -- two rewrites would be two chances
/// for the chart and the lock to disagree about what the value is.
///
/// [`Cow`] because the ordinary case is that nothing matches: a product with no
/// credential in it is borrowed, not cloned.
///
/// Rewriting the lock is safe because `gearbox_lock::write_canonical` recomputes
/// the hash from the product it is given rather than trusting the recorded one, so
/// what lands on disk verifies against itself. It will not match the *input*
/// lock's hash -- it is a different lock, which is what `GBX0705` says out loud.
pub fn redact_product<'a>(
    lock: &'a ResolvedProduct,
    catalogue: Option<&Catalogue>,
    diagnostics: &mut Diagnostics,
) -> Cow<'a, ResolvedProduct> {
    let Some(catalogue) = catalogue else {
        return Cow::Borrowed(lock);
    };

    let dirty: Vec<(GearId, Vec<String>)> = lock
        .gears
        .iter()
        .filter_map(|(id, gear)| {
            let fields: Vec<String> = secret_fields(catalogue, id)
                .into_iter()
                .filter(|field| carries_a_literal(&gear.config, field))
                .map(str::to_owned)
                .collect();
            (!fields.is_empty()).then(|| (id.clone(), fields))
        })
        .collect();

    if dirty.is_empty() {
        return Cow::Borrowed(lock);
    }

    let mut redacted = lock.clone();
    for (id, fields) in dirty {
        for field in fields {
            let name = secret_env_name(&id, &field);
            diagnostics.push(
                Diagnostic::new(
                    DiagnosticCode::GenLiteralSecretInLock,
                    format!("`{id}` config field `{field}` carries a credential in the lock"),
                )
                .with_help(format!(
                    "generation wrote `${{{name}}}` instead; re-resolve the product so the lock \
                     stops carrying it, and set `{field} = \"${{{name}}}\"` in the description"
                ))
                .at(Location::file(lock.product.id.clone())),
            );
            if let Some(gear) = redacted.gears.get_mut(&id) {
                gear.config
                    .insert(field, Value::String(format!("${{{name}}}")));
            }
        }
    }
    Cow::Owned(redacted)
}

/// Whether this field is set to something other than an environment reference.
///
/// An absent field is not a literal: the gear's own `serde` default supplies it at
/// run time, and nothing was written down.
fn carries_a_literal(config: &BTreeMap<String, Value>, field: &str) -> bool {
    match config.get(field) {
        None => false,
        Some(Value::String(raw)) => !is_env_placeholder(raw),
        Some(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_defaulted_placeholder_is_not_a_placeholder() {
        assert!(is_env_placeholder("${PG_PASSWORD}"));
        assert!(is_env_placeholder("  ${PG_PASSWORD}  "));
        // The half after `:-` is the credential, expanded whenever the variable
        // is unset. Accepting this is how a password stays in a `.gdl` while
        // looking like a reference to one.
        assert!(!is_env_placeholder("${PG_PASSWORD:-hunter2}"));
        assert!(!is_env_placeholder("hunter2"));
        assert!(!is_env_placeholder("${lowercase}"));
    }

    #[test]
    fn the_env_name_is_derived_from_gear_and_field() {
        let gear = GearId::new("api-gateway").unwrap();
        assert_eq!(secret_env_name(&gear, "password"), "API_GATEWAY_PASSWORD");
    }
}
