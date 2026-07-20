import { parentPort, workerData } from 'node:worker_threads';

import { WorkgroupGraphStore } from '../graphify/store.js';
import type { GraphExplainResult } from '../graphify/types.js';

interface WorkerOptions {
  path: string;
  workgroupId: string;
  command: 'query' | 'status' | 'explain' | 'path' | 'affected';
  args: Record<string, unknown>;
}

function resolveReference(store: WorkgroupGraphStore, reference: string): string {
  if (store.explain(reference)) return reference;
  const exact = store
    .query(reference, { limit: 100 })
    .nodes.filter((node) => node.name.toLocaleLowerCase() === reference.toLocaleLowerCase());
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) throw new Error(`ambiguous graph reference: ${reference}`);
  throw new Error(`unknown graph reference: ${reference}`);
}

function explainDepth(store: WorkgroupGraphStore, nodeId: string, depth: number): GraphExplainResult | null {
  const root = store.explain(nodeId);
  if (!root || depth <= 1) return root;
  const incoming = new Map(root.incoming.map((edge) => [`${edge.id}:${edge.from}:${edge.to}`, edge]));
  const outgoing = new Map(root.outgoing.map((edge) => [`${edge.id}:${edge.from}:${edge.to}`, edge]));
  const hyperedges = new Map(root.hyperedges.map((edge) => [edge.id, edge]));
  let frontier = [nodeId];
  const seen = new Set(frontier);
  for (let level = 1; level < depth; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const detail = store.explain(id);
      if (!detail) continue;
      for (const edge of detail.incoming) {
        incoming.set(`${edge.id}:${edge.from}:${edge.to}`, edge);
        if (!seen.has(edge.from)) next.push(edge.from);
      }
      for (const edge of detail.outgoing) {
        outgoing.set(`${edge.id}:${edge.from}:${edge.to}`, edge);
        if (!seen.has(edge.to)) next.push(edge.to);
      }
      for (const edge of detail.hyperedges) hyperedges.set(edge.id, edge);
    }
    frontier = next.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (!frontier.length) break;
  }
  return {
    ...root,
    incoming: [...incoming.values()],
    outgoing: [...outgoing.values()],
    hyperedges: [...hyperedges.values()],
  };
}

const port = parentPort;
if (!port) throw new Error('Graphify isolated read requires a parent port');
const options = workerData as WorkerOptions;

try {
  const store = new WorkgroupGraphStore(options.path, options.workgroupId, { readonly: true });
  let result: unknown;
  switch (options.command) {
    case 'status':
      result = store.status();
      break;
    case 'query':
      result = store.query(String(options.args.term), { limit: Number(options.args.limit) });
      break;
    case 'explain': {
      const reference = resolveReference(store, String(options.args.reference));
      result = explainDepth(store, reference, Number(options.args.depth));
      break;
    }
    case 'path':
      result = store.path(
        resolveReference(store, String(options.args.from)),
        resolveReference(store, String(options.args.to)),
        { maxDepth: Number(options.args.maxDepth) },
      );
      break;
    case 'affected':
      result = store.affected(resolveReference(store, String(options.args.reference)), {
        maxDepth: Number(options.args.maxDepth),
      });
      break;
  }
  store.close();
  port.postMessage({ ok: true, result });
} catch (error) {
  port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
