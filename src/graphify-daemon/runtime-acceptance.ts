import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkgroupGraphStore, type SourceReconciliation } from '../graphify/store.js';
import type { ExtractionBundle, SourceInput } from '../graphify/types.js';
import { runIsolatedRead } from './isolated-read.js';
import { runIsolatedSourceReconcile } from './isolated-source-reconcile.js';

function source(workgroupId: string, id: string, text: string): SourceReconciliation {
  const relativePath = `knowledge/${id}.md`;
  const input: SourceInput = {
    id,
    workgroupId,
    kind: 'document',
    relativePath,
    contentHash: `${id}:${text}`,
  };
  const bundle: ExtractionBundle = {
    nodes: [
      {
        id: `node:${id}`,
        name: text,
        type: 'knowledge',
        description: text,
        evidence: [{ sourceId: id, relativePath, line: 1, excerpt: text }],
      },
    ],
    edges: [],
    hyperedges: [],
  };
  return { source: input, bundle };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'graphify-runtime-acceptance-'));
  try {
    const alphaPath = join(root, 'alpha.db');
    const betaPath = join(root, 'beta.db');
    for (const [path, workgroupId, text] of [
      [alphaPath, 'alpha', 'alpha retention policy'],
      [betaPath, 'beta', 'beta launch plan'],
    ] as const) {
      const store = new WorkgroupGraphStore(path, workgroupId);
      const generation = store.beginGeneration('acceptance-seed');
      store.appendSources([source(workgroupId, 'seed', text)], generation);
      store.completeGeneration(generation);
      store.close();
    }

    const alpha = await runIsolatedRead<ReturnType<WorkgroupGraphStore['query']>>(alphaPath, 'alpha', 'query', {
      term: 'retention',
      limit: 20,
    });
    const betaIsolation = await runIsolatedRead<ReturnType<WorkgroupGraphStore['query']>>(betaPath, 'beta', 'query', {
      term: 'retention',
      limit: 20,
    });
    assert(alpha.nodes.length === 1, 'shared workgroup retrieval did not return the seeded source');
    assert(betaIsolation.nodes.length === 0, 'cross-workgroup retrieval leaked a source');
    assert(alpha.nodes[0].evidence[0]?.relativePath === 'knowledge/seed.md', 'retrieval provenance is missing');

    const updates = Array.from({ length: 500 }, (_, index) =>
      source('alpha', `bulk-${index}`, `bulk concept ${index}`),
    );
    const started = performance.now();
    const mutation = runIsolatedSourceReconcile({
      path: alphaPath,
      workgroupId: 'alpha',
      reason: 'acceptance-live-update',
      upserts: updates,
      deletes: [],
    });
    const [statusDuringWrite, queryDuringWrite] = await Promise.all([
      runIsolatedRead<ReturnType<WorkgroupGraphStore['status']>>(alphaPath, 'alpha', 'status', {}),
      runIsolatedRead<ReturnType<WorkgroupGraphStore['query']>>(alphaPath, 'alpha', 'query', {
        term: 'retention',
        limit: 20,
      }),
    ]);
    const readLatencyMs = performance.now() - started;
    assert(statusDuringWrite.completeGeneration >= 1, 'status could not read a complete generation during mutation');
    assert(queryDuringWrite.nodes.length === 1, 'query could not read the last committed snapshot during mutation');
    assert(
      readLatencyMs < 5_000,
      `interactive reads exceeded 5 seconds during mutation: ${readLatencyMs.toFixed(0)}ms`,
    );
    await mutation;

    const fresh = await runIsolatedRead<ReturnType<WorkgroupGraphStore['query']>>(alphaPath, 'alpha', 'query', {
      term: 'bulk concept 499',
      limit: 20,
    });
    assert(
      fresh.nodes.some((node) => node.name === 'bulk concept 499'),
      'committed update was not immediately retrievable',
    );
    process.stdout.write(
      `${JSON.stringify({ passed: true, readLatencyMs: Math.round(readLatencyMs), checks: ['sharing', 'isolation', 'provenance', 'concurrent-read', 'freshness'] })}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
