//! Named arguments inside a call, and lists other than `gears`.
//!
//! Same surgical rule as the parent module: byte spans from the parser, no
//! re-serialisation. Named arguments and dict keys are located on the AST of the
//! call being edited; string values are escaped before they are written.

use gearbox_ir::{ConfigValue, DiagnosticCode, Diagnostics};
use starlark::syntax::AstModule;
use starlark_syntax::codemap::Span;
use starlark_syntax::syntax::ast::{
    ArgumentP, AstArgumentP, AstExprP, AstLiteral, AstStmtP, ExprP, StmtP,
};

use crate::declarative::dialect;
use crate::edit::{
    Edit, NamedList, insert_entry, is_use_gear_entry, named_list_literal, offset, refuse,
    refuse_with, remove_entry, slice,
};

/// Whether a config key name looks like a credential slot.
///
/// **Heuristic only** — the engine cannot know a value is secret from its shape.
/// Refuses obvious literal-key names so operators keep `${PG_PASSWORD}`-style
/// references instead.
#[must_use]
pub fn is_secret_config_key(key: &str) -> bool {
    const EXACT: &[&str] = &["password", "secret", "token", "key", "credential"];
    const SUFFIXES: &[&str] = &["_password", "_secret", "_token", "_key", "_credential"];
    let lower = key.to_ascii_lowercase();
    EXACT.contains(&lower.as_str()) || SUFFIXES.iter().any(|s| lower.ends_with(s))
}

/// Whether writing `value` under `key` is refused as a literal credential.
///
/// Narrower than the name check alone, and deliberately: a `bool` or a number
/// cannot carry a password, so the heuristic has nothing to protect there. Only
/// a string can be a credential typed into a form -- which also stops a `bool`
/// named `mtls_key` being unwritable for a reason that never applied to it.
fn refuses_as_literal_secret(key: &str, value: Option<&ConfigValue>) -> bool {
    matches!(value, Some(ConfigValue::Str(_))) && is_secret_config_key(key)
}

/// One config value as the GDL literal that reads back as itself.
///
/// Total by construction, which is why [`ConfigValue`] is narrower than the JSON
/// the evaluator accepts: there is no arm here that exists only to refuse.
fn render_config_value(value: &ConfigValue) -> String {
    match value {
        ConfigValue::Str(s) => quote_string(s),
        // `Display` spells the Starlark literal for the rest.
        other => other.to_string(),
    }
}

/// Set, change, or remove one key in a gear's `config = {...}`.
///
/// # Errors
/// Refuses a string under a secret-looking key name, a missing gear, a
/// non-literal `config`, or a description that does not parse.
pub fn set_gear_config(
    uri: &str,
    source: &str,
    gear: &str,
    key: &str,
    value: Option<&ConfigValue>,
) -> Result<Edit, Diagnostics> {
    if refuses_as_literal_secret(key, value) {
        return Err(refuse(
            uri,
            &format!(
                "refusing to write config key `{key}`: names like this are for external secret references"
            ),
            "express credentials as a reference such as `${PG_PASSWORD}` rather than a literal value in the description",
        ));
    }
    let list = named_list_literal(uri, source, "gears")?;
    let entry = find_gear_entry(source, &list, gear).ok_or_else(|| {
        refuse(
            uri,
            &format!("no `use_gear` naming `{gear}` in `gears`"),
            "add the gear first, then set its config",
        )
    })?;
    let rendered = value.map(render_config_value);
    let new_entry = set_dict_key_on_call(
        uri,
        slice(source, entry),
        "config",
        key,
        rendered.as_deref(),
    )?;
    if new_entry == slice(source, entry) {
        return Ok(Edit::Unchanged);
    }
    Ok(Edit::Changed {
        source: replace_span(source, entry, &new_entry),
    })
}

/// Replace a gear's `features = [...]` list.
///
/// # Errors
/// As [`set_gear_config`], when the gear is missing or the description does not
/// parse.
pub fn set_gear_features(
    uri: &str,
    source: &str,
    gear: &str,
    features: &[String],
) -> Result<Edit, Diagnostics> {
    let list = named_list_literal(uri, source, "gears")?;
    let entry = find_gear_entry(source, &list, gear).ok_or_else(|| {
        refuse(
            uri,
            &format!("no `use_gear` naming `{gear}` in `gears`"),
            "add the gear first, then set its features",
        )
    })?;
    let new_entry = if features.is_empty() {
        set_named_arg_on_call(uri, slice(source, entry), "features", None)?
    } else {
        let rendered = features
            .iter()
            .map(|f| quote_string(f))
            .collect::<Vec<_>>()
            .join(", ");
        set_named_arg_on_call(
            uri,
            slice(source, entry),
            "features",
            Some(&format!("[{rendered}]")),
        )?
    };
    if new_entry == slice(source, entry) {
        return Ok(Edit::Unchanged);
    }
    Ok(Edit::Changed {
        source: replace_span(source, entry, &new_entry),
    })
}

/// A named list argument on a call, located inside that call's own text.
///
/// The list-shaped counterpart of the dict lookup `set_dict_key_on_call` does.
/// `Ok(None)` means the argument is absent, which is a state a caller acts on;
/// an argument that is present but not a list literal is a refusal, because
/// appending to `plugins = helper(...)` would mean guessing what it evaluates to.
fn list_arg_on_call(
    uri: &str,
    text: &str,
    name: &str,
) -> Result<Option<crate::edit::NamedList>, Diagnostics> {
    let ast = parse_call(uri, text)?;
    let args = call_args(ast.statement())
        .ok_or_else(|| refuse(uri, "expected a call expression", "fix the entry shape"))?;
    let Some(arg) = args
        .iter()
        .find(|arg| matches!(&arg.node, ArgumentP::Named(n, _) if n.node == name))
    else {
        return Ok(None);
    };
    let ArgumentP::Named(_, value) = &arg.node else {
        unreachable!("matched Named above");
    };
    let ExprP::List(entries) = &value.node else {
        return Err(refuse(
            uri,
            &format!("`{name}` is not a list literal"),
            "write it as a literal list so it can be edited surgically",
        ));
    };
    Ok(Some(crate::edit::NamedList::of(
        value.span,
        entries.iter().map(|entry| entry.span).collect(),
    )))
}

