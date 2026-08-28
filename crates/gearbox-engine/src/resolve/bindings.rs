//! Step 6: how each declared contract edge is actually established.
//!
//! The mode is *derived from placement*, never declared. A description may ask
//! for local or remote, and the answer is whatever the topology produced -- which
//! is the only way the two can be guaranteed to agree. Asking and getting are
//! both recorded, so "you asked for gRPC and got REST" is an explanation rather
//! than a surprise.
//!
//! One asymmetry is worth stating because it looks like a bug. When consumer and
//! provider share a process the binding is local **whatever the request says**,
//! and no endpoint is written: the runtime's client hub finds the in-process
//! instance and short-circuits before any resolver is consulted. Configuring a
//! remote address there does not fail, it is simply ignored -- so writing one
//! would be writing a lie into the lock.

use gearbox_ir::{
    BindingMechanism, BindingMode, BindingRequest, Catalogue, ContractDescriptor, ContractId,
    DeploymentProfileDecl, Diagnostic, DiagnosticCode, Diagnostics, Discovery, GearId, Location,
    ProcessId, ResolvedBinding, ResolvedBindingMode, Selected, Transport,
};

use super::cuts::Cuts;
use super::partition::Partition;
use super::profile::ProfileScoped;

/// Derive a binding for every severable edge, plus the forced-local ones.
pub fn derive(
    catalogue: &Catalogue,
    cuts: &Cuts,
    partition: &Partition,
    scoped: &ProfileScoped<'_>,
    declaration: &DeploymentProfileDecl,
    uri: &str,
    diagnostics: &mut Diagnostics,
) -> Vec<ResolvedBinding> {
    let mut bindings = Vec::new();

    for edge in &cuts.cuttable {
        let Some(contract) = catalogue.contracts.get(&edge.contract) else {
            continue;
        };
        let request = requested(scoped, &edge.consumer, &edge.contract);

        // Placement decides the mode. Both being in one process is not a
        // preference the resolver expressed; it is where they ended up.
        let together = partition.share_a_process(&edge.consumer, &edge.provider);
        let Some(consumer_process) = process_of(partition, &edge.consumer) else {
            continue;
        };
        let Some(provider_process) = process_of(partition, &edge.provider) else {
            continue;
        };

        let binding = if together {
            local(edge, contract, consumer_process, request, uri, diagnostics)
        } else {
            remote(
                edge,
                contract,
                consumer_process,
                provider_process,
                request,
                declaration,
                uri,
                diagnostics,
            )
        };
        bindings.push(binding);
    }

    bindings.sort_by(|a, b| (&a.consumer, &a.contract).cmp(&(&b.consumer, &b.contract)));
    bindings
}

/// The process a gear runs in, preferring the one it was placed in first.
///
/// An overlapping gear is in several; the host is the answer that matters for a
/// binding, and the host is always first.
fn process_of(partition: &Partition, gear: &GearId) -> Option<ProcessId> {
    partition
        .processes
        .iter()
        .find(|p| p.contains(gear))
        .map(|p| p.name.clone())
}

/// What the description asked for about this edge, if anything.
fn requested(
    scoped: &ProfileScoped<'_>,
    consumer: &GearId,
    contract: &ContractId,
) -> Option<BindingRequest> {
    scoped
        .bindings
        .iter()
        .find(|b| b.consumer == *consumer && b.contract == *contract)
        .map(|b| BindingRequest {
            mode: b.mode,
            transport: b.transport,
        })
}

/// Consumer and provider share a binary.
fn local(
    edge: &super::cuts::CuttableEdge,
    contract: &ContractDescriptor,
    process: ProcessId,
    request: Option<BindingRequest>,
    uri: &str,
    diagnostics: &mut Diagnostics,
) -> ResolvedBinding {
    // A request to separate them that placement did not honour. Recorded on the
    // binding *and* reported, because the lock alone would show a local binding
    // with no hint that anyone wanted otherwise.
    let downgraded = request.is_some_and(|r| r.mode == BindingMode::Remote);
    if downgraded {
        diagnostics.push(
            Diagnostic::new(
                DiagnosticCode::BindingForcedLocal,
                format!(
                    "`{}` asked for a remote binding of `{}`, but both gears are in process `{}`",
                    edge.consumer, edge.contract, process
                ),
            )
            .with_help(
                "the client hub finds the in-process instance and short-circuits before any \
                 endpoint is consulted, so a remote address here would be ignored rather than \
                 used; separating them needs a profile with more than one process",
            )
            .at(Location::file(uri.to_owned())),
        );
    }

    ResolvedBinding {
        consumer: edge.consumer.clone(),
        consumer_process: process.clone(),
        contract: contract.id.clone(),
        provider: edge.provider.clone(),
        provider_process: process,
        mode: ResolvedBindingMode::Local,
        transport: Transport::Local,
        mechanism: BindingMechanism::colocated(),
        // Deliberately absent, not empty: there is no endpoint, and writing one
        // would record a value the runtime never reads.
        endpoint_source: None,
        endpoint: None,
        critical: edge.critical,
        selected: selection(
            request,
            downgraded.then_some(DiagnosticCode::BindingForcedLocal),
        ),
    }
}

