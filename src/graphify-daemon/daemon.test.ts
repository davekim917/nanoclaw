import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoverWorkgroup } from '../graphify/discovery.js';
import { WorkgroupGraphStore } from '../graphify/store.js';
import type { ExtractionBundle, GraphQueryResult, SourceInput } from '../graphify/types.js';
import {
  bridgeCodeBundle,
  DEFAULT_FULL_RECONCILE_MS,
  graphifyJobsRoot,
  namespaceSemantic,
  WorkgroupGraphDaemon,
} from './daemon.js';
import { BackgroundGraphRunner } from './background-runner.js';
import { ArchiveConversationReader } from './archive.js';
import { EnrichmentRepository } from './enrichment-cache.js';

const roots: string[] = [];
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'graphify-daemon-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; data: string; groups: string; central: string } {
  const root = temp();
  const data = join(root, 'data');
  const groups = join(root, 'groups');
  mkdirSync(data);
  mkdirSync(groups);
  const central = join(data, 'v2.db');
  const db = new Database(central);
  db.exec(`
    CREATE TABLE workgroups (id TEXT PRIMARY KEY);
    CREATE TABLE agent_groups (id TEXT PRIMARY KEY, folder TEXT NOT NULL, workgroup_id TEXT);
    CREATE TABLE messaging_groups (id TEXT PRIMARY KEY, platform_id TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT, thread_id TEXT);
    INSERT INTO workgroups VALUES ('madison');
    INSERT INTO agent_groups VALUES ('ag-a', 'madison-agent', 'madison');
  `);
  db.close();
  mkdirSync(join(groups, 'madison-agent'));
  return { root, data, groups, central };
}

function createArchive(path: string): Database.Database {
  const db = new Database(path);
  db.exec(`CREATE TABLE messages_archive (
    id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT,
    channel_type TEXT NOT NULL, channel_name TEXT, platform_id TEXT, thread_id TEXT,
    role TEXT NOT NULL, sender_id TEXT, sender_name TEXT, text TEXT NOT NULL, sent_at TEXT NOT NULL
  )`);
  return db;
}

