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
    Diagnostic, ExplanationGraph, FileAction, FilePlan, GearDescriptor, Ownership, PendingGear,
    ProductIntent, ResolvedProduct,
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
    pub const PRODUCT_LOCK: &str = "gearbox/product/lock";
    pub const PRODUCT_ADD_GEAR: &str = "gearbox/product/addGear";
    pub const PRODUCT_REMOVE_GEAR: &str = "gearbox/product/removeGear";
    pub const PRODUCT_SET_CONFIG: &str = "gearbox/product/setConfig";
    pub const PRODUCT_SET_FEATURES: &str = "gearbox/product/setFeatures";
    pub const PRODUCT_ADD_PROFILE: &str = "gearbox/product/addProfile";
    pub const PRODUCT_REMOVE_PROFILE: &str = "gearbox/product/removeProfile";
    pub const PRODUCT_SET_PROFILE_FIELD: &str = "gearbox/product/setProfileField";
    pub const PRODUCT_CREATE: &str = "gearbox/product/create";
    pub const VALIDATE: &str = "gearbox/validate";
    pub const GENERATE_PLAN: &str = "gearbox/generate/plan";
    pub const GENERATE_APPLY: &str = "gearbox/generate/apply";
    pub const GENERATE_FILE: &str = "gearbox/generate/file";

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
    /// The client never declared write capability, so a mutating method is
    /// refused outright (`cpt-gearbox-fr-rpc-writes-opt-in`). Distinct from a
    /// failed write: nothing was attempted.
    pub const WRITES_NOT_ALLOWED: i32 = -32055;
    /// The path is outside every declared root, or the file could not be edited.
    pub const EDIT_REFUSED: i32 = -32056;
    /// Generation was refused: the output root is not writable, resolution
    /// reported errors, or the engine could not produce a tree.
    pub const GENERATE_REFUSED: i32 = -32057;
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct InitializeParams {
    /// Source roots to scan. Absolute, or relative to the server's working
    /// directory.
    #[serde(default)]
    pub roots: Vec<String>,

    /// Whether this client may ask the server to change files.
    ///
    /// Declared by the client, defaulting to `false`, and every mutating method
    /// is refused until it is `true`
    /// (`cpt-gearbox-fr-rpc-writes-opt-in`): "The API's first clients are an
    /// editor and an autonomous agent. Read-only by default is the only safe
    /// posture."
    ///
    /// A declaration rather than a negotiation. The server has no way to judge
    /// whether a caller *should* be allowed to write, so it does not pretend to:
    /// it records what was claimed and refuses everything not claimed, which
    /// makes a client that never asks for writes incapable of making one by
    /// accident.
    #[serde(default)]
    pub allow_writes: bool,

    /// The directory writes may touch, beyond the source roots.
    ///
    /// `cpt-gearbox-fr-rpc-writes-opt-in` requires rejecting "any path outside
    /// the declared workspace or source roots", and a product description lives
    /// in neither: it sits beside the products, not inside a *gear* source root.
    /// So the workspace is declared too, by the client that knows where it is.
    ///
    /// Deliberately not the server's working directory, which was the first
    /// attempt: the cwd of a process is not a boundary anybody declared, and
    /// treating it as one means the permitted set changes with how the server
    /// happened to be launched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
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
/// `resolve` and `generate` are advertised once the engine can answer them, so
/// the client can hide a panel rather than render an empty one that looks like
/// a bug. Worker entry points (M6) and Docker/Helm (M7) are still missing; they
/// arrive as `skipped` on a generate plan, not as `generate: false`.
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
    /// Whether *this session* may change files.
    ///
    /// Reflects back what the client declared in `InitializeParams`, not a
    /// property of the build. A client that forgot to ask can therefore see that
    /// it forgot, instead of discovering it from a refusal later.
    pub writes: bool,
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

/// `gearbox/product/lock` -- the canonical lock text for one profile.
///
/// The same shape as [`ResolveParams`], and deliberately a separate method
/// rather than another field on [`ResolveResult`]: serializing the lock costs
/// work and bytes that the panels reading a resolution do not need, and the
/// client asks for the text only when something is going to show it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct LockParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,

    /// The output tree to compare against, when it is not the default
    /// `.gearbox/<product>/<profile>/`.
    ///
    /// The Studio sends none: there is one generated tree now that a lock no
    /// longer depends on which client wrote it. It exists so a test can put a
    /// deliberately stale lock somewhere of its own instead of doctoring the tree
    /// the plan's section 12 step 2 builds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<String>,
}

/// The lock as it would be written.
///
/// `canonical` comes from `gearbox_lock::write_canonical`, the one function that
/// decides the lock's bytes. A client must never render its own TOML: byte
/// identity across runs is the property the lock exists for
/// (`cpt-gearbox-nfr-determinism`), and a second serializer is a second answer.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct LockResult {
    pub canonical: String,
    /// Repeated here so a caller can label the text without parsing it.
    pub lock_hash: String,
    pub profile: String,

    /// Where a lock for this profile lives, whether or not one is there.
    ///
    /// Reported even when absent, because "there is no lock yet" and "I did not
    /// look" are different answers and a client cannot tell them apart from a
    /// missing field.
    pub lock_path: String,

    /// The lock already on disk, when there is one.
    ///
    /// Carried with the text rather than fetched by a second method, for the same
    /// reason `ResolveResult` carries its explanation: the two have to be about
    /// one resolution, and a separate call cannot promise that.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_disk: Option<LockOnDisk>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
}

