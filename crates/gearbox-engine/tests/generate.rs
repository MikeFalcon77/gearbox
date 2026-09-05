//! The generators, against the real tree.
//!
//! `products/payments-demo/product.gdl` resolved for `dev` is the M5 slice, and
//! everything here asserts against what that produces from `../gears-rust`
//! rather than from a fixture. Fixtures appear in two places, and both say
//! why: the `OperatorOwned` path, because Helm's `values.yaml` is the design's
//! only operator-owned file; and the cluster-secret path, because the demo
//! product's lock has an empty `cluster` list (no gear requires a primitive),
//! so a values-file grep on the demo would pass by having nothing to write.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use gearbox_engine::generate::{GenerateInput, Generated, TemplateSet, base_root_for, generate};
use gearbox_engine::{SourceRoot, load_catalogue, load_product};
use gearbox_ir::{
    ClusterPrimitive, ClusterResolution, FileAction, FileEntry, FileKind, FileSet, GearId,
    InclusionReason, Ownership, ProfileId, RelPath, ResolvedClusterBinding, ResolvedGear,
    ResolvedProduct, Selected, SourceId,
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
    let files = generate_tree(&lock, &source_roots, &out);
    Some((lock, files))
}

fn generate_tree(
    lock: &ResolvedProduct,
    source_roots: &BTreeMap<SourceId, PathBuf>,
    out: &Path,
) -> Generated {
    generate(&GenerateInput {
        lock,
        source_roots,
        out_root: out,
        templates: TemplateSet::new(),
    })
    .expect("generation succeeds for the demo product")
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
    let again = generate_tree(&second, &source_roots, &out);

    let one = generate_tree(&first, &source_roots, &out);

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

/// A one-file set. Hand-built for the writer tests: the real `OperatorOwned`
/// artefact is Helm's `values.yaml`, asserted separately against a generated
/// prod tree.
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
    let files = generate_tree(&lock, &roots, &out_root()).files;

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

/// A product-local template is the file that actually renders.
///
/// Without this the override contract is a comment: a house-style
/// Dockerfile would look like a generator change, and there would be no
/// test that could fail when `get` started ignoring the overlay.
#[test]
fn a_product_template_overrides_the_builtin() {
    let Some((lock, source_roots)) = resolve("dev") else {
        return;
    };
    let mut overrides = BTreeMap::new();
    overrides.insert(
        "main.rs".to_owned(),
        "{{ header }}\nfn main() { /* product-local */ }\n".to_owned(),
    );
    let generated = generate(&GenerateInput {
        lock: &lock,
        source_roots: &source_roots,
        out_root: &out_root(),
        templates: TemplateSet::from_overrides(overrides),
    })
    .expect("generation succeeds with an overlay");
    let main = text(&generated.files, "processes/api-gateway/src/main.rs");
    assert!(
        main.contains("/* product-local */"),
        "the overlay did not win:\n{main}"
    );
    assert!(
        !main.contains("run_server"),
        "the builtin host main survived the overlay:\n{main}"
    );
    assert_eq!(generated.overridden_templates, ["main.rs"]);
}

/// Dockerfiles are a Kubernetes artefact: non-root, ca-certificates, the
/// `--config` the runtime actually reads, and EXPOSE from the process's
/// own sockets rather than a number the template invented.
///
/// The build context is the common ancestor of this tree and the source
/// roots -- generated Cargo.toml path-deps walk out of `.gearbox/` -- and
/// that fact is written into `build.sh` and `.dockerignore` because
/// leaving it as an operator guess is how images fail with a missing crate.
#[test]
fn a_kubernetes_profile_generates_a_dockerfile_per_process() {
    let Some((lock, files)) = generated("prod") else {
        return;
    };

    for process in &lock.processes {
        let path = format!("docker/{}/Dockerfile", process.name);
        let body = text(&files.files, &path);
        let entry = files
            .files
            .get(&RelPath::new(&path).unwrap())
            .expect("just read");
        assert_eq!(entry.kind, FileKind::Dockerfile, "{path}");
        assert!(body.contains("USER 65532"), "{path}:\n{body}");
        assert!(body.contains("ca-certificates"), "{path}:\n{body}");
        assert!(
            body.contains(&format!(
                r#"CMD ["{}", "--config", "/etc/gearbox/{}.yaml"]"#,
                process.bin_name, process.name
            )),
            "{path}:\n{body}"
        );
        for endpoint in &process.listens {
            if let Some(port) = endpoint.address.rsplit(':').next() {
                assert!(
                    body.contains(&format!("EXPOSE {port}")),
                    "{path} missing EXPOSE {port}:\n{body}"
                );
            }
        }
        if let Some(serve) = &process.serve
            && let Some(port) = serve.listen_addr.rsplit(':').next()
        {
            assert!(
                body.contains(&format!("EXPOSE {port}")),
                "{path} missing worker EXPOSE {port}:\n{body}"
            );
        }
    }

    let ignore = text(&files.files, "docker/.dockerignore");
    assert!(ignore.contains("**/target/"), "{ignore}");
    assert!(ignore.contains("**/.git/"), "{ignore}");
    assert!(
        ignore.contains("gears-rust/config/"),
        "the corpus config/ (unignored secrets) must be excluded:\n{ignore}"
    );
    assert!(
        !ignore.contains("**/config/"),
        "a blanket config/ ignore would drop the generated --config file:\n{ignore}"
    );

    let script = text(&files.files, "docker/build.sh");
    assert!(script.starts_with("#!/bin/sh\n"), "{script}");
    assert!(script.contains("docker build"), "{script}");
    assert!(
        script.contains("--ignorefile"),
        "generate() cannot write .dockerignore at the context root:\n{script}"
    );
    for process in &lock.processes {
        assert!(
            script.contains(process.name.as_str()),
            "build.sh does not name {}:\n{script}",
            process.name
        );
    }
}

/// The chart is an umbrella with one subchart per process, because Helm
/// looks for subcharts under `charts/` and each process is a separate
/// workload, Service, `ConfigMap` and `ServiceAccount`.
#[test]
fn a_kubernetes_profile_generates_an_umbrella_and_a_subchart_per_process() {
    let Some((lock, files)) = generated("prod") else {
        return;
    };
    let product = lock.product.id.as_str();
    let chart = text(&files.files, &format!("helm/{product}/Chart.yaml"));
    assert!(chart.contains("apiVersion: v2"), "{chart}");
    assert!(
        !chart.contains("<<"),
        "Chart.yaml is serialized data, not a template:\n{chart}"
    );
    for process in &lock.processes {
        let sub = process.subchart.as_deref().unwrap_or(process.name.as_str());
        assert!(
            chart.contains(&format!("condition: {sub}.enabled")),
            "{chart}"
        );
        assert_subchart_deployment(&files.files, product, sub);
        assert_subchart_security_defaults(&files.files, product, sub);
        let values = text(&files.files, &format!("helm/{product}/values.yaml"));
        assert!(values.contains(&format!("{sub}:")), "{values}");
        assert!(values.contains("enabled: true"), "{values}");
    }

    let gateway_config = text(&files.files, "config/api-gateway.yaml");
    assert!(
        gateway_config.contains("home_dir: /var/lib/gearbox"),
        "readOnlyRootFilesystem makes ~ unwritable:\n{gateway_config}"
    );
}

/// `prod` is the first profile that writes `consumer_wiring`, because that is
/// the first profile whose bindings cross a process boundary *and* have an
/// endpoint. The key is the provider gear's name -- the runtime looks up
/// `gears.{consumer}.config.consumer_wiring.{dep_gear}` -- not the contract.
#[test]
fn a_kubernetes_worker_wires_the_provider_gear_not_the_contract() {
    let Some((_, files)) = generated("prod") else {
        return;
    };
    let audit = text(&files.files, "config/audit.yaml");
    assert!(
        audit.contains("consumer_wiring:"),
        "audit is the remote consumer; without this it dials nothing:\n{audit}"
    );
    assert!(
        audit.contains("api-contracts:"),
        "the runtime keys consumer_wiring by the provider gear, not PaymentApi:\n{audit}"
    );
    assert!(
        !audit.contains("payment_api:"),
        "a contract-derived key is the defect M7 step 1 closed:\n{audit}"
    );
}

fn assert_subchart_deployment(files: &FileSet, product: &str, sub: &str) {
    let deploy = text(
        files,
        &format!("helm/{product}/charts/{sub}/templates/deployment.yaml"),
    );
    assert!(
        deploy.contains("checksum/config"),
        "subPath mounts do not update in place:\n{deploy}"
    );
    assert!(deploy.contains("subPath:"), "{deploy}");
    assert!(deploy.contains("path: /healthz"), "{deploy}");
    assert!(deploy.contains("path: /readyz"), "{deploy}");
    assert!(
        !deploy.contains("path: /health\n"),
        "/health is liveness-hostile (503 on a sick dependency):\n{deploy}"
    );
    assert!(deploy.contains("POD_NAME"), "{deploy}");
    assert!(deploy.contains("POD_NAMESPACE"), "{deploy}");
    assert!(
        deploy.contains("nodeSelector"),
        "Vision §56 hatches must be in the template, not only the schema:\n{deploy}"
    );
    assert!(
        deploy.contains("existingSecret"),
        "secretKeyRef is gated on the operator naming a Secret:\n{deploy}"
    );
    assert!(deploy.contains("secretKeyRef"), "{deploy}");
    assert!(
        !deploy.contains("<<"),
        "`<<` survived into the Helm template:\n{deploy}"
    );
    assert!(
        deploy.contains("{{ include"),
        "Helm's `{{ }}` did not survive:\n{deploy}"
    );
}

/// The restricted Pod Security Standard is still the default -- but as values.
///
/// It used to be literal text in `_helpers.tpl`, where an operator could not
/// reach it. Asserting on `values.yaml` now, and asserting the template *reads*
/// the value rather than re-stating the standard, is what keeps the default
/// strict without making it unreachable: a template that hardcoded these again
/// would pass a grep of the rendered output and fail this.
fn assert_subchart_security_defaults(files: &FileSet, product: &str, sub: &str) {
    let values = text(files, &format!("helm/{product}/values.yaml"));
    for field in [
        "runAsNonRoot: true",
        "runAsUser: 65532",
        "fsGroup: 65532",
        "readOnlyRootFilesystem: true",
        "allowPrivilegeEscalation: false",
        "RuntimeDefault",
    ] {
        assert!(values.contains(field), "values must default to `{field}`");
    }

    let helpers = text(
        files,
        &format!("helm/{product}/charts/{sub}/templates/_helpers.tpl"),
    );
    assert!(
        !helpers.contains("readOnlyRootFilesystem"),
        "a security context in the template is one an operator cannot edit:\n{helpers}"
    );

    let deploy = text(
        files,
        &format!("helm/{product}/charts/{sub}/templates/deployment.yaml"),
    );
    // `with`, not `if`: an operator who empties the map means "omit the block",
    // and that is exactly what a cluster assigning its own UIDs needs to say.
    assert!(
        deploy.contains("{{- with .Values.podSecurityContext }}"),
        "{deploy}"
    );
    assert!(
        deploy.contains("{{- with .Values.containerSecurityContext }}"),
        "{deploy}"
    );
}

/// Chart.yaml, values*.yaml and values.schema.json are serialized data.
///
/// minijinja would turn a version string or a `$comment` into an accidental
/// substitution, and a test that only greps the Helm templates would not
/// catch it. `{{` belongs in templates/; these four files must not have it.
#[test]
fn chart_and_values_are_serialized_not_templated() {
    let Some((lock, files)) = generated("prod") else {
        return;
    };
    let product = lock.product.id.as_str();
    for path in [
        format!("helm/{product}/Chart.yaml"),
        format!("helm/{product}/values.yaml"),
        format!("helm/{product}/values.generated.yaml"),
        format!("helm/{product}/values.schema.json"),
    ] {
        let body = text(&files.files, &path);
        for marker in ["<<", "<%", "<#", "{{", "}}"] {
            assert!(
                !body.contains(marker),
                "`{marker}` in `{path}`, which is serialized data:\n{body}"
            );
        }
    }
}

/// `values.yaml` is the operator's, so a second generate reconciles rather
/// than overwrites. `values.generated.yaml` is the lock's copy, always ours.
#[test]
fn values_yaml_is_operator_owned_and_the_generated_copy_is_not() {
    let Some((lock, files)) = generated("prod") else {
        return;
    };
    let product = lock.product.id.as_str();
    let owned = files
        .files
        .get(&RelPath::new(format!("helm/{product}/values.yaml")).unwrap())
        .expect("values.yaml");
    assert_eq!(owned.ownership, Ownership::OperatorOwned);
    let generated_copy = files
        .files
        .get(&RelPath::new(format!("helm/{product}/values.generated.yaml")).unwrap())
        .expect("values.generated.yaml");
    assert_eq!(generated_copy.ownership, Ownership::Generated);
}

/// The schema rejects a key it does not know and a replicaCount that is not
/// an integer -- the two `--set` mistakes Helm would otherwise accept.
#[test]
fn values_schema_rejects_unknown_keys_and_wrong_types() {
    let Some((lock, files)) = generated("prod") else {
        return;
    };
    let product = lock.product.id.as_str();
    let schema: serde_json::Value = serde_json::from_str(text(
        &files.files,
        &format!("helm/{product}/values.schema.json"),
    ))
    .expect("schema is JSON");
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["type"], "object");
    let gateway = &schema["properties"]["api-gateway"];
    assert_eq!(gateway["additionalProperties"], false);
    assert_eq!(gateway["properties"]["replicaCount"]["type"], "integer");
    for hatch in [
        "nameOverride",
        "fullnameOverride",
        "podAnnotations",
        "nodeSelector",
        "tolerations",
        "affinity",
        "resources",
        "extraEnv",
        "extraVolumes",
        "extraVolumeMounts",
        "podSecurityContext",
        "containerSecurityContext",
        "existingSecret",
        "secretKeys",
    ] {
        assert!(
            gateway["properties"].get(hatch).is_some(),
            "schema is missing hatch `{hatch}`"
        );
    }
    // `["string", "null"]`, not `"string"`: the field is optional and the schema
    // is now derived from the struct rather than hand-written beside it. The
    // hand-written copy is what let `global` drift until `helm lint` rejected
    // the `commonLabels` the generator itself had written, so a looser but
    // truthful type is the trade being made deliberately.
    let global = &schema["properties"]["global"]["properties"];
    for (key, expected) in [("imageRegistry", "string"), ("imagePullSecrets", "array")] {
        let ty = &global[key]["type"];
        let admits = ty == expected
            || ty
                .as_array()
                .is_some_and(|kinds| kinds.iter().any(|kind| kind == expected));
        assert!(admits, "global.{key} should admit {expected}, got {ty}");
    }
    for key in ["commonLabels", "commonAnnotations"] {
        assert!(
            global.get(key).is_some(),
            "the derived schema must carry `global.{key}`, or `helm lint` \
             rejects the values this generator writes"
        );
    }
}

