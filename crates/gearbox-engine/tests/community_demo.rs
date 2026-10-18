//! Resolve and generate the actual prepared demo, including overlapping closures.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "integration test assertions"
)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use gearbox_engine::generate::{GenerateInput, TemplateSet};
use gearbox_engine::{CatalogueScan, SourceRoot, load_catalogue, load_product};
use gearbox_ir::{FileSet, RelPath, ResolvedProduct, SourceId};

#[path = "common/corpus.rs"]
mod corpus_support;

fn resolved() -> Option<(ResolvedProduct, FileSet)> {
    static SCAN: OnceLock<CatalogueScan> = OnceLock::new();
    let root = corpus_support::root()?;
    let source = SourceRoot::open(SourceId::new("gears-rust").unwrap(), root).unwrap();
    let scan = SCAN.get_or_init(|| load_catalogue(std::slice::from_ref(&source)));
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let product = repo.join("products/settings-community-demo/product.gdl");
    let intent = load_product(&product, None)
        .intent
        .expect("prepared demo evaluates");
    let result = gearbox_engine::resolve::resolve_at(
        &scan.catalogue,
        &intent,
        &intent.default_profile,
        Some(&product),
    );
    assert!(!result.has_errors(), "{:?}", result.diagnostics);
    let lock = gearbox_engine::resolve::product::assemble(
        &scan.catalogue,
        &intent,
        &result,
        BTreeMap::from([(source.id.clone(), source.to_resolved())]),
    );
    let roots: BTreeMap<SourceId, PathBuf> = BTreeMap::from([(source.id, source.root)]);
    let generated = gearbox_engine::generate(&GenerateInput {
        lock: &lock,
        source_roots: &roots,
        out_root: &repo.join(".gearbox/community-demo-test/minikube"),
        templates: TemplateSet::default(),
        product_dir: product.parent(),
        catalogue: Some(&scan.catalogue),
        registry: None,
    })
    .unwrap();
    Some((lock, generated.files))
}

fn text<'a>(files: &'a FileSet, path: &str) -> &'a str {
    files
        .get(&RelPath::new(path).unwrap())
        .unwrap()
        .as_text()
        .unwrap()
}

#[test]
fn each_process_links_the_selected_plugins_of_every_host_it_contains() {
    let Some((lock, _)) = resolved() else {
        return;
    };
    assert_eq!(lock.applications.len(), 2);
    let worker = lock
        .applications
        .iter()
        .find(|app| app.name.as_str() == "demo-settings-worker")
        .unwrap();
    assert!(
        worker
            .gears
            .iter()
            .any(|id| id.as_str() == "authn-resolver")
    );
    assert!(
        worker
            .gears
            .iter()
            .any(|id| id.as_str() == "static-authn-plugin")
    );
    for app in &lock.applications {
        for (id, gear) in &lock.gears {
            for reason in &gear.selected_by {
                if let gearbox_ir::InclusionReason::PluginOf { host, .. } = reason
                    && app.gears.contains(host)
                {
                    assert!(
                        app.gears.contains(id),
                        "{} contains {host} but omits its plugin {id}",
                        app.name
                    );
                }
            }
        }
    }
}

#[test]
fn worker_bootstrap_does_not_pull_settings_back_into_the_gateway() {
    let Some((lock, _)) = resolved() else {
        return;
    };
    let gateway = lock
        .applications
        .iter()
        .find(|app| app.name.as_str() == "demo-gateway")
        .unwrap();
    let worker = lock
        .applications
        .iter()
        .find(|app| app.name.as_str() == "demo-settings-worker")
        .unwrap();
    for id in ["settings-service", "family-labs-bootstrap"] {
        assert!(
            !gateway.gears.iter().any(|gear| gear.as_str() == id),
            "{id} must stay remote"
        );
        assert!(worker.gears.iter().any(|gear| gear.as_str() == id));
    }
    // Both processes intentionally restore their own local V1 catalogue.
    for app in [&gateway, &worker] {
        assert!(
            app.gears
                .iter()
                .any(|gear| gear.as_str() == "demo-catalogue")
        );
    }
}

#[test]
fn eb_metadata_and_event_log_use_files_under_the_persistent_home() {
    let Some((lock, files)) = resolved() else {
        return;
    };
    assert!(
        !lock
            .database
            .as_ref()
            .unwrap()
            .database_names
            .keys()
            .any(|id| id.as_str() == "event-broker")
    );
    let config: serde_json::Value =
        serde_saphyr::from_str(text(&files, "config/demo-gateway.yaml")).unwrap();
    assert_eq!(
        config["gears"]["event-broker"]["database"],
        serde_json::json!({"engine": "sqlite", "file": "metadata.sqlite3"})
    );
    assert_eq!(
        config["gears"]["event-broker"]["config"]["topics"]["gts.cf.core.events.topic.v1~cf.demo.settings.changed.v1"]
            ["backend"]["path"],
        "/var/lib/gearbox/event-broker/events.sqlite3"
    );
    let values: serde_json::Value =
        serde_saphyr::from_str(text(&files, "helm/settings-community-demo/values.yaml")).unwrap();
    assert_eq!(
        values["demo-gateway"]["homeVolume"]["type"],
        "persistentVolumeClaim"
    );
    assert_eq!(values["demo-gateway"]["strategy"]["type"], "Recreate");
    assert_eq!(values["demo-gateway"]["replicaCount"], 1);
}

#[test]
fn worker_directory_and_platform_provider_come_from_the_resolved_host() {
    let Some((_, files)) = resolved() else {
        return;
    };
    let worker: serde_json::Value =
        serde_saphyr::from_str(text(&files, "config/demo-settings-worker.yaml")).unwrap();
    let gateway: serde_json::Value =
        serde_saphyr::from_str(text(&files, "config/demo-gateway.yaml")).unwrap();
    assert_eq!(
        worker["oop_http"]["internal_auth"],
        gateway["gears"]["api-gateway"]["config"]["internal_auth"]
    );
    assert_eq!(
        gateway["gears"]["grpc-hub"]["config"]["internal_auth"],
        worker["oop_http"]["internal_auth"]
    );
    assert_eq!(
        worker["oop_http"]["internal_auth"]["peer_name"],
        "settings-service"
    );
    let deployment = text(
        &files,
        "helm/settings-community-demo/charts/demo-settings-worker/templates/deployment.yaml",
    );
    assert!(deployment.contains("TOOLKIT_DIRECTORY_ENDPOINT"));
    assert!(deployment.contains("command:"));
    assert!(deployment.contains("\"gbx-demo-settings-worker\""));
    assert!(deployment.contains("http://demo-gateway.gearbox-demo.svc.cluster.local:50051"));
    assert!(!deployment.contains("127.0.0.1:50051"));
}

#[test]
fn event_broker_has_an_actual_postgres_cluster_cache_binding() {
    let Some((lock, _)) = resolved() else {
        return;
    };
    assert!(lock.cluster.iter().any(|binding| binding.scope == "event-broker"
        && binding.primitive == gearbox_ir::ClusterPrimitive::Cache
        && matches!(&binding.resolved, gearbox_ir::ClusterResolution::Provider { name } if name == "postgres")), "{:?}", lock.cluster);
}
