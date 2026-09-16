//! Write gates refuse paths that look inside the workspace until they are
//! resolved, and they refuse a clone source that is not a `.gdl` the session
//! may read.
//!
//! `writable_out_root` used to canonicalize the nearest *existing* ancestor
//! and `join` the rest, including `..`. `Path::starts_with` then compared the
//! unresolved path, so `workspace/keep/missing/../../../outside` passed the
//! gate and `create_dir_all` created the escaped location.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use lsp_server::RequestId;

use super::*;
use crate::protocol::{CreateProductParams, ScaffoldGearParams};

static NEXT: AtomicUsize = AtomicUsize::new(0);

fn scratch(label: &str) -> PathBuf {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crate lives under the workspace");
    let nth = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = repo.join(format!(
        "target/gbx-write-gate-{label}-{}-{nth}",
        std::process::id()
    ));
    drop(std::fs::remove_dir_all(&dir));
    std::fs::create_dir_all(&dir).expect("scratch directory");
    dir
}

fn write_state(workspace: PathBuf) -> State {
    state_with_roots(workspace, &[])
}

/// A write-enabled session with source roots, for the gate that is about them.
///
/// `write_state` declares none, which is why the source-root branch of
/// `writable_out_root` went uncovered by `make check` for as long as it did: only
/// `ide/scripts/rpc-smoke.mjs` ever passed a real corpus, and that script is not
/// part of it.
fn state_with_roots(workspace: PathBuf, roots: &[PathBuf]) -> State {
    let (roots, failed_roots) = open_roots(roots);
    State {
        roots,
        catalogue: None,
        failed_roots,
        initialized: true,
        allow_writes: true,
        workspace: Some(workspace),
    }
}

fn create_params(path: &Path, clone_from: Option<String>) -> CreateProductParams {
    CreateProductParams {
        path: path.display().to_string(),
        id: "demo".to_owned(),
        name: "Demo".to_owned(),
        version: "0.1.0".to_owned(),
        sources: vec![],
        profile_kind: "embedded".to_owned(),
        profile_id: "dev".to_owned(),
        clone_from,
        dry_run: true,
    }
}

/// Ids are checked before anything is created, and before the path is.
///
/// **Neither id was checked at all.** `create_product` stamped whatever arrived,
/// so an empty box produced `id = ""` with a destination of
/// `products//product.gdl`, and a single space produced `id = " "` in a product
/// that then opened and resolved with no diagnostics -- a product whose identity
/// is a space. The same function built a validated `SourceId` for the literal
/// `"product"` eighty lines further down, so the validator was present for the
/// value that could not be wrong and missing for the two that come from a person.
///
/// Checked before `writable_out_root` on purpose: a refusal that also created a
/// directory would be a refusal with a side effect.
#[test]
fn a_blank_or_malformed_id_is_refused_before_anything_is_written() {
    let tmp = scratch("product-id");
    let workspace = tmp.join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let target = workspace.join("products").join("demo").join("product.gdl");

    for bad in ["", " ", "Demo", "demo_product", "-demo", "demo-", "de--mo", "1demo"] {
        let mut params = create_params(&target, None);
        params.id = bad.to_owned();
        let mut state = write_state(workspace.clone());
        let response = create_product(&mut state, RequestId::from(1), &params);
        let message = match response.response_result {
            Err(e) => e.message,
            Ok(_) => panic!("`{bad}` must not be accepted as a product id"),
        };
        assert!(
            message.contains("product id"),
            "`{bad}`: the refusal must name what was wrong: {message}"
        );
        assert!(
            !target.exists(),
            "`{bad}`: nothing may be written for a refused id"
        );
    }

    // The profile id goes through the same gate, on the same call.
    let mut params = create_params(&target, None);
    params.profile_id = " ".to_owned();
    let mut state = write_state(workspace.clone());
    let response = create_product(&mut state, RequestId::from(1), &params);
    let message = match response.response_result {
        Err(e) => e.message,
        Ok(_) => panic!("a blank profile id must not be accepted"),
    };
    assert!(message.contains("profile id"), "{message}");

    // And the shape the corpus already uses is accepted, so the rule is not
    // merely refusing everything.
    let mut params = create_params(&target, None);
    params.id = "payments-demo".to_owned();
    let mut state = write_state(workspace);
    let response = create_product(&mut state, RequestId::from(1), &params);
    assert!(
        response.response_result.is_ok(),
        "a kebab-case id must be accepted: {response:?}"
    );
}

