//! The resolved product: derived implementation.
//!
//! The third of the model's three representations, and the only one written by a
//! machine. Serialized as `product.lock`, committed, diffed, and the sole input
//! to every generator -- so no generator ever re-derives a decision, and the Helm
//! output cannot come to disagree with the Cargo output.
//!
//! Two shapes carry most of the meaning. [`Selected`] keeps what was asked for
//! next to what was produced, so a downgrade is visible rather than silent. And
//! [`BindingMechanism`] names the actual code path the runtime will take, rather
//! than an abstraction over it, so the lock can be checked against behaviour.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::catalogue::{ResolvedSource, RuntimeCap};
use crate::contract::{CargoRef, Transport};
use crate::diagnostics::{DiagnosticCode, Diagnostics};
use crate::explain::ProvenanceEdge;
use crate::ids::{CapabilityId, ContractId, GearId, ProcessId, ProfileId, RelPath, SourceId};
use crate::intent::{BindingMode, Discovery};
use crate::requirement::ClusterPrimitive;

/// The schema version of the lock format.
///
/// A reader that meets an unknown version must refuse rather than guess: a lock
/// half-understood is worse than one not read at all.
pub const LOCK_SCHEMA_VERSION: u32 = 1;

/// What was asked for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "choice", rename_all = "snake_case")]
pub enum Choice<T> {
    /// Nothing was asked for; the resolver chose.
    Auto,
    /// Something specific was asked for.
    Explicit { value: T },
}

impl<T> Choice<T> {
    #[must_use]
    pub const fn is_auto(&self) -> bool {
        matches!(self, Self::Auto)
    }

    #[must_use]
    pub const fn explicit(&self) -> Option<&T> {
        match self {
            Self::Auto => None,
            Self::Explicit { value } => Some(value),
        }
    }
}

/// What was asked for, alongside why the outcome differs if it does.
///
/// The resolved value lives on the surrounding struct, not in here: it is not
/// optional, whereas a request is. Keeping them adjacent is what turns "you asked
/// for gRPC and got REST" from a surprise into an explanation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Selected<T> {
    pub selected: Choice<T>,

    /// The code explaining why the outcome differs from the request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub downgraded_by: Option<DiagnosticCode>,
}

impl<T> Selected<T> {
    /// The resolver chose freely.
    #[must_use]
    pub const fn auto() -> Self {
        Self {
            selected: Choice::Auto,
            downgraded_by: None,
        }
    }

    /// A request was made and honoured.
    #[must_use]
    pub const fn honoured(value: T) -> Self {
        Self {
            selected: Choice::Explicit { value },
            downgraded_by: None,
        }
    }

    /// A request was made and could not be honoured.
    #[must_use]
    pub const fn downgraded(value: T, code: DiagnosticCode) -> Self {
        Self {
            selected: Choice::Explicit { value },
            downgraded_by: Some(code),
        }
    }

    /// Whether the outcome differs from the request.
    #[must_use]
    pub const fn was_downgraded(&self) -> bool {
        self.downgraded_by.is_some()
    }
}

/// Whether a process hosts others or is hosted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ProcessKind {
    /// Runs the full host runtime, and spawns workers when there are any.
    Host,
    /// Runs the out-of-process runtime: its own HTTP router, probes,
    /// self-registration, and heartbeat.
    Worker,
}

/// Which runtime entry point a generated binary calls.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Entrypoint {
    /// The host runtime.
    RunServer,
    /// The out-of-process worker runtime.
    RunOopWithOptions,
}

impl Entrypoint {
    #[must_use]
    pub const fn for_kind(kind: ProcessKind) -> Self {
        match kind {
            ProcessKind::Host => Self::RunServer,
            ProcessKind::Worker => Self::RunOopWithOptions,
        }
    }
}

/// Something a process listens on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ResolvedEndpoint {
    pub name: String,

    /// The gear that owns the socket.
    pub gear: GearId,

    /// The configuration key carrying the address.
    pub config_key: String,

    pub address: String,

    /// The address other processes should use, when it differs from the bind
    /// address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advertise_uri: Option<String>,

    /// Whether a loopback address may be advertised.
    ///
    /// Acceptable on one machine and wrong anywhere else, so it is recorded
    /// rather than assumed.
    #[serde(default)]
    pub allow_loopback_advertise: bool,
}

/// A worker a host process starts.
///
/// Mirrors the runtime's per-gear execution configuration exactly, because that
/// is what the generated configuration has to contain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SpawnSpec {
    /// The gear whose runtime kind is set to out-of-process.
    pub gear: GearId,

    pub executable_path: String,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,

    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub environment: BTreeMap<String, String>,
}