/// The demo product cannot prove `cpt-gearbox-fr-no-secrets-in-values`.
///
/// `ResolvedProduct::cluster` for payments-demo/prod is empty: the product
/// declares a postgres profile with `${PG_PASSWORD}`, but no gear in the
/// corpus requires a cluster primitive, so the binding never reaches the
/// lock. Acceptance greps on the demo values files pass because there is
/// nothing to write. This test uses a lock fixture with a cluster binding
/// so the generator is actually exercised.
#[test]
fn generated_values_name_a_secret_and_never_contain_one() {
    let Some((lock, files)) = generated_with_cluster_secret() else {
        return;
    };
    let product = lock.product.id.as_str();
    for path in [
        format!("helm/{product}/values.yaml"),
        format!("helm/{product}/values.generated.yaml"),
    ] {
        let body = text(&files.files, &path);
        assert!(
            !body.to_ascii_lowercase().contains("password:")
                && !body.to_ascii_lowercase().contains("apikey:"),
            "`{path}` must not carry a credential:\n{body}"
        );
        assert!(
            body.contains("existingSecret: payments-demo-pg"),
            "`{path}` should name the operator's Secret, not invent one:\n{body}"
        );
        assert!(
            body.contains("PG_PASSWORD"),
            "`{path}` should list the env names the runtime will expand:\n{body}"
        );
    }

    let config = text(&files.files, "config/audit.yaml");
    assert!(
        config.contains("${PG_PASSWORD}"),
        "the placeholder has to reach the ConfigMap so secretKeyRef can fill it:\n{config}"
    );
    assert!(!config.contains("supersecret"), "{config}");
}