/// The lock found on disk, and how it differs from the one just resolved.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct LockOnDisk {
    /// The bytes as they are on disk, so a client can show a text diff without
    /// reading the file itself.
    pub canonical: String,

    /// The hash the file carries. Empty when the file could not be parsed.
    pub lock_hash: String,

    /// What differs, in the engine's own words: `LockDiff::summary()`, whose doc
    /// comment names this widget as its consumer. `+` added, `-` removed, `~`
    /// changed.
    ///
    /// **Empty means the two are the same**, which is why it is not
    /// `skip_serializing_if`: an absent list and an empty one would read alike,
    /// and "no differences" is the answer most worth being sure of.
    ///
    /// Sent rather than computed by the client. A second implementation of "what
    /// changed" is a second answer, and the whole point of a lock is that there
    /// is one.
    pub changes: Vec<String>,

    /// Why the file on disk is not a lock, when it is not one.
    ///
    /// A file that exists and does not parse is neither "current" nor "stale",
    /// and saying so beats reporting an empty diff for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unreadable: Option<String>,
}

/// `gearbox/product/addGear` and `gearbox/product/removeGear`.
///
/// One envelope for both, because they differ only in direction, and a caller
/// that can express one can express the other without learning a second shape.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct EditGearParams {
    /// The product description to edit.
    pub path: String,
    /// The gear to add or remove.
    pub gear: String,
    /// Which declared source the gear comes from. Ignored when removing.
    #[serde(default)]
    pub source: Option<String>,
    /// Report what would change and write nothing.
    ///
    /// ADR `cpt-gearbox-adr-authoring-ownership-tiers`: "A preview is not
    /// optional. Every surveyed tool has `--dry-run`." The flag rather than a
    /// second method, for the same reason `gearbox generate` has one.
    #[serde(default)]
    pub dry_run: bool,
}

/// `gearbox/product/setConfig` -- one key in a gear's `config = {...}`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SetConfigParams {
    pub path: String,
    pub gear: String,
    pub key: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
}

/// `gearbox/product/setFeatures`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SetFeaturesParams {
    pub path: String,
    pub gear: String,
    pub features: Vec<String>,
    #[serde(default)]
    pub dry_run: bool,
}

/// `gearbox/product/addProfile`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct AddProfileParams {
    pub path: String,
    pub kind: String,
    pub id: String,
    #[serde(default)]
    pub fields: Vec<ProfileFieldEntry>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ProfileFieldEntry {
    pub name: String,
    pub value: String,
}

/// `gearbox/product/removeProfile`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct RemoveProfileParams {
    pub path: String,
    pub id: String,
    #[serde(default)]
    pub dry_run: bool,
}

/// `gearbox/product/setProfileField`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct SetProfileFieldParams {
    pub path: String,
    pub id: String,
    pub field: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
}

/// A source entry written into a new product description.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreateSourceEntry {
    pub id: String,
    pub at: String,
}

/// `gearbox/product/create` -- new file from a template or a clone.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct CreateProductParams {
    pub path: String,
    pub id: String,
    pub name: String,
    #[serde(default = "default_product_version")]
    pub version: String,
    #[serde(default)]
    pub sources: Vec<CreateSourceEntry>,
    #[serde(default = "default_profile_kind")]
    pub profile_kind: String,
    #[serde(default = "default_profile_id")]
    pub profile_id: String,
    #[serde(default)]
    pub clone_from: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
}

fn default_product_version() -> String {
    "0.1.0".to_owned()
}

fn default_profile_kind() -> String {
    "embedded".to_owned()
}

fn default_profile_id() -> String {
    "dev".to_owned()
}

/// What an edit would do, or did.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct EditGearResult {
    /// Whether the file needed changing at all. `false` is the idempotent case:
    /// the description already said this.
    pub changed: bool,
    /// Whether the change reached the disk. Always `false` for a dry run.
    pub written: bool,
    /// The file as it is now, for a preview to diff against.
    pub before: String,
    /// The file as it would be, or as it now is. Equal to `before` when
    /// `changed` is false.
    pub after: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
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

/// `gearbox/generate/plan` and `gearbox/generate/apply`.
///
/// The same envelope for both, because they differ only in whether anything is
/// written. `out` is the CLI's `--out`: a test (and a Studio run that must not
/// collide with a developer's tree) can send the artefacts to a separate root.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct GenerateParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// Absolute output root. Omitted, the server uses
    /// `<workspace>/.gearbox/<product>/<profile>/`, the same layout as the CLI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<String>,
}

/// One line per file, and nothing else: `FilePlan` is a preview line, not a
/// payload. File contents arrive on `gearbox/generate/file`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct GeneratePlanResult {
    pub plans: Vec<FilePlan>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
    pub out_root: String,
    /// Processes this milestone does not generate (worker entry points are M6).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped: Vec<String>,
}

/// What an apply did.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct GenerateApplyResult {
    pub plans: Vec<FilePlan>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
    pub written: u32,
}

/// `gearbox/generate/file` -- the two sides of one planned file.
///
/// Re-runs generation and picks one entry. Stateless on purpose: a cached plan
/// the client later applies would need a staleness check, and we do not have
/// one yet. `Cargo.lock` is ~100k; putting every file on the plan would make
/// the preview the expensive call.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct GenerateFileParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<String>,
    /// Path relative to `out_root`, as `FilePlan.path` spelled it.
    pub file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct GenerateFileResult {
    /// The bytes generation proposes, as text. Absent when they are not UTF-8.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposed: Option<String>,
    /// What is on disk today. Absent when the file does not exist or is not
    /// UTF-8 -- the same distinction `preview_available` makes on the plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    pub action: FileAction,
    pub ownership: Ownership,
}
