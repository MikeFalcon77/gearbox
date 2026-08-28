//! Product intent: what someone wants.
//!
//! The second of the model's three representations, and the only one a human
//! authors. It says nothing about how the product is realized -- that is derived.
//!
//! Two properties are deliberate. First, there is **no way to state whether a
//! binding is local or remote**: that is a consequence of placement, and offering
//! it as a knob would let a description contradict the topology it asked for.
//! Second, profile-specific choices are expressed by **scoping a declaration to a
//! list of profiles**, not by branching. Data, not control flow -- which is what
//! keeps the description language declarative.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::contract::Transport;
use crate::ids::{ContractId, GearId, ProcessId, ProfileId, RelPath, SourceId};
use crate::requirement::ClusterPrimitive;

/// Where to get a gear's source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SourceDecl {
    /// A local directory, relative to the product description.
    Path { at: String },

    /// A Git repository at a pinned reference.
    ///
    /// Pinning is by tag, revision, or branch; the resolved commit is what lands
    /// in the lock, because a branch is not a reproducible input.
    Git {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tag: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rev: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
    },
}

impl SourceDecl {
    /// Whether this reference pins an immutable point in history.
    ///
    /// A branch does not, so a lock built from one is repeatable but not
    /// reproducible.
    #[must_use]
    pub const fn is_immutable(&self) -> bool {
        match self {
            Self::Path { .. } => false,
            Self::Git { rev, tag, .. } => rev.is_some() || tag.is_some(),
        }
    }
}

/// How a consumer finds a remote provider's address.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Discovery {
    /// Addresses are pinned in configuration and read by the static endpoint
    /// resolver.
    ///
    /// The only mechanism available under Kubernetes, because no cluster-native
    /// endpoint resolver exists.
    Static,

    /// Addresses come from the directory service over gRPC.
    ///
    /// Requires the directory server and the gRPC hub in the host process: the
    /// host's worker-spawn phase waits for the hub's endpoint in order to hand it
    /// to each child.
    Directory,
}

impl Discovery {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Static => "static",
            Self::Directory => "directory",
        }
    }

    /// Whether this mechanism needs the directory server co-resident with the host.
    #[must_use]
    pub const fn needs_directory(self) -> bool {
        matches!(self, Self::Directory)
    }
}

/// A deployment profile, as declared.
///
/// A composition-time concept: the runtime has no such type, only a per-gear
/// runtime kind. Each variant is projected onto that plus a deployment topology.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "profile", rename_all = "snake_case")]
pub enum DeploymentProfileDecl {
    /// Everything in one process. Every contract binding is local by construction.
    Embedded { id: ProfileId },

    /// One host process that spawns worker processes.
    ///
    /// Workers are local operating-system processes; no other spawn backend is
    /// implemented, so this profile is one machine.
    HostWorkers {
        id: ProfileId,
        /// Which process is the host.
        host: ProcessId,
        discovery: Discovery,
        /// Where worker binaries will be built, needed to write each worker's
        /// executable path.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target_dir: Option<String>,
    },

    /// One container image and workload per process.
    Kubernetes {
        id: ProfileId,
        discovery: Discovery,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image_registry: Option<String>,
    },
}

impl DeploymentProfileDecl {
    #[must_use]
    pub const fn id(&self) -> &ProfileId {
        match self {
            Self::Embedded { id } | Self::HostWorkers { id, .. } | Self::Kubernetes { id, .. } => {
                id
            }
        }
    }

    /// The profile family, as it appears in the lock.
    #[must_use]
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Embedded { .. } => "embedded",
            Self::HostWorkers { .. } => "host-workers",
            Self::Kubernetes { .. } => "kubernetes",
        }
    }

    /// Whether this profile can have more than one process.
    #[must_use]
    pub const fn is_multi_process(&self) -> bool {
        !matches!(self, Self::Embedded { .. })
    }

    /// How remote addresses are found, if there can be any.
    #[must_use]
    pub const fn discovery(&self) -> Option<Discovery> {
        match self {
            Self::Embedded { .. } => None,
            Self::HostWorkers { discovery, .. } | Self::Kubernetes { discovery, .. } => {
                Some(*discovery)
            }
        }
    }
}

