//! Step 2: the co-location closure.
//!
//! This is the step that carries the project's most consequential finding. A
//! gear's `deps` are link-time: the gear macro emits a hidden re-export per
//! entry and the registry treats a missing one as a hard `MissingDeps` failure,
//! so a process containing a gear contains everything that gear reaches. The set
//! is therefore a **closure, not a partition** -- two processes may legitimately
//! share gears, and no resolver decision can sever an edge inside one.
//!
//! Breadth-first from the selected gears, popping in sorted order, so the answer
//! is the same on every run and on every machine.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use gearbox_ir::{
    Catalogue, Diagnostic, DiagnosticCode, Diagnostics, GearId, InclusionReason, Location,
    ProductIntent,
};

/// Every gear in the product, with why each is here.
#[derive(Debug, Default)]
pub struct Closure {
    /// Reasons per gear, sorted and deduplicated. A gear can be both selected
    /// directly and pulled in by someone else, and both are worth keeping: the
    /// answer to "why is this here" is "for two reasons", not one of them.
    pub members: BTreeMap<GearId, Vec<InclusionReason>>,
}

impl Closure {
    #[must_use]
    pub fn contains(&self, gear: &GearId) -> bool {
        self.members.contains_key(gear)
    }

    #[must_use]
    pub fn ids(&self) -> BTreeSet<GearId> {
        self.members.keys().cloned().collect()
    }
}

/// Expand the selected gears over `colocated_deps`.
///
/// Unknown gears are reported and skipped rather than aborting: a product naming
/// one gear that does not exist should still resolve the rest, so the operator
/// sees every problem at once instead of one per run.
pub fn expand(
    catalogue: &Catalogue,
    intent: &ProductIntent,
    diagnostics: &mut Diagnostics,
) -> Closure {
    let uri = format!("file://{}", intent.gdl_path.as_str());
    let mut closure = Closure::default();
    let mut queue: VecDeque<GearId> = VecDeque::new();

    // Seed from the selection, in sorted order so the walk is reproducible.
    let selected: BTreeSet<GearId> = intent
        .selected_gears
        .iter()
        .map(|s| s.gear.clone())
        .collect();
    for gear in &selected {
        if !catalogue.gears.contains_key(gear) {
            diagnostics.push(unknown(gear, None, &uri));
            continue;
        }
        closure
            .members
            .entry(gear.clone())
            .or_default()
            .push(InclusionReason::Selected);
        queue.push_back(gear.clone());
    }

    while let Some(current) = queue.pop_front() {
        let Some(descriptor) = catalogue.gears.get(&current) else {
            continue;
        };
        for dep in &descriptor.colocated_deps {
            if !catalogue.gears.contains_key(dep) {
                diagnostics.push(unknown(dep, Some(&current), &uri));
                continue;
            }
            let reason = InclusionReason::ColocatedBy {
                gear: current.clone(),
            };
            let entry = closure.members.entry(dep.clone()).or_default();
            let first_visit = entry.is_empty();
            if !entry.contains(&reason) {
                entry.push(reason);
            }
            // Enqueue on first visit only. A second reason for a gear already in
            // the closure adds provenance, not new frontier.
            if first_visit {
                queue.push_back(dep.clone());
            }
        }
    }

    for reasons in closure.members.values_mut() {
        reasons.sort();
        reasons.dedup();
    }

    detect_cycle(catalogue, &closure, &uri, diagnostics);
    closure
}

fn unknown(gear: &GearId, pulled_by: Option<&GearId>, uri: &str) -> Diagnostic {
    let message = match pulled_by {
        Some(by) => format!(
            "`{by}` declares a co-location dependency on `{gear}`, which is not in the catalogue"
        ),
        None => format!("`use_gear(\"{gear}\")` names a gear that is not in the catalogue"),
    };
    let help = match pulled_by {
        Some(_) => "the dependency is projected from `#[toolkit::gear(deps = [...])]`, so either \
                    the named gear has no `gear.gdl` or its source root is not open"
            .to_owned(),
        None => "run `gearbox catalogue` to list the ids the open sources declare, or \
                 `gearbox validate --product ...`, which distinguishes a typo from a gear \
                 nobody has described yet"
            .to_owned(),
    };
    Diagnostic::error(DiagnosticCode::TopologyUnknownGear, message, help)
        .at(Location::file(uri.to_owned()))
}

/// Report a cycle among co-location edges.
///
/// The runtime's own topological sort rejects one at startup, so a cycle here
/// means the product cannot boot. Detecting it during the walk would be cheaper,
/// but a separate pass can name the whole cycle rather than the edge that closed
/// it -- and the cycle is what a reader has to break.
fn detect_cycle(
    catalogue: &Catalogue,
    closure: &Closure,
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        Open,
        Done,
    }

    /// Iterative depth-first search: the recursion depth would otherwise follow
    /// the tree's depth, and a malformed catalogue is exactly when that is
    /// unbounded.
    enum Step {
        Enter(GearId),
        Leave(GearId),
    }

    let mut marks: BTreeMap<GearId, Mark> = BTreeMap::new();
    let mut path: Vec<GearId> = Vec::new();
    let mut reported: BTreeSet<Vec<GearId>> = BTreeSet::new();

    for root in closure.members.keys() {
        if marks.get(root) == Some(&Mark::Done) {
            continue;
        }
        let mut stack = vec![Step::Enter(root.clone())];
        while let Some(step) = stack.pop() {
            match step {
                Step::Enter(gear) => {
                    match marks.get(&gear) {
                        Some(Mark::Done) => continue,
                        Some(Mark::Open) => {
                            // Found the back edge; the cycle is the path from the
                            // earlier occurrence to here.
                            if let Some(start) = path.iter().position(|g| *g == gear) {
                                let mut cycle: Vec<GearId> = path[start..].to_vec();
                                cycle.push(gear.clone());
                                if reported.insert(cycle.clone()) {
                                    diagnostics.push(cycle_diagnostic(&cycle, uri));
                                }
                            }
                            continue;
                        }
                        None => {}
                    }
                    marks.insert(gear.clone(), Mark::Open);
                    path.push(gear.clone());
                    stack.push(Step::Leave(gear.clone()));
                    if let Some(descriptor) = catalogue.gears.get(&gear) {
                        // Reversed so the sorted order is preserved once popped.
                        for dep in descriptor.colocated_deps.iter().rev() {
                            if closure.contains(dep) {
                                stack.push(Step::Enter(dep.clone()));
                            }
                        }
                    }
                }
                Step::Leave(gear) => {
                    marks.insert(gear.clone(), Mark::Done);
                    path.pop();
                }
            }
        }
    }
}

fn cycle_diagnostic(cycle: &[GearId], uri: &str) -> Diagnostic {
    let rendered = cycle
        .iter()
        .map(GearId::to_string)
        .collect::<Vec<_>>()
        .join(" -> ");
    Diagnostic::error(
        DiagnosticCode::TopologyDepsCycle,
        format!("co-location dependencies form a cycle: {rendered}"),
        "the runtime's registry sorts gears topologically at startup and refuses a cycle, so \
         this product cannot boot; break the loop by removing one `deps` entry, which means \
         the gear that no longer depends must reach the other through a contract instead",
    )
    .at(Location::file(uri.to_owned()))
}
