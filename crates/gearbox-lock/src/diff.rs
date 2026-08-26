//! Structural diffing between two resolved products.
//!
//! A text diff of two `product.lock` files is dominated by noise: changing
//! one intent value can shift every line below it if a collection gains or
//! loses an entry. This compares the parsed structures instead, so the diff
//! is confined to what actually changed
//! (`cpt-gearbox-nfr-lock-diff-minimal`).

use std::collections::BTreeMap;

use gearbox_ir::{ClusterPrimitive, ContractId, GearId, ProcessId, ResolvedProduct};
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

/// What changed between two resolved products.
///
/// Every list is sorted, so the diff itself is deterministic. A key appears
/// in at most one of the added/removed/changed lists for its category.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct LockDiff {
    /// Set when the profile itself differs -- `(before, after)`.
    pub profile_changed: Option<(String, String)>,

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
}

impl LockDiff {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.profile_changed.is_none()
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

        for id in &self.gears_added {
            lines.push(format!("+ gear {id}"));
        }
        for id in &self.gears_removed {
            lines.push(format!("- gear {id}"));
        }
        for id in &self.gears_changed {
            lines.push(format!("~ gear {id}"));
        }

        for id in &self.processes_added {
            lines.push(format!("+ process {id}"));
        }
        for id in &self.processes_removed {
            lines.push(format!("- process {id}"));
        }
        for id in &self.processes_changed {
            lines.push(format!("~ process {id}"));
        }

        for key in &self.bindings_added {
            lines.push(format!("+ binding {} -> {}", key.consumer, key.contract));
        }
        for key in &self.bindings_removed {
            lines.push(format!("- binding {} -> {}", key.consumer, key.contract));
        }
        for key in &self.bindings_changed {
            lines.push(format!("~ binding {} -> {}", key.consumer, key.contract));
        }

        for key in &self.cluster_added {
            lines.push(format!("+ cluster {}.{}", key.scope, key.primitive));
        }
        for key in &self.cluster_removed {
            lines.push(format!("- cluster {}.{}", key.scope, key.primitive));
        }
        for key in &self.cluster_changed {
            lines.push(format!("~ cluster {}.{}", key.scope, key.primitive));
        }

        lines
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

    LockDiff {
        profile_changed,
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
    }
}