/// A gear someone asked for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct GearSelection {
    pub gear: GearId,

    /// Which declared source to read it from.
    pub source: SourceId,

    /// Extra Cargo features to enable.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub features: Vec<String>,

    /// Opaque per-gear runtime configuration, merged into the generated config.
    ///
    /// An ordered map, not `serde_json::Map`, because iteration order reaches the
    /// generated configuration file and must be stable. Values are passed
    /// through untouched; nulls are rejected during evaluation, since the lock is
    /// TOML and TOML has no null.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(type = "Record<string, unknown>")]
    pub config: BTreeMap<String, serde_json::Value>,

    /// Implementations chosen for this gear's plugin extension points.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plugins: Vec<PluginSelection>,
}

/// One plugin implementation chosen for a host gear.
///
/// Which extension point it fills is a catalogue fact, not recorded here: the
/// product names an implementing gear and the catalogue says what that gear
/// implements. Recording it twice would let the two disagree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct PluginSelection {
    pub gear: GearId,

    /// Per-plugin configuration. `vendor` and `priority` here override the
    /// crate's compiled-in defaults, and overriding one side without the other
    /// is what makes a host resolve nothing.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(type = "Record<string, unknown>")]
    pub config: BTreeMap<String, serde_json::Value>,

    /// Profiles this choice applies to. Empty means every profile.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub profiles: BTreeSet<ProfileId>,
}

impl PluginSelection {
    /// The vendor this selection asks for, if the product set one.
    #[must_use]
    pub fn configured_vendor(&self) -> Option<&str> {
        self.config
            .get("vendor")
            .and_then(serde_json::Value::as_str)
    }

    /// The priority this selection asks for, if the product set one.
    #[must_use]
    pub fn configured_priority(&self) -> Option<i64> {
        self.config
            .get("priority")
            .and_then(serde_json::Value::as_i64)
    }
}

/// What someone asked for regarding one binding.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS,
)]
#[serde(rename_all = "lowercase")]
pub enum BindingMode {
    /// Let the resolver decide.
    #[default]
    Auto,
    /// Keep consumer and provider together.
    Local,
    /// Separate them.
    Remote,
}

/// A request about one contract edge.
///
/// Note what is absent: there is no way to declare a binding *is* local or
/// remote, only to ask for it. The resolver decides, and records both.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct BindingIntent {
    pub consumer: GearId,
    pub contract: ContractId,

    #[serde(default)]
    pub mode: BindingMode,

    /// A transport preference. Honoured only if the provider offers it and the
    /// edge can actually carry it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<Transport>,

    /// A pinned address, overriding whatever discovery would produce.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,

    /// Profiles this applies to. Empty means all of them.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub profiles: BTreeSet<ProfileId>,
}

/// A cluster provider choice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ProviderBinding {
    /// The provider name, which must be one the runtime registers.
    pub provider: String,

    /// Backend-specific settings, passed through verbatim.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(type = "Record<string, unknown>")]
    pub options: BTreeMap<String, serde_json::Value>,

    /// A reference to externally managed credentials. Never a credential itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<String>,
}

/// A cluster scope's provider bindings.
///
/// The cache is the anchor and must be bound; leaving the other two unbound is
/// what engages the SDK's compare-and-swap default over that cache, so an absent
/// entry is a meaningful choice rather than an omission.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ClusterScopeIntent {
    /// The scope name. The runtime calls this a cluster profile; renamed so it
    /// cannot be confused with a deployment profile.
    pub scope: String,

    pub cache: ProviderBinding,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leader_election: Option<ProviderBinding>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock: Option<ProviderBinding>,

    /// Profiles this applies to. Empty means all of them.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub profiles: BTreeSet<ProfileId>,
}