/// A gear as it appears in the resolved product.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ResolvedGear {
    pub id: GearId,
    pub source: SourceId,

    /// Where its description was read from, for traceability.
    pub gdl_path: RelPath,

    pub package: CargoRef,

    /// The crate directory relative to its source root, resolved once here so no
    /// generator has to redo it.
    pub crate_dir: RelPath,

    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub runtime_caps: BTreeSet<RuntimeCap>,

    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub colocated_deps: BTreeSet<GearId>,

    /// Why this gear is in the product at all.
    ///
    /// Either the description selected it, or something's co-location closure
    /// pulled it in. Recorded because "why is this even here" is one of the most
    /// common questions about a resolved product.
    pub selected_by: Vec<InclusionReason>,
}

/// How a gear came to be in the product.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum InclusionReason {
    /// Named directly in the product description.
    Selected,
    /// Pulled in by another gear's co-location dependency.
    ColocatedBy { gear: GearId },
    /// Required to satisfy a structural constraint of the profile.
    RequiredByProfile { profile: ProfileId, why: String },
}

/// One process in the resolved topology.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ResolvedProcess {
    pub name: ProcessId,
    pub kind: ProcessKind,

    /// The gear whose co-location closure defines this process.
    ///
    /// For a worker this is also its directory identity, verbatim: the runtime
    /// takes that name from a field fixed in the binary, with no configuration
    /// override, which is why roles cannot be expressed.
    pub anchor: GearId,

    /// The gears in this binary, in dependency order.
    ///
    /// **May overlap other processes.** A gear reached by two closures is linked
    /// into both binaries; that is a consequence of co-location being a closure
    /// rather than a partition, not a mistake.
    pub gears: Vec<GearId>,

    pub replicas: u32,

    pub entrypoint: Entrypoint,

    /// The binary name.
    pub bin_name: String,

    /// The generated crate's package name.
    pub crate_name: String,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub listens: Vec<ResolvedEndpoint>,

    /// The single REST host gear, if this process has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rest_host: Option<GearId>,

    /// The single gRPC hub gear, if this process has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grpc_hub: Option<GearId>,

    #[serde(default)]
    pub needs_db: bool,

    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub cargo_features: BTreeSet<String>,

    /// Workers this process starts. Only a host has any.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spawns: Vec<SpawnSpec>,

    /// The container image, when the profile builds images.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,

    /// The chart subdirectory, when the profile generates a chart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subchart: Option<String>,

    /// The service port other processes reach this one on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_port: Option<u16>,
}

impl ResolvedProcess {
    #[must_use]
    pub fn contains(&self, gear: &GearId) -> bool {
        self.gears.contains(gear)
    }

    #[must_use]
    pub const fn is_worker(&self) -> bool {
        matches!(self.kind, ProcessKind::Worker)
    }

    /// Whether this process runs more than one copy of itself.
    #[must_use]
    pub const fn is_replicated(&self) -> bool {
        self.replicas > 1
    }
}

/// How a binding is actually established.
///
/// Deliberately names the real code path rather than an abstraction over it, so a
/// reader can check the lock against what the runtime does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum BindingMechanism {
    /// The provider is in the same binary, so the client hub's local lookup
    /// short-circuits. No readiness gate, and no configuration can change it.
    ColocatedLocal,

    /// A declared contract edge resolved through the static endpoint resolver,
    /// reading the consumer's endpoint override from configuration. REST only.
    ConsumesStatic,

    /// A declared contract edge resolved through the directory service.
    ConsumesDirectory,

    /// The provider's client wiring points at a remote address while its crate
    /// stays linked in. Used only when a transport request forces it.
    ProvidesClientWiring,
}

impl BindingMechanism {
    /// The mechanism for a same-process binding.
    #[must_use]
    pub const fn colocated() -> Self {
        Self::ColocatedLocal
    }

    /// The mechanism for a severed edge under `discovery`.
    #[must_use]
    pub const fn for_discovery(discovery: Discovery) -> Self {
        match discovery {
            Discovery::Static => Self::ConsumesStatic,
            Discovery::Directory => Self::ConsumesDirectory,
        }
    }

    /// Whether this mechanism gates the consumer's readiness.
    ///
    /// A local binding does not: the local lookup succeeds immediately. A remote
    /// one does, which is how a critical dependency keeps a process out of
    /// rotation without turning startup into a global ordering problem.
    #[must_use]
    pub const fn gates_readiness(self) -> bool {
        !matches!(self, Self::ColocatedLocal)
    }
}

