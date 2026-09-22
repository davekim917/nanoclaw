import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getRawDb } from './index.js';
import {
  getUsageWatermark,
  rollupSessionUsage,
  listUsageDaily,
  pruneOldTurnUsage,
  summarizeTurnUsage,
} from './usage.js';
import {
  CLAUDE_USAGE_TRUSTED_FROM,
  isUntrustedTurnUsage,
  UNTRUSTED_USAGE_NOTE,
  untrustedTurnUsageSql,
} from './usage-trust.js';
import { listTurnUsageSince } from '../modules/mailbox/ops/reads.js';

/**
 * The rollup takes a mailbox session, not a raw handle (mailbox seam, PR 6).
 * These fixtures build the outbound DB directly, so bind the module's REAL
 * read op to that handle rather than stubbing it — the SQL under test stays
 * the SQL that ships, including its missing-table branch.
 */
function sessionOf(db: Database.Database): {
  listTurnUsageSince: (afterId: number) => ReturnType<typeof listTurnUsageSince>;
} {
  return { listTurnUsageSince: (afterId: number) => listTurnUsageSince(db, afterId) };
}

const GID = 'ag-usage';
const SESSION_DIR = `${GID}/sess-1`;

/**
 * The sweep's three steps in one helper (seam 3 PR 6): the central watermark,
 * the outbound rows above it, the central transaction that folds them in.
 */
async function rollup(outDb: Database.Database, gid: string = GID, dir: string = SESSION_DIR): Promise<number> {
  const rows = sessionOf(outDb).listTurnUsageSince(await getUsageWatermark(dir));
  return rollupSessionUsage(rows, gid, dir);
}

