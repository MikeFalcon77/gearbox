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
        Some(PathBuf::from("/a/b/gear.gdl"))
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
        Some(PathBuf::from("C:/src/gear.gdl"))
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
        Some(PathBuf::from("//server/share/gear.gdl"))
    );
    let path = PathBuf::from("//server/share/gear.gdl");
    assert_eq!(
        path_from_uri(&gearbox_ir::file_uri(&path)),
        Some(path),
        "the two halves must agree, or a UNC document is two documents"
    );
}

/// Anything that is not a `file:` URI has no path to offer.
#[test]
fn an_untitled_buffer_has_no_path() {
    assert_eq!(path_from_uri("untitled:Untitled-1"), None);
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
        Some(PathBuf::from("/a/100%\u{20ac}.gdl")),
        "a stray `%` must not turn a local file into `not a local file`"
    );
    assert_eq!(
        path_from_uri("file:///a/100%.gdl"),
        Some(PathBuf::from("/a/100%.gdl")),
        "`%.g` is not hex, so the `%` stands"
    );
    assert_eq!(
        path_from_uri("file:///a/b%"),
        Some(PathBuf::from("/a/b%")),
        "a trailing `%` has no two bytes after it at all"
    );
    assert_eq!(
        path_from_uri("file:///a/%E2%82%AC.gdl"),
        Some(PathBuf::from("/a/\u{20ac}.gdl")),
        "and a properly encoded one still decodes, or the fix traded one bug for another"
    );
}

/// `..` is collapsed before anyone compares the path to a source root.
///
/// `Path::starts_with` is a component comparison, so an unnormalized
/// `/root/../etc/gear.gdl` satisfies `starts_with("/root")` while naming a file
/// that is nowhere near it.
#[test]
fn a_dot_dot_uri_is_collapsed() {
    let path = path_from_uri("file:///allowed/root/../../etc/gear.gdl").unwrap();
    assert_eq!(path, PathBuf::from("/etc/gear.gdl"));
    assert!(
        !path.starts_with("/allowed/root"),
        "the whole point: the boundary check must see where the path really goes"
    );
    assert_eq!(
        path_from_uri("file:///a/./b/c/../gear.gdl"),
        Some(PathBuf::from("/a/b/gear.gdl"))
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
