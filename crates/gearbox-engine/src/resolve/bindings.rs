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
    ApplicationId, BindingMechanism, BindingMode, BindingRequest, Catalogue, ContractDescriptor,
    ContractId, DeploymentProfileDecl, Diagnostic, DiagnosticCode, Diagnostics, Discovery, GearId,
    Location, NodeKind, ResolvedBinding, ResolvedBindingMode, Selected, Transport, binding_key,
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
        let together = partition.share_an_application(&edge.consumer, &edge.provider);
        let Some(consumer_application) = application_of(partition, &edge.consumer) else {
            continue;
        };
        let Some(provider_application) = application_of(partition, &edge.provider) else {
            continue;
        };

        let binding = if together {
            local(
                edge,
                contract,
                consumer_application,
                request,
                uri,
                diagnostics,
            )
        } else {
            remote(
                edge,
                contract,
                consumer_application,
                provider_application,
                request,
                declaration,
                uri,
                diagnostics,
            )
        };
        bindings.push(binding);
    }

    report_unhonoured_endpoints(scoped, uri, diagnostics);

    bindings.sort_by(|a, b| (&a.consumer, &a.contract).cmp(&(&b.consumer, &b.contract)));
    bindings
}

/// Refuse a `bind(endpoint = ...)`, because nothing here reads it.
///
/// Over every declaration rather than only the ones that matched an edge: the
/// complaint is that the *address* does nothing, and that is true whether or
/// not the edge resolved. A person who wrote one is owed the news either way.
fn report_unhonoured_endpoints(
    scoped: &ProfileScoped<'_>,
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    for binding in &scoped.bindings {
        let Some(endpoint) = &binding.endpoint else {
            continue;
        };
        diagnostics.push(
            Diagnostic::error(
                DiagnosticCode::BindingEndpointNotHonoured,
                format!(
                    "`{}` binds `{}` with endpoint `{endpoint}`, which this build does not \
                     honour",
                    binding.consumer, binding.contract
                ),
                "remove the `endpoint` argument: the address a consumer reaches a provider at \
                 is derived from where the resolver placed them, and an address written here \
                 is read by nothing. Pointing at a provider outside the product is not \
                 expressible yet",
            )
            .at(Location::file(uri.to_owned())),
        );
    }
}

/// The process a gear runs in, preferring the one it was placed in first.
///
/// An overlapping gear is in several; the host is the answer that matters for a
/// binding, and the host is always first.
fn application_of(partition: &Partition, gear: &GearId) -> Option<ApplicationId> {
    partition
        .applications
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
    application: ApplicationId,
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
                    "`{}` asked for a remote binding of `{}`, but both gears are in application `{}`",
                    edge.consumer, edge.contract, application
                ),
            )
            .with_help(
                "the client hub finds the in-process instance and short-circuits before any \
                 endpoint is consulted, so a remote address here would be ignored rather than \
                 used; separating them needs a profile with more than one application",
            )
            .at(Location::file(uri.to_owned())),
        );
    }

    ResolvedBinding {
        consumer: edge.consumer.clone(),
        consumer_application: application.clone(),
        contract: contract.id.clone(),
        provider: edge.provider.clone(),
        provider_application: application,
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
    consumer_application: ApplicationId,
    provider_application: ApplicationId,
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
    // environment-specific. The static key is the one the runtime actually
    // reads -- `gears.{consumer}.config.consumer_wiring.{provider}` -- not a
    // contract-derived name. Two majors of one provider therefore share a
    // slot; the lock must not pretend they are independently addressable.
    let endpoint_source = match discovery {
        Discovery::Static => static_endpoint_source(&edge.consumer, &edge.provider),
        Discovery::Directory => format!("directory:{provider_application}"),
    };

    ResolvedBinding {
        consumer: edge.consumer.clone(),
        consumer_application,
        contract: contract.id.clone(),
        provider: edge.provider.clone(),
        provider_application,
        mode: ResolvedBindingMode::Remote,
        transport: Transport::Rest,
        mechanism,
        endpoint_source: Some(endpoint_source),
        endpoint: None,
        critical: edge.critical,
        selected: selection(request, downgrade),
    }
}

