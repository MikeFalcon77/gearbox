//! Step 4: which gears end up in which process.
//!
//! The word *partition* is a misnomer kept for continuity with the plan, and the
//! misnomer is worth naming because it is the thing most easily got wrong: this
//! is **not** a partition. A process is the co-location closure of its anchor,
//! and two closures may overlap, so one gear is routinely linked into several
//! binaries. That is a consequence of `deps` being link-time, not a mistake to be
//! corrected -- and a resolver that tried to assign each gear to exactly one
//! process would be unable to represent any real product.
//!
//! One deterministic pass, no scoring and no search. Every severable edge whose
//! provider is not already inside the consumer's process becomes an anchor; that
//! is the whole algorithm. A solver would need a cost model that does not exist,
//! and the platform currently offers so few severable edges that there is nothing
//! for one to optimise.

use std::collections::BTreeSet;

use gearbox_ir::{
    Catalogue, DeploymentProfileDecl, Diagnostic, DiagnosticCode, Diagnostics, Entrypoint, GearId,
    Location, ProcessId, ProcessKind, ResolvedProcess, RuntimeCap,
};

use super::closure::Closure;
use super::cuts::Cuts;
use super::profile::ProfileScoped;

/// The processes, in a stable order.
#[derive(Debug, Default)]
pub struct Partition {
    pub processes: Vec<ResolvedProcess>,
}

impl Partition {
    /// Which process a gear runs in, when exactly one contains it.
    ///
    /// `None` when a gear is in several, which is the overlap case and must be
    /// answered by asking about a specific pair rather than about a gear.
    #[must_use]
    pub fn sole_process(&self, gear: &GearId) -> Option<&ResolvedProcess> {
        let mut found = self.processes.iter().filter(|p| p.contains(gear));
        let first = found.next()?;
        found.next().is_none().then_some(first)
    }

    /// Whether two gears share at least one process.
    ///
    /// The question a binding actually needs: not "where does this gear live"
    /// but "will these two be in the same binary".
    #[must_use]
    pub fn share_a_process(&self, a: &GearId, b: &GearId) -> bool {
        self.processes
            .iter()
            .any(|p| p.contains(a) && p.contains(b))
    }
}

/// Everything the partition reads and never changes.
///
/// A struct rather than five parameters: they travel together through every
/// stage below, and naming the bundle is what keeps the signatures readable.
pub struct Inputs<'a> {
    pub catalogue: &'a Catalogue,
    pub closure: &'a Closure,
    pub cuts: &'a Cuts,
    pub scoped: &'a ProfileScoped<'a>,
    /// The gears the description named, as opposed to those reached from them.
    pub selected: &'a BTreeSet<GearId>,
}

/// Assign gears to processes for one profile.
pub fn partition(
    input: &Inputs<'_>,
    declaration: &DeploymentProfileDecl,
    uri: &str,
    diagnostics: &mut Diagnostics,
) -> Partition {
    let Inputs {
        catalogue,
        closure,
        cuts,
        scoped,
        ..
    } = *input;
    let mut used_names: BTreeSet<String> = BTreeSet::new();
    let mut processes = Vec::new();

    match declaration {
        DeploymentProfileDecl::Embedded { .. } => {
            report_embedded_violations(cuts, scoped, uri, diagnostics);
            // One process holding the whole product. Not the anchor's closure:
            // a selected gear that nothing depends on still has to run, and in a
            // single-process profile there is nowhere else for it to be.
            let all: Vec<GearId> = closure.members.keys().cloned().collect();
            let gears = topo_sort(catalogue, closure, &all);
            if let Some(anchor) = pick_anchor(catalogue, &gears)
                && let Some(name) = derive_name(&anchor, &used_names)
            {
                processes.push(build(
                    catalogue,
                    anchor,
                    gears,
                    ProcessKind::Host,
                    name,
                    None,
                    &mut used_names,
                ));
            }
        }
        DeploymentProfileDecl::HostWorkers { host, .. } => {
            processes = split(input, Some(host), &mut used_names);
        }
        DeploymentProfileDecl::Kubernetes { .. } => {
            processes = split(input, None, &mut used_names);
        }
    }

    report_orphans(closure, &processes, uri, diagnostics);
    Partition { processes }
}

