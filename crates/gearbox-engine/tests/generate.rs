//! The generators, against the real tree.
//!
//! `products/payments-demo/product.gdl` resolved for `dev` is the M5 slice, and
//! everything here asserts against what that produces from `../gears-rust`
//! rather than from a fixture. The one thing a fixture is used for is the
//! `OperatorOwned` path, and the reason is stated where it appears: the whole
//! design has exactly one operator-owned file -- Helm's `values.yaml` -- and M7
//! is where that arrives, so there is nothing real for it to be tried against.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use gearbox_engine::generate::{GenerateInput, Generated, base_root_for, generate};
use gearbox_engine::{SourceRoot, load_catalogue, load_product};
use gearbox_ir::{
    FileAction, FileEntry, FileKind, FileSet, GearId, Ownership, ProfileId, RelPath,
    ResolvedProduct, SourceId,
};

fn gears_rust() -> Option<PathBuf> {
    // Walks up instead of counting `..`, and the difference is not cosmetic.
    // `CARGO_MANIFEST_DIR/../../../gears-rust` is the sibling of the *repository*
    // root, so from a git worktree -- `.claude/worktrees/<name>/crates/...` -- it
    // resolved to nothing. Every real-tree test then skipped, printed a reason
    // nobody reads, and the suite went green having touched none of the corpus.
    // An agent working in a worktree got that silently.
    let mut dir: &Path = Path::new(env!("CARGO_MANIFEST_DIR"));
    loop {
        let candidate = dir.join("gears-rust");
        if candidate.join("gears").is_dir() {
            return candidate.canonicalize().ok();
        }
        dir = dir.parent()?;
    }
}

fn product_gdl() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../products/payments-demo/product.gdl")
        .canonicalize()
        .expect("the repository's own product description")
}

/// Resolve the demo product for one profile against the real tree.
fn resolve(profile: &str) -> Option<(ResolvedProduct, BTreeMap<SourceId, PathBuf>)> {
    let root = gears_rust()?;
    let opened = vec![SourceRoot::open(SourceId::new("gears-rust").unwrap(), &root).unwrap()];
    let scan = load_catalogue(&opened);

    let path = product_gdl();
    let product = load_product(&path, None);
    let intent = product.intent.expect("the product evaluates");
    let profile = ProfileId::new(profile).unwrap();

    let resolution =
        gearbox_engine::resolve::resolve_at(&scan.catalogue, &intent, &profile, Some(&path));
    let sources = opened
        .iter()
        .map(|r| (r.id.clone(), r.to_resolved()))
        .collect();
    let lock =
        gearbox_engine::resolve::product::assemble(&scan.catalogue, &intent, &resolution, sources);

    let roots = opened
        .iter()
        .map(|r| (r.id.clone(), r.root.clone()))
        .collect();
    Some((lock, roots))
}

/// A fixed output root. Never written to by these tests -- generation is pure,
/// and the path only decides what the relative dependency paths are relative
/// to.
fn out_root() -> PathBuf {
    PathBuf::from("/workspace/.gearbox/payments-demo/dev")
}

fn generated(profile: &str) -> Option<(ResolvedProduct, Generated)> {
    let (lock, source_roots) = resolve(profile)?;
    let out = out_root();
    let files = generate(&GenerateInput {
        lock: &lock,
        source_roots: &source_roots,
        out_root: &out,
    })
    .expect("generation succeeds for the demo product");
    Some((lock, files))
}

fn text<'a>(files: &'a FileSet, path: &str) -> &'a str {
    files
        .get(&RelPath::new(path).unwrap())
        .unwrap_or_else(|| panic!("no generated file at `{path}`"))
        .as_text()
        .expect("generated files are UTF-8")
}

#[test]
fn the_embedded_profile_generates_the_documented_output_set() {
    let Some((_, files)) = generated("dev") else {
        return;
    };
    let paths: Vec<&str> = files.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "Cargo.toml",
            "config/api-gateway.yaml",
            "processes/api-gateway/Cargo.toml",
            "processes/api-gateway/src/main.rs",
            "processes/api-gateway/src/registered_gears.rs",
            "product.lock",
            "rust-toolchain.toml",
        ],
        "the embedded profile's output set is the plan's section 7 table minus the \
         Docker and Helm rows, which are M7"
    );
}