#[test]
fn missing_dir_plus_dotdot_is_outside_the_workspace() {
    let tmp = scratch("dotdot");
    let workspace = tmp.join("ws");
    std::fs::create_dir_all(workspace.join("keep")).unwrap();
    let escaped = tmp.join("pwned");
    let attack = workspace
        .join("keep")
        .join("missing")
        .join("..")
        .join("..")
        .join("..")
        .join("pwned");

    let state = write_state(workspace);
    let err = writable_out_root(&state, &attack).expect_err("must refuse a lexical escape");
    assert!(err.contains("outside the declared workspace"), "{err}");
    assert!(
        !escaped.exists(),
        "the gate must not create the escaped location"
    );
}

/// A source root beside the workspace gets the source-root refusal, not the
/// workspace one.
///
/// **Both rules apply and the specific one has to win.** The corpus is a
/// *sibling* of this repository -- `products/payments-demo` names
/// `../../../gears-rust` -- so generating into it is simultaneously "outside the
/// declared workspace" and "inside a source root". The second sentence is the one
/// a person can act on: it names the rule (ADR-0010 tier 5, do not write next to
/// human-authored crates) instead of describing a boundary they did not cross on
/// purpose.
///
/// `writable_out_root` said so in a comment and did the opposite: the workspace
/// check returned first, which made its own source-root loop unreachable for
/// exactly the layout the comment names. `ide/scripts/rpc-smoke.mjs` asserted the
/// intent and had been failing on it; this is the same claim where `make check`
/// can see it.
#[test]
fn a_source_root_beside_the_workspace_gets_the_specific_refusal() {
    let tmp = scratch("out-in-sibling-source-root");
    let workspace = tmp.join("ws");
    let corpus = tmp.join("gears-rust");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(corpus.join("gears")).unwrap();

    let state = state_with_roots(workspace, std::slice::from_ref(&corpus));
    let err = writable_out_root(&state, &corpus.join("generated"))
        .expect_err("generation must not write into a source root");
    assert!(
        err.contains("inside a source root"),
        "the refusal must name the rule, not the boundary: {err}"
    );
}

/// The other order still holds: outside everything is a workspace refusal.
///
/// The pair matters. Making the source-root sentence win must not turn every
/// out-of-workspace path into one, and this is the case that would catch it --
/// a directory that is outside the workspace and inside no source root.
#[test]
fn a_root_outside_everything_is_still_a_workspace_refusal() {
    let tmp = scratch("out-outside-everything");
    let workspace = tmp.join("ws");
    let corpus = tmp.join("gears-rust");
    let elsewhere = tmp.join("elsewhere");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(corpus.join("gears")).unwrap();
    std::fs::create_dir_all(&elsewhere).unwrap();

    let state = state_with_roots(workspace, &[corpus]);
    let err = writable_out_root(&state, &elsewhere.join("generated"))
        .expect_err("generation must stay inside the workspace");
    assert!(err.contains("outside the declared workspace"), "{err}");
}

#[test]
fn a_new_directory_inside_the_workspace_is_allowed() {
    let tmp = scratch("inside");
    let workspace = tmp.join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let wanted = workspace.join("brand").join("new");
    let state = write_state(workspace.clone());
    let resolved = writable_out_root(&state, &wanted).expect("missing dirs under the workspace");
    assert!(resolved.starts_with(workspace.canonicalize().unwrap()));
    assert!(!wanted.exists(), "the gate resolves; it does not create");
}

