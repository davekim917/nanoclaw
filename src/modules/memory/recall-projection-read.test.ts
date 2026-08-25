/**
 * Recall projection READ SEAM (docs/specs/workgroup-cerebro/plan.md §P2.5.6
 * step 6): P2.5-AC1, AC2, AC3, AC6, AC7, AC9, AC11, AC12, AC13, AC14, AC15,
 * AC16, AC18, AC19, AC20.
 *
 * Real temp SQLite files, real trees, no mocking of `better-sqlite3`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GENERATED_MEMORY_RELATIVE_PATH } from './curator-contract.js';
import {
  _recallProjectionWarmForTest,
  _resetRecallProjectionForTest,
  _resetTokenStreamCacheForTest,
  _setRecallProjectionTestHooks,
  _tokenStreamCacheStatsForTest,
  frozenBoundsJson,
  LANE_EXCERPT_CHARS,
  PRE_TURN_BOUNDS,
  projectionTreeStaleness,
  readMemoryEvidence,
  tokenizeForRecall,
  warmRecallProjection,
  type ContextNotice,
  type PreTurnContext,
  type RecallCandidateStats,
} from './pre-turn-context.js';
import {
  buildAndPromoteProjection,
  hydrateCandidates,
  openProjectionDb,
  projectionDir,
  projectionPath,
  queryTermCandidates,
} from './recall-projection.js';

const temporaryDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `recall-read-${prefix}-`));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  _resetRecallProjectionForTest();
  _resetTokenStreamCacheForTest();
  vi.restoreAllMocks();
  while (temporaryDirs.length > 0) fs.rmSync(temporaryDirs.pop()!, { recursive: true, force: true });
});

function writeFile(root: string, relative: string, content: string | Buffer): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function factLine(text: string, id: string, capturedAt: string): string {
  return `- ${text} <!-- nanoclaw-memory:id=${id};evidence=msg_1;captured=${capturedAt} -->`;
}

function ledger(...lines: string[]): string {
  return ['# Generated workgroup memory', '', ...lines, ''].join('\n');
}

const WORKGROUP = 'wg-read';

interface Served {
  evidence: PreTurnContext['memoryEvidence'];
  notices: ContextNotice[];
  stats: RecallCandidateStats;
}

interface ServeOptions {
  bootstrap?: boolean;
  senders?: string[];
  seen?: Set<string>;
}

function serve(root: string, query: string, options: ServeOptions = {}): Served {
  const notices: ContextNotice[] = [];
  const stats: RecallCandidateStats = {
    factCandidates: 0,
    fileCandidates: 0,
    recallPath: 'fallback',
    recallReason: 'not-reached',
  };
  const evidence = readMemoryEvidence(
    root,
    WORKGROUP,
    query,
    notices,
    options.bootstrap ?? false,
    options.seen ?? new Set<string>(),
    false,
    options.senders ?? [],
    stats,
  );
  return { evidence, notices, stats };
}

/** Build and promote a projection for `root`; returns the fake DATA_DIR holding it. */
function buildProjection(root: string): string {
  const dataDir = scratch('data');
  buildAndPromoteProjection({ root, directory: projectionDir(WORKGROUP, dataDir) });
  return dataDir;
}

/** Point the seam at `dataDir` with a manual scheduler; returns the queue. */
function attach(dataDir: string): Array<() => void> {
  const queue: Array<() => void> = [];
  _setRecallProjectionTestHooks({
    dataDir,
    schedule: (run) => {
      queue.push(run);
    },
  });
  return queue;
}

/** Build, attach, and warm in one step — the ordinary "projection is live" state. */
function live(root: string): { dataDir: string; queue: Array<() => void> } {
  const dataDir = buildProjection(root);
  const queue = attach(dataDir);
  const warm = warmRecallProjection(WORKGROUP, root);
  expect(warm).toMatchObject({ warm: true, reason: 'warm' });
  return { dataDir, queue };
}

/** The two paths must agree byte for byte, notices and order included (P2.5-I1). */
function expectIdentical(root: string, query: string, options: ServeOptions = {}): Served {
  const empty = scratch('empty');
  attach(empty);
  _resetTokenStreamCacheForTest();
  const filesystem = serve(root, query, options);
  expect(filesystem.stats.recallPath).toBe('cold');

  _resetRecallProjectionForTest();
  const projection = (() => {
    live(root);
    return serve(root, query, options);
  })();
  expect(projection.stats.recallPath).toBe('hit');
  expect(JSON.stringify(projection.evidence)).toBe(JSON.stringify(filesystem.evidence));
  expect(JSON.stringify(projection.notices)).toBe(JSON.stringify(filesystem.notices));
  return projection;
}

// ---------------------------------------------------------------------------

/**
 * A tree carrying every shape the byte-identity long tail depends on
 * (decision 15): a heading-prefixed `searchable` whose passage cannot be found
 * in `content` (the `indexOf` clamp), facts sharing one headings array and one
 * `capturedAt`, a non-ASCII file, a candidate whose sentence hard-chops
 * mid-word, files long enough to be excerpted rather than delivered whole, and
 * the three lanes that stay on the filesystem.
 */