/// Add one plugin to a gear's `plugins = [...]`, leaving the others alone.
///
/// **Append-only, and that is the whole point of it existing beside
/// [`set_gear_plugins`].** That one replaces the list with bare `plugin("id")`
/// entries -- its own doc says profiles and per-plugin config stay manual -- so
/// using it to attach one plugin to `payments-demo`'s `authn-resolver` would
/// silently drop `profiles = ["dev", "local"]` and `config = {"mode":
/// "accept_all"}` from the two entries already there. A visual authoring tool
/// cannot own an edit that destroys what it did not write.
///
/// Idempotent: a plugin the list already names yields [`Edit::Unchanged`], which
/// is the convention every edit in this module follows.
///
/// # Errors
/// When the gear is not named by a `use_gear` in `gears`, when `plugins` is
/// present but not a literal list, or when the description does not parse.
pub fn add_gear_plugin(
    uri: &str,
    source: &str,
    gear: &str,
    plugin: &str,
) -> Result<Edit, Diagnostics> {
    let list = named_list_literal(uri, source, "gears")?;
    let entry = find_gear_entry(source, &list, gear).ok_or_else(|| {
        refuse(
            uri,
            &format!("no `use_gear` naming `{gear}` in `gears`"),
            "add the host gear first, then attach the plugin to it",
        )
    })?;
    let text = slice(source, entry);
    let rendered = format!("plugin({})", quote_string(plugin));

    let new_entry = match list_arg_on_call(uri, text, "plugins")? {
        // No `plugins` yet: the argument arrives with this one entry in it.
        None => set_named_arg_on_call(uri, text, "plugins", Some(&format!("[{rendered}]")))?,
        Some(plugins) => {
            // Already there, whatever else that entry carries. Compared by the
            // name the entry *names*, not by the rendered text, so an existing
            // `plugin("x", profiles = [...])` counts as present.
            if plugins
                .entries()
                .iter()
                .any(|entry| names_entry(text, *entry, plugin))
            {
                return Ok(Edit::Unchanged);
            }
            insert_entry(text, &plugins, &rendered)
        }
    };

    if new_entry == text {
        return Ok(Edit::Unchanged);
    }
    Ok(Edit::Changed {
        source: replace_span(source, entry, &new_entry),
    })
}

/// Edit one `plugin(...)` entry in place, by where it is written.
///
/// **Addressed by position, because GDL gives the entry nothing else.** A
/// `plugin("x")` call carries no id, and the same implementation may legitimately
/// appear twice under one host for disjoint profiles -- that is what
/// `profiles = [...]` is for -- so the pair `(host, index)` is the only thing
/// that distinguishes them. `plugin` is checked against what is found there and
/// the edit is refused on a mismatch, which turns a stale address into a refusal
/// rather than into an edit of the wrong connection.
///
/// **`index` counts written entries, not evaluated ones.** Evaluation drops an
/// entry whose id does not parse and an entry that duplicates a selection, so a
/// caller counting the `PluginSelection`s it received would address the wrong
/// `plugin(...)` as soon as one malformed sibling existed -- exactly when the
/// others most need editing. `gearbox_ir::PluginSelection::entry_index` carries
/// the written position for this reason; pass that.
///
/// The document the index refers to is the caller's to pin: the RPC layer
/// compares the whole text against the snapshot the client previewed before this
/// is ever reached.
///
/// `config` sets or (with `None`) removes one key; `profiles` replaces the whole
/// scope, where an empty slice means every profile and so removes the argument.
/// `remove` drops the entry and outranks both.
///
/// # Errors
/// When the host is no longer named by a `use_gear`, when `plugins` is absent or
/// not a literal list, when no entry at `index` names `plugin`, or when the
/// value would write a literal secret.
#[allow(
    clippy::too_many_arguments,
    reason = "one entry, and every way to edit it"
)]
pub fn edit_plugin_entry(
    uri: &str,
    source: &str,
    host: &str,
    index: usize,
    plugin: &str,
    config: Option<(&str, Option<&ConfigValue>)>,
    profiles: Option<&[String]>,
    remove: bool,
) -> Result<Edit, Diagnostics> {
    let list = named_list_literal(uri, source, "gears")?;
    let host_span = find_gear_entry(source, &list, host).ok_or_else(|| {
        refuse(
            uri,
            &format!("no `use_gear` naming `{host}` in `gears`"),
            "reload the product: the host of this connection is no longer selected",
        )
    })?;
    // Spans inside the host's `plugins` are relative to the host's own text, so
    // the entry is edited within that slice and the whole slice is spliced back.
    let host_text = slice(source, host_span);
    let plugins = list_arg_on_call(uri, host_text, "plugins")?.ok_or_else(|| {
        refuse(
            uri,
            &format!("`{host}` no longer has a `plugins` list"),
            "reload the product before editing this connection",
        )
    })?;
    let entry = plugins
        .entries()
        .get(index)
        .copied()
        .filter(|entry| names_entry(host_text, *entry, plugin))
        .ok_or_else(|| {
            refuse(
                uri,
                &format!("no `plugin(\"{plugin}\")` at position {index} of `{host}`"),
                "reload the product: this connection has moved or is already gone",
            )
        })?;

    let updated_host = if remove {
        remove_entry(host_text, entry)
    } else {
        let mut text = slice(host_text, entry).to_owned();
        if let Some((key, value)) = config {
            if refuses_as_literal_secret(key, value) {
                return Err(refuse(
                    uri,
                    &format!(
                        "`{key}` reads as a secret, so it is not written into the description"
                    ),
                    "point the value at a secret store and let the profile supply it",
                ));
            }
            let rendered = value.map(render_config_value);
            text = set_dict_key_on_call(uri, &text, "config", key, rendered.as_deref())?;
        }
        if let Some(profiles) = profiles {
            // An empty scope is not an empty list: `profiles = []` would read as
            // "no profile", while the absence of the argument means every one.
            let rendered = render_profiles(profiles);
            text = set_named_arg_on_call(
                uri,
                &text,
                "profiles",
                if profiles.is_empty() {
                    None
                } else {
                    Some(&rendered)
                },
            )?;
        }
        replace_span(host_text, entry, &text)
    };

    if updated_host == host_text {
        return Ok(Edit::Unchanged);
    }
    Ok(Edit::Changed {
        source: replace_span(source, host_span, &updated_host),
    })
}