#[test]
fn clone_from_a_non_gdl_path_is_refused_before_read() {
    let tmp = scratch("clone-passwd");
    let workspace = tmp.join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let outside = tmp.join("secret.txt");
    std::fs::write(&outside, "not a description\n").unwrap();

    let mut state = write_state(workspace.clone());
    let dest = workspace.join("product.gdl");
    let response = create_product(
        &mut state,
        RequestId::from(1),
        &create_params(&dest, Some(outside.display().to_string())),
    );
    let message = match response.response_result {
        Err(e) => e.message,
        Ok(_) => panic!("must refuse"),
    };
    assert!(
        message.contains("not a `.gdl`") || message.contains("outside"),
        "{message}"
    );
}

#[test]
fn clone_from_a_gdl_outside_the_workspace_is_refused() {
    let tmp = scratch("clone-outside");
    let workspace = tmp.join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let outside = tmp.join("evil.gdl");
    std::fs::write(&outside, "product(id = \"x\")\n").unwrap();

    let mut state = write_state(workspace.clone());
    let dest = workspace.join("product.gdl");
    let response = create_product(
        &mut state,
        RequestId::from(1),
        &create_params(&dest, Some(outside.display().to_string())),
    );
    let message = match response.response_result {
        Err(e) => e.message,
        Ok(_) => panic!("must refuse"),
    };
    assert!(
        message.contains("outside the declared workspace")
            || message.contains("outside the declared workspace and every source root"),
        "{message}"
    );
}

#[test]
fn scaffold_refuses_a_dotdot_id() {
    let tmp = scratch("scaffold-dotdot");
    let workspace = tmp.join("ws");
    std::fs::create_dir_all(&workspace).unwrap();
    let dest = workspace.join("gears");
    std::fs::create_dir_all(&dest).unwrap();

    let mut state = write_state(workspace);
    let response = scaffold_gear(
        &mut state,
        RequestId::from(1),
        &ScaffoldGearParams {
            id: "..".to_owned(),
            name: "Escape".to_owned(),
            version: "0.1.0".to_owned(),
            kind: crate::protocol::GearKind::Minimal,
            plugin: None,
            destination_dir: dest.display().to_string(),
            dry_run: false,
        },
    );
    let message = match response.response_result {
        Err(e) => e.message,
        Ok(_) => panic!("must refuse `..`"),
    };
    assert!(message.contains("kebab-case"), "{message}");
    assert!(
        !dest.join("Cargo.toml").exists(),
        "parent dest must stay unchanged"
    );
}

/// The wire shape the Studio client actually sends, deserialised.
///
/// A round trip through the type is not the same as a round trip through the
/// *wire*: `plugin` arriving under a name serde does not expect deserialises to
/// `None` and the scaffold silently writes the commented shape -- which is a
/// working feature and a broken one that look identical in a preview.
#[test]
fn the_clients_scaffold_request_carries_its_plugin() {
    let json = r#"{
        "id": "ldap-authn-plugin",
        "name": "LDAP AuthN",
        "version": "0.1.0",
        "kind": "plugin",
        "plugin": {
            "crate_name": "cf-gears-authn-resolver",
            "lib_ident": "authn_resolver_sdk",
            "path": "../../authn-resolver"
        },
        "destination_dir": "/tmp/gears",
        "dry_run": true
    }"#;
    let params: ScaffoldGearParams = serde_json::from_str(json).expect("the client's shape parses");
    assert_eq!(params.kind, crate::protocol::GearKind::Plugin);
    let plugin = params.plugin.expect("`plugin` survived the wire");
    assert_eq!(plugin.lib_ident, "authn_resolver_sdk");
    assert_eq!(plugin.plugin_interface, None, "absent means read the impl");
}

