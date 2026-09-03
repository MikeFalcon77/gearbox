//! The canonical typed model for Gearbox Builder.
//!
//! Pure data plus construction-time validation: no filesystem, no process, no
//! clock, no network. Everything downstream -- the description-language
//! evaluator, the resolver, the generators, the lock serializer, and the RPC
//! layer -- agrees by agreeing on these types.

pub mod catalogue;
pub mod contract;
pub mod diagnostics;
pub mod explain;
pub mod fileset;
pub mod ids;
pub mod intent;
pub mod requirement;
pub mod resolved;

pub use catalogue::{
    Catalogue, ConfigFieldDecl, ConfigFieldType, ConfigSchema, DeclaredRole, EndpointDecl,
    ExtensionPointDecl, GearDescriptor, GearDocs, GtsTypeDecl, LifecycleDecl, LoadStage,
    PendingGear, PluginFill, ResolvedSource, RuntimeCap, SourceKind, Visibility,
};
pub use contract::{
    CargoRef, ContractDescriptor, ContractKind, ContractVersion, GrpcProjection,
    ProviderDescriptor, RestProjection, RestVisibility, Transport, strip_version_suffix,
    version_marker,
};
pub use diagnostics::{
    Diagnostic, DiagnosticCode, DiagnosticDomain, Diagnostics, Location, Position, Range,
    RelatedLocation, Severity, UnknownDiagnosticCode, file_uri,
};
pub use explain::{
    ExplanationGraph, ExplanationNode, NodeKind, ProvenanceEdge, ProvenanceKind, binding_key,
};
pub use fileset::{FileAction, FileEntry, FileKind, FilePlan, FileSet, Ownership};
pub use ids::{
    CapabilityId, ContractId, GearId, IdError, NodeId, ProcessId, ProfileId, ProviderId, RelPath,
    RequirementId, SourceId,
};
pub use intent::{
    BindingIntent, BindingMode, ClusterScopeIntent, ConfigValue, DeploymentProfileDecl, Discovery,
    GearSelection, PluginSelection, Preference, ProcessPin, ProductIntent, ProviderBinding,
    SourceDecl,
};
pub use requirement::{
    Capability, ClusterPrimitive, ClusterProviderDecl, Requirement, RequirementKind, capabilities,
};
pub use resolved::{
    BindingMechanism, BindingRequest, Choice, ClusterResolution, CutBlocker, CutCandidate,
    CutSavings, Entrypoint, InclusionReason, KubernetesSettings, LOCK_SCHEMA_VERSION, ProcessKind,
    ResolvedBinding, ResolvedBindingMode, ResolvedClusterBinding, ResolvedEndpoint, ResolvedGear,
    ResolvedProcess, ResolvedProduct, ResolvedProductHeader, Selected, SpawnSpec,
};
