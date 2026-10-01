// Layout and geometry shared by the graph views.
//
// Extracted from the co-location view when three more joined it. The layering is
// a hand-rolled layered assignment rather than elkjs: the plan reached for elkjs
// to get determinism, and computing layers ourselves is deterministic by
// construction, needs no async layout pass, and these graphs are shallow DAGs of
// a few dozen nodes. If one grows a cycle or a hundred nodes, elkjs is the answer.
//
// Generalised over node **ids** rather than over gears. The co-location view used
// to read `colocated_deps` inside the layering, which tied the algorithm to one
// kind of node; every out-edge it consulted is already in `edges`, so passing the
// edge list is the same computation with nothing to keep in sync. That equivalence
// is why the co-location drawing is unchanged to the pixel, which the four tests
// on `.gbx-edge` and the isolated band are there to hold.

export const NODE_W = 168;
export const NODE_H = 30;
export const GAP_X = 74;
export const GAP_Y = 16;
export const MARGIN = 12;
/** Space between the connected graph and the band of unconnected nodes. */
export const BAND_GAP = 46;

export interface Edge {
  readonly from: string;
  readonly to: string;
}

export interface Placement {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** True for a node with no edge in either direction. */
  readonly isolated: boolean;
}

/** Y of the rule between the connected graph and the isolated band. */
export function bandRuleY(placed: readonly Placement[]): number {
  const connectedBottom = Math.max(
    0,
    ...placed.filter((p) => !p.isolated).map((p) => p.y + NODE_H),
  );
  return connectedBottom + BAND_GAP / 2;
}

/** The SVG box that holds everything placed. */
export function graphSize(placed: readonly Placement[]): { width: number; height: number } {
  return {
    width: Math.max(...placed.map((p) => p.x + NODE_W)) + MARGIN,
    height: Math.max(...placed.map((p) => p.y + NODE_H)) + MARGIN,
  };
}

/**
 * An edge as two horizontal stubs and a diagonal.
 *
 * Straight lines between box edges cross the columns at shallow angles and are
 * hard to follow; the stubs make every edge leave and enter horizontally, which
 * is what makes a bundle of them readable.
 */
export function elbow(x1: number, y1: number, x2: number, y2: number): string {
  const stub = Math.min(18, Math.max(6, (x2 - x1) / 3));
  return `M ${x1} ${y1} L ${x1 + stub} ${y1} L ${x2 - stub} ${y2} L ${x2} ${y2}`;
}

/**
 * Every node reachable from `id`, including `id` itself.
 *
 * Over an adjacency map rather than a scan of every edge per step: the scan was
 * `O(V*E)` per click, which is invisible at a few dozen nodes and is the first
 * thing to hurt at a few hundred.
 */
export function closureOf(id: string, edges: readonly Edge[]): Set<string> {
  const adjacency = adjacencyOf(edges);

  const out = new Set<string>([id]);
  const queue = [id];
  for (;;) {
    const current = queue.pop();
    if (current === undefined) {
      return out;
    }
    for (const next of adjacency.get(current) ?? []) {
      if (!out.has(next)) {
        out.add(next);
        queue.push(next);
      }
    }
  }
}

/**
 * Layered layout, plus a separate band for nodes with no edges.
 *
 * The band is not cosmetic. Layer 0 means "depends on nothing drawn here", and an
 * isolated node satisfies that -- so mixing the two puts nodes that nobody
 * depends on in the same column as the ones everybody depends on, which reads as
 * though they were depended upon. `cluster` and `api-contracts` landing beside
 * `types-registry` was exactly that misreading.
 *
 * `ids` is sorted here rather than by the caller, so the result depends on the
 * set and not on the order it arrived in.
 */
