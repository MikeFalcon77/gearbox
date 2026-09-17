//! Tests for `ClusterProfile` projection.
//!
//! The first fixture is the `event-broker` marker as the platform's cluster
//! crate declares it, because it carries both traps at once: a private marker,
//! and a `NAME` that is not the kebab-case of the identifier. It is not a
//! transcription of a production impl -- there was none when this was written;
//! the demo corpus's requester carries the first one.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::PathBuf;

use super::*;
use crate::test_corpus::require;

fn file(src: &str) -> RustFile {
    RustFile {
        path: PathBuf::from("domain/cluster.rs"),
        relative: PathBuf::from("domain/cluster.rs"),
        ast: syn::parse_file(src).expect("fixture parses"),
    }
}

/// Parse a single file from the sibling checkout, if present.
fn tree_file(rel: &str) -> Option<RustFile> {
    let path = crate::test_corpus::corpus(rel)?;
    let text = std::fs::read_to_string(&path).ok()?;
    Some(RustFile {
        path,
        relative: PathBuf::from(rel),
        ast: syn::parse_file(&text).ok()?,
    })
}

/// Project, with the error channel unwrapped so an assertion is about profiles.
fn profiles(files: &[RustFile]) -> Vec<ProjectedProfile> {
    project_cluster_profiles(files).unwrap_or_else(|e| panic!("project: {e}"))
}

/// Verbatim from `event-broker/src/domain/cluster.rs`.
const EVENT_BROKER: &str = r#"
#[derive(Debug, Clone, Copy)]
struct EventBrokerProfile;

impl ClusterProfile for EventBrokerProfile {
    const NAME: &'static str = "event-broker";
}
"#;

#[test]
fn name_is_read_not_derived_from_the_ident() {
    let got = profiles(&[file(EVENT_BROKER)]);
    assert_eq!(got.len(), 1, "one impl, one profile");
    assert_eq!(
        got[0].name, "event-broker",
        "the name must come from `const NAME`; deriving it from the ident would \
         yield `event-broker-profile` and be wrong on the only real instance"
    );
    assert_eq!(got[0].marker_ident, "EventBrokerProfile");
}

#[test]
fn a_private_marker_and_a_public_one_project_identically() {
    // Visibility is never required: the platform spells the `event-broker`
    // marker without `pub`. Asserted by comparing the two rather than by
    // checking the fixture's own text for "pub struct", which could only fail if
    // someone edited the fixture and said nothing about the projector.
    let private = profiles(&[file(
        r#"
        struct P;
        impl ClusterProfile for P { const NAME: &'static str = "primary"; }
        "#,
    )]);
    let public = profiles(&[file(
        r#"
        pub struct P;
        impl ClusterProfile for P { const NAME: &'static str = "primary"; }
        "#,
    )]);
    assert_eq!(private, public, "visibility is not part of the projection");
    assert_eq!(private.len(), 1);
}

#[test]
fn location_points_at_the_impl() {
    let got = profiles(&[file(EVENT_BROKER)]);
    assert_eq!(got[0].relative, PathBuf::from("domain/cluster.rs"));
    assert_eq!(
        got[0].line, 5,
        "1-based line of the `impl`, so an editor can jump to it"
    );
}

#[test]
fn a_non_literal_name_is_reported_rather_than_skipped() {
    // A dropped profile reads as a crate that implements none, and
    // `check_profiles` then raises `ClusterProfileNotImplemented` against a
    // crate that does implement it -- pointing the reader at the wrong file.
    let src = r#"
        impl ClusterProfile for Computed {
            const NAME: &'static str = concat!("a", "b");
        }
    "#;
    let err = project_cluster_profiles(&[file(src)]).unwrap_err();
    match &err {
        ProfileProjectionError::UnreadableName { marker_ident, .. } => {
            assert_eq!(marker_ident, "Computed");
        }
        other @ ProfileProjectionError::InvalidName { .. } => {
            panic!("expected UnreadableName, got {other}")
        }
    }
    assert!(
        err.to_string().contains("domain/cluster.rs"),
        "the message must name the file to edit: {err}"
    );
}

/// `NAME` through a `&str` const, the way `project_provider_name` reads a
/// provider's `PROVIDER_NAME`. There is no reason a marker may not spell it that
/// way, and reporting it as unreadable would be a refusal over a shape that has
/// a readable meaning.
#[test]
fn a_name_behind_a_const_resolves() {
    let src = r#"
        pub const PROFILE_NAME: &str = "event-broker";
        impl ClusterProfile for P { const NAME: &'static str = PROFILE_NAME; }
    "#;
    let got = profiles(&[file(src)]);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].name, "event-broker");
}

/// The name becomes a `ClientScope` segment: the SDK resolves
/// `ClientScope::new("cluster:{name}")`, so a `NAME` containing `:` resolves
/// into a different scope namespace than the one it declares.
#[test]
fn a_name_that_is_not_a_profile_id_is_refused() {
    let src = r#"
        impl ClusterProfile for Sneaky {
            const NAME: &'static str = "primary:extra";
        }
    "#;
    let err = project_cluster_profiles(&[file(src)]).unwrap_err();
    assert!(
        matches!(err, ProfileProjectionError::InvalidName { .. }),
        "got {err}"
    );
    assert!(
        err.to_string().contains("Sneaky"),
        "the message must name the marker: {err}"
    );
}

#[test]
fn several_profiles_in_one_crate_sort_by_name() {
    let src = r#"
        impl ClusterProfile for Zulu { const NAME: &'static str = "zulu"; }
        impl ClusterProfile for Alpha { const NAME: &'static str = "alpha"; }
    "#;
    let names: Vec<String> = profiles(&[file(src)]).into_iter().map(|p| p.name).collect();
    assert_eq!(names, vec!["alpha".to_owned(), "zulu".to_owned()]);
}

#[test]
fn unrelated_impls_are_ignored() {
    let src = r#"
        impl SomethingElse for Thing { const NAME: &'static str = "nope"; }
        impl Thing { const NAME: &'static str = "also-nope"; }
    "#;
    assert!(profiles(&[file(src)]).is_empty());
}

#[test]
fn real_profiles_project_from_the_cluster_examples() {
    // The only `impl ClusterProfile`s on `main` live in the cluster crate's
    // tests and examples, so that is where the real-source check has to look.
    let f = require!(tree_file(
        "gears/system/cluster/cluster/examples/multi_profile.rs"
    ));

    let names: Vec<String> = profiles(&[f]).into_iter().map(|p| p.name).collect();
    assert_eq!(
        names,
        vec!["analytics".to_owned(), "primary".to_owned()],
        "one application binds a distinct backend under each typed profile; both \
         must project"
    );
}
