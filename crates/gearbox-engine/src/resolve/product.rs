//! Step 10: assembling the lock, and step 9's graph alongside it.
//!
//! Everything the earlier steps decided is gathered here into the one artifact
//! every generator reads. Ordering is imposed by `gearbox_lock::canonicalize_order`
//! and the hash by `compute_hash`, so "did anything actually change" is a byte
//! comparison rather than a judgement.
//!
//! The explanation graph is built from the finished resolution rather than
//! accumulated as each decision is made. The plan asked for the latter; the
//! information is identical either way, because every decision already records
//! its own provenance -- a gear knows why it is in the closure, a binding knows
//! what was asked for and what downgraded it, a cluster choice knows whether it
//! was named. Threading a mutable graph through six modules would buy nothing
//! those records do not already carry, and would couple every step to a type
//! none of them otherwise needs.

use std::collections::BTreeMap;

use gearbox_ir::{
    Catalogue, Choice, ExplanationGraph, ExplanationNode, GearId, InclusionReason,
    KubernetesSettings, LOCK_SCHEMA_VERSION, NodeId, NodeKind, ProductIntent, ProvenanceEdge,
    ProvenanceKind, ResolvedGear, ResolvedProduct, ResolvedProductHeader, ResolvedSource, SourceId,
    binding_key,
};

use super::Resolution;

/// Build the lock from a finished resolution.
///
/// `sources` comes from the caller because only it knows where each root was
/// actually opened; the resolver is pure and has never touched a filesystem.
#[must_use]
pub fn assemble(
    catalogue: &Catalogue,
    intent: &ProductIntent,
    resolution: &Resolution,
    sources: BTreeMap<SourceId, ResolvedSource>,
) -> ResolvedProduct {
    let declaration = intent.profiles.get(&resolution.profile);

    let mut product = ResolvedProduct {
        schema_version: LOCK_SCHEMA_VERSION,
        product: ResolvedProductHeader {
            id: intent.id.clone(),
            version: intent.version.clone(),
            profile: resolution.profile.clone(),
            profile_kind: declaration.map_or("unknown", |d| d.kind()).to_owned(),
            gearbox_version: env!("CARGO_PKG_VERSION").to_owned(),
            // Filled in below, once the body is final. Hashing it before that
            // would hash a value that no longer describes the thing.
            lock_hash: String::new(),
        },
        kubernetes: kubernetes(declaration),
        sources,
        gears: gears(catalogue, intent, resolution),
        processes: resolution.partition.processes.clone(),
        bindings: resolution.bindings.clone(),
        cluster: resolution.cluster.clone(),
        cuttable_if_declared: resolution.cuts.blocked.clone(),
        provenance: explain(catalogue, intent, resolution).edges,
        diagnostics: resolution.diagnostics.clone(),
    };

    gearbox_lock::canonicalize_order(&mut product);
    // A hash that cannot be computed is left empty rather than faked: an empty
    // one is visibly wrong, while a placeholder would compare equal to itself.
    product.product.lock_hash = gearbox_lock::compute_hash(&product).unwrap_or_default();
    product
}

fn kubernetes(
    declaration: Option<&gearbox_ir::DeploymentProfileDecl>,
) -> Option<KubernetesSettings> {
    match declaration {
        Some(gearbox_ir::DeploymentProfileDecl::Kubernetes {
            discovery,
            namespace,
            image_registry,
            ..
        }) => Some(KubernetesSettings {
            namespace: namespace.clone(),
            image_registry: image_registry.clone(),
            discovery: *discovery,
        }),
        _ => None,
    }
}

/// The gears in the product, each carrying why it is here and what it was told.
fn gears(
    catalogue: &Catalogue,
    intent: &ProductIntent,
    resolution: &Resolution,
) -> BTreeMap<GearId, ResolvedGear> {
    resolution
        .closure
        .members
        .iter()
        .filter_map(|(id, reasons)| {
            let descriptor = catalogue.gears.get(id)?;
            Some((
                id.clone(),
                ResolvedGear {
                    id: id.clone(),
                    source: descriptor.source.clone(),
                    gdl_path: descriptor.gdl_path.clone(),
                    package: descriptor.package.clone(),
                    // Resolved at merge time so no generator has to redo it.
                    crate_dir: descriptor.crate_dir(),
                    runtime_caps: descriptor.runtime_caps.clone(),
                    colocated_deps: descriptor.colocated_deps.clone(),
                    selected_by: reasons.clone(),
                    // Only a `use_gear` entry carries configuration. A gear the
                    // closure pulled in has none, and inheriting one would be a
                    // decision nobody wrote down.
                    config: intent
                        .selected_gears
                        .iter()
                        .find(|selection| &selection.gear == id)
                        .map(|selection| selection.config.clone())
                        .unwrap_or_default(),
                },
            ))
        })
        .collect()
}

