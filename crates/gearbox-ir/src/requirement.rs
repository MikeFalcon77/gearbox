//! Requirements and capabilities.
//!
//! A **requirement** is something a gear needs. A **capability** is a fact about
//! something that could satisfy it. Resolution is the act of matching the two,
//! and every capability in this model corresponds to a property that is
//! observable in `gears-rust` source -- not to an aspiration.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

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

    /// A cache that can watch a key prefix for changes.
    pub const CACHE_PREFIX_WATCH: &str = "cluster.cache.prefix-watch";

    /// Leader election with linearizable semantics.
    pub const LEADER_ELECTION_LINEARIZABLE: &str = "cluster.leader-election.linearizable";

    /// Distributed locking with linearizable semantics.
    pub const LOCK_LINEARIZABLE: &str = "cluster.lock.linearizable";

    /// Every capability a `cluster.cache(...)` requirement may name.
    pub const CACHE_ALL: &[&str] = &[CACHE_LINEARIZABLE, CACHE_PREFIX_WATCH];

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

/// A cluster provider, as declared by the cluster gear's description.
///
/// The runtime assembles its provider registry in hand-written Rust, so this
/// declaration is mirrored from that source and cross-checked against it. A
/// provider registered in Rust but missing here would silently narrow what the
/// resolver believes is available; the reverse would let it bless a provider that
/// does not exist.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
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
