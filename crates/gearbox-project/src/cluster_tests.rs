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
use crate::test_corpus::require;

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

// ---------------------------------------------------------------- registry

/// Mirrors `ClusterGear::provider_registry()` verbatim.
///
/// **Including its shape, which is the part that drifted.** The corpus stopped
/// being one builder chain when the native Kubernetes plugin landed: the chain
/// is bound to a local, a `#[cfg(feature = "k8s")]` block adds three more
/// registrations, and the local is returned. The fixture kept the old shape, so
/// `registry_projects_from_the_real_tree` was the only thing that could notice
/// -- and what it noticed was five expected against **nothing** projected,
/// because the projector was reading the tail expression alone.
const REGISTRY: &str = r#"
impl ClusterGear {
    #[cfg_attr(not(feature = "k8s"), allow(unused_mut))]
    fn provider_registry() -> ProviderRegistry {
        let mut registry = ProviderRegistry::new()
            .with_cache_provider(Arc::new(standalone_cluster_plugin::StandaloneCacheProvider))
            .with_cache_provider(Arc::new(postgres_cluster_plugin::PostgresCacheProvider))
            .with_lock_provider(Arc::new(postgres_cluster_plugin::PostgresLockProvider))
            .with_cache_provider(Arc::new(redis_cluster_plugin::RedisCacheProvider))
            .with_lock_provider(Arc::new(redis_cluster_plugin::RedisLockProvider));
        #[cfg(feature = "k8s")]
        {
            registry = registry
                .with_cache_provider(Arc::new(k8s_cluster_plugin::K8sCacheProvider))
                .with_leader_election_provider(Arc::new(
                    k8s_cluster_plugin::K8sLeaderElectionProvider,
                ))
                .with_lock_provider(Arc::new(k8s_cluster_plugin::K8sLockProvider));
        }
        registry
    }
}
"#;

#[test]
fn registry_projects_in_source_order() {
    let got = project_provider_registry(&[file(REGISTRY)], "fixture").expect("project");
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
            (
                ClusterPrimitive::Cache,
                "redis_cluster_plugin",
                "RedisCacheProvider"
            ),
            (
                ClusterPrimitive::Lock,
                "redis_cluster_plugin",
                "RedisLockProvider"
            ),
            (
                ClusterPrimitive::Cache,
                "k8s_cluster_plugin",
                "K8sCacheProvider"
            ),
            (
                ClusterPrimitive::LeaderElection,
                "k8s_cluster_plugin",
                "K8sLeaderElectionProvider"
            ),
            (
                ClusterPrimitive::Lock,
                "k8s_cluster_plugin",
                "K8sLockProvider"
            ),
        ],
        "the chain must project in source order, since operator config resolves \
         a provider by name and the registry is last-write-wins"
    );
}

/// **This claim used to assert the opposite, and the corpus had already
/// falsified it.** For as long as there was no native leader election, "nothing
/// registers it, so it always falls through to the SDK compare-and-swap
/// default" was a fact worth pinning. `K8sLeaderElectionProvider` is the first
/// one in the tree, and it arrived on 2026-09-02 -- but this test kept passing,
/// because it asserts against the fixture and the fixture had not moved.
///
/// What is true now, and is the thing the resolver needs: leader election is
/// registered **only** under a cargo feature. A build without `k8s` still falls
/// through to the SDK default, and a catalogue that recorded the registration
/// as unconditional would say otherwise.
#[test]
fn leader_election_is_registered_only_under_a_feature() {
    let got = project_provider_registry(&[file(REGISTRY)], "fixture").expect("project");
    let leader: Vec<&ProjectedClusterProvider> = got
        .iter()
        .filter(|p| p.primitive == ClusterPrimitive::LeaderElection)
        .collect();
    assert_eq!(
        leader.len(),
        1,
        "the k8s plugin is the only one, got {leader:?}"
    );
    assert_eq!(
        leader[0].gated_by,
        FeatureGate::Feature("k8s".to_owned()),
        "an unconditional record would promise a backend a default build does not link"
    );
    assert!(
        got.iter()
            .filter(|p| p.plugin_lib != "k8s_cluster_plugin")
            .all(|p| p.gated_by == FeatureGate::Always),
        "the providers that are always there must not be marked as gated"
    );
}

