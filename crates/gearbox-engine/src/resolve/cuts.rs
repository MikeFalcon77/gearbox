//! Step 3: which edges could carry a process boundary, and which could not.
//!
//! Only a **declared** contract edge is ever severable. A co-location dependency
//! is link-time and cannot be cut at all; an undeclared dependency is invisible
//! to the resolver, because a gear reaching another through a type-keyed hub
//! lookup leaves no trace in any attribute. The conservative rule follows: two
//! gears stay together unless the edge between them is declared.
//!
//! That rule would be merely restrictive if it were silent. It is not: every pair
//! the resolver *would* separate if the edge were declared is reported with the
//! literal `#[toolkit::consumes]` line that would enable it
//! (`cpt-gearbox-fr-report-cuttable-if-declared`). With most of the tree wired by
//! co-location and hub lookups, that list is the actionable path from one binary
//! toward one process per gear -- a deliverable, not an apology.

use std::collections::{BTreeMap, BTreeSet};

use gearbox_ir::{
    Catalogue, ContractDescriptor, ContractId, CutBlocker, CutCandidate, CutSavings, Diagnostic,
    DiagnosticCode, Diagnostics, GearId, Location, RelPath, RequirementKind, Transport,
};

use super::closure::Closure;

/// A declared edge that a process boundary could run through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CuttableEdge {
    pub consumer: GearId,
    pub provider: GearId,
    pub contract: ContractId,
    /// Whether the consumer declared the dependency critical, which decides
    /// whether a missing provider is fatal at startup.
    pub critical: bool,
}

/// The outcome of classifying every edge in the product.
#[derive(Debug, Default)]
pub struct Cuts {
    /// Edges a boundary may run through, sorted by `(consumer, contract)`.
    pub cuttable: Vec<CuttableEdge>,
    /// Edges it may not, with why -- and, where declaring would help, the edit.
    pub blocked: Vec<CutCandidate>,
}

/// Classify every declared contract edge, and report the undeclared pairs.
pub fn classify(
    catalogue: &Catalogue,
    closure: &Closure,
    uri: &str,
    diagnostics: &mut Diagnostics,
) -> Cuts {
    let mut cuts = Cuts::default();
    let providers = provider_index(catalogue, closure);

    for consumer in closure.members.keys() {
        let Some(descriptor) = catalogue.gears.get(consumer) else {
            continue;
        };
        for requirement in &descriptor.consumes {
            let RequirementKind::Contract { contract, from, .. } = &requirement.kind else {
                continue;
            };
            classify_declared(
                catalogue,
                &providers,
                consumer,
                contract,
                from,
                requirement.critical,
                uri,
                &mut cuts,
                diagnostics,
            );
        }
    }

    report_undeclared(catalogue, closure, &mut cuts, diagnostics, uri);

    cuts.cuttable
        .sort_by(|a, b| (&a.consumer, &a.contract).cmp(&(&b.consumer, &b.contract)));
    cuts.blocked.sort_by(|a, b| {
        (&a.consumer, &a.provider, &a.contract).cmp(&(&b.consumer, &b.provider, &b.contract))
    });
    cuts
}

/// Which gears in the closure provide which contracts.
///
/// Only gears in the closure: a provider outside the product cannot satisfy
/// anything, and treating it as if it could would turn "you did not select the
/// provider" into a silently working binding.
fn provider_index(
    catalogue: &Catalogue,
    closure: &Closure,
) -> BTreeMap<ContractId, BTreeSet<GearId>> {
    let mut index: BTreeMap<ContractId, BTreeSet<GearId>> = BTreeMap::new();
    for gear in closure.members.keys() {
        let Some(descriptor) = catalogue.gears.get(gear) else {
            continue;
        };
        for provided in &descriptor.provides {
            index
                .entry(provided.contract.clone())
                .or_default()
                .insert(gear.clone());
        }
    }
    index
}