#[test]
fn every_generated_file_is_tool_owned() {
    // M5 produces nothing an operator owns. Asserted rather than assumed,
    // because the three-way merge path is the one that can lose data and the
    // claim that nothing reaches it should not rest on reading the code.
    let Some((_, files)) = generated("dev") else {
        return;
    };
    for file in &files.files {
        assert_eq!(
            file.ownership,
            Ownership::Generated,
            "`{}` is {}, but no M5 output is anything but Generated",
            file.path,
            file.ownership
        );
    }
}

#[test]
fn no_generated_manifest_inherits_from_a_workspace() {
    // The single most likely build failure: the generated crates live under
    // `.gearbox/<product>/<profile>/`, outside the `gears-rust` workspace, so
    // `edition.workspace = true` -- the spelling every crate they depend on
    // uses -- resolves to nothing.
    let Some((_, files)) = generated("dev") else {
        return;
    };
    for file in &files.files {
        if file.kind != FileKind::Toml {
            continue;
        }
        let body = file.as_text().unwrap();
        assert!(
            !body.contains("workspace = true"),
            "`{}` inherits from a workspace that will not be there",
            file.path
        );
    }

    let manifest = text(&files.files, "processes/api-gateway/Cargo.toml");
    assert!(manifest.contains("edition = \"2024\""));
    assert!(manifest.contains("rust-version = \"1.95.0\""));
}

#[test]
fn the_manifest_and_the_link_file_agree() {
    // The generated `registered_gears.rs` is also the source of the
    // `--list-registered-gears` oracle, so a template bug could produce an
    // oracle that agrees with a wrong composition. The independent check is
    // that every link line names a dependency the manifest declares, and that
    // every gear-crate dependency is linked.
    let Some((lock, files)) = generated("dev") else {
        return;
    };
    let manifest = text(&files.files, "processes/api-gateway/Cargo.toml");
    let links = text(
        &files.files,
        "processes/api-gateway/src/registered_gears.rs",
    );

    let process = lock
        .process(&gearbox_ir::ProcessId::new("api-gateway").unwrap())
        .expect("the embedded profile resolves one process");

    for id in &process.gears {
        let gear = lock.gears.get(id).unwrap();
        assert!(
            manifest.contains(&format!("[dependencies.{}]", gear.package.lib_ident)),
            "`{id}` has no dependency entry keyed by its library identifier `{}`",
            gear.package.lib_ident
        );
        assert!(
            manifest.contains(&format!("package = \"{}\"", gear.package.crate_name)),
            "`{id}`'s package name is not spelled out"
        );
        for ident in gear.package.link_idents() {
            assert!(
                links.contains(&format!("use {ident} as _;")),
                "`{id}` links `{ident}`, which the link file does not keep alive"
            );
        }
    }

    // `cf-api-contracts` is the load-bearing case: the crate has no `[lib]`
    // section, so its identifier is `cf_api_contracts` and not `api_contracts`.
    // A generator deriving the identifier from the package name gets this wrong
    // and the mistake compiles nowhere.
    assert!(links.contains("use cf_api_contracts as _;"));
    assert!(!links.contains("use api_contracts as _;"));
}

#[test]
fn the_config_carries_every_resolved_socket() {
    let Some((lock, files)) = generated("dev") else {
        return;
    };
    let config = text(&files.files, "config/api-gateway.yaml");
    let process = lock
        .process(&gearbox_ir::ProcessId::new("api-gateway").unwrap())
        .unwrap();

    assert!(
        !process.listens.is_empty(),
        "the resolver must assign the REST host a bind address; `bind_addr` has no \
         serde default, so a config without one fails at startup"
    );
    for endpoint in &process.listens {
        assert!(
            config.contains(&format!("{}: {}", endpoint.config_key, endpoint.address)),
            "`{}`'s `{}` is missing from the generated configuration",
            endpoint.gear,
            endpoint.config_key
        );
    }

    // Every composed gear appears, so `--list-gears` and the composed set match.
    for id in &process.gears {
        assert!(
            config.contains(&format!("  {id}:")),
            "`{id}` is composed into the binary but absent from its configuration"
        );
    }
}

