//! Roles reach the catalogue, and the tool says what it cannot do with them.
//!
//! Both gap codes have been raised since roles were parsed and neither has
//! ever been asserted to fire. `gearbox-gdl`'s own role test ends by asserting
//! that *nothing* is raised and defers with "Gap diagnostics are asserted in
//! gearbox-engine" -- where, until this file, they were not. That matters more
//! than usual here: ADR `cpt-gearbox-adr-role-qualified-names` corrects what
//! GBX0601 claims, and a claim nothing tests can be changed without anyone
//! noticing which way it went.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use gearbox_engine::{SourceRoot, load_catalogue};
use gearbox_ir::{Catalogue, DiagnosticCode, GearId, Severity, SourceId};

static NEXT: AtomicUsize = AtomicUsize::new(0);

const GEAR_RS: &str = r#"
#[toolkit::gear(name = "demo", capabilities = [system])]
pub struct DemoGear;
"#;

const MANIFEST: &str = "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n\
     [lib]\nname = \"demo\"\npath = \"src/lib.rs\"\n";

fn root(declared: &str) -> PathBuf {
    let nth = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("gbx-roles-{}-{nth}", std::process::id()));
    drop(std::fs::remove_dir_all(&root));
    let crate_dir = root.join("demo");
    std::fs::create_dir_all(crate_dir.join("src")).unwrap();
    std::fs::write(
        crate_dir.join("gear.gdl"),
        format!(
            r#"
gear(
    name = "Demo",
    description = "d",
    category = "core-functionality",
    visibility = "internal",
    package = cargo(crate_name = "demo", lib = "demo", path = "."),
    {declared}
)
"#
        ),
    )
    .unwrap();
    std::fs::write(crate_dir.join("Cargo.toml"), MANIFEST).unwrap();
    std::fs::write(crate_dir.join("src/lib.rs"), GEAR_RS).unwrap();
    root
}

fn catalogue(declared: &str) -> Catalogue {
    let path = root(declared);
    let source = SourceRoot::open(SourceId::new("demo").unwrap(), &path).unwrap();
    load_catalogue(&[source]).catalogue
}

fn demo(catalogue: &Catalogue) -> &gearbox_ir::GearDescriptor {
    catalogue
        .gears
        .get(&GearId::new("demo").unwrap())
        .expect("the demo gear is in the catalogue")
}

fn codes(catalogue: &Catalogue) -> Vec<DiagnosticCode> {
    catalogue.diagnostics.iter().map(|d| d.code).collect()
}

#[test]
fn a_declared_role_is_reported_with_its_evidence() {
    let catalogue = catalogue(r#"roles = [role(name = "ingest")],"#);
    let d = catalogue
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::GapRoles)
        .expect("GBX0601");

    assert_eq!(d.severity, Severity::Warning);
    assert!(d.message.contains("1 role"), "{}", d.message);
    // The runtime-gap contract demands the column; this demands a value at the
    // one site that fills it.
    assert!(
        d.evidence.as_deref().unwrap_or_default().contains("oop.rs"),
        "{:?}",
        d.evidence
    );
    assert!(d.help.is_some());
    assert!(
        !codes(&catalogue).contains(&DiagnosticCode::GapShards),
        "a plain role asks for no sharding"
    );
}

#[test]
fn sharding_and_instance_addressing_are_reported_separately() {
    for declared in [
        r#"roles = [role(name = "ingest", sharded = True)],"#,
        r#"roles = [role(name = "ingest", instance_addressable = True)],"#,
    ] {
        let found = codes(&catalogue(declared));
        assert!(found.contains(&DiagnosticCode::GapRoles), "{found:?}");
        assert!(found.contains(&DiagnosticCode::GapShards), "{found:?}");
    }
}

#[test]
fn a_gear_with_no_roles_raises_neither() {
    let found = codes(&catalogue(r#"visibility = "internal","#));
    assert!(!found.contains(&DiagnosticCode::GapRoles), "{found:?}");
    assert!(!found.contains(&DiagnosticCode::GapShards), "{found:?}");
}

#[test]
fn a_roles_directory_name_reaches_the_descriptor() {
    // What the contract-owner check reads, so it is load-bearing rather than
    // decorative: a role's directory name is one of the names the catalogue
    // answers to.
    let catalogue =
        catalogue(r#"roles = [role(name = "ingest", directory_name = "demo-ingest")],"#);
    let roles = &demo(&catalogue).declared_roles;
    assert_eq!(roles.len(), 1);
    assert_eq!(roles[0].directory_name.as_deref(), Some("demo-ingest"));
}