fn generated_with_cluster_secret() -> Option<(ResolvedProduct, Generated)> {
    let (mut lock, source_roots) = resolve("prod")?;
    let root = gears_rust()?;
    let opened = vec![SourceRoot::open(SourceId::new("gears-rust").unwrap(), &root).unwrap()];
    let scan = load_catalogue(&opened);
    let cluster_id = GearId::new("cluster").unwrap();
    let descriptor = scan.catalogue.gears.get(&cluster_id).cloned()?;

    let crate_dir = descriptor.crate_dir();
    lock.gears.insert(
        cluster_id.clone(),
        ResolvedGear {
            id: cluster_id.clone(),
            source: descriptor.source,
            gdl_path: descriptor.gdl_path,
            package: descriptor.package,
            crate_dir,
            runtime_caps: descriptor.runtime_caps,
            colocated_deps: descriptor.colocated_deps,
            selected_by: vec![InclusionReason::Selected],
            config: BTreeMap::new(),
        },
    );

    let process = lock
        .processes
        .iter_mut()
        .find(|p| p.name.as_str() == "audit")
        .expect("the demo's audit worker");
    if !process.gears.iter().any(|g| g == &cluster_id) {
        process.gears.push(cluster_id);
    }
    let requester = process.anchor.clone();
    lock.cluster.push(ResolvedClusterBinding {
        scope: "main".to_owned(),
        primitive: ClusterPrimitive::Cache,
        required_capabilities: BTreeSet::default(),
        requesters: vec![requester],
        selected: Selected::honoured("postgres".to_owned()),
        resolved: ClusterResolution::Provider {
            name: "postgres".to_owned(),
        },
        options: BTreeMap::from([(
            "connection_string".to_owned(),
            serde_json::json!(
                "postgres://payments@${PG_HOST}:5432/payments?password=${PG_PASSWORD}"
            ),
        )]),
        secret_ref: Some("existingSecret:payments-demo-pg".to_owned()),
    });

    let files = generate_tree(&lock, &source_roots, &out_root());
    Some((lock, files))
}

