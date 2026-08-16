import { describe, expect, it, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { WorkgroupGraphStore } from '../../graphify/store.js';
import type { ExtractionBundle, SourceInput } from '../../graphify/types.js';
import {
  GRAPH_SCENT_BOUNDS,
  graphScentTerms,
  probeGraphScentWarmth,
  probeNextGraphScentWorkgroup,
  readGraphScent,
  _setGraphScentTestHooks,
  _resetGraphScentForTest,
} from './graph-scent.js';
import type { ContextNotice } from './pre-turn-context.js';

const roots: string[] = [];

afterEach(() => {
  _resetGraphScentForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A graphs root holding <workgroupId>/index.db, mirroring data/graphify/workgroups/. */
function makeGraphsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'graph-scent-'));
  roots.push(root);
  return root;
}

function seedGraph(
  graphsRoot: string,
  workgroupId: string,
  sources: Array<{ relativePath: string; text: string; type?: string }>,
  /** Directory override: the daemon builds a next index for the SAME workgroup in a staging path. */
  dirName: string = workgroupId,
): void {
  const store = new WorkgroupGraphStore(join(graphsRoot, dirName, 'index.db'), workgroupId);
  const generation = store.beginGeneration('scent-fixture');
  sources.forEach((entry, index) => {
    const sourceInput: SourceInput = {
      id: `src-${index}`,
      workgroupId,
      kind: 'document',
      relativePath: entry.relativePath,
      contentHash: `hash-${index}-${entry.text.length}`,
    };
    const bundle: ExtractionBundle = {
      nodes: [
        {
          id: `node-${index}`,
          name: entry.text,
          type: entry.type ?? 'document_chunk',
          description: entry.text,
          evidence: [{ sourceId: sourceInput.id, relativePath: entry.relativePath, line: 1, excerpt: entry.text }],
        },
      ],
      edges: [],
      hyperedges: [],
    };
    store.upsertSource(sourceInput, bundle, generation);
  });
  store.completeGeneration(generation);
  store.close();
}

function warm(graphsRoot: string, workgroupId: string): void {
  _setGraphScentTestHooks({ graphsRoot });
  probeGraphScentWarmth(workgroupId);
}

const QUERY = 'How does the forecast pipeline reconcile snowflake volume data?';

describe('graph scent terms (AC1, AC2)', () => {
  it('builds unstemmed exact terms from the raw query', () => {
    const terms = graphScentTerms('Which columns does the materialized view expose?');
    expect(terms).toContain('materialized');
    expect(terms).toContain('columns');
    expect(terms.length).toBeLessThanOrEqual(GRAPH_SCENT_BOUNDS.terms);
    expect(terms).not.toContain('materializ');
    expect(terms).not.toContain('column');
    expect(terms).not.toContain('which');
    expect(terms).not.toContain('does');
    expect(terms).not.toContain('the');
  });

  it('returns fewer than two terms as null', () => {
    const graphsRoot = makeGraphsRoot();
    seedGraph(graphsRoot, 'wg-a', [{ relativePath: 'workgroup/repo/a.md', text: 'forecast pipeline' }]);
    warm(graphsRoot, 'wg-a');
    const notices: ContextNotice[] = [];
    expect(readGraphScent('wg-a', 'the a is', notices)).toBeNull();
    expect(notices.some((n) => n.code === 'graph-scent-no-match')).toBe(true);
  });

  it('stays completely silent for a workgroup with no graph, whatever the input', () => {
    _setGraphScentTestHooks({ graphsRoot: makeGraphsRoot() });
    for (const query of ['the a is', QUERY]) {
      const notices: ContextNotice[] = [];
      expect(readGraphScent('wg-none', query, notices)).toBeNull();
      expect(notices).toHaveLength(0);
    }
  });

  it('matches exactly, not by prefix — the failed 8-prefix design cannot come back silently', () => {
    const graphsRoot = makeGraphsRoot();
    // Every content token is a MORPHOLOGICAL variant of a query token: a
    // prefix MATCH ("forecast"*) finds this document, an exact MATCH must not.
    seedGraph(graphsRoot, 'wg-a', [
      { relativePath: 'workgroup/repo/variants.md', text: 'forecasting pipelines snowflakes volumes reconciles' },
    ]);
    warm(graphsRoot, 'wg-a');
    const notices: ContextNotice[] = [];
    expect(readGraphScent('wg-a', 'forecast pipeline snowflake volume reconcile', notices)).toBeNull();
    expect(notices.some((n) => n.code === 'graph-scent-no-match')).toBe(true);
  });
});

