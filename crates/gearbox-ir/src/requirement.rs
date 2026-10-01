//! Requirements and capabilities.
//!
//! A **requirement** is something a gear needs. A **capability** is a fact about
//! something that could satisfy it. Resolution is the act of matching the two,
//! and every capability in this model corresponds to a property that is
//! observable in `gears-rust` source -- not to an aspiration.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::catalogue::ConfigSchema;
use crate::ids::{CapabilityId, ContractId, GearId, RequirementId};

/// The cluster coordination primitives the runtime implements.
///
/// Exactly three. There is no fourth.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ClusterPrimitive {
    Cache,
    LeaderElection,
    Lock,
}

impl ClusterPrimitive {
    pub const ALL: &'static [Self] = &[Self::Cache, Self::LeaderElection, Self::Lock];

    /// The key the runtime's cluster configuration uses for this primitive.
    #[must_use]
    pub const fn config_key(self) -> &'static str {
        match self {
            Self::Cache => "cache",
            Self::LeaderElection => "leader_election",
            Self::Lock => "lock",
        }
    }

    /// The `kebab-case` form used inside identifiers.
    #[must_use]
    pub const fn slug(self) -> &'static str {
        match self {
            Self::Cache => "cache",
            Self::LeaderElection => "leader-election",
            Self::Lock => "lock",
        }
    }

    /// Whether omitting this primitive from configuration is what engages the
    /// SDK's compare-and-swap default over the profile's cache.
    ///
    /// The cache is the anchor: it must always be configured explicitly, and the
    /// other two fall back to a default layered over it. That is why an absent
    /// key is meaningful rather than merely missing.
    #[must_use]
    pub const fn falls_back_to_sdk_default(self) -> bool {
        matches!(self, Self::LeaderElection | Self::Lock)
    }
}

impl std::fmt::Display for ClusterPrimitive {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.slug())
    }
}

/// The capability identifiers this release knows about.
///
/// Each is grounded in code that can be pointed at, which is what makes the
/// resolver's refusals checkable (`cpt-gearbox-nfr-evidence-cited`).
pub mod capabilities {
    /// A cache whose reads and writes are linearizable.
    ///
    /// Required by the compare-and-swap based leader election and lock defaults,
    /// which refuse to construct over an eventually-consistent cache.
    pub const CACHE_LINEARIZABLE: &str = "cluster.cache.linearizable";

    /// A cache that can watch one key for changes.
    ///
    /// Weaker than [`CACHE_PREFIX_WATCH`] and not implied by it being absent: a
    /// backend may serve an exact-key watch and no prefix watch -- postgres does,
    /// over a NOTIFY channel that carries one key per payload. What this refuses
    /// is the backend that serves neither, which the SDK spells
    /// `CacheFeatures::without_watch()` and redis reaches under
    /// `watch_mode: disabled`. Without this word a gear that needs to watch a
    /// single key could not say so, and the mismatch arrived at run time as
    /// `ClusterError::Unsupported` rather than as a refusal to resolve.
    pub const CACHE_WATCH: &str = "cluster.cache.watch";

    /// A cache that can watch a key prefix for changes.
    pub const CACHE_PREFIX_WATCH: &str = "cluster.cache.prefix-watch";

    /// Leader election with linearizable semantics.
    pub const LEADER_ELECTION_LINEARIZABLE: &str = "cluster.leader-election.linearizable";

    /// Distributed locking with linearizable semantics.
    pub const LOCK_LINEARIZABLE: &str = "cluster.lock.linearizable";

    /// Every capability a `cluster.cache(...)` requirement may name.
    pub const CACHE_ALL: &[&str] = &[CACHE_LINEARIZABLE, CACHE_WATCH, CACHE_PREFIX_WATCH];

    /// Every capability a `cluster.leader_election(...)` requirement may name.
    pub const LEADER_ELECTION_ALL: &[&str] = &[LEADER_ELECTION_LINEARIZABLE];

    /// Every capability a `cluster.lock(...)` requirement may name.
    pub const LOCK_ALL: &[&str] = &[LOCK_LINEARIZABLE];
}

impl ClusterPrimitive {
    /// The capabilities a requirement on this primitive may name.
    ///
    /// A requirement naming anything else is a description of a product the
    /// runtime cannot express, and is refused rather than ignored.
    #[must_use]
    pub const fn nameable_capabilities(self) -> &'static [&'static str] {
        match self {
            Self::Cache => capabilities::CACHE_ALL,
            Self::LeaderElection => capabilities::LEADER_ELECTION_ALL,
            Self::Lock => capabilities::LOCK_ALL,
        }
    }
}

