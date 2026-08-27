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
pub mod merge;
pub mod source;

pub use catalogue::{CatalogueScan, load_catalogue};
pub use cluster::ClusterProjection;
pub use merge::{MergedGear, merge};
pub use source::{SourceRoot, SourceRootError};