describe('graph scent query (AC3, AC4, AC5)', () => {
  it('orders pointers by bm25 rank', () => {
    const graphsRoot = makeGraphsRoot();
    seedGraph(graphsRoot, 'wg-a', [
      { relativePath: 'workgroup/repo/weak.md', text: 'forecast mentioned once alongside unrelated prose here' },
      {
        relativePath: 'workgroup/repo/dense.md',
        text: 'forecast pipeline reconcile snowflake volume forecast pipeline snowflake volume reconcile',
      },
    ]);
    warm(graphsRoot, 'wg-a');
    const notices: ContextNotice[] = [];
    const scent = readGraphScent('wg-a', QUERY, notices);
    expect(scent).not.toBeNull();
    expect(scent!.pointers[0]!.path).toBe('workgroup/repo/dense.md');
  });

  it('deduplicates by basename, keeping the highest ranked', () => {
    const graphsRoot = makeGraphsRoot();
    seedGraph(graphsRoot, 'wg-a', [
      { relativePath: 'workgroup/a/x.ts', text: 'forecast pipeline snowflake volume reconcile data' },
      { relativePath: 'workgroup/b/x.ts', text: 'forecast pipeline snowflake' },
    ]);
    warm(graphsRoot, 'wg-a');
    const scent = readGraphScent('wg-a', QUERY, []);
    const kept = scent!.pointers.filter((p) => p.path.endsWith('/x.ts'));
    expect(kept).toHaveLength(1);
    // The HIGHER-ranked copy survives: workgroup/a/x.ts carries far more of
    // the query's terms than workgroup/b/x.ts.
    expect(kept[0]!.path).toBe('workgroup/a/x.ts');
  });

  it('excludes agents/ and conversations/ sources', () => {
    const graphsRoot = makeGraphsRoot();
    seedGraph(graphsRoot, 'wg-a', [
      { relativePath: 'agents/ag-1/clone/hit.md', text: 'forecast pipeline snowflake volume' },
      { relativePath: 'conversations/slack/hit.conversation', text: 'forecast pipeline snowflake volume' },
      { relativePath: 'workgroup/repo/hit.md', text: 'forecast pipeline snowflake volume' },
    ]);
    warm(graphsRoot, 'wg-a');
    const scent = readGraphScent('wg-a', QUERY, []);
    expect(scent!.pointers).toHaveLength(1);
    expect(scent!.pointers[0]!.path).toBe('workgroup/repo/hit.md');
  });
});

describe('graph scent degradation (AC6)', () => {
  it('returns null and a degraded notice when the graph is absent', () => {
    const graphsRoot = makeGraphsRoot();
    _setGraphScentTestHooks({ graphsRoot });
    // Warmth cannot exist for a graph that never probed; force the warm mark to
    // isolate the open failure from the cold refusal.
    _setGraphScentTestHooks({ graphsRoot, forceWarm: ['wg-missing'] });
    const notices: ContextNotice[] = [];
    expect(readGraphScent('wg-missing', QUERY, notices)).toBeNull();
    const notice = notices.find((n) => n.code === 'graph-scent-unavailable');
    expect(notice?.status).toBe('degraded');
  });
});