/// A fact about something that can satisfy a requirement.
///
/// `evidence` is not decoration: it is the citation a diagnostic quotes when a
/// capability turns out to be absent, and it is what lets a reader confirm the
/// claim instead of trusting the tool.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Capability {
    pub id: CapabilityId,

    /// What having this capability means, in one sentence.
    pub description: String,

    /// Where in `gears-rust` this capability is established or denied, as
    /// `path:line`.
    pub evidence: String,
}

impl Capability {
    #[must_use]
    pub fn new(
        id: CapabilityId,
        description: impl Into<String>,
        evidence: impl Into<String>,
    ) -> Self {
        Self {
            id,
            description: description.into(),
            evidence: evidence.into(),
        }
    }
}

/// What a requirement is for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RequirementKind {
    /// A declared contract edge.
    ///
    /// Distinct from a co-location dependency in the way that matters most: the
    /// provider may be in another process, so this edge is severable -- and it is
    /// the *only* kind of edge that is.
    Contract {
        contract: ContractId,
        /// The gear expected to provide it, as declared.
        from: GearId,
        /// An override for the generated resolving client, when the default
        /// naming does not apply.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolving_client: Option<String>,
    },

    /// A cluster coordination primitive within a named scope.
    Cluster {
        primitive: ClusterPrimitive,
        /// The cluster scope name. The runtime calls this a cluster profile;
        /// renamed here so it cannot be confused with a deployment profile or a
        /// product preset.
        scope: String,
    },
}

impl RequirementKind {
    /// The identifier namespace this kind occupies, used to build a
    /// [`RequirementId`].
    #[must_use]
    pub fn namespace(&self) -> String {
        match self {
            Self::Contract { .. } => "contract.consumes".to_owned(),
            Self::Cluster { primitive, .. } => format!("cluster.{}", primitive.slug()),
        }
    }
}

/// Something a gear needs in order to work.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Requirement {
    pub id: RequirementId,

    /// The gear that needs it.
    pub requester: GearId,

    pub kind: RequirementKind,

    /// Capabilities the satisfier must have. Empty means any satisfier will do.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub capabilities: BTreeSet<CapabilityId>,

    /// Whether the requester cannot serve traffic without this.
    ///
    /// Affects readiness, not startup: a critical remote dependency gates
    /// `/readyz` but must not become a global startup ordering constraint.
    #[serde(default)]
    pub critical: bool,
}

impl Requirement {
    /// The contract this requirement names, if it is a contract requirement.
    #[must_use]
    pub const fn contract(&self) -> Option<&ContractId> {
        match &self.kind {
            RequirementKind::Contract { contract, .. } => Some(contract),
            RequirementKind::Cluster { .. } => None,
        }
    }

    /// The declared provider gear, if this is a contract requirement.
    #[must_use]
    pub const fn declared_provider(&self) -> Option<&GearId> {
        match &self.kind {
            RequirementKind::Contract { from, .. } => Some(from),
            RequirementKind::Cluster { .. } => None,
        }
    }

    /// Whether this is a contract requirement, and therefore potentially
    /// severable across a process boundary.
    #[must_use]
    pub const fn is_contract(&self) -> bool {
        matches!(self.kind, RequirementKind::Contract { .. })
    }
}

/// A cluster provider, projected from the cluster gear's Rust.
///
/// A build condition a provider registration sits under.
///
/// Two variants rather than three: "always" is the absence of an entry, so it
/// costs nothing on the wire and cannot be confused with a predicate that was
/// read and found empty. `Unreadable` is kept apart from absence deliberately
/// -- a registration nobody can place in a build must not look like one that is
/// in every build.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum FeatureGate {
    /// Registered only where this cargo feature is enabled.
    Feature(String),
    /// Gated by a predicate the projector could not reduce to one feature.
    Unreadable(String),
}

/// Assembled from three places, because no single one of them has the whole
/// answer: `ClusterGear::provider_registry()` says which provider types are
/// registered and for which primitive, the provider's own `fn provider()` says
/// what it is called, and the *backend* impl says what it can do. That last hop
/// is the surprising one -- the provider traits carry no capability at all, only
/// a name and a factory.
///
/// Two fields are not projected, and deliberately so: `process_local` and
/// `needs_credentials` have no representation anywhere in Rust, so they are
/// declared. Every other field here is read out of source, which is what keeps a
/// provider registered in code from silently missing from the catalogue.
// **`PartialEq` without `Eq`, since `options` arrived.** A projected default is
// a `serde_json::Value`, which is `PartialEq` and deliberately not `Eq` -- `f64`
// has no total equality. Nothing compares providers for hashing or set
// membership; they are values in a map keyed by name.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
pub struct ClusterProviderDecl {
    /// The name used in configuration, e.g. `postgres`.
    pub name: String,

    /// The primitives this provider implements natively.
    pub primitives: BTreeSet<ClusterPrimitive>,

    /// Per-primitive capabilities.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub capabilities: BTreeMap<ClusterPrimitive, BTreeSet<CapabilityId>>,

