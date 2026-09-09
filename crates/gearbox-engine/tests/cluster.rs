//! Cluster projection end to end, against the real `gears-rust` tree.
//!
//! The point of these is that the `cluster` gear's `gear.gdl` declares no
//! provider, no name and no capability -- only where the two plugin crates are.
//! Everything asserted below therefore came out of Rust, which is what ADR
//! `cpt-gearbox-adr-macro-projected-catalogue` requires.
//!
//! Skipped when the sibling checkout is absent, so the suite still runs
//! standalone.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::{Path, PathBuf};

use gearbox_engine::{SourceRoot, load_catalogue};
use gearbox_ir::{Catalogue, ClusterPrimitive, GearId, SourceId};

fn gears_rust() -> Option<PathBuf> {
    let mut dir: &Path = Path::new(env!("CARGO_MANIFEST_DIR"));
    loop {
        let candidate = dir.join("gears-rust");
        if candidate.join("gears").is_dir() {
            return candidate.canonicalize().ok();
        }
        dir = dir.parent()?;
    }
}

fn catalogue() -> Option<Catalogue> {
    let root = gears_rust()?;
    let source = SourceRoot::open(SourceId::new("gears-rust").unwrap(), root).ok()?;
    Some(load_catalogue(&[source]).catalogue)
}

macro_rules! require_tree {
    () => {
        match catalogue() {
            Some(c) => c,
            None => {
                eprintln!("skipping: ../gears-rust not present");
                return;
            }
        }
    };
}

fn cluster_gear(catalogue: &Catalogue) -> &gearbox_ir::GearDescriptor {
    catalogue
        .gears
        .get(&GearId::new("cluster").unwrap())
        .expect("the slice includes the cluster gear")
}

#[test]
fn provider_names_are_projected_not_declared() {
    let catalogue = require_tree!();
    let names: Vec<&str> = cluster_gear(&catalogue)
        .cluster_providers
        .iter()
        .map(|p| p.name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["postgres", "redis", "standalone"],
        "names come from each plugin's `PROVIDER_NAME`; the description names \
         none of them -- it only says where each crate is"
    );
}

#[test]
fn the_capability_matrix_comes_out_of_rust() {
    let catalogue = require_tree!();
    let gear = cluster_gear(&catalogue);

    let caps = |name: &str, primitive: ClusterPrimitive| -> Vec<String> {
        let mut v: Vec<String> = gear
            .cluster_providers
            .iter()
            .find(|p| p.name == name)
            .unwrap_or_else(|| panic!("no provider named `{name}`"))
            .capabilities_for(primitive)
            .into_iter()
            .map(|c| c.as_str().to_owned())
            .collect();
        v.sort();
        v
    };

    assert_eq!(
        caps("standalone", ClusterPrimitive::Cache),
        vec!["cluster.cache.linearizable", "cluster.cache.prefix-watch"],
        "an in-process store watches a prefix natively"
    );
    assert_eq!(
        caps("postgres", ClusterPrimitive::Cache),
        vec!["cluster.cache.linearizable"],
        "the NOTIFY channel carries one key per payload, so prefix routing is \
         infeasible -- and that absence is what later makes \
         cache(linearizable + prefix_watch) unsatisfiable in a multi-process \
         profile"
    );
    assert_eq!(
        caps("postgres", ClusterPrimitive::Lock),
        vec!["cluster.lock.linearizable"]
    );
}

#[test]
fn no_provider_registers_leader_election() {
    let catalogue = require_tree!();
    assert!(
        !cluster_gear(&catalogue)
            .cluster_providers
            .iter()
            .any(|p| p.primitives.contains(&ClusterPrimitive::LeaderElection)),
        "leader election always falls through to the SDK compare-and-swap \
         default over the profile's cache; a provider claiming it would let the \
         resolver bless a binding the runtime cannot make"
    );
}

#[test]
fn deployment_semantics_are_declared_because_rust_does_not_state_them() {
    let catalogue = require_tree!();
    let gear = cluster_gear(&catalogue);
    let by = |name: &str| {
        gear.cluster_providers
            .iter()
            .find(|p| p.name == name)
            .unwrap_or_else(|| panic!("no provider named `{name}`"))
    };

    assert!(
        by("standalone").process_local,
        "an in-memory store coordinates nothing across processes; this is the \
         fact GBX0503 rests on"
    );
    assert!(!by("standalone").needs_credentials);
    assert!(!by("postgres").process_local);
    assert!(by("postgres").needs_credentials);
}

#[test]
fn the_slice_projects_cleanly() {
    let catalogue = require_tree!();
    // 8 original + tenant-resolver + 5 plugin gears.
    assert_eq!(catalogue.gears.len(), 14);
    let errors: Vec<String> = catalogue
        .diagnostics
        .iter()
        .filter(|d| d.severity == gearbox_ir::Severity::Error)
        .map(|d| format!("{} {}", d.code.as_str(), d.message))
        .collect();
    assert!(
        errors.is_empty(),
        "the slice must project with no errors; got {errors:#?}"
    );
}

#[test]
fn the_cluster_description_restates_nothing_it_could_project() {
    let Some(root) = gears_rust() else {
        eprintln!("skipping: ../gears-rust not present");
        return;
    };
    let text = std::fs::read_to_string(root.join("gears/system/cluster/cluster/gear.gdl"))
        .expect("the cluster description exists");

    // Comments explain the projection at length, and the prose legitimately uses
    // words like "primitives", so strip comments and match *field assignments*
    // rather than bare substrings. An earlier version of this check matched the
    // description's own explanatory text.
    let code: String = text
        .lines()
        .map(|l| l.split('#').next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");

    for projected in [
        "cluster_providers",
        "runtime_caps",
        "colocated_deps",
        "lifecycle",
        "client",
        "id",
    ] {
        assert!(
            !code.contains(&format!("{projected} =")),
            "`{projected}` is projected from Rust and must not be assigned in \
             the description"
        );
    }
    assert!(
        !code.contains("provider("),
        "`provider(...)` left the GDL surface when providers became projected"
    );
    assert!(
        code.contains("cluster_plugin("),
        "the description still has to say where the plugin crates are"
    );
}