describe('graph scent freshness (AC7)', () => {
  it('treats a promoted index as cold until reprobed, then serves it', () => {
    const graphsRoot = makeGraphsRoot();
    seedGraph(graphsRoot, 'wg-a', [
      { relativePath: 'workgroup/repo/old.md', text: 'forecast pipeline snowflake volume' },
    ]);
    // The daemon's promote: a NEXT index for the same workgroup, renamed over.
    seedGraph(
      graphsRoot,
      'wg-a',
      [{ relativePath: 'workgroup/repo/new.md', text: 'forecast pipeline snowflake volume' }],
      'wg-a-next',
    );
    warm(graphsRoot, 'wg-a');
    const first = readGraphScent('wg-a', QUERY, []);
    expect(first!.pointers[0]!.path).toBe('workgroup/repo/old.md');
    renameSync(join(graphsRoot, 'wg-a-next', 'index.db'), join(graphsRoot, 'wg-a', 'index.db'));
    // The warm mark was earned against the OLD file's identity: the promoted
    // index must NOT be queried on the strength of it. Identical query string,
    // so any result caching would also be exposed here.
    const notices: ContextNotice[] = [];
    expect(readGraphScent('wg-a', QUERY, notices)).toBeNull();
    expect(notices.some((n) => n.code === 'graph-scent-cold')).toBe(true);
    // A fresh probe re-verifies the new file; only then is it served.
    probeGraphScentWarmth('wg-a');
    const second = readGraphScent('wg-a', QUERY, []);
    expect(second!.pointers[0]!.path).toBe('workgroup/repo/new.md');
  });

  it('unmarks warmth when a query fails, so failures do not repeat per turn', () => {
    const graphsRoot = makeGraphsRoot();
    seedGraph(graphsRoot, 'wg-a', [{ relativePath: 'workgroup/repo/a.md', text: 'forecast pipeline snowflake' }]);
    warm(graphsRoot, 'wg-a');
    let opens = 0;
    _setGraphScentTestHooks({
      graphsRoot,
      open: () => {
        opens += 1;
        throw new Error('database is locked');
      },
    });
    const firstNotices: ContextNotice[] = [];
    expect(readGraphScent('wg-a', QUERY, firstNotices)).toBeNull();
    expect(firstNotices.some((n) => n.code === 'graph-scent-read-failed')).toBe(true);
    expect(opens).toBe(1);
    // Second turn: the failure unmarked the workgroup, so no further open.
    const secondNotices: ContextNotice[] = [];
    expect(readGraphScent('wg-a', QUERY, secondNotices)).toBeNull();
    expect(secondNotices.some((n) => n.code === 'graph-scent-cold')).toBe(true);
    expect(opens).toBe(1);
  });
});

describe('graph scent warm gating (AC8, AC9, AC10)', () => {
  it('does not query a cold workgroup', () => {
    const graphsRoot = makeGraphsRoot();
    seedGraph(graphsRoot, 'wg-a', [{ relativePath: 'workgroup/repo/a.md', text: 'forecast pipeline snowflake' }]);
    let opens = 0;
    _setGraphScentTestHooks({
      graphsRoot,
      open: (dbPath) => {
        opens += 1;
        return new Database(dbPath, { readonly: true, fileMustExist: true });
      },
    });
    const notices: ContextNotice[] = [];
    expect(readGraphScent('wg-a', QUERY, notices)).toBeNull();
    expect(opens).toBe(0);
    expect(notices.some((n) => n.code === 'graph-scent-cold')).toBe(true);
  });

  it('a probe inside budget marks the workgroup warm', () => {
    const graphsRoot = makeGraphsRoot();
    seedGraph(graphsRoot, 'wg-a', [{ relativePath: 'workgroup/repo/a.md', text: 'forecast pipeline snowflake' }]);
    const ticks = [0, 100];
    _setGraphScentTestHooks({ graphsRoot, clock: () => ticks.shift() ?? 100 });
    expect(probeGraphScentWarmth('wg-a')).toBe(100);
    const scent = readGraphScent('wg-a', QUERY, []);
    expect(scent).not.toBeNull();
    expect(scent!.pointers.length).toBeGreaterThan(0);
  });

  it('a probe over budget leaves the workgroup cold and unmarks a warm one', () => {
    const graphsRoot = makeGraphsRoot();
    seedGraph(graphsRoot, 'wg-a', [{ relativePath: 'workgroup/repo/a.md', text: 'forecast pipeline snowflake' }]);
    warm(graphsRoot, 'wg-a');
    expect(readGraphScent('wg-a', QUERY, [])).not.toBeNull();

    const ticks = [0, 900];
    _setGraphScentTestHooks({ graphsRoot, clock: () => ticks.shift() ?? 900 });
    expect(probeGraphScentWarmth('wg-a')).toBe(900);

    let opens = 0;
    _setGraphScentTestHooks({
      graphsRoot,
      open: (dbPath) => {
        opens += 1;
        return new Database(dbPath, { readonly: true, fileMustExist: true });
      },
    });
    const notices: ContextNotice[] = [];
    expect(readGraphScent('wg-a', QUERY, notices)).toBeNull();
    expect(opens).toBe(0);
    expect(notices.some((n) => n.code === 'graph-scent-cold')).toBe(true);
  });
});