/// The transports a provider actually wires up for one contract.
fn offered_transports(
    catalogue: &Catalogue,
    provider: &GearId,
    contract: &ContractId,
) -> BTreeSet<Transport> {
    catalogue
        .gears
        .get(provider)
        .into_iter()
        .flat_map(|g| g.provides.iter())
        .find(|p| p.contract == *contract)
        .map(|p| p.transports.clone())
        .unwrap_or_default()
}

#[expect(
    clippy::too_many_arguments,
    reason = "each argument is a distinct fact the classification needs; bundling them into a \
              struct would name the bundle after this function and explain nothing"
)]
fn classify_declared(
    catalogue: &Catalogue,
    providers: &BTreeMap<ContractId, BTreeSet<GearId>>,
    consumer: &GearId,
    contract: &ContractId,
    declared_from: &GearId,
    critical: bool,
    uri: &str,
    cuts: &mut Cuts,
    diagnostics: &mut Diagnostics,
) {
    let candidates = providers.get(contract);
    let Some(provider) = candidates.and_then(|set| set.iter().next()).cloned() else {
        // Nothing provides this exact contract. Distinguish "no provider at all"
        // from "a provider of a different major", because the remedies differ:
        // one is a missing gear, the other is an upgrade.
        if let Some(other) = other_major(catalogue, providers, contract) {
            diagnostics.push(major_mismatch(consumer, contract, &other, uri));
        } else {
            diagnostics.push(no_provider(consumer, contract, declared_from, uri));
        }
        return;
    };

    let Some(descriptor) = catalogue.contracts.get(contract) else {
        // The contract is provided but unknown to the catalogue, which the
        // catalogue load would already have reported; nothing useful to add.
        return;
    };

    // A contract whose kind is in-process only can never cross a boundary, and no
    // amount of transport configuration changes that.
    if !descriptor.remote_capable() {
        cuts.blocked.push(blocked(
            consumer,
            &provider,
            contract,
            CutBlocker::InProcessOnlyContract,
            None,
            None,
        ));
        diagnostics.push(in_process_only(consumer, &provider, descriptor, uri));
        return;
    }

    // The provider being inside the consumer's own co-location closure settles
    // it before any transport question: the runtime finds a local instance and
    // short-circuits, so a configured endpoint would have no effect at all.
    if reaches(catalogue, consumer, &provider) {
        cuts.blocked.push(blocked(
            consumer,
            &provider,
            contract,
            CutBlocker::ColocationClosure,
            None,
            None,
        ));
        diagnostics.push(forced_local(consumer, &provider, contract, uri));
        return;
    }

    let transports = offered_transports(catalogue, &provider, contract);
    if !transports.contains(&Transport::Rest) {
        // The consumption macro emits a REST resolving client and nothing else,
        // so REST is the only transport a severed declared edge can carry.
        cuts.blocked.push(blocked(
            consumer,
            &provider,
            contract,
            CutBlocker::NoRemoteTransport,
            None,
            None,
        ));
        diagnostics.push(no_remote_transport(
            consumer,
            &provider,
            contract,
            &transports,
            uri,
        ));
        return;
    }

    cuts.cuttable.push(CuttableEdge {
        consumer: consumer.clone(),
        provider,
        contract: contract.clone(),
        critical,
    });
}

/// A provider of the same contract family at a different major, if there is one.
///
/// Compatibility is exact major equality: parallel majors are a design feature of
/// the platform and there is no adapter between them, so a near miss is a
/// different error from a total absence.
fn other_major(
    catalogue: &Catalogue,
    providers: &BTreeMap<ContractId, BTreeSet<GearId>>,
    wanted: &ContractId,
) -> Option<ContractId> {
    let target = catalogue.contracts.get(wanted)?;
    providers
        .keys()
        .filter(|id| *id != wanted)
        .find(|id| {
            catalogue.contracts.get(*id).is_some_and(|other| {
                other.owner == target.owner
                    && other.base_name == target.base_name
                    && other.version.major != target.version.major
            })
        })
        .cloned()
}

