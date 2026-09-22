//! What a `provider(...)` may say, checked against the struct the backend reads.
//!
//! Until this existed, `options` was carried verbatim from the description into
//! the generated YAML and nothing looked at a single key. The authority was
//! always there -- every options struct in the corpus is `#[derive(Deserialize)]`
//! with `#[serde(deny_unknown_fields)]`, so a typo is already an error -- but it
//! was an error at *backend startup*, in a deployed system, where the
//! description that caused it is not to hand. What was missing was the join
//! key: the provider traits carry `provider()` and `build_*(options: &Map)`, and
//! the type on the other side of that map is named only inside the `build_*`
//! body. `cluster_plugin(cache_options = "...")` states it.
//!
//! **Checked against the binding as written, not against whatever resolution
//! chose.** The options belong to the `provider("redis", …)` call somebody
//! typed; if that name is not registered, `GBX0505` says so and there is no
//! schema to check against anyway.

use gearbox_ir::{
    ClusterPrimitive, ClusterProviderDecl, Diagnostic, DiagnosticCode, Diagnostics, Location,
    ProviderBinding,
};

use crate::config_check::{actual, mismatch};

/// Check one binding's options against its provider's declared schema.
pub fn check(
    providers: &[ClusterProviderDecl],
    primitive: ClusterPrimitive,
    binding: &ProviderBinding,
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    let Some(provider) = providers.iter().find(|p| p.name == binding.provider) else {
        return;
    };
    let at = binding
        .declared_at
        .clone()
        .unwrap_or_else(|| Location::file(uri.to_owned()));

    // **A credential is refused wherever it is written, schema or no schema.**
    // This does not depend on the options being typed: a plugin that declares
    // which option carries its credential has said enough on its own.
    if let Some(credential) = provider.credential_option.as_deref()
        && let Some(value) = binding.options.get(credential)
        && !is_reference(value)
    {
        diagnostics.push(
            Diagnostic::error(
                DiagnosticCode::GdlLiteralSecret,
                format!(
                    "`{credential}` on provider `{}` is written as a literal",
                    provider.name
                ),
                "this option carries the backend's credential. Write `secret_ref = \"...\"` \
                         on the same `provider(...)`, or an expansion such as `${DATABASE_URL}` \
                         that the backend resolves at startup -- a value written here is committed \
                         with the description",
            )
            .at(at.clone()),
        );
    }

    let Some(schema) = provider.options.get(&primitive) else {
        // No declaration, so the untyped bag it always was. Deliberately silent:
        // reporting an absence here would put a diagnostic on every product that
        // uses a plugin nobody has declared options for yet.
        return;
    };

    for (key, value) in &binding.options {
        let Some(field) = schema.fields.iter().find(|f| &f.name == key) else {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::ClusterUnknownProviderOption,
                    format!(
                        "`{}` does not read an option `{key}` for {}",
                        provider.name,
                        primitive.config_key()
                    ),
                    format!(
                        "`{}` declares: {}",
                        schema.rust,
                        if schema.fields.is_empty() {
                            "no options at all".to_owned()
                        } else {
                            schema
                                .fields
                                .iter()
                                .map(|f| f.name.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        }
                    ),
                )
                .at(at.clone())
                .about_config(key.clone()),
            );
            continue;
        };
        // A value the backend expands at startup is a string here whatever the
        // field's type is, so it is not compared against it. The same rule the
        // gear-config check applies, and for the same reason: `${PORT}` is not
        // an integer until something expands it.
        if is_reference(value) {
            continue;
        }
        if let Some(expected) = mismatch(&field.ty, value) {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::ClusterProviderOptionTypeMismatch,
                    format!(
                        "`{key}` on provider `{}` takes {expected}, and this is {}",
                        provider.name,
                        actual(value)
                    ),
                    format!("read into `{}::{key}`", schema.rust),
                )
                .at(at.clone())
                .about_config(key.clone()),
            );
        }
    }

    for field in &schema.fields {
        if !field.required || binding.options.contains_key(&field.name) {
            continue;
        }
        // The credential is reported as missing like any other required option,
        // because it is one -- but the remedy is the reference, not a value.
        let help = if provider.credential_option.as_deref() == Some(field.name.as_str()) {
            "this option carries the backend's credential: supply it as `secret_ref = \"...\"` or \
             as an expansion the backend resolves at startup"
                .to_owned()
        } else {
            format!(
                "`{}::{}` has no default, so serde cannot fill it: the backend refuses to start \
                 without it",
                schema.rust, field.name
            )
        };
        diagnostics.push(
            Diagnostic::error(
                DiagnosticCode::ClusterProviderOptionMissing,
                format!(
                    "provider `{}` needs an option `{}` for {}",
                    provider.name,
                    field.name,
                    primitive.config_key()
                ),
                help,
            )
            .at(at.clone())
            .about_config(field.name.clone()),
        );
    }
}

/// Whether a value is a reference to something resolved elsewhere.
///
/// `${VAR}` and `${VAR:-default}` are what the plugins' own
/// `deserialize_and_expand` reads, so a description written that way is correct
/// and must not be compared against the field's type or refused as a literal
/// credential -- there is no credential in it.
fn is_reference(value: &serde_json::Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| s.contains("${") && s.contains('}'))
}

#[cfg(test)]
#[path = "cluster_options_tests.rs"]
mod cluster_options_tests;
