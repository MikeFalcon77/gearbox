//! The `textDocument/*` half of the wire: real LSP, not a Gearbox method wearing
//! an LSP name.
//!
//! `cpt-gearbox-fr-editor-diagnostics` asks for description diagnostics "over a
//! language-server interface", and the module header of `lib.rs` has always said
//! why the lifecycle is LSP-shaped: "One server backs both the Studio and the
//! `.gdl` language client." The `.gdl` language client is not Studio. So these
//! types are the protocol's own, down to the field spellings -- a client built on
//! `vscode-languageclient` or `lsp-types` speaks to this without a shim.
//!
//! That is also why nothing here derives `TS`. Everything else on this wire is
//! Gearbox's own invention, so the client would have to hand-write a mirror and
//! `cpt-gearbox-nfr-no-type-drift` forbids it; here the client imports LSP's
//! published definitions instead, which is the same rule reaching its better
//! answer -- one canonical source that neither side wrote.
//!
//! The one thing not taken from LSP is which diagnostics get published. See
//! `publishable`.

use std::path::{Component, Path, PathBuf};

use gearbox_ir::{Diagnostic, Location, Range, Severity};
use serde::{Deserialize, Serialize};

#[cfg(test)]
#[path = "lsp_tests.rs"]
mod lsp_tests;

/// `file:///a/b` back to `/a/b`.
///
/// Studio sends Theia's `URI.toString()`, which percent-encodes; `gearbox_ir::
/// file_uri` does not encode at all. Decoding here rather than comparing raw
/// strings is what keeps a path with a space in it from being two different
/// documents.
///
/// The result is lexically normalized -- `.` dropped and `..` collapsed --
/// because the caller compares it against a source root, and `Path::starts_with`
/// compares components. `/root/../etc/gear.gdl` is *not* inside `/root`, and an
/// unnormalized prefix test says it is. Lexical rather than `canonicalize`
/// because an editor asks about buffers that are not on disk yet, and a path
/// that cannot be resolved is still a path this has to answer for.
///
/// [`UriPath::NotLocal`] for anything that is not a `file:` URI. An `untitled:`
/// buffer has no directory for `load()` to resolve against, and inventing one
/// would make the answer about a file that does not exist.
///
/// [`UriPath::Undecodable`] is the other non-answer, and it is deliberately not
/// the same one: a `file://` URI whose escapes decode to bytes that are not UTF-8
/// names a document the editor really has open, and the caller published an empty
/// diagnostic list for it -- reporting a real file as clean -- back when both
/// came back as `None`.
#[must_use]
pub fn path_from_uri(uri: &str) -> UriPath {
    let Some(rest) = uri.strip_prefix("file://") else {
        return UriPath::NotLocal;
    };
    let encoded = match rest.strip_prefix('/') {
        // `file:///C:/src`: the first slash belongs to the URI grammar, not to
        // the path.
        Some(drive) if drive.as_bytes().get(1) == Some(&b':') => drive.to_owned(),
        // `file:///a/b`: the slash *is* the root of the path.
        Some(_) => rest.to_owned(),
        // `file://server/share`: an authority, which is a UNC path. The inverse
        // of the branch `gearbox_ir::file_uri` takes for one.
        None => format!("//{rest}"),
    };

    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        // A `%` that does not begin a valid escape is a literal `%`, which is a
        // legal character in a filename. Failing the whole decode instead would
        // answer "this is not a local file" for a file that is one -- and the
        // two bytes after an unencoded `%` are not even usually hex: in
        // `100%€.gdl` they are the first half of a multi-byte character, so
        // `from_utf8` is exactly as likely to be what fails as `from_str_radix`.
        // Both fall through to the same place.
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3])
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    match String::from_utf8(out) {
        Ok(decoded) => UriPath::Local(normalized(Path::new(&decoded))),
        Err(_) => UriPath::Undecodable,
    }
}

/// What a `textDocument` URI names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UriPath {
    /// A path on this machine, lexically normalized.
    Local(PathBuf),
    /// Not a `file:` URI at all, so there is no path to answer with.
    NotLocal,
    /// A `file:` URI whose percent-escapes do not decode as UTF-8.
    ///
    /// Separate from [`Self::NotLocal`] because the two need different answers:
    /// this one is about a document the editor is showing, so it is reported
    /// rather than treated as somebody else's file.
    Undecodable,
}

impl UriPath {
    /// The path, when the URI named one.
    #[must_use]
    pub fn local(&self) -> Option<&Path> {
        match self {
            Self::Local(path) => Some(path),
            Self::NotLocal | Self::Undecodable => None,
        }
    }
}