function adversarialTree(): string {
  const root = scratch('adversarial');
  writeFile(root, 'index.md', '# Core index\n\nThe core index names the routing seam and the delivery seam.\n');
  writeFile(root, 'system/definition.md', '# Definition\n\nNon-recall path, never a candidate.\n');
  writeFile(root, 'preferences/pat-quinn.md', '# Pat Quinn\n\nPrefers terse answers about routing.\n');
  writeFile(root, 'preferences/sam-reed.md', '# Sam Reed\n\nPrefers diagrams about delivery.\n');
  // Long enough that contextualExcerpt actually windows, and headed so that a
  // passage anchored in the `path\nheadings\n` prefix cannot be found in
  // `content` and clamps to 0.
  writeFile(
    root,
    'concepts/routing.md',
    `# Routing seam\n## Delivery handoff\n\n${'The router hands a message to the delivery seam and the delivery seam retries transient overload. '.repeat(20)}\n`,
  );
  writeFile(
    root,
    'concepts/naive-café.md',
    `# Naïve café — résumé\n\n${'Le café naïve résumé — em-dash, ellipsis… and ﬁ ligature. '.repeat(20)}\n`,
  );
  const filler = 'alpha '.repeat(400);
  writeFile(root, 'concepts/chopped.md', `${filler.slice(0, LANE_EXCERPT_CHARS.file - 4)}zebracrossing ${filler}`);
  writeFile(
    root,
    'domain/ledgers.md',
    `# Ledgers\n\n${'A ledger accumulates facts the curator appends. '.repeat(30)}\n`,
  );
  writeFile(root, 'people/pat.md', '# Pat\n\nOwns the routing seam and the deploy pipeline.\n');
  writeFile(
    root,
    GENERATED_MEMORY_RELATIVE_PATH,
    ledger(
      // Two facts with the SAME capturedAt: the recency tie-break cannot
      // separate them, so `sourceOrder` is what decides — and `sourceOrder`
      // is exactly what a hydration path is most likely to break.
      factLine('The delivery seam retries transient overload errors.', 'mem_00000000000000a1', '2026-08-01T00:00:00Z'),
      factLine(
        'The delivery seam retries transient overload failures.',
        'mem_00000000000000a2',
        '2026-08-01T00:00:00Z',
      ),
      factLine(
        'Registrar and nameserver changes go through the domain owner.',
        'mem_00000000000000b1',
        '2026-07-01T00:00:00Z',
      ),
      factLine('Worktrees are never garbage collected automatically.', 'mem_00000000000000c1', '2026-06-01T00:00:00Z'),
      factLine(
        'A curator rewrite only appends and removes; it never edits a surviving line.',
        'mem_00000000000000d1',
        '',
      ),
    ),
  );
  return root;
}

const DIFFERENTIAL_QUERIES = [
  '',
  '?',
  'a',
  'the and of to',
  'routing',
  'routing seam',
  'delivery seam retries transient overload',
  'what did we decide about the delivery seam retrying transient overload errors',
  'how does the router hand a message to delivery',
  'ledger curator appends facts',
  'why does the curator never edit a surviving line in place',
  'worktree cleanup',
  'remind me how worktrees are cleaned up — I think we said never automatically?',
  'naïve café résumé',
  'ﬁ ligature em-dash ellipsis',
  'zebracrossing',
  'alpha zebracrossing alpha',
  'deploy pipeline owner',
  'dns',
  'dns registrar',
  'search console access unavailable',
  'nothing in this store matches xyzzy plugh frobnicate',
  'Delivery Seam Retries Transient Overload',
  'seam',
  'A'.repeat(2000),
  'people pat routing seam deploy pipeline delivery handoff ledger curator worktree registrar',
];

describe('P2.5-AC1 differential equivalence against the filesystem path', () => {
  it('delivers byte-identical evidence and notices for every query, on both bootstrap and sender variants', () => {
    const root = adversarialTree();
    let compared = 0;
    for (const [index, query] of DIFFERENTIAL_QUERIES.entries()) {
      for (const options of [
        {},
        { bootstrap: true },
        { senders: ['Pat Quinn', 'Sam Reed'] },
        { bootstrap: true, senders: ['Pat Quinn'] },
      ] satisfies ServeOptions[]) {
        _resetRecallProjectionForTest();
        expectIdentical(root, query, options);
        compared++;
      }
      expect(index).toBeLessThan(DIFFERENTIAL_QUERIES.length);
    }
    expect(compared).toBe(DIFFERENTIAL_QUERIES.length * 4);
    // 104 build-and-compare rounds: ~5 s alone, and slower again under the full
    // suite's parallelism, which is what pushed it past the 5 s default.
  }, 120_000);

  it('keeps the two paths identical after the projection is rebuilt over a changed tree', () => {
    const root = adversarialTree();
    expectIdentical(root, 'routing seam delivery');
    writeFile(root, 'concepts/added.md', '# Added\n\nA routing seam note added after the first build.\n');
    _resetRecallProjectionForTest();
    expectIdentical(root, 'routing seam delivery');
  });
});

describe('P2.5-AC2 scan order survives hydration, not term-index order', () => {
  it('returns a shuffled id set in lane/scan order', () => {
    const root = adversarialTree();
    const dataDir = buildProjection(root);
    const db = openProjectionDb(projectionPath(WORKGROUP, dataDir), frozenBoundsJson())!;
    const all = (db.prepare('SELECT id FROM candidate').all() as { id: number }[]).map((row) => row.id);
    const hydrated = hydrateCandidates(db, [...all].reverse());
    db.close();

    expect(hydrated).toHaveLength(all.length);
    const files = hydrated.filter((row) => row.lane === 'file');
    const facts = hydrated.filter((row) => row.lane === 'fact');
    // Lanes are contiguous (all files, then all facts) and each is strictly
    // ascending in scan_order, whatever order the ids arrived in.
    expect(hydrated.map((row) => row.lane)).toEqual([...facts.map(() => 'fact'), ...files.map(() => 'file')]);
    expect(facts.map((row) => row.scanOrder)).toEqual([...facts.map((row) => row.scanOrder)].sort((a, b) => a - b));
    expect(files.map((row) => row.scanOrder)).toEqual([...files.map((row) => row.scanOrder)].sort((a, b) => a - b));
  });

  it('breaks a recency tie by scan order exactly as the walk does', () => {
    const root = adversarialTree();
    // Two facts share a capturedAt and match this query identically, so only
    // `sourceOrder` can order them. Term-index order would reverse them.
    const served = expectIdentical(root, 'delivery seam retries transient overload');
    const facts = served.evidence.excerpts.filter((row) => row.path === GENERATED_MEMORY_RELATIVE_PATH);
    expect(facts.length).toBeGreaterThanOrEqual(2);
    expect(facts[0]!.text).toContain('mem_00000000000000a1');
    expect(facts[1]!.text).toContain('mem_00000000000000a2');
  });
});

