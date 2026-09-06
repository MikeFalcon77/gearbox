//! Tests for cluster projection.
//!
//! The fixtures reproduce the exact shapes found in `gears-rust` so the traps
//! are covered even when the sibling checkout is absent; the real-tree tests
//! then prove the fixtures did not drift from what they mirror.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::PathBuf;

use super::*;
use crate::scan::scan_crate;

fn file(src: &str) -> RustFile {
    RustFile {
        path: PathBuf::from("fixture.rs"),
        relative: PathBuf::from("fixture.rs"),
        ast: syn::parse_file(src).expect("fixture parses"),
    }
}

/// The plugin crate directories, when the sibling checkout is present.
fn plugin(name: &str) -> Option<Vec<RustFile>> {
    let dir = crate::test_corpus::corpus(&format!("gears/system/cluster/plugins/{name}"))?;
    Some(scan_crate(&dir).unwrap_or_else(|e| panic!("scan plugin {name}: {e}")))
}

fn cluster_crate() -> Option<Vec<RustFile>> {
    let dir = crate::test_corpus::corpus("gears/system/cluster/cluster")?;
    Some(scan_crate(&dir).unwrap_or_else(|e| panic!("scan cluster: {e}")))
}

macro_rules! require {
    ($e:expr) => {
        match $e {
            Some(v) => v,
            None => {
                eprintln!("skipping: ../gears-rust not present");
                return;
            }
        }
    };
}

// ---------------------------------------------------------------- registry

/// Mirrors `ClusterGear::provider_registry()` verbatim.
const REGISTRY: &str = r"
impl ClusterGear {
    fn provider_registry() -> ProviderRegistry {
        ProviderRegistry::new()
            .with_cache_provider(Arc::new(standalone_cluster_plugin::StandaloneCacheProvider))
            .with_cache_provider(Arc::new(postgres_cluster_plugin::PostgresCacheProvider))
            .with_lock_provider(Arc::new(postgres_cluster_plugin::PostgresLockProvider))
    }
}
";

#[test]
fn registry_projects_in_source_order() {
    let got = project_provider_registry(&[file(REGISTRY)]).expect("project");
    let shape: Vec<(ClusterPrimitive, &str, &str)> = got
        .iter()
        .map(|p| (p.primitive, p.plugin_lib.as_str(), p.provider_type.as_str()))
        .collect();

    assert_eq!(
        shape,
        vec![
            (
                ClusterPrimitive::Cache,
                "standalone_cluster_plugin",
                "StandaloneCacheProvider"
            ),
            (
                ClusterPrimitive::Cache,
                "postgres_cluster_plugin",
                "PostgresCacheProvider"
            ),
            (
                ClusterPrimitive::Lock,
                "postgres_cluster_plugin",
                "PostgresLockProvider"
            ),
        ],
        "the chain must project in source order, since operator config resolves \
         a provider by name and the registry is last-write-wins"
    );
}

#[test]
fn registry_registers_no_leader_election_provider() {
    let got = project_provider_registry(&[file(REGISTRY)]).expect("project");
    assert!(
        !got.iter()
            .any(|p| p.primitive == ClusterPrimitive::LeaderElection),
        "no plugin registers leader election; it always falls through to the \
         SDK compare-and-swap default, and the catalogue must say so"
    );
}

#[test]
fn registry_projects_from_the_real_tree() {
    let files = require!(cluster_crate());
    let got = project_provider_registry(&files).expect("project");
    assert_eq!(
        got,
        project_provider_registry(&[file(REGISTRY)]).expect("project"),
        "the fixture has drifted from the real provider_registry()"
    );
}

// ---------------------------------------------------------------- names

#[test]
fn provider_name_resolves_through_a_const() {
    let src = r#"
        pub const PROVIDER_NAME: &str = "standalone";
        impl ClusterCacheProvider for StandaloneCacheProvider {
            fn provider(&self) -> &'static str { PROVIDER_NAME }
        }
    "#;
    assert_eq!(
        project_provider_name(&[file(src)], "StandaloneCacheProvider").unwrap(),
        "standalone"
    );
}

#[test]
fn provider_name_accepts_a_literal() {
    let src = r#"
        impl ClusterLockProvider for Whatever {
            fn provider(&self) -> &'static str { "inline" }
        }
    "#;
    assert_eq!(
        project_provider_name(&[file(src)], "Whatever").unwrap(),
        "inline"
    );
}