/// Whether `from` reaches `to` through co-location edges.
///
/// This is per-gear reachability, not membership of the product's closure: two
/// gears can both be in the product without either reaching the other, and that
/// difference is exactly what decides whether a boundary may run between them.
fn reaches(catalogue: &Catalogue, from: &GearId, to: &GearId) -> bool {
    let mut seen: BTreeSet<&GearId> = BTreeSet::new();
    let mut stack = vec![from];
    while let Some(current) = stack.pop() {
        if !seen.insert(current) {
            continue;
        }
        let Some(descriptor) = catalogue.gears.get(current) else {
            continue;
        };
        for dep in &descriptor.colocated_deps {
            if dep == to {
                return true;
            }
            stack.push(dep);
        }
    }
    false
}

/// Report the pairs that would become severable if the edge were declared.
///
/// The condition is narrower than it first looks, and getting it wrong produces
/// either nothing or noise. The requirement is "each pair the resolver *would be
/// willing to separate* if the dependency were declared" -- so the pair must be
/// one the resolver is currently **holding together**. Two gears with no
/// relationship at all are not being held: reporting them yields a cross product
/// of every gear against every contract it does not consume, which on the demo
/// product is ten suggestions to create dependencies that do not exist.
///
/// What holds a pair together is a co-location edge. And a `deps` entry pointing
/// at a gear that *provides a contract* is the signature of an undeclared hub
/// lookup: declaring `deps` is exactly how a gear guarantees the provider is in
/// its process so that `hub.get::<dyn X>()` will find it. The resolver cannot see
/// the lookup itself -- that is what `CutBlocker::UndeclaredHubEdge` means -- but
/// it can see the arrangement that only a lookup explains.
///
/// So: a direct `deps` edge whose target provides a remote-capable contract the
/// consumer does not declare. Direct, not transitive, because the remedy is
/// removing one `deps` entry and a transitive relationship is not one entry.
fn report_undeclared(
    catalogue: &Catalogue,
    closure: &Closure,
    cuts: &mut Cuts,
    diagnostics: &mut Diagnostics,
    uri: &str,
) {
    for consumer in closure.members.keys() {
        let Some(consumer_descriptor) = catalogue.gears.get(consumer) else {
            continue;
        };
        let declared: BTreeSet<&ContractId> = consumer_descriptor
            .consumes
            .iter()
            .filter_map(|r| r.contract())
            .collect();

        for provider in &consumer_descriptor.colocated_deps {
            if !closure.contains(provider) {
                continue;
            }
            let Some(provider_descriptor) = catalogue.gears.get(provider) else {
                continue;
            };
            for provided in &provider_descriptor.provides {
                if declared.contains(&provided.contract) {
                    continue;
                }
                let Some(contract) = catalogue.contracts.get(&provided.contract) else {
                    continue;
                };
                if !contract.remote_capable() {
                    continue;
                }
                let edit = consumes_line(contract, provider);
                cuts.blocked.push(blocked(
                    consumer,
                    provider,
                    &provided.contract,
                    CutBlocker::UndeclaredHubEdge,
                    Some(edit.clone()),
                    Some(consumer_descriptor.package.path.clone()),
                ));
                diagnostics.push(cuttable_if_declared(
                    consumer,
                    provider,
                    &provided.contract,
                    &edit,
                    uri,
                ));
            }
        }
    }
}

/// The literal attribute line that would declare the edge.
fn consumes_line(contract: &ContractDescriptor, provider: &GearId) -> String {
    format!(
        "#[toolkit::consumes(contract = {}::{}, from = \"{}\")]",
        contract.sdk.lib_ident,
        contract.trait_ident(),
        provider
    )
}

fn blocked(
    consumer: &GearId,
    provider: &GearId,
    contract: &ContractId,
    blocker: CutBlocker,
    suggested_edit: Option<String>,
    file: Option<RelPath>,
) -> CutCandidate {
    CutCandidate {
        consumer: consumer.clone(),
        provider: provider.clone(),
        contract: Some(contract.clone()),
        blocked_by: blocker,
        suggested_edit,
        file,
        // Filled in by the partition step, which is the first point at which
        // "how much would this buy" has an answer.
        estimated_savings: CutSavings::default(),
    }
}