/// Consumer and provider are in different binaries.
#[expect(
    clippy::too_many_arguments,
    reason = "each is a distinct fact the binding records; a bundle would be named after this \
              function and explain nothing"
)]
fn remote(
    edge: &super::cuts::CuttableEdge,
    contract: &ContractDescriptor,
    consumer_process: ProcessId,
    provider_process: ProcessId,
    request: Option<BindingRequest>,
    declaration: &DeploymentProfileDecl,
    uri: &str,
    diagnostics: &mut Diagnostics,
) -> ResolvedBinding {
    // REST is the only transport a severed declared edge can carry: the
    // consumption macro emits a REST resolving client and there is no other path.
    // Cross-process gRPC exists in the runtime, but only through hand-written
    // wiring the generator does not produce.
    let mut downgrade = None;
    if request.and_then(|r| r.transport) == Some(Transport::Grpc) {
        downgrade = Some(DiagnosticCode::BindingGrpcUnsupported);
        diagnostics.push(
            Diagnostic::new(
                DiagnosticCode::BindingGrpcUnsupported,
                format!(
                    "`{}` asked for gRPC on `{}`, which crosses a process boundary; using REST",
                    edge.consumer, edge.contract
                ),
            )
            .with_help(
                "`#[toolkit::consumes]` emits a REST resolving client and nothing else, so a \
                 severed edge has no gRPC path; the gRPC that exists in the runtime is \
                 hand-written wiring the generator does not produce",
            )
            .at(Location::file(uri.to_owned())),
        );
    }

    let discovery = declaration.discovery().unwrap_or(Discovery::Static);
    let mechanism = BindingMechanism::for_discovery(discovery);
    // Where the address comes from, named rather than resolved: the value itself
    // is a deployment concern, and pinning it here would make the lock
    // environment-specific.
    let endpoint_source = match discovery {
        Discovery::Static => format!(
            "gears.{}.consumer_wiring.{}",
            edge.consumer,
            contract.wiring_key()
        ),
        Discovery::Directory => format!("directory:{provider_process}"),
    };

    ResolvedBinding {
        consumer: edge.consumer.clone(),
        consumer_process,
        contract: contract.id.clone(),
        provider: edge.provider.clone(),
        provider_process,
        mode: ResolvedBindingMode::Remote,
        transport: Transport::Rest,
        mechanism,
        endpoint_source: Some(endpoint_source),
        endpoint: None,
        critical: edge.critical,
        selected: selection(request, downgrade),
    }
}

fn selection(
    request: Option<BindingRequest>,
    downgraded_by: Option<DiagnosticCode>,
) -> Selected<BindingRequest> {
    request.map_or_else(Selected::auto, |value| match downgraded_by {
        Some(code) => Selected::downgraded(value, code),
        None => Selected::honoured(value),
    })
}

/// Report a static endpoint override the environment cannot express.
///
/// The runtime's environment-key remapping turns underscores into hyphens only
/// in the segment immediately after the gears prefix, so a hyphenated dependency
/// name nested deeper can never be matched by an environment variable. The
/// override has to be written into configuration instead -- which the generator
/// does, but an operator expecting to set it at deploy time needs telling.
pub fn report_env_limits(
    catalogue: &Catalogue,
    bindings: &[ResolvedBinding],
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    for binding in bindings
        .iter()
        .filter(|b| b.mechanism == BindingMechanism::ConsumesStatic)
    {
        let Some(contract) = catalogue.contracts.get(&binding.contract) else {
            continue;
        };
        let key = contract.wiring_key();
        if !key.contains('_') {
            continue;
        }
        diagnostics.push(
            Diagnostic::new(
                DiagnosticCode::BindingEnvCannotExpressWiring,
                format!(
                    "the endpoint override for `{}` on `{}` cannot come from an environment \
                     variable",
                    binding.consumer, binding.contract
                ),
            )
            .with_help(format!(
                "the key is `consumer_wiring.{key}`, and the runtime's environment remapping \
                 converts underscores to hyphens only in the segment right after the gears \
                 prefix, so a nested key with an underscore never matches; the generator writes \
                 it into the configuration file instead"
            ))
            .at(Location::file(uri.to_owned())),
        );
    }
}
