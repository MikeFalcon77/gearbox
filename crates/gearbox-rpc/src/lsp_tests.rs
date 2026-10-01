//! The pure functions on the `textDocument/*` wire: URI decoding, and the
//! severity numbering LSP defines.
//!
//! Separate from `document_tests.rs`, which drives the whole handler over a
//! connection. These have no server in them on purpose -- the shapes they cover
//! are ones no fixture on this developer's machine can produce (a Windows drive
//! letter, a UNC share) or ones the description evaluator does not currently
//! emit (a warning with a position). A bug in either would otherwise ship
//! silently, because the suite would go on being green about the one case it
//! can reach.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use super::*;

/// The plain POSIX shape, which is the one every other test happens to exercise.
#[test]
fn a_posix_uri_keeps_its_leading_slash() {
    assert_eq!(
        path_from_uri("file:///a/b/gear.gdl"),
        UriPath::Local(PathBuf::from("/a/b/gear.gdl"))
    );
}

/// `file:///C:/src`: the first slash is the URI's, not the path's.
///
/// Untestable through a fixture on a POSIX machine -- no such path can be
/// created here -- and wrong in a way that would only ever be reported by a
/// Windows user, as "diagnostics do not work".
#[test]
fn a_windows_drive_uri_drops_the_grammar_slash() {
    assert_eq!(
        path_from_uri("file:///C:/src/gear.gdl"),
        UriPath::Local(PathBuf::from("C:/src/gear.gdl"))
    );
}

/// `file://server/share`: an authority, which is a UNC path.
///
/// The inverse of the branch `gearbox_ir::file_uri` takes for one, so the two
/// are asserted to round-trip rather than asserted apart: a change to either
/// spelling that forgot the other would pass a test written only against this
/// side.
#[test]
fn a_unc_uri_becomes_a_double_slashed_path() {
    assert_eq!(
        path_from_uri("file://server/share/gear.gdl"),
        UriPath::Local(PathBuf::from("//server/share/gear.gdl"))
    );
    let path = PathBuf::from("//server/share/gear.gdl");
    assert_eq!(
        path_from_uri(&gearbox_ir::file_uri(&path)),
        UriPath::Local(path),
        "the two halves must agree, or a UNC document is two documents"
    );
}

/// Anything that is not a `file:` URI has no path to offer.
#[test]
fn an_untitled_buffer_has_no_path() {
    assert_eq!(path_from_uri("untitled:Untitled-1"), UriPath::NotLocal);
}

/// A `%` that begins no valid escape is a literal `%`.
///
/// The regression this guards is not the `%` itself but what used to follow it:
/// the decode propagated the failure out of the *whole* function, so a real file
/// answered `None` and its diagnostics stopped publishing with nothing logged
/// anywhere. `%€` is the realistic shape -- the two bytes after the `%` are the
/// first half of a multi-byte character, so they are not valid UTF-8 either, and
/// both failure modes fall through the same branch.
#[test]
fn an_unescaped_percent_is_a_literal_percent() {
    assert_eq!(
        path_from_uri("file:///a/100%\u{20ac}.gdl"),
        UriPath::Local(PathBuf::from("/a/100%\u{20ac}.gdl")),
        "a stray `%` must not turn a local file into `not a local file`"
    );
    assert_eq!(
        path_from_uri("file:///a/100%.gdl"),
        UriPath::Local(PathBuf::from("/a/100%.gdl")),
        "`%.g` is not hex, so the `%` stands"
    );
    assert_eq!(
        path_from_uri("file:///a/b%"),
        UriPath::Local(PathBuf::from("/a/b%")),
        "a trailing `%` has no two bytes after it at all"
    );
    assert_eq!(
        path_from_uri("file:///a/%E2%82%AC.gdl"),
        UriPath::Local(PathBuf::from("/a/\u{20ac}.gdl")),
        "and a properly encoded one still decodes, or the fix traded one bug for another"
    );
}

/// An escape that decodes to bytes no path can be made of is its own answer.
///
/// `%FF` is a valid escape and not valid UTF-8, so it is the case the decode
/// cannot answer with a path -- and it used to come back as the same `None` an
/// `untitled:` buffer gets, which the caller reads as "not a local file" and
/// turns into an empty diagnostic list: a document the editor is showing,
/// reported as clean. The variant is the whole point; without it there is nothing
/// for the handler to report.
#[test]
fn an_escape_that_is_not_utf8_is_not_the_same_as_not_a_file() {
    assert_eq!(path_from_uri("file:///a/%FF.gdl"), UriPath::Undecodable);
    assert_ne!(
        path_from_uri("file:///a/%FF.gdl"),
        UriPath::NotLocal,
        "a `file://` URI this server cannot decode is not somebody else's buffer"
    );
    assert_eq!(
        path_from_uri("file:///a/%FF.gdl").local(),
        None,
        "and there is still no path to evaluate against"
    );
}

