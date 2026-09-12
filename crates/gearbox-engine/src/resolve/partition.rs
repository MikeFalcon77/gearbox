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

use std::collections::{BTreeMap, BTreeSet};

use gearbox_ir::{
    ApplicationId, ApplicationKind, Catalogue, DeploymentProfileDecl, Diagnostic, DiagnosticCode,
    Diagnostics, Entrypoint, GearId, ImageRef, Location, ResolvedApplication, ResolvedEndpoint,
    RuntimeCap, SpawnSpec, WorkerServe,
};

use super::closure::Closure;
use super::cuts::Cuts;
use super::profile::ProfileScoped;

/// The processes, in a stable order.
#[derive(Debug, Default)]
pub struct Partition {
    pub applications: Vec<ResolvedApplication>,
}

impl Partition {
    /// Which process a gear runs in, when exactly one contains it.
    ///
    /// `None` when a gear is in several, which is the overlap case and must be
    /// answered by asking about a specific pair rather than about a gear.
    #[must_use]
    pub fn sole_application(&self, gear: &GearId) -> Option<&ResolvedApplication> {
        let mut found = self.applications.iter().filter(|p| p.contains(gear));
        let first = found.next()?;
        found.next().is_none().then_some(first)
    }

    /// Whether two gears share at least one process.
    ///
    /// The question a binding actually needs: not "where does this gear live"
    /// but "will these two be in the same binary".
    #[must_use]
    pub fn share_an_application(&self, a: &GearId, b: &GearId) -> bool {
        self.applications
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
    /// Gears `prefer.isolate` asked to run in their own process.
    pub isolates: &'a BTreeSet<GearId>,
}

/// Assign gears to processes for one profile.
pub fn partition(
    input: &Inputs<'_>,
    declaration: &DeploymentProfileDecl,
    product_version: &str,
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
    let mut applications = Vec::new();

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
                applications.push(build(
                    catalogue,
                    anchor,
                    gears,
                    ApplicationKind::Host,
                    name,
                    None,
                    &mut used_names,
                ));
            }
        }
        DeploymentProfileDecl::SelfHosted { host, .. } => {
            applications = split(input, Some(host), &mut used_names);
        }
        DeploymentProfileDecl::Kubernetes { .. } => {
            applications = split(input, None, &mut used_names);
        }
    }

    assign_endpoints(catalogue, declaration, &mut applications);
    assign_spawns(declaration, &mut applications, uri, diagnostics);
    assign_chart_fields(declaration, product_version, &mut applications);
    report_orphans(closure, &applications, uri, diagnostics);
    Partition { applications }
}

/// The base port a worker's own REST listener is allocated from.
///
/// Deliberately above the gears' declared defaults, so a worker's socket does
/// not sit where a gear's would and a reader can tell the two apart at a glance.
const WORKER_SERVE_BASE_PORT: u16 = 8090;