/// What was requested for a binding, as one value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct BindingRequest {
    pub mode: BindingMode,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<Transport>,
}

/// What a binding resolved *to*.
///
/// Two variants where [`BindingMode`] has three, and the missing one is the
/// point: `Auto` is a request to decide, so a resolved binding carrying it would
/// be a lock recording that nothing was decided. Keeping the request enum out of
/// the resolved model makes that state unrepresentable rather than merely
/// unexpected.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ResolvedBindingMode {
    /// Consumer and provider are in the same process.
    Local,
    /// They are in different processes, so the edge crosses a transport.
    Remote,
}

impl ResolvedBindingMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Remote => "remote",
        }
    }
}

impl std::fmt::Display for ResolvedBindingMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One resolved contract binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ResolvedBinding {
    pub consumer: GearId,
    pub consumer_process: ProcessId,
    pub contract: ContractId,
    pub provider: GearId,
    pub provider_process: ProcessId,

    /// What the runtime will actually produce. Derived from placement, never
    /// configured (`cpt-gearbox-fr-derive-binding-from-placement`).
    pub mode: ResolvedBindingMode,

    pub transport: Transport,
    pub mechanism: BindingMechanism,

    /// Where the address comes from: a configuration key, a directory lookup, or
    /// nothing at all for a local binding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_source: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,

    /// Whether the consumer cannot serve without this.
    #[serde(default)]
    pub critical: bool,

    pub selected: Selected<BindingRequest>,
}

impl ResolvedBinding {
    #[must_use]
    pub const fn is_remote(&self) -> bool {
        matches!(self.mode, ResolvedBindingMode::Remote)
    }

    /// Whether this binding keeps the consumer out of rotation until it resolves.
    #[must_use]
    pub const fn gates_readiness(&self) -> bool {
        self.critical && self.mechanism.gates_readiness()
    }
}

/// What a cluster primitive resolved to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "via", rename_all = "kebab-case")]
pub enum ClusterResolution {
    /// A provider the runtime registers.
    Provider { name: String },

    /// The SDK's compare-and-swap default, layered over this scope's cache.
    ///
    /// Not a fallback in the sense of a compromise: it is the intended design
    /// for the primitives that have no dedicated backend, and it is engaged by
    /// leaving the key out of configuration.
    SdkCasDefault { over_cache: String },
}

impl ClusterResolution {
    /// The provider whose capabilities actually decide behaviour.
    ///
    /// For the compare-and-swap default that is the underlying cache, not the
    /// primitive being asked about -- which is why a process-local cache makes
    /// leader election process-local too.
    #[must_use]
    pub fn effective_provider(&self) -> &str {
        match self {
            Self::Provider { name } | Self::SdkCasDefault { over_cache: name } => name,
        }
    }
}

/// One resolved cluster primitive.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ResolvedClusterBinding {
    /// The cluster scope name.
    pub scope: String,

    pub primitive: ClusterPrimitive,

    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub required_capabilities: BTreeSet<CapabilityId>,

    /// The gears that asked for it.
    pub requesters: Vec<GearId>,

    pub selected: Selected<String>,

    pub resolved: ClusterResolution,

    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(type = "Record<string, unknown>")]
    pub options: BTreeMap<String, serde_json::Value>,

    /// A reference to externally managed credentials. Never a credential.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<String>,
}

/// Why an edge could not be severed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum CutBlocker {
    /// The provider is inside the consumer's co-location closure, so it is in the
    /// same binary and the local lookup wins regardless of configuration.
    ColocationClosure,

    /// The dependency is not declared as a contract edge -- it is a direct
    /// type-keyed client lookup. Severing it would fail at runtime, and the
    /// resolver cannot see enough to know otherwise.
    UndeclaredHubEdge,

    /// The contract's kind is in-process only.
    InProcessOnlyContract,

    /// The provider declares no transport that a severed edge can carry.
    NoRemoteTransport,

    /// The profile is single-process.
    ProfileForbidsSplit,
}

impl CutBlocker {
    /// Whether declaring the edge would remove this obstacle.
    ///
    /// Only true for the undeclared case: the rest are facts about the code or
    /// the profile that an annotation cannot change.
    #[must_use]
    pub const fn fixable_by_declaring(self) -> bool {
        matches!(self, Self::UndeclaredHubEdge)
    }
}