    /// Whether this backend's state lives inside a single process.
    ///
    /// The decisive property for multi-process topologies: an in-memory backend
    /// starts successfully in every replica and coordinates none of them, so
    /// leader election over it elects one leader per replica. That failure is
    /// silent at runtime, which is why it must be caught here.
    #[serde(default)]
    pub process_local: bool,

    /// Whether the provider needs credentials before it can connect.
    #[serde(default)]
    pub needs_credentials: bool,

    /// Primitives whose capabilities this backend decides at run time.
    ///
    /// Empty for a backend that states its capabilities in Rust. Non-empty
    /// means there was nothing to project: the redis cache reads its
    /// consistency off the server it connects to, so `capabilities` for that
    /// primitive is empty **because nothing is promised**, not because the
    /// backend is poor.
    ///
    /// The distinction has to survive into the resolver, or its explanation
    /// degrades into a half-truth. "redis: missing cluster.cache.linearizable"
    /// reads as *cannot be*, when the honest statement is *cannot be known
    /// until it connects*.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub runtime_determined: BTreeSet<ClusterPrimitive>,

    /// The shape of the options this backend accepts, per primitive.
    ///
    /// **Projected from the struct the backend already deserializes into**, not
    /// written a second time: every one of them is `#[derive(Deserialize)]` with
    /// `#[serde(deny_unknown_fields)]`, so the authority for what an option key
    /// may be already exists in Rust. What did not exist is the *join key* --
    /// the provider traits carry `provider()` and `build_*(options: &Map)` and
    /// nothing that names the type those options are read into -- so
    /// `cluster_plugin(cache_options = "...")` declares it, for the same reason
    /// `process_local` is declared: no Rust construct states the link, and
    /// reading it out of a `build_*` body would be our inference rather than the
    /// code's statement.
    ///
    /// Absent for a primitive whose plugin declares no options struct, which
    /// keeps today's behaviour exactly: an untyped bag, checked by nothing until
    /// the backend starts.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub options: BTreeMap<ClusterPrimitive, ConfigSchema>,

    /// Which primitives this backend registers only under a cargo feature.
    ///
    /// **Absence means "in every build", which is every provider but one.** The
    /// Kubernetes plugin registers its three behind `#[cfg(feature = "k8s")]`,
    /// and the cluster crate's own comment states the consequence: "a profile
    /// binding `provider: k8s` requires a build with this feature". A catalogue
    /// that recorded those registrations as unconditional would let a product
    /// bind a backend its build does not link -- which is exactly the failure
    /// `no_provider_registers_leader_election` was written to keep impossible
    /// while no native leader election existed.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub gated_by: BTreeMap<ClusterPrimitive, FeatureGate>,

    /// Which option carries the credential, when this backend needs one.
    ///
    /// Declared rather than projected, and the reason is sharper here than for
    /// `process_local`: the fields in question are plain `String`, so the
    /// projector's `secret` flag -- which reads `secrecy` wrappers and nothing
    /// else -- is false for both, and a name heuristic catches
    /// `connection_string` and misses `url`. A form that will *save* one of
    /// these must not offer a plaintext box for it, so the fact has to be
    /// stated somewhere, and the plugin is what knows it.
    ///
    /// Teaching the projector a `secrecy` wrapper upstream is the better answer
    /// and is a change to the plugin crates, decided separately.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_option: Option<String>,
}

impl ClusterProviderDecl {
    /// Whether this provider implements `primitive` with all of `required`.
    #[must_use]
    pub fn satisfies(
        &self,
        primitive: ClusterPrimitive,
        required: &BTreeSet<CapabilityId>,
    ) -> bool {
        if !self.primitives.contains(&primitive) {
            return false;
        }
        match self.capabilities.get(&primitive) {
            Some(have) => required.is_subset(have),
            // No capability entry means no capabilities, which satisfies only an
            // empty requirement.
            None => required.is_empty(),
        }
    }

    /// The capabilities this provider has for `primitive`.
    #[must_use]
    pub fn capabilities_for(&self, primitive: ClusterPrimitive) -> BTreeSet<CapabilityId> {
        self.capabilities
            .get(&primitive)
            .cloned()
            .unwrap_or_default()
    }

    /// Which of `required` this provider lacks for `primitive`.
    ///
    /// Drives the per-candidate comparison table in the unsatisfiable-capability
    /// diagnostic, which is what makes that error actionable rather than merely
    /// correct.
    #[must_use]
    pub fn missing(
        &self,
        primitive: ClusterPrimitive,
        required: &BTreeSet<CapabilityId>,
    ) -> BTreeSet<CapabilityId> {
        let have = self.capabilities_for(primitive);
        required.difference(&have).cloned().collect()
    }
}