#[test]
fn the_lock_is_written_beside_the_tree_it_produced() {
    // `gearbox lock gears` is answered from this file, and the acceptance
    // procedure runs it from inside the generated directory.
    let Some((lock, files)) = generated("dev") else {
        return;
    };
    let written = text(&files.files, "product.lock");
    let reread = gearbox_lock::read(written).expect("the written lock reads back");
    assert_eq!(reread.product.lock_hash, lock.product.lock_hash);
}

#[test]
fn generation_is_deterministic() {
    let Some((first, _)) = generated("dev") else {
        return;
    };
    let (second, source_roots) = resolve("dev").unwrap();
    let out = out_root();
    let again = generate(&GenerateInput {
        lock: &second,
        source_roots: &source_roots,
        out_root: &out,
    })
    .unwrap();

    let one = generate(&GenerateInput {
        lock: &first,
        source_roots: &source_roots,
        out_root: &out,
    })
    .unwrap();

    let digests = |g: &Generated| -> Vec<(String, String)> {
        g.files
            .iter()
            .map(|f| (f.path.as_str().to_owned(), f.digest()))
            .collect()
    };
    assert_eq!(digests(&one), digests(&again));
}

#[test]
fn the_lock_s_gear_order_is_a_valid_topological_order() {
    // What `gearbox lock gears --order topo` prints. The running binary's own
    // order cannot be compared against it -- `GearRegistry` seeds Kahn's
    // algorithm from `HashMap::keys()`, which is randomized per process -- so
    // the property that *is* checkable is that the lock's order is one the
    // registry could legitimately have produced.
    let Some((lock, _)) = generated("dev") else {
        return;
    };
    for process in &lock.processes {
        let mut seen: Vec<&GearId> = Vec::new();
        for id in &process.gears {
            let gear = lock.gears.get(id).unwrap();
            for dep in &gear.colocated_deps {
                assert!(
                    seen.contains(&dep),
                    "`{id}` is placed before its co-location dependency `{dep}`"
                );
            }
            seen.push(id);
        }
    }
}

// ---------------------------------------------------------------- the writer

/// A throwaway output tree.
struct Out(PathBuf);

impl Out {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "gearbox-generate-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("profile")).unwrap();
        Self(dir)
    }

    fn root(&self) -> PathBuf {
        self.0.join("profile")
    }

    fn write(&self, rel: &str, body: &str) {
        let path = self.root().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.root().join(rel)).unwrap()
    }
}

impl Drop for Out {
    fn drop(&mut self) {
        // A leftover temporary directory is untidy, not wrong, and a test that
        // panicked during unwinding should not panic again here.
        drop(std::fs::remove_dir_all(&self.0));
    }
}

/// A one-file set. Hand-built: nothing in `gears-rust` produces an
/// `OperatorOwned` or `GeneratedOnce` file, because the only operator-owned
/// artefact in the whole design is Helm's `values.yaml` and M7 is where that
/// arrives.
fn one(path: &str, body: &str, ownership: Ownership) -> FileSet {
    let mut set = FileSet::new();
    drop(set.insert(FileEntry::text(
        RelPath::new(path).unwrap(),
        body,
        FileKind::Yaml,
        ownership,
    )));
    set
}

fn action(plans: &[gearbox_ir::FilePlan], path: &str) -> FileAction {
    plans
        .iter()
        .find(|p| p.path.as_str() == path)
        .unwrap_or_else(|| panic!("no plan for `{path}`"))
        .action
}

#[test]
fn a_generated_file_is_overwritten_and_then_reported_unchanged() {
    let out = Out::new("generated");
    let base = base_root_for(&out.root());
    let files = one(
        "values.generated.yaml",
        "image: new\n",
        Ownership::Generated,
    );

    let outcome = gearbox_engine::apply_generate(&files, &out.root(), &base).unwrap();
    assert_eq!(
        action(&outcome.plans, "values.generated.yaml"),
        FileAction::Create
    );
    assert_eq!(outcome.written, 1);

    let again = gearbox_engine::apply_generate(&files, &out.root(), &base).unwrap();
    assert_eq!(
        action(&again.plans, "values.generated.yaml"),
        FileAction::Unchanged
    );
    assert_eq!(again.written, 0, "a second apply must be a no-op");
}

