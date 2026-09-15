//! Roles reach the catalogue, and the tool says what it cannot do with them.
//!
//! Two claims, and they are about different things. Whether a role's labels
//! can be *written* is a fact about the gear and its generated configuration,
//! knowable when the description is read -- GBX0602, here. Whether a role can
//! be *deployed* is a fact about a product, because a gear whose roles nobody
//! selects costs nothing -- GBX0318, asserted in the resolver's own tests.
//!
//! GBX0601 said the second one at load time and blamed the runtime for it.
//! These tests were written before it moved, so the move is visible.

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
fn a_plain_role_is_recorded_and_says_nothing_at_load() {
    // It used to warn here that the runtime could not support it. The runtime
    // takes whatever directory name it is given; whether a *product* can
    // deploy two of them is GBX0318, and only a resolution knows.
    let catalogue = catalogue(r#"roles = [role(name = "ingest")],"#);
    assert!(
        codes(&catalogue).is_empty(),
        "a role is a fact, not a complaint: {:?}",
        codes(&catalogue)
    );
    assert_eq!(demo(&catalogue).declared_roles.len(), 1);
}

#[test]
fn a_label_is_reported_because_nothing_generated_can_carry_it() {
    for declared in [
        r#"roles = [role(name = "ingest", labels = ["shard"])],"#,
        r#"roles = [role(name = "ingest", labels = ["shard", "zone"])],"#,
    ] {
        let catalogue = catalogue(declared);
        let d = catalogue
            .diagnostics
            .iter()
            .find(|d| d.code == DiagnosticCode::GapShards)
            .expect("GBX0602");
        assert_eq!(d.severity, Severity::Warning);
        // The runtime-gap contract demands the column; this demands a value.
        assert!(d.evidence.is_some(), "{d:?}");
        assert!(d.help.is_some());
    }
}

#[test]
fn a_gear_with_no_roles_is_silent() {
    let found = codes(&catalogue(r#"visibility = "internal","#));
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
    assert_eq!(roles[0].directory_name, "demo-ingest");
}

#[test]
fn a_directory_name_left_out_defaults_to_the_gear_and_the_role() {
    // The default needs the gear's id, which is projected from Rust, so it
    // cannot live in the constructor -- and every reader wants the resolved
    // name rather than a rule for deriving one.
    let catalogue = catalogue(r#"roles = [role(name = "ingest")],"#);
    let roles = &demo(&catalogue).declared_roles;
    assert_eq!(roles[0].directory_name, "demo-ingest");
}

#[test]
fn one_role_may_be_the_front_door_and_two_may_not() {
    // The bare name reaching exactly one role is what makes an internal role
    // unreachable structurally rather than by a filter.
    let one = catalogue(r#"roles = [role(name = "dispatcher", directory_name = "demo")],"#);
    assert!(
        !codes(&one).contains(&DiagnosticCode::GdlDuplicateFrontDoor),
        "{:?}",
        codes(&one)
    );

    let two = catalogue(
        r#"roles = [
               role(name = "dispatcher", directory_name = "demo"),
               role(name = "other", directory_name = "demo"),
           ],"#,
    );
    let d = two
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::GdlDuplicateFrontDoor)
        .expect("GBX0117");
    assert!(
        d.message.contains("dispatcher") && d.message.contains("other"),
        "{}",
        d.message
    );
}

#[test]
fn every_role_being_internal_is_allowed() {
    // A gear with no front door is a shape the platform's model permits: not
    // every role-split gear has a public face.
    let catalogue = catalogue(r#"roles = [role(name = "ingest"), role(name = "delivery")],"#);
    assert!(
        !codes(&catalogue).contains(&DiagnosticCode::GdlDuplicateFrontDoor),
        "{:?}",
        codes(&catalogue)
    );
}