describe('P2.5-AC3 window-only tokens from the non-sliceable fallback are searchable', () => {
  it('surfaces a candidate matched only by a token a hard-chopped window minted', () => {
    const root = scratch('chopped-read');
    const filler = 'alpha '.repeat(400);
    writeFile(root, 'concepts/chopped.md', `${filler.slice(0, LANE_EXCERPT_CHARS.file - 4)}zebracrossing ${filler}`);
    writeFile(root, 'concepts/plain.md', '# Plain\n\nAn ordinary offset-sliceable candidate.\n');

    const dataDir = buildProjection(root);
    const db = openProjectionDb(projectionPath(WORKGROUP, dataDir), frozenBoundsJson())!;
    const whole = new Set(
      tokenizeForRecall(
        (
          db.prepare("SELECT searchable FROM candidate WHERE path = 'concepts/chopped.md'").get() as {
            searchable: string;
          }
        ).searchable,
      ),
    );
    const indexed = (db.prepare('SELECT token FROM term').all() as { token: string }[]).map((row) => row.token);
    const windowOnly = indexed.filter((token) => !whole.has(token));
    // Precondition asserted, not assumed.
    expect(windowOnly.length).toBeGreaterThan(0);
    // The prefilter finds it through the term index, which is what makes the
    // union in decision 8 observable on the READ path rather than only in the
    // stored table.
    for (const token of windowOnly) expect(queryTermCandidates(db, [token], 1).length).toBeGreaterThan(0);
    db.close();
  });
});

describe('P2.5-AC6 staleness is detected for every writer class', () => {
  function stalenessOf(root: string, dataDir: string): string | null {
    const db = openProjectionDb(projectionPath(WORKGROUP, dataDir), frozenBoundsJson())!;
    try {
      return projectionTreeStaleness(root, db);
    } finally {
      db.close();
    }
  }

  it('detects a tracked-file write, a same-millisecond in-place edit, an add, a remove, and a rename', () => {
    // Each case gets its own tree and its own projection so the five are
    // INDEPENDENTLY asserted — a batch against one tree would pass on the
    // first writer class alone.
    const base = (): { root: string; dataDir: string } => {
      const root = scratch('stale');
      writeFile(root, 'concepts/routing.md', '# Routing\n\nThe router hands a message to delivery.\n');
      writeFile(root, 'domain/ledgers.md', '# Ledgers\n\nA ledger accumulates facts.\n');
      writeFile(
        root,
        GENERATED_MEMORY_RELATIVE_PATH,
        ledger(factLine('One fact.', 'mem_0000000000000001', '2026-08-01T00:00:00Z')),
      );
      const dataDir = buildProjection(root);
      // Fresh means fresh: a false positive here would make every case pass.
      expect(stalenessOf(root, dataDir)).toBeNull();
      return { root, dataDir };
    };

    // 1. An ordinary write to a tracked file (the container-side writer class).
    {
      const { root, dataDir } = base();
      writeFile(root, 'concepts/routing.md', '# Routing\n\nThe router hands a message to delivery, then acks.\n');
      expect(stalenessOf(root, dataDir)).toBe('changed: concepts/routing.md');
    }
    // 2. Same-size, in-place, mtime forced back to within 1 ms of the original.
    //    Only nanosecond mtime or the inode separates these two states, which
    //    is why the diff uses `statSync(..., { bigint: true })`.
    {
      const { root, dataDir } = base();
      const victim = path.join(root, 'concepts/routing.md');
      const before = fs.statSync(victim, { bigint: true });
      const original = fs.readFileSync(victim, 'utf8');
      const edited = original.replace('router hands', 'router sends');
      expect(edited.length).toBe(original.length);
      fs.writeFileSync(victim, edited);
      // Push mtime back to the same MILLISECOND as the original; the
      // nanosecond remainder is what remains different.
      const sameMs = Number(before.mtimeNs / 1_000_000n) / 1000 + 0.000_4;
      fs.utimesSync(victim, sameMs, sameMs);
      const after = fs.statSync(victim, { bigint: true });
      expect(after.size).toBe(before.size);
      expect(Math.floor(Number(after.mtimeNs) / 1e6)).toBe(Math.floor(Number(before.mtimeNs) / 1e6));
      expect(after.mtimeNs).not.toBe(before.mtimeNs);
      expect(stalenessOf(root, dataDir)).toBe('changed: concepts/routing.md');
    }
    // 3. A new file under the memory root. Walking stored rows cannot see this.
    {
      const { root, dataDir } = base();
      writeFile(root, 'concepts/added.md', '# Added\n\nBrand new.\n');
      expect(stalenessOf(root, dataDir)).toBe('added: concepts/added.md');
    }
    // 4. A tracked file removed.
    {
      const { root, dataDir } = base();
      fs.rmSync(path.join(root, 'domain/ledgers.md'));
      expect(stalenessOf(root, dataDir)).toBe('removed: domain/ledgers.md');
    }
    // 5. A rename that preserves size, mtime AND inode: every per-file identity
    //    matches, and only the LISTING differs.
    {
      const { root, dataDir } = base();
      const from = path.join(root, 'domain/ledgers.md');
      const to = path.join(root, 'domain/ledgers-renamed.md');
      const before = fs.statSync(from, { bigint: true });
      fs.renameSync(from, to);
      const after = fs.statSync(to, { bigint: true });
      expect(after.ino).toBe(before.ino);
      expect(after.size).toBe(before.size);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(stalenessOf(root, dataDir)).toBe('added: domain/ledgers-renamed.md');
    }
  });

  it('refuses to warm a stale projection, and the turn reports stale rather than hit', () => {
    const root = adversarialTree();
    const dataDir = buildProjection(root);
    writeFile(root, 'concepts/added.md', '# Added\n\nA routing note.\n');
    attach(dataDir);
    const warm = warmRecallProjection(WORKGROUP, root);
    expect(warm.warm).toBe(false);
    expect(warm.reason).toMatch(/^stale: added: concepts\/added\.md$/);

    const served = serve(root, 'routing seam');
    expect(served.stats.recallPath).toBe('stale');
    expect(served.stats.recallReason).toMatch(/^stale: /);
  });
});