#[test]
fn a_generated_once_file_is_never_revisited() {
    let out = Out::new("once");
    let base = base_root_for(&out.root());
    out.write("gear.gdl", "the human's version\n");

    let files = one("gear.gdl", "the tool's version\n", Ownership::GeneratedOnce);
    let outcome = gearbox_engine::apply_generate(&files, &out.root(), &base).unwrap();

    assert_eq!(action(&outcome.plans, "gear.gdl"), FileAction::Kept);
    assert_eq!(outcome.written, 0);
    assert_eq!(out.read("gear.gdl"), "the human's version\n");
}

#[test]
fn an_operator_file_keeps_its_edits_across_a_regeneration() {
    let out = Out::new("operator");
    let base = base_root_for(&out.root());

    // First run establishes the base.
    let first = one(
        "values.yaml",
        "image: old\nport: 8080\n",
        Ownership::OperatorOwned,
    );
    gearbox_engine::apply_generate(&first, &out.root(), &base).unwrap();

    // The operator adds a key.
    out.write(
        "values.yaml",
        "image: old\nport: 8080\nnodeSelector:\n  disk: ssd\n",
    );

    // The generator changes a different one.
    let second = one(
        "values.yaml",
        "image: new\nport: 8080\n",
        Ownership::OperatorOwned,
    );
    let outcome = gearbox_engine::apply_generate(&second, &out.root(), &base).unwrap();

    assert_eq!(action(&outcome.plans, "values.yaml"), FileAction::Update);
    assert_eq!(
        out.read("values.yaml"),
        "image: new\nport: 8080\nnodeSelector:\n  disk: ssd\n"
    );
}

#[test]
fn a_real_conflict_is_gbx0701_and_writes_nothing() {
    let out = Out::new("conflict");
    let base = base_root_for(&out.root());

    let first = one("values.yaml", "image: old\n", Ownership::OperatorOwned);
    gearbox_engine::apply_generate(&first, &out.root(), &base).unwrap();

    out.write("values.yaml", "image: operators-choice\n");
    let second = one(
        "values.yaml",
        "image: generators-choice\n",
        Ownership::OperatorOwned,
    );
    let outcome = gearbox_engine::apply_generate(&second, &out.root(), &base).unwrap();

    assert_eq!(action(&outcome.plans, "values.yaml"), FileAction::Conflict);
    assert_eq!(outcome.written, 0);
    assert!(
        outcome
            .diagnostics
            .as_slice()
            .iter()
            .any(|d| d.code == gearbox_ir::DiagnosticCode::GenClobberOperatorFile),
        "an unresolvable overlap must be GBX0701"
    );
    assert_eq!(
        out.read("values.yaml"),
        "image: operators-choice\n",
        "the operator's file must be left exactly as they left it"
    );
}

#[test]
fn a_conflict_stops_the_whole_apply() {
    // The transactional requirement of ADR
    // `cpt-gearbox-adr-authoring-ownership-tiers`: a run that wrote the files it
    // could and left one conflicted produces a tree that is half one product
    // and half another, and nothing downstream can tell.
    let out = Out::new("atomic");
    let base = base_root_for(&out.root());

    let seed = one("values.yaml", "image: old\n", Ownership::OperatorOwned);
    gearbox_engine::apply_generate(&seed, &out.root(), &base).unwrap();
    out.write("values.yaml", "image: operators-choice\n");

    let mut files = one(
        "values.yaml",
        "image: generators-choice\n",
        Ownership::OperatorOwned,
    );
    drop(files.insert(FileEntry::text(
        RelPath::new("Cargo.toml").unwrap(),
        "[workspace]\n",
        FileKind::Toml,
        Ownership::Generated,
    )));

    let outcome = gearbox_engine::apply_generate(&files, &out.root(), &base).unwrap();
    assert_eq!(outcome.written, 0);
    assert!(
        !out.root().join("Cargo.toml").exists(),
        "no file may be written when any file conflicts"
    );
}

