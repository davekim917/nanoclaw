import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './index.js';
import { rollupSessionUsage, listUsageDaily } from './usage.js';

const GID = 'ag-usage';
const SESSION_DIR = `${GID}/sess-1`;

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
  const withDefault = <T>(v: T | null | undefined, fallback: T): T | null => (v === undefined ? fallback : v);
  db.prepare(
    `INSERT INTO turn_usage (ts, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
     VALUES (@ts, @provider, @model, @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @cost_usd)`,
  ).run({
    ts: withDefault(row.ts, '2026-08-10T12:00:00.000Z'),
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
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: GID,
      name: 'usage',
      folder: 'usage',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });
  afterEach(() => closeDb());

  it('aggregates turn_usage rows into usage_daily, additive by (date, group, provider, model)', () => {
    const outDb = makeOutboundDb();
    insertTurn(outDb, { ts: '2026-08-10T01:00:00.000Z' });
    insertTurn(outDb, { ts: '2026-08-10T23:00:00.000Z' });
    insertTurn(outDb, { ts: '2026-08-11T01:00:00.000Z', provider: 'codex', model: 'gpt-5' });

    const rolled = rollupSessionUsage(outDb, GID, SESSION_DIR);
    expect(rolled).toBe(3);

    const rows = listUsageDaily({ agentGroupId: GID });
    expect(rows).toHaveLength(2);

    const day1 = rows.find((r) => r.date === '2026-08-10' && r.provider === 'claude')!;
    expect(day1.turns).toBe(2);
    expect(day1.input_tokens).toBe(200);
    expect(day1.output_tokens).toBe(100);
    expect(day1.cache_read_tokens).toBe(20);
    expect(day1.cache_write_tokens).toBe(10);
    expect(day1.cost_usd).toBeCloseTo(1.0);
    expect(day1.model).toBe('opus');

    const day2 = rows.find((r) => r.date === '2026-08-11' && r.provider === 'codex')!;
    expect(day2.turns).toBe(1);
    expect(day2.model).toBe('gpt-5');
  });

  it('watermark prevents double-counting on a second sweep of the same session', () => {
    const outDb = makeOutboundDb();
    insertTurn(outDb, { ts: '2026-08-10T01:00:00.000Z' });
    insertTurn(outDb, { ts: '2026-08-10T02:00:00.000Z' });

    expect(rollupSessionUsage(outDb, GID, SESSION_DIR)).toBe(2);
    // Second sweep, no new rows written in between: watermark already covers
    // everything, so nothing is re-added.
    expect(rollupSessionUsage(outDb, GID, SESSION_DIR)).toBe(0);

    const rows = listUsageDaily({ agentGroupId: GID });
    expect(rows).toHaveLength(1);
    expect(rows[0].turns).toBe(2);

    // A third turn lands; only the NEW row is picked up.
    insertTurn(outDb, { ts: '2026-08-10T03:00:00.000Z' });
    expect(rollupSessionUsage(outDb, GID, SESSION_DIR)).toBe(1);
    expect(listUsageDaily({ agentGroupId: GID })[0].turns).toBe(3);
  });

  it('NULL token/cost/model columns roll up as 0 / empty string, not NULL or a crash', () => {
    const outDb = makeOutboundDb();
    insertTurn(outDb, {
      model: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      cost_usd: null,
    });

    expect(rollupSessionUsage(outDb, GID, SESSION_DIR)).toBe(1);
    const [row] = listUsageDaily({ agentGroupId: GID });
    expect(row.model).toBe('');
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
    expect(row.cache_read_tokens).toBe(0);
    expect(row.cache_write_tokens).toBe(0);
    expect(row.cost_usd).toBe(0);
  });

  it('a session outbound.db with no turn_usage table is skipped without error', () => {
    const outDb = new Database(':memory:'); // no turn_usage table at all
    expect(() => rollupSessionUsage(outDb, GID, SESSION_DIR)).not.toThrow();
    expect(rollupSessionUsage(outDb, GID, SESSION_DIR)).toBe(0);
    expect(listUsageDaily({ agentGroupId: GID })).toHaveLength(0);
  });
});

describe('listUsageDaily filters', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: GID,
      name: 'usage',
      folder: 'usage',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createAgentGroup({
      id: 'ag-other',
      name: 'other',
      folder: 'other',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const outDb = makeOutboundDb();
    insertTurn(outDb, { ts: '2026-08-01T00:00:00.000Z' });
    insertTurn(outDb, { ts: '2026-08-09T00:00:00.000Z' });
    rollupSessionUsage(outDb, GID, SESSION_DIR);
    rollupSessionUsage(outDb, 'ag-other', 'ag-other/sess-1');
  });
  afterEach(() => closeDb());

  it('--group filters to one agent group', () => {
    const rows = listUsageDaily({ agentGroupId: GID });
    expect(rows.every((r) => r.agent_group_id === GID)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('--since filters to dates on/after the given UTC date', () => {
    const rows = listUsageDaily({ agentGroupId: GID, sinceDate: '2026-08-05' });
    expect(rows.map((r) => r.date)).toEqual(['2026-08-09']);
  });
});
