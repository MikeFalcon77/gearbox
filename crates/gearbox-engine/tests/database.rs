#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test fixture assertions"
)]
use gearbox_engine::generate::{GenerateInput, TemplateSet};
use gearbox_ir::{Catalogue, DiagnosticCode, ProfileId, RelPath, ResolvedProduct, RuntimeCap};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
#[path = "support/resolve_fixtures.rs"]
mod fixtures;

fn intent(profile: &str, database: &str) -> gearbox_ir::ProductIntent {
    let applications = if profile.starts_with("self_hosted") {
        r#"applications = [application("two", anchor = "store-two")],"#
    } else if profile.starts_with("kubernetes") {
        r#"applications = [application("one", anchor = "store-one"), application("two", anchor = "store-two")],"#
    } else {
        ""
    };
    let text = format!(r#"product(id = "db-test", version = "0.1.0",
        sources = [source(id = "fixture", at = path("."))],
        profiles = [{profile}], default_profile = "dev",
        gears = [use_gear("store-one", source = "fixture"), use_gear("store-two", source = "fixture")],
        {applications}
    )"#).replace("DATABASE", database);
    let evaluated = gearbox_gdl::GdlEngine::new().eval_product(
        &gearbox_gdl::FileIdentity {
            uri: "file:///product.gdl".to_owned(),
            source: fixtures::source(),
            gdl_path: RelPath::new("product.gdl").unwrap(),
            load_paths: None,
        },
        &text,
    );
    assert!(
        !evaluated.diagnostics.has_errors(),
        "{:?}",
        evaluated.diagnostics
    );
    evaluated.value.unwrap()
}

const DB: &str = r#"postgres(host = "localhost", user = "app", password = "${GEARS_PG_PASSWORD}",
    params = {"sslmode": "require"}, database_names = {"store-one": "one"}, existing_secret = "app-db")"#;
fn catalogue() -> Catalogue {
    let mut catalogue = Catalogue::default();
    for name in ["store-one", "store-two"] {
        let mut descriptor = fixtures::descriptor(name);
        descriptor.runtime_caps.insert(RuntimeCap::Db);
        catalogue.gears.insert(descriptor.id.clone(), descriptor);
    }
    catalogue
}
fn resolve(profile: &str, db: &str) -> ResolvedProduct {
    let mut catalogue = catalogue();
    if profile.starts_with("self_hosted") {
        let host = catalogue
            .gears
            .get_mut(&fixtures::gid("store-one"))
            .unwrap();
        host.runtime_caps.insert(RuntimeCap::RestHost);
        host.colocated_deps.insert(fixtures::gid("hosted-api"));
        let mut api = fixtures::descriptor("hosted-api");
        api.runtime_caps.insert(RuntimeCap::Rest);
        catalogue.gears.insert(api.id.clone(), api);
    }
    let intent = intent(profile, db);
    let resolution =
        gearbox_engine::resolve::resolve(&catalogue, &intent, &ProfileId::new("dev").unwrap());
    assert!(!resolution.has_errors(), "{:?}", resolution.diagnostics);
    gearbox_engine::resolve::product::assemble(&catalogue, &intent, &resolution, BTreeMap::new())
}
fn generated(lock: &ResolvedProduct) -> gearbox_ir::FileSet {
    let corpus = if cfg!(windows) {
        PathBuf::from(r"C:\workspace\corpus")
    } else {
        PathBuf::from("/workspace/corpus")
    };
    gearbox_engine::generate(&GenerateInput {
        lock,
        source_roots: &BTreeMap::from([(fixtures::source(), corpus.clone())]),
        out_root: &corpus.parent().unwrap().join("out"),
        templates: TemplateSet::default(),
        product_dir: None,
        catalogue: None,
        registry: None,
    })
    .unwrap()
    .files
}
fn text<'a>(files: &'a gearbox_ir::FileSet, path: &str) -> &'a str {
    files
        .get(&RelPath::new(path).unwrap())
        .unwrap()
        .as_text()
        .unwrap()
}

fn export_files(files: &gearbox_ir::FileSet) {
    if let Some(destination) = std::env::var_os("GEARBOX_TEST_OUTPUT") {
        let destination = PathBuf::from(destination);
        for entry in files {
            let path = destination.join(entry.path.as_str());
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, entry.as_text().unwrap()).unwrap();
        }
    }
}