export function layoutLayered(
  ids: readonly string[],
  edges: readonly Edge[],
): { placed: Placement[]; columnCount: number } {
  const present = new Set(ids);
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  const kept = edges.filter((e) => present.has(e.from) && present.has(e.to));
  const out = adjacencyOf(kept);

  const touched = new Set<string>();
  for (const edge of kept) {
    touched.add(edge.from);
    touched.add(edge.to);
  }

  const connected = sorted.filter((id) => touched.has(id));
  const isolated = sorted.filter((id) => !touched.has(id));

  // Layer = longest path to a node with no outgoing edges.
  //
  // Deliberately the *longest* path, not the shortest: a node must be drawn to
  // the left of everything it points at, and the shortest path would let an edge
  // run backwards when a node points at both a leaf and a chain.
  //
  // Cycles are impossible in the co-location graph -- the registry's topological
  // sort rejects them at startup -- but the visited set keeps a malformed input
  // from hanging the UI rather than trusting that. The contract graph has no such
  // guarantee at all, which makes the guard load-bearing rather than defensive.
  const layer = new Map<string, number>();
  const layerOf = (id: string, seen: Set<string>): number => {
    const cached = layer.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const next = out.get(id) ?? [];
    const value = next.length === 0 ? 0 : 1 + Math.max(...next.map((d) => layerOf(d, seen)));
    seen.delete(id);
    layer.set(id, value);
    return value;
  };
  for (const id of connected) layerOf(id, new Set());

  const maxLayer = connected.length === 0 ? 0 : Math.max(...connected.map((id) => layer.get(id) ?? 0));
  // Column index counts from the left, deepest first, so arrows read "pulls in"
  // left to right.
  const columns: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of connected) {
    // The index is in range by construction -- `maxLayer` is the maximum of the
    // same map -- but saying so beats asserting it, since the arithmetic and the
    // array length are established several lines apart.
    columns[maxLayer - (layer.get(id) ?? 0)]?.push(id);
  }

  orderColumns(columns, kept);

  const placed: Placement[] = [];
  columns.forEach((column, index) => {
    column.forEach((id, row) => {
      placed.push({
        id,
        x: index * (NODE_W + GAP_X) + MARGIN,
        y: row * (NODE_H + GAP_Y) + MARGIN,
        isolated: false,
      });
    });
  });

  // The isolated band: a grid under the rule, as wide as the graph above it.
  const bandTop =
    bandRuleY(placed.length > 0 ? placed : [{ id: "", x: 0, y: 0, isolated: false }]) + BAND_GAP / 2;
  const perRow = Math.max(1, columns.length);
  isolated.forEach((id, index) => {
    placed.push({
      id,
      x: (index % perRow) * (NODE_W + GAP_X) + MARGIN,
      y: bandTop + Math.floor(index / perRow) * (NODE_H + GAP_Y),
      isolated: true,
    });
  });

  return { placed, columnCount: columns.length };
}

/**
 * Place nodes in fixed ranks, left to right.
 *
 * For the cluster graph, whose three ranks -- requirement, capability, provider --
 * are what the picture *means*. Computing them from edge depth would put a
 * capability nobody requires in the requirement column, which is the one thing
 * this drawing must not say.
 */
export function layoutRanked(ranks: readonly (readonly string[])[]): Placement[] {
  const placed: Placement[] = [];
  ranks.forEach((rank, index) => {
    rank.forEach((id, row) => {
      placed.push({
        id,
        x: index * (NODE_W + GAP_X) + MARGIN,
        y: row * (NODE_H + GAP_Y) + MARGIN,
        isolated: false,
      });
    });
  });
  return placed;
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
    // neighbours are the nodes that point at it and its right neighbours are the
    // nodes it points at.
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
      const column = columns[index];
      if (!column) {
        continue;
      }
      const side = sweep === 0 ? "left" : "right";
      const keyed = column.map((id) => ({ id, key: barycentre(id, side) }));
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

function adjacencyOf(edges: readonly Edge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from);
    if (list) {
      list.push(edge.to);
    } else {
      adjacency.set(edge.from, [edge.to]);
    }
  }
  return adjacency;
}