/// `path` with `.` dropped and `..` collapsed, without asking the filesystem.
///
/// A `..` with nothing left to pop is kept rather than dropped: swallowing it
/// would quietly rewrite a path that climbs above its own root into one that
/// does not, which is the opposite of what the caller needs.
fn normalized(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(Component::ParentDir);
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// Whether this diagnostic may be underlined in `uri`.
///
/// **Two conditions, and the second is the decision this slice turns on**
/// (`cpt-gearbox-adr-gdl-language-server`): the diagnostic must be about *this*
/// document, and it must say *where* in it.
///
/// 81 diagnostics in `gearbox-engine` are built with `Location::file`, which is
/// `Range::whole_file` -- the sentinel meaning "this file", not "here". Publishing those would put a marker at the very start of
/// the document, and that is not a less precise claim about where the error is,
/// it is a false one. They still reach the person through the Problems panel by
/// way of the resolution, anchored to the file without pretending to a position.
///
/// **A zero-width range is not the same thing as that sentinel**, and the
/// distinction is load-bearing. `gear(\n  name = "Demo",` -- the unclosed call --
/// reports at line 2, column 0, with nothing between start and end, because the
/// error is a *point*: the place the expression should have continued. Excluding
/// empty ranges rather than the sentinel would silently drop every truncated
/// file, which is the commonest thing a half-typed description is.
///
/// Stated as a property of the range rather than as a list of diagnostic codes on
/// purpose. A list would be a second place recording which diagnostics have
/// spans, and it would be wrong the first time somebody gave one to a semantic
/// check; this way that check begins to underline itself and no server code
/// changes.
#[must_use]
pub fn publishable(diagnostic: &Diagnostic, uri: &str) -> bool {
    diagnostic
        .location
        .as_ref()
        .is_some_and(|location| location.uri == uri && location.range != Range::whole_file())
}

/// One engine diagnostic as an LSP one.
///
/// `help` is folded into the message, exactly as `resolution-markers.ts` does on
/// the other path and for the same reason: an editor shows one line per marker,
/// and for an error `help` is where the actionable half lives
/// (`cpt-gearbox-nfr-actionable-diagnostics`). Dropping it would leave the
/// squiggle saying what is wrong and not what to do.
///
/// By value, because this runs per keystroke over a collection the caller drops
/// immediately afterwards: every string here -- the message, the help, each
/// related entry -- moves instead of being copied.
#[must_use]
pub fn to_lsp(diagnostic: Diagnostic) -> LspDiagnostic {
    LspDiagnostic {
        range: diagnostic
            .location
            .as_ref()
            .map_or_else(Range::whole_file, |location| location.range),
        severity: severity_of(diagnostic.severity),
        code: diagnostic.code.as_str().to_owned(),
        source: "gearbox".to_owned(),
        message: match diagnostic.help {
            None => diagnostic.message,
            Some(help) if help.is_empty() => diagnostic.message,
            Some(help) => format!("{} — {help}", diagnostic.message),
        },
        related_information: diagnostic
            .related
            .into_iter()
            .map(|related| DiagnosticRelatedInformation {
                location: related.location,
                message: related.message,
            })
            .collect(),
    }
}

/// LSP's `DiagnosticSeverity`, which is a number and starts at one.
const fn severity_of(severity: Severity) -> u8 {
    match severity {
        Severity::Error => 1,
        Severity::Warning => 2,
        Severity::Info => 3,
        Severity::Hint => 4,
    }
}

/// How much of a document the client must resend on each edit.
///
/// `Full`, spelled as LSP's `TextDocumentSyncKind` number. Incremental sync would
/// buy nothing: evaluating a whole `.gdl` costs milliseconds, so the work saved
/// is smaller than the bookkeeping needed to apply the ranges correctly.
pub const SYNC_FULL: u8 = 1;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocumentItem {
    pub uri: String,
    #[serde(default)]
    pub language_id: String,
    /// LSP requires it; a client that omits it gets `None`, not `0`.
    ///
    /// `0` is a version a client can really be at, so defaulting to it would
    /// have this server *claim* a version it was never told -- and the claim is
    /// echoed back on `publishDiagnostics`, where a client compares versions to
    /// drop answers a later keystroke has already outdated. Refusing the
    /// notification outright is the opposite over-answer: the text is there and
    /// evaluates fine, so the honest report is "these are for this text, at no
    /// version I can name".
    #[serde(default)]
    pub version: Option<i32>,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocumentIdentifier {
    pub uri: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionedTextDocumentIdentifier {
    pub uri: String,
    /// Optional for the same reason as [`TextDocumentItem::version`], and it has
    /// to be the same reason: between them they are every way a version enters.
    #[serde(default)]
    pub version: Option<i32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DidOpenTextDocumentParams {
    pub text_document: TextDocumentItem,
}

/// One whole-document replacement per edit.
///
/// LSP allows a `range` beside the text, for incremental sync. This server
/// advertises `Full`, so a well-behaved client never sends one and the field is
/// not read -- a client that sends one anyway is told, rather than having part of
/// its edit silently ignored.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocumentContentChangeEvent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<Range>,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DidChangeTextDocumentParams {
    pub text_document: VersionedTextDocumentIdentifier,
    pub content_changes: Vec<TextDocumentContentChangeEvent>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DidCloseTextDocumentParams {
    pub text_document: TextDocumentIdentifier,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishDiagnosticsParams {
    pub uri: String,
    /// The document version these diagnostics were computed from, echoed so a
    /// client can drop an answer that a later keystroke has already outdated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<i32>,
    pub diagnostics: Vec<LspDiagnostic>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnostic {
    pub range: Range,
    /// 1 error, 2 warning, 3 information, 4 hint.
    pub severity: u8,
    /// The Gearbox code, e.g. `GBX0101`, so `gearbox explain` takes it unchanged.
    pub code: String,
    pub source: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related_information: Vec<DiagnosticRelatedInformation>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRelatedInformation {
    pub location: Location,
    pub message: String,
}