/// Append one profile-scoped `plugin(...)` to a host, leaving the rest alone.
///
/// Beside [`add_gear_plugin`] rather than replacing it because the scope is part
/// of the identity here: the same implementation twice for disjoint profiles is
/// a pair of legitimate entries, not a duplicate.
///
/// Idempotent on that reading -- an entry naming this plugin *with the same
/// scope* yields [`Edit::Unchanged`], while the same plugin under a different
/// scope appends. A same-scope duplicate is what the evaluator reports as a
/// collision, so writing one would only produce a diagnostic.
///
/// # Errors
/// When the host is not named by a `use_gear` in `gears`, when `plugins` is
/// present but not a literal list, or when the description does not parse.
pub fn add_plugin_selection(
    uri: &str,
    source: &str,
    host: &str,
    plugin: &str,
    profiles: &[String],
) -> Result<Edit, Diagnostics> {
    let list = named_list_literal(uri, source, "gears")?;
    let entry = find_gear_entry(source, &list, host).ok_or_else(|| {
        refuse(
            uri,
            &format!("no `use_gear` naming `{host}` in `gears`"),
            "add the host gear first, then attach the plugin to it",
        )
    })?;
    let text = slice(source, entry);
    let scope = if profiles.is_empty() {
        String::new()
    } else {
        format!(", profiles = {}", render_profiles(profiles))
    };
    let rendered = format!("plugin({}{scope})", quote_string(plugin));

    let updated = match list_arg_on_call(uri, text, "plugins")? {
        // No `plugins` yet: the argument arrives with this one entry in it.
        None => set_named_arg_on_call(uri, text, "plugins", Some(&format!("[{rendered}]")))?,
        Some(plugins) => {
            let wanted: Vec<String> = profiles.to_vec();
            if plugins.entries().iter().any(|entry| {
                names_entry(text, *entry, plugin)
                    && entry_profiles(text, *entry).unwrap_or_default() == wanted
            }) {
                return Ok(Edit::Unchanged);
            }
            insert_entry(text, &plugins, &rendered)
        }
    };

    if updated == text {
        return Ok(Edit::Unchanged);
    }
    Ok(Edit::Changed {
        source: replace_span(source, entry, &updated),
    })
}