describe('P2.5-AC7 every degraded projection state falls back to the filesystem path', () => {
  function filesystemBaseline(root: string, query: string): Served {
    _resetRecallProjectionForTest();
    attach(scratch('empty'));
    _resetTokenStreamCacheForTest();
    return serve(root, query);
  }

  const QUERY = 'routing seam delivery retries';

  it('1. missing index.db', () => {
    const root = adversarialTree();
    const expected = filesystemBaseline(root, QUERY);
    _resetRecallProjectionForTest();
    attach(scratch('data-empty'));
    const served = serve(root, QUERY);
    expect(served.stats).toMatchObject({ recallPath: 'cold', recallReason: 'absent' });
    expect(JSON.stringify(served.evidence)).toBe(JSON.stringify(expected.evidence));
  });

  it('2. a projection that fails the staleness check', () => {
    const root = adversarialTree();
    const dataDir = buildProjection(root);
    writeFile(root, 'concepts/added.md', '# Added\n\nA routing seam note.\n');
    const expected = filesystemBaseline(root, QUERY);
    _resetRecallProjectionForTest();
    attach(dataDir);
    warmRecallProjection(WORKGROUP, root);
    const served = serve(root, QUERY);
    expect(served.stats.recallPath).toBe('stale');
    expect(JSON.stringify(served.evidence)).toBe(JSON.stringify(expected.evidence));
  });

  it('3. an index.db that fails to open (truncated/garbage)', () => {
    const root = adversarialTree();
    const expected = filesystemBaseline(root, QUERY);
    _resetRecallProjectionForTest();
    const dataDir = buildProjection(root);
    fs.writeFileSync(projectionPath(WORKGROUP, dataDir), 'not a database at all');
    attach(dataDir);
    const warm = warmRecallProjection(WORKGROUP, root);
    expect(warm.warm).toBe(false);
    const served = serve(root, QUERY);
    expect(served.stats.recallPath).toBe('fallback');
    expect(served.stats.recallReason).toMatch(/^unreadable: /);
    expect(JSON.stringify(served.evidence)).toBe(JSON.stringify(expected.evidence));
  });

  it('4. a schema_version mismatch', () => {
    const root = adversarialTree();
    const expected = filesystemBaseline(root, QUERY);
    _resetRecallProjectionForTest();
    const dataDir = buildProjection(root);
    const writable = new Database(projectionPath(WORKGROUP, dataDir));
    writable.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
    writable.close();
    attach(dataDir);
    expect(warmRecallProjection(WORKGROUP, root).reason).toMatch(/^schema-version: 999$/);
    const served = serve(root, QUERY);
    expect(served.stats).toMatchObject({ recallPath: 'fallback', recallReason: 'schema-version: 999' });
    expect(JSON.stringify(served.evidence)).toBe(JSON.stringify(expected.evidence));
  });

  it('5. a projection that opens and passes staleness but throws mid-hydration', () => {
    const root = adversarialTree();
    const expected = filesystemBaseline(root, QUERY);
    _resetRecallProjectionForTest();
    const dataDir = buildProjection(root);
    // Corrupt a row the warming probe's fixed terms never touch, so the
    // projection warms cleanly and only the turn's own hydration explodes —
    // the truncated-page / disk-full shape decision 14 is about.
    const writable = new Database(projectionPath(WORKGROUP, dataDir));
    const changed = writable
      .prepare("UPDATE source_file SET headings_json = '{ this is not json' WHERE path = 'concepts/routing.md'")
      .run();
    writable.close();
    expect(changed.changes).toBe(1);

    attach(dataDir);
    expect(warmRecallProjection(WORKGROUP, root).warm).toBe(true);
    const served = serve(root, QUERY);
    expect(served.stats.recallPath).toBe('fallback');
    expect(served.stats.recallReason).toMatch(/^hydrate: /);
    // The outer catch would have produced `markdown-read-failed` and EMPTY
    // evidence (P2.5-I4). It did not.
    expect(served.notices.some((notice) => notice.code === 'markdown-read-failed')).toBe(false);
    expect(JSON.stringify(served.evidence)).toBe(JSON.stringify(expected.evidence));
    // A failed read unmarks, so the next turn re-verifies rather than
    // re-exploding on every turn until the TTL.
    expect(_recallProjectionWarmForTest(WORKGROUP)).toBe(false);
  });

  it('5b. the same, in the stream-hydration batch the read only runs on a token-cache miss', () => {
    const root = adversarialTree();
    _resetRecallProjectionForTest();
    const dataDir = buildProjection(root);
    const writable = new Database(projectionPath(WORKGROUP, dataDir));
    expect(
      writable.prepare("UPDATE candidate SET stream_json = '{ nope' WHERE path = 'concepts/routing.md'").run().changes,
    ).toBe(1);
    writable.close();

    attach(dataDir);
    expect(warmRecallProjection(WORKGROUP, root).warm).toBe(true);
    // Empty token cache, so the seam actually fetches the persisted streams.
    _resetTokenStreamCacheForTest();
    const served = serve(root, QUERY);
    expect(served.stats.recallPath).toBe('fallback');
    expect(served.stats.recallReason).toMatch(/^hydrate-streams: /);
    expect(served.notices.some((notice) => notice.code === 'markdown-read-failed')).toBe(false);
    expect(served.evidence.excerpts.length).toBeGreaterThan(0);
  });
});

