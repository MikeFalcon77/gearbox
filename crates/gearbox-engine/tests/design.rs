//! `maturity = "design"`: a gear described before it has code.
//!
//! What replaced the platform's `gear.toml` for the gears that had only
//! documents. The claims: such a gear is listed apart from the gears that can
//! be used, no crate is looked for, nothing is pending on it, and naming it in
//! a product says *why* it cannot be used (GBX0321) rather than "unknown gear".

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not the helpers here"
)]

use std::path::PathBuf;

use gearbox_engine::{Continue, LoadEvent, SourceRoot, load_catalogue, load_catalogue_staged};
use gearbox_gdl::{FileIdentity, GdlEngine};
use gearbox_ir::{DiagnosticCode, GearId, ProfileId, RelPath, SourceId};

const DESIGN: &str = r#"
gear(
    maturity = "design",
    id = "approval-service",
    name = "Approval Service",
    description = "Multi-step approvals for tenant operations.",
    category = "core-functionality",
)
"#;

/// A throwaway source root: one design gear with a PRD, one gear with code.
struct Tree(PathBuf);

impl Tree {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "gearbox-design-{label}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("approval-service/docs")).unwrap();
        std::fs::write(dir.join("approval-service/gear.gdl"), DESIGN).unwrap();
        std::fs::write(dir.join("approval-service/docs/PRD.md"), "# PRD\n").unwrap();

        std::fs::create_dir_all(dir.join("thing/src")).unwrap();
        std::fs::write(
            dir.join("thing/Cargo.toml"),
            "[package]\nname = \"thing\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("thing/src/lib.rs"),
            "#[toolkit::gear(name = \"thing\")]\n#[derive(Default)]\npub struct Thing;\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("thing/gear.gdl"),
            "gear(name = \"Thing\", package = cargo(crate_name = \"thing\", lib = \"thing\", path = \".\"))\n",
        )
        .unwrap();
        Self(dir)
    }

    fn root(&self) -> SourceRoot {
        SourceRoot::open(SourceId::new("fixture").unwrap(), self.0.clone()).unwrap()
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

#[test]
fn a_design_gear_is_listed_apart_and_needs_no_crate() {
    let tree = Tree::new("listed");
    let catalogue = load_catalogue(&[tree.root()]).catalogue;

    assert!(
        catalogue.diagnostics.as_slice().is_empty(),
        "{:?}",
        catalogue.diagnostics
    );
    let id = GearId::new("approval-service").unwrap();
    assert!(!catalogue.gears.contains_key(&id), "a design gear is not usable");
    let design = catalogue.designs.get(&id).expect("listed as a design");
    assert_eq!(design.display_name, "Approval Service");
    assert_eq!(design.category.as_deref(), Some("core-functionality"));
    assert_eq!(design.gdl_path.as_str(), "approval-service/gear.gdl");
    // Documents are found by the same convention as for a gear with code.
    assert_eq!(
        design
            .docs
            .as_ref()
            .and_then(|d| d.prd.as_ref())
            .map(RelPath::as_str),
        Some("approval-service/docs/PRD.md")
    );
    // And the gear with code beside it is unaffected.
    assert!(catalogue.gears.contains_key(&GearId::new("thing").unwrap()));
}

#[test]
fn a_design_gear_arrives_in_the_first_pass_and_is_never_pending() {
    let tree = Tree::new("staged");
    let mut design_before_boundary = false;
    let mut boundary = false;
    let mut declared = Vec::new();
    let scan = load_catalogue_staged(&[tree.root()], &mut |event| {
        match event {
            LoadEvent::Design(d) => {
                assert_eq!(d.id.as_str(), "approval-service");
                design_before_boundary = !boundary;
            }
            LoadEvent::Declared(p) => declared.push(p.gdl_path.as_str().to_owned()),
            LoadEvent::DeclarationComplete { .. } => boundary = true,
            _ => {}
        }
        Continue::Yes
    });
    assert!(design_before_boundary, "a design is complete when declared");
    assert_eq!(declared, ["thing/gear.gdl"], "only the gear with code is pending");
    assert!(scan.pending.is_empty());
}

#[test]
fn a_design_id_beside_a_gear_with_code_is_reported() {
    let tree = Tree::new("outgrown");
    std::fs::create_dir_all(tree.0.join("old-thing")).unwrap();
    std::fs::write(
        tree.0.join("old-thing/gear.gdl"),
        "gear(maturity = \"design\", id = \"thing\", name = \"Thing\")\n",
    )
    .unwrap();
    let catalogue = load_catalogue(&[tree.root()]).catalogue;
    let messages: Vec<&str> = catalogue
        .diagnostics
        .iter()
        .filter(|d| d.code == DiagnosticCode::GdlCardinality)
        .map(|d| d.message.as_str())
        .collect();
    assert_eq!(messages.len(), 1, "{:?}", catalogue.diagnostics);
    assert!(messages[0].contains("also described at design maturity"), "{}", messages[0]);
}

fn product(gear: &str) -> gearbox_ir::ProductIntent {
    let src = format!(
        r#"
product(
    id = "demo", version = "0.1.0",
    sources = [source(id = "fixture", at = path("."))],
    profiles = [embedded(id = "dev")],
    default_profile = "dev",
    gears = [use_gear("{gear}", source = "fixture")],
)
"#
    );
    let identity = FileIdentity {
        uri: "file:///repo/product.gdl".to_owned(),
        source: SourceId::new("product").unwrap(),
        gdl_path: RelPath::new("product.gdl").unwrap(),
        load_paths: None,
    };
    let out = GdlEngine::new().eval_product(&identity, &src);
    out.value.unwrap_or_else(|| panic!("{:?}", out.diagnostics))
}

#[test]
fn selecting_a_design_gear_says_it_has_no_code_yet() {
    let tree = Tree::new("selected");
    let root = tree.root();
    let catalogue = load_catalogue(std::slice::from_ref(&root)).catalogue;
    let intent = product("approval-service");

    let resolution =
        gearbox_engine::resolve::resolve(&catalogue, &intent, &ProfileId::new("dev").unwrap());
    let codes: Vec<DiagnosticCode> = resolution.diagnostics.iter().map(|d| d.code).collect();
    assert!(codes.contains(&DiagnosticCode::TopologyDesignGear), "{codes:?}");
    assert!(!codes.contains(&DiagnosticCode::TopologyUnknownGear), "{codes:?}");
    let design = resolution
        .diagnostics
        .iter()
        .find(|d| d.code == DiagnosticCode::TopologyDesignGear)
        .unwrap();
    // The help points at the plan, which is what a reader asking "when?" wants.
    let help = design.help.as_deref().unwrap_or_default();
    assert!(help.contains("approval-service/docs/PRD.md"), "{help}");

    // Validate checks selections without resolving, and says the same.
    let report = gearbox_engine::validate::validate(&[root], Some(&intent));
    let codes: Vec<DiagnosticCode> = report.diagnostics.iter().map(|d| d.code).collect();
    assert!(codes.contains(&DiagnosticCode::TopologyDesignGear), "{codes:?}");
    assert!(!codes.contains(&DiagnosticCode::TopologyUnknownGear), "{codes:?}");
}
