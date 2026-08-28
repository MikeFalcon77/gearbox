//! Step 5: constraints the runtime imposes on a topology.
//!
//! Every check here mirrors something the platform actually does, and the value
//! of the step is that it says so *before* a binary is built rather than when one
//! fails to start. The two that matter most are the ones the runtime enforces
//! silently: a second REST host in a process, which the registry rejects, and a
//! REST host inside a worker, which starts happily and then never receives
//! traffic because a worker serves through its own out-of-process router.
//!
//! Directory discovery has two prerequisites that are easy to miss because
//! neither is named in the description: the directory server itself, and the gRPC
//! hub the spawn phase blocks on while waiting for its endpoint. Missing either
//! produces a host that hangs at startup, which is the least debuggable failure
//! this resolver can prevent.

use gearbox_ir::{
    Catalogue, DeploymentProfileDecl, Diagnostic, DiagnosticCode, Diagnostics, Discovery, GearId,
    ProcessKind, ResolvedProcess, RuntimeCap,
};

use super::partition::Partition;

/// The gear that answers directory lookups.
const DIRECTORY_SERVER: &str = "gear-orchestrator";
/// The gear that publishes the endpoint the spawn phase waits for.
const GRPC_HUB: &str = "grpc-hub";

/// Check the resolved topology against what the runtime will accept.
pub fn check(
    catalogue: &Catalogue,
    partition: &Partition,
    declaration: &DeploymentProfileDecl,
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    for process in &partition.processes {
        check_singletons(catalogue, process, uri, diagnostics);
        check_worker_shape(process, uri, diagnostics);
        check_rest_without_host(catalogue, process, uri, diagnostics);
    }
    check_discovery(partition, declaration, uri, diagnostics);
    check_worker_paths(partition, declaration, uri, diagnostics);
    report_spawn_gap(partition, declaration, uri, diagnostics);
}

/// At most one REST host and one gRPC hub per process.
///
/// The registry enforces both at startup, so a second one is a binary that
/// refuses to boot. Reported per process because the offending set is what a
/// reader has to act on, not the count.
fn check_singletons(
    catalogue: &Catalogue,
    process: &ResolvedProcess,
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    for (cap, code, what) in [
        (
            RuntimeCap::RestHost,
            DiagnosticCode::TopologyMultipleRestHost,
            "REST host",
        ),
        (
            RuntimeCap::GrpcHub,
            DiagnosticCode::TopologyMultipleGrpcHub,
            "gRPC hub",
        ),
    ] {
        let holders: Vec<&GearId> = process
            .gears
            .iter()
            .filter(|g| has_cap(catalogue, g, cap))
            .collect();
        if holders.len() > 1 {
            let named = holders
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            diagnostics.push(
                Diagnostic::error(
                    code,
                    format!(
                        "process `{}` contains {} {what} gears: {named}",
                        process.name,
                        holders.len()
                    ),
                    format!(
                        "the registry allows one {what} per process and refuses the rest at \
                         startup; separate them into different processes, or select only one"
                    ),
                )
                .at(Location(uri)),
            );
        }
    }
}

/// A worker must not carry a REST host.
///
/// A worker serves over the router `oop_serve` builds for it, not through the
/// composed gateway, so a REST host there registers routes nothing will call.
/// The process starts, reports healthy, and silently answers nothing -- which is
/// why this is an error rather than a warning.
fn check_worker_shape(process: &ResolvedProcess, uri: &str, diagnostics: &mut Diagnostics) {
    if process.kind != ProcessKind::Worker {
        return;
    }
    if let Some(host) = &process.rest_host {
        diagnostics.push(
            Diagnostic::error(
                DiagnosticCode::TopologyRestHostInWorker,
                format!("worker `{}` contains the REST host `{host}`", process.name),
                "a worker serves through its own out-of-process router, so routes registered \
                 with the composed gateway are never reached; keep the REST host in the host \
                 process, or pin this gear there with `process(...)`",
            )
            .at(Location(uri)),
        );
    }
}

/// A process with REST gears and no REST host has nowhere to publish them.
fn check_rest_without_host(
    catalogue: &Catalogue,
    process: &ResolvedProcess,
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    // Only meaningful for a host process: a worker publishes through `oop_serve`,
    // which needs no `rest_host` gear at all.
    if process.kind != ProcessKind::Host || process.rest_host.is_some() {
        return;
    }
    let rest_gears: Vec<&GearId> = process
        .gears
        .iter()
        .filter(|g| has_cap(catalogue, g, RuntimeCap::Rest))
        .collect();
    if rest_gears.is_empty() {
        return;
    }
    let named = rest_gears
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    diagnostics.push(
        Diagnostic::error(
            DiagnosticCode::TopologyRestWithoutHost,
            format!(
                "process `{}` has REST gears with no REST host to compose them: {named}",
                process.name
            ),
            "a `rest` gear registers its routes with the process's REST host; without one the \
             routes exist and nothing serves them, so select a gear with the `rest_host` \
             capability into this process",
        )
        .at(Location(uri)),
    );
}

