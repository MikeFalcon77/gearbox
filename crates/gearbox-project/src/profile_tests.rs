//! Tests for `ClusterProfile` projection.
//!
//! The first fixture is a transcription of `event-broker/src/domain/cluster.rs`
//! -- the platform's only production `impl ClusterProfile` -- because it carries
//! both traps at once: a private marker, and a `NAME` that is not the kebab-case
//! of the identifier.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::PathBuf;

use super::*;

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
    let got = project_cluster_profiles(&[file(EVENT_BROKER)]);
    assert_eq!(got.len(), 1, "one impl, one profile");
    assert_eq!(
        got[0].name, "event-broker",
        "the name must come from `const NAME`; deriving it from the ident would \
         yield `event-broker-profile` and be wrong on the only real instance"
    );
    assert_eq!(got[0].marker_ident, "EventBrokerProfile");
}

#[test]
fn a_private_marker_still_projects() {
    // `struct EventBrokerProfile;` has no `pub`. Requiring visibility would miss
    // the only production profile in the platform.
    assert!(!EVENT_BROKER.contains("pub struct"));
    assert_eq!(project_cluster_profiles(&[file(EVENT_BROKER)]).len(), 1);
}

#[test]
fn location_points_at_the_impl() {
    let got = project_cluster_profiles(&[file(EVENT_BROKER)]);
    assert_eq!(got[0].relative, PathBuf::from("domain/cluster.rs"));
    assert_eq!(
        got[0].line, 5,
        "1-based line of the `impl`, so an editor can jump to it"
    );
}

#[test]
fn a_non_literal_name_is_skipped_rather_than_guessed() {
    let src = r#"
        impl ClusterProfile for Computed {
            const NAME: &'static str = concat!("a", "b");
        }
    "#;
    assert!(
        project_cluster_profiles(&[file(src)]).is_empty(),
        "an unreadable name must yield no profile; inventing one would make the \
         join key silently wrong"
    );
}

#[test]
fn several_profiles_in_one_crate_sort_by_name() {
    let src = r#"
        impl ClusterProfile for Zulu { const NAME: &'static str = "zulu"; }
        impl ClusterProfile for Alpha { const NAME: &'static str = "alpha"; }
    "#;
    let names: Vec<String> = project_cluster_profiles(&[file(src)])
        .into_iter()
        .map(|p| p.name)
        .collect();
    assert_eq!(names, vec!["alpha".to_owned(), "zulu".to_owned()]);
}

#[test]
fn unrelated_impls_are_ignored() {
    let src = r#"
        impl SomethingElse for Thing { const NAME: &'static str = "nope"; }
        impl Thing { const NAME: &'static str = "also-nope"; }
    "#;
    assert!(project_cluster_profiles(&[file(src)]).is_empty());
}

#[test]
fn real_profiles_project_from_the_cluster_examples() {
    // The only `impl ClusterProfile`s on `main` live in the cluster crate's
    // tests and examples, so that is where the real-source check has to look.
    let Some(f) = tree_file("gears/system/cluster/cluster/examples/multi_profile.rs") else {
        eprintln!("skipping: ../gears-rust not present");
        return;
    };

    let names: Vec<String> = project_cluster_profiles(&[f])
        .into_iter()
        .map(|p| p.name)
        .collect();
    assert_eq!(
        names,
        vec!["analytics".to_owned(), "primary".to_owned()],
        "one process binds a distinct backend under each typed profile; both \
         must project"
    );
}