/// `["a", "b"]`, the one place the scope list is spelled.
fn render_profiles(profiles: &[String]) -> String {
    format!(
        "[{}]",
        profiles
            .iter()
            .map(|profile| quote_string(profile))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// The `profiles = [...]` of a list entry, as written. Absent reads as empty.
///
/// Mirrors [`entry_id`]: the entry fragment is parsed as its own module, because
/// a span is all that is held of it.
fn entry_profiles(source: &str, entry: Span) -> Option<Vec<String>> {
    let text = slice(source, entry);
    let ast = AstModule::parse("file:///entry.gdl", text.to_owned(), &dialect()).ok()?;
    let args = call_args(ast.statement())?;
    for arg in args {
        if let ArgumentP::Named(name, value) = &arg.node
            && name.node == "profiles"
            && let ExprP::List(items) = &value.node
        {
            return items.iter().map(string_literal).collect();
        }
    }
    Some(Vec::new())
}

/// Replace a gear's `plugins = [plugin("..."), ...]` list.
///
/// Each entry is a bare `plugin("id")` — profiles and per-plugin config stay
/// manual in the description until a richer Studio editor lands.
///
/// # Errors
/// As [`set_gear_features`], when the gear is missing or the description does
/// not parse.
pub fn set_gear_plugins(
    uri: &str,
    source: &str,
    gear: &str,
    plugins: &[String],
) -> Result<Edit, Diagnostics> {
    let list = named_list_literal(uri, source, "gears")?;
    let entry = find_gear_entry(source, &list, gear).ok_or_else(|| {
        refuse(
            uri,
            &format!("no `use_gear` naming `{gear}` in `gears`"),
            "add the gear first, then set its plugins",
        )
    })?;
    let new_entry = if plugins.is_empty() {
        set_named_arg_on_call(uri, slice(source, entry), "plugins", None)?
    } else {
        let rendered = plugins
            .iter()
            .map(|p| format!("plugin({})", quote_string(p)))
            .collect::<Vec<_>>()
            .join(", ");
        set_named_arg_on_call(
            uri,
            slice(source, entry),
            "plugins",
            Some(&format!("[{rendered}]")),
        )?
    };
    if new_entry == slice(source, entry) {
        return Ok(Edit::Unchanged);
    }
    Ok(Edit::Changed {
        source: replace_span(source, entry, &new_entry),
    })
}

/// Insert a deployment profile entry.
///
/// # Errors
/// When `profiles` is missing or not a list literal.
pub fn add_profile(
    uri: &str,
    source: &str,
    kind: &str,
    id: &str,
    fields: &[(String, String)],
) -> Result<Edit, Diagnostics> {
    require_profile_kind(uri, kind)?;
    for (k, _) in fields {
        require_gdl_identifier(uri, k, "profile field")?;
    }
    let list = named_list_literal(uri, source, "profiles")?;
    if list
        .entries
        .iter()
        .any(|entry| names_entry(source, *entry, id))
    {
        return Ok(Edit::Unchanged);
    }
    // **A field the caller did not name is scaffolded, not refused.** Studio's
    // Add profile form asks for an id and a kind, which is the right amount to
    // ask: the values below are editable in the profile form the moment the
    // profile exists, and asking for them twice in two shapes is how the two
    // shapes disagree. Before this, that form sent no fields at all and so could
    // add an `embedded` profile and nothing else.
    let mut supplied: Vec<(String, String)> = fields.to_vec();
    for (name, default) in required_profile_fields(kind) {
        if !supplied.iter().any(|(key, _)| key == name) {
            supplied.push(((*name).to_owned(), (*default).to_owned()));
        }
    }
    let fields = supplied.as_slice();
    require_profile_fields(uri, kind, fields)?;
    let mut parts = vec![format!("id = {}", quote_string(id))];
    for (k, v) in fields {
        parts.push(format!("{k} = {}", quote_string(v)));
    }
    let entry = format!("{kind}({})", parts.join(", "));
    Ok(Edit::Changed {
        source: insert_entry(source, &list, &entry),
    })
}

/// Insert a `source(id = ..., at = path(...))` entry.
///
/// **Why a product ever needs one added.** A scaffolded gear cannot land inside
/// an existing source root: `writable_out_root` refuses that path, and ADR
/// `cpt-gearbox-adr-authoring-ownership-tiers` tier 5 is why -- the tool does not
/// write into a corpus somebody else owns. So a gear created from inside a
/// product is, by construction, in a directory the product does not read yet, and
/// `use_gear` cannot reach it until the directory is declared. Without this edit
/// the flow ended at a notification telling the person to go and edit the
/// description by hand.
///
/// Only `path(...)` sources. A `git(...)` source is refused by
/// `ProductSessionService` when a product declares one, and writing an entry the
/// session will then refuse to open is worse than not offering it.
///
/// # Errors
/// When `sources` is missing or not a list literal, when `id` is not a valid
/// [`SourceId`](gearbox_ir::SourceId) (kebab-case), or when `at` is empty.
pub fn add_source(uri: &str, source: &str, id: &str, at: &str) -> Result<Edit, Diagnostics> {
    // **`SourceId`'s rule, not the GDL identifier rule.** A source id is
    // kebab-case -- the demo's own is `gears-rust` -- so validating it as an
    // identifier refused the id every product in the corpus already uses. Found
    // by the idempotence test, which is exactly what that test is for: it passes
    // an id the description already declares, so it can only fail on validation.
    // `SourceId::new` is the authority, and calling it keeps one rule in one
    // place rather than a second spelling of kebab-case here.
    if let Err(e) = gearbox_ir::SourceId::new(id) {
        return Err(refuse(
            uri,
            &format!("`{id}` is not a valid source id: {e}"),
            "use a kebab-case name, like `local-gears`",
        ));
    }
    if at.trim().is_empty() {
        return Err(refuse(
            uri,
            "a source needs a path",
            "pass the directory the gears live in, relative to the description",
        ));
    }
    let list = named_list_literal(uri, source, "sources")?;
    if list
        .entries
        .iter()
        .any(|entry| names_entry(source, *entry, id))
    {
        // Idempotent, as `add_gear` is: a product that already declares this id
        // is already what the caller wanted.
        return Ok(Edit::Unchanged);
    }
    let entry = format!(
        "source(id = {}, at = path({}))",
        quote_string(id),
        quote_string(at)
    );
    Ok(Edit::Changed {
        source: insert_entry(source, &list, &entry),
    })
}

/// Remove a profile by `id`.
///
/// # Errors
/// When `profiles` is missing or not a list literal.
pub fn remove_profile(uri: &str, source: &str, id: &str) -> Result<Edit, Diagnostics> {
    let list = named_list_literal(uri, source, "profiles")?;
    let Some(target) = list
        .entries
        .iter()
        .copied()
        .find(|entry| names_entry(source, *entry, id))
    else {
        return Ok(Edit::Unchanged);
    };
    Ok(Edit::Changed {
        source: remove_entry(source, target),
    })
}

/// Set one scalar field on a profile entry (`host`, `namespace`, …).
///
/// # Errors
/// When the profile is missing or the description does not parse.
pub fn set_profile_field(
    uri: &str,
    source: &str,
    id: &str,
    field: &str,
    value: Option<&str>,
) -> Result<Edit, Diagnostics> {
    require_gdl_identifier(uri, field, "profile field")?;
    let list = named_list_literal(uri, source, "profiles")?;
    let entry = list
        .entries
        .iter()
        .copied()
        .find(|e| names_entry(source, *e, id))
        .ok_or_else(|| {
            refuse(
                uri,
                &format!("no profile with id `{id}`"),
                "add the profile first, then edit its fields",
            )
        })?;
    // **Unsetting is a removal, and some arguments cannot be removed.** A
    // `None` here deletes the argument from the call, so for a field the kind
    // requires the result is a description the evaluator will not read -- the
    // product stops opening, and the control that did it is on a screen that no
    // longer renders. Refused before the write rather than reported after it.
    if value.is_none() {
        let kind = entry_callee(source, entry).unwrap_or_default();
        if required_profile_fields(&kind)
            .iter()
            .any(|(name, _)| *name == field)
        {
            return Err(refuse(
                uri,
                &format!("`{kind}` profile needs `{field}`, so it cannot be unset"),
                &format!("give `{field}` another value instead of clearing it"),
            ));
        }
    }
    let rendered = value.map(quote_string);
    let new_entry = set_named_arg_on_call(uri, slice(source, entry), field, rendered.as_deref())?;
    if new_entry == slice(source, entry) {
        return Ok(Edit::Unchanged);
    }
    Ok(Edit::Changed {
        source: replace_span(source, entry, &new_entry),
    })
}

/// The `name = "..."` of a `cluster_profile(...)` entry.
fn scope_name(source: &str, entry: Span) -> Option<String> {
    let text = slice(source, entry);
    let ast = AstModule::parse("file:///entry.gdl", text.to_owned(), &dialect()).ok()?;
    let args = call_args(ast.statement())?;
    args.iter().find_map(|arg| match &arg.node {
        ArgumentP::Named(name, value) if name.node == "name" => string_literal(value),
        _ => None,
    })
}

/// The span of the `provider(...)` call bound to `primitive`, inside an entry's text.
fn provider_call_span(uri: &str, entry_text: &str, primitive: &str) -> Result<Span, Diagnostics> {
    let ast = parse_call(uri, entry_text)?;
    let args = call_args(ast.statement()).ok_or_else(|| {
        refuse(
            uri,
            "expected a `cluster_profile(...)` call",
            "fix the entry shape",
        )
    })?;
    let bound = args.iter().find_map(|arg| match &arg.node {
        ArgumentP::Named(name, value) if name.node == primitive => Some(value),
        _ => None,
    });
    let Some(value) = bound else {
        return Err(refuse(
            uri,
            &format!("this cluster profile binds no `{primitive}`"),
            "bind a provider for that primitive before setting an option on it",
        ));
    };
    if !matches!(&value.node, ExprP::Call(..)) {
        return Err(refuse(
            uri,
            &format!("`{primitive}` is not written as a `provider(...)` call"),
            "an option can only be set on a binding written as a call here; edit the \
             description by hand if it is written another way",
        ));
    }
    Ok(value.span)
}

/// Set, change or remove one option on a `provider(...)` in a cluster profile.
///
/// **Addressed by where it is written**, the way a plugin connection is: a
/// product may hold two `cluster_profile(...)` entries with the same `name` for
/// disjoint deployment profiles -- `payments-demo` does -- so the name alone
/// picks one of two. `entry_index` is the written position in
/// `cluster_profiles`, and `scope` is checked against the entry found there: an
/// address computed against text that has since changed is refused rather than
/// applied to whatever now sits at that position.
///
/// # Errors
/// Refuses a stale address, a scope that binds nothing for the primitive, a
/// binding not written as a call, or a description that does not parse.
pub fn set_provider_option(
    uri: &str,
    source: &str,
    scope: &str,
    entry_index: usize,
    primitive: &str,
    key: &str,
    value: Option<&ConfigValue>,
) -> Result<Edit, Diagnostics> {
    require_gdl_identifier(uri, key, "provider option")?;
    let list = named_list_literal(uri, source, "cluster_profiles")?;
    let Some(entry) = list.entries.get(entry_index).copied() else {
        return Err(refuse(
            uri,
            &format!(
                "there is no cluster profile at position {entry_index}; the description has {}",
                list.entries.len()
            ),
            "the description changed since this edit was computed: re-read it and try again",
        ));
    };
    if scope_name(source, entry).as_deref() != Some(scope) {
        return Err(refuse(
            uri,
            &format!("the cluster profile at position {entry_index} is not `{scope}`"),
            "the description changed since this edit was computed: re-read it and try again",
        ));
    }

    let entry_text = slice(source, entry);
    let inner = provider_call_span(uri, entry_text, primitive)?;
    let (begin, end) = (
        offset(inner.begin(), entry_text),
        offset(inner.end(), entry_text),
    );
    let rendered = value.map(render_config_value);
    let new_inner = set_named_arg_on_call(uri, &entry_text[begin..end], key, rendered.as_deref())?;
    if new_inner == entry_text[begin..end] {
        return Ok(Edit::Unchanged);
    }
    let new_entry = format!("{}{new_inner}{}", &entry_text[..begin], &entry_text[end..]);
    Ok(Edit::Changed {
        source: replace_span(source, entry, &new_entry),
    })
}

/// Parameters for a new product description from the Studio wizard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateProductParams {
    pub id: String,
    pub name: String,
    pub version: String,
    /// `(source_id, relative_path)` entries for `sources = [...]`.
    pub sources: Vec<(String, String)>,
    pub profile_kind: String,
    pub profile_id: String,
}

/// Render a new `product.gdl` from the wizard fields.
///
/// String fields are escaped so the result always parses as GDL.
#[must_use]
pub fn render_product_template(params: &CreateProductParams) -> String {
    let sources = params
        .sources
        .iter()
        .map(|(id, at)| {
            format!(
                "        source(id = {}, at = path({}))",
                quote_string(id),
                quote_string(&at.replace('\\', "/"))
            )
        })
        .collect::<Vec<_>>()
        .join(",\n");
    let id = quote_string(&params.id);
    let name = quote_string(&params.name);
    let version = quote_string(&params.version);
    let profile_id = quote_string(&params.profile_id);
    let profile_kind = sanitized_profile_kind(&params.profile_kind);
    let profile = render_profile_entry(profile_kind, &profile_id);
    let comment_name = params.name.replace(['\n', '\r'], " ");
    format!(
        r"# Generated product description for {comment_name}.
#
# Edit this file in Gearbox Studio. Comments carry the reasoning for choices
# made here — preserve them when changing the description.

product(
    id = {id},
    name = {name},
    version = {version},

    sources = [
{sources}
    ],

    profiles = [
        {profile},
    ],
    default_profile = {profile_id},

    gears = [
    ],
)
"
    )
}

/// The scaffold entry for a new profile. `id` arrives already quoted.
///
/// Reads `required_profile_fields`, which is where the values and the reason for
/// them live -- this used to carry its own copy, and the copy was the bug behind
/// Add profile offering two kinds it could not add.
fn render_profile_entry(kind: &str, id: &str) -> String {
    let mut parts = vec![format!("id = {id}")];
    for (name, value) in required_profile_fields(kind) {
        parts.push(format!("{name} = {}", quote_string(value)));
    }
    format!("{kind}({})", parts.join(", "))
}

/// Clone a product file, changing `id` and `name` on the top-level call.
///
/// When `version` is `Some`, that argument is stamped too. Sources and every
/// other line are left untouched — comments survive byte-for-byte outside the
/// replaced named arguments.
///
/// # Errors
/// When the source does not parse or has no `product(...)` call.
pub fn clone_product_text(
    uri: &str,
    source: &str,
    new_id: &str,
    new_name: &str,
    version: Option<&str>,
) -> Result<String, Diagnostics> {
    let ast = AstModule::parse(uri, source.to_owned(), &dialect()).map_err(|e| {
        refuse_with(
            uri,
            DiagnosticCode::GdlParse,
            &format!("`{uri}` does not parse: {e}"),
            "fix the source description before cloning it",
        )
    })?;
    let call_expr_span = product_call_span(ast.statement()).ok_or_else(|| {
        refuse(
            uri,
            "could not locate `product(...)` span",
            "unexpected file shape",
        )
    })?;
    let call_text = slice(source, call_expr_span);
    let mut updated = set_named_arg_on_call(uri, call_text, "id", Some(&quote_string(new_id)))?;
    updated = set_named_arg_on_call(uri, &updated, "name", Some(&quote_string(new_name)))?;
    if let Some(version) = version {
        updated = set_named_arg_on_call(uri, &updated, "version", Some(&quote_string(version)))?;
    }
    Ok(replace_span(source, call_expr_span, &updated))
}

/// The deployment profile kinds the editor can scaffold and validate.
///
/// Public so a caller checks against this rather than restating the three
/// names: a fourth kind must reach every consumer, not just the ones somebody
/// remembered.
pub const PROFILE_KINDS: &[&str] = &["embedded", "self_hosted", "kubernetes"];

fn is_gdl_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {
            chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        _ => false,
    }
}

