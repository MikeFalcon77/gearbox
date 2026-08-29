//! Editing a description in place, without disturbing what surrounds the edit.
//!
//! **Re-serialising is not an option, and that decides the design.** A real
//! `product.gdl` is mostly comments, and the comments carry the reasoning: why
//! `vendor` is better left alone, why `grpc-hub` is not listed, why the profiles
//! are data rather than a branch. Evaluating the file and printing the resulting
//! [`ProductIntent`] back would produce something equivalent to the machine and
//! useless to the next reader. So an edit here is a byte insertion at a span the
//! parser found, and everything outside that span is copied verbatim.
//!
//! Which tier this is, since ADR `cpt-gearbox-adr-authoring-ownership-tiers`
//! governs what may be written: **tier 3, a structured manifest edited
//! surgically.** The ADR calls that "the single most universal behaviour in the
//! set -- `cargo add`, `dotnet package add`, Gazelle", and permits it. The tier-5
//! prohibition is on rewriting *human logic*, and GDL cannot be logic: the
//! dialect refuses every branching construct (`cpt-gearbox-fr-gdl-declarative`),
//! so `use_gear("x", source = "y")` is a data entry in a list and nothing else.
//!
//! What this module will not do:
//!
//! - **Guess.** If `gears` is missing, or is not a literal list -- built by a
//!   `load()`ed helper, say -- there is no span to insert into, and the answer is
//!   a diagnostic rather than an approximation.
//! - **Reformat.** The indentation of a new entry is read off the entries already
//!   there, so a file with four-space lists keeps them and a one-line list stays
//!   on one line.
//! - **Duplicate.** Adding a gear the list already names is a no-op, which is
//!   ADR-0010's "idempotent by content" and costs nothing.

use gearbox_ir::{Diagnostic, DiagnosticCode, Diagnostics, Location, Position, Range};
use starlark::syntax::AstModule;
use starlark_syntax::codemap::{Pos, Span};
use starlark_syntax::syntax::ast::{ArgumentP, AstExprP, AstStmtP, ExprP, StmtP};

use crate::declarative::dialect;

/// The outcome of an edit request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edit {
    /// The file needs to change, and this is what it becomes.
    Changed { source: String },
    /// The file already says what was asked for. Nothing to write.
    Unchanged,
}

impl Edit {
    /// The new text, when there is one.
    #[must_use]
    pub fn changed(&self) -> Option<&str> {
        match self {
            Self::Changed { source } => Some(source),
            Self::Unchanged => None,
        }
    }
}

/// Add `use_gear(<gear>, source = <source>)` to a product's `gears` list.
///
/// # Errors
/// Returns the diagnostics explaining why the file could not be edited: it did
/// not parse, it declares no `product(...)` call, or its `gears` argument is not
/// a literal list this can insert into.
pub fn add_gear(
    uri: &str,
    source: &str,
    gear: &str,
    source_id: &str,
) -> Result<Edit, Diagnostics> {
    let list = gears_list(uri, source)?;

    if list.entries.iter().any(|entry| names_gear(source, *entry, gear)) {
        return Ok(Edit::Unchanged);
    }

    let entry = format!("use_gear(\"{gear}\", source = \"{source_id}\")");
    Ok(Edit::Changed {
        source: insert_entry(source, &list, &entry),
    })
}

/// Remove every `use_gear` naming `gear` from a product's `gears` list.
///
/// # Errors
/// As [`add_gear`].
pub fn remove_gear(uri: &str, source: &str, gear: &str) -> Result<Edit, Diagnostics> {
    let list = gears_list(uri, source)?;
    let Some(target) = list
        .entries
        .iter()
        .copied()
        .find(|entry| names_gear(source, *entry, gear))
    else {
        return Ok(Edit::Unchanged);
    };
    Ok(Edit::Changed {
        source: remove_entry(source, target),
    })
}

/// A `gears = [...]` argument, located.
struct GearsList {
    /// The list expression's own span, brackets included.
    span: Span,
    /// The spans of the entries already in it.
    entries: Vec<Span>,
}

/// Find the `gears` argument of the top-level `product(...)` call.
fn gears_list(uri: &str, source: &str) -> Result<GearsList, Diagnostics> {
    let ast = AstModule::parse(uri, source.to_owned(), &dialect())
        .map_err(|e| {
            refuse(
                uri,
                &format!("`{uri}` does not parse: {e}"),
                "fix the description before editing it; an edit cannot be placed in a file whose shape is unknown",
            )
        })?;

    let call = find_product_call(ast.statement())
        .ok_or_else(|| {
            refuse(
                uri,
                "no top-level `product(...)` call to edit",
                "point this at a product description; a `gear.gdl` has no `gears` list to add to",
            )
        })?;

    let gears = call
        .iter()
        .find_map(|argument| match &argument.node {
            ArgumentP::Named(name, value) if name.node == "gears" => Some(value),
            _ => None,
        })
        .ok_or_else(|| {
            refuse(
                uri,
                "`product(...)` declares no `gears` argument",
                "add `gears = []` to the product and retry, so there is a list to insert into",
            )
        })?;

    match &gears.node {
        ExprP::List(entries) => Ok(GearsList {
            span: gears.span,
            entries: entries.iter().map(|entry| entry.span).collect(),
        }),
        // A list built by anything other than a literal has no span to insert
        // into. Refusing names the shape rather than mangling it.
        _ => Err(refuse(
            uri,
            "`gears` is not a list literal, so there is no place to insert an entry",
            "write the entries as a literal list, or add this one by hand -- a computed list has no span to edit",
        )),
    }
}