describe('P2.5-AC9 snapshot isolation across the two-phase read', () => {
  it('sees one committed generation when an incremental commit lands between the phases', () => {
    const root = adversarialTree();
    const dataDir = buildProjection(root);
    const dbPath = projectionPath(WORKGROUP, dataDir);

    const commitBetween = (ids: number[]): void => {
      const writer = new Database(dbPath);
      writer.pragma('busy_timeout = 5000');
      writer.prepare(`DELETE FROM candidate WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      writer.close();
    };

    // Control: with NO read transaction, the second phase sees the writer's
    // commit and the ids dangle. This is what the test would look like if
    // decision 13 were not implemented.
    {
      const reader = openProjectionDb(dbPath, frozenBoundsJson())!;
      const ids = queryTermCandidates(reader, tokenizeForRecall('routing seam delivery'), 2);
      expect(ids.length).toBeGreaterThan(1);
      commitBetween([ids[0]!]);
      expect(hydrateCandidates(reader, ids)).toHaveLength(ids.length - 1);
      reader.close();
    }

    // The real thing: one deferred transaction spans both phases.
    const rebuilt = buildProjection(root);
    const rebuiltPath = projectionPath(WORKGROUP, rebuilt);
    const reader = openProjectionDb(rebuiltPath, frozenBoundsJson())!;
    reader.exec('BEGIN DEFERRED');
    const ids = queryTermCandidates(reader, tokenizeForRecall('routing seam delivery'), 2);
    expect(ids.length).toBeGreaterThan(1);
    const writer = new Database(rebuiltPath);
    writer.pragma('busy_timeout = 5000');
    writer.prepare('DELETE FROM candidate WHERE id = ?').run(ids[0]);
    writer.close();
    const hydrated = hydrateCandidates(reader, ids);
    reader.exec('COMMIT');
    reader.close();
    expect(hydrated).toHaveLength(ids.length);
  });

  // The test above proves the SEMANTICS at the store level, with a control that
  // fails without the transaction — but it opens its own connection, so it
  // binds nothing about the seam. A mutation run confirmed that: deleting the
  // seam's own BEGIN/COMMIT left every test green. This one binds it.
  it('the turn read wraps both phases in one deferred transaction', () => {
    const root = adversarialTree();
    live(root);
    const exec = vi.spyOn(Database.prototype, 'exec');
    expect(serve(root, 'routing seam delivery').stats.recallPath).toBe('hit');
    const statements = exec.mock.calls.map(([sql]) => sql);
    expect(statements).toContain('BEGIN DEFERRED');
    expect(statements).toContain('COMMIT');
    // Opened before the term query, closed after hydration — one snapshot for
    // both phases, not a transaction wrapped around only one of them.
    expect(statements.indexOf('BEGIN DEFERRED')).toBeLessThan(statements.indexOf('COMMIT'));
  });
});

describe('P2.5-AC11 no top-N cap before dedupe', () => {
  it('still returns a low-ranked new candidate when every better one is already seen', () => {
    const root = scratch('nocap');
    // 60 files that all match, so any plausible top-N cutoff would drop the
    // last of them. Sorted paths make the ranking deterministic.
    for (let index = 0; index < 60; index++) {
      const stem = String(index).padStart(3, '0');
      writeFile(
        root,
        `concepts/${stem}.md`,
        `# Note ${stem}\n\nThe routing seam hands a message to the delivery seam.\n`,
      );
    }
    // The one that must survive: identical wording, so it ranks by path last.
    writeFile(root, 'concepts/zzz-late.md', '# Late\n\nThe routing seam hands a message to the delivery seam.\n');

    const empty = scratch('empty');
    attach(empty);
    const all = serve(root, 'routing seam delivery message');
    _resetRecallProjectionForTest();

    // Everything the filesystem path would deliver except the late one.
    const seen = new Set(
      all.evidence.excerpts.filter((row) => row.path !== 'concepts/zzz-late.md').map((row) => row.fingerprint),
    );
    attach(empty);
    const filesystem = serve(root, 'routing seam delivery message', { seen });
    _resetRecallProjectionForTest();
    live(root);
    const projection = serve(root, 'routing seam delivery message', { seen });

    expect(projection.stats.recallPath).toBe('hit');
    expect(JSON.stringify(projection.evidence)).toBe(JSON.stringify(filesystem.evidence));
    expect(projection.evidence.excerpts.length).toBeGreaterThan(0);
    expect(projection.notices.some((notice) => notice.code === 'no-relevant-memory')).toBe(false);
  });
});

describe('P2.5-AC12 ephemeral expansion fires only on a true double-zero, and only notices on a hit', () => {
  function tree(body: string): string {
    const root = scratch('expand');
    writeFile(root, 'concepts/note.md', `# Note\n\n${body}\n`);
    return root;
  }
  const NOTICE = 'ephemeral-query-expansion-used';

  it('(a) direct scorer already has survivors: no expansion notice', () => {
    const root = tree('The dns registrar holds the nameserver records.');
    const served = expectIdentical(root, 'dns');
    expect(served.evidence.excerpts.length).toBeGreaterThan(0);
    expect(served.notices.some((notice) => notice.code === NOTICE)).toBe(false);
  });

  it('(b) direct empty in both lanes, expanded finds evidence: notice fires', () => {
    const root = tree('The registrar holds the nameserver records for this domain.');
    const served = expectIdentical(root, 'dns');
    expect(served.evidence.excerpts.length).toBeGreaterThan(0);
    expect(served.notices.some((notice) => notice.code === NOTICE)).toBe(true);
  });

  it('(c) direct AND expanded both empty: no notice', () => {
    const root = tree('Nothing here relates to that subject at all.');
    const served = expectIdentical(root, 'dns');
    expect(served.evidence.excerpts).toHaveLength(0);
    expect(served.notices.some((notice) => notice.code === NOTICE)).toBe(false);
    expect(served.notices.some((notice) => notice.code === 'no-relevant-memory')).toBe(true);
  });
});

