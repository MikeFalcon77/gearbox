//! Step 7: which backend answers each cluster primitive.
//!
//! The provider table is **projected** from the `with_*_provider` calls in the
//! cluster gear's registry, not declared anywhere, so a provider added in Rust
//! cannot go missing here and one removed cannot linger. Today that table holds
//! exactly two entries, and the shape of what they offer decides most of this
//! step:
//!
//! * `postgres` answers cache and lock, is linearizable for both, is not
//!   process-local, and needs credentials;
//! * `standalone` answers cache only, adds prefix-watch, is process-local, and
//!   needs none.
//!
//! **Neither registers leader election.** That is not an omission in this code:
//! zero leader-election providers exist in the runtime, so the primitive always
//! resolves to the SDK's compare-and-swap default layered over whatever cache is
//! bound. Reported rather than hidden, because "leader election works" and
//! "leader election is CAS over your cache" are different promises.
//!
//! The most valuable rule here is the last one. A process-local backend in a
//! topology with more than one process is a correctness bug the runtime would
//! start happily and never complain about: `standalone`'s cache lives in one
//! process's memory, so leader election over it elects a leader *per replica*.

use std::collections::{BTreeMap, BTreeSet};

use gearbox_ir::{
    CapabilityId, Catalogue, Choice, ClusterPrimitive, ClusterProviderDecl, ClusterResolution,
    Diagnostic, DiagnosticCode, Diagnostics, GearId, Location, Preference, ProviderBinding,
    RequirementKind, ResolvedClusterBinding, Selected,
};

use super::closure::Closure;
use super::partition::Partition;
use super::profile::ProfileScoped;

/// One primitive that something in the product needs.
#[derive(Debug, Default)]
struct Need {
    requesters: BTreeSet<GearId>,
    capabilities: BTreeSet<CapabilityId>,
}

/// Resolve every cluster primitive the product asks for.
pub fn resolve(
    catalogue: &Catalogue,
    closure: &Closure,
    partition: &Partition,
    scoped: &ProfileScoped<'_>,
    preferences: &[Preference],
    uri: &str,
    diagnostics: &mut Diagnostics,
) -> Vec<ResolvedClusterBinding> {
    let needs = collect_needs(catalogue, closure);
    if needs.is_empty() {
        return Vec::new();
    }

    let providers = provider_table(catalogue, closure);
    let spread = is_spread(partition);
    let prefer_existing = preferences.contains(&Preference::ExistingInfrastructure);

    let mut out: Vec<ResolvedClusterBinding> = Vec::new();
    for ((scope, primitive), need) in needs {
        // Within a scope, the cache is decided first: leader election and lock
        // both fall back to a default layered over it, and `existing
        // infrastructure` prefers whatever the scope already uses.
        let already: BTreeSet<String> = out
            .iter()
            .filter(|b| b.scope == scope)
            .map(|b| b.resolved.effective_provider().to_owned())
            .filter(|name| !name.is_empty())
            .collect();

        let declared = scoped
            .cluster_scopes
            .iter()
            .find(|s| s.scope == scope)
            .and_then(|s| s.binding(primitive));

        let binding = decide(
            &Context {
                scope: &scope,
                primitive,
                need: &need,
                providers: &providers,
                already: &already,
                spread,
                prefer_existing,
                uri,
            },
            declared,
            diagnostics,
        );
        out.push(binding);
    }

    out.sort_by(|a, b| (&a.scope, a.primitive).cmp(&(&b.scope, b.primitive)));
    out
}

/// Everything one decision needs, so the signature stays readable.
struct Context<'a> {
    scope: &'a str,
    primitive: ClusterPrimitive,
    need: &'a Need,
    providers: &'a [ClusterProviderDecl],
    /// Providers already chosen elsewhere in this scope.
    already: &'a BTreeSet<String>,
    /// Whether the topology has more than one process or any replication.
    spread: bool,
    prefer_existing: bool,
    uri: &'a str,
}