function immediateRunner(): {
  run: (job: (signal: AbortSignal) => Promise<unknown>) => Promise<Record<string, unknown>>;
} {
  return {
    run: async (job) => {
      try {
        return { status: 'completed', value: await job(new AbortController().signal) };
      } catch (error) {
        return { status: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
  };
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('WorkgroupGraphDaemon', () => {
  it('uses a host-visible data job root in production construction', () => {
    expect(graphifyJobsRoot('/srv/nanoclaw/data')).toBe('/srv/nanoclaw/data/graphify/jobs');
    expect(graphifyJobsRoot('/srv/nanoclaw/data')).not.toContain('/tmp');
  });
  it('uses a six-hour default safety reconciliation interval', () => {
    expect(DEFAULT_FULL_RECONCILE_MS).toBe(6 * 60 * 60_000);
  });
  it('initial reconciliation reaches a clean completed generation', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'stable knowledge');
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
    });
    await daemon.refreshCatalog();
    const status = await daemon.ensureFresh('madison');
    expect(status.completeGeneration).toBeGreaterThan(0);
    expect(status.completeGeneration).toBe(status.currentGeneration);
    expect(status.freshness).toMatchObject({ dirty: false, reconciling: false, lastFailure: undefined });
    await daemon.close();
  });

  it('serves the last complete generation while restart reconciliation runs', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'durable restart knowledge');
    const initial = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
    });
    await initial.refreshCatalog();
    await initial.ensureFresh('madison');
    await initial.close();

    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const restarted = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      backgroundRunner: immediateRunner() as never,
      discover: async (options) => {
        started = true;
        await gate;
        return discoverWorkgroup(options);
      },
    });
    await restarted.start();
    await waitUntil(() => started);
    const statusSpy = vi.spyOn(WorkgroupGraphStore.prototype, 'status');
    const result = await restarted.query('madison', 'durable restart knowledge');
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(statusSpy).not.toHaveBeenCalled();
    statusSpy.mockRestore();
    expect(restarted.status('madison').freshness).toMatchObject({ dirty: true, reconciling: true });
    release();
    await waitUntil(() => !restarted.status('madison').freshness.dirty);
    await restarted.close();
  });

  it('activates immediate freshness watching after the initial generation', async () => {
    const f = fixture();
    const knowledge = join(f.groups, 'madison-agent', 'brief.md');
    writeFileSync(knowledge, 'version one knowledge');
    const discover = vi.fn(discoverWorkgroup);
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      backgroundRunner: immediateRunner() as never,
      debounceMs: 5,
      discover,
    });
    await daemon.start();
    await waitUntil(() => !daemon.status('madison').freshness.dirty);
    const initialGeneration = daemon.status('madison').completeGeneration;
    await new Promise((resolve) => setTimeout(resolve, 100));

    writeFileSync(knowledge, 'version two knowledge');
    await waitUntil(
      () =>
        daemon.status('madison').completeGeneration > initialGeneration && !daemon.status('madison').freshness.dirty,
      5_000,
    );
    expect((await daemon.query('madison', 'version two knowledge')).nodes.length).toBeGreaterThan(0);
    expect(discover).toHaveBeenCalledTimes(1);

    const changedGeneration = daemon.status('madison').completeGeneration;
    rmSync(knowledge);
    await waitUntil(
      () =>
        daemon.status('madison').completeGeneration > changedGeneration && !daemon.status('madison').freshness.dirty,
      5_000,
    );
    expect((await daemon.query('madison', 'version two knowledge')).nodes).toHaveLength(0);
    expect(discover).toHaveBeenCalledTimes(1);
    await daemon.close();
  });

  it('drains a quiet workgroup while a sibling is dirty or queued behind the lane', async () => {
    const f = fixture();
    // A second workgroup that will stay permanently busy.
    const central = new Database(f.central);
    central.exec(`
      INSERT INTO workgroups VALUES ('sibling');
      INSERT INTO agent_groups VALUES ('ag-b', 'sibling-agent', 'sibling');
    `);
    central.close();
    mkdirSync(join(f.groups, 'sibling-agent'));
    writeFileSync(join(f.groups, 'sibling-agent', 'busy.md'), 'sibling knowledge');
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'quiet workgroup knowledge');

    const semanticBackend = {
      extract: vi.fn(async () => ({ nodes: [], edges: [], hyperedges: [] })),
      extractBatch: vi.fn(
        async (items: Array<{ source: SourceInput }>) =>
          new Map(
            items.map(({ source }) => [source.id, { nodes: [], edges: [], hyperedges: [] } satisfies ExtractionBundle]),
          ),
      ),
    };
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      semanticBackend,
      backgroundRunner: immediateRunner() as never,
      semanticMinIntervalMs: 0,
      semanticPumpDelayMs: 0,
    });
    await daemon.refreshCatalog();

    // Pin the sibling into each state that used to veto the whole fleet. Before
    // this fix the gate was `some(...)` across every workgroup, so one busy
    // sibling starved every other queue indefinitely.
    const states = (daemon as unknown as { states: Map<string, Record<string, unknown>> }).states;
    const sibling = states.get('sibling')!;

    for (const busy of ['dirty', 'archiveDirty', 'backgroundQueued'] as const) {
      sibling.dirty = false;
      sibling.archiveDirty = false;
      sibling.backgroundQueued = false;
      sibling[busy] = true;

      writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), `quiet workgroup knowledge ${busy}`);
      await daemon.ensureFresh('madison');
      // Real reconcile + enrich per iteration; leave headroom for the full suite
      // running in parallel, matching the other reconciliation waits in this file.
      await waitUntil(() => daemon.status('madison').freshness.pendingEnrichment === 0, 5_000);

      expect(daemon.status('madison').freshness.pendingEnrichment).toBe(0);
      expect(daemon.status('madison').freshness.enrichmentEligible).toBe(true);
      expect(daemon.status('sibling').freshness.enrichmentEligible).toBe(false);
    }

    await daemon.close();
  });

  it('removes semantic queue and cache state when an indexed source is deleted', async () => {
    const f = fixture();
    const root = join(f.groups, 'madison-agent');
    const knowledge = join(root, 'brief.md');
    writeFileSync(knowledge, 'temporary semantic knowledge');
    const semanticBackend = {
      extract: vi.fn(async () => ({ nodes: [], edges: [], hyperedges: [] })),
      extractBatch: vi.fn(
        async (items: Array<{ source: SourceInput }>) =>
          new Map(
            items.map(({ source }) => [
              source.id,
              {
                nodes: [{ id: `concept-${source.id}`, name: 'Temporary concept', type: 'concept' }],
                edges: [],
                hyperedges: [],
              } satisfies ExtractionBundle,
            ]),
          ),
      ),
    };
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      semanticBackend,
      backgroundRunner: immediateRunner() as never,
      semanticMinIntervalMs: 0,
      semanticPumpDelayMs: 0,
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');
    await waitUntil(() => daemon.status('madison').freshness.pendingEnrichment === 0);
    const enrichmentPath = join(f.data, 'graphify', 'enrichment.db');
    const before = new Database(enrichmentPath, { readonly: true });
    expect(
      (
        before.prepare("SELECT count(*) AS count FROM enrichments WHERE workgroup_id='madison'").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    before.close();

    rmSync(knowledge);
    daemon.markFilesystemChanges('madison', [{ root, path: knowledge, kind: 'unlink' }]);
    await daemon.ensureFresh('madison');

    const after = new Database(enrichmentPath, { readonly: true });
    expect(
      (
        after.prepare("SELECT count(*) AS count FROM enrichments WHERE workgroup_id='madison'").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect(
      (
        after.prepare("SELECT count(*) AS count FROM semantic_queue WHERE workgroup_id='madison'").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    after.close();
    expect((await daemon.query('madison', 'Temporary concept')).nodes).toHaveLength(0);
    await daemon.close();
  });

  it('repairs stale enrichment rows against the last complete generation on restart', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'retained graph knowledge');
    const initial = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
    });
    await initial.refreshCatalog();
    await initial.ensureFresh('madison');
    await initial.close();

    const enrichmentPath = join(f.data, 'graphify', 'enrichment.db');
    const repository = new EnrichmentRepository(enrichmentPath);
    repository.put({
      sourceId: 'stale-source',
      workgroupId: 'madison',
      contentHash: 'stale',
      semantic: { nodes: [], edges: [], hyperedges: [] },
    });
    repository.enqueue([
      {
        source: {
          id: 'stale-source',
          workgroupId: 'madison',
          kind: 'document',
          relativePath: 'deleted.md',
          contentHash: 'stale',
        },
        segments: ['deleted knowledge'],
        priority: 1,
      },
    ]);
    repository.close();

    const restarted = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      backgroundRunner: { run: vi.fn(async () => ({ status: 'deferred' })) } as never,
    });
    await restarted.start();

    const repaired = new Database(enrichmentPath, { readonly: true });
    expect(
      (
        repaired.prepare("SELECT count(*) AS count FROM enrichments WHERE source_id='stale-source'").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect(
      (
        repaired.prepare("SELECT count(*) AS count FROM semantic_queue WHERE source_id='stale-source'").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    repaired.close();
    await restarted.close();
  });

  it('serves the complete generation immediately while a filesystem delta is pending', async () => {
    const f = fixture();
    const root = join(f.groups, 'madison-agent');
    const knowledge = join(root, 'brief.md');
    writeFileSync(knowledge, 'stable generation knowledge');
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');
    const initialGeneration = daemon.status('madison').completeGeneration;

    daemon.pause('madison');
    writeFileSync(knowledge, 'incremental generation knowledge');
    daemon.markFilesystemChanges('madison', [{ root, path: knowledge, kind: 'change' }]);
    const stable = await Promise.race([
      daemon.query('madison', 'stable generation knowledge'),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('interactive read waited for filesystem reconciliation')), 250),
      ),
    ]);
    expect(stable.nodes.length).toBeGreaterThan(0);
    expect(daemon.status('madison').freshness).toMatchObject({ dirty: true, paused: true });

    daemon.resume('madison');
    await waitUntil(
      () =>
        daemon.status('madison').completeGeneration > initialGeneration && !daemon.status('madison').freshness.dirty,
      5_000,
    );
    expect((await daemon.query('madison', 'incremental generation knowledge')).nodes.length).toBeGreaterThan(0);
    expect((await daemon.query('madison', 'stable generation knowledge')).nodes).toHaveLength(0);
    await daemon.close();
  });

  it('removes incomplete next-generation databases left by an interrupted process', async () => {
    const f = fixture();
    const graphDir = join(f.data, 'graphify', 'workgroups', 'madison');
    mkdirSync(graphDir, { recursive: true });
    const staleDb = join(graphDir, 'index.next-interrupted.db');
    const staleWal = `${staleDb}-wal`;
    writeFileSync(staleDb, 'partial');
    writeFileSync(staleWal, 'partial');
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'stable knowledge');
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');
    expect(existsSync(staleDb)).toBe(false);
    expect(existsSync(staleWal)).toBe(false);
    expect(existsSync(join(graphDir, 'index.db'))).toBe(true);
    await daemon.close();
  });

  it('indexes malformed structured text without blocking the workgroup generation', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'valid strategy knowledge');
    writeFileSync(join(f.groups, 'madison-agent', 'partial.json'), '{"unfinished":');
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
    });
    await daemon.refreshCatalog();
    const status = await daemon.ensureFresh('madison');
    expect(status.freshness.dirty).toBe(false);
    expect(status.counts.failed).toBe(0);
    expect(status.failures).toEqual([]);
    expect((await daemon.query('madison', 'valid strategy knowledge')).nodes.length).toBeGreaterThan(0);
    expect((await daemon.query('madison', 'unfinished')).nodes.length).toBeGreaterThan(0);
    await daemon.close();
  });

  it('canonical semantic entities bridge conversations documents and SQL without stale payload', () => {
    const root = temp();
    const store = new WorkgroupGraphStore(join(root, 'index.db'), 'madison');
    const sources: SourceInput[] = [
      {
        id: 'conversation',
        workgroupId: 'madison',
        kind: 'conversation',
        relativePath: 'conversations/thread.conversation',
        contentHash: 'a',
      },
      {
        id: 'document',
        workgroupId: 'madison',
        kind: 'document',
        relativePath: 'workgroup/brief.md',
        contentHash: 'b',
      },
      { id: 'sql', workgroupId: 'madison', kind: 'code', relativePath: 'agents/ag-a/models/ltv.sql', contentHash: 'c' },
    ];
    const descriptions = ['business definition', 'planning definition', 'SQL implementation'];
    const upserts = sources.map((source, index) => {
      const semantic = namespaceSemantic(source, {
        nodes: [
          {
            id: `local-${index}`,
            name: index === 1 ? 'customer ltv' : 'Customer LTV',
            type: 'metric',
            description: descriptions[index],
          },
        ],
        edges: [],
        hyperedges: [],
      });
      const rootId = semantic.edges.find((edge) => edge.type === 'mentions')!.from;
      const rootNode = {
        id: rootId,
        name: source.relativePath,
        type: source.kind,
        evidence: [{ sourceId: source.id, relativePath: source.relativePath }],
      };
      const semanticBundle = { ...semantic, nodes: [rootNode, ...semantic.nodes] };
      if (source.id !== 'sql') return { source, bundle: semanticBundle };
      const structural = bridgeCodeBundle(source, {
        nodes: [
          {
            id: 'sql-model',
            name: 'customer_ltv_model',
            type: 'model',
            evidence: [{ sourceId: source.id, relativePath: source.relativePath, line: 1 }],
          },
        ],
        edges: [],
        hyperedges: [],
      });
      return {
        source,
        bundle: {
          nodes: [...semanticBundle.nodes, ...structural.nodes],
          edges: [...semanticBundle.edges, ...structural.edges],
          hyperedges: [],
        },
      };
    });
    store.reconcileSources('semantic bridge', upserts, []);
    const canonical = store.query('Customer LTV', { limit: 20 }).nodes.find((node) => node.type === 'metric')!;
    expect(canonical.evidence.map((item) => item.sourceId).sort()).toEqual(['conversation', 'document', 'sql']);
    expect(canonical.description).toBeUndefined();
    const rootsBySource = new Map(
      upserts.map((item) => [item.source.id, item.bundle.edges.find((edge) => edge.type === 'mentions')!.from]),
    );
    expect(store.path(rootsBySource.get('conversation')!, rootsBySource.get('document')!)).not.toBeNull();
    expect(store.path(rootsBySource.get('conversation')!, rootsBySource.get('sql')!)).not.toBeNull();
    expect(store.path(rootsBySource.get('conversation')!, 'sql-model')).not.toBeNull();
    store.reconcileSources('remove document', [], ['document']);
    const after = store.explain(canonical.id)!;
    expect(after.evidence.map((item) => item.sourceId).sort()).toEqual(['conversation', 'sql']);
    expect(after.node.description).toBeUndefined();
    expect(store.query('planning definition').nodes).toHaveLength(0);
    store.close();
  });
  it('test_daemon_indexes_canonical_clones_gitignored_and_untracked_files', async () => {
    const f = fixture();
    const repo = join(f.groups, 'madison-agent', 'analytics');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.gitignore'), 'ignored.md\n');
    writeFileSync(join(repo, 'ignored.md'), 'retention cohort definition');
    writeFileSync(join(repo, 'untracked.md'), 'merchandising experiment brief');
    const discover = vi.fn(discoverWorkgroup);
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      discover,
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');
    const ignored = (await daemon.query('madison', 'retention cohort')) as GraphQueryResult;
    const untracked = (await daemon.query('madison', 'merchandising experiment')) as GraphQueryResult;
    expect(ignored.nodes.flatMap((node) => node.evidence.map((e) => e.relativePath))).toContain(
      'agents/ag-a/analytics/ignored.md',
    );
    expect(untracked.nodes.flatMap((node) => node.evidence.map((e) => e.relativePath))).toContain(
      'agents/ag-a/analytics/untracked.md',
    );
    await daemon.close();
  });

  it('indexes workgroup files and every sibling agent folder without crossing workgroup boundaries', async () => {
    const f = fixture();
    const db = new Database(f.central);
    db.exec(`
      INSERT INTO agent_groups VALUES ('ag-b', 'madison-codex', 'madison');
      INSERT INTO workgroups VALUES ('other');
      INSERT INTO agent_groups VALUES ('ag-other', 'other-agent', 'other');
    `);
    db.close();
    mkdirSync(join(f.data, 'workgroups', 'madison'), { recursive: true });
    mkdirSync(join(f.groups, 'madison-codex'));
    mkdirSync(join(f.groups, 'other-agent'));
    writeFileSync(join(f.data, 'workgroups', 'madison', 'shared.md'), 'shared workgroup operating decision');
    writeFileSync(join(f.groups, 'madison-agent', 'primary.md'), 'primary agent private knowledge');
    writeFileSync(join(f.groups, 'madison-codex', 'sibling.md'), 'codex sibling private knowledge');
    writeFileSync(join(f.groups, 'other-agent', 'other.md'), 'other workgroup secret knowledge');

    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');

    const evidenceFor = async (query: string): Promise<string[]> =>
      (await daemon.query('madison', query)).nodes.flatMap((node) =>
        node.evidence.map((evidence) => evidence.relativePath),
      );
    expect(await evidenceFor('shared workgroup operating')).toContain('workgroup/shared.md');
    expect(await evidenceFor('primary agent private')).toContain('agents/ag-a/primary.md');
    expect(await evidenceFor('codex sibling private')).toContain('agents/ag-b/sibling.md');
    expect(await evidenceFor('other workgroup secret')).toHaveLength(0);
    await daemon.close();
  });

  it('resolves unique labels and rejects ambiguous or unknown graph references', async () => {
    const f = fixture();
    mkdirSync(join(f.groups, 'madison-agent', 'one'));
    mkdirSync(join(f.groups, 'madison-agent', 'two'));
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'unique brief');
    writeFileSync(join(f.groups, 'madison-agent', 'one', 'same.md'), 'one');
    writeFileSync(join(f.groups, 'madison-agent', 'two', 'same.md'), 'two');
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
    });
    await daemon.refreshCatalog();
    expect((await daemon.explain('madison', 'BRIEF.MD'))?.node.name).toBe('brief.md');
    await expect(daemon.explain('madison', 'same.md')).rejects.toThrow(/ambiguous/);
    await expect(daemon.affected('madison', 'not-present')).rejects.toThrow(/unknown/);
    await daemon.close();
  });

  it('test_daemon_deletion_preserves_last_complete_generation_on_failure', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'stable baseline insight');
    let fail = false;
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      discover: async (options) => {
        if (fail) throw new Error('filesystem failure');
        return discoverWorkgroup(options);
      },
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');
    fail = true;
    daemon.markDirty('madison');
    await daemon.ensureFresh('madison');
    const result = (await daemon.query('madison', 'stable baseline')) as GraphQueryResult;
    expect(result.nodes.length).toBeGreaterThan(0);
    expect((await daemon.status('madison')).freshness.lastFailure).toContain('filesystem failure');
    await daemon.close();
  });

  it('test_initial_query_waits_for_first_generation_but_not_enrichment', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'fresh.md'), 'fresh deterministic knowledge');
    const enrich = { run: vi.fn(() => new Promise(() => {})) };
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      backgroundRunner: enrich as never,
      semanticBackend: { extract: vi.fn(async () => ({ nodes: [], edges: [], hyperedges: [] })) },
    });
    await daemon.refreshCatalog();
    const result = (await daemon.query('madison', 'fresh deterministic')) as GraphQueryResult;
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(enrich.run).toHaveBeenCalled();
    expect((await daemon.status('madison')).freshness.pendingEnrichment).toBeGreaterThan(0);
    await daemon.close();
  });

  it('test_thread_worktree_overlay_isolated_between_sessions', async () => {
    const f = fixture();
    const db = new Database(f.central);
    db.exec(`
      INSERT INTO messaging_groups VALUES ('mg1', 'discord:one');
      INSERT INTO messaging_groups VALUES ('mg2', 'discord:two');
      INSERT INTO sessions VALUES ('s1', 'ag-a', 'mg1', 'thread-one');
      INSERT INTO sessions VALUES ('s2', 'ag-a', 'mg2', 'thread-two');
    `);
    db.close();
    const one = join(f.data, 'v2-threads', 'thread-one', 'worktrees');
    const two = join(f.data, 'v2-threads', 'thread-two', 'worktrees');
    mkdirSync(one, { recursive: true });
    mkdirSync(two, { recursive: true });
    writeFileSync(join(one, 'draft.md'), 'alpha private draft');
    writeFileSync(join(two, 'draft.md'), 'beta private draft');
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      threadWorktrees: true,
      enableEnrichment: false,
    });
    await daemon.refreshCatalog();
    const a = (await daemon.query('madison', 'alpha private', 20, {
      agentGroupId: 'ag-a',
      sessionId: 's1',
    })) as GraphQueryResult;
    const b = (await daemon.query('madison', 'alpha private', 20, {
      agentGroupId: 'ag-a',
      sessionId: 's2',
    })) as GraphQueryResult;
    expect(a.nodes.length).toBeGreaterThan(0);
    expect(b.nodes).toHaveLength(0);
    await daemon.close();
  });

  it('test_daemon_status_exposes_freshness_pending_failures_and_quarantine', async () => {
    const f = fixture();
    const file = join(f.groups, 'madison-agent', 'unsafe.md');
    writeFileSync(file, 'unsafe');
    let fail = false;
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      discover: async (options) => {
        if (fail) throw new Error('later failure');
        return [
          {
            id: 'old',
            workgroupId: options.workgroupId,
            relativePath: 'unsafe.md',
            absolutePath: file,
            kind: 'document',
            bytes: 6,
            mtimeMs: 1,
            sha256: 'h',
            state: 'quarantined',
            stateReason: 'unsafe archive',
          },
        ];
      },
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');
    fail = true;
    daemon.markDirty('madison');
    await daemon.ensureFresh('madison');
    const status = await daemon.status('madison');
    expect(status.quarantines).toHaveLength(1);
    expect(status.freshness.dirty).toBe(true);
    expect(status.freshness.lastFailure).toContain('later failure');
    expect(status.freshness).toHaveProperty('pendingEnrichment');
    await daemon.close();
  });

  it('serializes startup reconciliation across workgroups', async () => {
    const f = fixture();
    const db = new Database(f.central);
    db.exec("INSERT INTO workgroups VALUES ('other'); INSERT INTO agent_groups VALUES ('ag-b','other-agent','other')");
    db.close();
    mkdirSync(join(f.groups, 'other-agent'));
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      discover: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return [];
      },
    });
    await daemon.start();
    await waitUntil(() => calls >= 2 && active === 0);
    expect(maximum).toBe(1);
    await daemon.close();
  });

  it('finishes an admitted deterministic baseline when interactive pressure begins', async () => {
    const f = fixture();
    let pressure = false;
    let started = false;
    let aborted = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const background = new BackgroundGraphRunner({
      sessionsRoot: join(f.data, 'none'),
      pressure: () => pressure,
      freeMemory: () => 10_000_000_000,
      pollMs: 10,
    });
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      backgroundRunner: background,
      discover: async (options) => {
        started = true;
        options.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        await gate;
        return [];
      },
    });
    await daemon.start();
    await waitUntil(() => started);
    pressure = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(aborted).toBe(false);
    release();
    await waitUntil(() => !daemon.status('madison').freshness.dirty);
    await daemon.close();
  });

  it('does not lose a watcher mutation that arrives during reconciliation', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'version one');
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      discover: async (options) => {
        calls += 1;
        if (calls === 1) await gate;
        return discoverWorkgroup(options);
      },
    });
    await daemon.refreshCatalog();
    const freshness = daemon.ensureFresh('madison');
    await waitUntil(() => calls === 1);
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'version two');
    daemon.markDirty('madison');
    release();
    await freshness;
    expect(calls).toBe(2);
    expect((await daemon.query('madison', 'version two')).nodes.length).toBeGreaterThan(0);
    expect(daemon.status('madison').freshness.dirty).toBe(false);
    await daemon.close();
  });

  it('archive polling queues only changed workgroups', async () => {
    const f = fixture();
    const central = new Database(f.central);
    central.exec(
      "INSERT INTO workgroups VALUES ('other'); INSERT INTO agent_groups VALUES ('ag-b','other-agent','other')",
    );
    central.close();
    mkdirSync(join(f.groups, 'other-agent'));
    const archive = new Database(join(f.data, 'archive.db'));
    archive.exec(`CREATE TABLE messages_archive (
      id TEXT PRIMARY KEY, agent_group_id TEXT, channel_type TEXT, role TEXT, text TEXT, sent_at TEXT)`);
    archive.close();
    const discover = vi.fn(discoverWorkgroup);
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      discover,
    });
    await daemon.refreshCatalog();
    expect(await daemon.pollArchiveOnce(false)).toEqual([]);
    const writer = new Database(join(f.data, 'archive.db'));
    writer
      .prepare("INSERT INTO messages_archive VALUES ('m','ag-a','discord','user','new','2026-01-01T00:00:00Z')")
      .run();
    writer.close();
    expect(await daemon.pollArchiveOnce(false)).toEqual(['madison']);
    expect(discover).not.toHaveBeenCalled();
    await daemon.close();
  });

  it('archive reconciliation updates the live DB in place and leaves unchanged source generations untouched', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'sentinel.md'), 'large stable sentinel');
    const archivePath = join(f.data, 'archive.db');
    createArchive(archivePath).close();
    const discover = vi.fn(discoverWorkgroup);
    const runner = immediateRunner();
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      archivePath,
      enableEnrichment: false,
      discover,
      backgroundRunner: runner as never,
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');
    await daemon.pollArchiveOnce(false);
    const indexPath = join(f.data, 'graphify', 'workgroups', 'madison', 'index.db');
    const beforeStat = statSync(indexPath);
    const beforeDb = new Database(indexPath, { readonly: true });
    const before = beforeDb
      .prepare("SELECT id, generation FROM sources WHERE relative_path='agents/ag-a/sentinel.md'")
      .get() as { id: string; generation: number };
    beforeDb.close();
    const calls = discover.mock.calls.length;
    const writer = new Database(archivePath);
    writer
      .prepare(
        `INSERT INTO messages_archive
      VALUES ('m1','ag-a','mg','discord','Strategy','thread','t1','user','u','Operator','new archive knowledge','2026-01-01T00:00:00.000Z')`,
      )
      .run();
    writer.close();
    expect(await daemon.pollArchiveOnce(true)).toEqual(['madison']);
    await waitUntil(() => !daemon.status('madison').freshness.dirty);
    const afterDb = new Database(indexPath, { readonly: true });
    const after = afterDb.prepare('SELECT generation FROM sources WHERE id=?').get(before.id) as { generation: number };
    const conversations = (
      afterDb
        .prepare("SELECT count(*) AS count FROM sources WHERE relative_path LIKE 'conversations/%' AND state='indexed'")
        .get() as { count: number }
    ).count;
    afterDb.close();
    expect(discover).toHaveBeenCalledTimes(calls);
    expect(after.generation).toBe(before.generation);
    expect(conversations).toBe(1);
    expect(statSync(indexPath).ino).toBe(beforeStat.ino);
    expect(existsSync(join(f.data, 'graphify', 'workgroups', 'madison', 'index.archive.db'))).toBe(false);
    await daemon.close();
  });

  it('rethrows a transient background discovery failure and retries to a clean generation', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'eventual success');
    let attempts = 0;
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      backgroundRunner: immediateRunner() as never,
      reconcileRetryBaseMs: 5,
      discover: async (options) => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient discovery');
        return discoverWorkgroup(options);
      },
    });
    await daemon.start();
    await waitUntil(() => attempts >= 2 && !daemon.status('madison').freshness.dirty);
    expect(daemon.status('madison').freshness.lastFailure).toBeUndefined();
    expect((await daemon.query('madison', 'eventual success')).nodes.length).toBeGreaterThan(0);
    await daemon.close();
  });

  it('retries a transient archive failure without replacing the last complete graph', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'stable during archive retry');
    const archivePath = join(f.data, 'archive.db');
    createArchive(archivePath).close();
    const realReader = new ArchiveConversationReader(archivePath);
    let reads = 0;
    const archiveReader = {
      read: (workgroupId: string, memberIds: string[]) => {
        reads += 1;
        if (reads === 2) throw new Error('transient archive read');
        return realReader.read(workgroupId, memberIds);
      },
    };
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      archivePath,
      archiveReader: archiveReader as ArchiveConversationReader,
      enableEnrichment: false,
      backgroundRunner: immediateRunner() as never,
      reconcileRetryBaseMs: 5,
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');
    await daemon.pollArchiveOnce(false);
    const writer = new Database(archivePath);
    writer
      .prepare(
        `INSERT INTO messages_archive
      VALUES ('m1','ag-a','mg','discord','Strategy','thread','t1','user','u','Operator','retry me','2026-01-01T00:00:00.000Z')`,
      )
      .run();
    writer.close();
    await daemon.pollArchiveOnce(true);
    await waitUntil(() => reads >= 3 && !daemon.status('madison').freshness.dirty);
    expect(daemon.status('madison').freshness.lastFailure).toBeUndefined();
    expect((await daemon.query('madison', 'retry me')).nodes.length).toBeGreaterThan(0);
    await daemon.close();
  });

  it('pause is isolated per workgroup', async () => {
    const f = fixture();
    const db = new Database(f.central);
    db.exec("INSERT INTO workgroups VALUES ('other'); INSERT INTO agent_groups VALUES ('ag-b','other-agent','other')");
    db.close();
    mkdirSync(join(f.groups, 'other-agent'));
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
    });
    await daemon.refreshCatalog();
    daemon.pause('madison');
    expect(daemon.status('madison').freshness.paused).toBe(true);
    expect(daemon.status('other').freshness.paused).toBe(false);
    await daemon.close();
  });

  it('pause aborts an active reconciliation and resume completes it', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'stable knowledge');
    let calls = 0;
    let started!: () => void;
    const activeDiscovery = new Promise<void>((resolve) => {
      started = resolve;
    });
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      discover: async (options) => {
        calls += 1;
        if (calls === 2) {
          started();
          await new Promise<never>((_resolve, reject) => {
            const abort = (): void => reject(new DOMException('paused', 'AbortError'));
            if (options.signal?.aborted) abort();
            else options.signal?.addEventListener('abort', abort, { once: true });
          });
        }
        return discoverWorkgroup(options);
      },
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');
    daemon.markDirty('madison');
    const reconciliation = daemon.ensureFresh('madison', 5_000);
    await activeDiscovery;

    daemon.pause('madison');
    await reconciliation;
    expect(daemon.status('madison').freshness).toMatchObject({ dirty: true, reconciling: false, paused: true });
    expect((await daemon.query('madison', 'stable knowledge')).nodes.length).toBeGreaterThan(0);
    expect(calls).toBe(2);

    daemon.resume('madison');
    await waitUntil(() => calls === 3 && !daemon.status('madison').freshness.dirty);
    expect(daemon.status('madison').freshness).toMatchObject({ dirty: false, reconciling: false, paused: false });
    await daemon.close();
  });

  it('serializes a full reindex behind an active foreground reconciliation', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'first');
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      backgroundRunner: immediateRunner() as never,
      discover: async (options) => {
        calls += 1;
        if (calls === 2) await gate;
        return discoverWorkgroup(options);
      },
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');
    daemon.markDirty('madison');
    const active = daemon.ensureFresh('madison');
    await waitUntil(() => calls === 2);
    const full = daemon.reindex('madison', true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(join(f.data, 'graphify', 'workgroups', 'madison', 'index.db'))).toBe(true);
    release();
    await Promise.all([active, full]);
    await waitUntil(() => calls === 3 && !daemon.status('madison').freshness.dirty);
    expect(daemon.status('madison').freshness).toMatchObject({ dirty: false, reconciling: false });
    await daemon.close();
  });

  it('keeps the complete generation queryable throughout a full reindex', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'stable maintenance knowledge');
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      backgroundRunner: immediateRunner() as never,
      discover: async (options) => {
        calls += 1;
        if (calls === 2) await gate;
        return discoverWorkgroup(options);
      },
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');

    await daemon.reindex('madison', true);
    await waitUntil(() => calls === 2);
    expect(existsSync(join(f.data, 'graphify', 'workgroups', 'madison', 'index.db'))).toBe(true);
    const stable = await Promise.race([
      daemon.query('madison', 'stable maintenance knowledge'),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('interactive read waited for full reindex')), 250),
      ),
    ]);
    expect(stable.nodes.length).toBeGreaterThan(0);
    expect(daemon.status('madison').freshness).toMatchObject({ dirty: true, reconciling: true });

    release();
    await waitUntil(() => !daemon.status('madison').freshness.dirty, 5_000);
    expect((await daemon.query('madison', 'stable maintenance knowledge')).nodes.length).toBeGreaterThan(0);
    await daemon.close();
  });

  it('keeps a full reindex durable while chat pressure preempts the background lane', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'durable rebuild');
    let pressure = false;
    const discover = vi.fn(discoverWorkgroup);
    const background = new BackgroundGraphRunner({
      sessionsRoot: join(f.data, 'none'),
      pressure: () => pressure,
      freeMemory: () => 10_000_000_000,
      pollMs: 10,
    });
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      discover,
      backgroundRunner: background,
      preemptRetryMs: 5,
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');
    expect(discover).toHaveBeenCalledTimes(1);
    pressure = true;
    await daemon.reindex('madison', true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(daemon.status('madison').freshness.dirty).toBe(true);
    expect(discover).toHaveBeenCalledTimes(1);
    pressure = false;
    await waitUntil(() => discover.mock.calls.length === 2 && !daemon.status('madison').freshness.dirty);
    expect((await daemon.query('madison', 'durable rebuild')).nodes.length).toBeGreaterThan(0);
    await daemon.close();
  });

  it('discovers and watches a workgroup added after startup without restart', async () => {
    const f = fixture();
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      backgroundRunner: immediateRunner() as never,
      catalogRefreshMs: 10,
    });
    await daemon.start();
    await waitUntil(() => !daemon.status('madison').freshness.dirty);
    const db = new Database(f.central);
    db.exec(
      "INSERT INTO workgroups VALUES ('new-wg'); INSERT INTO agent_groups VALUES ('new-agent','new-folder','new-wg')",
    );
    db.close();
    mkdirSync(join(f.groups, 'new-folder'));
    writeFileSync(join(f.groups, 'new-folder', 'new.md'), 'new workgroup knowledge');
    await waitUntil(() => daemon.hasWorkgroup('new-wg') && !daemon.status('new-wg').freshness.dirty);
    expect((await daemon.query('new-wg', 'new workgroup knowledge')).nodes.length).toBeGreaterThan(0);
    await daemon.close();
  });

  it('keeps deterministic indexing available when Docker orphan cleanup fails', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'available without docker');
    const codeWorker = {
      cleanupOrphans: vi.fn(async () => {
        throw new Error('docker unavailable');
      }),
      extract: vi.fn(async () => new Map()),
    };
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      enableEnrichment: false,
      codeWorker,
      backgroundRunner: immediateRunner() as never,
    });
    await daemon.start();
    await waitUntil(() => !daemon.status('madison').freshness.dirty);
    expect((await daemon.query('madison', 'available without docker')).nodes.length).toBeGreaterThan(0);
    expect(codeWorker.cleanupOrphans).toHaveBeenCalledTimes(1);
    await daemon.close();
  });

  it('routes TOML to semantic enrichment instead of the code worker', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'app.ts'), 'export const value = 1;');
    writeFileSync(join(f.groups, 'madison-agent', 'agent_config.toml'), 'name = "research"');
    const codeWorker = {
      extract: vi.fn(async () => new Map()),
    };
    const semanticBackend = {
      extract: vi.fn(async () => ({ nodes: [], edges: [], hyperedges: [] })),
      extractBatch: vi.fn(async () => new Map()),
    };
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      codeWorker,
      semanticBackend,
      backgroundRunner: immediateRunner() as never,
      semanticMinIntervalMs: 0,
      semanticPumpDelayMs: 0,
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');
    await waitUntil(
      () => codeWorker.extract.mock.calls.length > 0 && semanticBackend.extractBatch.mock.calls.length > 0,
    );
    const codeCalls = codeWorker.extract.mock.calls as unknown as Array<
      [string, string, string, Array<{ relativePath: string }>]
    >;
    const semanticCalls = semanticBackend.extractBatch.mock.calls as unknown as Array<[Array<{ source: SourceInput }>]>;
    const codePaths = codeCalls.flatMap((call) => call[3].map((source) => source.relativePath));
    const semanticPaths = semanticCalls.flatMap((call) => call[0].map((item) => item.source.relativePath));
    expect(codePaths).toContain('agents/ag-a/app.ts');
    expect(codePaths).not.toContain('agents/ag-a/agent_config.toml');
    expect(semanticPaths).toContain('agents/ag-a/agent_config.toml');
    await daemon.close();
  });

  it('eventually enriches semantic jobs after repeated priority preemption', async () => {
    const f = fixture();
    writeFileSync(join(f.groups, 'madison-agent', 'brief.md'), 'durable customer lifetime value knowledge');
    let preemptions = 0;
    const backgroundRunner = {
      run: async (
        job: (signal: AbortSignal) => Promise<unknown>,
        options?: { priority?: 'freshness' | 'normal' | 'enrichment' },
      ) => {
        if (options?.priority !== 'freshness' && preemptions < 6) {
          preemptions += 1;
          return { status: 'preempted' };
        }
        return { status: 'completed', value: await job(new AbortController().signal) };
      },
    };
    const semanticBackend = {
      extract: vi.fn(async () => ({ nodes: [], edges: [], hyperedges: [] })),
      extractBatch: vi.fn(
        async (items: Array<{ source: SourceInput }>) =>
          new Map(
            items.map(({ source }) => [
              source.id,
              {
                nodes: [{ id: `concept-${source.id}`, name: 'Customer LTV', type: 'metric' }],
                edges: [],
                hyperedges: [],
              } satisfies ExtractionBundle,
            ]),
          ),
      ),
    };
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      semanticBackend,
      backgroundRunner: backgroundRunner as never,
      semanticMinIntervalMs: 0,
      semanticPumpDelayMs: 0,
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');
    await waitUntil(
      () =>
        semanticBackend.extractBatch.mock.calls.length === 1 &&
        daemon.status('madison').freshness.pendingEnrichment === 0,
      5_000,
    );
    expect(preemptions).toBe(6);
    expect((await daemon.query('madison', 'Customer LTV')).nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Customer LTV' })]),
    );
    await daemon.close();
  });

  it('bisects failed code batches so valid sources still receive enrichment', async () => {
    const f = fixture();
    for (const name of ['good-a.ts', 'good-b.ts', 'isolated-bad.py']) {
      writeFileSync(join(f.groups, 'madison-agent', name), `export const ${name.replace(/\W/g, '_')} = 1;`);
    }
    const successful = new Set<string>();
    const codeWorker = {
      extract: vi.fn(async (_workgroupId, _root, _prefix, sources: Array<{ id: string; relativePath: string }>) => {
        const containsBad = sources.some((source) => source.relativePath.endsWith('isolated-bad.py'));
        if (containsBad && sources.length > 1) throw new Error('one source rejected the batch');
        return new Map(
          sources.map((source) => {
            successful.add(source.relativePath);
            return [
              source.id,
              {
                nodes: [{ id: `symbol-${source.id}`, name: source.relativePath, type: 'symbol' }],
                edges: [],
                hyperedges: [],
              } satisfies ExtractionBundle,
            ];
          }),
        );
      }),
    };
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      codeWorker,
      backgroundRunner: immediateRunner() as never,
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');
    await waitUntil(() => successful.size === 3);
    expect(codeWorker.extract.mock.calls[0]?.[3]).toHaveLength(3);
    expect(
      codeWorker.extract.mock.calls.some(
        (call) =>
          (call[3] as Array<{ relativePath: string }>).length === 1 &&
          (call[3] as Array<{ relativePath: string }>)[0]?.relativePath.endsWith('isolated-bad.py'),
      ),
    ).toBe(true);
    expect(successful).toEqual(
      new Set(['agents/ag-a/good-a.ts', 'agents/ag-a/good-b.ts', 'agents/ag-a/isolated-bad.py']),
    );
    await daemon.close();
  });

  it('applies multiple enrichment batches to a 5000-source corpus without rediscovery', async () => {
    const f = fixture();
    const docPath = join(f.root, 'source.md');
    const mediaPath = join(f.root, 'source.mp4');
    writeFileSync(docPath, 'customer lifetime value');
    writeFileSync(mediaPath, 'binary');
    const docHash = createHash('sha256').update('customer lifetime value').digest('hex');
    const mediaHash = createHash('sha256').update('binary').digest('hex');
    const discovered = Array.from({ length: 5_000 }, (_, index) => {
      const knowledge = index < 51;
      const sql = index === 50;
      return {
        id: `raw-${index}`,
        workgroupId: 'madison',
        relativePath: knowledge ? (sql ? 'models/customer_ltv.sql' : `knowledge/${index}.md`) : `media/${index}.mp4`,
        absolutePath: knowledge ? docPath : mediaPath,
        kind: knowledge ? (sql ? ('code' as const) : ('document' as const)) : ('media' as const),
        bytes: knowledge ? 23 : 6,
        mtimeMs: 1,
        sha256: knowledge ? docHash : mediaHash,
        state: 'pending' as const,
      };
    });
    const discover = vi.fn(async () => discovered);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let semanticCalls = 0;
    const semanticBackend = {
      extract: vi.fn(async () => ({ nodes: [], edges: [], hyperedges: [] })),
      extractBatch: vi.fn(async (items: Array<{ source: SourceInput }>) => {
        semanticCalls += 1;
        if (semanticCalls === 1) await gate;
        return new Map(
          items.map(({ source }) => [
            source.id,
            {
              nodes: [{ id: `concept-${source.id}`, name: 'Customer LTV', type: 'metric' }],
              edges: [],
              hyperedges: [],
            } satisfies ExtractionBundle,
          ]),
        );
      }),
    };
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      discover,
      semanticBackend,
      backgroundRunner: immediateRunner() as never,
      semanticMinIntervalMs: 0,
      semanticPumpDelayMs: 0,
    });
    await daemon.refreshCatalog();
    await daemon.ensureFresh('madison');
    const indexPath = join(f.data, 'graphify', 'workgroups', 'madison', 'index.db');
    const beforeDb = new Database(indexPath, { readonly: true });
    const initialGeneration = (
      beforeDb.prepare('SELECT min(generation) AS generation FROM sources').get() as { generation: number }
    ).generation;
    beforeDb.close();
    release();
    await waitUntil(() => semanticCalls === 3 && daemon.status('madison').freshness.pendingEnrichment === 0, 20_000);
    const afterDb = new Database(indexPath, { readonly: true });
    const documentGeneration = (
      afterDb.prepare("SELECT generation FROM sources WHERE relative_path='agents/ag-a/knowledge/0.md'").get() as {
        generation: number;
      }
    ).generation;
    const mediaGeneration = (
      afterDb.prepare("SELECT generation FROM sources WHERE relative_path='agents/ag-a/media/4999.mp4'").get() as {
        generation: number;
      }
    ).generation;
    afterDb.close();
    expect(discover).toHaveBeenCalledTimes(1);
    expect(documentGeneration).toBeGreaterThan(initialGeneration);
    expect(mediaGeneration).toBe(initialGeneration);
    expect(semanticBackend.extractBatch).toHaveBeenCalledTimes(3);
    await daemon.close();
  }, 60_000);

  it('thread overlay stays searchable without launching synchronous code workers', async () => {
    const f = fixture();
    const db = new Database(f.central);
    db.exec(
      "INSERT INTO messaging_groups VALUES ('mg1','discord:one'); INSERT INTO sessions VALUES ('s1','ag-a','mg1','thread-one')",
    );
    db.close();
    const worktree = join(f.data, 'v2-threads', 'thread-one', 'worktrees');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'change.ts'), 'changed()');
    const codeWorker = {
      extract: vi.fn(
        async (_wg, _root, _prefix, sources) =>
          new Map([
            [
              sources[0].id,
              {
                nodes: [
                  { id: 'changed', name: 'changed', type: 'function' },
                  { id: 'dependent', name: 'dependent', type: 'function' },
                ],
                edges: [{ id: 'calls', from: 'dependent', to: 'changed', type: 'calls', structural: true }],
                hyperedges: [],
              },
            ],
          ]),
      ),
    };
    const daemon = new WorkgroupGraphDaemon({
      dataDir: f.data,
      groupsDir: f.groups,
      centralDbPath: f.central,
      threadWorktrees: true,
      enableEnrichment: false,
      codeWorker,
    });
    await daemon.refreshCatalog();
    const result = await daemon.query('madison', 'changed', 20, { agentGroupId: 'ag-a', sessionId: 's1' });
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(codeWorker.extract).not.toHaveBeenCalled();
    await daemon.close();
  });
});
