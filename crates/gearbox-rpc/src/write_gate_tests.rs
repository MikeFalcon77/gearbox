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
use crate::protocol::CreateProductParams;

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
    State {
        roots: vec![],
        catalogue: None,
        failed_roots: vec![],
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