/** Fixture outbound.db — same shape the container writes (contract in the plan). */
function makeOutboundDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE turn_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      cost_usd REAL
    )
  `);
  return db;
}

function insertTurn(
  db: Database.Database,
  row: Partial<{
    ts: string;
    provider: string;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    cost_usd: number | null;
  }>,
): void {
  // `??` would treat an explicit `null` (the NULL-column test case) the same
  // as "not provided" and silently fall back to the default — check `undefined`
  // specifically so a deliberate null in the fixture reaches the INSERT as NULL.
  // The default date sits after the #1061 cutoff (./usage-trust.ts): these
  // cases test rollup arithmetic, and a Claude row inside the untrusted
  // window reads back as the note, not a figure — that has its own describe.
  const withDefault = <T>(v: T | null | undefined, fallback: T): T | null => (v === undefined ? fallback : v);
  db.prepare(
    `INSERT INTO turn_usage (ts, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
     VALUES (@ts, @provider, @model, @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @cost_usd)`,
  ).run({
    ts: withDefault(row.ts, '2026-10-10T12:00:00.000Z'),
    provider: withDefault(row.provider, 'claude'),
    model: withDefault(row.model, 'opus'),
    input_tokens: withDefault(row.input_tokens, 100),
    output_tokens: withDefault(row.output_tokens, 50),
    cache_read_tokens: withDefault(row.cache_read_tokens, 10),
    cache_write_tokens: withDefault(row.cache_write_tokens, 5),
    cost_usd: withDefault(row.cost_usd, 0.5),
  });
}

describe('rollupSessionUsage', () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    await createAgentGroup({
      id: GID,
      name: 'usage',
      folder: 'usage',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });
  afterEach(() => closeDb());

  it('aggregates turn_usage rows into usage_daily, additive by (date, group, provider, model)', async () => {
    const outDb = makeOutboundDb();
    insertTurn(outDb, { ts: '2026-10-10T01:00:00.000Z' });
    insertTurn(outDb, { ts: '2026-10-10T23:00:00.000Z' });
    insertTurn(outDb, { ts: '2026-10-11T01:00:00.000Z', provider: 'codex', model: 'gpt-5' });

    const rolled = await rollup(outDb);
    expect(rolled).toBe(3);

    const rows = await listUsageDaily({ agentGroupId: GID });
    expect(rows).toHaveLength(2);

    const day1 = rows.find((r) => r.date === '2026-10-10' && r.provider === 'claude')!;
    expect(day1.turns).toBe(2);
    expect(day1.input_tokens).toBe(200);
    expect(day1.output_tokens).toBe(100);
    expect(day1.cache_read_tokens).toBe(20);
    expect(day1.cache_write_tokens).toBe(10);
    expect(day1.cost_usd).toBeCloseTo(1.0);
    expect(day1.model).toBe('opus');
    expect(day1.cost_applicable).toBe(true);

    const day2 = rows.find((r) => r.date === '2026-10-11' && r.provider === 'codex')!;
    expect(day2.turns).toBe(1);
    expect(day2.model).toBe('gpt-5');
    // Codex's app-server has no per-token cost field (ChatGPT-plan/subscription
    // billing) — cost_usd sums to 0 like a real zero-spend row would, but
    // cost_applicable distinguishes "not applicable" from "verified $0".
    expect(day2.cost_applicable).toBe(false);
  });

  it('watermark prevents double-counting on a second sweep of the same session', async () => {
    const outDb = makeOutboundDb();
    insertTurn(outDb, { ts: '2026-08-10T01:00:00.000Z' });
    insertTurn(outDb, { ts: '2026-08-10T02:00:00.000Z' });

    expect(await rollup(outDb)).toBe(2);
    // Second sweep, no new rows written in between: watermark already covers
    // everything, so nothing is re-added.
    expect(await rollup(outDb)).toBe(0);

    const rows = await listUsageDaily({ agentGroupId: GID });
    expect(rows).toHaveLength(1);
    expect(rows[0].turns).toBe(2);

    // A third turn lands; only the NEW row is picked up.
    insertTurn(outDb, { ts: '2026-08-10T03:00:00.000Z' });
    expect(await rollup(outDb)).toBe(1);
    expect((await listUsageDaily({ agentGroupId: GID }))[0].turns).toBe(3);
  });

  it('NULL token/cost/model columns roll up as 0 / empty string, not NULL or a crash', async () => {
    const outDb = makeOutboundDb();
    insertTurn(outDb, {
      model: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      cost_usd: null,
    });

    expect(await rollup(outDb)).toBe(1);
    const [row] = await listUsageDaily({ agentGroupId: GID });
    expect(row.model).toBe('');
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
    expect(row.cache_read_tokens).toBe(0);
    expect(row.cache_write_tokens).toBe(0);
    expect(row.cost_usd).toBe(0);
    // Default fixture provider is 'claude' (metered) — a NULL cost here is a
    // genuine data gap, not "free", so cost_applicable stays true even though
    // cost_usd rolls up to the same 0 a subscription provider would show.
    expect(row.cost_applicable).toBe(true);
  });

  it('a session outbound.db with no turn_usage table is skipped without error', async () => {
    const outDb = new Database(':memory:'); // no turn_usage table at all
    await expect(rollup(outDb)).resolves.toBe(0);
    await expect(rollup(outDb)).resolves.toBe(0);
    await expect(listUsageDaily({ agentGroupId: GID })).resolves.toHaveLength(0);
  });
});

/** Fixture matching the post-Phase-0.1-follow-up container schema (steps/duration_ms/trigger/rate_limit_*). */
function makeOutboundDbWithTurnMeta(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE turn_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      turn_id TEXT,
      steps INTEGER,
      duration_ms INTEGER,
      trigger TEXT,
      rate_limit_type TEXT,
      rate_limit_utilization REAL,
      rate_limit_resets_at TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      cost_usd REAL
    )
  `);
  return db;
}

/** The current container shape — turn meta plus the effort columns. */
function makeOutboundDbWithEffort(): Database.Database {
  const db = makeOutboundDbWithTurnMeta();
  db.exec('ALTER TABLE turn_usage ADD COLUMN effort TEXT');
  db.exec('ALTER TABLE turn_usage ADD COLUMN effort_requested TEXT');
  return db;
}

