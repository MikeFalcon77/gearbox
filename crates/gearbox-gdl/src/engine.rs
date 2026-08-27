//! Evaluating one GDL file into the facts it declares.
//!
//! Note what this does *not* produce: a [`gearbox_ir::GearDescriptor`]. Under
//! ADR `cpt-gearbox-adr-macro-projected-catalogue` a description does not carry
//! the gear's id, capabilities, co-location dependencies, lifecycle or client
//! trait -- those are projected from the Rust attributes that own them. So a
//! `gear.gdl` alone cannot name the gear it describes, and assembling a
//! descriptor is `gearbox-engine`'s job, where both halves are in scope.
//!
//! The order here is deliberate: token scan, then parse, then evaluate.
//! Scanning first means a file full of conditionals reports every one of them
//! (GBX0103) instead of stopping at whatever the parser happens to dislike
//! first.
//!
//! Nothing in this crate reads the filesystem except the `load()` sandbox, and
//! that only within a root the caller names -- which keeps GDL testable from
//! string literals.

use gearbox_ir::{Diagnostic, DiagnosticCode, Diagnostics, Location, Range, RelPath, SourceId};
use starlark::environment::Module;
use starlark::eval::Evaluator;
use starlark::syntax::AstModule;

use crate::declarative::{dialect, scan_forbidden_tokens};
use crate::globals::gear_globals;
use crate::loader::{GdlLoader, is_load_escape};
use crate::sink::{GdlSink, GearDecl};

/// Where a GDL file came from, as far as the catalogue is concerned.
#[derive(Debug, Clone)]
pub struct FileIdentity {
    /// A `file://` URI, used for diagnostics and editor navigation.
    pub uri: String,
    /// The declared source this file was read from.
    pub source: SourceId,
    /// The file's path relative to that source's root.
    pub gdl_path: RelPath,
    /// Where `load()` may read from. `None` disables it, which is what a caller
    /// evaluating a string literal wants: there is no directory for a fragment
    /// to live in, and resolving against the process's cwd would be worse than
    /// refusing.
    pub load_paths: Option<LoadPaths>,
}

/// The directories `load()` is confined to.
#[derive(Debug, Clone)]
pub struct LoadPaths {
    /// The declaring file's directory.
    pub base: std::path::PathBuf,
    /// The boundary no `load()` may cross.
    pub root: std::path::PathBuf,
}

/// The result of evaluating one file.
#[derive(Debug)]
pub struct EvalOutcome<T> {
    /// `None` when evaluation could not produce a value. Diagnostics say why.
    pub value: Option<T>,
    pub diagnostics: Diagnostics,
}

impl<T> EvalOutcome<T> {
    fn failed(diagnostics: Diagnostics) -> Self {
        Self {
            value: None,
            diagnostics,
        }
    }
}

/// Evaluates GDL. Holds no mutable state, so one engine serves many files.
#[derive(Debug, Default)]
pub struct GdlEngine {
    _private: (),
}