/// A host plus one process per gear that moved out of it.
///
/// The host is not "the anchor's closure": it is everything selected, minus what
/// left. A worker leaves only if nothing remaining in the host reaches it -- and
/// when something does, the gear is in **both** binaries, which is the overlap
/// this whole design exists to represent rather than to prevent.
fn split(
    input: &Inputs<'_>,
    host_name: Option<&ProcessId>,
    used_names: &mut BTreeSet<String>,
) -> Vec<ResolvedProcess> {
    let Inputs {
        catalogue,
        closure,
        cuts,
        scoped,
        selected,
    } = *input;
    // Candidates to move out: the provider of every severable edge, plus
    // anything the description pinned to its own process.
    let mut worker_anchors: BTreeSet<GearId> = cuts
        .cuttable
        .iter()
        .map(|e| e.provider.clone())
        .chain(scoped.process_pins.iter().map(|p| p.anchor.clone()))
        .filter(|g| closure.contains(g))
        .collect();

    // The host keeps every selected gear that is not moving out, and everything
    // those reach. A worker anchor still reached from the host is in both.
    let host_seeds: Vec<GearId> = selected
        .iter()
        .filter(|g| !worker_anchors.contains(*g))
        .cloned()
        .collect();
    let host_gears = topo_sort(catalogue, closure, &host_seeds);
    worker_anchors.retain(|a| !host_gears.contains(a) || is_pinned(scoped, a));

    let mut processes = Vec::new();
    if let Some(anchor) = pick_anchor(catalogue, &host_gears) {
        let name = host_name
            .cloned()
            .or_else(|| derive_name(&anchor, used_names));
        if let Some(name) = name {
            processes.push(build(
                catalogue,
                anchor,
                host_gears,
                ProcessKind::Host,
                name,
                None,
                used_names,
            ));
        }
    }
    for anchor in &worker_anchors {
        let gears = topo_sort(catalogue, closure, std::slice::from_ref(anchor));
        let pin = scoped.process_pins.iter().find(|p| p.anchor == *anchor);
        let name = pin
            .map(|p| p.name.clone())
            .or_else(|| derive_name(anchor, used_names));
        if let Some(name) = name {
            processes.push(build(
                catalogue,
                anchor.clone(),
                gears,
                ProcessKind::Worker,
                name,
                pin.map(|p| p.replicas),
                used_names,
            ));
        }
    }
    processes
}

fn is_pinned(scoped: &ProfileScoped<'_>, gear: &GearId) -> bool {
    scoped.process_pins.iter().any(|p| p.anchor == *gear)
}

/// The gear a process is named and identified by.
///
/// The REST host when there is one, because that gear owns the composed router
/// and is what a reader calls the process. Otherwise the first gear in
/// dependency order -- arbitrary but stable, and it affects nothing but the name.
fn pick_anchor(catalogue: &Catalogue, gears: &[GearId]) -> Option<GearId> {
    gears
        .iter()
        .find(|g| has_cap(catalogue, g, RuntimeCap::RestHost))
        .or_else(|| gears.last())
        .cloned()
}

/// Complaints an embedded profile owes the operator.
///
/// Downgraded rather than refused: the product is still buildable as one
/// process, and the operator probably wants to see it.
fn report_embedded_violations(
    cuts: &Cuts,
    scoped: &ProfileScoped<'_>,
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    for pin in &scoped.process_pins {
        diagnostics.push(embedded_violation(
            &format!("`process(\"{}\")` asks for a second process", pin.name),
            uri,
        ));
        if pin.replicas > 1 {
            diagnostics.push(embedded_violation(
                &format!(
                    "`process(\"{}\", replicas = {})` asks for more than one copy",
                    pin.name, pin.replicas
                ),
                uri,
            ));
        }
    }
    if !cuts.cuttable.is_empty() {
        // Worth saying out loud: the product *has* separable edges and this
        // profile is declining to use them. Silence reads as "nothing was
        // separable", which is a different and more discouraging fact.
        diagnostics.push(embedded_violation(
            &format!(
                "{} severable edge(s) stay local because the profile is single-process",
                cuts.cuttable.len()
            ),
            uri,
        ));
    }
}

/// Build one process from its gear set.
fn build(
    catalogue: &Catalogue,
    anchor: GearId,
    gears: Vec<GearId>,
    kind: ProcessKind,
    name: ProcessId,
    replicas: Option<u32>,
    used_names: &mut BTreeSet<String>,
) -> ResolvedProcess {
    used_names.insert(name.to_string());

    ResolvedProcess {
        rest_host: gears
            .iter()
            .find(|g| has_cap(catalogue, g, RuntimeCap::RestHost))
            .cloned(),
        grpc_hub: gears
            .iter()
            .find(|g| has_cap(catalogue, g, RuntimeCap::GrpcHub))
            .cloned(),
        needs_db: gears.iter().any(|g| has_cap(catalogue, g, RuntimeCap::Db)),
        bin_name: format!("gbx-{name}"),
        crate_name: format!("gbx-{name}"),
        replicas: replicas.unwrap_or(1),
        entrypoint: Entrypoint::for_kind(kind),
        cargo_features: features(catalogue, &gears),
        gears,
        name,
        kind,
        anchor,
        listens: Vec::new(),
        spawns: Vec::new(),
        image: None,
        subchart: None,
        service_port: None,
    }
}