describe('rollupSessionUsage — central turn_usage mirror', () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    await createAgentGroup({
      id: GID,
      name: 'usage',
      folder: 'usage',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });
  afterEach(() => closeDb());

  it('writes a faithful 1:1 central row per turn_usage row, including steps/duration_ms/trigger/rate_limit_*', async () => {
    const outDb = makeOutboundDbWithTurnMeta();
    outDb
      .prepare(
        `INSERT INTO turn_usage (ts, provider, model, turn_id, steps, duration_ms, trigger, rate_limit_type, rate_limit_utilization, rate_limit_resets_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES ('2026-08-10T01:00:00.000Z', 'claude', 'opus', 't-abc', 12, 45000, 'human', 'seven_day', 0.91, '2026-08-25T00:00:00.000Z', 1000, 200, 50, 10, 0.5)`,
      )
      .run();

    expect(await rollup(outDb)).toBe(1);

    // usage_daily is untouched by the mirror — same shape as the existing contract.
    const daily = await listUsageDaily({ agentGroupId: GID });
    expect(daily).toHaveLength(1);
    expect(daily[0].turns).toBe(1);

    const centralRows = getRawDb().prepare('SELECT * FROM turn_usage').all() as Array<Record<string, unknown>>;
    expect(centralRows).toHaveLength(1);
    expect(centralRows[0]).toMatchObject({
      session_id: 'sess-1',
      agent_group_id: GID,
      provider: 'claude',
      model: 'opus',
      turn_id: 't-abc',
      steps: 12,
      duration_ms: 45000,
      trigger: 'human',
      rate_limit_type: 'seven_day',
      rate_limit_utilization: 0.91,
      rate_limit_resets_at: '2026-08-25T00:00:00.000Z',
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 50,
      cache_write_tokens: 10,
      cost_usd: 0.5,
    });
  });

  it('two turn_usage rows sharing one turn_id (a multi-model turn) roll up into two central rows carrying that SAME turn_id', async () => {
    // The regression this whole fix targets: usage_daily's turns column
    // counts rows, and a multi-model turn writes N of them. Once turn_id
    // survives the rollup unmolested, COUNT(DISTINCT turn_id) against the
    // central table recovers the real turn count (1) instead of the
    // over-counted row count (2) usage_daily would report.
    const outDb = makeOutboundDbWithTurnMeta();
    outDb
      .prepare(
        `INSERT INTO turn_usage (ts, provider, model, turn_id, input_tokens) VALUES
           ('2026-08-10T01:00:00.000Z', 'claude', 'claude-opus-5', 'shared-turn-id', 1000),
           ('2026-08-10T01:00:00.000Z', 'claude', 'claude-sonnet-5', 'shared-turn-id', 3000)`,
      )
      .run();

    expect(await rollup(outDb)).toBe(2);

    const centralRows = getRawDb().prepare('SELECT turn_id FROM turn_usage ORDER BY id ASC').all() as Array<{
      turn_id: string | null;
    }>;
    expect(centralRows).toHaveLength(2);
    expect(centralRows[0].turn_id).toBe('shared-turn-id');
    expect(centralRows[1].turn_id).toBe('shared-turn-id');

    const distinct = getRawDb().prepare('SELECT COUNT(DISTINCT turn_id) AS n FROM turn_usage').get() as { n: number };
    expect(distinct.n).toBe(1);
  });

  it('an old-shape turn_usage row (missing steps/duration_ms/trigger/rate_limit_*/turn_id columns) rolls up without throwing, central row is NULL', async () => {
    const outDb = makeOutboundDb(); // the pre-Phase-0.1-follow-up fixture, no new columns at all
    insertTurn(outDb, { ts: '2026-08-10T01:00:00.000Z' });

    await expect(rollup(outDb)).resolves.toBe(1);
    expect(await rollup(outDb)).toBe(0); // watermark already advanced by the call above

    const centralRows = getRawDb().prepare('SELECT * FROM turn_usage').all() as Array<Record<string, unknown>>;
    expect(centralRows).toHaveLength(1);
    expect(centralRows[0].steps).toBeNull();
    expect(centralRows[0].duration_ms).toBeNull();
    expect(centralRows[0].trigger).toBeNull();
    expect(centralRows[0].rate_limit_type).toBeNull();
    expect(centralRows[0].rate_limit_utilization).toBeNull();
    expect(centralRows[0].rate_limit_resets_at).toBeNull();
    expect(centralRows[0].turn_id).toBeNull();
    expect(centralRows[0].effort).toBeNull();
    expect(centralRows[0].effort_requested).toBeNull();
  });

  it('carries effort/effort_requested across the mirror instead of dropping them at the hop', async () => {
    // A column that lands in the session DB and is lost here is WORSE than no
    // column, because the central ledger is what operators read — a missing
    // value there reads as "measured, and there was no effort".
    const outDb = makeOutboundDbWithEffort();
    outDb
      .prepare(
        `INSERT INTO turn_usage (ts, provider, model, turn_id, effort, effort_requested) VALUES
           ('2026-08-10T01:00:00.000Z', 'claude', 'claude-opus-5[1m]', 'shared', 'high', 'high'),
           ('2026-08-10T01:00:00.000Z', 'claude', 'claude-sonnet-5', 'shared', NULL, NULL),
           ('2026-08-10T01:01:00.000Z', 'claude', 'claude-haiku-4-5-20251001', 'haiku-turn', NULL, 'high')`,
      )
      .run();

    expect(await rollup(outDb)).toBe(3);

    const rows = getRawDb()
      .prepare('SELECT model, effort, effort_requested FROM turn_usage ORDER BY id ASC')
      .all() as Array<{ model: string; effort: string | null; effort_requested: string | null }>;
    expect(rows.map((r) => [r.model, r.effort, r.effort_requested])).toEqual([
      ['claude-opus-5[1m]', 'high', 'high'],
      // Subagent row on a multi-model turn: not attributable, not "no effort".
      ['claude-sonnet-5', null, null],
      // Clamped away by the model, but the configured value still reached the
      // container — the pair is what tells those two apart.
      ['claude-haiku-4-5-20251001', null, 'high'],
    ]);
  });

  it('derives session_id from sessionDirKey (<agent-group>/<session>)', async () => {
    const outDb = makeOutboundDbWithTurnMeta();
    outDb
      .prepare(
        `INSERT INTO turn_usage (ts, provider, trigger) VALUES ('2026-08-10T01:00:00.000Z', 'codex', 'scheduled')`,
      )
      .run();
    await rollup(outDb, GID, `${GID}/sess-xyz`);
    const row = getRawDb().prepare('SELECT session_id FROM turn_usage').get() as { session_id: string };
    expect(row.session_id).toBe('sess-xyz');
  });
});