impl GdlEngine {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Evaluate one `gear.gdl` into the facts it declares.
    ///
    /// Never returns `Err`: a malformed description is a diagnostic, not a
    /// failure of the tool.
    #[must_use]
    #[expect(
        clippy::unused_self,
        reason = "cached Globals and the loader cache will live on the engine; \
                  taking &self now keeps adding them non-breaking"
    )]
    pub fn eval_gear(&self, identity: &FileIdentity, source: &str) -> EvalOutcome<GearDecl> {
        let forbidden = scan_forbidden_tokens(&identity.uri, source);
        if !forbidden.is_empty() {
            let mut diagnostics: Diagnostics = forbidden.into_iter().collect();
            diagnostics.finish();
            return EvalOutcome::failed(diagnostics);
        }

        let ast = match AstModule::parse(&identity.uri, source.to_owned(), &dialect()) {
            Ok(ast) => ast,
            Err(e) => {
                return EvalOutcome::failed(
                    [starlark_error(&identity.uri, &e, DiagnosticCode::GdlParse)]
                        .into_iter()
                        .collect(),
                );
            }
        };

        let globals = gear_globals();
        let sink = GdlSink::new();

        // Declared before the evaluator: `set_loader` borrows it for the
        // evaluator's whole lifetime.
        let loader = identity
            .load_paths
            .as_ref()
            .map(|p| GdlLoader::new(p.base.clone(), p.root.clone(), &globals));

        let eval_err = Module::with_temp_heap(|module| {
            let mut eval = Evaluator::new(&module);
            eval.extra = Some(&sink);
            if let Some(loader) = loader.as_ref() {
                eval.set_loader(loader);
            }
            eval.eval_module(ast, &globals).err()
        });

        let mut diagnostics = sink.take_diagnostics();

        if let Some(e) = eval_err {
            diagnostics.push(starlark_error(&identity.uri, &e, classify(&e)));
            diagnostics.finish();
            return EvalOutcome::failed(diagnostics);
        }

        if sink.saw_duplicate() {
            diagnostics.push(cardinality_error(
                &identity.uri,
                "more than one `gear()` declaration",
                "a gear.gdl describes exactly one gear; split the extra declaration into its own file",
            ));
        }

        let Some(decl) = sink.take_gear() else {
            diagnostics.push(cardinality_error(
                &identity.uri,
                "no `gear()` declaration",
                "add a `gear(package = cargo(...))` call",
            ));
            diagnostics.finish();
            return EvalOutcome::failed(diagnostics);
        };

        if decl.package.is_none() {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::GdlEval,
                    "gear has no `package = cargo(...)`",
                    "declare the crate: `package = cargo(crate_name = \"...\", lib = \"...\")`. \
                     It is what tells the projector which crate to scan.",
                )
                .at(Location::file(identity.uri.clone())),
            );
            diagnostics.finish();
            return EvalOutcome::failed(diagnostics);
        }

        diagnostics.finish();
        EvalOutcome {
            value: Some(decl),
            diagnostics,
        }
    }
}

/// Which diagnostic code a starlark failure deserves.
///
/// Three distinct, actionable mistakes hide behind starlark's generic errors,
/// and matching on the message is the only signal it gives. The alternative --
/// declaring `**kwargs` everywhere and validating by hand -- would trade the
/// macro's own arity and type checking for a cleaner match, which is a bad deal.
fn classify(error: &starlark::Error) -> DiagnosticCode {
    let message = error.to_string();
    if is_load_escape(error) {
        DiagnosticCode::GdlLoadEscape
    } else if message.contains("is projected from Rust and must not be declared here") {
        DiagnosticCode::ValidateRestatement
    } else if message.contains("extra named parameter") {
        DiagnosticCode::GdlUnknownArgument
    } else {
        DiagnosticCode::GdlEval
    }
}

/// Turn a starlark error into a diagnostic, carrying its span when it has one.
fn starlark_error(uri: &str, error: &starlark::Error, code: DiagnosticCode) -> Diagnostic {
    // `without_diagnostic` drops starlark's own rendered span block, which the
    // structured location below would otherwise duplicate.
    let message = error.without_diagnostic().to_string();
    let help = match code {
        DiagnosticCode::ValidateRestatement => {
            "delete the field; it is already declared in Rust and projecting it is what \
             makes the two impossible to disagree"
        }
        DiagnosticCode::GdlUnknownArgument => {
            "check the spelling against the GDL vocabulary; unsupported fields are rejected \
             rather than ignored"
        }
        DiagnosticCode::GdlParse => "fix the syntax error",
        DiagnosticCode::GdlLoadEscape => {
            "load() may only read fragments inside the declaring file's source root; \
             use a `//`-prefixed path to address the root explicitly"
        }
        _ => "see the message above",
    };

    let mut diagnostic = Diagnostic::error(code, message, help);
    if let Some(span) = error.span() {
        // starlark's ResolvedPos is 0-based, like LSP and like our own Position,
        // so this is a field copy rather than arithmetic.
        let resolved = span.resolve_span();
        diagnostic = diagnostic.at(Location::new(
            uri.to_owned(),
            Range::new(
                gearbox_ir::Position::new(
                    u32::try_from(resolved.begin.line).unwrap_or(u32::MAX),
                    u32::try_from(resolved.begin.column).unwrap_or(u32::MAX),
                ),
                gearbox_ir::Position::new(
                    u32::try_from(resolved.end.line).unwrap_or(u32::MAX),
                    u32::try_from(resolved.end.column).unwrap_or(u32::MAX),
                ),
            ),
        ));
    }
    diagnostic
}

fn cardinality_error(uri: &str, message: &str, help: &str) -> Diagnostic {
    Diagnostic::error(DiagnosticCode::GdlCardinality, message, help)
        .at(Location::file(uri.to_owned()))
}