impl ClusterScopeIntent {
    /// The binding for `primitive`, if one was made.
    #[must_use]
    pub const fn binding(&self, primitive: ClusterPrimitive) -> Option<&ProviderBinding> {
        match primitive {
            ClusterPrimitive::Cache => Some(&self.cache),
            ClusterPrimitive::LeaderElection => self.leader_election.as_ref(),
            ClusterPrimitive::Lock => self.lock.as_ref(),
        }
    }
}

/// An explicitly requested process.
///
/// Only needed to name or replicate a process; the resolver derives the partition
/// on its own otherwise.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ProcessPin {
    pub name: ProcessId,

    /// The gear whose co-location closure this process is built from.
    pub anchor: GearId,

    #[serde(default = "one")]
    pub replicas: u32,

    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub profiles: BTreeSet<ProfileId>,
}

const fn one() -> u32 {
    1
}

/// A tie-breaker among choices that are all valid.
///
/// Distinct from a constraint, which decides validity. A preference may only
/// order candidates that already satisfy every hard requirement, so no preference
/// can ever make an invalid product valid.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(tag = "prefer", rename_all = "snake_case")]
pub enum Preference {
    /// Favour a provider already in use elsewhere in the same scope, rather than
    /// introducing another dependency.
    ExistingInfrastructure,

    /// Keep gears together when the choice is otherwise free.
    FewerProcesses,

    /// Give this gear its own process when that is possible.
    Isolate { gear: GearId },
}

/// What someone wants.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ProductIntent {
    pub id: String,
    pub display_name: String,
    pub version: String,

    /// Where the product description was read from.
    pub gdl_path: RelPath,

    pub sources: BTreeMap<SourceId, SourceDecl>,

    pub profiles: BTreeMap<ProfileId, DeploymentProfileDecl>,

    pub default_profile: ProfileId,

    /// The gears asked for directly. Their co-location closures bring in more.
    pub selected_gears: Vec<GearSelection>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bindings: Vec<BindingIntent>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cluster_scopes: Vec<ClusterScopeIntent>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub process_pins: Vec<ProcessPin>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub preferences: Vec<Preference>,
}

impl ProductIntent {
    #[must_use]
    pub fn profile(&self, id: &ProfileId) -> Option<&DeploymentProfileDecl> {
        self.profiles.get(id)
    }

    /// Whether a declaration scoped to `scoped_to` applies under `profile`.
    ///
    /// An empty scope means every profile. This one predicate is what replaces
    /// conditionals in the description language.
    #[must_use]
    pub fn applies(scoped_to: &BTreeSet<ProfileId>, profile: &ProfileId) -> bool {
        scoped_to.is_empty() || scoped_to.contains(profile)
    }

    /// The binding requests that apply under `profile`.
    #[must_use]
    pub fn bindings_for(&self, profile: &ProfileId) -> Vec<&BindingIntent> {
        self.bindings
            .iter()
            .filter(|b| Self::applies(&b.profiles, profile))
            .collect()
    }

    /// The cluster scopes that apply under `profile`.
    #[must_use]
    pub fn cluster_scopes_for(&self, profile: &ProfileId) -> Vec<&ClusterScopeIntent> {
        self.cluster_scopes
            .iter()
            .filter(|c| Self::applies(&c.profiles, profile))
            .collect()
    }

    /// The process pins that apply under `profile`.
    #[must_use]
    pub fn process_pins_for(&self, profile: &ProfileId) -> Vec<&ProcessPin> {
        self.process_pins
            .iter()
            .filter(|p| Self::applies(&p.profiles, profile))
            .collect()
    }

    /// Whether `preference` was asked for.
    #[must_use]
    pub fn prefers(&self, preference: &Preference) -> bool {
        self.preferences.contains(preference)
    }

    /// Whether a specific gear was asked to be isolated.
    #[must_use]
    pub fn isolates(&self, gear: &GearId) -> bool {
        self.preferences
            .iter()
            .any(|p| matches!(p, Preference::Isolate { gear: g } if g == gear))
    }
}
