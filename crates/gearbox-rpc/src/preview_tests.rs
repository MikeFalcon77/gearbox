//! `gearbox/product/resolvePreview` answers about a description that is not on
//! disk, and leaves the one that is exactly as it found it.
//!
//! The point of the method is that a person can see what adding a gear does
//! *before* deciding to do it. That is only true if asking is free -- a preview
//! that wrote would make the question indistinguishable from the answer, and the
//! Add Gear panel asks on a debounce, so it would write while someone types.
//!
//! Byte-for-byte, not "unchanged apart from formatting": the edit pipeline is a
//! text transform, and a preview that reformatted a file would be a write.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use gearbox_ir::GearId;

use super::*;
use crate::protocol::{PreviewAddGear, ResolvePreviewParams};

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// The gear corpus, when it is checked out beside this repository.
fn gears_rust() -> Option<PathBuf> {
    let candidate = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(|p| p.join("../gears-rust"))?;
    candidate
        .canonicalize()
        .ok()
        .filter(|p| p.join("gears").is_dir())
}

/// A copy of the demo product in a scratch directory.
///
/// A copy rather than the file in `products/`: the failure this guards against is
/// "the preview wrote to the path it was given", and a test that proves it by
/// corrupting the corpus is not one worth running twice. The `sources` path stays
/// valid because it is spelled relative to the repository, so the copy is placed
/// at the same depth.
fn demo_copy() -> Option<PathBuf> {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)?;
    let original = repo.join("products/payments-demo/product.gdl");
    let source = std::fs::read_to_string(&original).ok()?;

    let nth = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = repo.join(format!(
        "target/gbx-preview-{}-{nth}/payments-demo",
        std::process::id()
    ));
    drop(std::fs::remove_dir_all(&dir));
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("product.gdl");
    // The description names its source root as `../../../gears-rust`, so the copy
    // has to sit three levels under the repository's parent, as `products/x/` does.
    let rewritten = source.replace("../../../gears-rust", "../../../../gears-rust");
    std::fs::write(&path, rewritten).ok()?;
    Some(path)
}

fn state() -> Option<State> {
    let root = gears_rust()?;
    let (roots, failed_roots) = open_roots(&[root]);
    Some(State {
        roots,
        catalogue: None,
        failed_roots,
        initialized: true,
        // Deliberately false. A preview needs no write permission, and a preview
        // that only worked for a client that had asked for one would be evidence
        // that it writes.
        allow_writes: false,
        workspace: None,
    })
}

macro_rules! require_corpus {
    () => {
        match (state(), demo_copy()) {
            (Some(state), Some(path)) => (state, path),
            _ => {
                eprintln!("skipping: ../gears-rust or products/payments-demo is not present");
                return;
            }
        }
    };
}

#[test]
fn a_preview_resolves_a_description_that_is_not_on_disk() {
    let (mut state, path) = require_corpus!();
    let before = std::fs::read(&path).unwrap();

    let response = resolve_preview(
        &mut state,
        RequestId::from(1),
        &ResolvePreviewParams {
            path: path.display().to_string(),
            profile: None,
            add: Some(PreviewAddGear {
                gear: "tenant-resolver".to_owned(),
                source: "gears-rust".to_owned(),
            }),
            edits: Vec::new(),
        },
    );

    let value = response
        .response_result
        .expect("the preview succeeded rather than refusing");
    let result: ResolveResult =
        serde_json::from_value(value).expect("the preview answers with a ResolveResult");
    let product = result
        .product
        .expect("the proposed description evaluates, so there is a product");

    // The gear that was asked for, and the closure it drags in: the whole reason
    // the panel shows this before writing.
    assert!(
        product
            .gears
            .contains_key(&GearId::new("tenant-resolver").unwrap()),
        "the added gear is in the resolution"
    );
    assert!(
        product.gears.len() > state_gear_count(&mut state, &path),
        "adding a gear resolves to more gears than the description has today"
    );

    assert_eq!(
        std::fs::read(&path).unwrap(),
        before,
        "the preview must leave the description byte-identical"
    );
}

/// How many gears the description resolves to as it stands, for the comparison
/// above. Runs after the preview on purpose: if the preview had written, this
/// would be reading the damage.
fn state_gear_count(state: &mut State, path: &Path) -> usize {
    let Ok(resolved) = resolve_once(
        state,
        &RequestId::from(2),
        &path.display().to_string(),
        None,
        None,
    ) else {
        panic!("the unmodified description resolves");
    };
    resolved.product.gears.len()
}

#[test]
fn a_refused_edit_still_writes_nothing() {
    let (mut state, path) = require_corpus!();
    let before = std::fs::read(&path).unwrap();

    // Already named by the description: `add_gear` reports no change, and the
    // preview resolves the text it was handed, unchanged.
    let response = resolve_preview(
        &mut state,
        RequestId::from(1),
        &ResolvePreviewParams {
            path: path.display().to_string(),
            profile: Some("prod".to_owned()),
            add: Some(PreviewAddGear {
                gear: "api-gateway".to_owned(),
                source: "gears-rust".to_owned(),
            }),
            edits: Vec::new(),
        },
    );

    assert!(
        response.response_result.is_ok(),
        "a preview of a gear already named must still succeed"
    );
    assert_eq!(
        std::fs::read(&path).unwrap(),
        before,
        "a no-op preview must leave the description byte-identical"
    );
}