/// A host's probes follow `prefix_path`, and a worker's never do.
///
/// This is the defect that makes the platform's own hand-written chart
/// undeployable: it probes `/health` while its `ConfigMap` sets
/// `prefix_path: "/cf"`, so the kubelet gets a 404 and the pod never passes
/// readiness. The demo product sets no prefix, so without injecting one here the
/// prefixed branch is dark and a regression to "always unprefixed" would keep
/// every other test green.
///
/// The worker half matters just as much and for the opposite reason: an
/// out-of-process gear serves its probes from the runtime's own listener, which
/// has no prefix to inherit. Prefixing a worker would break what works.
#[test]
fn host_probes_follow_the_rest_prefix_and_worker_probes_do_not() {
    let Some(root) = gears_rust() else {
        eprintln!("skipping: ../gears-rust not present");
        return;
    };
    let opened = vec![SourceRoot::open(SourceId::new("gears-rust").unwrap(), &root).unwrap()];
    let scan = load_catalogue(&opened);

    let path = product_gdl();
    let product = load_product(&path, None);
    let mut intent = product.intent.expect("the product evaluates");
    intent
        .selected_gears
        .iter_mut()
        .find(|s| s.gear.as_str() == "api-gateway")
        .expect("the demo product names api-gateway")
        .config
        .insert(
            "prefix_path".to_owned(),
            serde_json::Value::String("/cf".to_owned()),
        );

    let profile = ProfileId::new("prod").unwrap();
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
    let files = generate(&GenerateInput {
        lock: &lock,
        source_roots: &roots,
        out_root: &out_root(),
        templates: TemplateSet::new(),
    })
    .expect("generation succeeds")
    .files;

    let host = text(
        &files,
        "helm/payments-demo/charts/api-gateway/templates/deployment.yaml",
    );
    assert!(host.contains("path: /cf/healthz"), "{host}");
    assert!(host.contains("path: /cf/readyz"), "{host}");

    // A worker mounts nothing on the gateway, so its probes stay at the root.
    let worker = text(
        &files,
        "helm/payments-demo/charts/audit/templates/deployment.yaml",
    );
    assert!(worker.contains("path: /healthz"), "{worker}");
    assert!(
        !worker.contains("/cf/"),
        "a worker must not inherit the host's prefix:\n{worker}"
    );
}

