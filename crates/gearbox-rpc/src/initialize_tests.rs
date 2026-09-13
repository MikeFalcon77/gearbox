//! What `initialize` does to the cached catalogue, and why the empty case is
//! safe.
//!
//! **Written because an audit reported the empty-roots branch as a bug and it is
//! not one**, and nothing in the tree said so. `state.roots` is assigned in
//! exactly one place and `state.catalogue` is cleared in exactly one, and those
//! two statements share an `if` on purpose: the cache therefore cannot outlive a
//! change of roots. That is a property of where two lines sit, which is the
//! least durable kind of invariant there is — nobody would notice if one of them
//! moved, and the next reader would file the same report.
//!
//! So the decisions are pinned here rather than argued in a comment. Each test
//! is one sentence of the contract:
//!
//!   * naming no roots means "keep what you have", including the catalogue,
//!     because the catalogue still belongs to the roots that did not change;
//!   * naming different roots drops it, which is what the branch exists for;
//!   * naming the *same* roots drops it too, deliberately.
//!
//! And the load's own guard: a staged load that stopped early must not be
//! cached, or `resolve` reads a catalogue missing most of its gears.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use lsp_server::{Connection, RequestId};

use super::*;
use crate::protocol::InitializeParams;

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A directory that exists, so `open_roots` yields a root rather than a failure.
fn scratch(label: &str) -> PathBuf {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crate lives under the workspace");
    let nth = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = repo.join(format!(
        "target/gbx-initialize-{label}-{}-{nth}",
        std::process::id()
    ));
    drop(std::fs::remove_dir_all(&dir));
    std::fs::create_dir_all(&dir).expect("scratch directory");
    dir
}

/// A catalogue distinguishable from a freshly loaded one.
///
/// Identity is all these tests need: the question is whether *this* value
/// survives, not what is in it.
fn marked_catalogue() -> gearbox_ir::Catalogue {
    let mut catalogue = gearbox_ir::Catalogue::default();
    catalogue.sources.insert(
        gearbox_ir::SourceId::new("marker").unwrap(),
        gearbox_ir::ResolvedSource {
            id: gearbox_ir::SourceId::new("marker").unwrap(),
            kind: gearbox_ir::SourceKind::Path,
            location: "/marker".to_owned(),
            digest: String::new(),
        },
    );
    catalogue
}

fn state_with(root: &Path) -> State {
    let (roots, failed_roots) = open_roots(&[root.to_path_buf()]);
    State {
        roots,
        catalogue: Some(marked_catalogue()),
        failed_roots,
        initialized: false,
        allow_writes: false,
        workspace: None,
    }
}

fn params(roots: &[&Path]) -> InitializeParams {
    InitializeParams {
        roots: roots.iter().map(|r| r.display().to_string()).collect(),
        allow_writes: false,
        workspace: None,
    }
}

fn is_marked(state: &State) -> bool {
    state.catalogue.as_ref().is_some_and(|c| {
        c.sources
            .contains_key(&gearbox_ir::SourceId::new("marker").unwrap())
    })
}

/// Naming no roots keeps them, and keeps the catalogue with them.
///
/// The case reported as a bug. It is not: the roots did not change, so the
/// cached catalogue is still the catalogue *of these roots*. Clearing it here
/// would throw away a valid cache and force the next `resolve` through a full
/// rescan, which is a cost with nothing bought.
///
/// Nor can a client even reach it today — the Studio backend substitutes the CLI
/// defaults for an empty list before the wire. That makes this a statement about
/// the protocol rather than about a caller, which is the reason to write it down.
#[test]
fn naming_no_roots_keeps_the_roots_and_the_catalogue() {
    let dir = scratch("empty");
    let mut state = state_with(&dir);
    let before: Vec<_> = state.roots.iter().map(|r| r.id.clone()).collect();

    let response = initialize(&mut state, RequestId::from(1), &params(&[]));
    assert!(response.response_result.is_ok(), "{response:?}");

    assert_eq!(
        state.roots.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
        before,
        "an empty `roots` means keep them, not open nothing"
    );
    assert!(
        is_marked(&state),
        "the catalogue belongs to roots that did not change, so it survives"
    );
}

/// Naming different roots drops the catalogue. The branch's whole purpose.
///
/// A reconnecting client sends a second `initialize`, and before the clear
/// existed the rest of that session was answered out of a cache built from the
/// first tree.
#[test]
fn naming_different_roots_drops_the_catalogue() {
    let first = scratch("first");
    let second = scratch("second");
    let mut state = state_with(&first);

    let response = initialize(&mut state, RequestId::from(1), &params(&[&second]));
    assert!(response.response_result.is_ok(), "{response:?}");

    assert!(
        !is_marked(&state),
        "a catalogue must never outlive the roots it was scanned from"
    );
    assert_eq!(state.roots.len(), 1);
    assert!(state.roots[0].root.ends_with(second.file_name().unwrap()));
}

/// Naming the *same* roots drops it too, and that is intended.
///
/// Telling "the same roots" from "different roots that happen to resolve alike"
/// needs a comparison this handler does not do, and a spurious rescan is the
/// cheap side of that trade. Pinned so the rescan is not read later as an
/// oversight and "optimised" into the staleness the previous test describes.
#[test]
fn naming_the_same_roots_drops_the_catalogue_anyway() {
    let dir = scratch("same");
    let mut state = state_with(&dir);

    let response = initialize(&mut state, RequestId::from(1), &params(&[&dir]));
    assert!(response.response_result.is_ok(), "{response:?}");

    assert!(
        !is_marked(&state),
        "naming roots at all re-opens them, and the cache goes with them"
    );
}

/// A staged load that stopped early is not cached.
///
/// Unreachable today: the load stops only when a notification cannot be sent,
/// which means the channel is closed, which ends the request loop — the
/// truncated catalogue dies with the process. The guard is for the cancellation
/// the code above `catalogue_load` promises ("cancellation is the answer to a
/// slow load"). The moment that exists, an early stop is routine, and caching
/// what it produced would have `resolve` report `GBX0301` for gears that are
/// there.
///
/// Driven by dropping the peer of an in-memory connection, which is exactly the
/// send failure the real path sees.
#[test]
fn a_load_that_stopped_early_is_not_cached() {
    let dir = scratch("stopped");
    // One description, so the load has something to announce and therefore
    // something to fail on. An empty root would finish without ever sending.
    std::fs::write(
        dir.join("gear.gdl"),
        "gear(\n  name = \"Demo\",\n  category = \"example\",\n  \
         package = cargo(crate_name = \"demo\", lib = \"demo\", path = \".\"),\n)\n",
    )
    .unwrap();

    let (server, client) = Connection::memory();
    // The client is gone before the load begins, so the first notification
    // fails and the walk stops at the S1 boundary.
    drop(client);

    let (roots, failed_roots) = open_roots(&[dir]);
    let mut state = State {
        roots,
        catalogue: None,
        failed_roots,
        initialized: true,
        allow_writes: false,
        workspace: None,
    };

    drop(catalogue_load(&server, &mut state, RequestId::from(1)));

    assert!(
        state.catalogue.is_none(),
        "a partial catalogue must not become the cache every later answer is built from"
    );
}
