//! Projecting gear facts out of the Rust attributes that own them.
//!
//! Under ADR `cpt-gearbox-adr-macro-projected-catalogue`, `#[toolkit::gear]`,
//! `#[toolkit::contract]`, `#[toolkit::provides]` and `#[toolkit::consumes]`
//! remain authoritative for every fact they already express. A `gear.gdl`
//! declares only the disjoint remainder. This crate reads the first half.
//!
//! It parses with `syn` and never compiles, so it works on a checked-out tree
//! with no toolchain invocation and no build. That also means it sees the
//! source as written -- including attributes behind a `#[cfg(...)]` it cannot
//! evaluate -- which is a limitation recorded honestly in
//! [`ProjectedGear::conditional`] rather than papered over.
//!
//! The crate is deliberately ignorant of GDL: it takes a directory and returns
//! facts. Merging the two halves is `gearbox-engine`'s job, which keeps this
//! testable against a fixture tree and keeps the merge rule in one place.

pub mod attribute;
pub mod cluster;
pub mod config;
pub mod contract;
pub mod error_enum;
pub mod gear;
pub mod gts;
pub mod manifest;
pub mod plugin;
pub mod profile;
pub mod scan;

// Test-only, and declared here because six test modules used to duplicate a
// brittle path into the real gear tree.
#[cfg(test)]
mod test_corpus;

pub use attribute::{AttributeSite, LocateError, gear_attribute_sites, locate_gear_attribute};
pub use cluster::{
    ClusterProjectionError, ProjectedClusterProvider, SdkDefaultRule, project_backend_capabilities,
    project_provider_name, project_provider_registry, project_sdk_defaults,
};
pub use config::{ConfigField, ConfigRootError, project_config_fields, project_config_root};
pub use contract::{
    ProjectedConsume, ProjectedContract, ProjectedProvide, project_consumes, project_contracts,
    project_provides,
};
pub use error_enum::{ProjectedErrorEnum, ProjectedErrorVariant, project_error_enums};
pub use gear::{ProjectedGear, ProjectedLifecycle, project_gear};
pub use gts::{GtsError, GtsType, gts_type_from_schema, project_gts_types};
pub use manifest::{CrateManifest, ManifestError, project_manifest};
pub use plugin::{
    ExtensionPoint, PluginImplError, VendorDefault, project_extension_points, project_plugin_impl,
    project_vendor_default,
};
pub use profile::{ProjectedProfile, project_cluster_profiles};
pub use scan::{RustFile, ScanError, scan_crate};