#[test]
fn plan_writes_nothing() {
    let out = Out::new("plan");
    let base = base_root_for(&out.root());
    let files = one(
        "values.generated.yaml",
        "image: new\n",
        Ownership::Generated,
    );

    let (plans, diagnostics) = gearbox_engine::generate::plan(&files, &out.root(), &base).unwrap();
    assert_eq!(action(&plans, "values.generated.yaml"), FileAction::Create);
    assert!(diagnostics.is_empty());
    assert!(
        !out.root().join("values.generated.yaml").exists(),
        "a preview must not write"
    );
}

/// Part B: a value the description sets reaches the generated configuration.
///
/// It could not before. `app_config` seeded every gear's section empty and
/// filled it only from endpoints, wiring, cluster and spawns, and it could not
/// have done otherwise -- `GenerateInput` carries the lock, and the lock had no
/// place to put a product's configuration. Both halves are asserted here: the
/// lock carries it, and the generator writes it.
#[test]
fn a_products_config_reaches_the_generated_configuration() {
    let Some(root) = gears_rust() else {
        eprintln!("skipping: ../gears-rust not present");
        return;
    };
    let opened = vec![SourceRoot::open(SourceId::new("gears-rust").unwrap(), &root).unwrap()];
    let scan = load_catalogue(&opened);

    let path = product_gdl();
    let product = load_product(&path, None);
    let mut intent = product.intent.expect("the product evaluates");
    let selection = intent
        .selected_gears
        .iter_mut()
        .find(|s| s.gear.as_str() == "api-gateway")
        .expect("the demo product names api-gateway");
    selection
        .config
        .insert("enable_docs".to_owned(), serde_json::Value::Bool(true));
    selection.config.insert(
        "prefix_path".to_owned(),
        serde_json::Value::String("/cf".to_owned()),
    );

    let profile = ProfileId::new("dev").unwrap();
    let resolution =
        gearbox_engine::resolve::resolve_at(&scan.catalogue, &intent, &profile, Some(&path));
    let sources = opened
        .iter()
        .map(|r| (r.id.clone(), r.to_resolved()))
        .collect();
    let lock =
        gearbox_engine::resolve::product::assemble(&scan.catalogue, &intent, &resolution, sources);

    // The lock carries it, which is what makes it reachable by a generator at all.
    let gear = lock
        .gears
        .get(&gearbox_ir::GearId::new("api-gateway").unwrap())
        .expect("api-gateway resolved");
    assert_eq!(
        gear.config.get("enable_docs"),
        Some(&serde_json::Value::Bool(true))
    );

    let roots = opened
        .iter()
        .map(|r| (r.id.clone(), r.root.clone()))
        .collect();
    let files = generate(&GenerateInput {
        lock: &lock,
        source_roots: &roots,
        out_root: &out_root(),
    })
    .expect("generation succeeds")
    .files;

    let yaml = text(&files, "config/api-gateway.yaml");
    // A real boolean, not the string the wire used to force.
    assert!(yaml.contains("enable_docs: true"), "{yaml}");
    assert!(yaml.contains("prefix_path: /cf"), "{yaml}");
    // And the projected socket still wins over anything written by hand.
    assert!(yaml.contains("bind_addr:"), "{yaml}");
}