#[test]
fn database_roundtrips_through_gdl_resolution_lock_and_runtime_yaml() {
    let target = if cfg!(windows) {
        "C:/workspace/target"
    } else {
        "/workspace/target"
    };
    let self_hosted = format!(
        r#"self_hosted(id = "dev", host = "one", worker_discovery = "static", target_dir = "{target}", database = DATABASE)"#
    );
    for profile in [
        self_hosted.as_str(),
        r#"embedded(id = "dev", database = DATABASE)"#,
        r#"kubernetes(id = "dev", discovery = "static", database = DATABASE)"#,
    ] {
        let lock = resolve(profile, DB);
        let db = lock.database.as_ref().unwrap();
        assert_eq!(db.port, 5432);
        assert_eq!(db.database_names[&fixtures::gid("store-one")], "one");
        assert_eq!(db.database_names[&fixtures::gid("store-two")], "store_two");
        let serialized = gearbox_lock::write_canonical(&lock).unwrap();
        let restored = gearbox_lock::read(&serialized).unwrap();
        assert_eq!(restored.database, lock.database);
        let files = generated(&lock);
        export_files(&files);
        for app in &lock.applications {
            let manifest = text(&files, &format!("apps/{}/Cargo.toml", app.name));
            assert!(manifest.contains("[dependencies.toolkit_db]"));
            assert!(manifest.contains("\"pg\""));
            let config = text(&files, &format!("config/{}.yaml", app.name));
            let yaml: serde_json::Value = serde_saphyr::from_str(config).unwrap();
            assert_eq!(
                yaml["database"]["servers"]["pg"]["password"],
                "${GEARS_PG_PASSWORD}"
            );
            assert_eq!(yaml["database"]["servers"]["pg"]["engine"], "postgres");
            for gear in app
                .gears
                .iter()
                .filter(|id| lock.gears[*id].runtime_caps.contains(&RuntimeCap::Db))
            {
                assert_eq!(
                    yaml["gears"][gear.as_str()]["database"]["dbname"],
                    db.database_names[gear]
                );
            }
        }
        if lock.kubernetes.is_some() {
            let values = text(&files, "helm/db-test/values.yaml");
            assert!(values.contains("existingSecret: app-db"), "{values}");
            assert!(
                values.contains("passwordEnv: GEARS_PG_PASSWORD"),
                "{values}"
            );
            for app in &lock.applications {
                let deployment = text(
                    &files,
                    &format!("helm/db-test/charts/{}/templates/deployment.yaml", app.name),
                );
                assert!(deployment.contains(".Values.database"));
                assert!(deployment.contains("secretKeyRef:"));
            }
        }
    }
}

