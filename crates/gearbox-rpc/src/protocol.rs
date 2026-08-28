//! The wire types, and the shape of a staged catalogue load over JSON-RPC.
//!
//! Everything here derives `TS`, because the client must never hand-maintain a
//! mirror of a wire format (`cpt-gearbox-nfr-no-type-drift`). The envelopes join
//! the `gearbox-ir` types already exported, so one `make ts` covers both.
//!
//! No `#[ts(export_to = ...)]` on any of these, and that is not an omission: the
//! output directory belongs to the export test's `Config`, and an `export_to`
//! here is resolved *relative to it*, which silently doubles the path. The IR
//! types carry no such attribute for the same reason.

use gearbox_ir::{Diagnostic, GearDescriptor, PendingGear};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Method names, in one place so the server and the smoke test cannot drift.
pub mod method {
    pub const INITIALIZE: &str = "initialize";
    pub const SHUTDOWN: &str = "shutdown";
    pub const CATALOGUE_LOAD: &str = "gearbox/catalogue/load";

    pub const INITIALIZED: &str = "initialized";
    pub const EXIT: &str = "exit";
    pub const CATALOGUE_CHANGED: &str = "gearbox/catalogueChanged";
    pub const PROGRESS: &str = "$/progress";
    pub const LOG: &str = "gearbox/log";
}

/// Application errors, so a transport failure and a Gearbox failure are never
/// confused.
///
/// Inside LSP's `ServerErrorStart..ServerErrorEnd` window (`-32099..-32000`) but
/// clear of the two values LSP itself defines there -- `-32001`
/// `UnknownErrorCode` and `-32002` `ServerNotInitialized`. Reusing `-32002` for
/// "no workspace" would have been quietly wrong: a client mapping codes to
/// messages would report the wrong cause.
pub mod error_code {
    pub const NOT_INITIALIZED: i32 = -32050;
    pub const WORKSPACE_NOT_OPEN: i32 = -32051;
    pub const LOAD_FAILED: i32 = -32052;
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct InitializeParams {
    /// Source roots to scan. Absolute, or relative to the server's working
    /// directory.
    #[serde(default)]
    pub roots: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct InitializeResult {
    pub server_info: ServerInfo,
    /// What this build can do. Read by the client to decide which panels are
    /// worth showing, so a panel is disabled rather than empty when the engine
    /// cannot answer it yet.
    pub capabilities: Capabilities,
}

/// Deliberately honest about what is not built.
///
/// `resolve` and `generate` are `false` until M4 and M5-M7, and the client uses
/// that to say "needs the resolver" rather than rendering an empty panel that
/// looks like a bug.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "a set of names cannot say `resolve: false`: absence would be \
              ambiguous between `this server does not have it` and `this server \
              is too old to know about it`, and telling those apart is the whole \
              reason the field exists"
)]
pub struct Capabilities {
    pub catalogue: bool,
    pub staged_catalogue: bool,
    pub resolve: bool,
    pub generate: bool,
}

/// The response to `gearbox/catalogue/load`.
///
/// Returned at the boundary between the two passes: every description has been
/// evaluated, no crate has been parsed. So `pending` is the whole tree, `gears`
/// is empty, and the rest arrives as `gearbox/catalogueChanged`.
///
/// A client must not read an absent field on a `PendingGear` as an absent fact.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CatalogueLoadResult {
    /// How many descriptions were discovered, so a progress bar has a
    /// denominator immediately.
    pub total: u32,
    pub pending: Vec<PendingGear>,
    /// Diagnostics raised while evaluating descriptions. Projection diagnostics
    /// arrive later, with the gears they belong to.
    pub diagnostics: Vec<Diagnostic>,
}

/// One gear finished projecting.
///
/// Carries the gear alone rather than the catalogue again: a registry of a
/// thousand gears re-sent per completion is the obvious way to make staged
/// loading slower than the blocking load it replaces.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CatalogueChanged {
    /// The gear that moved out of `pending`.
    pub gear: GearDescriptor,
    /// Its `gdl_path`, so the client can drop the matching pending row without
    /// having to know that `gdl_path` was its key.
    pub replaces: String,
}

/// `$/progress`, in the shape the staged load actually produces.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProgressParams {
    pub token: String,
    pub completed: u32,
    pub total: u32,
    /// Set once, on the last notification, so a client can retire the indicator
    /// without comparing counters.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub done: bool,
}

/// Sent when the load finishes, carrying what only the end knows.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct LogParams {
    pub message: String,
}