/// The shape that broke, reduced: a body this cannot read is an error, and not
/// an empty registry.
///
/// The two were the same value, so `GBX0509`'s help told the reader to check a
/// builder chain that was there all along -- and every cluster provider left the
/// catalogue, not only the ones the new shape added.
#[test]
fn a_body_that_cannot_be_read_is_an_error_not_an_empty_registry() {
    let src = r"
impl ClusterGear {
    fn provider_registry() -> ProviderRegistry {
        build_it_somehow()
    }
}
";
    let err = project_provider_registry(&[file(src)], "fixture").unwrap_err();
    assert!(
        matches!(err, ClusterProjectionError::RegistryUnreadable { .. }),
        "expected RegistryUnreadable, got {err}"
    );
}

/// A predicate that is not one feature is recorded as unreadable, never as
/// "always".
///
/// The distinction is the whole reason `FeatureGate` has three states: a
/// registration nobody can place in a build must not be indistinguishable from
/// one that is in every build.
#[test]
fn a_cfg_this_cannot_reduce_to_one_feature_is_not_read_as_unconditional() {
    let src = r#"
impl ClusterGear {
    fn provider_registry() -> ProviderRegistry {
        let mut registry = ProviderRegistry::new()
            .with_cache_provider(Arc::new(standalone_cluster_plugin::StandaloneCacheProvider));
        #[cfg(all(feature = "k8s", target_os = "linux"))]
        {
            registry = registry.with_lock_provider(Arc::new(k8s_cluster_plugin::K8sLockProvider));
        }
        registry
    }
}
"#;
    let got = project_provider_registry(&[file(src)], "fixture").expect("project");
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].gated_by, FeatureGate::Always);
    assert!(
        matches!(got[1].gated_by, FeatureGate::Unreadable(_)),
        "got {:?}",
        got[1].gated_by
    );
}

#[test]
fn registry_projects_from_the_real_tree() {
    let files = require!(cluster_crate());
    let got = project_provider_registry(&files, "cluster").expect("project");
    assert_eq!(
        got,
        project_provider_registry(&[file(REGISTRY)], "fixture").expect("project"),
        "the fixture has drifted from the real provider_registry()"
    );
}

/// The case the doc on `walk_chain` calls out, and the one nothing reached: a
/// chain of three whose middle registration is unreadable yields two, which
/// looks exactly like a chain of two.
#[test]
fn an_unreadable_registration_in_the_middle_of_the_chain_is_an_error() {
    let src = r"
impl ClusterGear {
    fn provider_registry() -> ProviderRegistry {
        ProviderRegistry::new()
            .with_cache_provider(Arc::new(standalone_cluster_plugin::StandaloneCacheProvider))
            .with_cache_provider(make_provider())
            .with_lock_provider(Arc::new(redis_cluster_plugin::RedisLockProvider))
    }
}
";
    let err = project_provider_registry(&[file(src)], "fixture").unwrap_err();
    match &err {
        ClusterProjectionError::ProviderRegistration { setter, .. } => {
            assert_eq!(setter, "with_cache_provider");
        }
        other => panic!("expected ProviderRegistration, got {other}"),
    }
    assert!(
        err.to_string().contains("is not a path"),
        "the message must say what it could not read: {err}"
    );
}

/// Hop 1 used to accept silently what hop 3 reports as a caller error: two
/// impls with a `provider_registry` came back as one merged registry with
/// nothing saying there were two.
#[test]
fn two_provider_registry_impls_are_ambiguous_not_merged() {
    let src = r"
impl ClusterGear {
    fn provider_registry() -> ProviderRegistry {
        ProviderRegistry::new()
            .with_cache_provider(Arc::new(standalone_cluster_plugin::StandaloneCacheProvider))
    }
}
impl TestDoubleGear {
    fn provider_registry() -> ProviderRegistry {
        ProviderRegistry::new()
            .with_cache_provider(Arc::new(fake_plugin::FakeCacheProvider))
    }
}
";
    let err = project_provider_registry(&[file(src)], "fixture").unwrap_err();
    match err {
        ClusterProjectionError::RegistryAmbiguous { candidates, .. } => {
            assert_eq!(
                candidates,
                vec!["ClusterGear".to_owned(), "TestDoubleGear".to_owned()]
            );
        }
        other => panic!("expected RegistryAmbiguous, got {other}"),
    }
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
        .declared
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
        vec![
            "cluster.cache.linearizable",
            "cluster.cache.prefix-watch",
            "cluster.cache.watch"
        ]
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
        vec!["cluster.cache.linearizable", "cluster.cache.watch"],
        "postgres cannot route a prefix watch; that absence is what later makes \
         cache(linearizable + prefix_watch) unsatisfiable -- but `new` states an \
         exact-key watch whatever its argument says, and postgres serves one over \
         NOTIFY, so only the prefix half drops"
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
        vec![
            "cluster.cache.linearizable",
            "cluster.cache.prefix-watch",
            "cluster.cache.watch"
        ]
    );
    // **Postgres watches one key and not a family, and both halves are read.**
    // It was described by `linearizable` alone until `cluster.cache.watch`
    // existed, which understated it: its NOTIFY channel carries a single key per
    // payload, so an exact watch is served and only prefix routing is not
    // (DESIGN.md §4.3, quoted in the plugin's own `features`).
    assert_eq!(
        caps(&postgres, ClusterPrimitive::Cache),
        vec!["cluster.cache.linearizable", "cluster.cache.watch"]
    );
    assert_eq!(
        caps(&postgres, ClusterPrimitive::Lock),
        vec!["cluster.lock.linearizable"]
    );
}