describe('P2.5-AC13 every seam-born notice is reproduced exactly', () => {
  function noticesFor(
    root: string,
    options: ServeOptions,
    code: string,
  ): { fs: ContextNotice[]; proj: ContextNotice[] } {
    attach(scratch('empty'));
    _resetTokenStreamCacheForTest();
    const filesystem = serve(root, 'routing seam', options);
    _resetRecallProjectionForTest();
    live(root);
    const projection = serve(root, 'routing seam', options);
    expect(projection.stats.recallPath).toBe('hit');
    return {
      fs: filesystem.notices.filter((notice) => notice.code === code),
      proj: projection.notices.filter((notice) => notice.code === code),
    };
  }

  it('missing-core-memory', () => {
    const root = scratch('nocore');
    writeFile(root, 'concepts/routing.md', '# Routing\n\nThe routing seam.\n');
    const { fs: left, proj: right } = noticesFor(root, { bootstrap: true }, 'missing-core-memory');
    expect(left).toHaveLength(1);
    expect(right).toEqual(left);
  });

  it('preference-read-failed', () => {
    const root = scratch('preffail');
    writeFile(root, 'concepts/routing.md', '# Routing\n\nThe routing seam.\n');
    writeFile(root, 'preferences/pat-quinn.md', '# Pat\n\nTerse.\n');
    fs.chmodSync(path.join(root, 'preferences/pat-quinn.md'), 0o000);
    try {
      const { fs: left, proj: right } = noticesFor(root, { senders: ['Pat Quinn'] }, 'preference-read-failed');
      expect(left).toHaveLength(1);
      expect(right).toEqual(left);
    } finally {
      fs.chmodSync(path.join(root, 'preferences/pat-quinn.md'), 0o644);
    }
  });

  it('preference-recall', () => {
    const root = scratch('prefok');
    writeFile(root, 'concepts/routing.md', '# Routing\n\nThe routing seam.\n');
    writeFile(root, 'preferences/pat-quinn.md', '# Pat\n\nTerse.\n');
    const { fs: left, proj: right } = noticesFor(root, { senders: ['Pat Quinn'] }, 'preference-recall');
    expect(left).toHaveLength(1);
    expect(right).toEqual(left);
  });

  it('markdown-symlink-skipped', () => {
    const root = scratch('symlink');
    writeFile(root, 'concepts/routing.md', '# Routing\n\nThe routing seam.\n');
    fs.symlinkSync(path.join(root, 'concepts/routing.md'), path.join(root, 'concepts/alias.md'));
    const { fs: left, proj: right } = noticesFor(root, {}, 'markdown-symlink-skipped');
    expect(left).toHaveLength(1);
    expect(right).toEqual(left);
  });

  it('markdown-file-limit', () => {
    const root = scratch('filelimit');
    // Past the 2,048 visited-entry cap, spread over directories so the notice
    // names unlisted scopes rather than just the root.
    for (let index = 0; index < PRE_TURN_BOUNDS.markdownFiles + 64; index++) {
      writeFile(root, `bulk/${String(index).padStart(5, '0')}.md`, `# ${index}\n\nrouting seam ${index}\n`);
    }
    const { fs: left, proj: right } = noticesFor(root, {}, 'markdown-file-limit');
    expect(left).toHaveLength(1);
    expect(right).toEqual(left);
    // 2,112 files written, walked twice and projected once.
  }, 60_000);

  it('markdown-byte-limit is carried by the projection at the scan loop position', () => {
    // The real bound is 24 MiB, which no fixture can reach in a unit test
    // without minutes of tokenization. What IS testable, and what the seam
    // owns, is that a byte-limit notice recorded by the build is replayed at
    // the SCAN LOOP's position — after the preference lane, not before it with
    // the listing notices.
    const root = scratch('bytelimit');
    writeFile(root, 'concepts/routing.md', '# Routing\n\nThe routing seam.\n');
    writeFile(root, 'preferences/pat-quinn.md', '# Pat\n\nTerse.\n');
    const dataDir = buildProjection(root);
    const writable = new Database(projectionPath(WORKGROUP, dataDir));
    writable.prepare("UPDATE meta SET value = ? WHERE key = 'notices_json'").run(
      JSON.stringify([
        { source: 'markdown', status: 'degraded', code: 'markdown-symlink-skipped', detail: 'skipped 1 symbolic link' },
        {
          source: 'markdown',
          status: 'truncated',
          code: 'markdown-byte-limit',
          detail: `scanned ${PRE_TURN_BOUNDS.markdownScannedBytes} bytes`,
        },
      ]),
    );
    writable.close();
    attach(dataDir);
    expect(warmRecallProjection(WORKGROUP, root).warm).toBe(true);
    const served = serve(root, 'routing seam', { senders: ['Pat Quinn'] });
    expect(served.stats.recallPath).toBe('hit');
    const codes = served.notices.map((notice) => notice.code);
    // Listing notice BEFORE the preference lane's, byte-limit AFTER it.
    expect(codes.indexOf('markdown-symlink-skipped')).toBeLessThan(codes.indexOf('preference-recall'));
    expect(codes.indexOf('markdown-byte-limit')).toBeGreaterThan(codes.indexOf('preference-recall'));
  });
});