fn is_allowed_profile_kind(kind: &str) -> bool {
    PROFILE_KINDS.contains(&kind)
}

fn sanitized_profile_kind(kind: &str) -> &str {
    if is_allowed_profile_kind(kind) {
        kind
    } else {
        "embedded"
    }
}

fn require_gdl_identifier(uri: &str, name: &str, what: &str) -> Result<(), Diagnostics> {
    if is_gdl_identifier(name) {
        Ok(())
    } else {
        Err(refuse(
            uri,
            &format!("`{name}` is not a valid {what} identifier"),
            "use a name matching [A-Za-z_][A-Za-z0-9_]*",
        ))
    }
}

/// The fields a profile of this kind cannot be written without.
///
/// **One table, because two operations need the same answer.** `add_profile`
/// asks before writing a new entry, and `set_profile_field` asks before
/// *removing* an argument from an existing one. Until the second caller existed
/// you could not add a `self_hosted` profile without `worker_discovery` but
/// could delete it from one afterwards, which left a description the evaluator
/// refuses to read -- `product.rs` declares these as non-`Option` named
/// arguments, so starlark rejects the call outright and the product stops
/// opening.
///
/// Mirrored in the Studio profile form (`profileFields` in
/// `product/product-widget.tsx`), which is what stops the control offering the
/// removal in the first place. Two statements of one rule, and they must agree.
///
/// **The value beside each name is the scaffold default**, and it lives here so
/// that the rule and the way to satisfy it cannot drift apart. They had:
/// `add_profile` refused a `self_hosted` profile with no `host`, while
/// `render_profile_entry` -- three hundred lines away, used only by the create
/// wizard -- already knew that `host = "localhost"` and
/// `worker_discovery = "static"` evaluate clean. So Add profile offered two
/// kinds that could never succeed, next to a wizard that produced both of them
/// without trouble. Every caller now reads this one table.
///
/// `static` is not a free choice: the lowering accepts exactly `static` and
/// `directory`, and `directory` makes the resolver demand `gear-orchestrator`
/// and `grpc-hub` in the host process, which a product that was just created has
/// not selected. `profile_scaffolds_evaluate` in `tests/product.rs` holds these
/// values to evaluating on their own.
#[must_use]
pub fn required_profile_fields(kind: &str) -> &'static [(&'static str, &'static str)] {
    match kind {
        "kubernetes" => &[("discovery", "static")],
        "self_hosted" => &[("host", "localhost"), ("worker_discovery", "static")],
        _ => &[],
    }
}

