import { afterEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { WorkgroupGraphStore } from './store.js';
import type { ExtractionBundle, SourceInput } from './types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeStore(workgroupId = 'example-retail'): WorkgroupGraphStore {
  const root = mkdtempSync(join(tmpdir(), 'graphify-store-'));
  roots.push(root);
  return new WorkgroupGraphStore(join(root, 'index.db'), workgroupId);
}

function source(id: string, relativePath: string, contentHash = `hash-${id}`): SourceInput {
  return {
    id,
    workgroupId: 'example-retail',
    kind: 'document',
    relativePath,
    contentHash,
  };
}

function bundleFor(sourceId: string, relativePath: string, nodeId: string, nodeName: string): ExtractionBundle {
  return {
    nodes: [
      {
        id: nodeId,
        name: nodeName,
        type: 'concept',
        description: `${nodeName} description`,
        evidence: [{ sourceId, relativePath, line: 7, excerpt: nodeName }],
      },
    ],
    edges: [],
    hyperedges: [],
  };
}

describe('WorkgroupGraphStore', () => {
  test('creates reverse lookup indexes used by interactive retrieval', () => {
    const root = mkdtempSync(join(tmpdir(), 'graphify-store-indexes-'));
    roots.push(root);
    const path = join(root, 'index.db');
    new WorkgroupGraphStore(path, 'example-retail').close();

    const db = new Database(path, { readonly: true });
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index'
            AND name IN ('source_nodes_node_idx', 'edges_from_to_idx')
          ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    db.close();
    expect(indexes.map((row) => row.name)).toEqual(['edges_from_to_idx', 'source_nodes_node_idx']);
  });

  test('read-only store serves retrieval without claiming a writer lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'graphify-store-readonly-'));
    roots.push(root);
    const path = join(root, 'index.db');
    const writer = new WorkgroupGraphStore(path, 'example-retail');
    const generation = writer.beginGeneration('seed');
    const input = source('source-readonly', 'notes/readonly.md');
    writer.upsertSource(input, bundleFor(input.id, input.relativePath, 'readonly-node', 'Read Only'), generation);
    writer.completeGeneration(generation);
    writer.close();

    const reader = new WorkgroupGraphStore(path, 'example-retail', { readonly: true });
    expect(reader.query('Read Only').nodes.map((node) => node.id)).toEqual(['readonly-node']);
    expect(() => reader.beginGeneration('forbidden')).toThrow(/readonly/i);
    reader.close();
  });

  test('test_graph_store_atomic_source_replacement', () => {
    const store = makeStore();
    const generation = store.beginGeneration('initial');
    const input = source('source-1', 'notes/metrics.md');

    store.upsertSource(input, bundleFor(input.id, input.relativePath, 'old-node', 'Old Metric'), generation);
    store.upsertSource(
      { ...input, contentHash: 'replacement-hash' },
      bundleFor(input.id, input.relativePath, 'new-node', 'New Metric'),
      generation,
    );

    expect(store.query('Old Metric').nodes).toHaveLength(0);
    expect(store.query('New Metric').nodes.map((node) => node.id)).toEqual(['new-node']);
    expect(store.getSourceById(input.id)).toMatchObject({
      contentHash: 'replacement-hash',
      state: 'indexed',
      generation,
    });

    expect(() =>
      store.upsertSource(
        { ...input, contentHash: 'broken-hash' },
        {
          nodes: [],
          edges: [
            {
              id: 'broken-edge',
              from: 'missing-a',
              to: 'missing-b',
              type: 'depends_on',
              structural: true,
            },
          ],
          hyperedges: [],
        },
        generation,
      ),
    ).toThrow(/missing nodes/i);
    expect(store.query('New Metric').nodes.map((node) => node.id)).toEqual(['new-node']);
    expect(store.getSourceById(input.id)?.contentHash).toBe('replacement-hash');
    store.close();
  });

  test('test_graph_store_duplicate_content_preserves_source_aliases', () => {
    const store = makeStore();
    const generation = store.beginGeneration('duplicates');
    const first = source('source-a', 'repos/dbt/models/orders.sql', 'same-content');
    const second = source('source-b', 'exports/orders.sql', 'same-content');

    store.upsertSource(first, bundleFor(first.id, first.relativePath, 'orders', 'Orders'), generation);
    store.upsertSource(second, bundleFor(second.id, second.relativePath, 'orders', 'Orders'), generation);

    const result = store.explain('orders');
    expect(result?.evidence.map((item) => item.relativePath).sort()).toEqual([
      'exports/orders.sql',
      'repos/dbt/models/orders.sql',
    ]);
    expect(store.getSource('exports/orders.sql')?.id).toBe('source-b');
    store.close();
  });

  test('test_graph_store_uses_full_text_prefixes_for_partial_terms', () => {
    const store = makeStore();
    const generation = store.beginGeneration('prefix search');
    const input = source('source-prefix', 'knowledge/retention.md');
    store.upsertSource(
      input,
      bundleFor(input.id, input.relativePath, 'customer-lifetime-value', 'Customer Lifetime Value'),
      generation,
    );
    store.completeGeneration(generation);

    expect(store.query('CUSTOMER-LIFETIME-VALUE').nodes.map((node) => node.id)).toEqual(['customer-lifetime-value']);
    expect(store.query('cust life val').nodes.map((node) => node.id)).toEqual(['customer-lifetime-value']);
    store.close();
  });

  test('test_graph_store_prioritizes_name matches over description matches', () => {
    const store = makeStore();
    const generation = store.beginGeneration('name priority');
    const descriptionMatch = source('source-description', 'knowledge/description.md');
    const nameMatch = source('source-name', 'knowledge/name.md');
    store.upsertSource(
      descriptionMatch,
      {
        nodes: [
          {
            id: 'a-description-match',
            name: 'Unrelated title',
            type: 'concept',
            description: 'Customer Lifetime Value appears only in this description.',
            evidence: [{ sourceId: descriptionMatch.id, relativePath: descriptionMatch.relativePath }],
          },
        ],
        edges: [],
        hyperedges: [],
      },
      generation,
    );
    store.upsertSource(
      nameMatch,
      bundleFor(nameMatch.id, nameMatch.relativePath, 'z-name-match', 'Customer Lifetime Value'),
      generation,
    );
    store.completeGeneration(generation);

    expect(store.query('customer lifetime value', { limit: 1 }).nodes.map((node) => node.id)).toEqual(['z-name-match']);
    store.close();
  });

  test('test_graph_store_bounded_append_uses_one_open_generation', () => {
    const store = makeStore();
    const generation = store.beginGeneration('streamed corpus');
    const first = source('source-a', 'knowledge/strategy.md');
    const second = source('source-b', 'models/customer_ltv.sql');

    store.appendSources(
      [
        { source: first, bundle: bundleFor(first.id, first.relativePath, 'strategy', 'Retention Strategy') },
        { source: second, bundle: bundleFor(second.id, second.relativePath, 'ltv', 'Customer LTV') },
      ],
      generation,
    );

    expect(store.status()).toMatchObject({ currentGeneration: generation, completeGeneration: 0 });
    expect(store.query('Retention Strategy').nodes.map((node) => node.id)).toEqual(['strategy']);
    expect(store.query('Customer LTV').nodes.map((node) => node.id)).toEqual(['ltv']);
    const metadata = source('source-metadata', 'knowledge/.env');
    store.appendSourceStates(
      [{ source: metadata, state: 'metadata_only', error: 'Sensitive credential-shaped file' }],
      generation,
    );
    expect(store.getSourceById(metadata.id)).toMatchObject({
      state: 'metadata_only',
      error: 'Sensitive credential-shaped file',
      generation,
    });
    expect(() =>
      store.appendSources(
        [{ source: first, bundle: bundleFor(first.id, first.relativePath, 'replacement', 'Replacement') }],
        generation,
      ),
    ).toThrow(/unique constraint failed/i);
    expect(store.query('Retention Strategy').nodes.map((node) => node.id)).toEqual(['strategy']);
    expect(store.query('Replacement').nodes).toEqual([]);

    store.completeGeneration(generation);
    expect(store.status().completeGeneration).toBe(generation);
    expect(() =>
      store.appendSources(
        [
          {
            source: source('source-c', 'knowledge/after-complete.md'),
            bundle: bundleFor('source-c', 'knowledge/after-complete.md', 'late', 'Late'),
          },
        ],
        generation,
      ),
    ).toThrow(/no complete generation/i);
    expect(() =>
      store.appendSourceStates(
        [{ source: source('source-late-state', 'knowledge/late.env'), state: 'metadata_only' }],
        generation,
      ),
    ).toThrow(/no complete generation/i);
    store.close();
  });

  test('test_graph_store_affected_ignores_semantic_edges', () => {
    const store = makeStore();
    const generation = store.beginGeneration('dependencies');
    const input = source('source-1', 'models/metrics.lkml');
    const evidence = [{ sourceId: input.id, relativePath: input.relativePath }];
    store.upsertSource(
      input,
      {
        nodes: [
          { id: 'base', name: 'Base', type: 'model', evidence },
          { id: 'structural-dependent', name: 'Structural', type: 'model', evidence },
          { id: 'semantic-dependent', name: 'Semantic', type: 'concept', evidence },
        ],
        edges: [
          {
            id: 'structural-edge',
            from: 'structural-dependent',
            to: 'base',
            type: 'depends_on',
            structural: true,
            evidence,
          },
          {
            id: 'semantic-edge',
            from: 'semantic-dependent',
            to: 'base',
            type: 'related_to',
            structural: false,
            evidence,
          },
        ],
        hyperedges: [],
      },
      generation,
    );

    expect(store.affected('base').nodes.map((node) => node.id)).toEqual(['structural-dependent']);
    store.close();
  });

  test('test_graph_store_path_and_explain_return_provenance', () => {
    const store = makeStore();
    const generation = store.beginGeneration('path');
    const input = source('source-1', 'specs/revenue.md');
    const evidence = [
      {
        sourceId: input.id,
        relativePath: input.relativePath,
        page: 3,
        excerpt: 'Revenue feeds net revenue',
      },
    ];
    store.upsertSource(
      input,
      {
        nodes: [
          { id: 'revenue', name: 'Revenue', type: 'metric', evidence },
          { id: 'net-revenue', name: 'Net Revenue', type: 'metric', evidence },
        ],
        edges: [
          {
            id: 'feeds',
            from: 'revenue',
            to: 'net-revenue',
            type: 'feeds',
            structural: true,
            evidence,
          },
        ],
        hyperedges: [],
      },
      generation,
    );

    const path = store.path('revenue', 'net-revenue');
    expect(path?.nodes.map((node) => node.id)).toEqual(['revenue', 'net-revenue']);
    expect(path?.edges[0]).toMatchObject({ id: 'feeds', structural: true });
    expect(path?.edges[0]?.evidence[0]).toMatchObject({
      relativePath: 'specs/revenue.md',
      page: 3,
    });
    expect(store.explain('revenue')?.evidence[0]).toMatchObject({
      relativePath: 'specs/revenue.md',
      excerpt: 'Revenue feeds net revenue',
    });
    store.close();
  });

  test('test_graph_store_deletion_removes_orphaned_contributions', () => {
    const store = makeStore();
    const generation = store.beginGeneration('delete');
    const input = source('source-1', 'notes/obsolete.md');
    store.upsertSource(input, bundleFor(input.id, input.relativePath, 'obsolete', 'Obsolete Concept'), generation);

    store.deleteSource(input.id, generation);

    expect(store.query('Obsolete Concept').nodes).toHaveLength(0);
    expect(store.explain('obsolete')).toBeNull();
    expect(store.getSourceById(input.id)?.state).toBe('deleted');
    store.close();
  });

  test('atomically reconciles changed sources while leaving unchanged contributions untouched', () => {
    const store = makeStore();
    const initial = store.beginGeneration('initial archive');
    const unchanged = source('unchanged', 'conversations/unchanged.md');
    const removed = source('removed', 'conversations/removed.md');
    store.upsertSource(unchanged, bundleFor(unchanged.id, unchanged.relativePath, 'shared-node', 'Shared'), initial);
    store.upsertSource(removed, bundleFor(removed.id, removed.relativePath, 'removed-node', 'Removed'), initial);
    store.completeGeneration(initial);

    const added = source('added', 'conversations/added.md');
    const result = store.reconcileSources(
      'archive delta',
      [
        { source: unchanged, bundle: bundleFor(unchanged.id, unchanged.relativePath, 'should-not-replace', 'Wrong') },
        { source: added, bundle: bundleFor(added.id, added.relativePath, 'added-node', 'Added') },
      ],
      [removed.id],
    );

    expect(result).toMatchObject({
      upsertedSourceIds: ['added'],
      deletedSourceIds: ['removed'],
      unchangedSourceIds: ['unchanged'],
    });
    expect(store.getSourceById(unchanged.id)?.generation).toBe(initial);
    expect(store.query('Shared').nodes.map((node) => node.id)).toEqual(['shared-node']);
    expect(store.query('Wrong').nodes).toHaveLength(0);
    expect(store.query('Removed').nodes).toHaveLength(0);
    expect(store.explain('removed-node')).toBeNull();
    expect(store.query('Added').nodes.map((node) => node.id)).toEqual(['added-node']);
    store.close();
  });

  test('rolls back the complete source batch when one replacement is invalid', () => {
    const store = makeStore();
    const initial = store.beginGeneration('initial archive');
    const stable = source('stable', 'conversations/stable.md');
    store.upsertSource(stable, bundleFor(stable.id, stable.relativePath, 'stable-node', 'Stable'), initial);
    store.completeGeneration(initial);
    const valid = source('valid', 'conversations/valid.md');
    const broken = source('broken', 'conversations/broken.md');

    expect(() =>
      store.reconcileSources(
        'broken archive delta',
        [
          { source: valid, bundle: bundleFor(valid.id, valid.relativePath, 'valid-node', 'Valid') },
          {
            source: broken,
            bundle: {
              nodes: [],
              edges: [{ id: 'bad', from: 'missing', to: 'also-missing', type: 'related', structural: false }],
              hyperedges: [],
            },
          },
        ],
        [stable.id],
      ),
    ).toThrow(/missing nodes/i);

    expect(store.status().completeGeneration).toBe(initial);
    expect(store.getSourceById(valid.id)).toBeNull();
    expect(store.getSourceById(stable.id)?.state).toBe('indexed');
    expect(store.query('Stable').nodes.map((node) => node.id)).toEqual(['stable-node']);
    store.close();
  });

  test('test_graph_store_status_exposes_quarantine_and_pending', () => {
    const store = makeStore();
    const generation = store.beginGeneration('backfill');
    store.markSourceState(source('pending-source', 'pending/new.md'), 'pending', generation);
    store.markSourceState(
      source('quarantined-source', 'unsafe/secret.env'),
      'quarantined',
      generation,
      'credential-like content',
    );

    const before = store.status();
    expect(before.currentGeneration).toBe(generation);
    expect(before.completeGeneration).toBe(0);
    expect(before.pendingJobs).toBe(1);
    expect(before.counts.pending).toBe(1);
    expect(before.counts.quarantined).toBe(1);
    expect(before.quarantines).toEqual([
      expect.objectContaining({ id: 'quarantined-source', error: 'credential-like content' }),
    ]);

    store.completeGeneration(generation);
    expect(store.status().completeGeneration).toBe(generation);
    store.close();
  });

  test('test_graph_store_rejects_cross_source_evidence', () => {
    const store = makeStore();
    const generation = store.beginGeneration('isolation');
    const input = source('source-1', 'notes/owned.md');

    expect(() =>
      store.upsertSource(
        input,
        bundleFor('source-2', '../other-workgroup/private.md', 'escaped', 'Escaped'),
        generation,
      ),
    ).toThrow(/evidence.*source/i);
    expect(store.getSourceById(input.id)).toBeNull();
    store.close();
  });
});