/// M6: a `host_workers` profile generates a crate for the worker too.
///
/// The `local` profile splits `api-contracts` out of the gateway because its
/// contract edge is severable — no pin required — so this exercises the shape
/// the resolver reaches on its own.
#[test]
fn a_host_workers_profile_generates_both_processes() {
    let Some((lock, files)) = generated("local") else {
        return;
    };

    let paths: Vec<&str> = files.files.iter().map(|f| f.path.as_str()).collect();
    for expected in [
        "processes/gateway/src/main.rs",
        "processes/api-contracts/src/main.rs",
        "processes/api-contracts/Cargo.toml",
        "processes/api-contracts/src/registered_gears.rs",
        "config/api-contracts.yaml",
    ] {
        assert!(
            paths.contains(&expected),
            "missing `{expected}` in {paths:?}"
        );
    }

    // Every process in the lock produced a crate. There is no "skipped" list to
    // check any more -- the dispatch on `ProcessKind` is exhaustive, so a kind
    // this cannot generate is a compile error rather than a silent omission.
    assert_eq!(
        paths.iter().filter(|p| p.ends_with("/src/main.rs")).count(),
        lock.processes.len(),
        "one entry point per process in {paths:?}"
    );

    // Both crates are workspace members. A generated crate inside the workspace
    // root that is not a member is what Cargo reports as "believes it's in a
    // workspace when it's not".
    let workspace = text(&files.files, "Cargo.toml");
    assert!(workspace.contains("processes/gateway"), "{workspace}");
    assert!(workspace.contains("processes/api-contracts"), "{workspace}");

    // The worker's entry point is the out-of-process runtime, not the host's.
    let worker_main = text(&files.files, "processes/api-contracts/src/main.rs");
    assert!(
        worker_main.contains("run_oop_with_options"),
        "{worker_main}"
    );
    // Its directory identity, taken from the anchor verbatim.
    assert!(
        worker_main.contains(r#"gear_name: "api-contracts".to_owned()"#),
        "{worker_main}"
    );
    // The line that keeps `TOOLKIT_DIRECTORY_ENDPOINT` working.
    assert!(
        worker_main.contains("..Default::default()"),
        "{worker_main}"
    );

    assert_eq!(
        lock.processes.len(),
        2,
        "the local profile is a host and one worker"
    );
}

/// The trap the runtime sets and the example server in `gears-rust` falls into:
/// a gear both linked into the host and marked `oop` runs twice, because the
/// registry discovers by `inventory` and takes no notice of `runtime.type`.
/// Placement is a link-time decision, and this asserts we make it there.
#[test]
fn a_spawned_gear_is_configured_by_the_host_but_not_linked_into_it() {
    let Some((_, files)) = generated("local") else {
        return;
    };

    let host_links = text(&files.files, "processes/gateway/src/registered_gears.rs");
    let worker_links = text(
        &files.files,
        "processes/api-contracts/src/registered_gears.rs",
    );

    // The worker links its gear; the host does not. `cf_api_contracts` is the
    // library identifier -- the crate has no `[lib]`, which is the whole reason
    // `lib` is declared rather than derived.
    assert!(
        worker_links.contains("use cf_api_contracts as _;"),
        "{worker_links}"
    );
    assert!(
        !host_links.contains("use cf_api_contracts as _;"),
        "the host must not link a gear it spawns:\n{host_links}"
    );

    // But the host must still *configure* it, because the runtime builds its
    // spawn table by iterating configured gears. Configured and linked are
    // different sets, and this is where they differ.
    let host_config = text(&files.files, "config/gateway.yaml");
    assert!(host_config.contains("type: oop"), "{host_config}");
    assert!(
        host_config.contains("gbx-api-contracts"),
        "the executable path comes from the profile's target_dir:\n{host_config}"
    );
}

/// Without `oop_http` the runtime silently takes the legacy gRPC-only path and
/// never registers the gear, which would make the lock's `via directory` a
/// claim about something that cannot happen.
#[test]
fn a_worker_is_configured_to_serve_rest_and_advertise_itself() {
    let Some((lock, files)) = generated("local") else {
        return;
    };

    let worker_config = text(&files.files, "config/api-contracts.yaml");
    assert!(worker_config.contains("oop_http:"), "{worker_config}");
    assert!(worker_config.contains("advertise_uri:"), "{worker_config}");
    // The runtime defaults this to false and refuses to start on a loopback
    // advertise without it.
    assert!(
        worker_config.contains("allow_loopback_advertise: true"),
        "{worker_config}"
    );

    // The address is the resolver's, from the same deduplicated pool the
    // listening ports come from -- not a number the template invented.
    let worker = lock
        .processes
        .iter()
        .find(|p| p.is_worker())
        .expect("the local profile has a worker");
    let serve = worker.serve.as_ref().expect("a worker serves");
    assert!(
        worker_config.contains(&serve.listen_addr),
        "{worker_config}"
    );
    let host_ports: Vec<&str> = lock
        .processes
        .iter()
        .flat_map(|p| p.listens.iter())
        .map(|e| e.address.as_str())
        .collect();
    assert!(
        !host_ports.contains(&serve.listen_addr.as_str()),
        "the worker took a port a gear already binds: {host_ports:?}"
    );
}
