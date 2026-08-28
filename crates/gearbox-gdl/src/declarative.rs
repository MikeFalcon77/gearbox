//! Keeping GDL declarative.
//!
//! GDL describes facts; the resolver makes decisions. A conditional in a
//! description file would move a decision out of the resolver and destroy both
//! determinism and explainability, so the language admits none
//! (`cpt-gearbox-fr-gdl-declarative`).
//!
//! Enforcement is two layers, in this order:
//!
//! 1. [`dialect`] -- the parser itself refuses `def`, `lambda`, top-level
//!    control flow, f-strings, and type expressions. Free, and the error
//!    already carries a span.
//! 2. [`scan_forbidden_tokens`] -- a token scan for the *expression* forms the
//!    dialect still admits: comprehensions, ternaries, and `and`/`or`/`not`.
//!
//! The second layer exists because the first demonstrably does not cover
//! those: `tests/declarative.rs` asserts that a comprehension and a ternary
//! both parse and evaluate under [`dialect`]. That is measured rather than
//! assumed, so if a future starlark version starts rejecting them, the test
//! fails and this layer can be reconsidered.
//!
//! A token scan is usually a blunt instrument -- `Token::If` fires for both a
//! statement and a harmless ternary, `Token::In` for a harmless membership
//! test. That objection does not apply here: the GDL vocabulary contains no
//! legitimate use of any of these tokens, so every occurrence is a violation
//! by construction and there is nothing to over-reject. String *contents* are
//! safe because the lexer yields them as `Token::String`. Should the scan ever
//! prove too blunt, the precise upgrade is a walk over `StmtP`/`ExprP`.

use gearbox_ir::{Diagnostic, DiagnosticCode, Location, Position, Range};
use starlark::syntax::{Dialect, DialectTypes};
use starlark_syntax::codemap::{CodeMap, Pos, Span};
use starlark_syntax::lexer::{Lexer, Token};

/// The GDL dialect: layer 1.
///
/// `enable_load` stays on because shared fragments are a legitimate need; the
/// sandbox that makes it safe lives in [`crate::loader`].
///
/// Note `enable_top_level_stmt: false` gates control-flow statements only --
/// top-level *assignments* remain legal, which the `gear.gdl` files rely on
/// for `SDK = cargo(...)` bindings.
#[must_use]
pub fn dialect() -> Dialect {
    Dialect {
        enable_def: false,
        enable_lambda: false,
        enable_load: true,
        enable_load_reexport: false,
        enable_top_level_stmt: false,
        enable_f_strings: false,
        enable_types: DialectTypes::Disable,
        ..Dialect::Standard
    }
}

/// A token that encodes a decision, with the reason it is refused.
///
/// The message names the construct a reader would recognise rather than the
/// token, because `Token::If` is reached from both `x if c else y` and a
/// comprehension's filter, and "conditional expression" is what they have in
/// common.
const fn forbidden(token: &Token) -> Option<&'static str> {
    match token {
        Token::If | Token::Elif | Token::Else => {
            Some("a conditional (`if`/`elif`/`else`) encodes a decision")
        }
        Token::For => Some("`for` encodes iteration, and a comprehension encodes a decision"),
        Token::Def => Some("`def` defines a function"),
        Token::Lambda => Some("`lambda` defines a function"),
        Token::And | Token::Or => Some("`and`/`or` short-circuit, which encodes a decision"),
        Token::Not => Some("`not` negates a condition"),
        Token::In => Some("`in` tests membership, which encodes a decision"),
        Token::Break | Token::Continue | Token::Return | Token::Pass => {
            Some("control flow has no meaning in a description")
        }
        _ => None,
    }
}

/// Every word the pinned lexer treats as a keyword, refused or not.
///
/// The one hand-maintained list here, because `Token` is a Logos enum with no
/// runtime reflection: there is nothing to iterate. It is complete for
/// starlark 0.14.2 by construction -- the lexer declares exactly fifteen
/// `#[token]` keywords and folds every other reserved word into the single
/// `Token::Reserved` variant, so those are the two groups and both are spelled
/// out below.
///
/// The drift this does *not* catch: a starlark upgrade introducing a new
/// keyword, plus a new [`forbidden`] arm for it, with nobody adding the
/// spelling here. Nothing short of `Token` reflection would; the mitigations
/// are the exact version pin in `Cargo.toml` and `probe_words_are_all_keywords`
/// below, which fires the moment a listed word stops being one. **If you add an
/// arm to [`forbidden`], add its spelling here.**
const KEYWORD_PROBE: &str = "\
    and break continue def elif else for if in lambda load not or pass return \
    as assert async await class del except finally from global import is \
    nonlocal raise try while with yield";

