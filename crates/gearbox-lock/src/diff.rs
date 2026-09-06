//! Structural diffing between two resolved products.
//!
//! A text diff of two `product.lock` files is dominated by noise: changing
//! one intent value can shift every line below it if a collection gains or
//! loses an entry. This compares the parsed structures instead, so the diff
//! is confined to what actually changed
//! (`cpt-gearbox-nfr-lock-diff-minimal`).

use std::collections::BTreeMap;

use gearbox_ir::{
    ClusterPrimitive, ContractId, GearId, NodeId, ProcessId, ProvenanceKind, ResolvedProduct,
    SourceId,
};
use serde::Serialize;

/// The `(consumer, contract)` pair that identifies one binding.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct BindingKey {
    pub consumer: GearId,
    pub contract: ContractId,
}

/// The `(scope, primitive)` pair that identifies one cluster binding.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct ClusterKey {
    pub scope: String,
    pub primitive: ClusterPrimitive,
}

/// The `(consumer, provider, contract)` triple that identifies one blocked cut.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct CutKey {
    pub consumer: GearId,
    pub provider: GearId,
    pub contract: Option<ContractId>,
}

/// The `(from, kind, to)` triple that identifies one provenance edge.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct ProvenanceKey {
    pub from: NodeId,
    pub kind: ProvenanceKind,
    pub to: NodeId,
}

/// One scalar field of the lock that differs -- `(before, after)`.
///
/// A list rather than one `Option` per field: the header alone has six, and six
/// nearly-identical `Option<(String, String)>` members would be six chances to
/// forget one in [`LockDiff::is_empty`].
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct FieldChange {
    /// Dotted path, e.g. `product.lock_hash`.
    pub field: String,
    pub before: String,
    pub after: String,
}

/// What changed between two resolved products.
///
/// Every list is sorted, so the diff itself is deterministic. A key appears
/// in at most one of the added/removed/changed lists for its category.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct LockDiff {
    /// Set when the profile itself differs -- `(before, after)`.
    pub profile_changed: Option<(String, String)>,

    /// Every other scalar that differs: the rest of the header, and the
    /// Kubernetes block. Sorted by field name.
    ///
    /// These used to be compared by nothing at all, so `is_empty` answered
    /// "nothing changed" for a lock with a different `lock_hash`, a different
    /// namespace, or a different image registry.
    pub fields_changed: Vec<FieldChange>,

    pub sources_added: Vec<SourceId>,
    pub sources_removed: Vec<SourceId>,
    pub sources_changed: Vec<SourceId>,

    pub gears_added: Vec<GearId>,
    pub gears_removed: Vec<GearId>,
    pub gears_changed: Vec<GearId>,

    pub processes_added: Vec<ProcessId>,
    pub processes_removed: Vec<ProcessId>,
    pub processes_changed: Vec<ProcessId>,

    pub bindings_added: Vec<BindingKey>,
    pub bindings_removed: Vec<BindingKey>,
    pub bindings_changed: Vec<BindingKey>,

    pub cluster_added: Vec<ClusterKey>,
    pub cluster_removed: Vec<ClusterKey>,
    pub cluster_changed: Vec<ClusterKey>,

    pub cuts_added: Vec<CutKey>,
    pub cuts_removed: Vec<CutKey>,
    pub cuts_changed: Vec<CutKey>,

    pub provenance_added: Vec<ProvenanceKey>,
    pub provenance_removed: Vec<ProvenanceKey>,
    pub provenance_changed: Vec<ProvenanceKey>,

    /// Set when the two locks carry different diagnostics -- `(before, after)`
    /// counts.
    ///
    /// Counts rather than the diagnostics themselves: the widget's job is to
    /// say that the advice changed, and reproducing it here would duplicate a
    /// list the caller already has.
    pub diagnostics_changed: Option<(usize, usize)>,
}