#[test]
fn provider_name_refuses_an_unresolvable_const() {
    let src = r"
        impl ClusterCacheProvider for Thing {
            fn provider(&self) -> &'static str { SOME_OTHER_CRATE_NAME }
        }
    ";
    let err = project_provider_name(&[file(src)], "Thing").unwrap_err();
    assert!(
        matches!(err, ClusterProjectionError::ProviderName { .. }),
        "an unreadable name must be reported, not silently dropped: {err}"
    );
    assert!(
        err.to_string().contains("SOME_OTHER_CRATE_NAME"),
        "the message must name the const it could not resolve: {err}"
    );
}

#[test]
fn provider_names_come_from_the_real_plugins() {
    let standalone = require!(plugin("standalone-cluster-plugin"));
    let postgres = require!(plugin("postgres-cluster-plugin"));

    assert_eq!(
        project_provider_name(&standalone, "StandaloneCacheProvider").unwrap(),
        "standalone"
    );
    assert_eq!(
        project_provider_name(&postgres, "PostgresCacheProvider").unwrap(),
        "postgres"
    );
    assert_eq!(
        project_provider_name(&postgres, "PostgresLockProvider").unwrap(),
        "postgres"
    );
}

// ---------------------------------------------------------------- capabilities

fn caps(files: &[RustFile], primitive: ClusterPrimitive) -> Vec<String> {
    let mut v: Vec<String> = project_backend_capabilities(files, primitive, "fixture", None)
        .unwrap()
        .into_iter()
        .map(|c| c.as_str().to_owned())
        .collect();
    v.sort();
    v
}

#[test]
fn cache_capabilities_read_both_axes() {
    let src = r"
        impl ClusterCacheBackend for StandaloneCache {
            fn consistency(&self) -> CacheConsistency { CacheConsistency::Linearizable }
            fn features(&self) -> CacheFeatures { CacheFeatures::new(true) }
        }
    ";
    assert_eq!(
        caps(&[file(src)], ClusterPrimitive::Cache),
        vec!["cluster.cache.linearizable", "cluster.cache.prefix-watch"]
    );
}

#[test]
fn prefix_watch_false_drops_the_capability() {
    let src = r"
        impl ClusterCacheBackend for PostgresCache {
            fn consistency(&self) -> CacheConsistency { CacheConsistency::Linearizable }
            fn features(&self) -> CacheFeatures { CacheFeatures::new(false) }
        }
    ";
    assert_eq!(
        caps(&[file(src)], ClusterPrimitive::Cache),
        vec!["cluster.cache.linearizable"],
        "postgres cannot route a prefix watch; that absence is what later makes \
         cache(linearizable + prefix_watch) unsatisfiable"
    );
}

#[test]
fn ambiguous_backend_impl_is_reported_with_candidates() {
    let src = r"
        impl ClusterCacheBackend for First {
            fn consistency(&self) -> CacheConsistency { CacheConsistency::Linearizable }
            fn features(&self) -> CacheFeatures { CacheFeatures::new(true) }
        }
        impl ClusterCacheBackend for Second {
            fn consistency(&self) -> CacheConsistency { CacheConsistency::Linearizable }
            fn features(&self) -> CacheFeatures { CacheFeatures::new(true) }
        }
    ";
    let err = project_backend_capabilities(&[file(src)], ClusterPrimitive::Cache, "fixture", None)
        .unwrap_err();
    match err {
        ClusterProjectionError::BackendAmbiguous { candidates, .. } => {
            assert_eq!(candidates, vec!["First".to_owned(), "Second".to_owned()]);
        }
        other => panic!("expected BackendAmbiguous, got {other}"),
    }
}

#[test]
fn missing_backend_impl_is_reported() {
    let err = project_backend_capabilities(&[file("")], ClusterPrimitive::Lock, "fixture", None)
        .unwrap_err();
    assert!(
        matches!(err, ClusterProjectionError::BackendNotFound { .. }),
        "got {err}"
    );
}

#[test]
fn an_added_feature_flag_is_an_error_not_a_default() {
    // `CacheFeatures` is #[non_exhaustive] with a positional constructor, so a
    // new flag changes the arity. Reading the wrong flag silently would be worse
    // than refusing.
    let src = r"
        impl ClusterCacheBackend for Future {
            fn consistency(&self) -> CacheConsistency { CacheConsistency::Linearizable }
            fn features(&self) -> CacheFeatures { CacheFeatures::new(true, false) }
        }
    ";
    let err = project_backend_capabilities(&[file(src)], ClusterPrimitive::Cache, "fixture", None)
        .unwrap_err();
    assert!(
        err.to_string().contains("must be updated"),
        "the message must say the projection needs updating: {err}"
    );
}