/// Fill `endpoint` for static discovery under Kubernetes.
///
/// Directory discovery finds the address at runtime; writing one into the lock
/// would record a guess as a decision. Static discovery under Kubernetes is
/// the opposite: the only resolver the runtime has is a pinned URI, and the
/// URI is a pure function of the process's Service DNS name. One-machine
/// static profiles still leave this empty -- their address is a local spawn
/// concern, not a cluster name.
pub fn pin_static_endpoints(
    bindings: &mut [ResolvedBinding],
    partition: &Partition,
    declaration: &DeploymentProfileDecl,
) {
    if !matches!(
        declaration,
        DeploymentProfileDecl::Kubernetes {
            discovery: Discovery::Static,
            ..
        }
    ) {
        return;
    }
    let namespace = match declaration {
        DeploymentProfileDecl::Kubernetes { namespace, .. } => {
            namespace.as_deref().unwrap_or("default")
        }
        _ => return,
    };
    for binding in bindings.iter_mut().filter(|b| b.is_remote()) {
        let Some(provider) = partition
            .applications
            .iter()
            .find(|application| application.name == binding.provider_application)
        else {
            continue;
        };
        binding.endpoint = super::partition::cluster_dns(provider, namespace);
    }
}

/// Config key the runtime reads for a static endpoint override.
///
/// `StaticEndpointResolver` looks up
/// `gears.{consumer}.config.consumer_wiring.{provider}`, keyed by the *provider
/// gear name*, not by `ContractDescriptor::wiring_key`. `PaymentApi@v1` and
/// `@v2` therefore collapse to one `consumer_wiring.api-contracts` entry.
fn static_endpoint_source(consumer: &GearId, provider: &GearId) -> String {
    format!("gears.{consumer}.config.consumer_wiring.{provider}")
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
/// in the segment immediately after the gears prefix. Nested keys are not
/// remapped, so a hyphenated *provider gear name* (`api-contracts`) can never
/// be matched by an environment variable. A single-segment name (`billing`)
/// can. The override has to be written into configuration instead -- which the
/// generator does, but an operator expecting to set it at deploy time needs
/// telling.
pub fn report_env_limits(bindings: &[ResolvedBinding], uri: &str, diagnostics: &mut Diagnostics) {
    for binding in bindings
        .iter()
        .filter(|b| b.mechanism == BindingMechanism::ConsumesStatic)
    {
        if !binding.provider.as_str().contains('-') {
            continue;
        }
        let key = static_endpoint_source(&binding.consumer, &binding.provider);
        let mut diagnostic = Diagnostic::new(
            DiagnosticCode::BindingEnvCannotExpressWiring,
            format!(
                "the endpoint override for `{}` on `{}` cannot come from an environment variable",
                binding.consumer, binding.contract
            ),
        )
        .with_help(format!(
            "the key is `{key}`, and the runtime's environment remapping converts underscores \
             to hyphens only in the segment right after the gears prefix, so a nested \
             hyphenated provider name never matches; the generator writes it into the \
             configuration file instead"
        ))
        .with_evidence("libs/toolkit/src/bootstrap/config/mod.rs:429")
        .at(Location::file(uri.to_owned()));
        // `subject` is documented as "the graph node this concerns, so a client can
        // select it", and until now nothing set it on any diagnostic --
        // `Diagnostic::about` existed with no callers at all, so Studio's Conflicts
        // screen had no node to offer an explanation for.
        //
        // This diagnostic because its subject is unambiguous: the complaint is
        // about exactly one binding, named by consumer and contract, and the
        // explanation graph holds a node for every resolved binding under the same
        // key -- `binding_key`, which is now written down once for both. Most other
        // diagnostics are about a resolution as a whole ("two severable edges stay
        // local because the profile is single-process" concerns no single node), and
        // inventing a subject for those would send a reader to a node that does not
        // explain them.
        //
        // The `if let` rather than an `about(...)` that takes an `Option`: an id
        // that cannot be constructed is not an error here, it is a diagnostic
        // without a subject, which is the ordinary case everywhere else.
        if let Some(node) = NodeKind::Binding.id_for(&binding_key(
            binding.consumer.as_str(),
            binding.contract.as_str(),
        )) {
            diagnostic = diagnostic.about(node);
        }
        diagnostics.push(diagnostic);
    }
}
