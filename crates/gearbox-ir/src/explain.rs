//! The explanation graph.
//!
//! Provenance is recorded **while** resolution happens, never reconstructed
//! afterwards (`cpt-gearbox-nfr-provenance-during-resolution`). Reconstruction
//! would infer a rationale it did not observe, and would drift from the resolver
//! as the resolver changed.
//!
//! Node identifiers are derived from content rather than from a counter, so the
//! same inputs produce the same graph byte for byte
//! (`cpt-gearbox-nfr-determinism`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::diagnostics::Location;
use crate::ids::NodeId;

/// What a node stands for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum NodeKind {
    Gear,
    Contract,
    Requirement,
    Capability,
    ClusterProvider,
    Process,
    Binding,
    /// A choice the resolver made. The nodes worth asking "why" about.
    Decision,
    Preference,
    /// A hard rule that eliminated alternatives.
    Constraint,
    Diagnostic,
    Source,
    Profile,
}

impl NodeKind {
    /// The identifier prefix for this kind, so a node id is self-describing.
    #[must_use]
    pub const fn prefix(self) -> &'static str {
        match self {
            Self::Gear => "gear",
            Self::Contract => "contract",
            Self::Requirement => "requirement",
            Self::Capability => "capability",
            Self::ClusterProvider => "cluster-provider",
            Self::Process => "process",
            Self::Binding => "binding",
            Self::Decision => "decision",
            Self::Preference => "preference",
            Self::Constraint => "constraint",
            Self::Diagnostic => "diagnostic",
            Self::Source => "source",
            Self::Profile => "profile",
        }
    }

    /// The node id for a thing of this kind, named by `key`.
    ///
    /// One definition, because there were two: the graph builder formatted
    /// `{prefix}:{key}` inline, and a diagnostic that wanted to name the same node
    /// in its `subject` field would have had to format it again. Two format
    /// strings for one wire convention is how a client ends up asking about a node
    /// that does not exist -- silently, since a missing node reads as "no
    /// explanation recorded".
    ///
    /// `None` only for a key that cannot make a valid id, which no caller
    /// produces: every key comes from an already-validated id. Returning an
    /// `Option` rather than asserting keeps this total -- an unnameable node is
    /// simply absent from the graph, which degrades an explanation instead of
    /// aborting a resolution.
    #[must_use]
    pub fn id_for(self, key: &str) -> Option<NodeId> {
        // Extra colons stay in the payload. `NodeId` is `{kind}:{opaque}`, and
        // decision keys already embed arrows and slashes
        // (`cut:payments-audit->api-contracts/PaymentApi@v1`).
        NodeId::new(format!("{}:{}", self.prefix(), key)).ok()
    }
}

/// The key a binding is named by: `{consumer}|{contract}`.
///
/// A pipe rather than an arrow, and it matters that this is written down once: the
/// Studio builds the same string in TypeScript to ask "why is this binding here",
/// so the two have to agree exactly. The `->` seen in `ids.rs` doc comments is an
/// example of what the *payload grammar* permits, not this convention.
#[must_use]
pub fn binding_key(consumer: &str, contract: &str) -> String {
    format!("{consumer}|{contract}")
}

/// One thing in the graph.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ExplanationNode {
    pub id: NodeId,
    pub kind: NodeKind,

    /// How to show it.
    pub label: String,

    /// Where the underlying fact was declared, when it came from a file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Location>,
}

impl ExplanationNode {
    #[must_use]
    pub fn new(id: NodeId, kind: NodeKind, label: impl Into<String>) -> Self {
        Self {
            id,
            kind,
            label: label.into(),
            origin: None,
        }
    }

    #[must_use]
    pub fn at(mut self, origin: Location) -> Self {
        self.origin = Some(origin);
        self
    }
}

/// Why one node follows from another.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ProvenanceKind {
    /// A description file stated it.
    Declared,
    /// A co-location closure pulled it in.
    ColocatedBy,
    /// The product description selected it.
    SelectedBy,
    /// The resolver derived it from other facts.
    DerivedFrom,
    /// A hard rule eliminated an alternative.
    ConstrainedBy,
    /// A preference ranked one valid candidate above another.
    PreferredOver,
    /// What was asked for differed from what was produced.
    DowngradedBy,
    /// A diagnostic attaches here.
    Diagnosed,
}

impl ProvenanceKind {
    /// A phrase that reads naturally between two node labels.
    #[must_use]
    pub const fn phrase(self) -> &'static str {
        match self {
            Self::Declared => "declared by",
            Self::ColocatedBy => "co-located by",
            Self::SelectedBy => "selected by",
            Self::DerivedFrom => "derived from",
            Self::ConstrainedBy => "constrained by",
            Self::PreferredOver => "preferred over",
            Self::DowngradedBy => "downgraded by",
            Self::Diagnosed => "diagnosed by",
        }
    }
}

/// An edge, carrying its own reason.
///
/// `because` is written at the moment the edge is created, while the resolver
/// still knows the specifics. That is what makes an explanation an account of
/// what happened rather than a plausible story about it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ProvenanceEdge {
    pub from: NodeId,
    pub to: NodeId,
    pub kind: ProvenanceKind,

    /// One sentence of already-resolved "why".
    pub because: String,
}