fn require_profile_fields(
    uri: &str,
    kind: &str,
    fields: &[(String, String)],
) -> Result<(), Diagnostics> {
    for (name, _) in required_profile_fields(kind) {
        if !fields.iter().any(|(key, _)| key == name) {
            return Err(refuse(
                uri,
                &format!("`{kind}` profile needs `{name}`"),
                &format!("pass `{name}` when adding a `{kind}` profile"),
            ));
        }
    }
    Ok(())
}

fn require_profile_kind(uri: &str, kind: &str) -> Result<(), Diagnostics> {
    if is_allowed_profile_kind(kind) {
        Ok(())
    } else {
        Err(refuse(
            uri,
            &format!("`{kind}` is not a deployment profile constructor"),
            "use `embedded`, `self_hosted`, or `kubernetes`",
        ))
    }
}

/// Quote `s` as a Starlark/GDL double-quoted string literal.
#[must_use]
pub fn quote_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn names_entry(source: &str, entry: Span, id: &str) -> bool {
    entry_id(source, entry).as_deref() == Some(id)
}

/// The `id` of a list entry call: named `id = "…"` or the first positional string.
#[must_use]
pub fn entry_id(source: &str, entry: Span) -> Option<String> {
    let text = slice(source, entry);
    let ast = AstModule::parse("file:///entry.gdl", text.to_owned(), &dialect()).ok()?;
    let args = call_args(ast.statement())?;
    for arg in args {
        if let ArgumentP::Named(name, value) = &arg.node
            && name.node == "id"
        {
            return string_literal(value);
        }
    }
    args.iter().find_map(|arg| match &arg.node {
        ArgumentP::Positional(value) => string_literal(value),
        _ => None,
    })
}