impl LockDiff {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.profile_changed.is_none()
            && self.fields_changed.is_empty()
            && self.diagnostics_changed.is_none()
            && self.sources_added.is_empty()
            && self.sources_removed.is_empty()
            && self.sources_changed.is_empty()
            && self.cuts_added.is_empty()
            && self.cuts_removed.is_empty()
            && self.cuts_changed.is_empty()
            && self.provenance_added.is_empty()
            && self.provenance_removed.is_empty()
            && self.provenance_changed.is_empty()
            && self.gears_added.is_empty()
            && self.gears_removed.is_empty()
            && self.gears_changed.is_empty()
            && self.processes_added.is_empty()
            && self.processes_removed.is_empty()
            && self.processes_changed.is_empty()
            && self.bindings_added.is_empty()
            && self.bindings_removed.is_empty()
            && self.bindings_changed.is_empty()
            && self.cluster_added.is_empty()
            && self.cluster_removed.is_empty()
            && self.cluster_changed.is_empty()
    }

    /// Render as ordered, human-readable lines: `+` added, `-` removed,
    /// `~` changed. What a CLI or the Studio's Lock widget shows directly.
    #[must_use]
    pub fn summary(&self) -> Vec<String> {
        let mut lines = Vec::new();

        if let Some((before, after)) = &self.profile_changed {
            lines.push(format!("~ profile: {before} -> {after}"));
        }
        for change in &self.fields_changed {
            lines.push(format!(
                "~ {}: {} -> {}",
                change.field, change.before, change.after
            ));
        }
        if let Some((before, after)) = self.diagnostics_changed {
            if before == after {
                lines.push(format!("~ diagnostics changed ({before})"));
            } else {
                lines.push(format!("~ diagnostics: {before} -> {after}"));
            }
        }

        marked(
            &mut lines,
            "source",
            [
                &self.sources_added,
                &self.sources_removed,
                &self.sources_changed,
            ],
            ToString::to_string,
        );
        marked(
            &mut lines,
            "gear",
            [&self.gears_added, &self.gears_removed, &self.gears_changed],
            ToString::to_string,
        );
        marked(
            &mut lines,
            "process",
            [
                &self.processes_added,
                &self.processes_removed,
                &self.processes_changed,
            ],
            ToString::to_string,
        );
        marked(
            &mut lines,
            "binding",
            [
                &self.bindings_added,
                &self.bindings_removed,
                &self.bindings_changed,
            ],
            |key| format!("{} -> {}", key.consumer, key.contract),
        );
        marked(
            &mut lines,
            "cluster",
            [
                &self.cluster_added,
                &self.cluster_removed,
                &self.cluster_changed,
            ],
            |key| format!("{}.{}", key.scope, key.primitive),
        );
        marked(
            &mut lines,
            "cuttable",
            [&self.cuts_added, &self.cuts_removed, &self.cuts_changed],
            |key| {
                let contract = key
                    .contract
                    .as_ref()
                    .map_or_else(String::new, |c| format!(" : {c}"));
                format!("{} -> {}{contract}", key.consumer, key.provider)
            },
        );
        marked(
            &mut lines,
            "provenance",
            [
                &self.provenance_added,
                &self.provenance_removed,
                &self.provenance_changed,
            ],
            |key| {
                format!(
                    "{} {} {}",
                    key.to.as_str(),
                    key.kind.phrase(),
                    key.from.as_str()
                )
            },
        );

        lines
    }
}