#[test]
fn a_computed_flag_is_not_read_as_a_plugin_capability() {
    // This is the SDK-default shape. A plugin backend must not be read this way.
    let src = r"
        impl DistributedLockBackend for CasBased {
            fn features(&self) -> LockFeatures {
                LockFeatures::new(self.cache.consistency() == CacheConsistency::Linearizable)
            }
        }
    ";
    let err = project_backend_capabilities(&[file(src)], ClusterPrimitive::Lock, "fixture", None)
        .unwrap_err();
    assert!(
        matches!(err, ClusterProjectionError::Capability { .. }),
        "got {err}"
    );
}

#[test]
fn capabilities_come_from_the_real_plugins() {
    let standalone = require!(plugin("standalone-cluster-plugin"));
    let postgres = require!(plugin("postgres-cluster-plugin"));

    assert_eq!(
        caps(&standalone, ClusterPrimitive::Cache),
        vec!["cluster.cache.linearizable", "cluster.cache.prefix-watch"]
    );
    assert_eq!(
        caps(&postgres, ClusterPrimitive::Cache),
        vec!["cluster.cache.linearizable"]
    );
    assert_eq!(
        caps(&postgres, ClusterPrimitive::Lock),
        vec!["cluster.lock.linearizable"]
    );
}

// ---------------------------------------------------------------- SDK defaults

#[test]
fn sdk_defaults_are_recognised_as_derived_from_the_cache() {
    let files = require!(cluster_crate());
    let got = project_sdk_defaults(&files);

    let primitives: Vec<ClusterPrimitive> = got.iter().map(|r| r.primitive).collect();
    assert!(
        primitives.contains(&ClusterPrimitive::LeaderElection)
            && primitives.contains(&ClusterPrimitive::Lock),
        "both fall-back primitives derive their capability from the bound cache; \
         got {primitives:?}"
    );
    assert!(
        got.iter().all(|r| r.linearizable_from_cache),
        "the rule is inheritance, not a fixed answer"
    );
}

#[test]
fn backend_narrowing_resolves_an_ambiguity() {
    // Two impls in one crate, in different files. Without narrowing this is
    // ambiguous; with it, the named file wins -- and it must be the *named*
    // one's flag that comes through, not either one's.
    let real = RustFile {
        path: PathBuf::from("cache.rs"),
        relative: PathBuf::from("cache.rs"),
        ast: syn::parse_file(
            r"
            impl ClusterCacheBackend for StandaloneCache {
                fn consistency(&self) -> CacheConsistency { CacheConsistency::Linearizable }
                fn features(&self) -> CacheFeatures { CacheFeatures::new(true) }
            }
            ",
        )
        .unwrap(),
    };
    let decoy = RustFile {
        path: PathBuf::from("other.rs"),
        relative: PathBuf::from("other.rs"),
        ast: syn::parse_file(
            r"
            impl ClusterCacheBackend for SecondCache {
                fn consistency(&self) -> CacheConsistency { CacheConsistency::Linearizable }
                fn features(&self) -> CacheFeatures { CacheFeatures::new(false) }
            }
            ",
        )
        .unwrap(),
    };
    let files = vec![real, decoy];

    assert!(
        matches!(
            project_backend_capabilities(&files, ClusterPrimitive::Cache, "fixture", None),
            Err(ClusterProjectionError::BackendAmbiguous { .. })
        ),
        "without narrowing this must refuse"
    );

    let mut got: Vec<String> = project_backend_capabilities(
        &files,
        ClusterPrimitive::Cache,
        "fixture",
        Some("src/cache.rs"),
    )
    .unwrap()
    .into_iter()
    .map(|c| c.as_str().to_owned())
    .collect();
    got.sort();
    assert_eq!(
        got,
        vec!["cluster.cache.linearizable", "cluster.cache.prefix-watch"],
        "the narrowed file's flag must win; picking the decoy's `false` would be \
         a silently wrong answer"
    );
}

#[test]
fn backend_narrowing_cannot_climb_out_of_the_crate() {
    let src = r"
        impl ClusterCacheBackend for C {
            fn consistency(&self) -> CacheConsistency { CacheConsistency::Linearizable }
            fn features(&self) -> CacheFeatures { CacheFeatures::new(true) }
        }
    ";
    let err = project_backend_capabilities(
        &[file(src)],
        ClusterPrimitive::Cache,
        "fixture",
        Some("../other-crate/src/cache.rs"),
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("climbs out of the crate"),
        "got {err}"
    );
}