// ------------------------------------------------------------------ diagnostics

fn no_provider(consumer: &GearId, contract: &ContractId, from: &GearId, uri: &str) -> Diagnostic {
    Diagnostic::error(
        DiagnosticCode::BindingNoProvider,
        format!("`{consumer}` consumes `{contract}`, which nothing in the product provides"),
        format!(
            "the declaration names `{from}` as the provider, so either select it with \
             `use_gear(\"{from}\")` or remove the `#[toolkit::consumes]` edge"
        ),
    )
    .at(Location::file(uri.to_owned()))
}

fn major_mismatch(
    consumer: &GearId,
    wanted: &ContractId,
    available: &ContractId,
    uri: &str,
) -> Diagnostic {
    Diagnostic::error(
        DiagnosticCode::BindingMajorMismatch,
        format!("`{consumer}` consumes `{wanted}`, but the product provides `{available}`"),
        "majors are compared for exact equality: parallel majors of one contract coexist by \
         design and there is no adapter between them, so either the consumer moves to the \
         provided major or a provider of the consumed one joins the product",
    )
    .at(Location::file(uri.to_owned()))
}

fn in_process_only(
    consumer: &GearId,
    provider: &GearId,
    contract: &ContractDescriptor,
    uri: &str,
) -> Diagnostic {
    Diagnostic::error(
        DiagnosticCode::BindingInProcessOnlyContract,
        format!(
            "`{consumer}` consumes `{}` from `{provider}`, and its kind is in-process only",
            contract.id
        ),
        "only the remote-capable contract kinds may cross a process boundary; the others are \
         in-process by definition of their kind, so this pair must stay in one process",
    )
    .at(Location::file(uri.to_owned()))
}

fn forced_local(
    consumer: &GearId,
    provider: &GearId,
    contract: &ContractId,
    uri: &str,
) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::BindingForcedLocal,
        format!(
            "`{consumer}` reaches `{provider}` through co-location, so `{contract}` binds locally"
        ),
    )
    .with_help(
        "the runtime short-circuits to a local instance when one is in the process, so a \
         configured endpoint for this binding would have no effect; separating the two would \
         require removing the `deps` entry that links them, which is a source change in the gear",
    )
    .at(Location::file(uri.to_owned()))
}

fn no_remote_transport(
    consumer: &GearId,
    provider: &GearId,
    contract: &ContractId,
    offered: &BTreeSet<Transport>,
    uri: &str,
) -> Diagnostic {
    let offered = if offered.is_empty() {
        "none".to_owned()
    } else {
        offered
            .iter()
            .map(|t| t.as_str().to_owned())
            .collect::<Vec<_>>()
            .join(", ")
    };
    Diagnostic::new(
        DiagnosticCode::BindingNoRemoteTransport,
        format!(
            "`{provider}` wires up no REST transport for `{contract}`, so the edge from \
             `{consumer}` cannot be severed (offers: {offered})"
        ),
    )
    .with_help(
        "a severed declared edge is carried by the REST resolving client the consumption macro \
         emits, and there is no other path; add `rest` to the provider's \
         `#[toolkit::provides(transports = [...])]` to make the edge severable",
    )
    .at(Location::file(uri.to_owned()))
}

fn cuttable_if_declared(
    consumer: &GearId,
    provider: &GearId,
    contract: &ContractId,
    edit: &str,
    uri: &str,
) -> Diagnostic {
    Diagnostic::new(
        DiagnosticCode::BindingCuttableIfDeclared,
        format!(
            "`{consumer}` and `{provider}` could be separated if the `{contract}` edge were declared"
        ),
    )
    .with_help(format!(
        "`{consumer}` keeps `{provider}` in its process with a `deps` entry, which is how a gear \
         guarantees a type-keyed hub lookup will find it -- and that lookup leaves no trace the \
         resolver can read. Add `{edit}` beside `{consumer}`'s `#[toolkit::gear]` attribute and \
         drop `{provider}` from its `deps`, and the pair becomes severable"
    ))
    .at(Location::file(uri.to_owned()))
}
