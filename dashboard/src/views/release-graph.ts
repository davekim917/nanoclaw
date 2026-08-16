import type { ReleaseItem } from '../lib/api.js';

/**
 * The release board as a dependency DAG, laid out in layers.
 *
 * Two things this module refuses to do, because both would be lies:
 *
 * 1. **Undeclared is not independent.** An item that never declared its
 *    dependencies is not the same as an item that declared it has none. Both
 *    would otherwise land in layer 0 looking identical, and the reader would
 *    conclude "nothing blocks these" from what is actually "nobody said".
 *    `depsKnown` separates them and `declaredPct` reports the gap, so a sparse
 *    graph reads as a coverage problem rather than as good news.
 *
 * 2. **Dangling references are not edges.** A `dependsOn` naming an id that is
 *    not on the board (closed, another repo, a typo) is dropped from layout and
 *    surfaced in `danglingRefs` — drawing an edge to a node that isn't there,
 *    or inventing the node, both misrepresent the data.
 *
 * The layout is longest-path layering: layer(n) = 0 when nothing on the board
 * blocks it, else 1 + max(layer of its blockers). That is a few lines and needs
 * no layout library — the heavy ones (elkjs ~500KB, cytoscape ~400KB) exist for
 * general graphs with edge routing and force simulation, none of which a
 * left-to-right DAG needs.
 */

export interface GraphNode {
  item: ReleaseItem;
  /** 0 = nothing on this board blocks it. */
  layer: number;
  /** Ids this node is blocked by, restricted to items actually on the board. */
  blockedBy: string[];
  /** How many items transitively free up if this one lands. The ranking key. */
  unblocks: number;
  /** False when the item never declared dependencies — NOT "has none". */
  depsKnown: boolean;
  /** This node sits on a dependency cycle; nothing in it can go first. */
  inCycle: boolean;
}

export interface ReleaseGraph {
  /** layers[i] holds every node at depth i, in board order. */
  layers: GraphNode[][];
  byId: Map<string, GraphNode>;
  /** Percentage of items that declared their dependencies at all (0-100). */
  declaredPct: number;
  undeclaredCount: number;
  /** `dependsOn` entries naming something not on the board. */
  danglingRefs: { from: string; to: string }[];
  /** Ids that sit on at least one cycle. */
  cycles: string[];
}

/**
 * Omitting `dependsOn` means "nobody checked"; an explicit empty array means
 * "checked, nothing blocks it". One field carries both, so the watcher does not
 * need a second flag to say it looked.
 */
export function depsDeclared(item: ReleaseItem): boolean {
  return Array.isArray(item.dependsOn);
}

export function buildReleaseGraph(items: ReleaseItem[]): ReleaseGraph {
  const byIdItem = new Map(items.map((i) => [i.id, i]));
  const danglingRefs: { from: string; to: string }[] = [];

  // Edges, restricted to ids present on the board and de-duplicated. A
  // self-reference is dropped rather than treated as a one-node cycle.
  const blockedBy = new Map<string, string[]>();
  for (const item of items) {
    const deps: string[] = [];
    for (const raw of item.dependsOn ?? []) {
      const to = raw.trim();
      if (!to || to === item.id) continue;
      if (!byIdItem.has(to)) {
        danglingRefs.push({ from: item.id, to });
        continue;
      }
      if (!deps.includes(to)) deps.push(to);
    }
    blockedBy.set(item.id, deps);
  }

  // Longest-path layering with DFS cycle detection. `visiting` is the current
  // stack: re-entering a node already on it is a cycle, and every node on that
  // stack is part of one — we cut the edge for layout and record the ids so the
  // UI can say "these block each other" instead of silently picking a winner.
  const layerOf = new Map<string, number>();
  const cycles = new Set<string>();
  const visiting = new Set<string>();

  function layer(id: string): number {
    const cached = layerOf.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      cycles.add(id);
      return 0;
    }
    visiting.add(id);
    let depth = 0;
    for (const dep of blockedBy.get(id) ?? []) {
      if (visiting.has(dep)) {
        cycles.add(id);
        cycles.add(dep);
        continue;
      }
      depth = Math.max(depth, layer(dep) + 1);
    }
    visiting.delete(id);
    layerOf.set(id, depth);
    return depth;
  }
  for (const item of items) layer(item.id);

  // Transitive downstream count — "land this and N things move". Computed by
  // walking the reverse edges from each node, memoised on the reachable SET
  // rather than a count, because two paths to the same item must not count it
  // twice.
  const dependents = new Map<string, string[]>();
  for (const [id, deps] of blockedBy) {
    for (const dep of deps) {
      const list = dependents.get(dep);
      if (list) list.push(id);
      else dependents.set(dep, [id]);
    }
  }
  const reachCache = new Map<string, Set<string>>();
  function downstream(id: string, seen = new Set<string>()): Set<string> {
    const cached = reachCache.get(id);
    if (cached) return cached;
    if (seen.has(id)) return new Set();
    seen.add(id);
    const out = new Set<string>();
    for (const child of dependents.get(id) ?? []) {
      out.add(child);
      for (const g of downstream(child, seen)) out.add(g);
    }
    seen.delete(id);
    // Only cache once the walk completed outside a cycle guard, so a partial
    // result from a cycle-truncated branch is never reused as the answer.
    if (seen.size === 0) reachCache.set(id, out);
    return out;
  }

  const nodes: GraphNode[] = items.map((item) => ({
    item,
    layer: layerOf.get(item.id) ?? 0,
    blockedBy: blockedBy.get(item.id) ?? [],
    unblocks: downstream(item.id).size,
    depsKnown: depsDeclared(item),
    inCycle: cycles.has(item.id),
  }));

  const depth = nodes.reduce((m, n) => Math.max(m, n.layer), 0);
  const layers: GraphNode[][] = Array.from({ length: depth + 1 }, () => []);
  for (const n of nodes) layers[n.layer]!.push(n);

  const declared = nodes.filter((n) => n.depsKnown).length;
  return {
    layers,
    byId: new Map(nodes.map((n) => [n.item.id, n])),
    declaredPct: nodes.length === 0 ? 100 : Math.round((declared / nodes.length) * 100),
    undeclaredCount: nodes.length - declared,
    danglingRefs,
    cycles: [...cycles],
  };
}

/**
 * "Land this and N things move" — the answer the picture exists to give, in a
 * form that works on a phone. Items that unblock nothing are dropped: a ranking
 * of zeros is noise, and they are already on the board by status.
 */
export function unblockRanking(graph: ReleaseGraph, limit = 8): GraphNode[] {
  return [...graph.byId.values()]
    .filter((n) => n.unblocks > 0)
    .sort(
      (a, b) =>
        b.unblocks - a.unblocks ||
        Number(Boolean(b.item.blocksRelease)) - Number(Boolean(a.item.blocksRelease)) ||
        a.item.id.localeCompare(b.item.id),
    )
    .slice(0, limit);
}