#[test]
fn missing_database_names_the_gear_and_profile_before_generation() {
    let catalogue = catalogue();
    let intent = intent(r#"embedded(id = "dev")"#, "");
    let resolution =
        gearbox_engine::resolve::resolve(&catalogue, &intent, &ProfileId::new("dev").unwrap());
    let errors: Vec<_> = resolution
        .diagnostics
        .iter()
        .filter(|d| d.code == DiagnosticCode::TopologyDbWithoutDatabase)
        .collect();
    assert_eq!(errors.len(), 2);
    assert!(errors.iter().all(|d| d.message.contains("profile `dev`")));
}

#[test]
fn colliding_derived_names_and_unselected_overrides_are_refused() {
    for db in [
        DB.replace("\"one\"", "\"store_two\""),
        DB.replace("store-one", "absent"),
    ] {
        let catalogue = catalogue();
        let intent = intent(r#"embedded(id = "dev", database = DATABASE)"#, &db);
        let resolution =
            gearbox_engine::resolve::resolve(&catalogue, &intent, &ProfileId::new("dev").unwrap());
        assert!(
            resolution
                .diagnostics
                .iter()
                .any(|d| d.code == DiagnosticCode::TopologyDbWithoutDatabase)
        );
    }
}

#[test]
fn database_changes_are_visible_in_canonical_lock_diff() {
    let before = resolve(r#"embedded(id = "dev", database = DATABASE)"#, DB);
    let after = resolve(
        r#"embedded(id = "dev", database = DATABASE)"#,
        &DB.replace("localhost", "other-host"),
    );
    let diff = gearbox_lock::diff(&before, &after);
    assert!(format!("{diff:?}").contains("database.host"));
}

#[test]
fn malformed_or_credential_bearing_database_locks_are_refused() {
    let mut lock = resolve(r#"embedded(id = "dev", database = DATABASE)"#, DB);
    lock.database.as_mut().unwrap().password = "literal-password".to_owned();
    assert!(lock.validate_database().is_err());
    assert!(gearbox_lock::write_canonical(&lock).is_err());
    lock.database.as_mut().unwrap().password = "${GEARS_PG_PASSWORD}".to_owned();
    lock.database.as_mut().unwrap().database_names.clear();
    assert!(lock.validate_database().is_err());
    let mut serialized = gearbox_lock::write_canonical(&lock).unwrap();
    serialized = serialized.replace("schema_version = 2", "schema_version = 1");
    assert!(
        gearbox_lock::read(&serialized)
            .unwrap_err()
            .to_string()
            .contains("gearbox resolve")
    );
}

#[test]
fn a_non_database_process_gets_no_connection_or_secret() {
    let mut lock = resolve(
        r#"kubernetes(id = "dev", discovery = "static", database = DATABASE)"#,
        DB,
    );
    let plain = fixtures::gid("store-two");
    lock.gears
        .get_mut(&plain)
        .unwrap()
        .runtime_caps
        .remove(&RuntimeCap::Db);
    lock.database
        .as_mut()
        .unwrap()
        .database_names
        .remove(&plain);
    let app = lock
        .applications
        .iter_mut()
        .find(|app| app.gears.contains(&plain))
        .unwrap();
    app.needs_db = false;
    let name = app.name.to_string();
    let files = generated(&lock);
    let yaml: serde_json::Value =
        serde_saphyr::from_str(text(&files, &format!("config/{name}.yaml"))).unwrap();
    assert!(yaml.get("database").is_none());
    assert!(yaml["gears"][plain.as_str()].get("database").is_none());
    let values: serde_json::Value =
        serde_saphyr::from_str(text(&files, "helm/db-test/values.yaml")).unwrap();
    assert!(values[&name].get("database").is_none());
}

#[test]
fn kubernetes_requires_a_secret_and_names_are_limited_without_truncation() {
    let catalogue = catalogue();
    for db in [
        DB.replace(", existing_secret = \"app-db\"", ""),
        DB.replace("\"one\"", &format!("\"{}\"", "a".repeat(64))),
    ] {
        let evaluated = gearbox_gdl::GdlEngine::new().eval_product(&gearbox_gdl::FileIdentity {
            uri: "file:///product.gdl".to_owned(), source: fixtures::source(), gdl_path: RelPath::new("product.gdl").unwrap(), load_paths: None,
        }, &format!(r#"product(id = "demo", version = "0.1.0", sources = [source(id = "fixture", at = path("."))], profiles = [kubernetes(id = "dev", discovery = "static", database = {db})], default_profile = "dev", gears = [use_gear("store-one", source = "fixture")])"#));
        if let Some(intent) = evaluated.value {
            let resolution = gearbox_engine::resolve::resolve(
                &catalogue,
                &intent,
                &ProfileId::new("dev").unwrap(),
            );
            assert!(resolution.has_errors());
        } else {
            assert!(evaluated.diagnostics.has_errors());
        }
    }
}

#[test]
fn database_and_cluster_credentials_use_independent_existing_secrets() {
    let mut lock = resolve(
        r#"kubernetes(id = "dev", discovery = "static", database = DATABASE)"#,
        DB,
    );
    lock.gears
        .get_mut(&fixtures::gid("store-one"))
        .unwrap()
        .config
        .insert(
            "cluster_token".to_owned(),
            serde_json::json!("${CLUSTER_PASSWORD}"),
        );
    lock.cluster.push(gearbox_ir::ResolvedClusterBinding {
        scope: "test".to_owned(),
        primitive: gearbox_ir::ClusterPrimitive::Cache,
        required_capabilities: BTreeSet::default(),
        requesters: vec![fixtures::gid("store-one")],
        selected: gearbox_ir::Selected::honoured("postgres".to_owned()),
        resolved: gearbox_ir::ClusterResolution::Provider {
            name: "postgres".to_owned(),
        },
        options: BTreeMap::new(),
        secret_ref: Some("existingSecret:cluster-secret".to_owned()),
    });
    let files = generated(&lock);
    let values: serde_json::Value =
        serde_saphyr::from_str(text(&files, "helm/db-test/values.yaml")).unwrap();
    assert_eq!(values["one"]["existingSecret"], "cluster-secret");
    assert_eq!(values["one"]["database"]["existingSecret"], "app-db");
    assert_eq!(
        values["one"]["secretKeys"],
        serde_json::json!(["CLUSTER_PASSWORD"])
    );
}

#[test]
fn spawning_a_db_worker_does_not_configure_its_database_in_the_host() {
    let target = if cfg!(windows) {
        "C:/workspace/target"
    } else {
        "/workspace/target"
    };
    let profile = format!(
        r#"self_hosted(id = "dev", host = "one", worker_discovery = "static", target_dir = "{target}", database = DATABASE)"#
    );
    let mut lock = resolve(&profile, DB);
    let host_gear = fixtures::gid("store-one");
    lock.gears
        .get_mut(&host_gear)
        .unwrap()
        .runtime_caps
        .remove(&RuntimeCap::Db);
    lock.database
        .as_mut()
        .unwrap()
        .database_names
        .remove(&host_gear);
    let host = lock
        .applications
        .iter_mut()
        .find(|a| a.name.as_str() == "one")
        .unwrap();
    host.needs_db = false;
    assert_eq!(host.spawns.len(), 1);
    let files = generated(&lock);
    let host: serde_json::Value = serde_saphyr::from_str(text(&files, "config/one.yaml")).unwrap();
    assert!(host.get("database").is_none());
    assert!(host["gears"]["store-two"].get("database").is_none());
    assert!(host["gears"]["store-two"].get("runtime").is_some());
    let worker: serde_json::Value =
        serde_saphyr::from_str(text(&files, "config/two.yaml")).unwrap();
    assert_eq!(
        worker["gears"]["store-two"]["database"]["dbname"],
        "store_two"
    );
}
