// The co-location graph: what pulls what into the same process.
//
// This is the view that makes the project's most consequential finding visible.
// `deps` edges are link-time -- the gear macro emits a hidden re-export per
// entry, and the registry treats a missing one as a hard failure -- so they can
// never be severed. The set of gears reachable from a process entry point is a
// *closure*, not a partition, and processes therefore overlap. Clicking a node
// paints exactly that closure, because a picture of "these three go together"
// is what the fact means in practice.
//
// Layout is a hand-rolled layered assignment rather than elkjs. The plan reached
// for elkjs to get determinism; computing layers ourselves is deterministic by
// construction, needs no async layout pass, and this graph is a shallow DAG of a
// few dozen nodes. If it grows a cycle or a hundred nodes, elkjs is the answer.

import { ReactWidget } from "@theia/core/lib/browser";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
// The shim is `export = React`, so a namespace import is rejected under
// esModuleInterop; a default import is the form that works.
import React from "@theia/core/shared/react";

import type { GearDescriptor } from "../../common/generated/GearDescriptor";
import { CatalogueStore } from "../catalogue-store";

const NODE_W = 168;
const NODE_H = 30;
const GAP_X = 74;
const GAP_Y = 16;
const MARGIN = 12;
/** Space between the connected graph and the band of unconnected gears. */
const BAND_GAP = 46;

interface Placed {
  readonly gear: GearDescriptor;
  readonly x: number;
  readonly y: number;
  /** True for a gear with no co-location edge in either direction. */
  readonly isolated: boolean;
}

interface Edge {
  readonly from: string;
  readonly to: string;
}

@injectable()
export class DepsGraphWidget extends ReactWidget {
  static readonly ID = "gearbox.graph.deps";
  static readonly LABEL = "Gearbox Graph (co-location)";

  @inject(CatalogueStore) protected readonly store!: CatalogueStore;

  /** The gear whose closure is painted, if any. */
  protected focus: string | undefined;

  @postConstruct()
  protected init(): void {
    this.id = DepsGraphWidget.ID;
    this.title.label = DepsGraphWidget.LABEL;
    this.title.closable = true;
    this.addClass("gearbox-graph");
    this.toDispose.push(this.store.onChanged(() => this.update()));
    this.update();
  }

  protected render(): React.ReactNode {
    const gears = this.store.current.rows
      .filter((r) => r.kind === "projected")
      .map((r) => (r as { gear: GearDescriptor }).gear);

    if (gears.length === 0) {
      return (
        <div className="gbx-empty">
          Co-location edges come from <code>#[toolkit::gear(deps = [...])]</code>,
          so they appear as gears finish projecting.
        </div>
      );
    }

    const { placed, edges } = layout(gears);
    const byId = new Map(placed.map((p) => [p.gear.id, p]));
    const closure = this.focus ? closureOf(this.focus, edges) : undefined;
    const width = Math.max(...placed.map((p) => p.x + NODE_W)) + MARGIN;
    const height = Math.max(...placed.map((p) => p.y + NODE_H)) + MARGIN;
    const isolatedCount = placed.filter((p) => p.isolated).length;

    return (
      <div className="gbx-root">
        <div className="gbx-header">
          An arrow is <strong>link-time</strong> co-location: the resolver can never
          sever it, so every process reaching a gear contains everything the arrows
          lead to. Click a gear to paint its closure -- that is the set no process
          boundary can split.
          {isolatedCount > 0 && (
            <>
              {" "}
              {isolatedCount} gears below the rule have no co-location at all, so
              each one can stand alone in a process.
            </>
          )}
        </div>
        <svg width={width} height={height} className="gbx-svg">
          <defs>
            <marker
              id="gbx-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 7 4 L 0 7 z" className="gbx-arrow-head" />
            </marker>
            <marker
              id="gbx-arrow-lit"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 7 4 L 0 7 z" className="gbx-arrow-head-lit" />
            </marker>
          </defs>

          {/* The rule that separates the connected graph from the isolated band,
              drawn only when there is something on both sides of it. */}
          {isolatedCount > 0 && isolatedCount < placed.length && (
            <line
              className="gbx-band-rule"
              x1={MARGIN}
              y1={bandRuleY(placed)}
              x2={width - MARGIN}
              y2={bandRuleY(placed)}
            />
          )}

          {edges.map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return undefined;
            // From the right edge of the dependant to the left edge of the
            // dependency, never through a box: the arrowhead has to be visible,
            // and relying on opaque rects drawn afterwards to hide the overlap
            // is the sort of thing that breaks the first time a fill changes.
            const lit = closure?.has(edge.from) === true && closure.has(edge.to);
            return (
              <path
                key={`${edge.from}->${edge.to}`}
                className={`gbx-edge ${lit ? "gbx-edge-lit" : closure ? "gbx-edge-dim" : ""}`}
                d={elbow(
                  from.x + NODE_W,
                  from.y + NODE_H / 2,
                  to.x,
                  to.y + NODE_H / 2,
                )}
                markerEnd={`url(#${lit ? "gbx-arrow-lit" : "gbx-arrow"})`}
                data-from={edge.from}
                data-to={edge.to}
              />
            );
          })}

