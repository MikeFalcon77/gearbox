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

use gearbox_ir::{
    Diagnostic, ExplanationGraph, GearDescriptor, PendingGear, ProductIntent, ResolvedProduct,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Method names, in one place so the server and the smoke test cannot drift.
pub mod method {
    pub const INITIALIZE: &str = "initialize";
    pub const SHUTDOWN: &str = "shutdown";
    pub const CATALOGUE_LOAD: &str = "gearbox/catalogue/load";
    pub const PRODUCT_LOAD: &str = "gearbox/product/load";
    pub const PRODUCT_RESOLVE: &str = "gearbox/product/resolve";
    pub const VALIDATE: &str = "gearbox/validate";

    pub const INITIALIZED: &str = "initialized";
    pub const EXIT: &str = "exit";
    pub const CATALOGUE_CHANGED: &str = "gearbox/catalogueChanged";
    pub const CATALOGUE_DIAGNOSTICS: &str = "gearbox/catalogueDiagnostics";
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
    /// The product description could not be evaluated.
    ///
    /// Distinct from [`RESOLVE_FAILED`]: this one means the file is not a
    /// product at all, so there is nothing to resolve and no partial answer to
    /// return.
    pub const PRODUCT_LOAD_FAILED: i32 = -32053;
    /// Resolution ran and could not produce a lock.
    ///
    /// Reserved for the case where no `ResolvedProduct` exists at all. A product
    /// that resolves *with errors* is not this: it comes back normally, with its
    /// diagnostics, because a partial graph plus three errors is more useful
    /// than one error and nothing to look at.
    pub const RESOLVE_FAILED: i32 = -32054;
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

/// One source root as the server resolved it on this machine.
///
/// Deliberately an RPC fact, not an IR one. `SourceDecl::location` keeps the
/// location *as the operator wrote it* because it goes into `product.lock`, and
/// a lock carrying `/Users/someone/...` would not survive being committed. But a
/// client rendering a clickable path needs a real path, and the RPC server and
/// its client are on the same machine by construction -- so this is the layer
/// where an absolute path is the right answer.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ResolvedRoot {
    /// The source id every `GearDescriptor::source` refers to.
    pub id: String,
    /// Canonical absolute path of the root directory.
    pub path: String,
}

/// A root the server was asked for and could not open.
///
/// Reported rather than dropped. A shorter `roots` list says nothing about
/// *which* root is missing or why, and the alternative -- waiting for the load
/// to fail with `WORKSPACE_NOT_OPEN` -- loses the cause entirely.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct FailedRoot {
    /// The path as the client (or `--root`) spelled it.
    pub path: String,
    /// Why it could not be opened.
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct InitializeResult {
    pub server_info: ServerInfo,
    /// What this build can do. Read by the client to decide which panels are
    /// worth showing, so a panel is disabled rather than empty when the engine
    /// cannot answer it yet.
    pub capabilities: Capabilities,
    /// Where each source root actually is.
    ///
    /// Without this a client cannot open anything the catalogue points at:
    /// `gdl_path` and every docs path are relative to their source root, and the
    /// root is the one thing only the server knows.
    #[serde(default)]
    pub roots: Vec<ResolvedRoot>,

    /// The roots that could not be opened, with the reason for each.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed_roots: Vec<FailedRoot>,
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

/// `gearbox/product/load` -- evaluate a `product.gdl` and return what it says.
///
/// Evaluation only. Whether the gears it names exist is
/// `gearbox/validate`'s question, and what topology they produce is
/// `gearbox/product/resolve`'s.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProductLoadParams {
    /// Absolute path to the description. Absolute because the server's working
    /// directory is not the client's, and a relative path here has produced a
    /// `file://` URI that renders as a link and opens nothing.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProductLoadResult {
    pub intent: ProductIntent,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
}

/// `gearbox/product/resolve` -- one profile's topology.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ResolveParams {
    pub path: String,
    /// Which deployment profile. `None` uses the product's own default, so the
    /// common call is short and the answer still comes from the description
    /// rather than from a guess made here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

/// The resolved product, plus everything said while producing it.
///
/// `product` is `None` only when the description did not evaluate. A product
/// that resolved *with errors* is present: the UI renders a partial graph and
/// the diagnostics beside it, which is the whole reason errors do not abort
/// resolution.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ResolveResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product: Option<ResolvedProduct>,
    /// The explanation graph for this resolution, so "why" needs no second call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explanation: Option<ExplanationGraph>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
}

/// `gearbox/validate` -- everything checkable without resolving.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ValidateParams {
    /// Also check a product's gear selections. Without it, only the catalogue
    /// is validated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ValidateResult {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
    pub errors: u32,
    pub warnings: u32,
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

/// Diagnostics raised after the load already answered.
///
/// Everything the second pass produces -- projection failures, manifest
/// mismatches, merge errors -- arrives after the `catalogue/load` response has
/// gone out, so there is no response left to carry it. Without this the client
/// sees a tree that silently omits the gears that failed.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CatalogueDiagnostics {
    /// Only the ones not already sent in the load response.
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
    ///
    /// The key is `(gear.source, replaces)`, not `replaces` alone: a `gdl_path`
    /// is relative to one source root and the server accepts several, so two
    /// roots of the same shape both hold `gears/x/gear.gdl`.
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