describe('listUsageDaily filters', () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    await createAgentGroup({
      id: GID,
      name: 'usage',
      folder: 'usage',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await createAgentGroup({
      id: 'ag-other',
      name: 'other',
      folder: 'other',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const outDb = makeOutboundDb();
    insertTurn(outDb, { ts: '2026-08-01T00:00:00.000Z' });
    insertTurn(outDb, { ts: '2026-08-09T00:00:00.000Z' });
    await rollup(outDb);
    await rollup(outDb, 'ag-other', 'ag-other/sess-1');
  });
  afterEach(() => closeDb());

  it('--group filters to one agent group', async () => {
    const rows = await listUsageDaily({ agentGroupId: GID });
    expect(rows.every((r) => r.agent_group_id === GID)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('--since filters to dates on/after the given UTC date', async () => {
    const rows = await listUsageDaily({ agentGroupId: GID, sinceDate: '2026-08-05' });
    expect(rows.map((r) => r.date)).toEqual(['2026-08-09']);
  });
});

describe('pruneOldTurnUsage', () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
  });
  afterEach(() => closeDb());

  it('deletes central turn_usage rows older than 30 days, keeps recent ones', async () => {
    const db = getRawDb();
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();
    db.prepare(
      `INSERT INTO turn_usage (ts, session_id, agent_group_id, provider) VALUES (?, 's1', 'ag', 'claude')`,
    ).run(old);
    db.prepare(
      `INSERT INTO turn_usage (ts, session_id, agent_group_id, provider) VALUES (?, 's1', 'ag', 'claude')`,
    ).run(recent);

    const deleted = await pruneOldTurnUsage();
    expect(deleted).toBe(1);

    const remaining = db.prepare('SELECT ts FROM turn_usage').all() as Array<{ ts: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].ts).toBe(recent);
  });

  it('never throws — returns 0 rather than crashing the sweep', async () => {
    await closeDb(); // no DB initialized — getDb() throws inside the try
    await expect(pruneOldTurnUsage()).resolves.toBe(0);
  });
});

