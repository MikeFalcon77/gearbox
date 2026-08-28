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
        gears: gears(catalogue, resolution),
        processes: resolution.partition.processes.clone(),
        bindings: resolution.bindings.clone(),
        cluster: resolution.cluster.clone(),
        cuttable_if_declared: resolution.cuts.blocked.clone(),
        provenance: explain(resolution).edges,
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

/// The gears in the product, each carrying why it is here.
fn gears(catalogue: &Catalogue, resolution: &Resolution) -> BTreeMap<GearId, ResolvedGear> {
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
                    // Resolved once here so no generator has to redo it.
                    crate_dir: descriptor
                        .gdl_path
                        .parent()
                        .resolve(descriptor.package.path.as_str())
                        .unwrap_or_else(|_| descriptor.gdl_path.parent()),
                    runtime_caps: descriptor.runtime_caps.clone(),
                    colocated_deps: descriptor.colocated_deps.clone(),
                    selected_by: reasons.clone(),
                },
            ))
        })
        .collect()
}

/// Step 9: the graph that answers "why".
///
/// Node ids are content-derived, never counters, so the same resolution produces
/// the same graph byte for byte.
#[must_use]
pub fn explain(resolution: &Resolution) -> ExplanationGraph {
    let mut graph = ExplanationGraph::new();
    let Some(profile) = node_id(NodeKind::Profile, resolution.profile.as_str()) else {
        return graph;
    };
    graph.add_node(ExplanationNode::new(
        profile.clone(),
        NodeKind::Profile,
        resolution.profile.to_string(),
    ));

    for (gear, reasons) in &resolution.closure.members {
        let Some(id) = node_id(NodeKind::Gear, gear.as_str()) else {
            continue;
        };
        graph.add_node(ExplanationNode::new(
            id.clone(),
            NodeKind::Gear,
            gear.to_string(),
        ));
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
        let key = format!("{}|{}", binding.consumer, binding.contract);
        let (Some(id), Some(consumer_process)) = (
            node_id(NodeKind::Binding, &key),
            node_id(NodeKind::Process, binding.consumer_process.as_str()),
        ) else {
            continue;
        };
        graph.add_node(ExplanationNode::new(
            id.clone(),
            NodeKind::Binding,
            format!("{} -> {}", binding.consumer, binding.contract),
        ));
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

/// A node id derived from what it names, so the graph is byte-stable.
///
/// `None` only for an empty key, which no caller produces: every key comes from
/// an already-validated id. Returning an `Option` rather than asserting that is
/// what keeps the function total -- an unnameable node is simply absent from the
/// graph, which degrades the explanation instead of aborting the resolution.
fn node_id(kind: NodeKind, key: &str) -> Option<NodeId> {
    // A colon separates the two parts, so one inside the key would make a third.
    let sanitized = key.replace(':', "_");
    NodeId::new(format!("{}:{sanitized}", kind.prefix())).ok()
}