/// What GDL does with a keyword.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeywordVerdict {
    /// Refused by [`scan_forbidden_tokens`]: GBX0103, with a reason.
    Forbidden,
    /// Reserved by Starlark itself. The lexer errors on it, so it resurfaces as
    /// [`DiagnosticCode::GdlParse`] rather than as a forbidden construct --
    /// which is why `while` never reaches [`forbidden`] despite being every bit
    /// as refused as `for`.
    Reserved,
    /// Still a keyword, and still legal. In practice `load`, and only `load`.
    Allowed,
}

/// Each probe word paired with what GDL does with it.
///
/// Derived by lexing rather than restated, so the editor's red cannot disagree
/// with the engine's refusal. Consumed by `tests/export_grammar.rs`, which
/// turns the two refused groups into `invalid.illegal` scopes -- a GDL author
/// sees `if` go red as they type it, before the engine is asked anything.
#[must_use]
pub fn keyword_verdicts() -> Vec<(&'static str, KeywordVerdict)> {
    KEYWORD_PROBE
        .split_whitespace()
        .map(|word| (word, verdict(word)))
        .collect()
}

/// Lex one bare word and classify the single token it yields.
///
/// A lexer error means `Reserved`: for input that is one identifier-shaped word
/// and nothing else, `LexemeError::ReservedKeyword` is the only error the lexer
/// can raise. `probe_words_are_all_keywords` is what keeps that true.
fn verdict(word: &str) -> KeywordVerdict {
    let codemap = CodeMap::new("<probe>".to_owned(), word.to_owned());
    let mut lexer = Lexer::new(word, &dialect(), codemap);
    match lexer.next() {
        Some(Ok((_, token, _))) if forbidden(&token).is_some() => KeywordVerdict::Forbidden,
        Some(Err(_)) => KeywordVerdict::Reserved,
        _ => KeywordVerdict::Allowed,
    }
}

/// Scan `source` for constructs that encode a decision: layer 2.
///
/// Returns one [`DiagnosticCode::GdlForbiddenConstruct`] per occurrence, each
/// carrying the offending span. Every occurrence is reported rather than just
/// the first, so a reader fixing a file sees all of them in one pass.
///
/// A lexer error is not reported here -- it will resurface from the parser as
/// [`DiagnosticCode::GdlParse`] with better context, and reporting it twice
/// would just be noise.
#[must_use]
pub fn scan_forbidden_tokens(uri: &str, source: &str) -> Vec<Diagnostic> {
    // The lexer ignores the dialect it is handed (its parameter is
    // underscore-prefixed upstream), so this scan neither duplicates nor
    // cross-checks layer 1 -- it is genuinely independent.
    // CodeMap is Arc-backed (and derives Dupe), so the clone the lexer takes
    // ownership of costs a refcount bump, not a second copy of the source.
    let codemap = CodeMap::new(uri.to_owned(), source.to_owned());
    let lexer = Lexer::new(source, &dialect(), codemap.clone());

    let mut out = Vec::new();
    for lexeme in lexer {
        let Ok((start, token, end)) = lexeme else {
            // Malformed input: leave it to the parser.
            break;
        };
        if let Some(why) = forbidden(&token) {
            let span = Span::new(
                Pos::new(u32::try_from(start).unwrap_or(u32::MAX)),
                Pos::new(u32::try_from(end).unwrap_or(u32::MAX)),
            );
            out.push(
                Diagnostic::error(
                    DiagnosticCode::GdlForbiddenConstruct,
                    format!("{why}; GDL describes facts, and the resolver decides"),
                    "state the fact directly, or scope the declaration to a profile with \
                     `profiles = [...]` instead of branching",
                )
                .at(Location::new(uri.to_owned(), resolve(&codemap, span))),
            );
        }
    }
    out
}

/// Convert a byte span into the 0-based line/column range the IR uses.
///
/// starlark's `ResolvedPos` is already 0-based, matching LSP, so this is a
/// field copy rather than arithmetic -- which is why the IR's `Position` was
/// defined 0-based in the first place. (Their `Display` is 1-based; never parse
/// the display form.)
fn resolve(codemap: &CodeMap, span: Span) -> Range {
    let resolved = codemap.resolve_span(span);
    Range::new(
        Position::new(
            u32::try_from(resolved.begin.line).unwrap_or(u32::MAX),
            u32::try_from(resolved.begin.column).unwrap_or(u32::MAX),
        ),
        Position::new(
            u32::try_from(resolved.end.line).unwrap_or(u32::MAX),
            u32::try_from(resolved.end.column).unwrap_or(u32::MAX),
        ),
    )
}