/// A plugin scaffold given a host writes the locator live, and it still evaluates.
///
/// The commented shape exists because an `sdk` pointing nowhere makes the gear
/// fail to load. A host picked out of a loaded catalogue is not nowhere -- but
/// writing the locator live means writing GDL from strings that came off the
/// wire, and this is the gate that says the result still parses as a gear.
///
/// Quoting is the part that would fail silently: a path with a backslash or a
/// quote in it, escaped Rust-debug style rather than Starlark style, produces a
/// file that reads fine and does not evaluate.
#[test]
fn a_plugin_scaffold_with_a_host_writes_a_live_locator() {
    use crate::protocol::{GearKind, PluginScaffold};

    let files = super::scaffold_gear_files(&ScaffoldGearParams {
        id: "ldap-authn-plugin".to_owned(),
        name: "LDAP AuthN".to_owned(),
        version: "0.1.0".to_owned(),
        kind: GearKind::Plugin,
        plugin: Some(PluginScaffold {
            crate_name: "cf-gears-authn-resolver-sdk".to_owned(),
            lib_ident: "authn_resolver_sdk".to_owned(),
            path: "../../authn-resolver-sdk".to_owned(),
            plugin_interface: Some("AuthNResolverPluginClient".to_owned()),
        }),
        destination_dir: "/tmp".to_owned(),
        dry_run: true,
    })
    .expect("the shape renders");

    let gdl = &files
        .iter()
        .find(|(rel, _, _)| rel == "gear.gdl")
        .expect("a gear.gdl")
        .1;

    // Live, not commented: every one of these lines is `#`-prefixed without a host.
    assert!(
        gdl.contains("sdk = cargo("),
        "the locator is still commented: {gdl}"
    );
    assert!(
        gdl.contains(r#"crate_name = "cf-gears-authn-resolver-sdk""#),
        "{gdl}"
    );
    assert!(gdl.contains(r#"lib = "authn_resolver_sdk""#), "{gdl}");
    assert!(
        gdl.contains(r#"path = "../../authn-resolver-sdk""#),
        "{gdl}"
    );
    assert!(
        gdl.contains(r#"plugin_interface = "AuthNResolverPluginClient""#),
        "{gdl}"
    );

    // And it evaluates as a gear description, which is the scaffold's own gate.
    let identity = gearbox_gdl::FileIdentity {
        uri: "file:///tmp/ldap-authn-plugin/gear.gdl".to_owned(),
        source: gearbox_ir::SourceId::new("scaffold").expect("kebab"),
        gdl_path: gearbox_ir::RelPath::new("gear.gdl").expect("valid"),
        load_paths: None,
    };
    let outcome = gearbox_gdl::GdlEngine::new().eval_gear(&identity, gdl);
    assert!(
        outcome.value.is_some(),
        "a live locator must still evaluate: {:?}",
        outcome.diagnostics
    );
}

/// Without a host, the locator stays a comment.
///
/// The other half of the same decision, asserted so that "absent keeps the old
/// behaviour" is a check rather than a promise in a doc comment.
#[test]
fn a_plugin_scaffold_without_a_host_keeps_the_commented_locator() {
    use crate::protocol::GearKind;

    let files = super::scaffold_gear_files(&ScaffoldGearParams {
        id: "ldap-authn-plugin".to_owned(),
        name: "LDAP AuthN".to_owned(),
        version: "0.1.0".to_owned(),
        kind: GearKind::Plugin,
        plugin: None,
        destination_dir: "/tmp".to_owned(),
        dry_run: true,
    })
    .expect("the shape renders");

    let gdl = &files
        .iter()
        .find(|(rel, _, _)| rel == "gear.gdl")
        .expect("a gear.gdl")
        .1;
    assert!(gdl.contains("# sdk = cargo("), "{gdl}");
    for line in gdl.lines() {
        assert!(
            !line.trim_start().starts_with("sdk = cargo("),
            "an uncommented locator with no host to point at: {gdl}"
        );
    }
}

/// Every shape evaluates, and each one offers what its kind needs.
///
/// The gate this guards is the scaffold's own: `scaffold_gear` evaluates the
/// `gear.gdl` it just rendered and refuses if it does not parse as a gear
/// description. Three shapes mean three chances to write a file that does not --
/// and the shapes are mostly *comments*, so a stray `#` or an unbalanced paren
/// would be caught here and nowhere else until somebody used it.
#[test]
fn every_scaffold_shape_evaluates_and_carries_its_own_hints() {
    use crate::protocol::GearKind;

    for kind in [GearKind::Minimal, GearKind::Service, GearKind::Plugin] {
        let files = super::scaffold_gear_files(&ScaffoldGearParams {
            id: "payments-audit".to_owned(),
            name: "Payments Audit".to_owned(),
            version: "0.1.0".to_owned(),
            kind,
            plugin: None,
            destination_dir: "/tmp".to_owned(),
            dry_run: true,
        })
        .expect("the shape renders");

        let gdl = &files
            .iter()
            .find(|(rel, _, _)| rel == "gear.gdl")
            .expect("a gear.gdl")
            .1;
        let lib = &files
            .iter()
            .find(|(rel, _, _)| rel == "src/lib.rs")
            .expect("a lib.rs")
            .1;

        let identity = gearbox_gdl::FileIdentity {
            uri: "file:///scaffold/gear.gdl".to_owned(),
            source: SourceId::new("scaffold").expect("kebab"),
            gdl_path: RelPath::new("gear.gdl").expect("valid"),
            load_paths: None,
        };
        let outcome = gearbox_gdl::GdlEngine::new().eval_gear(&identity, gdl);
        assert!(
            outcome.value.is_some(),
            "{kind:?} does not evaluate: {:?}",
            outcome.diagnostics
        );

        // Every shape names the crate and carries the configuration hint.
        assert!(gdl.contains(r#"crate_name = "payments-audit""#), "{kind:?}");
        assert!(gdl.contains("config_schema = config(exposes"), "{kind:?}");

        // Shapes are comments until there is something true to write. Live
        // placeholders fail load (sdk) or diagnostics (plugin_interface /
        // invented category), so every hint must stay behind `#`.
        for line in gdl.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with('#') || trimmed.is_empty() {
                continue;
            }
            assert!(
                !trimmed.starts_with("config_schema =")
                    && !trimmed.starts_with("sdk = ")
                    && !trimmed.starts_with("plugin_interface")
                    && !trimmed.starts_with("provides =")
                    && !trimmed.starts_with("consumes =")
                    && !trimmed.starts_with("description =")
                    && !trimmed.starts_with("category =")
                    && !trimmed.starts_with("visibility ="),
                "{kind:?} writes `{trimmed}` as a value, and it has nothing true to put there"
            );
        }

        match kind {
            GearKind::Minimal => {
                // Nothing beyond the crate, the name and that one hint: this is
                // the shape the method wrote before kinds existed.
                assert!(!gdl.contains("sdk = cargo"), "{kind:?}");
                assert!(!gdl.contains("provides = ["), "{kind:?}");
                assert!(!lib.contains("impl Gear"), "{kind:?}");
            }
            GearKind::Service => {
                assert!(gdl.contains("provides = [provide("), "{kind:?}");
                assert!(gdl.contains("consumes = [consume("), "{kind:?}");
                assert!(!gdl.contains("plugin_interface"), "{kind:?}");
                // Doc in the stub, not code -- the toolkit path is unknown here.
                assert!(lib.contains("impl Gear"), "{kind:?}");
                assert!(
                    lib.lines().all(|line| {
                        let t = line.trim_start();
                        t.is_empty() || t.starts_with("//")
                    }),
                    "{kind:?} lib stub must stay comments only"
                );
            }
            GearKind::Plugin => {
                // The locator that decides which point it fills, and the escape
                // hatch for the case reading the `impl` cannot decide.
                assert!(gdl.contains("sdk = cargo("), "{kind:?}");
                assert!(gdl.contains("plugin_interface"), "{kind:?}");
                assert!(lib.contains("GBX0518"), "{kind:?}");
            }
        }
    }
}