describe('P2.5-AC14/AC15 warmth never blocks a turn and is re-established off the event loop', () => {
  it('a cold turn runs no bigint stat sweep and serves the filesystem path immediately', () => {
    const root = adversarialTree();
    const dataDir = buildProjection(root);
    const queue = attach(dataDir);

    const statSync = vi.spyOn(fs, 'statSync');
    const served = serve(root, 'routing seam delivery');
    const bigintStats = statSync.mock.calls.filter(
      (call) => (call[1] as { bigint?: boolean } | undefined)?.bigint === true,
    ).length;
    statSync.mockRestore();

    expect(served.stats.recallPath).toBe('cold');
    expect(served.stats.recallReason).toBe('not-verified-warm');
    // The tree diff stats every listed path with { bigint: true }. A cold turn
    // must do none of them (P2.5-AC14, the graph-scent 26.9 s lesson).
    expect(bigintStats).toBe(0);
    // Warming was QUEUED, not run.
    expect(queue).toHaveLength(1);
    expect(_recallProjectionWarmForTest(WORKGROUP)).toBe(false);
  });

  it('the queued pass warms the workgroup and the next turn is a hit', () => {
    const root = adversarialTree();
    const dataDir = buildProjection(root);
    const queue = attach(dataDir);

    expect(serve(root, 'routing seam').stats.recallPath).toBe('cold');
    expect(queue).toHaveLength(1);
    queue.shift()!();
    expect(_recallProjectionWarmForTest(WORKGROUP)).toBe(true);
    expect(serve(root, 'routing seam').stats.recallPath).toBe('hit');
  });

  it('coalesces repeated cold turns into a single queued pass', () => {
    const root = adversarialTree();
    const queue = attach(buildProjection(root));
    for (let turn = 0; turn < 5; turn++) expect(serve(root, 'routing seam').stats.recallPath).toBe('cold');
    expect(queue).toHaveLength(1);
  });

  it('the real scheduler runs the pass on a later tick, after the turn returned', async () => {
    const root = adversarialTree();
    const dataDir = buildProjection(root);
    // Real `setImmediate`, only the data dir redirected.
    _setRecallProjectionTestHooks({ dataDir });

    expect(serve(root, 'routing seam').stats.recallPath).toBe('cold');
    // Still cold on the same tick: the turn did not wait for warming.
    expect(_recallProjectionWarmForTest(WORKGROUP)).toBe(false);
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
    expect(_recallProjectionWarmForTest(WORKGROUP)).toBe(true);
    expect(serve(root, 'routing seam').stats.recallPath).toBe('hit');
  });

  it('an expired warm mark falls back and re-warms; a half-life mark serves and refreshes', () => {
    const root = adversarialTree();
    const dataDir = buildProjection(root);
    let now = 1_000_000;
    const queue: Array<() => void> = [];
    _setRecallProjectionTestHooks({
      dataDir,
      clock: () => now,
      schedule: (run) => {
        queue.push(run);
      },
      warmTtlMs: 1_000,
    });
    expect(warmRecallProjection(WORKGROUP, root).warm).toBe(true);

    now += 100;
    expect(serve(root, 'routing seam').stats.recallPath).toBe('hit');
    expect(queue).toHaveLength(0);

    // Past warmRefreshMs but inside the TTL: still a hit, refresh queued.
    now += 30_000;
    _setRecallProjectionTestHooks({ warmTtlMs: 60_000 });
    expect(serve(root, 'routing seam').stats.recallPath).toBe('hit');
    expect(queue).toHaveLength(1);
    // Run the refresh — leaving it queued would keep the coalescing guard set
    // and hide the next schedule.
    queue.shift()!();

    // Past the TTL: fall back rather than serve on an unverified mark.
    now += 60_001;
    expect(serve(root, 'routing seam').stats.recallPath).toBe('cold');
    expect(queue).toHaveLength(1);
  });

  it('a promoted index invalidates the warm mark earned against the previous one', () => {
    const root = adversarialTree();
    const dataDir = buildProjection(root);
    attach(dataDir);
    expect(warmRecallProjection(WORKGROUP, root).warm).toBe(true);
    expect(serve(root, 'routing seam').stats.recallPath).toBe('hit');

    buildAndPromoteProjection({ root, directory: projectionDir(WORKGROUP, dataDir) });
    expect(serve(root, 'routing seam').stats.recallPath).toBe('cold');
  });
});

describe('P2.5-AC16 the shared byte budget forces a fallback, not divergent output', () => {
  it('read-time: a projection whose frozen scan no longer fits the budget falls back', () => {
    const root = adversarialTree();
    const expected = (() => {
      attach(scratch('empty'));
      return serve(root, 'routing seam delivery');
    })();
    _resetRecallProjectionForTest();

    const dataDir = buildProjection(root);
    const db = openProjectionDb(projectionPath(WORKGROUP, dataDir), frozenBoundsJson())!;
    const scanned = Number(
      (db.prepare("SELECT value FROM meta WHERE key='scanned_bytes'").get() as { value: string }).value,
    );
    db.close();

    attach(dataDir);
    expect(warmRecallProjection(WORKGROUP, root).warm).toBe(true);
    // Budget exactly at what the build consumed: the preference lane's own cap
    // alone now pushes a turn over it, so the live scan could truncate where
    // the build did not.
    _setRecallProjectionTestHooks({ scannedBytesBudget: scanned });
    const served = serve(root, 'routing seam delivery');
    expect(served.stats.recallPath).toBe('fallback');
    expect(served.stats.recallReason).toMatch(/^byte-budget: /);
    expect(JSON.stringify(served.evidence)).toBe(JSON.stringify(expected.evidence));

    // One byte of headroom above the preference cap and it serves again.
    _setRecallProjectionTestHooks({
      scannedBytesBudget: scanned + PRE_TURN_BOUNDS.preferenceExcerpts * PRE_TURN_BOUNDS.markdownFileBytes,
    });
    expect(serve(root, 'routing seam delivery').stats.recallPath).toBe('hit');
  });

  it('build-time: a scan that exhausts the budget refuses to produce a projection', () => {
    const root = adversarialTree();
    // The real bound is 24 MiB; the assertion arithmetic is what is under test.
    _setRecallProjectionTestHooks({ scannedBytesBudget: 16 });
    expect(() => buildProjection(root)).toThrow(/exhausted the shared scannedBytes budget/);
  });
});

