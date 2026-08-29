// The cluster graph: requirement, capability, provider.
//
// Three fixed ranks rather than a computed layering, because the ranks *are* the
// meaning. A capability nobody requires still belongs in the capability column; a
// depth-based layout would slide it into the requirement column and the drawing
// would assert something false about who asked for what.
//
// The provider shown is `ClusterResolution.effective_provider`, which for the
// compare-and-swap default is the underlying **cache**, not the primitive being
// asked about. The IR is explicit about why: "a process-local cache makes leader
// election process-local too", and that is exactly the mistake GBX0503 exists to
// report. Showing the primitive here instead would hide it.
//
// `SdkCasDefault` is labelled as the intended design, not as a fallback. Again
// from the IR: "Not a fallback in the sense of a compromise: it is the intended
// design for the primitives that have no dedicated backend, and it is engaged by
// leaving the key out of configuration."
//
// **Nothing in the demo corpus reaches this view yet.** A `ResolvedClusterBinding`
// appears only when a gear requires a primitive -- `cluster.cache`,
// `cluster.lock`, `cluster.leader_election` -- and no `gear.gdl` in the corpus
// declares one, in any profile. The product does declare a provider for the
// `event-broker` scope, so the empty state says precisely that: the provider is
// waiting for a requester. The requester arrives with `payments-audit`, the new
// gear in plan section 10, which reconciles through `LeaderElectionV1` and
// `ClusterCacheV1`.

import React from "@theia/core/shared/react";

import type { Diagnostic } from "../../../common/generated/Diagnostic";
import type { ResolvedClusterBinding } from "../../../common/generated/ResolvedClusterBinding";
import {
  NODE_H,
  NODE_W,
  elbow,
  graphSize,
  layoutRanked,
} from "../layered";

export interface ClusterViewProps {
  readonly cluster: readonly ResolvedClusterBinding[];
  readonly diagnostics: readonly Diagnostic[];
  readonly profile: string | undefined;
}

/** The codes that mean a requirement is not satisfied, rather than merely noted. */
const UNSATISFIED = new Set(["GBX0502", "GBX0503", "GBX0505", "GBX0508", "GBX0510"]);