/// `..` is collapsed before anyone compares the path to a source root.
///
/// `Path::starts_with` is a component comparison, so an unnormalized
/// `/root/../etc/gear.gdl` satisfies `starts_with("/root")` while naming a file
/// that is nowhere near it.
#[test]
fn a_dot_dot_uri_is_collapsed() {
    let path = path_from_uri("file:///allowed/root/../../etc/gear.gdl")
        .local()
        .expect("a `file://` URI that decodes")
        .to_path_buf();
    assert_eq!(path, PathBuf::from("/etc/gear.gdl"));
    assert!(
        !path.starts_with("/allowed/root"),
        "the whole point: the boundary check must see where the path really goes"
    );
    assert_eq!(
        path_from_uri("file:///a/./b/c/../gear.gdl"),
        UriPath::Local(PathBuf::from("/a/b/gear.gdl"))
    );
}

/// A `..` with nothing left to pop survives the normalization.
///
/// The arm the two cases above never reach, and the one the doc comment on
/// `normalized` calls load bearing: swallowing a climb above the root would
/// rewrite a path that leaves its root into one that stays inside it, and the
/// caller's `starts_with` against a source root would then answer about a
/// different file than the one named.
#[test]
fn a_dot_dot_above_the_root_is_kept() {
    assert_eq!(
        path_from_uri("file:///../etc/gear.gdl"),
        UriPath::Local(PathBuf::from("/../etc/gear.gdl")),
        "the climb must stay in the result, or a path that leaves its root looks like one \
         that does not"
    );
}

/// A diagnostic about another file is not underlined in this one.
///
/// The half of `publishable` no fixture in this crate reaches: a diagnostic
/// reported inside a `load()`ed fragment carries the fragment's URI, and
/// published under the open document's it would put a marker at a position taken
/// from a file the editor is not showing.
#[test]
fn a_diagnostic_about_another_file_is_not_published_here() {
    let span = Range::new(
        gearbox_ir::Position::new(3, 0),
        gearbox_ir::Position::new(3, 7),
    );
    let elsewhere = Diagnostic::error(
        gearbox_ir::DiagnosticCode::GdlEval,
        "the fragment is what is wrong",
        "fix the fragment",
    )
    .at(Location::new("file:///root/shared.gdl", span));

    assert!(
        !publishable(&elsewhere, "file:///root/gears/demo/gear.gdl"),
        "a span in another file must not be underlined in this one"
    );
    assert!(
        publishable(&elsewhere, "file:///root/shared.gdl"),
        "and the same diagnostic is publishable in the file it is about, or this test \
         would pass against a `publishable` that refuses everything"
    );
}

/// `help` is folded into the message, and an empty one adds no separator.
///
/// `to_lsp` is the only path by which `help` reaches the editor, so a lost
/// `help` leaves the squiggle saying what is wrong and not what to do -- and a
/// separator appended to nothing is a message ending in a dash.
#[test]
fn help_is_folded_into_the_message_only_when_there_is_help() {
    let base = Diagnostic::new(
        gearbox_ir::DiagnosticCode::GdlEval,
        "`name` must be a string",
    );

    let mut absent = base.clone();
    absent.help = None;
    assert_eq!(to_lsp(absent).message, "`name` must be a string");

    let empty = base.clone().with_help("");
    assert_eq!(
        to_lsp(empty).message,
        "`name` must be a string",
        "an empty `help` must not append a separator to nothing"
    );

    let present = base.with_help("quote it");
    assert_eq!(
        to_lsp(present).message,
        "`name` must be a string \u{2014} quote it",
        "the separator is an em dash, which is what the other path uses"
    );
}

/// LSP's `DiagnosticSeverity` is a number, it starts at one, and it is not the
/// order `Severity` happens to declare its variants in.
///
/// Only `Error` is reachable from a description fixture today, so a swapped
/// `Warning`/`Info` arm would go unnoticed until a semantic check with a span
/// shipped -- and then it would show up as the wrong colour of squiggle, which
/// nobody files a bug about.
#[test]
fn every_severity_maps_to_its_lsp_number() {
    assert_eq!(severity_of(Severity::Error), 1);
    assert_eq!(severity_of(Severity::Warning), 2);
    assert_eq!(severity_of(Severity::Info), 3);
    assert_eq!(severity_of(Severity::Hint), 4);
}

/// A missing `version` is absent, not zero.
///
/// `0` is a version a client can really be at, so a default would have the
/// server claim one it was never told -- on the field a client uses to decide
/// whether an answer is stale.
#[test]
fn a_missing_version_deserializes_as_none() {
    let item: TextDocumentItem =
        serde_json::from_value(serde_json::json!({ "uri": "file:///a/gear.gdl", "text": "" }))
            .expect("version is optional, but the notification is still readable");
    assert_eq!(item.version, None);

    let versioned: VersionedTextDocumentIdentifier =
        serde_json::from_value(serde_json::json!({ "uri": "file:///a/gear.gdl" }))
            .expect("same on the `didChange` side");
    assert_eq!(versioned.version, None);

    let given: TextDocumentItem = serde_json::from_value(
        serde_json::json!({ "uri": "file:///a/gear.gdl", "version": 0, "text": "" }),
    )
    .expect("a real version 0");
    assert_eq!(
        given.version,
        Some(0),
        "and a client that really is at 0 must be distinguishable from one that said nothing"
    );
}
