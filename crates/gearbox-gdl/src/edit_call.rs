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
    let rendered = value.map(quote_string);
    let new_entry = set_named_arg_on_call(uri, slice(source, entry), field, rendered.as_deref())?;
    if new_entry == slice(source, entry) {
        return Ok(Edit::Unchanged);
    }
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

fn render_profile_entry(kind: &str, id: &str) -> String {
    match kind {
        "kubernetes" => format!("{kind}(id = {id}, discovery = \"dns\")"),
        "host_workers" => {
            format!("{kind}(id = {id}, host = \"localhost\", worker_discovery = \"dns\")")
        }
        _ => format!("{kind}(id = {id})"),
    }
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

const PROFILE_KINDS: &[&str] = &["embedded", "host_workers", "kubernetes"];

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

fn require_profile_fields(
    uri: &str,
    kind: &str,
    fields: &[(String, String)],
) -> Result<(), Diagnostics> {
    let required: &[&str] = match kind {
        "kubernetes" => &["discovery"],
        "host_workers" => &["host", "worker_discovery"],
        _ => &[],
    };
    for name in required {
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
            "use `embedded`, `host_workers`, or `kubernetes`",
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