/// Give every worker a serving address, and tell the host how to start it.
///
/// **Inventing this port is not the same as inventing a gear's.**
/// [`assign_endpoints`] skips an endpoint with no `default_port` rather than
/// fabricating one, because the gear has its own default and a made-up number
/// would silently override it. A worker's listener has no such fallback: the
/// out-of-process runtime binds what `oop_http` says and advertises it to the
/// directory, so without an address here the worker serves nothing and the
/// binding the lock calls `via directory` resolves to nothing.
///
/// The two halves are one function because they are one decision: the host's
/// spawn entry and the worker's address describe the same arrangement, and
/// splitting them would let a refactor change one without the other.
fn assign_spawns(
    declaration: &DeploymentProfileDecl,
    applications: &mut [ResolvedApplication],
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    let mut taken: BTreeSet<u16> = applications
        .iter()
        .flat_map(|p| p.listens.iter())
        .filter_map(|e| e.address.rsplit_once(':').and_then(|(_, p)| p.parse().ok()))
        .collect();

    // In name order, for the same reason `assign_endpoints` is: the lock is
    // written in name order, so any other order would let a refactor that
    // changes no topology still change every port.
    let mut order: Vec<usize> = (0..applications.len()).collect();
    order.sort_by(|a, b| applications[*a].name.cmp(&applications[*b].name));

    let mut spawns: Vec<SpawnSpec> = Vec::new();
    for index in order {
        if !applications[index].is_worker() {
            continue;
        }
        let Some(port) = next_free_port(WORKER_SERVE_BASE_PORT, &taken) else {
            continue;
        };
        taken.insert(port);
        let host = bind_host(declaration);
        let address = format!("{host}:{port}");
        let loopback = allows_loopback(declaration);
        applications[index].serve = Some(WorkerServe {
            advertise_uri: format!("http://{address}"),
            listen_addr: address,
            // Kubernetes advertises a Service DNS name (rewritten in
            // `assign_chart_fields`); a one-machine profile has to say loopback
            // is allowed or the runtime refuses to start.
            allow_loopback_advertise: loopback,
        });

        // The binary by name, not by path. Where it sits is a fact about the
        // generated tree -- which target directory it was built into, and where
        // that tree is -- and the resolver knows none of that. `target_dir`
        // travels to the lock as a profile setting instead, and the generator
        // composes the path from both. `structural::check_worker_paths` still
        // reports a missing one, because without it there is nowhere to build.
        if declaration.target_dir().is_some() {
            spawns.push(SpawnSpec {
                gear: applications[index].anchor.clone(),
                bin_name: applications[index].bin_name.clone(),
                // `--config` is the only channel that works: the runtime reads
                // `TOOLKIT_CONFIG_PATH` but nothing ever sets it.
                args: vec![
                    "--config".to_owned(),
                    format!("config/{}.yaml", applications[index].name),
                ],
                working_directory: None,
                // Deliberately empty. The host injects `TOOLKIT_DIRECTORY_ENDPOINT`
                // and `TOOLKIT_MODULE_CONFIG` itself at spawn time, and the
                // endpoint is only known once its gRPC hub has bound -- recording
                // a value here would be recording a guess as a decision.
                environment: BTreeMap::new(),
            });
        }
    }

    if spawns.is_empty() {
        return;
    }
    if let Some(host) = applications
        .iter_mut()
        .find(|p| matches!(p.kind, ApplicationKind::Host))
    {
        host.spawns = spawns;
        return;
    }
    diagnostics.push(
        Diagnostic::error(
            DiagnosticCode::TopologyNoHost,
            "workers have no host application to spawn them",
            "keep a `ApplicationKind::Host` in this profile, or name the host on `self_hosted`",
        )
        .at(Location::file(uri.to_owned())),
    );
}

/// The host a generated bind address uses.
///
/// Loopback on one-machine profiles: a process that binds every interface by
/// default is a decision nobody asked for. Kubernetes is the opposite -- a
/// Service cannot deliver a packet to `127.0.0.1` inside the pod -- so the
/// address is resolved here rather than patched in a template. The lock records
/// the fact once and every generator reads it.
fn bind_host(declaration: &DeploymentProfileDecl) -> &'static str {
    if matches!(declaration, DeploymentProfileDecl::Kubernetes { .. }) {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    }
}

fn allows_loopback(declaration: &DeploymentProfileDecl) -> bool {
    !matches!(declaration, DeploymentProfileDecl::Kubernetes { .. })
}

