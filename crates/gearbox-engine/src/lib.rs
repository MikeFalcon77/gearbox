//! Workspace discovery and catalogue assembly.
//!
//! This is the only crate that touches the filesystem. `gearbox-gdl` evaluates
//! a string; `gearbox-lock` serializes a value; the resolver is a pure
//! function. Keeping I/O here is what lets all of those be tested from
//! literals, and it is why the CLI and the future RPC server can share one
//! engine without either owning the notion of "where the files are".
//!
//! The engine's own dependency set deliberately names no CLI or UI crate
//! (`cpt-gearbox-nfr-engine-has-no-frontend-deps`), and no crate but
//! `gearbox-gdl` names `starlark`. Both are asserted in `tests/boundaries.rs`.

pub mod catalogue;
pub mod cluster;
pub mod docs;
pub mod manifest_check;
pub mod merge;
pub mod plugin;
pub mod plugin_select;
pub mod product;
pub mod resolve;
pub mod scans;
pub mod source;
pub mod undescribed;
pub mod validate;

pub use catalogue::{CatalogueScan, Continue, LoadEvent, load_catalogue, load_catalogue_staged};
pub use cluster::ClusterProjection;
pub use merge::{MergedGear, Projections, merge};
pub use plugin::PluginProjection;
pub use plugin_select::{PointResolution, check as check_plugins};
pub use product::{ProductScan, load_product};
pub use scans::CrateScans;
pub use source::{SourceRoot, SourceRootError};