          {placed.map((p) => {
            const state = closure
              ? closure.has(p.gear.id)
                ? p.gear.id === this.focus
                  ? "gbx-node-focus"
                  : "gbx-node-lit"
                : "gbx-node-dim"
              : "";
            return (
              <g
                key={p.gear.id}
                transform={`translate(${p.x},${p.y})`}
                className={`gbx-node-g ${state}`}
                data-gear={p.gear.id}
                data-isolated={p.isolated ? "true" : "false"}
                onClick={() => {
                  this.focus = this.focus === p.gear.id ? undefined : p.gear.id;
                  this.update();
                }}
              >
                <rect width={NODE_W} height={NODE_H} rx={4} className="gbx-node" />
                <text x={8} y={19} className="gbx-node-label">
                  {p.gear.id}
                </text>
              </g>
            );
          })}
        </svg>
        {closure && (
          <div className="gbx-footer">
            <code>{this.focus}</code> co-locates {closure.size - 1} other gears; any
            process containing it contains all of them.
          </div>
        )}
      </div>
    );
  }
}

/** Y of the rule between the connected graph and the isolated band. */
function bandRuleY(placed: readonly Placed[]): number {
  const connectedBottom = Math.max(
    0,
    ...placed.filter((p) => !p.isolated).map((p) => p.y + NODE_H),
  );
  return connectedBottom + BAND_GAP / 2;
}

/**
 * A dependant-to-dependency edge as two horizontal stubs and a diagonal.
 *
 * Straight lines between box edges cross the columns at shallow angles and are
 * hard to follow; the stubs make every edge leave and enter horizontally, which
 * is what makes a bundle of them readable.
 */
function elbow(x1: number, y1: number, x2: number, y2: number): string {
  const stub = Math.min(18, Math.max(6, (x2 - x1) / 3));
  return `M ${x1} ${y1} L ${x1 + stub} ${y1} L ${x2 - stub} ${y2} L ${x2} ${y2}`;
}