/// Fill each process's `listens` from what its gears declare they `serve`.
///
/// Runs once over every process rather than inside `build`, because the one
/// thing that cannot be decided per process is the thing that matters: two
/// processes must not be handed the same port. A gear linked into two binaries
/// -- which co-location closures produce routinely -- would otherwise get its
/// declared default twice and the second bind would fail at run time, long
/// after the lock said everything was fine.
///
/// Endpoints with no `default_port` are skipped rather than invented. The gear
/// then falls back to whatever its own config default is, which is a worse
/// answer than a resolved one but a much better answer than a fabricated port
/// the description never mentioned.
fn assign_endpoints(
    catalogue: &Catalogue,
    declaration: &DeploymentProfileDecl,
    applications: &mut [ResolvedApplication],
) {
    let mut taken: BTreeSet<u16> = BTreeSet::new();
    let host = bind_host(declaration);
    let loopback = allows_loopback(declaration);

    // By process name, not by construction order: the lock is written in name
    // order, so assigning in any other order would let a resolver refactor that
    // does not change the topology still change every port.
    let mut order: Vec<usize> = (0..applications.len()).collect();
    order.sort_by(|a, b| applications[*a].name.cmp(&applications[*b].name));

    for index in order {
        let gears = applications[index].gears.clone();
        let mut listens = Vec::new();
        for gear in gears {
            let Some(descriptor) = catalogue.gears.get(&gear) else {
                continue;
            };
            for served in &descriptor.serves {
                if !served.binds_own_socket() {
                    continue;
                }
                let (Some(config_key), Some(default_port)) =
                    (served.config_key.as_ref(), served.default_port)
                else {
                    continue;
                };
                let Some(port) = next_free_port(default_port, &taken) else {
                    continue;
                };
                taken.insert(port);
                listens.push(ResolvedEndpoint {
                    name: served.name.clone(),
                    gear: gear.clone(),
                    config_key: config_key.clone(),
                    address: format!("{host}:{port}"),
                    advertise_uri: None,
                    allow_loopback_advertise: loopback,
                });
            }
        }
        applications[index].listens = listens;
    }
}

/// Image, subchart and service port -- only when the profile builds images.
///
/// `service_port` is a projection of `listens` / `serve`, not an independent
/// fact. A process may listen on REST and gRPC; neighbours dial REST, because
/// that is the transport a severed declared edge actually carries. The Service
/// still lists every port.
fn assign_chart_fields(
    declaration: &DeploymentProfileDecl,
    product_version: &str,
    applications: &mut [ResolvedApplication],
) {
    let DeploymentProfileDecl::Kubernetes {
        namespace,
        image_registry,
        ..
    } = declaration
    else {
        return;
    };
    let namespace = namespace.as_deref().unwrap_or("default");
    for application in applications.iter_mut() {
        application.subchart = Some(application.name.to_string());
        application.image = Some(image_ref(
            image_registry.as_deref(),
            &application.bin_name,
            product_version,
        ));
        application.service_port = contract_port(application);
        if let Some(uri) = cluster_dns(application, namespace)
            && let Some(serve) = application.serve.as_mut()
        {
            serve.advertise_uri = uri;
            serve.allow_loopback_advertise = false;
        }
    }
}

fn image_ref(registry: Option<&str>, bin_name: &str, version: &str) -> ImageRef {
    ImageRef {
        registry: registry
            .filter(|registry| !registry.is_empty())
            .map(str::to_owned),
        repository: bin_name.to_owned(),
        tag: version.to_owned(),
    }
}

/// The port neighbours dial for contract traffic: a worker's own listener, or
/// the host's REST socket rather than its gRPC one.
fn contract_port(application: &ResolvedApplication) -> Option<u16> {
    if let Some(serve) = &application.serve {
        return parse_port(&serve.listen_addr);
    }
    application
        .listens
        .iter()
        .find(|endpoint| endpoint.name == "rest")
        .or_else(|| application.listens.first())
        .and_then(|endpoint| parse_port(&endpoint.address))
}

pub(crate) fn cluster_dns(application: &ResolvedApplication, namespace: &str) -> Option<String> {
    let name = application.subchart.as_deref()?;
    let port = application.service_port?;
    Some(format!(
        "http://{name}.{namespace}.svc.cluster.local:{port}"
    ))
}

fn parse_port(address: &str) -> Option<u16> {
    address.rsplit_once(':')?.1.parse().ok()
}

/// `preferred` if it is free, else the next free port above it.
///
/// `None` when the search runs off the end of the port space, which cannot
/// happen for any realistic product but is the honest answer rather than a
/// wrap-around to a privileged port.
fn next_free_port(preferred: u16, taken: &BTreeSet<u16>) -> Option<u16> {
    (preferred..=u16::MAX).find(|port| !taken.contains(port))
}