export function ClusterView({
  cluster,
  diagnostics,
  profile,
}: ClusterViewProps): React.ReactElement {
  if (cluster.length === 0) {
    return (
      <div className="gbx-empty gbx-cluster-empty">
        This profile resolved no cluster primitives, so there is nothing to draw.
        <br />
        A primitive appears here when a gear asks for one -- <code>
          cluster.cache
        </code>, <code>cluster.lock</code> or <code>cluster.leader_election</code> in
        its <code>gear.gdl</code>. The product declares a provider for its scope, but
        no gear in the catalogue currently requires it, so the provider has nothing
        to serve. This view fills in as soon as one does.
      </div>
    );
  }

  const bad = new Set(
    diagnostics
      .filter((d) => UNSATISFIED.has(d.code) && d.severity === "error")
      .flatMap((d) => (d.subject ? [d.subject] : [])),
  );

  // Three ranks, each de-duplicated: several requirements can want the same
  // capability, and several can land on the same provider.
  const requirements = [...cluster]
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.primitive.localeCompare(b.primitive))
    .map((binding) => ({ binding, id: `${binding.scope}/${binding.primitive}` }));
  const capabilities = [
    ...new Set(requirements.flatMap((r) => r.binding.required_capabilities ?? [])),
  ].sort((a, b) => a.localeCompare(b));
  const providers = [
    ...new Set(requirements.map((r) => effectiveProvider(r.binding))),
  ].sort((a, b) => a.localeCompare(b));

  const placed = layoutRanked([
    requirements.map((r) => r.id),
    capabilities.map((c) => `cap:${c}`),
    providers.map((p) => `provider:${p}`),
  ]);
  const at = new Map(placed.map((p) => [p.id, p]));
  const { width, height } = graphSize(placed);

  const edges: { from: string; to: string; unsatisfied: boolean }[] = [];
  for (const { binding, id } of requirements) {
    const unsatisfied = bad.has(id) || bad.has(binding.scope);
    const caps = binding.required_capabilities ?? [];
    const provider = `provider:${effectiveProvider(binding)}`;
    if (caps.length === 0) {
      // No capability requirement: the requirement reaches the provider directly,
      // rather than being drawn as though it demanded nothing of it.
      edges.push({ from: id, to: provider, unsatisfied });
      continue;
    }
    for (const cap of caps) {
      edges.push({ from: id, to: `cap:${cap}`, unsatisfied });
      edges.push({ from: `cap:${cap}`, to: provider, unsatisfied });
    }
  }

  return (
    <>
      <div className="gbx-header">
        Left to right: the primitive a gear asked for, the capabilities that ask
        demands, and the provider whose capabilities decide the behaviour
        {profile ? (
          <>
            {" "}
            in profile <code>{profile}</code>
          </>
        ) : undefined}
        . For the compare-and-swap default the provider shown is the underlying
        cache, because that is what actually decides -- a process-local cache makes
        leader election process-local too.{" "}
        {bad.size === 0 ? (
          <>Every requirement here is satisfied.</>
        ) : (
          <strong>Red marks a requirement no provider satisfies.</strong>
        )}
      </div>
      <svg width={width} height={height} className="gbx-svg" data-graph="cluster">
        {edges.map((edge) => {
          const from = at.get(edge.from);
          const to = at.get(edge.to);
          if (!from || !to) return undefined;
          return (
            <path
              key={`${edge.from}:${edge.to}`}
              className={`gbx-edge ${edge.unsatisfied ? "gbx-edge-bad" : "gbx-edge-local"}`}
              d={elbow(
                from.x + NODE_W,
                from.y + NODE_H / 2,
                to.x,
                to.y + NODE_H / 2,
              )}
              markerEnd={`url(#${edge.unsatisfied ? "gbx-arrow-bad" : "gbx-arrow"})`}
              data-from={edge.from}
              data-to={edge.to}
            />
          );
        })}

        {requirements.map(({ binding, id }) => {
          const p = at.get(id);
          if (!p) return undefined;
          const unsatisfied = bad.has(id) || bad.has(binding.scope);
          return (
            <g
              key={id}
              transform={`translate(${p.x},${p.y})`}
              className={`gbx-node-g ${unsatisfied ? "gbx-node-bad" : ""}`}
              data-cluster-requirement={id}
            >
              <rect width={NODE_W} height={NODE_H} rx={4} className="gbx-node" />
              <text x={8} y={13} className="gbx-node-label">
                {binding.primitive}
              </text>
              <text x={8} y={25} className="gbx-node-sub">
                {binding.scope}
              </text>
              <title>
                {`${binding.primitive} in scope ${binding.scope}\nasked for by: ${binding.requesters.join(", ")}`}
              </title>
            </g>
          );
        })}

        {capabilities.map((cap) => {
          const p = at.get(`cap:${cap}`);
          if (!p) return undefined;
          return (
            <g
              key={cap}
              transform={`translate(${p.x},${p.y})`}
              className="gbx-node-g gbx-node-capability"
              data-cluster-capability={cap}
            >
              <rect width={NODE_W} height={NODE_H} rx={14} className="gbx-node" />
              <text x={12} y={19} className="gbx-node-label">
                {cap}
              </text>
            </g>
          );
        })}

        {providers.map((provider) => {
          const p = at.get(`provider:${provider}`);
          if (!p) return undefined;
          const viaDefault = requirements.some(
            (r) => effectiveProvider(r.binding) === provider && isSdkDefault(r.binding),
          );
          return (
            <g
              key={provider}
              transform={`translate(${p.x},${p.y})`}
              className="gbx-node-g gbx-node-provider"
              data-cluster-provider={provider}
            >
              <rect width={NODE_W} height={NODE_H} rx={4} className="gbx-node" />
              <text x={8} y={viaDefault ? 13 : 19} className="gbx-node-label">
                {provider}
              </text>
              {viaDefault && (
                <text x={8} y={25} className="gbx-node-sub">
                  via the SDK compare-and-swap design
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </>
  );
}

/**
 * The provider whose capabilities actually decide behaviour.
 *
 * Mirrors `ClusterResolution::effective_provider` in the IR rather than deciding
 * anything: the serde tag is `via`, and both variants carry the name of the thing
 * that ends up doing the work.
 */
function effectiveProvider(binding: ResolvedClusterBinding): string {
  const resolved = binding.resolved as { via: string; name?: string; over_cache?: string };
  return resolved.name ?? resolved.over_cache ?? resolved.via;
}

function isSdkDefault(binding: ResolvedClusterBinding): boolean {
  return (binding.resolved as { via: string }).via === "sdk-cas-default";
}
