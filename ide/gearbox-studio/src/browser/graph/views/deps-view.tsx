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
// Moved out of the widget unchanged when the graph gained four views. Its
// selectors -- `.gbx-edge[data-from][data-to]`, `.gbx-node-lit/-dim/-focus`,
// `.gbx-footer`, `data-isolated` -- are what four tests assert on, and they are
// also the net that catches a mistake in the extracted layout.

import React from "@theia/core/shared/react";

import type { GearDescriptor } from "../../../common/generated/GearDescriptor";
import {
  Edge,
  MARGIN,
  NODE_H,
  NODE_W,
  bandRuleY,
  closureOf,
  elbow,
  graphSize,
  layoutLayered,
} from "../layered";

export interface DepsViewProps {
  readonly gears: readonly GearDescriptor[];
  /** The gear whose closure is painted, if any. */
  readonly focus: string | undefined;
  readonly onToggleFocus: (id: string) => void;
}

export function DepsView({ gears, focus, onToggleFocus }: DepsViewProps): React.ReactElement {
  if (gears.length === 0) {
    return (
      <div className="gbx-empty">
        Co-location edges come from <code>#[toolkit::gear(deps = [...])]</code>, so
        they appear as gears finish projecting.
      </div>
    );
  }

  const byId = new Map(gears.map((g) => [g.id, g]));
  const edges: Edge[] = [...gears]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((gear) =>
      (gear.colocated_deps ?? [])
        .filter((dep) => byId.has(dep))
        .sort()
        .map((dep) => ({ from: gear.id, to: dep })),
    );

  const { placed } = layoutLayered([...byId.keys()], edges);
  const at = new Map(placed.map((p) => [p.id, p]));
  const closure = focus ? closureOf(focus, edges) : undefined;
  const { width, height } = graphSize(placed);
  const isolatedCount = placed.filter((p) => p.isolated).length;

  return (
    <>
      <div className="gbx-header">
        An arrow is <strong>link-time</strong> co-location: the resolver can never
        sever it, so every process reaching a gear contains everything the arrows
        lead to. Click a gear to paint its closure -- that is the set no process
        boundary can split.
        {isolatedCount > 0 && (
          <>
            {" "}
            {isolatedCount} gears below the rule have no co-location at all, so each
            one can stand alone in a process.
          </>
        )}
      </div>
      <svg width={width} height={height} className="gbx-svg" data-graph="deps">
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
          const from = at.get(edge.from);
          const to = at.get(edge.to);
          if (!from || !to) return undefined;
          // From the right edge of the dependant to the left edge of the
          // dependency, never through a box: the arrowhead has to be visible,
          // and relying on opaque rects drawn afterwards to hide the overlap is
          // the sort of thing that breaks the first time a fill changes.
          const lit = closure?.has(edge.from) === true && closure.has(edge.to);
          return (
            <path
              key={`${edge.from}->${edge.to}`}
              className={`gbx-edge ${lit ? "gbx-edge-lit" : closure ? "gbx-edge-dim" : ""}`}
              d={elbow(from.x + NODE_W, from.y + NODE_H / 2, to.x, to.y + NODE_H / 2)}
              markerEnd={`url(#${lit ? "gbx-arrow-lit" : "gbx-arrow"})`}
              data-from={edge.from}
              data-to={edge.to}
            />
          );
        })}

        {placed.map((p) => {
          const state = closure
            ? closure.has(p.id)
              ? p.id === focus
                ? "gbx-node-focus"
                : "gbx-node-lit"
              : "gbx-node-dim"
            : "";
          return (
            <g
              key={p.id}
              transform={`translate(${p.x},${p.y})`}
              className={`gbx-node-g ${state}`}
              data-gear={p.id}
              data-isolated={p.isolated ? "true" : "false"}
              // Focusable and Enter/Space operable: painting a closure is the one
              // interaction this view has, and a mouse-only one makes the whole
              // panel unreachable from the keyboard.
              role="button"
              tabIndex={0}
              aria-label={`${p.id}: paint co-location closure`}
              aria-pressed={focus === p.id}
              onClick={() => onToggleFocus(p.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onToggleFocus(p.id);
                }
              }}
            >
              <rect width={NODE_W} height={NODE_H} rx={4} className="gbx-node" />
              <text x={8} y={19} className="gbx-node-label">
                {p.id}
              </text>
            </g>
          );
        })}
      </svg>
      {closure && (
        <div className="gbx-footer">
          <code>{focus}</code> co-locates {closure.size - 1} other gears; any process
          containing it contains all of them.
        </div>
      )}
    </>
  );
}