fn find_gear_entry(source: &str, list: &NamedList, gear: &str) -> Option<Span> {
    list.entries
        .iter()
        .copied()
        .find(|entry| is_use_gear_entry(source, *entry) && names_entry(source, *entry, gear))
}

pub fn entry_callee(source: &str, entry: Span) -> Option<String> {
    let text = slice(source, entry);
    let ast = AstModule::parse("file:///entry.gdl", text.to_owned(), &dialect()).ok()?;
    call_callee(ast.statement())
}

fn call_callee<P>(stmt: &AstStmtP<P>) -> Option<String>
where
    P: starlark_syntax::syntax::ast::AstPayload,
{
    match &stmt.node {
        StmtP::Statements(statements) => statements.iter().find_map(call_callee),
        StmtP::Expression(expr) => match &expr.node {
            ExprP::Call(callee, _) => match &callee.node {
                ExprP::Identifier(id) => Some(id.node.ident.clone()),
                _ => None,
            },
            _ => None,
        },
        _ => None,
    }
}

fn product_call_span<P>(stmt: &AstStmtP<P>) -> Option<Span>
where
    P: starlark_syntax::syntax::ast::AstPayload,
{
    match &stmt.node {
        StmtP::Statements(statements) => statements.iter().find_map(product_call_span),
        StmtP::Expression(expr) => match &expr.node {
            ExprP::Call(callee, _) if crate::edit::is_identifier(callee, "product") => {
                Some(expr.span)
            }
            _ => None,
        },
        _ => None,
    }
}

fn call_args<P>(stmt: &AstStmtP<P>) -> Option<&[AstArgumentP<P>]>
where
    P: starlark_syntax::syntax::ast::AstPayload,
{
    match &stmt.node {
        StmtP::Statements(statements) => statements.iter().find_map(call_args),
        StmtP::Expression(expr) => match &expr.node {
            ExprP::Call(_, args) => Some(args.args.as_slice()),
            _ => None,
        },
        _ => None,
    }
}

fn call_expr_span<P>(stmt: &AstStmtP<P>) -> Option<Span>
where
    P: starlark_syntax::syntax::ast::AstPayload,
{
    match &stmt.node {
        StmtP::Statements(statements) => statements.iter().find_map(call_expr_span),
        StmtP::Expression(expr) => match &expr.node {
            ExprP::Call(_, _) => Some(expr.span),
            _ => None,
        },
        _ => None,
    }
}

fn string_literal<P>(expr: &AstExprP<P>) -> Option<String>
where
    P: starlark_syntax::syntax::ast::AstPayload,
{
    match &expr.node {
        ExprP::Literal(AstLiteral::String(s)) => Some(s.node.clone()),
        _ => None,
    }
}

fn replace_span(source: &str, span: Span, replacement: &str) -> String {
    let start = offset(span.begin(), source);
    let end = offset(span.end(), source);
    let mut out = String::with_capacity(source.len() - (end - start) + replacement.len());
    out.push_str(&source[..start]);
    out.push_str(replacement);
    out.push_str(&source[end..]);
    out
}

fn parse_call(uri: &str, text: &str) -> Result<AstModule, Diagnostics> {
    AstModule::parse(uri, text.to_owned(), &dialect()).map_err(|e| {
        refuse(
            uri,
            &format!("call does not parse: {e}"),
            "fix the entry shape before editing it",
        )
    })
}

/// Set or remove a named argument on a single call expression fragment.
fn set_named_arg_on_call(
    uri: &str,
    text: &str,
    name: &str,
    rendered_value: Option<&str>,
) -> Result<String, Diagnostics> {
    let ast = parse_call(uri, text)?;
    let args = call_args(ast.statement())
        .ok_or_else(|| refuse(uri, "expected a call expression", "fix the entry shape"))?;
    let existing = args
        .iter()
        .find(|arg| matches!(&arg.node, ArgumentP::Named(n, _) if n.node == name));

    match (existing, rendered_value) {
        (Some(arg), Some(value)) => {
            let ArgumentP::Named(_, value_expr) = &arg.node else {
                unreachable!("matched Named above");
            };
            if slice(text, value_expr.span) == value {
                return Ok(text.to_owned());
            }
            Ok(replace_span(text, value_expr.span, value))
        }
        (Some(arg), None) => Ok(remove_arg_span(text, arg.span)),
        (None, Some(value)) => {
            let call_span = call_expr_span(ast.statement())
                .ok_or_else(|| refuse(uri, "expected a call expression", "fix the entry shape"))?;
            let close = offset(call_span.end(), text);
            if close == 0 || !text[..close].ends_with(')') {
                return Err(refuse(
                    uri,
                    "call has no closing paren",
                    "fix the entry shape",
                ));
            }
            let insert_at = close - 1;
            let head = &text[..insert_at];
            let insert = if head.trim_end().ends_with('(') {
                format!("{name} = {value}")
            } else {
                format!(", {name} = {value}")
            };
            Ok(format!("{head}{insert}{}", &text[insert_at..]))
        }
        (None, None) => Ok(text.to_owned()),
    }
}