/** Every gear reachable from `id`, including `id` itself. */
function closureOf(id: string, edges: readonly Edge[]): Set<string> {
  const out = new Set<string>([id]);
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const edge of edges) {
      if (edge.from === current && !out.has(edge.to)) {
        out.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return out;
}

/**
 * Layered layout, plus a separate band for gears with no co-location.
 *
 * The band is not cosmetic. Layer 0 means "depends on nothing in the catalogue",
 * and an isolated gear satisfies that -- so mixing the two puts gears that
 * nobody depends on in the same column as the ones everybody depends on, which
 * reads as though they were depended upon. `cluster` and `api-contracts` landing
 * beside `types-registry` was exactly that misreading.
 */
function layout(gears: readonly GearDescriptor[]): { placed: Placed[]; edges: Edge[] } {
  const byId = new Map(gears.map((g) => [g.id, g]));
  const sorted = [...gears].sort((a, b) => a.id.localeCompare(b.id));

  const edges: Edge[] = sorted.flatMap((gear) =>
    (gear.colocated_deps ?? [])
      .filter((dep) => byId.has(dep))
      .sort()
      .map((dep) => ({ from: gear.id, to: dep })),
  );

  const touched = new Set<string>();
  for (const edge of edges) {
    touched.add(edge.from);
    touched.add(edge.to);
  }

  const connected = sorted.filter((g) => touched.has(g.id));
  const isolated = sorted.filter((g) => !touched.has(g.id));

  // Layer = longest path to a gear with no co-location dependencies.
  //
  // Deliberately the *longest* path, not the shortest: a gear must be drawn to
  // the left of everything it pulls in, and the shortest path would let an edge
  // run backwards when a gear depends on both a leaf and a chain.
  //
  // Cycles are impossible here -- the registry's topological sort rejects them
  // at startup -- but the visited set keeps a malformed catalogue from hanging
  // the UI rather than trusting that.
  const layer = new Map<string, number>();
  const layerOf = (id: string, seen: Set<string>): number => {
    const cached = layer.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    const gear = byId.get(id);
    if (!gear) return 0;
    seen.add(id);
    const deps = (gear.colocated_deps ?? []).filter((d) => byId.has(d));
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => layerOf(d, seen)));
    seen.delete(id);
    layer.set(id, value);
    return value;
  };
  for (const gear of connected) layerOf(gear.id, new Set());

  const maxLayer = connected.length === 0 ? 0 : Math.max(...connected.map((g) => layer.get(g.id) ?? 0));
  // Column index counts from the left, deepest first, so arrows read "pulls in"
  // left to right.
  const columns: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const gear of connected) {
    columns[maxLayer - (layer.get(gear.id) ?? 0)].push(gear.id);
  }

  orderColumns(columns, edges);

  const placed: Placed[] = [];
  columns.forEach((column, index) => {
    column.forEach((id, row) => {
      const gear = byId.get(id);
      if (!gear) return;
      placed.push({
        gear,
        x: index * (NODE_W + GAP_X) + MARGIN,
        y: row * (NODE_H + GAP_Y) + MARGIN,
        isolated: false,
      });
    });
  });

  // The isolated band: a grid under the rule, as wide as the graph above it.
  const bandTop = bandRuleY(placed.length > 0 ? placed : [{ y: 0 } as Placed]) + BAND_GAP / 2;
  const perRow = Math.max(1, columns.length);
  isolated.forEach((gear, index) => {
    placed.push({
      gear,
      x: (index % perRow) * (NODE_W + GAP_X) + MARGIN,
      y: bandTop + Math.floor(index / perRow) * (NODE_H + GAP_Y),
      isolated: true,
    });
  });

  return { placed, edges };
}

/**
 * Reduce crossings by sorting each column to the average row of its neighbours.
 *
 * Two sweeps of the standard barycentre heuristic. Alphabetical order was what
 * produced the tangle in the first drawing: `api-gateway` sat above
 * `oidc-authn-plugin` while its dependencies sat below theirs, so every edge
 * crossed. Ties fall back to the id, so the result is still byte-stable.
 */
function orderColumns(columns: string[][], edges: readonly Edge[]): void {
  const rowOf = new Map<string, number>();
  const reindex = (): void => {
    rowOf.clear();
    for (const column of columns) {
      column.forEach((id, row) => rowOf.set(id, row));
    }
  };
  reindex();

  const barycentre = (id: string, from: "left" | "right"): number | undefined => {
    // Columns run dependant-to-dependency left to right, so a node's left
    // neighbours are the gears that depend on it and its right neighbours are
    // the gears it depends on.
    const neighbours =
      from === "left"
        ? edges.filter((e) => e.to === id).map((e) => e.from)
        : edges.filter((e) => e.from === id).map((e) => e.to);
    const rows = neighbours.map((n) => rowOf.get(n)).filter((r): r is number => r !== undefined);
    return rows.length === 0 ? undefined : rows.reduce((a, b) => a + b, 0) / rows.length;
  };

  for (let sweep = 0; sweep < 2; sweep += 1) {
    // Left to right, then right to left.
    const order = sweep === 0 ? [...columns.keys()] : [...columns.keys()].reverse();
    for (const index of order) {
      const side = sweep === 0 ? "left" : "right";
      const keyed = columns[index].map((id) => ({ id, key: barycentre(id, side) }));
      keyed.sort((a, b) => {
        if (a.key === undefined && b.key === undefined) return a.id.localeCompare(b.id);
        if (a.key === undefined) return 1;
        if (b.key === undefined) return -1;
        return a.key - b.key || a.id.localeCompare(b.id);
      });
      columns[index] = keyed.map((k) => k.id);
      reindex();
    }
  }
}
