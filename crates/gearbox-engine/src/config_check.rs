//! A product's config values against the types their gears declare.
//!
//! The join this performs has no resolution in it -- a product's selected gears
//! against the catalogue's projected fields -- which is why it is a pure
//! function with a `Diagnostics` out-parameter rather than a step of the
//! resolver.
//!
//! **It is called from two places, and both are necessary.** `validate` is where
//! a join like this belongs, but the Add Gear panel resolves rather than
//! validates, so a check placed only in `validate` would never appear where a
//! person is actually standing when they set a value. `Diagnostics::finish`
//! sorts and dedups, so a caller that ran both reports each finding once.
//!
//! **Only exposed fields are checked.** `exposes` is a curated subset, so a key
//! it omits may still be one the gear reads; reporting those would punish a
//! description for being selective, which is the thing curation is for.

use gearbox_ir::{
    Catalogue, ConfigFieldType, Diagnostic, DiagnosticCode, Diagnostics, Location, ProductIntent,
};

/// What a JSON value is, named as a diagnostic should name it.
fn actual(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "a boolean",
        serde_json::Value::Number(n) if n.is_f64() => "a fractional number",
        serde_json::Value::Number(_) => "an integer",
        serde_json::Value::String(_) => "a string",
        serde_json::Value::Array(_) => "a list",
        serde_json::Value::Object(_) => "a map",
    }
}

/// Whether `value` is admissible for `ty`, and what to say when it is not.
///
/// Returns `None` when the value fits. `Complex` always fits: the projector
/// could not read a shape for it, and inventing an expectation from an absence
/// would refuse descriptions that were always correct.
fn mismatch(ty: &ConfigFieldType, value: &serde_json::Value) -> Option<String> {
    let ok = match ty {
        ConfigFieldType::Complex => true,
        ConfigFieldType::Str => value.is_string(),
        ConfigFieldType::Bool => value.is_boolean(),
        ConfigFieldType::Int => value.is_i64() || value.is_u64(),
        // An integer is a perfectly good float, and YAML and JSON both write
        // `1` for `1.0`, so refusing it would refuse the ordinary spelling.
        ConfigFieldType::Float => value.is_number(),
        ConfigFieldType::Enum { variants } => value
            .as_str()
            .is_some_and(|s| variants.iter().any(|v| v == s)),
    };
    if ok {
        return None;
    }
    Some(match ty {
        ConfigFieldType::Enum { variants } => {
            format!("one of {}", variants.join(", "))
        }
        ConfigFieldType::Str => "a string".to_owned(),
        ConfigFieldType::Bool => "a boolean".to_owned(),
        ConfigFieldType::Int => "an integer".to_owned(),
        ConfigFieldType::Float => "a number".to_owned(),
        ConfigFieldType::Complex => unreachable!("Complex always fits"),
    })
}

/// Check every config value a product sets against the field it names.
pub fn check(
    catalogue: &Catalogue,
    intent: &ProductIntent,
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    for selection in &intent.selected_gears {
        let Some(gear) = catalogue.gears.get(&selection.gear) else {
            continue;
        };

        // Keys the generator derives from the resolved topology. Setting one is
        // not an error -- it is simply overwritten -- but it must not be
        // overwritten in silence, or an operator sets a bind address, finds the
        // generated file disagreeing, and has nothing to read that explains why.
        for endpoint in &gear.serves {
            let Some(derived) = endpoint.config_key.as_ref() else {
                continue;
            };
            if !selection.config.contains_key(derived) {
                continue;
            }
            diagnostics.push(
                // `new`, not `error`: the code's own default severity is a
                // warning, and the product still builds.
                Diagnostic::new(
                    DiagnosticCode::GdlConfigKeyDerived,
                    format!(
                        "`{}` sets `{derived}`, which its `{}` endpoint derives from the port the resolver assigned",
                        selection.gear, endpoint.name
                    ),
                )
                .with_help(format!(
                    "remove `{derived}` from this gear's config; a value written here describes a \
                     product that was not resolved"
                ))
                .at(location(selection, uri)),
            );
        }

        let Some(schema) = gear.config_schema.as_ref() else {
            continue;
        };

        for (key, value) in &selection.config {
            let Some(field) = schema.fields.iter().find(|f| &f.name == key) else {
                continue;
            };
            let Some(expected) = mismatch(&field.ty, value) else {
                continue;
            };
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::GdlConfigTypeMismatch,
                    format!(
                        "`{}` config key `{key}` is {}, but `{}` declares it as {expected}",
                        selection.gear,
                        actual(value),
                        schema.rust
                    ),
                    format!("write `{key}` as {expected}"),
                )
                .at(location(selection, uri)),
            );
        }
    }
}

/// Where a diagnostic about one selection points.
///
/// The `use_gear(...)` span when the description recorded one; claiming
/// byte-zero precision would be worse than claiming none.
fn location(selection: &gearbox_ir::GearSelection, uri: &str) -> Location {
    selection
        .declared_at
        .clone()
        .unwrap_or_else(|| Location::file(uri.to_owned()))
}

#[cfg(test)]
#[path = "config_check_tests.rs"]
mod config_check_tests;