/// A process name derived from its anchor, or `None` if none can be.
///
/// `GearId` and `ProcessId` share `validate_kebab` (`gearbox-ir/src/ids.rs`), so
/// in practice this always succeeds. It returns an `Option` rather than asserting
/// that, because the honest consequence of an unnameable process is that the
/// process is not built -- and then its gears are unplaced, which the orphan
/// check already reports. An impossible case degrades into a diagnosed one
/// instead of a panic.
fn derive_name(anchor: &GearId, used: &BTreeSet<String>) -> Option<ProcessId> {
    ProcessId::new(unique(anchor.as_str(), used)).ok()
}

/// A name not already taken, suffixed `-2`, `-3`, ... on collision.
///
/// Bounded rather than unbounded: the loop cannot run longer than the number of
/// processes already named, and an upper limit makes that a fact of the code
/// rather than of the caller.
fn unique(base: &str, used: &BTreeSet<String>) -> String {
    if !used.contains(base) {
        return base.to_owned();
    }
    let limit = u32::try_from(used.len())
        .unwrap_or(u32::MAX)
        .saturating_add(2);
    (2u32..=limit)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| !used.contains(candidate))
        .unwrap_or_else(|| base.to_owned())
}

/// The seeds' closure in dependency order: every gear after everything it
/// depends on, which is the order the registry builds them in.
fn topo_sort(catalogue: &Catalogue, closure: &Closure, seeds: &[GearId]) -> Vec<GearId> {
    enum Step {
        Enter(GearId),
        Emit(GearId),
    }

    let mut ordered: Vec<GearId> = Vec::new();
    let mut done: BTreeSet<GearId> = BTreeSet::new();
    // Reversed so the seeds are entered in their original order once popped.
    let mut stack: Vec<Step> = seeds.iter().rev().cloned().map(Step::Enter).collect();
    let mut open: BTreeSet<GearId> = BTreeSet::new();
    while let Some(step) = stack.pop() {
        match step {
            Step::Enter(gear) => {
                if done.contains(&gear) || !open.insert(gear.clone()) {
                    continue;
                }
                stack.push(Step::Emit(gear.clone()));
                if let Some(descriptor) = catalogue.gears.get(&gear) {
                    // Reversed so the sorted order survives the stack.
                    for dep in descriptor.colocated_deps.iter().rev() {
                        if closure.contains(dep) && !done.contains(dep) {
                            stack.push(Step::Enter(dep.clone()));
                        }
                    }
                }
            }
            Step::Emit(gear) => {
                open.remove(&gear);
                if done.insert(gear.clone()) {
                    ordered.push(gear);
                }
            }
        }
    }
    ordered
}

fn has_cap(catalogue: &Catalogue, gear: &GearId, cap: RuntimeCap) -> bool {
    catalogue
        .gears
        .get(gear)
        .is_some_and(|g| g.runtime_caps.contains(&cap))
}

/// Cargo features the process needs, unioned over its gears.
fn features(catalogue: &Catalogue, gears: &[GearId]) -> BTreeSet<String> {
    gears
        .iter()
        .filter_map(|g| catalogue.gears.get(g))
        .flat_map(|g| g.package.features.iter().cloned())
        .collect()
}

/// A gear in the product that landed in no process at all.
///
/// Only possible when a gear is selected and nothing anchors a closure reaching
/// it -- which means it would be silently dropped from every binary. Reported
/// rather than tolerated: the operator asked for it.
fn report_orphans(
    closure: &Closure,
    processes: &[ResolvedProcess],
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    let placed: BTreeSet<&GearId> = processes.iter().flat_map(|p| p.gears.iter()).collect();
    for gear in closure.members.keys() {
        if !placed.contains(gear) {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::TopologyOrphanGear,
                    format!("`{gear}` is in the product but was placed in no process"),
                    "nothing anchors a co-location closure that reaches it; either something \
                     must depend on it, or it needs its own process via `process(...)`",
                )
                .at(Location::file(uri.to_owned())),
            );
        }
    }
}

fn embedded_violation(what: &str, uri: &str) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::TopologyEmbeddedViolation,
        format!("{what}, and the embedded profile is one process by definition"),
    )
    .with_help(
        "resolved as a single process anyway, so the product is still buildable; resolve for a \
         `host_workers` or `kubernetes` profile to get the topology this asks for",
    )
    .at(Location::file(uri.to_owned()))
}