/// How much separating an edge would buy.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CutSavings {
    /// Gears that would move into their own process.
    pub gears_moved: u32,

    /// Gears that would leave the original binary entirely.
    pub binary_gears_removed: u32,
}

/// An edge the resolver would sever, but cannot.
///
/// This is a deliverable, not an apology: with the great majority of gears wired
/// by co-location and undeclared client lookups, the list of edges that *would*
/// become severable is the actionable path from today's single binary toward one
/// process per gear (`cpt-gearbox-fr-report-cuttable-if-declared`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CutCandidate {
    pub consumer: GearId,
    pub provider: GearId,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract: Option<ContractId>,

    pub blocked_by: CutBlocker,

    /// The literal source edit that would remove the obstacle, when one would.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_edit: Option<String>,

    /// The file that edit belongs in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<RelPath>,

    #[serde(default)]
    pub estimated_savings: CutSavings,
}

/// Identity and provenance of a resolved product.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ResolvedProductHeader {
    pub id: String,
    pub version: String,

    pub profile: ProfileId,

    /// The profile family: `embedded`, `host-workers`, or `kubernetes`.
    pub profile_kind: String,

    /// Which build produced this, so a stale lock is recognizable.
    pub gearbox_version: String,

    /// A digest of the canonical lock body with this field blanked.
    ///
    /// Makes "did anything actually change" a byte comparison rather than a
    /// judgement (`cpt-gearbox-nfr-determinism`).
    pub lock_hash: String,
}

/// Kubernetes-specific product settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct KubernetesSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_registry: Option<String>,

    pub discovery: Discovery,
}

/// The resolved product. Serialized as `product.lock`.
///
/// Every collection is in canonical order, fixed by the resolver's final pass, so
/// two runs over the same inputs serialize identically.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ResolvedProduct {
    pub schema_version: u32,

    pub product: ResolvedProductHeader,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kubernetes: Option<KubernetesSettings>,

    pub sources: BTreeMap<SourceId, ResolvedSource>,

    pub gears: BTreeMap<GearId, ResolvedGear>,

    /// Ordered by name.
    pub processes: Vec<ResolvedProcess>,

    /// Ordered by consumer then contract.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bindings: Vec<ResolvedBinding>,

    /// Ordered by scope then primitive.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cluster: Vec<ResolvedClusterBinding>,

    /// Ordered by consumer, provider, then contract.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cuttable_if_declared: Vec<CutCandidate>,

    /// Ordered by source, kind, then target.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provenance: Vec<ProvenanceEdge>,

    #[serde(default, skip_serializing_if = "Diagnostics::is_empty")]
    pub diagnostics: Diagnostics,
}

impl ResolvedProduct {
    #[must_use]
    pub fn process(&self, name: &ProcessId) -> Option<&ResolvedProcess> {
        self.processes.iter().find(|p| &p.name == name)
    }

    /// The processes a gear is linked into.
    ///
    /// Plural on purpose: a gear reached by two co-location closures is in both
    /// binaries.
    #[must_use]
    pub fn processes_containing(&self, gear: &GearId) -> Vec<&ResolvedProcess> {
        self.processes.iter().filter(|p| p.contains(gear)).collect()
    }

    /// The single host process, if the topology has one.
    #[must_use]
    pub fn host_process(&self) -> Option<&ResolvedProcess> {
        self.processes
            .iter()
            .find(|p| matches!(p.kind, ProcessKind::Host))
    }

    /// Bindings that cross a process boundary.
    #[must_use]
    pub fn remote_bindings(&self) -> Vec<&ResolvedBinding> {
        self.bindings.iter().filter(|b| b.is_remote()).collect()
    }

    /// Whether the topology has more than one process.
    #[must_use]
    pub fn is_multi_process(&self) -> bool {
        self.processes.len() > 1
    }

    /// Whether any process runs more than one copy of itself.
    #[must_use]
    pub fn has_replicas(&self) -> bool {
        self.processes.iter().any(ResolvedProcess::is_replicated)
    }

    /// Whether this topology needs cross-process coordination.
    ///
    /// The decisive question for cluster provider selection: a process-local
    /// backend is fine for exactly one unreplicated process and silently wrong
    /// otherwise.
    #[must_use]
    pub fn needs_cross_process_coordination(&self) -> bool {
        self.is_multi_process() || self.has_replicas()
    }

    /// Whether writing this lock and generating from it is permitted.
    #[must_use]
    pub fn is_writable(&self) -> bool {
        !self.diagnostics.has_errors()
    }
}