/// Every scalar in the lock that is not a collection and not the profile.
///
/// Spelled out one pair at a time rather than diffed from serialized JSON: a
/// structural diff that reached for `serde_json::Value` would report a changed
/// *collection* here as well, and each category already has its own list.
fn scalar_fields(before: &ResolvedProduct, after: &ResolvedProduct) -> Vec<FieldChange> {
    let mut out = Vec::new();
    let mut compare = |field: &str, a: String, b: String| {
        if a != b {
            out.push(FieldChange {
                field: field.to_owned(),
                before: a,
                after: b,
            });
        }
    };

    // Destructure so a new lock field is a compile error here, not a silent
    // "unchanged". Collections and diagnostics have their own lists; profile
    // is `profile_changed`.
    let gearbox_ir::ResolvedProduct {
        schema_version: before_schema,
        product: before_header,
        kubernetes: before_k8s,
        sources: _,
        gears: _,
        processes: _,
        bindings: _,
        cluster: _,
        cuttable_if_declared: _,
        provenance: _,
        diagnostics: _,
    } = before;
    let gearbox_ir::ResolvedProduct {
        schema_version: after_schema,
        product: after_header,
        kubernetes: after_k8s,
        sources: _,
        gears: _,
        processes: _,
        bindings: _,
        cluster: _,
        cuttable_if_declared: _,
        provenance: _,
        diagnostics: _,
    } = after;

    compare(
        "schema_version",
        before_schema.to_string(),
        after_schema.to_string(),
    );

    let header_scalars = |header: &gearbox_ir::ResolvedProductHeader| {
        let gearbox_ir::ResolvedProductHeader {
            id,
            version,
            profile: _,
            profile_kind,
            gearbox_version,
            lock_hash,
        } = header;
        (
            id.clone(),
            version.clone(),
            profile_kind.clone(),
            gearbox_version.clone(),
            lock_hash.clone(),
        )
    };
    let (bid, bver, bkind, beng, bhash) = header_scalars(before_header);
    let (aid, aver, akind, aeng, ahash) = header_scalars(after_header);
    compare("product.id", bid, aid);
    compare("product.version", bver, aver);
    compare("product.profile_kind", bkind, akind);
    compare("product.gearbox_version", beng, aeng);
    compare("product.lock_hash", bhash, ahash);

    let k8s_scalars = |settings: Option<&gearbox_ir::KubernetesSettings>| {
        let Some(gearbox_ir::KubernetesSettings {
            namespace,
            image_registry,
            discovery,
        }) = settings
        else {
            return (String::new(), String::new(), String::new());
        };
        (
            namespace.clone().unwrap_or_default(),
            image_registry.clone().unwrap_or_default(),
            discovery.as_str().to_owned(),
        )
    };
    let (bns, breg, bdisc) = k8s_scalars(before_k8s.as_ref());
    let (ans, areg, adisc) = k8s_scalars(after_k8s.as_ref());
    compare("kubernetes.namespace", bns, ans);
    compare("kubernetes.image_registry", breg, areg);
    compare("kubernetes.discovery", bdisc, adisc);

    out.sort();
    out
}

/// Append `+`/`-`/`~` lines for one category, in that order.
///
/// One helper rather than three loops per category: with seven categories the
/// loops were twenty-one near-identical blocks, and the only thing distinguishing
/// them -- the label and how a key reads -- is exactly what is passed in.
fn marked<K>(
    lines: &mut Vec<String>,
    label: &str,
    keys: [&Vec<K>; 3],
    render: impl Fn(&K) -> String,
) {
    for (mark, list) in ["+", "-", "~"].into_iter().zip(keys) {
        for key in list {
            lines.push(format!("{mark} {label} {}", render(key)));
        }
    }
}

/// The added, removed, and changed keys between two ordered maps, each list
/// sorted (an artifact of `K: Ord` and `BTreeSet`'s iteration order, not an
/// extra sort pass).
fn diff_keyed<K: Ord + Clone, V: PartialEq>(
    before: &BTreeMap<K, V>,
    after: &BTreeMap<K, V>,
) -> (Vec<K>, Vec<K>, Vec<K>) {
    let before_keys: std::collections::BTreeSet<&K> = before.keys().collect();
    let after_keys: std::collections::BTreeSet<&K> = after.keys().collect();

    let added = after_keys
        .difference(&before_keys)
        .map(|k| (*k).clone())
        .collect();
    let removed = before_keys
        .difference(&after_keys)
        .map(|k| (*k).clone())
        .collect();
    let changed = before_keys
        .intersection(&after_keys)
        .filter(|k| before[*k] != after[*k])
        .map(|k| (*k).clone())
        .collect();

    (added, removed, changed)
}