/// Directory discovery needs two gears the description never names.
fn check_discovery(
    partition: &Partition,
    declaration: &DeploymentProfileDecl,
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    if declaration.discovery() != Some(Discovery::Directory) {
        return;
    }
    // Only relevant once something has actually moved out: a single process
    // resolves everything locally and never consults the directory.
    if partition.processes.len() < 2 {
        return;
    }

    let Some(host) = partition.processes.first() else {
        return;
    };
    let has = |gear: &str| GearId::new(gear).is_ok_and(|id| host.contains(&id));

    if !has(DIRECTORY_SERVER) {
        diagnostics.push(
            Diagnostic::error(
                DiagnosticCode::TopologyNoOrchestrator,
                format!(
                    "the profile discovers workers through the directory, but `{DIRECTORY_SERVER}` \
                     is not in the host process `{}`",
                    host.name
                ),
                format!(
                    "workers self-register with the directory server and consumers read it back; \
                     without it every remote binding resolves to nothing. Add \
                     `use_gear(\"{DIRECTORY_SERVER}\")`, or switch the profile to static discovery"
                ),
            )
            .at(Location(uri)),
        );
    }

    if !has(GRPC_HUB) {
        diagnostics.push(
            Diagnostic::error(
                DiagnosticCode::TopologyNoGrpcHub,
                format!(
                    "the profile discovers workers through the directory, but `{GRPC_HUB}` is not \
                     in the host process `{}`",
                    host.name
                ),
                format!(
                    "the spawn phase waits for the gRPC hub's endpoint before starting any \
                     worker, so without it the host blocks at startup rather than failing. Add \
                     `use_gear(\"{GRPC_HUB}\")`, or switch the profile to static discovery"
                ),
            )
            .at(Location(uri)),
        );
    }
}

/// A worker binary needs a path, and only `target_dir` can supply one.
fn check_worker_paths(
    partition: &Partition,
    declaration: &DeploymentProfileDecl,
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    let DeploymentProfileDecl::HostWorkers { target_dir, .. } = declaration else {
        return;
    };
    if target_dir.is_some() {
        return;
    }
    let workers: Vec<&ResolvedProcess> = partition
        .processes
        .iter()
        .filter(|p| p.is_worker())
        .collect();
    if workers.is_empty() {
        return;
    }
    let named = workers
        .iter()
        .map(|p| p.name.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    diagnostics.push(
        Diagnostic::error(
            DiagnosticCode::TopologyNoTargetDir,
            format!("the profile has no `target_dir`, so no path can be written for: {named}"),
            "the host spawns each worker by absolute executable path, which is built from the \
             Cargo target directory; add `target_dir = \"...\"` to the profile",
        )
        .at(Location(uri)),
    );
}

/// Say plainly that host-workers means one machine.
///
/// Not a defect in the product: the runtime implements exactly one spawn
/// backend, which starts local operating-system processes. Recorded so nobody
/// reads a multi-process topology as a distributed one.
fn report_spawn_gap(
    partition: &Partition,
    declaration: &DeploymentProfileDecl,
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    if !matches!(declaration, DeploymentProfileDecl::HostWorkers { .. }) {
        return;
    }
    if !partition.processes.iter().any(ResolvedProcess::is_worker) {
        return;
    }
    diagnostics.push(
        Diagnostic::new(
            DiagnosticCode::GapNoRemoteSpawnBackend,
            "workers run as local operating-system processes on the host's machine",
        )
        .with_help(
            "the runtime implements one spawn backend and it is local; this profile is \
             multi-process, not multi-machine. Use the kubernetes profile for that",
        )
        .at(Location(uri)),
    );
}

fn has_cap(catalogue: &Catalogue, gear: &GearId, cap: RuntimeCap) -> bool {
    catalogue
        .gears
        .get(gear)
        .is_some_and(|g| g.runtime_caps.contains(&cap))
}

/// Shorthand for the one location every check in this file uses.
#[expect(non_snake_case, reason = "reads as a constructor at each call site")]
fn Location(uri: &str) -> gearbox_ir::Location {
    gearbox_ir::Location::file(uri.to_owned())
}