/// The registry stays out of `repository`, so a mirror override composes.
///
/// Helm's convention is that a site sets `global.imageRegistry` once and every
/// image moves to its mirror. That works only when the per-image value it
/// replaces is the registry alone. This generator used to fold the registry into
/// `repository` and split it back out by looking for the last colon, which put
/// *both* registries in the rendered reference --
/// `mirror.corp/registry.example.com/payments/gbx-audit:0.1.0`, an image that
/// does not exist anywhere. Measured before the fix, not deduced.
///
/// Asserting on the values rather than on a rendered chart because `helm` is not
/// a build dependency; the template's composition is pinned separately by
/// `assert_subchart_deployment`.
#[test]
fn the_image_registry_is_a_value_of_its_own() {
    let Some((lock, files)) = generated("prod") else {
        return;
    };
    let product = lock.product.id.as_str();
    let values = text(&files.files, &format!("helm/{product}/values.yaml"));

    assert!(
        values.contains("registry: registry.example.com/payments"),
        "the registry must be its own key:\n{values}"
    );
    assert!(
        values.contains("repository: gbx-audit"),
        "the repository must not carry the registry:\n{values}"
    );
    for process in &lock.processes {
        let image = process.image.as_ref().expect("kubernetes builds images");
        assert!(
            !image.repository.contains('/'),
            "`{}` still carries a registry",
            image.repository
        );
    }

    // The template's two-source composition: the per-image registry by default,
    // `global.imageRegistry` when the operator sets one.
    let sub = lock.processes[0]
        .subchart
        .as_deref()
        .unwrap_or(lock.processes[0].name.as_str());
    let deployment = text(
        &files.files,
        &format!("helm/{product}/charts/{sub}/templates/deployment.yaml"),
    );
    assert!(
        deployment.contains("$registry := .Values.image.registry"),
        "{deployment}"
    );
    assert!(
        deployment.contains("$registry = .Values.global.imageRegistry"),
        "{deployment}"
    );
}