/// A backend that reads its flag from a field contributes no capability and
/// says so, rather than being refused. Refusing used to make a configurable
/// backend unusable, and nothing pinned the behaviour that replaced it.
#[test]
fn a_field_read_features_body_is_recorded_as_runtime_determined() {
    let src = r"
        impl DistributedLockBackend for Configurable {
            fn features(&self) -> LockFeatures { LockFeatures::new(self.linearizable) }
        }
    ";
    let got = project_backend_capabilities(&[file(src)], ClusterPrimitive::Lock, "fixture", None)
        .expect("a computed flag is not an error");
    assert_eq!(got.runtime_determined, vec!["features"]);
    assert!(
        got.declared.is_empty(),
        "a flag decided at run time is no capability at composition time: {:?}",
        got.declared
    );
}

/// The redis cache's shape: `consistency()` returns a field its preflight set,
/// so there is no composition-time fact to read.
#[test]
fn a_non_path_consistency_body_is_recorded_as_runtime_determined() {
    let src = r"
        impl ClusterCacheBackend for RedisCache {
            fn consistency(&self) -> CacheConsistency { self.consistency }
            fn features(&self) -> CacheFeatures { CacheFeatures::new(false) }
        }
    ";
    let got = project_backend_capabilities(&[file(src)], ClusterPrimitive::Cache, "fixture", None)
        .expect("a computed consistency is not an error");
    assert_eq!(got.runtime_determined, vec!["consistency"]);
    // `features` is not undecided here: `new(false)` says prefix watch no, exact
    // watch yes. Only `consistency` is left to run time.
    assert_eq!(
        caps(&[file(src)], ClusterPrimitive::Cache),
        vec!["cluster.cache.watch"],
        "got {:?}",
        got.declared
    );
}

/// A declared capability is *not* runtime-determined, which is the other half of
/// the distinction and the one a regression would quietly invert.
#[test]
fn a_declared_capability_is_not_runtime_determined() {
    let src = r"
        impl ClusterCacheBackend for StandaloneCache {
            fn consistency(&self) -> CacheConsistency { CacheConsistency::Linearizable }
            fn features(&self) -> CacheFeatures { CacheFeatures::new(true) }
        }
    ";
    let got = project_backend_capabilities(&[file(src)], ClusterPrimitive::Cache, "fixture", None)
        .expect("project");
    assert!(
        got.runtime_determined.is_empty(),
        "got {:?}",
        got.runtime_determined
    );
}

// ---------------------------------------------------------------- SDK defaults

/// The inline half of the SDK-default rule. Its only other test sits behind
/// `require!`, so on a checkout without the corpus the function had no coverage
/// at all.
#[test]
fn a_derived_features_body_yields_an_sdk_default_rule() {
    let src = r"
        impl DistributedLockBackend for CasLock {
            fn features(&self) -> LockFeatures {
                LockFeatures::new(self.cache.consistency() == CacheConsistency::Linearizable)
            }
        }
        impl LeaderElectionBackend for CasElection {
            fn features(&self) -> LeaderElectionFeatures {
                LeaderElectionFeatures::new(
                    self.cache.consistency() == CacheConsistency::Linearizable,
                )
            }
        }
    ";
    let got = project_sdk_defaults(&[file(src)]);
    assert_eq!(
        got,
        vec![
            SdkDefaultRule {
                primitive: ClusterPrimitive::LeaderElection,
                linearizable_from_cache: true,
            },
            SdkDefaultRule {
                primitive: ClusterPrimitive::Lock,
                linearizable_from_cache: true,
            },
        ],
        "both fall-back primitives inherit the bound cache's capability"
    );
}