impl ProvenanceEdge {
    #[must_use]
    pub fn new(from: NodeId, to: NodeId, kind: ProvenanceKind, because: impl Into<String>) -> Self {
        Self {
            from,
            to,
            kind,
            because: because.into(),
        }
    }

    /// The sort key that puts the graph in canonical order.
    fn sort_key(&self) -> (&str, ProvenanceKind, &str) {
        (self.from.as_str(), self.kind, self.to.as_str())
    }
}

/// Why the product is the way it is.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ExplanationGraph {
    pub nodes: BTreeMap<NodeId, ExplanationNode>,
    pub edges: Vec<ProvenanceEdge>,
}

impl ExplanationGraph {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a node, keeping the first label if one is already present.
    ///
    /// Re-recording is expected: the same gear or contract is reached from
    /// several directions during resolution, and the first mention is the one
    /// with the most specific origin.
    pub fn add_node(&mut self, node: ExplanationNode) {
        self.nodes.entry(node.id.clone()).or_insert(node);
    }

    pub fn add_edge(&mut self, edge: ProvenanceEdge) {
        self.edges.push(edge);
    }

    /// Put the graph in canonical order and drop duplicate edges.
    pub fn finish(&mut self) {
        self.edges.sort_by(|a, b| a.sort_key().cmp(&b.sort_key()));
        self.edges.dedup();
    }

    #[must_use]
    pub fn node(&self, id: &NodeId) -> Option<&ExplanationNode> {
        self.nodes.get(id)
    }

    /// Edges pointing away from `id` -- the reasons behind it.
    #[must_use]
    pub fn outgoing(&self, id: &NodeId) -> Vec<&ProvenanceEdge> {
        self.edges.iter().filter(|e| &e.from == id).collect()
    }

    /// Edges pointing at `id` -- what it explains.
    #[must_use]
    pub fn incoming(&self, id: &NodeId) -> Vec<&ProvenanceEdge> {
        self.edges.iter().filter(|e| &e.to == id).collect()
    }

    /// The subgraph reachable from `root` by following reasons, up to `depth`.
    ///
    /// This is what answers a "why" question: start at the decision and walk
    /// outward through everything that produced it.
    #[must_use]
    pub fn because_of(&self, root: &NodeId, depth: usize) -> Self {
        let mut out = Self::new();
        let mut frontier = vec![root.clone()];
        let mut seen = std::collections::BTreeSet::new();
        if let Some(node) = self.nodes.get(root) {
            out.add_node(node.clone());
            seen.insert(root.clone());
        }

        // `depth` is hops, not inclusive loop count: 0 is the root alone.
        for _ in 0..depth {
            let mut next = Vec::new();
            for id in std::mem::take(&mut frontier) {
                for edge in self.outgoing(&id) {
                    out.add_edge(edge.clone());
                    if seen.insert(edge.to.clone()) {
                        if let Some(node) = self.nodes.get(&edge.to) {
                            out.add_node(node.clone());
                        }
                        next.push(edge.to.clone());
                    }
                }
            }
            frontier = next;
            if frontier.is_empty() {
                break;
            }
        }

        out.finish();
        out
    }

    /// Render the reasons behind `root` as ordered prose.
    ///
    /// Each line is `<label> <phrase> <label> -- <because>`. No language model is
    /// involved: the resolver already recorded every clause
    /// (`cpt-gearbox-nfr-explainability`).
    #[must_use]
    pub fn narrate(&self, root: &NodeId, depth: usize) -> Vec<String> {
        let sub = self.because_of(root, depth);
        let label = |id: &NodeId| -> String {
            sub.nodes
                .get(id)
                .map_or_else(|| id.to_string(), |n| n.label.clone())
        };

        sub.edges
            .iter()
            .map(|e| {
                format!(
                    "{} {} {} -- {}",
                    label(&e.from),
                    e.kind.phrase(),
                    label(&e.to),
                    e.because
                )
            })
            .collect()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty() && self.edges.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_for_keeps_colons_in_the_payload() {
        let id = NodeKind::Decision
            .id_for("cut:payments-audit->api-contracts/PaymentApi@v1")
            .expect("NodeId accepts extra colons in the payload");
        assert_eq!(
            id.as_str(),
            "decision:cut:payments-audit->api-contracts/PaymentApi@v1"
        );
    }

    #[test]
    fn because_of_depth_zero_is_the_root_alone() {
        let root = NodeKind::Decision.id_for("root").unwrap();
        let child = NodeKind::Constraint.id_for("rule").unwrap();
        let mut graph = ExplanationGraph::new();
        graph.add_node(ExplanationNode::new(
            root.clone(),
            NodeKind::Decision,
            "root",
        ));
        graph.add_node(ExplanationNode::new(
            child.clone(),
            NodeKind::Constraint,
            "rule",
        ));
        graph.add_edge(ProvenanceEdge::new(
            root.clone(),
            child,
            ProvenanceKind::ConstrainedBy,
            "because",
        ));
        graph.finish();

        let zero = graph.because_of(&root, 0);
        assert_eq!(zero.nodes.len(), 1);
        assert!(zero.nodes.contains_key(&root));
        assert!(zero.edges.is_empty());

        let one = graph.because_of(&root, 1);
        assert_eq!(one.nodes.len(), 2);
        assert_eq!(one.edges.len(), 1);
    }
}
