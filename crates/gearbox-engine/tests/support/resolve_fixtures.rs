//! Hand-built catalogues and intents for resolver cases the real tree cannot show.
//!
//! Used only for shapes that do not and should not exist in `gears-rust` — a
//! co-location cycle, for instance, which the runtime's own topological sort
//! refuses at startup. Everything the real tree *can* demonstrate is tested
//! against the real tree instead, because a fixture agreeing with itself proves
//! nothing about the platform.

#![allow(dead_code, reason = "each resolver stage uses a different subset")]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "clippy.toml's allow-unwrap-in-tests covers #[test] fns but not helpers"
)]

use std::collections::BTreeMap;

use gearbox_ir::{
    CargoRef, GearDescriptor, GearId, GearSelection, ProductIntent, ProfileId, RelPath, SourceId,
    Visibility,
};

pub fn gid(id: &str) -> GearId {
    GearId::new(id).unwrap()
}

pub fn source() -> SourceId {
    SourceId::new("fixture").unwrap()
}

/// The minimum a gear needs to take part in resolution.
///
/// Every optional field is left empty on purpose: a test that needs contracts or
/// capabilities sets them explicitly, so what a case depends on is visible in the
/// case rather than inherited from a fixture.
pub fn descriptor(id: &str) -> GearDescriptor {
    GearDescriptor {
        id: gid(id),
        display_name: id.to_owned(),
        description: None,
        category: None,
        visibility: Visibility::default(),
        source: source(),
        gdl_path: RelPath::new(format!("{id}/gear.gdl")).unwrap(),
        package: CargoRef {
            crate_name: format!("cf-{id}"),
            lib_ident: id.replace('-', "_"),
            path: RelPath::new(".").unwrap(),
            features: Vec::new(),
            default_features: true,
            link: Vec::new(),
        },
        runtime_caps: [].into_iter().collect(),
        colocated_deps: [].into_iter().collect(),
        lifecycle: None,
        provides: Vec::new(),
        consumes: Vec::new(),
        requires: Vec::new(),
        serves: Vec::new(),
        client_trait: None,
        cluster_providers: Vec::new(),
        extension_points: Vec::new(),
        fills: None,
        vendor_selector: None,
        declared_roles: Vec::new(),
        config_schema: None,
        docs: None,
        gts_types: Vec::new(),
    }
}

/// A product selecting exactly `gears`, with one embedded profile.
pub fn intent(gears: &[&str]) -> ProductIntent {
    let dev = ProfileId::new("dev").unwrap();
    ProductIntent {
        id: "fixture".to_owned(),
        display_name: "Fixture".to_owned(),
        version: "0.0.0".to_owned(),
        gdl_path: RelPath::new("product.gdl").unwrap(),
        sources: BTreeMap::new(),
        profiles: [(
            dev.clone(),
            gearbox_ir::DeploymentProfileDecl::Embedded { id: dev.clone() },
        )]
        .into_iter()
        .collect(),
        default_profile: dev,
        selected_gears: gears
            .iter()
            .map(|g| GearSelection {
                gear: gid(g),
                source: source(),
                features: Vec::new(),
                config: BTreeMap::new(),
                plugins: Vec::new(),
            })
            .collect(),
        bindings: Vec::new(),
        cluster_scopes: Vec::new(),
        process_pins: Vec::new(),
        preferences: Vec::new(),
    }
}