/// The negative case, which was untested: a `features()` body that is not a
/// cache-consistency comparison declares its own capability and is no SDK
/// default, so no rule may be emitted for it.
#[test]
fn a_features_body_that_is_not_derived_yields_no_rule() {
    let src = r"
        impl DistributedLockBackend for PostgresLock {
            fn features(&self) -> LockFeatures { LockFeatures::new(true) }
        }
        impl LeaderElectionBackend for Whatever {
            fn features(&self) -> LeaderElectionFeatures {
                LeaderElectionFeatures::new(self.linearizable)
            }
        }
    ";
    assert!(
        project_sdk_defaults(&[file(src)]).is_empty(),
        "a declared or run-time flag is not the inheritance rule"
    );
}

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
    .declared
    .into_iter()
    .map(|c| c.as_str().to_owned())
    .collect();
    got.sort();
    assert_eq!(
        got,
        vec![
            "cluster.cache.linearizable",
            "cluster.cache.prefix-watch",
            "cluster.cache.watch"
        ],
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

/// `without_watch()` states its answer in its name.
///
/// The SDK added it so a backend with `watch_mode: disabled` could say "no watch
/// at all" rather than `new(false)`, which means "exact watch yes, prefix watch
/// no". It takes no arguments, so the arity rule that guards `new` would have
/// refused it -- and refusing a constructor the SDK ships made every product
/// that reaches this backend unresolvable.
#[test]
fn a_without_watch_body_declares_no_prefix_watch() {
    let src = r"
        impl ClusterCacheBackend for Quiet {
            fn consistency(&self) -> CacheConsistency { CacheConsistency::Linearizable }
            fn features(&self) -> CacheFeatures { CacheFeatures::without_watch() }
        }
    ";
    let got = project_backend_capabilities(&[file(src)], ClusterPrimitive::Cache, "fixture", None)
        .expect("a named constructor is readable");
    assert_eq!(
        got.runtime_determined,
        Vec::<&str>::new(),
        "the name states the flag, so nothing is left to run time"
    );
    assert_eq!(
        caps(&[file(src)], ClusterPrimitive::Cache),
        vec!["cluster.cache.linearizable"],
        "`without_watch` forces prefix watch off as well as watch"
    );
}

#[test]
fn a_conditional_features_body_whose_branches_agree_is_read() {
    // An `if` around one answer is still that answer. Worth reading rather than
    // refusing: a backend may branch on configuration that cannot change the
    // flag, and the projection should not punish the shape.
    let src = r"
        impl ClusterCacheBackend for Either {
            fn consistency(&self) -> CacheConsistency { CacheConsistency::Linearizable }
            fn features(&self) -> CacheFeatures {
                if self.clustered { CacheFeatures::new(true) } else { CacheFeatures::new(true) }
            }
        }
    ";
    assert_eq!(
        caps(&[file(src)], ClusterPrimitive::Cache),
        vec![
            "cluster.cache.linearizable",
            "cluster.cache.prefix-watch",
            "cluster.cache.watch"
        ]
    );
}

/// The shape the redis cache actually has, and the reason this branch exists.
///
/// One arm computes the flag from the topology found at connect time, the other
/// names it. They disagree, so there is no composition-time fact -- which is
/// `runtime_determined`, not an error and not a claimed capability.
#[test]
fn a_conditional_features_body_whose_branches_disagree_is_runtime_determined() {
    let src = r"
        impl ClusterCacheBackend for Redis {
            fn consistency(&self) -> CacheConsistency { CacheConsistency::Linearizable }
            fn features(&self) -> CacheFeatures {
                if self.watchers.is_some() {
                    CacheFeatures::new(self.offers_prefix_watch())
                } else {
                    CacheFeatures::without_watch()
                }
            }
        }
    ";
    let got = project_backend_capabilities(&[file(src)], ClusterPrimitive::Cache, "fixture", None)
        .expect("a backend that decides at run time is not an error");
    assert_eq!(got.runtime_determined, vec!["features"]);
    assert_eq!(
        caps(&[file(src)], ClusterPrimitive::Cache),
        vec!["cluster.cache.linearizable"],
        "prefix watch is undecided here, so it is not declared"
    );
}

/// The arity guard survives the new shapes, including inside a branch.
///
/// This is the whole reason the parser is fussy: the feature structs are
/// `#[non_exhaustive]` with positional constructors, so a flag added upstream
/// changes the arity, and reading the wrong one would claim a capability the
/// backend does not have. A conditional must not become a way around that.
#[test]
fn a_conditional_branch_with_the_wrong_arity_is_still_refused() {
    let src = r"
        impl ClusterCacheBackend for Future {
            fn consistency(&self) -> CacheConsistency { CacheConsistency::Linearizable }
            fn features(&self) -> CacheFeatures {
                if self.clustered {
                    CacheFeatures::new(true, false)
                } else {
                    CacheFeatures::new(true)
                }
            }
        }
    ";
    let err = project_backend_capabilities(&[file(src)], ClusterPrimitive::Cache, "fixture", None)
        .expect_err("an unreadable branch is unreadable");
    let message = err.to_string();
    assert!(
        message.contains("takes 2 arguments here"),
        "the refusal must name what it found: {message}"
    );
}

#[test]
fn an_if_with_no_else_is_refused() {
    // It yields `()` unless every path returns, and this parser reads a value.
    let src = r"
        impl ClusterCacheBackend for Partial {
            fn consistency(&self) -> CacheConsistency { CacheConsistency::Linearizable }
            fn features(&self) -> CacheFeatures {
                if self.clustered { CacheFeatures::new(true) }
            }
        }
    ";
    project_backend_capabilities(&[file(src)], ClusterPrimitive::Cache, "fixture", None)
        .expect_err("an `if` with no `else` has no single value");
}

/// The two watch answers come apart, and that is the whole point of the pair.
///
/// `new(x)` sets `prefix_watch` from its argument and `watch` to `true`
/// regardless -- so a backend can serve an exact-key watch while declining a
/// prefix one, which is what postgres does and what a single flag could not say.
#[test]
fn an_exact_watch_is_declared_even_when_the_prefix_flag_is_off() {
    let src = r"
        impl ClusterCacheBackend for ExactOnly {
            fn consistency(&self) -> CacheConsistency { CacheConsistency::Linearizable }
            fn features(&self) -> CacheFeatures { CacheFeatures::new(false) }
        }
    ";
    assert_eq!(
        caps(&[file(src)], ClusterPrimitive::Cache),
        vec!["cluster.cache.linearizable", "cluster.cache.watch"]
    );
}

/// A computed prefix flag still states the exact watch.
///
/// The argument is what `new` cannot answer; the constructor's own meaning is
/// what it always answers. Reading only the argument left redis-shaped backends
/// describing nothing at all.
#[test]
fn a_computed_prefix_flag_leaves_the_exact_watch_declared() {
    let src = r"
        impl ClusterCacheBackend for Configurable {
            fn consistency(&self) -> CacheConsistency { CacheConsistency::Linearizable }
            fn features(&self) -> CacheFeatures { CacheFeatures::new(self.offers_prefix_watch()) }
        }
    ";
    let got = project_backend_capabilities(&[file(src)], ClusterPrimitive::Cache, "fixture", None)
        .expect("a computed flag is not an error");
    assert_eq!(
        got.runtime_determined,
        vec!["features"],
        "the prefix half is decided at run time"
    );
    assert_eq!(
        caps(&[file(src)], ClusterPrimitive::Cache),
        vec!["cluster.cache.linearizable", "cluster.cache.watch"],
        "the exact half is not"
    );
}

/// A lock has one flag, and `watch` is not a word about it.
///
/// The cache-only branch is guarded by the primitive rather than by the
/// constructor, so a lock whose flag reads `true` must not pick up a cache
/// capability on the way past.
#[test]
fn a_lock_never_declares_a_cache_watch() {
    let src = r"
        impl DistributedLockBackend for Strict {
            fn features(&self) -> LockFeatures { LockFeatures::new(true) }
        }
    ";
    assert_eq!(
        caps(&[file(src)], ClusterPrimitive::Lock),
        vec!["cluster.lock.linearizable"]
    );
}