/// Step 9: the graph that answers "why".
///
/// Node ids are content-derived, never counters, so the same resolution produces
/// the same graph byte for byte. Origins come from the product description when
/// the fact was written there (`use_gear`, `bind`, a profile constructor), and
/// from the catalogue's `gear(...)` when a gear arrived through co-location.
#[must_use]
pub fn explain(
    catalogue: &Catalogue,
    intent: &ProductIntent,
    resolution: &Resolution,
) -> ExplanationGraph {
    let mut graph = ExplanationGraph::new();
    let Some(profile) = node_id(NodeKind::Profile, resolution.profile.as_str()) else {
        return graph;
    };
    let mut profile_node = ExplanationNode::new(
        profile.clone(),
        NodeKind::Profile,
        resolution.profile.to_string(),
    );
    if let Some(origin) = intent
        .profiles
        .get(&resolution.profile)
        .and_then(|d| d.declared_at().cloned())
    {
        profile_node = profile_node.at(origin);
    }
    graph.add_node(profile_node);

    for (gear, reasons) in &resolution.closure.members {
        let Some(id) = node_id(NodeKind::Gear, gear.as_str()) else {
            continue;
        };
        let mut node = ExplanationNode::new(id.clone(), NodeKind::Gear, gear.to_string());
        if let Some(origin) = gear_origin(catalogue, intent, gear) {
            node = node.at(origin);
        }
        graph.add_node(node);
        for reason in reasons {
            let edge = match reason {
                InclusionReason::Selected => Some(ProvenanceEdge::new(
                    id.clone(),
                    profile.clone(),
                    ProvenanceKind::SelectedBy,
                    format!("`{gear}` is named in the product description"),
                )),
                InclusionReason::ColocatedBy { gear: by } => node_id(NodeKind::Gear, by.as_str())
                    .map(|to| {
                        ProvenanceEdge::new(
                            id.clone(),
                            to,
                            ProvenanceKind::ColocatedBy,
                            format!(
                                "`{by}` declares `{gear}` in `deps`, which is link-time and \
                                 cannot be cut"
                            ),
                        )
                    }),
                InclusionReason::RequiredByProfile { profile: p, why } => {
                    node_id(NodeKind::Profile, p.as_str()).map(|to| {
                        ProvenanceEdge::new(id.clone(), to, ProvenanceKind::ConstrainedBy, why)
                    })
                }
                // The edge points at the host, not at the profile: "why is this
                // crate in my binary" is answered by the gear that selected it,
                // and the profile is a qualifier on that answer rather than the
                // answer itself.
                InclusionReason::PluginOf { host, profile: p } => {
                    node_id(NodeKind::Gear, host.as_str()).map(|to| {
                        ProvenanceEdge::new(
                            id.clone(),
                            to,
                            ProvenanceKind::SelectedBy,
                            format!(
                                "`{gear}` is selected as a plugin of `{host}` for profile `{p}`"
                            ),
                        )
                    })
                }
            };
            if let Some(edge) = edge {
                graph.add_edge(edge);
            }
        }
    }

    for process in &resolution.partition.processes {
        let (Some(id), Some(anchor)) = (
            node_id(NodeKind::Process, process.name.as_str()),
            node_id(NodeKind::Gear, process.anchor.as_str()),
        ) else {
            continue;
        };
        graph.add_node(ExplanationNode::new(
            id.clone(),
            NodeKind::Process,
            process.name.to_string(),
        ));
        graph.add_edge(ProvenanceEdge::new(
            id,
            anchor,
            ProvenanceKind::DerivedFrom,
            format!(
                "process `{}` is the co-location closure of `{}`",
                process.name, process.anchor
            ),
        ));
    }

    for binding in &resolution.bindings {
        let key = binding_key(binding.consumer.as_str(), binding.contract.as_str());
        let (Some(id), Some(consumer_process)) = (
            node_id(NodeKind::Binding, &key),
            node_id(NodeKind::Process, binding.consumer_process.as_str()),
        ) else {
            continue;
        };
        let mut node = ExplanationNode::new(
            id.clone(),
            NodeKind::Binding,
            format!("{} -> {}", binding.consumer, binding.contract),
        );
        if let Some(origin) = intent
            .bindings
            .iter()
            .find(|b| b.consumer == binding.consumer && b.contract == binding.contract)
            .and_then(|b| b.declared_at.clone())
        {
            node = node.at(origin);
        }
        graph.add_node(node);
        graph.add_edge(ProvenanceEdge::new(
            id.clone(),
            consumer_process,
            ProvenanceKind::DerivedFrom,
            format!(
                "{:?} because the consumer is in `{}` and the provider in `{}`",
                binding.mode, binding.consumer_process, binding.provider_process
            ),
        ));
        // The edge a reader comes here for: you asked for X and got Y.
        if let Some(code) = binding.selected.downgraded_by
            && let Some(to) = node_id(NodeKind::Diagnostic, code.as_str())
        {
            graph.add_edge(ProvenanceEdge::new(
                id,
                to,
                ProvenanceKind::DowngradedBy,
                format!("requested, and not honoured: {code}"),
            ));
        }
    }

    for binding in &resolution.cluster {
        let key = format!("{}|{}", binding.scope, binding.primitive.slug());
        let Some(id) = node_id(NodeKind::ClusterProvider, &key) else {
            continue;
        };
        graph.add_node(ExplanationNode::new(
            id.clone(),
            NodeKind::ClusterProvider,
            format!(
                "{}/{} -> {}",
                binding.scope,
                binding.primitive.slug(),
                binding.resolved.effective_provider()
            ),
        ));
        for requester in &binding.requesters {
            if let Some(to) = node_id(NodeKind::Gear, requester.as_str()) {
                graph.add_edge(ProvenanceEdge::new(
                    id.clone(),
                    to,
                    ProvenanceKind::DerivedFrom,
                    format!(
                        "`{requester}` requires `{}` in scope `{}`",
                        binding.primitive.slug(),
                        binding.scope
                    ),
                ));
            }
        }
        let (kind, because) = match binding.selected.selected {
            Choice::Explicit { .. } => {
                (ProvenanceKind::Declared, "named in the product description")
            }
            Choice::Auto => (
                ProvenanceKind::PreferredOver,
                "ranked by the resolver; nothing named a provider",
            ),
        };
        graph.add_edge(ProvenanceEdge::new(id, profile.clone(), kind, because));
    }

    // Blocked cuts are part of the answer to "why is this one process", so they
    // belong in the graph rather than only in the diagnostics.
    for candidate in &resolution.cuts.blocked {
        let (Some(from), Some(to)) = (
            node_id(NodeKind::Gear, candidate.consumer.as_str()),
            node_id(NodeKind::Gear, candidate.provider.as_str()),
        ) else {
            continue;
        };
        graph.add_edge(ProvenanceEdge::new(
            from,
            to,
            ProvenanceKind::ConstrainedBy,
            format!("cannot be separated: {:?}", candidate.blocked_by),
        ));
    }

    graph.finish();
    graph
}

/// Origin of a gear node: the product's `use_gear` when named, else `gear(...)`.
fn gear_origin(
    catalogue: &Catalogue,
    intent: &ProductIntent,
    gear: &GearId,
) -> Option<gearbox_ir::Location> {
    if let Some(origin) = intent
        .selected_gears
        .iter()
        .find(|s| &s.gear == gear)
        .and_then(|s| s.declared_at.clone())
    {
        return Some(origin);
    }
    catalogue
        .gears
        .get(gear)
        .and_then(|d| d.declared_at.clone())
}

/// A node id derived from what it names, so the graph is byte-stable.
///
/// Delegates to `NodeKind::id_for`, which is where the `{prefix}:{key}` convention
/// now lives -- a diagnostic naming the same node in its `subject` has to produce
/// the identical string, and two format strings for one wire convention is how a
/// client ends up asking about a node that is not there.
fn node_id(kind: NodeKind, key: &str) -> Option<NodeId> {
    kind.id_for(key)
}