/// Group the closure's cluster requirements by scope and primitive.
fn collect_needs(
    catalogue: &Catalogue,
    closure: &Closure,
) -> BTreeMap<(String, ClusterPrimitive), Need> {
    let mut needs: BTreeMap<(String, ClusterPrimitive), Need> = BTreeMap::new();
    for gear in closure.members.keys() {
        let Some(descriptor) = catalogue.gears.get(gear) else {
            continue;
        };
        for requirement in &descriptor.requires {
            let RequirementKind::Cluster { primitive, scope } = &requirement.kind else {
                continue;
            };
            let entry = needs.entry((scope.clone(), *primitive)).or_default();
            entry.requesters.insert(gear.clone());
            // Unioned: two gears sharing a scope both get what they asked for,
            // and a provider must satisfy the union or satisfy neither.
            entry
                .capabilities
                .extend(requirement.capabilities.iter().cloned());
        }
    }
    needs
}

/// The providers registered by gears in the product.
fn provider_table(catalogue: &Catalogue, closure: &Closure) -> Vec<ClusterProviderDecl> {
    let mut table: Vec<ClusterProviderDecl> = closure
        .members
        .keys()
        .filter_map(|g| catalogue.gears.get(g))
        .flat_map(|g| g.cluster_providers.iter().cloned())
        .collect();
    table.sort_by(|a, b| a.name.cmp(&b.name));
    table.dedup_by(|a, b| a.name == b.name);
    table
}

/// Whether the topology can put two things in different memory.
fn is_spread(partition: &Partition) -> bool {
    partition.processes.len() > 1
        || partition
            .processes
            .iter()
            .any(gearbox_ir::ResolvedProcess::is_replicated)
}

fn decide(
    ctx: &Context<'_>,
    declared: Option<&ProviderBinding>,
    diagnostics: &mut Diagnostics,
) -> ResolvedClusterBinding {
    let candidates: Vec<&ClusterProviderDecl> = ctx
        .providers
        .iter()
        .filter(|p| p.satisfies(ctx.primitive, &ctx.need.capabilities))
        .collect();

    let (resolved, selected) = match declared {
        Some(request) => explicit(ctx, request, &candidates, diagnostics),
        None => automatic(ctx, &candidates, diagnostics),
    };

    guard_process_local(ctx, &resolved, diagnostics);
    check_credentials(ctx, &resolved, declared, diagnostics);

    ResolvedClusterBinding {
        scope: ctx.scope.to_owned(),
        primitive: ctx.primitive,
        required_capabilities: ctx.need.capabilities.clone(),
        requesters: ctx.need.requesters.iter().cloned().collect(),
        selected,
        resolved,
        options: declared.map(|d| d.options.clone()).unwrap_or_default(),
        secret_ref: declared.and_then(|d| d.secret_ref.clone()),
    }
}

/// The description named a provider.
fn explicit(
    ctx: &Context<'_>,
    request: &ProviderBinding,
    candidates: &[&ClusterProviderDecl],
    diagnostics: &mut Diagnostics,
) -> (ClusterResolution, Selected<String>) {
    let registered = ctx.providers.iter().any(|p| p.name == request.provider);
    let selected = if !registered {
        diagnostics.push(
            Diagnostic::error(
                DiagnosticCode::ClusterUnregisteredProvider,
                format!(
                    "scope `{}` asks for the `{}` provider, which the runtime does not register",
                    ctx.scope, request.provider
                ),
                format!("registered providers are: {}", names(ctx.providers)),
            )
            .at(loc(ctx.uri)),
        );
        Selected::downgraded(
            request.provider.clone(),
            DiagnosticCode::ClusterUnregisteredProvider,
        )
    } else if !candidates.iter().any(|p| p.name == request.provider) {
        diagnostics.push(unsatisfiable(ctx, Some(&request.provider)));
        Selected::downgraded(
            request.provider.clone(),
            DiagnosticCode::ClusterUnsatisfiable,
        )
    } else {
        Selected::honoured(request.provider.clone())
    };

    (
        ClusterResolution::Provider {
            name: request.provider.clone(),
        },
        selected,
    )
}