/// A host plus one process per gear that moved out of it.
///
/// The host is not "the anchor's closure": it is everything selected, minus what
/// left. A worker leaves only if nothing remaining in the host reaches it -- and
/// when something does, the gear is in **both** binaries, which is the overlap
/// this whole design exists to represent rather than to prevent.
fn split(
    input: &Inputs<'_>,
    host_name: Option<&ApplicationId>,
    used_names: &mut BTreeSet<String>,
) -> Vec<ResolvedApplication> {
    let Inputs {
        catalogue,
        closure,
        cuts,
        scoped,
        selected,
        isolates,
    } = *input;
    // Candidates to move out: the provider of every severable edge, plus
    // anything the description pinned to its own process.
    let mut worker_anchors: BTreeSet<GearId> = cuts
        .cuttable
        .iter()
        .map(|e| e.provider.clone())
        .chain(scoped.application_pins.iter().map(|p| p.anchor.clone()))
        .chain(isolates.iter().cloned())
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
    worker_anchors.retain(|a| !host_gears.contains(a) || is_forced_out(scoped, isolates, a));

    let mut applications = Vec::new();
    if let Some(anchor) = pick_anchor(catalogue, &host_gears) {
        let name = host_name
            .cloned()
            .or_else(|| derive_name(&anchor, used_names));
        if let Some(name) = name {
            applications.push(build(
                catalogue,
                anchor,
                host_gears,
                ApplicationKind::Host,
                name,
                None,
                used_names,
            ));
        }
    }
    for anchor in &worker_anchors {
        let gears = topo_sort(catalogue, closure, std::slice::from_ref(anchor));
        let pin = scoped.application_pins.iter().find(|p| p.anchor == *anchor);
        let name = pin
            .map(|p| p.name.clone())
            .or_else(|| derive_name(anchor, used_names));
        if let Some(name) = name {
            applications.push(build(
                catalogue,
                anchor.clone(),
                gears,
                ApplicationKind::Worker,
                name,
                pin.map(|p| p.replicas),
                used_names,
            ));
        }
    }
    applications
}

fn is_forced_out(scoped: &ProfileScoped<'_>, isolates: &BTreeSet<GearId>, gear: &GearId) -> bool {
    isolates.contains(gear) || scoped.application_pins.iter().any(|p| p.anchor == *gear)
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
    for pin in &scoped.application_pins {
        diagnostics.push(embedded_violation(
            &format!(
                "`application(\"{}\")` asks for a second application",
                pin.name
            ),
            uri,
        ));
        if pin.replicas > 1 {
            diagnostics.push(embedded_violation(
                &format!(
                    "`application(\"{}\", replicas = {})` asks for more than one copy",
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
                "{} severable edge(s) stay local because the profile is single-application",
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
    kind: ApplicationKind,
    name: ApplicationId,
    replicas: Option<u32>,
    used_names: &mut BTreeSet<String>,
) -> ResolvedApplication {
    used_names.insert(name.to_string());

    ResolvedApplication {
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
        serve: None,
        image: None,
        subchart: None,
        service_port: None,
    }
}

/// A process name derived from its anchor, or `None` if none can be.
///
/// `GearId` and `ApplicationId` share `validate_kebab` (`gearbox-ir/src/ids.rs`), so
/// in practice this always succeeds. It returns an `Option` rather than asserting
/// that, because the honest consequence of an unnameable process is that the
/// process is not built -- and then its gears are unplaced, which the orphan
/// check already reports. An impossible case degrades into a diagnosed one
/// instead of a panic.
fn derive_name(anchor: &GearId, used: &BTreeSet<String>) -> Option<ApplicationId> {
    ApplicationId::new(unique(anchor.as_str(), used)).ok()
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
    applications: &[ResolvedApplication],
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    let placed: BTreeSet<&GearId> = applications.iter().flat_map(|p| p.gears.iter()).collect();
    for gear in closure.members.keys() {
        if !placed.contains(gear) {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::TopologyOrphanGear,
                    format!("`{gear}` is in the product but was placed in no application"),
                    "nothing anchors a co-location closure that reaches it; either something \
                     must depend on it, or it needs its own application via `application(...)`",
                )
                .at(Location::file(uri.to_owned())),
            );
        }
    }
}

fn embedded_violation(what: &str, uri: &str) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::TopologyEmbeddedViolation,
        format!("{what}, and the embedded profile is one application by definition"),
    )
    .with_help(
        "resolved as a single application anyway, so the product is still buildable; resolve for a \
         `self_hosted` or `kubernetes` profile to get the topology this asks for",
    )
    .at(Location::file(uri.to_owned()))
}