/// Compare two resolved products structurally.
///
/// Assumes each product's own invariants: at most one process per name, one
/// binding per `(consumer, contract)`, one cluster entry per
/// `(scope, primitive)`. A resolver that violated those would have a bug
/// worth catching at resolution time, not silently folded into a diff here.
#[must_use]
pub fn diff(before: &ResolvedProduct, after: &ResolvedProduct) -> LockDiff {
    let profile_changed = (before.product.profile != after.product.profile).then(|| {
        (
            before.product.profile.to_string(),
            after.product.profile.to_string(),
        )
    });

    let fields_changed = scalar_fields(before, after);

    let (sources_added, sources_removed, sources_changed) =
        diff_keyed(&before.sources, &after.sources);

    let (gears_added, gears_removed, gears_changed) = diff_keyed(&before.gears, &after.gears);

    let by_process_name = |product: &ResolvedProduct| {
        product
            .processes
            .iter()
            .map(|p| (p.name.clone(), p.clone()))
            .collect::<BTreeMap<_, _>>()
    };
    let (processes_added, processes_removed, processes_changed) =
        diff_keyed(&by_process_name(before), &by_process_name(after));

    let by_binding_key = |product: &ResolvedProduct| {
        product
            .bindings
            .iter()
            .map(|b| {
                (
                    BindingKey {
                        consumer: b.consumer.clone(),
                        contract: b.contract.clone(),
                    },
                    b.clone(),
                )
            })
            .collect::<BTreeMap<_, _>>()
    };
    let (bindings_added, bindings_removed, bindings_changed) =
        diff_keyed(&by_binding_key(before), &by_binding_key(after));

    let by_cluster_key = |product: &ResolvedProduct| {
        product
            .cluster
            .iter()
            .map(|c| {
                (
                    ClusterKey {
                        scope: c.scope.clone(),
                        primitive: c.primitive,
                    },
                    c.clone(),
                )
            })
            .collect::<BTreeMap<_, _>>()
    };
    let (cluster_added, cluster_removed, cluster_changed) =
        diff_keyed(&by_cluster_key(before), &by_cluster_key(after));

    let by_cut_key = |product: &ResolvedProduct| {
        product
            .cuttable_if_declared
            .iter()
            .map(|c| {
                (
                    CutKey {
                        consumer: c.consumer.clone(),
                        provider: c.provider.clone(),
                        contract: c.contract.clone(),
                    },
                    c.clone(),
                )
            })
            .collect::<BTreeMap<_, _>>()
    };
    let (cuts_added, cuts_removed, cuts_changed) =
        diff_keyed(&by_cut_key(before), &by_cut_key(after));

    let by_provenance_key = |product: &ResolvedProduct| {
        product
            .provenance
            .iter()
            .map(|e| {
                (
                    ProvenanceKey {
                        from: e.from.clone(),
                        kind: e.kind,
                        to: e.to.clone(),
                    },
                    e.clone(),
                )
            })
            .collect::<BTreeMap<_, _>>()
    };
    let (provenance_added, provenance_removed, provenance_changed) =
        diff_keyed(&by_provenance_key(before), &by_provenance_key(after));

    let diagnostics_changed = (before.diagnostics != after.diagnostics)
        .then(|| (before.diagnostics.len(), after.diagnostics.len()));

    LockDiff {
        profile_changed,
        fields_changed,
        sources_added,
        sources_removed,
        sources_changed,
        gears_added,
        gears_removed,
        gears_changed,
        processes_added,
        processes_removed,
        processes_changed,
        bindings_added,
        bindings_removed,
        bindings_changed,
        cluster_added,
        cluster_removed,
        cluster_changed,
        cuts_added,
        cuts_removed,
        cuts_changed,
        provenance_added,
        provenance_removed,
        provenance_changed,
        diagnostics_changed,
    }
}