/// No `serde_json::Value` reaches the YAML serializer carrying a number.
///
/// The YAML writer is pinned to the dialect `gears-rust` reads, and it does not
/// understand the private newtype `serde_json` wraps numbers in. A field typed
/// as `serde_json::Value` therefore serializes `65532` as
/// `{"$serde_json::private::Number": "65532"}` -- valid YAML, silently wrong,
/// and only visible if someone reads the file. Several values fields still have
/// that type and are simply never populated today; this fails the moment one is.
#[test]
fn generated_yaml_carries_no_serde_json_internals() {
    let Some((lock, files)) = generated("prod") else {
        return;
    };
    let product = lock.product.id.as_str();
    for name in ["values.yaml", "values.generated.yaml"] {
        let body = text(&files.files, &format!("helm/{product}/{name}"));
        assert!(
            !body.contains("$serde_json"),
            "{name} leaked serde_json's private number encoding:\n{body}"
        );
    }
}

/// `drop: [ALL]`, in capitals, or Pod Security Admission refuses the pod.
///
/// PSA compares the dropped capability against the literal `ALL`. The template
/// this replaced wrote `all`, so the chart failed the `restricted` profile it
/// existed to satisfy -- and looked correct in every review.
#[test]
fn dropped_capabilities_use_the_spelling_admission_checks() {
    let Some((lock, files)) = generated("prod") else {
        return;
    };
    let values = text(
        &files.files,
        &format!("helm/{}/values.yaml", lock.product.id.as_str()),
    );
    assert!(values.contains("- ALL"), "{values}");
    assert!(
        !values.contains("- all"),
        "lowercase `all` is not what admission matches:\n{values}"
    );
}