/// Nothing was named, so the resolver ranks.
fn automatic(
    ctx: &Context<'_>,
    candidates: &[&ClusterProviderDecl],
    diagnostics: &mut Diagnostics,
) -> (ClusterResolution, Selected<String>) {
    if let Some(chosen) = rank(ctx, candidates) {
        diagnostics.push(
            Diagnostic::new(
                DiagnosticCode::ClusterAutoSelected,
                format!(
                    "`{}` answers `{}` in scope `{}`",
                    chosen.name,
                    ctx.primitive.config_key(),
                    ctx.scope
                ),
            )
            .with_help(format!(
                "nothing named a provider, so one was ranked: {}. Name one with \
                 `cluster_profile(..., {} = provider(\"...\"))` to fix the choice",
                why(ctx, candidates),
                ctx.primitive.config_key()
            ))
            .at(loc(ctx.uri)),
        );
        return (
            ClusterResolution::Provider {
                name: chosen.name.clone(),
            },
            Selected::auto(),
        );
    }

    // Nothing satisfies the primitive directly. For leader election and lock the
    // SDK layers a compare-and-swap implementation over the bound cache -- which
    // for leader election is always the answer, since no provider registers it.
    if ctx.primitive != ClusterPrimitive::Cache
        && let Some(cache) = ctx.already.iter().next()
    {
        diagnostics.push(
            Diagnostic::new(
                DiagnosticCode::ClusterSdkDefault,
                format!(
                    "`{}` in scope `{}` resolves to the SDK's compare-and-swap default over the \
                     `{cache}` cache",
                    ctx.primitive.config_key(),
                    ctx.scope
                ),
            )
            .with_help(
                "no registered provider implements this primitive, so the SDK builds it from \
                 the cache's atomic operations; its guarantees are the cache's guarantees, \
                 which is a weaker promise than a purpose-built backend",
            )
            .at(loc(ctx.uri)),
        );
        return (
            ClusterResolution::SdkCasDefault {
                over_cache: cache.clone(),
            },
            Selected::auto(),
        );
    }

    diagnostics.push(unsatisfiable(ctx, None));
    (ClusterResolution::Unsatisfied, Selected::auto())
}

/// Deterministic ranking. No scoring, no search.
fn rank<'a>(
    ctx: &Context<'_>,
    candidates: &[&'a ClusterProviderDecl],
) -> Option<&'a ClusterProviderDecl> {
    let mut ordered: Vec<&ClusterProviderDecl> = candidates.to_vec();
    ordered.sort_by(|a, b| {
        // (a) something already in use in this scope, when asked for;
        let a_existing = ctx.prefer_existing && ctx.already.contains(&a.name);
        let b_existing = ctx.prefer_existing && ctx.already.contains(&b.name);
        // (b) a backend that survives being spread, when the topology spreads;
        let a_spreadable = !ctx.spread || !a.process_local;
        let b_spreadable = !ctx.spread || !b.process_local;
        b_existing
            .cmp(&a_existing)
            .then_with(|| b_spreadable.cmp(&a_spreadable))
            // (c) and finally the name, so the answer never depends on order.
            .then_with(|| a.name.cmp(&b.name))
    });
    ordered.first().copied()
}