describe('summarizeTurnUsage', () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
  });
  afterEach(() => closeDb());

  /**
   * Insert one central turn_usage row. `turnId` null models a pre-migration-061
   * container. The default date is after the #1061 cutoff so aggregation cases
   * sum; the untrusted window is covered in its own describe below.
   */
  function central(row: {
    ts?: string;
    group?: string;
    session?: string;
    provider?: string;
    model?: string | null;
    turnId?: string | null;
    effort?: string | null;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
  }): void {
    getRawDb()
      .prepare(
        `INSERT INTO turn_usage (ts, session_id, agent_group_id, provider, model, turn_id, effort, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES (@ts, @session, @group, @provider, @model, @turn_id, @effort, @input, @output, @cache_read, @cache_write, @cost)`,
      )
      .run({
        ts: row.ts ?? '2026-10-01T12:00:00.000Z',
        session: row.session ?? 'sess-1',
        group: row.group ?? 'ag-a',
        provider: row.provider ?? 'claude',
        model: row.model === undefined ? 'claude-opus-5' : row.model,
        turn_id: row.turnId === undefined ? 't-1' : row.turnId,
        effort: row.effort ?? null,
        input: row.input ?? 0,
        output: row.output ?? 0,
        cache_read: row.cacheRead ?? 0,
        cache_write: row.cacheWrite ?? 0,
        cost: row.cost ?? 0,
      });
  }

  it('buckets by effort — the query that proves a group`s configured effort reached its container', async () => {
    central({ turnId: 't-1', model: 'claude-opus-5[1m]', effort: 'high', cacheRead: 300 });
    central({ turnId: 't-2', model: 'claude-opus-5[1m]', effort: 'high', cacheRead: 200 });
    // Same group and model, a different effort — invisible before this column.
    central({ turnId: 't-3', model: 'claude-opus-5[1m]', effort: 'xhigh', cacheRead: 100 });
    // A pre-cutoff row: no effort was ever recorded. Buckets as '' alongside
    // the not-attributable ones, and is NOT a measurement of "no effort".
    central({ turnId: 't-4', model: 'claude-opus-5[1m]', effort: null, cacheRead: 50 });

    const rows = await summarizeTurnUsage({ dimensions: ['model', 'effort'] });
    const buckets = rows.filter((r) => r.model !== 'TOTAL').map((r) => [r.effort, r.turns]);
    expect(buckets).toEqual([
      ['high', 2],
      ['xhigh', 1],
      ['', 1],
    ]);
    expect(rows.at(-1)!.turns).toBe(4);
  });

  it('counts distinct turns, not rows — a multi-model turn is one turn', async () => {
    central({ turnId: 't-1', model: 'claude-opus-5' });
    central({ turnId: 't-1', model: 'claude-sonnet-5' });
    central({ turnId: 't-1', model: 'claude-haiku-4-5' });
    central({ turnId: 't-2', model: 'claude-opus-5' });

    const total = (await summarizeTurnUsage()).at(-1)!;
    expect(total.group).toBe('TOTAL');
    expect(total.turns).toBe(2); // a row count would say 4 — that is the 1.40x bug
  });

  it('TOTAL is queried un-grouped, so per-model buckets deliberately exceed it', async () => {
    central({ turnId: 't-1', model: 'claude-opus-5' });
    central({ turnId: 't-1', model: 'claude-sonnet-5' });

    const rows = await summarizeTurnUsage({ dimensions: ['model'] });
    const buckets = rows.slice(0, -1);
    const total = rows.at(-1)!;
    expect(buckets).toHaveLength(2);
    // Each model truthfully reports "1 turn touched me"...
    expect(buckets.every((b) => b.turns === 1)).toBe(true);
    // ...and their sum (2) is NOT the fleet turn count. Summing buckets is
    // exactly the double-count this verb exists to avoid.
    expect(buckets.reduce((n, b) => n + Number(b.turns), 0)).toBe(2);
    expect(total.turns).toBe(1);
  });

  it('splits token composition and reports per-turn averages', async () => {
    central({ turnId: 't-1', input: 100, output: 20, cacheRead: 900, cacheWrite: 50, cost: 1.5 });
    central({ turnId: 't-2', input: 300, output: 40, cacheRead: 1100, cacheWrite: 50, cost: 2.5 });

    const total = (await summarizeTurnUsage()).at(-1)!;
    expect(total.input_tokens).toBe(400);
    expect(total.output_tokens).toBe(60);
    expect(total.cache_read_tokens).toBe(2000);
    expect(total.cache_write_tokens).toBe(50 + 50);
    expect(total.cost_usd).toBe(4);
    expect(total.input_per_turn).toBe(200);
    expect(total.cache_read_per_turn).toBe(1000);
    expect(total.output_per_turn).toBe(30);
  });

  it('counts each pre-migration-061 row (turn_id NULL) as its own turn instead of dropping it', async () => {
    central({ turnId: null });
    central({ turnId: null });
    central({ turnId: 't-9' });

    // Bare COUNT(DISTINCT turn_id) would report 1 and silently lose the two
    // old-container turns.
    expect((await summarizeTurnUsage()).at(-1)!.turns).toBe(3);
  });

  it('buckets by several dimensions at once and orders heaviest cache_read first', async () => {
    central({ group: 'ag-a', provider: 'claude', turnId: 't-1', cacheRead: 100 });
    central({ group: 'ag-b', provider: 'codex', turnId: 't-2', cacheRead: 900 });

    const rows = await summarizeTurnUsage({ dimensions: ['group', 'provider'] });
    expect(rows.slice(0, -1).map((r) => [r.group, r.provider])).toEqual([
      ['ag-b', 'codex'],
      ['ag-a', 'claude'],
    ]);
    // Only the first dimension carries the TOTAL label; the rest blank out.
    expect(rows.at(-1)).toMatchObject({ group: 'TOTAL', provider: '' });
  });

  it('filters by group, --since and --days', async () => {
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    central({ group: 'ag-a', turnId: 't-a', ts: '2026-01-01T00:00:00.000Z' });
    central({ group: 'ag-b', turnId: 't-b', ts: recent });

    expect((await summarizeTurnUsage({ agentGroupId: 'ag-a' })).at(-1)!.turns).toBe(1);
    expect((await summarizeTurnUsage({ sinceDate: '2026-06-01' })).at(-1)!.turns).toBe(1);
    expect((await summarizeTurnUsage({ days: 7 })).at(-1)!.turns).toBe(1);
    expect((await summarizeTurnUsage({ days: 7 })).at(-1)!.group).toBe('TOTAL');
  });

  it('an empty window still returns a zeroed TOTAL row, not an empty list', async () => {
    const rows = await summarizeTurnUsage({ days: 7 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ group: 'TOTAL', turns: 0, cache_read_tokens: 0, cache_read_per_turn: 0 });
  });
});