describe('P2.5-AC18 hydrated candidates are not re-tokenized', () => {
  function candidateMisses(run: () => void): number {
    _resetTokenStreamCacheForTest();
    const before = _tokenStreamCacheStatsForTest().misses;
    run();
    return _tokenStreamCacheStatsForTest().misses - before;
  }

  it('a projection turn tokenizes only the query, where the walk tokenizes every candidate', () => {
    const root = adversarialTree();
    const dataDir = buildProjection(root);

    attach(scratch('empty'));
    const walkMisses = candidateMisses(() => {
      expect(serve(root, 'routing seam delivery').stats.recallPath).toBe('cold');
    });

    _resetRecallProjectionForTest();
    attach(dataDir);
    expect(warmRecallProjection(WORKGROUP, root).warm).toBe(true);
    const projectionMisses = candidateMisses(() => {
      expect(serve(root, 'routing seam delivery').stats.recallPath).toBe('hit');
    });

    // Exactly the two query tokenizations (direct and expanded); every
    // candidate stream came from the projection.
    expect(projectionMisses).toBe(2);
    expect(walkMisses).toBeGreaterThan(projectionMisses + 5);
  });

  it('two concurrent workgroups do not evict each other, and neither re-tokenizes', () => {
    const rootA = adversarialTree();
    const rootB = adversarialTree();
    writeFile(rootB, 'concepts/other.md', '# Other\n\nA second workgroup with its own routing seam note.\n');
    const dataA = scratch('dataA');
    const dataB = scratch('dataB');
    buildAndPromoteProjection({ root: rootA, directory: projectionDir('wg-a', dataA) });
    buildAndPromoteProjection({ root: rootB, directory: projectionDir('wg-b', dataB) });

    const turn = (dataDir: string, workgroupId: string, root: string): number => {
      _setRecallProjectionTestHooks({ dataDir });
      expect(warmRecallProjection(workgroupId, root).warm).toBe(true);
      const before = _tokenStreamCacheStatsForTest().misses;
      const notices: ContextNotice[] = [];
      const stats: RecallCandidateStats = {
        factCandidates: 0,
        fileCandidates: 0,
        recallPath: 'fallback',
        recallReason: 'not-reached',
      };
      readMemoryEvidence(root, workgroupId, 'routing seam delivery', notices, false, new Set(), false, [], stats);
      expect(stats.recallPath).toBe('hit');
      return _tokenStreamCacheStatsForTest().misses - before;
    };

    _resetTokenStreamCacheForTest();
    // Interleaved, so a per-workgroup cache-thrash would show up as growing
    // miss counts on the later turns.
    const misses = [
      turn(dataA, 'wg-a', rootA),
      turn(dataB, 'wg-b', rootB),
      turn(dataA, 'wg-a', rootA),
      turn(dataB, 'wg-b', rootB),
    ];
    // Turn 1 of each pays the two query tokenizations; turns 3 and 4 reuse them.
    expect(misses).toEqual([2, 0, 0, 0]);
    expect(_tokenStreamCacheStatsForTest().size).toBeLessThan(_tokenStreamCacheStatsForTest().max);
  });
});

describe('P2.5-AC19 a bounds change after a build is detectable, not silent', () => {
  it('names the stale-bounds reason rather than serving output built under the old bound', () => {
    const root = adversarialTree();
    const dataDir = buildProjection(root);
    const writable = new Database(projectionPath(WORKGROUP, dataDir));
    const stored = JSON.parse(
      (writable.prepare("SELECT value FROM meta WHERE key='bounds_json'").get() as { value: string }).value,
    ) as Record<string, number>;
    // Simulates PRE_TURN_BOUNDS.markdownFileBytes changing with no rebuild.
    writable
      .prepare("UPDATE meta SET value = ? WHERE key = 'bounds_json'")
      .run(JSON.stringify({ ...stored, markdownFileBytes: stored.markdownFileBytes! * 2 }));
    writable.close();

    attach(dataDir);
    expect(warmRecallProjection(WORKGROUP, root).reason).toMatch(/^stale-bounds: /);
    const served = serve(root, 'routing seam');
    expect(served.stats.recallPath).toBe('fallback');
    expect(served.stats.recallReason).toMatch(/^stale-bounds: /);
  });

  it('a tokenizer change is the same class of staleness and is caught the same way', () => {
    const root = adversarialTree();
    const dataDir = buildProjection(root);
    const writable = new Database(projectionPath(WORKGROUP, dataDir));
    const stored = JSON.parse(
      (writable.prepare("SELECT value FROM meta WHERE key='bounds_json'").get() as { value: string }).value,
    ) as Record<string, number>;
    expect(typeof stored.tokenizerFingerprint).toBe('number');
    writable
      .prepare("UPDATE meta SET value = ? WHERE key = 'bounds_json'")
      .run(JSON.stringify({ ...stored, tokenizerFingerprint: stored.tokenizerFingerprint! + 1 }));
    writable.close();

    attach(dataDir);
    // A wrong stream must never be primed into the process-wide token cache.
    expect(warmRecallProjection(WORKGROUP, root).reason).toMatch(/^stale-bounds: /);
    expect(serve(root, 'routing seam').stats.recallPath).toBe('fallback');
  });
});

describe('P2.5-AC20 the turn reports which source served it', () => {
  it('reports hit / cold / stale / fallback with counts from the source that served', () => {
    const root = adversarialTree();
    const dataDir = buildProjection(root);

    attach(scratch('empty'));
    const cold = serve(root, 'routing seam delivery');
    expect(cold.stats).toMatchObject({ recallPath: 'cold', recallReason: 'absent' });
    // The walk's counts are the whole store.
    expect(cold.stats.fileCandidates).toBe(5);
    expect(cold.stats.factCandidates).toBe(5);

    _resetRecallProjectionForTest();
    attach(dataDir);
    expect(warmRecallProjection(WORKGROUP, root).warm).toBe(true);
    const hit = serve(root, 'routing seam delivery');
    expect(hit.stats.recallPath).toBe('hit');
    // The projection's counts are the term-index survivors — strictly fewer,
    // which is itself the drift signal decision 17 is for.
    expect(hit.stats.fileCandidates).toBeLessThan(cold.stats.fileCandidates);
    expect(hit.stats.fileCandidates).toBeGreaterThan(0);
    expect(hit.stats.factCandidates).toBeGreaterThan(0);

    writeFile(root, 'concepts/added.md', '# Added\n\nA routing seam note.\n');
    _resetRecallProjectionForTest();
    attach(dataDir);
    warmRecallProjection(WORKGROUP, root);
    expect(serve(root, 'routing seam delivery').stats.recallPath).toBe('stale');

    _resetRecallProjectionForTest();
    const broken = buildProjection(root);
    const writable = new Database(projectionPath(WORKGROUP, broken));
    writable.prepare("UPDATE meta SET value = '42' WHERE key = 'schema_version'").run();
    writable.close();
    attach(broken);
    warmRecallProjection(WORKGROUP, root);
    expect(serve(root, 'routing seam delivery').stats).toMatchObject({
      recallPath: 'fallback',
      recallReason: 'schema-version: 42',
    });
  });
});