/// Every resource carries the house labels, and every resource means every one.
///
/// A policy that requires `cost-center` on everything is satisfied by three
/// resources out of four exactly as well as by none. The label set used to be
/// literal text in `_helpers.tpl`, so adding a key meant replacing the helper --
/// and a replacement is what the operator was supposed to be spared.
///
/// Asserted on the templates rather than on rendered output because `helm` is
/// not a build dependency; the render was measured by hand, and this is what
/// keeps a fifth resource from being added without its labels.
#[test]
fn the_house_label_hooks_reach_all_four_resources() {
    let Some((lock, files)) = generated("prod") else {
        return;
    };
    let product = lock.product.id.as_str();
    let sub = lock.processes[0]
        .subchart
        .as_deref()
        .unwrap_or(lock.processes[0].name.as_str());

    for resource in ["deployment", "service", "configmap", "serviceaccount"] {
        let body = text(
            &files.files,
            &format!("helm/{product}/charts/{sub}/templates/{resource}.yaml"),
        );
        assert!(
            body.contains(&format!(r#"include "{sub}.labels""#)),
            "{resource}.yaml does not carry the shared labels:\n{body}"
        );
        assert!(
            body.contains(&format!(r#"include "{sub}.annotations""#)),
            "{resource}.yaml does not carry the shared annotations:\n{body}"
        );
    }

    let helpers = text(
        &files.files,
        &format!("helm/{product}/charts/{sub}/templates/_helpers.tpl"),
    );
    assert!(helpers.contains(".commonLabels"), "{helpers}");
    assert!(helpers.contains(".commonAnnotations"), "{helpers}");

    // The umbrella writes the block empty rather than omitting it: a key absent
    // from the file the operator edits is a key nobody finds.
    let values = text(&files.files, &format!("helm/{product}/values.yaml"));
    assert!(values.contains("global:"), "{values}");
    assert!(values.contains("commonLabels:"), "{values}");

    // The selector is immutable after creation; a label reaching it would make
    // the next upgrade fail rather than roll.
    let deployment = text(
        &files.files,
        &format!("helm/{product}/charts/{sub}/templates/deployment.yaml"),
    );
    let selector = deployment
        .split("matchLabels:")
        .nth(1)
        .and_then(|rest| rest.split("template:").next())
        .expect("a selector");
    assert!(
        !selector.contains("commonLabels") && !selector.contains("podLabels"),
        "the selector must stay exactly the standard set:\n{selector}"
    );
}

/// Probe timings are the operator's; the probe address is the lock's.
///
/// Before this the block was three lines of template with no schedule at all, so
/// a process slow to start in somebody else's cluster was killed and restarted
/// forever and the only cure was replacing the template. The path stays out of
/// values because it is derived: the REST host's `prefix_path` moves `/healthz`
/// to `/cf/healthz`, and a path an operator could type is a path that can
/// disagree with the configuration this same run generated.
#[test]
fn probe_timings_are_values_and_probe_paths_are_not() {
    let Some((lock, files)) = generated("prod") else {
        return;
    };
    let product = lock.product.id.as_str();
    let values = text(&files.files, &format!("helm/{product}/values.yaml"));

    for probe in ["livenessProbe:", "readinessProbe:", "startupProbe:"] {
        assert!(values.contains(probe), "{probe} missing:\n{values}");
    }
    assert!(values.contains("periodSeconds: 10"), "{values}");
    assert!(values.contains("failureThreshold: 30"), "{values}");
    assert!(
        !values.contains("/healthz") && !values.contains("/readyz"),
        "a probe path in values is one that can contradict the config:\n{values}"
    );

    let sub = lock.processes[0]
        .subchart
        .as_deref()
        .unwrap_or(lock.processes[0].name.as_str());
    let deployment = text(
        &files.files,
        &format!("helm/{product}/charts/{sub}/templates/deployment.yaml"),
    );
    // `omit "enabled"`: the flag decides whether the probe exists, and would be
    // an unknown field if it reached the manifest.
    assert!(
        deployment.contains(r#"omit .Values.livenessProbe "enabled""#),
        "{deployment}"
    );
    assert!(
        deployment.contains("{{- if .Values.startupProbe.enabled }}"),
        "a startup probe suppresses liveness, so it must be opt-in:\n{deployment}"
    );
}

/// The home volume names its kind, because Helm merges values rather than
/// replacing them.
///
/// With the default written as the Kubernetes shape -- `{emptyDir: {}}` -- an
/// operator who set `{persistentVolumeClaim: {...}}` got a volume carrying
/// *both* sources, which the API server rejects. Seen in the rendered manifest.
/// A discriminator the operator overwrites makes that unrepresentable.
#[test]
fn the_home_volume_is_chosen_by_a_field_not_by_a_shape() {
    let Some((lock, files)) = generated("prod") else {
        return;
    };
    let product = lock.product.id.as_str();
    let values = text(&files.files, &format!("helm/{product}/values.yaml"));
    assert!(values.contains("type: emptyDir"), "{values}");
    assert!(
        !values.contains("emptyDir: {}"),
        "the Kubernetes shape as a default is what merged wrongly:\n{values}"
    );

    let sub = lock.processes[0]
        .subchart
        .as_deref()
        .unwrap_or(lock.processes[0].name.as_str());
    let deployment = text(
        &files.files,
        &format!("helm/{product}/charts/{sub}/templates/deployment.yaml"),
    );
    assert!(
        deployment.contains(r#"eq .Values.homeVolume.type "persistentVolumeClaim""#),
        "{deployment}"
    );
    // A claim with no name would render a Deployment that cannot schedule; the
    // failure belongs at `helm template`, where someone is watching.
    assert!(
        deployment.contains("required \"homeVolume.claimName"),
        "{deployment}"
    );
}

/// The escape hatches an ordinary production chart is expected to have.
///
/// Each was absent, and absent meant "replace the template": there was no
/// `type` line on the Service at all, no annotations on the `ServiceAccount` --
/// which is how all three managed Kubernetes offerings hand a pod its cloud
/// identity -- and no rollout, scheduling or sidecar controls anywhere.
#[test]
fn the_chart_exposes_the_hatches_a_house_policy_needs() {
    let Some((lock, files)) = generated("prod") else {
        return;
    };
    let product = lock.product.id.as_str();
    let schema: serde_json::Value = serde_json::from_str(text(
        &files.files,
        &format!("helm/{product}/values.schema.json"),
    ))
    .expect("valid JSON");
    let sub = lock.processes[0]
        .subchart
        .as_deref()
        .unwrap_or(lock.processes[0].name.as_str());
    let properties = &schema["properties"][sub]["properties"];

    for hatch in [
        "service",
        "homeVolume",
        "automountServiceAccountToken",
        "strategy",
        "terminationGracePeriodSeconds",
        "priorityClassName",
        "topologySpreadConstraints",
        "revisionHistoryLimit",
        "initContainers",
        "extraContainers",
    ] {
        assert!(
            properties.get(hatch).is_some(),
            "schema is missing hatch `{hatch}`"
        );
    }
    assert!(
        properties["serviceAccount"]["properties"]
            .get("annotations")
            .is_some(),
        "without these no managed Kubernetes can give the pod an identity"
    );

    // Nothing in a generated topology talks to the API server -- the resolver set
    // is Directory, Null and Static, which is what GBX0603 reports -- so the
    // token would be an unused credential in every pod.
    let values = text(&files.files, &format!("helm/{product}/values.yaml"));
    assert!(
        values.contains("automountServiceAccountToken: false"),
        "{values}"
    );
}

/// One open door in a closed schema, so a replaced template has somewhere to read.
///
/// `additionalProperties: false` is what `cpt-gearbox-fr-values-schema` asks for
/// and it earns its keep -- a misspelled `replicaCount` is refused. But it also
/// refused every key a *house* template might read, so a site could override
/// `helm/deployment.yaml` and then have nowhere to put the values that template
/// needed. `custom` is unchecked; everything around it stays closed.
#[test]
fn custom_is_open_and_everything_around_it_is_closed() {
    let Some((lock, files)) = generated("prod") else {
        return;
    };
    let product = lock.product.id.as_str();
    let schema: serde_json::Value = serde_json::from_str(text(
        &files.files,
        &format!("helm/{product}/values.schema.json"),
    ))
    .expect("valid JSON");
    let sub = lock.processes[0]
        .subchart
        .as_deref()
        .unwrap_or(lock.processes[0].name.as_str());

    assert_eq!(schema["properties"][sub]["additionalProperties"], false);
    let custom = &schema["properties"][sub]["properties"]["custom"];
    assert_eq!(custom["type"], "object");
    assert_ne!(
        custom["additionalProperties"], false,
        "a closed `custom` would be no door at all: {custom}"
    );

    // Written out empty rather than omitted: a door nobody can see is a door
    // nobody opens.
    let values = text(&files.files, &format!("helm/{product}/values.yaml"));
    assert!(values.contains("custom: {}"), "{values}");
}