describe('large-graph re-warm bar (watch-item lever, fired 2026-08-16)', () => {
  it('a large graph needs consecutive clean probes to warm; one is not enough', () => {
    const graphsRoot = makeGraphsRoot();
    seedGraph(graphsRoot, 'wg-big', [{ relativePath: 'workgroup/repo/a.md', text: 'forecast pipeline snowflake' }]);
    // Treat ANY graph as large so the fixture exercises the bar.
    _setGraphScentTestHooks({ graphsRoot, largeGraphBytes: 1 });
    probeGraphScentWarmth('wg-big');
    const notices: ContextNotice[] = [];
    expect(readGraphScent('wg-big', QUERY, notices)).toBeNull();
    expect(notices.some((n) => n.code === 'graph-scent-cold')).toBe(true);
    probeGraphScentWarmth('wg-big');
    probeGraphScentWarmth('wg-big');
    expect(readGraphScent('wg-big', QUERY, [])).not.toBeNull();
  });

  it('an over-budget probe resets the streak', () => {
    const graphsRoot = makeGraphsRoot();
    seedGraph(graphsRoot, 'wg-big', [{ relativePath: 'workgroup/repo/a.md', text: 'forecast pipeline snowflake' }]);
    _setGraphScentTestHooks({ graphsRoot, largeGraphBytes: 1 });
    probeGraphScentWarmth('wg-big');
    probeGraphScentWarmth('wg-big');
    const ticks = [0, 900];
    _setGraphScentTestHooks({ graphsRoot, largeGraphBytes: 1, clock: () => ticks.shift() ?? 900 });
    probeGraphScentWarmth('wg-big'); // slow — streak dies
    _setGraphScentTestHooks({ graphsRoot, largeGraphBytes: 1 });
    probeGraphScentWarmth('wg-big'); // clean again, streak = 1 of 3
    expect(readGraphScent('wg-big', QUERY, [])).toBeNull();
  });

  it('small graphs keep the single-probe bar', () => {
    const graphsRoot = makeGraphsRoot();
    seedGraph(graphsRoot, 'wg-small', [{ relativePath: 'workgroup/repo/a.md', text: 'forecast pipeline snowflake' }]);
    _setGraphScentTestHooks({ graphsRoot });
    probeGraphScentWarmth('wg-small');
    expect(readGraphScent('wg-small', QUERY, [])).not.toBeNull();
  });
});

describe('sweep probe rotation', () => {
  it('probes one workgroup per call, round-robin', () => {
    const graphsRoot = makeGraphsRoot();
    seedGraph(graphsRoot, 'wg-a', [{ relativePath: 'workgroup/repo/a.md', text: 'alpha schema' }]);
    seedGraph(graphsRoot, 'wg-b', [{ relativePath: 'workgroup/repo/b.md', text: 'beta schema' }]);
    _setGraphScentTestHooks({ graphsRoot });
    const first = probeNextGraphScentWorkgroup();
    const second = probeNextGraphScentWorkgroup();
    const third = probeNextGraphScentWorkgroup();
    expect([first?.workgroupId, second?.workgroupId]).toEqual(['wg-a', 'wg-b']);
    expect(third?.workgroupId).toBe('wg-a');
  });

  it('returns null when no graphs exist', () => {
    _setGraphScentTestHooks({ graphsRoot: makeGraphsRoot() });
    expect(probeNextGraphScentWorkgroup()).toBeNull();
  });
});

describe('bounds', () => {
  it('returns null rather than an over-bound scent when the only pointer exceeds the budget', () => {
    const graphsRoot = makeGraphsRoot();
    const hugeSegment = 'pathological-directory-segment-'.repeat(24);
    seedGraph(graphsRoot, 'wg-a', [
      {
        relativePath: `workgroup/${hugeSegment}/forecast.md`,
        text: 'forecast pipeline snowflake volume reconcile data',
      },
    ]);
    warm(graphsRoot, 'wg-a');
    const notices: ContextNotice[] = [];
    expect(readGraphScent('wg-a', QUERY, notices)).toBeNull();
    expect(notices.some((n) => n.code === 'graph-scent-no-match')).toBe(true);
  });

  it('keeps the serialized scent inside its char bound', () => {
    const graphsRoot = makeGraphsRoot();
    const longSegment = 'very-long-directory-name-segment-'.repeat(4);
    seedGraph(
      graphsRoot,
      'wg-a',
      Array.from({ length: 8 }, (_, index) => ({
        relativePath: `workgroup/${longSegment}${index}/forecast-pipeline-snowflake-volume-file-${index}.md`,
        text: 'forecast pipeline snowflake volume reconcile data',
      })),
    );
    warm(graphsRoot, 'wg-a');
    const scent = readGraphScent('wg-a', QUERY, []);
    expect(scent).not.toBeNull();
    expect(JSON.stringify(scent).length).toBeLessThanOrEqual(GRAPH_SCENT_BOUNDS.chars);
  });
});