/**
 * #1061: every Claude row before the cutoff in ./usage-trust.ts carries wrong
 * cost AND wrong tokens. Readers must say so instead of showing a figure — a
 * zero or a stored sum there is exactly the number nobody may quote.
 */
describe('untrusted Claude usage window (#1061)', () => {
  beforeEach(async () => {
    await initTestDb();
    runMigrations(getRawDb());
    await createAgentGroup({
      id: GID,
      name: 'usage',
      folder: 'usage',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });
  afterEach(() => closeDb());

  it('ncl usage list: a Claude day inside the window shows the note, never a figure', async () => {
    const outDb = makeOutboundDb();
    // The live shape: a running total booked as one turn's cost.
    insertTurn(outDb, { ts: '2026-09-22T11:08:22.000Z', cost_usd: 125.38 });
    insertTurn(outDb, { ts: '2026-09-23T01:00:00.000Z', cost_usd: 0.14 });
    insertTurn(outDb, { ts: '2026-09-01T01:00:00.000Z', provider: 'codex', model: 'gpt-5', cost_usd: null });
    await rollup(outDb);

    const byDay = new Map((await listUsageDaily({ agentGroupId: GID })).map((r) => [`${r.date}/${r.provider}`, r]));
    expect(byDay.get('2026-09-22/claude')).toMatchObject({
      turns: 1,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      cost_usd: null,
      untrusted: UNTRUSTED_USAGE_NOTE,
    });
    expect(byDay.get('2026-09-23/claude')).toMatchObject({ cost_usd: 0.14, input_tokens: 100, untrusted: null });
    // Codex never went through the defective path: its figures stand.
    expect(byDay.get('2026-09-01/codex')).toMatchObject({ input_tokens: 100, untrusted: null });
  });

  it('ncl usage summary: untrusted rows are counted, never summed, and an all-untrusted bucket has no figure', async () => {
    const central = (ts: string, session: string, turnId: string, cost: number, provider = 'claude'): void => {
      getRawDb()
        .prepare(
          `INSERT INTO turn_usage (ts, session_id, agent_group_id, provider, model, turn_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
           VALUES (?, ?, 'ag-a', ?, 'claude-opus-5', ?, 2, 200, 243000, 700, ?)`,
        )
        .run(ts, session, provider, turnId, cost);
    };
    central('2026-09-22T11:08:22.000Z', 'sess-old', 't-old', 125.38);
    central('2026-09-22T19:00:00.000Z', 'sess-new', 't-new', 0.14);
    central('2026-09-01T00:00:00.000Z', 'sess-cx', 't-cx', 0, 'codex');

    const rows = await summarizeTurnUsage({ dimensions: ['session'] });
    const total = rows.at(-1)!;
    expect(total).toMatchObject({ session: 'TOTAL', turns: 3, trusted_turns: 2, untrusted_rows: 1 });
    expect(total.cost_usd).toBe(0.14); // 125.52 if the running total leaked in
    expect(total.cache_read_tokens).toBe(486_000);
    expect(total.cache_read_per_turn).toBe(243_000);
    expect(String(total.untrusted)).toContain(UNTRUSTED_USAGE_NOTE);

    const old = rows.find((r) => r.session === 'sess-old')!;
    expect(old).toMatchObject({ turns: 1, trusted_turns: 0, untrusted_rows: 1 });
    for (const key of ['cost_usd', 'input_tokens', 'cache_read_tokens', 'cache_read_per_turn']) {
      expect(old[key]).toBeNull();
    }
    expect(rows.find((r) => r.session === 'sess-new')).toMatchObject({ cost_usd: 0.14, untrusted: null });
  });

  it('the JS and SQL predicates agree at the cutoff instant', () => {
    const justBefore = new Date(Date.parse(CLAUDE_USAGE_TRUSTED_FROM) - 1).toISOString();
    expect(isUntrustedTurnUsage('claude', justBefore)).toBe(true);
    expect(isUntrustedTurnUsage('claude', CLAUDE_USAGE_TRUSTED_FROM)).toBe(false);
    expect(isUntrustedTurnUsage('codex', justBefore)).toBe(false);
    const sql = (ts: string, provider = 'claude'): number =>
      (
        getRawDb()
          .prepare(`SELECT ${untrustedTurnUsageSql()} AS u FROM (SELECT ? AS provider, ? AS ts)`)
          .get(provider, ts) as { u: number }
      ).u;
    expect(sql(justBefore)).toBe(1);
    expect(sql(CLAUDE_USAGE_TRUSTED_FROM)).toBe(0);
    expect(sql(justBefore, 'codex')).toBe(0);
  });
});