/// The argument list of the first top-level `product(...)` call.
fn find_product_call<P>(stmt: &AstStmtP<P>) -> Option<&[starlark_syntax::syntax::ast::AstArgumentP<P>]>
where
    P: starlark_syntax::syntax::ast::AstPayload,
{
    match &stmt.node {
        StmtP::Statements(statements) => statements.iter().find_map(find_product_call),
        StmtP::Expression(expr) => match &expr.node {
            ExprP::Call(callee, args) if is_identifier(callee, "product") => Some(&args.args),
            _ => None,
        },
        _ => None,
    }
}

fn is_identifier<P>(expr: &AstExprP<P>, name: &str) -> bool
where
    P: starlark_syntax::syntax::ast::AstPayload,
{
    matches!(&expr.node, ExprP::Identifier(id) if id.node.ident == name)
}

/// Whether a list entry is a `use_gear` naming `gear`.
///
/// Read off the source text of the entry rather than off the AST: the first
/// positional argument is a string literal in every form this accepts, and
/// comparing the rendered text keeps this indifferent to how the rest of the
/// entry is written.
fn names_gear(source: &str, entry: Span, gear: &str) -> bool {
    let text = slice(source, entry);
    text.trim_start().starts_with("use_gear")
        && (text.contains(&format!("\"{gear}\"")) || text.contains(&format!("'{gear}'")))
}

/// Insert `entry` as the last element of `list`.
fn insert_entry(source: &str, list: &GearsList, entry: &str) -> String {
    let close = offset(list.span.end(), source);
    // The insertion point is just before the closing bracket, and the text before
    // it decides the shape: a list whose entries are on their own lines gets a
    // new line, a one-line list gets a comma and a space.
    let head = &source[..close];
    let before_bracket = head.trim_end_matches(']');
    let multiline = list
        .entries
        .last()
        .is_some_and(|last| slice(source, *last).contains('\n') || spans_own_line(source, *last));

    let insertion = if multiline || list.entries.is_empty() {
        let indent = list
            .entries
            .last()
            .map_or_else(|| "    ".to_owned(), |last| indent_of(source, *last));
        format!("{indent}{entry},\n")
    } else {
        format!(", {entry}")
    };

    let mut out = String::with_capacity(source.len() + insertion.len());
    if multiline || list.entries.is_empty() {
        // Everything up to and including the last newline before `]`, so the
        // closing bracket keeps its own indentation.
        let cut = before_bracket.rfind('\n').map_or(before_bracket.len(), |at| at + 1);
        out.push_str(&source[..cut]);
        out.push_str(&insertion);
        out.push_str(&source[cut..]);
    } else {
        let at = close - (head.len() - before_bracket.len()) - 1;
        out.push_str(&source[..=at]);
        out.push_str(&insertion);
        out.push_str(&source[at + 1..]);
    }
    out
}

/// Remove one entry, and the comma and blank line it leaves behind.
fn remove_entry(source: &str, entry: Span) -> String {
    let start = offset(entry.begin(), source);
    let mut end = offset(entry.end(), source);

    // Take the trailing comma and the rest of the line with it, so removing an
    // entry does not leave `,\n` hanging.
    let tail = &source[end..];
    if let Some(stripped) = tail.strip_prefix(',') {
        end += 1;
        if let Some(newline) = stripped.find('\n')
            && stripped[..newline].trim().is_empty()
        {
            end += newline + 1;
        }
    }

    // And the indentation in front of it, for the same reason.
    let head = &source[..start];
    let line_start = head.rfind('\n').map_or(0, |at| at + 1);
    let cut = if head[line_start..].trim().is_empty() { line_start } else { start };

    let mut out = String::with_capacity(source.len());
    out.push_str(&source[..cut]);
    out.push_str(&source[end..]);
    out
}

/// A Starlark byte position as an index into the same source.
///
/// Clamped rather than trusted: the span and the text come from the same parse,
/// so they agree -- but an index that could panic on a mismatch is not worth the
/// risk in a function whose whole job is slicing.
fn offset(pos: Pos, source: &str) -> usize {
    (pos.get() as usize).min(source.len())
}

fn slice(source: &str, span: Span) -> &str {
    &source[offset(span.begin(), source)..offset(span.end(), source)]
}

/// Whether the entry is the first thing on its line -- the sign of a list
/// written one element per line.
fn spans_own_line(source: &str, span: Span) -> bool {
    let begin = offset(span.begin(), source);
    source[..begin]
        .rfind('\n')
        .is_some_and(|at| source[at + 1..begin].trim().is_empty())
}

fn indent_of(source: &str, span: Span) -> String {
    let begin = offset(span.begin(), source);
    let line_start = source[..begin].rfind('\n').map_or(0, |at| at + 1);
    source[line_start..begin]
        .chars()
        .take_while(|c| c.is_whitespace())
        .collect()
}

/// A refusal, pointing at the file rather than at a position inside it.
///
/// No range: the reason is about the file's shape, not about one token, and a
/// span pointing at byte zero would claim more precision than there is. `help` is
/// not optional -- `Diagnostic::error` requires it, which is
/// `cpt-gearbox-nfr-actionable-diagnostics` enforced by the type rather than by a
/// review comment.
fn refuse(uri: &str, message: &str, help: &str) -> Diagnostics {
    let zero = Position { line: 0, character: 0 };
    let mut diagnostics: Diagnostics = [Diagnostic::error(
        DiagnosticCode::GdlParse,
        message,
        help,
    )
    .at(Location::new(uri.to_owned(), Range { start: zero, end: zero }))]
    .into_iter()
    .collect();
    diagnostics.finish();
    diagnostics
}

#[cfg(test)]
#[path = "edit_tests.rs"]
mod edit_tests;