/// Set, replace or remove one key of a named dict argument on a call.
///
/// `rendered` is already a GDL literal, matching the convention
/// `set_named_arg_on_call` uses for its own value parameter. Quoting used to
/// happen here, three times, which made this span surgeon the one place that
/// decided every config value was a string.
fn set_dict_key_on_call(
    uri: &str,
    text: &str,
    dict_name: &str,
    key: &str,
    rendered: Option<&str>,
) -> Result<String, Diagnostics> {
    let ast = parse_call(uri, text)?;
    let args = call_args(ast.statement())
        .ok_or_else(|| refuse(uri, "expected a call expression", "fix the entry shape"))?;
    let dict_arg = args
        .iter()
        .find(|arg| matches!(&arg.node, ArgumentP::Named(n, _) if n.node == dict_name));

    match (dict_arg, rendered) {
        (None, None) => Ok(text.to_owned()),
        (None, Some(v)) => {
            let dict = format!("{{{}: {v}}}", quote_string(key));
            set_named_arg_on_call(uri, text, dict_name, Some(&dict))
        }
        (Some(arg), _) => {
            let ArgumentP::Named(_, dict_expr) = &arg.node else {
                unreachable!("matched Named above");
            };
            let ExprP::Dict(pairs) = &dict_expr.node else {
                return Err(refuse(
                    uri,
                    &format!("`{dict_name}` is not a dict literal"),
                    "write config as a literal dict so it can be edited surgically",
                ));
            };
            let key_pair = pairs
                .iter()
                .find(|(key_expr, _)| string_literal(key_expr).as_deref() == Some(key));
            match (key_pair, rendered) {
                (Some((_, old_val)), Some(v)) => {
                    // Textual idempotence, and it holds for every scalar shape:
                    // `True`, `8087` and `-1` all slice back as themselves.
                    if slice(text, old_val.span) == v {
                        return Ok(text.to_owned());
                    }
                    Ok(replace_span(text, old_val.span, v))
                }
                (None, Some(v)) => {
                    let pair = format!("{}: {v}", quote_string(key));
                    Ok(insert_dict_pair(text, dict_expr.span, &pair))
                }
                (Some((key_expr, val_expr)), None) => {
                    let pair_start = offset(key_expr.span.begin(), text);
                    let pair_end = offset(val_expr.span.end(), text);
                    let without = remove_range_with_comma(text, pair_start, pair_end);
                    // Re-parse to see if the dict is now empty — if so, drop the arg.
                    let ast = parse_call(uri, &without)?;
                    let args = call_args(ast.statement()).ok_or_else(|| {
                        refuse(uri, "expected a call expression", "fix the entry shape")
                    })?;
                    let still = args.iter().find(
                        |arg| matches!(&arg.node, ArgumentP::Named(n, _) if n.node == dict_name),
                    );
                    match still {
                        Some(arg) => {
                            let ArgumentP::Named(_, remaining_dict) = &arg.node else {
                                unreachable!("matched Named");
                            };
                            if matches!(&remaining_dict.node, ExprP::Dict(pairs) if pairs.is_empty())
                            {
                                Ok(remove_arg_span(&without, arg.span))
                            } else {
                                Ok(without)
                            }
                        }
                        None => Ok(without),
                    }
                }
                (None, None) => Ok(text.to_owned()),
            }
        }
    }
}

fn insert_dict_pair(text: &str, dict_span: Span, pair: &str) -> String {
    let end = offset(dict_span.end(), text);
    if end == 0 || !text[..end].ends_with('}') {
        return text.to_owned();
    }
    let insert_at = end - 1;
    let body = text[offset(dict_span.begin(), text) + 1..insert_at].trim();
    let insert = if body.is_empty() {
        pair.to_owned()
    } else {
        format!(", {pair}")
    };
    format!("{}{insert}{}", &text[..insert_at], &text[insert_at..])
}

fn remove_arg_span(text: &str, span: Span) -> String {
    remove_range_with_comma(text, offset(span.begin(), text), offset(span.end(), text))
}

/// Drop `[start, end)` and a neighbouring comma so the call/dict stays valid.
fn remove_range_with_comma(text: &str, start: usize, end: usize) -> String {
    let mut cut_start = start;
    let mut cut_end = end;

    let before = &text[..cut_start];
    if before.trim_end().ends_with(',') {
        let trimmed = before.trim_end();
        cut_start = trimmed.len() - 1;
        while cut_end < text.len() && text.as_bytes()[cut_end].is_ascii_whitespace() {
            cut_end += 1;
        }
    } else {
        while cut_end < text.len() && text.as_bytes()[cut_end].is_ascii_whitespace() {
            cut_end += 1;
        }
        if text.as_bytes().get(cut_end) == Some(&b',') {
            cut_end += 1;
            while cut_end < text.len() && text.as_bytes()[cut_end].is_ascii_whitespace() {
                cut_end += 1;
            }
        }
    }

    format!("{}{}", &text[..cut_start], &text[cut_end..])
}