/// The ranking, spelled out for the diagnostic.
fn why(ctx: &Context<'_>, candidates: &[&ClusterProviderDecl]) -> String {
    let names = candidates
        .iter()
        .map(|p| p.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let mut reasons = vec![format!("candidates were {names}")];
    if ctx.prefer_existing && !ctx.already.is_empty() {
        reasons
            .push("`prefer.existing_infrastructure` favoured what the scope already uses".into());
    }
    if ctx.spread {
        reasons.push(
            "the topology has more than one process, so a process-local backend ranked last".into(),
        );
    }
    reasons.push("ties broke on the name".into());
    reasons.join("; ")
}

/// Nothing can answer this. Show the per-provider comparison.
fn unsatisfiable(ctx: &Context<'_>, named: Option<&str>) -> Diagnostic {
    let required = ctx
        .need
        .capabilities
        .iter()
        .map(|c| c.as_str().to_owned())
        .collect::<Vec<_>>()
        .join(", ");
    let mut rows = Vec::new();
    for provider in ctx.providers {
        if !provider.primitives.contains(&ctx.primitive) {
            rows.push(format!(
                "  {}: does not answer {}",
                provider.name,
                ctx.primitive.config_key()
            ));
            continue;
        }
        let have = provider.capabilities_for(ctx.primitive);
        let missing: Vec<&str> = ctx
            .need
            .capabilities
            .iter()
            .filter(|c| !have.contains(*c))
            .map(CapabilityId::as_str)
            .collect();
        rows.push(if missing.is_empty() {
            format!("  {}: satisfies all of them", provider.name)
        } else {
            format!("  {}: missing {}", provider.name, missing.join(", "))
        });
    }

    let subject = named.map_or_else(
        || {
            format!(
                "no registered provider answers `{}`",
                ctx.primitive.config_key()
            )
        },
        |name| {
            format!(
                "the requested provider `{name}` cannot answer `{}`",
                ctx.primitive.config_key()
            )
        },
    );
    Diagnostic::error(
        DiagnosticCode::ClusterUnsatisfiable,
        format!("{subject} in scope `{}` with {{{required}}}", ctx.scope),
        format!("per provider:\n{}", rows.join("\n")),
    )
    .at(loc(ctx.uri))
}

/// The rule that catches a silent correctness bug.
fn guard_process_local(
    ctx: &Context<'_>,
    resolved: &ClusterResolution,
    diagnostics: &mut Diagnostics,
) {
    if !ctx.spread {
        return;
    }
    let effective = resolved.effective_provider();
    let Some(provider) = ctx.providers.iter().find(|p| p.name == effective) else {
        return;
    };
    if !provider.process_local {
        return;
    }
    diagnostics.push(
        Diagnostic::error(
            DiagnosticCode::ClusterProcessLocalInMultiProcess,
            format!(
                "`{effective}` answers `{}` in scope `{}`, and its state lives inside one process",
                ctx.primitive.config_key(),
                ctx.scope
            ),
            "the topology has more than one process or a replicated one, so each copy gets its \
             own state: a lock locks nothing across processes, and leader election over such a \
             cache elects a leader per replica. The runtime starts this without complaint. \
             Choose a backend that is not process-local, or keep the requesters in one \
             unreplicated process",
        )
        .at(loc(ctx.uri)),
    );
}

/// A provider that needs credentials must be told where they are.
fn check_credentials(
    ctx: &Context<'_>,
    resolved: &ClusterResolution,
    declared: Option<&ProviderBinding>,
    diagnostics: &mut Diagnostics,
) {
    let effective = resolved.effective_provider();
    let Some(provider) = ctx.providers.iter().find(|p| p.name == effective) else {
        return;
    };
    if !provider.needs_credentials || declared.is_some_and(|d| d.secret_ref.is_some()) {
        return;
    }
    diagnostics.push(
        Diagnostic::error(
            DiagnosticCode::ClusterNoCredentialSource,
            format!(
                "`{effective}` needs credentials, and scope `{}` names no source for them",
                ctx.scope
            ),
            "add `secret_ref = \"...\"` to the provider; the reference is written into the \
             generated configuration, and the credential itself never enters the lock or any \
             values file",
        )
        .at(loc(ctx.uri)),
    );
}

fn names(providers: &[ClusterProviderDecl]) -> String {
    if providers.is_empty() {
        return "none -- the product contains no gear that registers any".to_owned();
    }
    providers
        .iter()
        .map(|p| p.name.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn loc(uri: &str) -> Location {
    Location::file(uri.to_owned())
}

/// Report a replicated stateful gear with no leader election in its scope.
///
/// Step 8, kept here because it reads the same bindings. Two copies of a
/// stateful gear both doing the work is not something the runtime notices.
pub fn report_stateful_replicas(
    catalogue: &Catalogue,
    partition: &Partition,
    bindings: &[ResolvedClusterBinding],
    uri: &str,
    diagnostics: &mut Diagnostics,
) {
    let elected: bool = bindings
        .iter()
        .any(|b| b.primitive == ClusterPrimitive::LeaderElection);
    if elected {
        return;
    }
    for process in partition.processes.iter().filter(|p| p.is_replicated()) {
        let stateful: Vec<&GearId> = process
            .gears
            .iter()
            .filter(|g| {
                catalogue
                    .gears
                    .get(*g)
                    .is_some_and(|d| d.runtime_caps.contains(&gearbox_ir::RuntimeCap::Stateful))
            })
            .collect();
        if stateful.is_empty() {
            continue;
        }
        let named = stateful
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        diagnostics.push(
            Diagnostic::new(
                DiagnosticCode::ClusterStatefulReplicasWithoutElection,
                format!(
                    "process `{}` runs {} copies of stateful gears with no leader election: \
                     {named}",
                    process.name, process.replicas
                ),
            )
            .with_help(
                "every copy will do the work: a reconciliation loop runs N times, a scheduled \
                 job fires N times. Add a `leader_election` binding to the gear's cluster \
                 scope, or run one replica",
            )
            .at(loc(uri)),
        );
    }
}

/// Whether a selection was honoured, for the explanation graph.
#[must_use]
pub fn was_requested(binding: &ResolvedClusterBinding) -> bool {
    matches!(binding.selected.selected, Choice::Explicit { .. })
}
