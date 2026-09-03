import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getOutboundDb } from '../../mailbox/sqlite/connection.js';
import { ensureNanoclawOutboundSchema, prepareOutboundFile } from './index.js';
import { initTestSessionDb } from './testing.js';
import { getTurnUsageRows, recordTurnUsage, _resetCumulativeTrackingForTesting } from './turn-usage.js';

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-turn-usage-'));
  tempDirs.push(dir);
  return path.join(dir, 'outbound.db');
}

function tableExists(db: Database, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== null;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('turn_usage — insert helper', () => {
  beforeEach(() => {
    initTestSessionDb();
    // The cumulative->delta tracking map (see toTurnDelta) is
    // module-level state, so it survives across `it` blocks unless reset —
    // without this, a model name reused in a later test would see a
    // leftover "last" value from an earlier test and compute a bogus delta.
    _resetCumulativeTrackingForTesting();
  });

  it('writes a row readable back with the given fields', () => {
    recordTurnUsage('claude', {
      model: 'claude-opus-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      costUsd: 0.012,
    });

    const rows = getTurnUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'claude',
      model: 'claude-opus-5',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      cost_usd: 0.012,
    });
    expect(typeof rows[0].ts).toBe('string');
    expect(() => new Date(rows[0].ts).toISOString()).not.toThrow();
  });

  it('accepts an all-NULL usage payload (coverage-gap row)', () => {
    recordTurnUsage('codex');

    const rows = getTurnUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('codex');
    expect(rows[0].model).toBeNull();
    expect(rows[0].input_tokens).toBeNull();
    expect(rows[0].output_tokens).toBeNull();
    expect(rows[0].cache_read_tokens).toBeNull();
    expect(rows[0].cache_write_tokens).toBeNull();
    expect(rows[0].cost_usd).toBeNull();
  });

  it('tolerates individual NULL-able fields mixed with real values', () => {
    recordTurnUsage('opencode', { model: 'opencode-go/kimi-k2.7', inputTokens: 42 });

    const rows = getTurnUsageRows();
    expect(rows[0]).toMatchObject({ provider: 'opencode', model: 'opencode-go/kimi-k2.7', input_tokens: 42 });
    expect(rows[0].output_tokens).toBeNull();
    expect(rows[0].cost_usd).toBeNull();
  });

  it('writes one row per call, preserving insertion order', () => {
    // Provider is 'opencode' — not on the cumulative->delta path (see
    // toTurnDelta). This test is about row ordering, not usage math, and
    // claude would turn this monotonic 1,2,3 sequence into deltas, coupling an
    // unrelated test to that behavior.
    recordTurnUsage('opencode', { inputTokens: 1 });
    recordTurnUsage('opencode', { inputTokens: 2 });
    recordTurnUsage('opencode', { inputTokens: 3 });

    const rows = getTurnUsageRows();
    expect(rows.map((r) => r.input_tokens)).toEqual([1, 2, 3]);
  });

  it('a two-model turn (mirroring poll-loop dispatching a TurnUsageInfo[]) writes one attributed row per model summing to the turn total', () => {
    // Mirrors poll-loop.ts's `for (const usage of Array.isArray(...) ? ... : [...])`
    // dispatch for a Claude turn whose modelUsage had >1 key (Opus parent +
    // Sonnet subagent) — each model gets its own row instead of collapsing
    // under a NULL model.
    const usageByModel = [
      {
        model: 'claude-opus-5',
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        costUsd: 0.5,
      },
      {
        model: 'claude-sonnet-5',
        inputTokens: 3000,
        outputTokens: 800,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        costUsd: 0.3,
      },
    ];
    for (const usage of usageByModel) recordTurnUsage('claude', usage);

    const rows = getTurnUsageRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.model)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(rows.every((r) => r.model !== null)).toBe(true);

    const sum = (key: 'input_tokens' | 'output_tokens' | 'cost_usd') => rows.reduce((acc, r) => acc + (r[key] ?? 0), 0);
    expect(sum('input_tokens')).toBe(4000);
    expect(sum('output_tokens')).toBe(1000);
    expect(sum('cost_usd')).toBeCloseTo(0.8, 10);
  });

  it('writes the rate-limit meta fields when given, NULL when omitted (default TurnMeta)', () => {
    recordTurnUsage(
      'claude',
      { model: 'claude-opus-5', inputTokens: 10 },
      {
        turnId: 't-1',
        steps: null,
        durationMs: null,
        trigger: null,
        rateLimitType: 'seven_day',
        rateLimitUtilization: 0.91,
        rateLimitResetsAt: '2026-08-24T00:00:00.000Z',
      },
    );
    recordTurnUsage('claude', { model: 'claude-sonnet-5', inputTokens: 5 }); // default TurnMeta

    const rows = getTurnUsageRows();
    expect(rows[0]).toMatchObject({
      turn_id: 't-1',
      rate_limit_type: 'seven_day',
      rate_limit_utilization: 0.91,
      rate_limit_resets_at: '2026-08-24T00:00:00.000Z',
    });
    expect(rows[1]).toMatchObject({
      turn_id: null,
      rate_limit_type: null,
      rate_limit_utilization: null,
      rate_limit_resets_at: null,
    });
  });
});

describe('turn_usage — cumulative-usage delta fix (Claude)', () => {
  beforeEach(() => {
    initTestSessionDb();
    _resetCumulativeTrackingForTesting();
  });

  it('records the DELTA for a synthetic monotonic (stream-cumulative) sequence', () => {
    const model = 'claude-opus-5';
    for (const cumulative of [887_166, 11_317_363, 46_850_249, 58_637_103]) {
      recordTurnUsage('claude', { model, cacheReadTokens: cumulative });
    }
    const rows = getTurnUsageRows();
    expect(rows.map((r) => r.cache_read_tokens)).toEqual([
      887_166, // first observation — nothing to subtract yet
      11_317_363 - 887_166,
      46_850_249 - 11_317_363,
      58_637_103 - 46_850_249,
    ]);
  });

  it('records the raw value (not a negative delta) the turn right after a stream reset', () => {
    const model = 'claude-opus-5';
    recordTurnUsage('claude', { model, inputTokens: 5000 });
    recordTurnUsage('claude', { model, inputTokens: 9000 }); // delta = 4000
    recordTurnUsage('claude', { model, inputTokens: 200 }); // new stream, well below the old total
    const rows = getTurnUsageRows();
    expect(rows.map((r) => r.input_tokens)).toEqual([5000, 4000, 200]);
  });

  it('tracks two interleaved models independently without cross-contamination', () => {
    recordTurnUsage('claude', { model: 'claude-opus-5', inputTokens: 1000 });
    recordTurnUsage('claude', { model: 'claude-sonnet-5', inputTokens: 500 });
    recordTurnUsage('claude', { model: 'claude-opus-5', inputTokens: 1800 }); // delta 800
    recordTurnUsage('claude', { model: 'claude-sonnet-5', inputTokens: 900 }); // delta 400
    const rows = getTurnUsageRows();
    expect(rows.map((r) => [r.model, r.input_tokens])).toEqual([
      ['claude-opus-5', 1000],
      ['claude-sonnet-5', 500],
      ['claude-opus-5', 800],
      ['claude-sonnet-5', 400],
    ]);
  });

  // Contract, settled 2026-08-26: only Claude is deltaed here. Codex briefly
  // was (2026-08-25) while codex.ts reported its thread-cumulative `total`,
  // and that was unsafe — the thread outlives the container but this memo does
  // not, so the first turn after a respawn re-booked the whole thread. codex.ts
  // sums per-request `last` instead; see codex.token-usage.test.ts.
  it('does NOT apply the delta transform to codex (its provider sums per-request `last`)', () => {
    const model = 'gpt-5.6-sol';
    recordTurnUsage('codex', { model, inputTokens: 1000 }, undefined, 'thread-1');
    recordTurnUsage('codex', { model, inputTokens: 1500 }, undefined, 'thread-1');
    const rows = getTurnUsageRows();
    expect(rows.map((r) => r.input_tokens)).toEqual([1000, 1500]);
  });

  it('does NOT apply the delta transform to opencode (its provider already sums per-turn)', () => {
    const model = 'opencode-go/kimi-k2.7';
    recordTurnUsage('opencode', { model, inputTokens: 1000 });
    recordTurnUsage('opencode', { model, inputTokens: 1500 }); // a genuinely bigger turn, NOT cumulative
    const rows = getTurnUsageRows();
    expect(rows.map((r) => r.input_tokens)).toEqual([1000, 1500]);
  });

  it('falls back to the raw value when a field is NULL on either side of the comparison', () => {
    const model = 'claude-opus-5';
    recordTurnUsage('claude', { model, inputTokens: 1000, outputTokens: null });
    recordTurnUsage('claude', { model, inputTokens: null, outputTokens: 300 });
    const rows = getTurnUsageRows();
    expect(rows[0]).toMatchObject({ input_tokens: 1000, output_tokens: null });
    expect(rows[1]).toMatchObject({ input_tokens: null, output_tokens: 300 });
  });

  it('treats a reset as ONE decision for the whole row — no field taken raw while another is deltaed', () => {
    const model = 'claude-opus-5';
    recordTurnUsage('claude', { model, inputTokens: 1_000_000, outputTokens: 500 }, undefined, 'sess-a');
    // A new SDK stream: input restarted BELOW the old total, output happens to
    // land above it. Per-field reset detection produced input=900000 (raw,
    // reset detected) and output=100 (delta) in the SAME row.
    recordTurnUsage('claude', { model, inputTokens: 900_000, outputTokens: 600 }, undefined, 'sess-a');
    const rows = getTurnUsageRows();
    expect(rows[1]).toMatchObject({ input_tokens: 900_000, output_tokens: 600 });
  });

  it('does not subtract across accounting scopes — a new continuation starts a fresh baseline', () => {
    const model = 'claude-opus-5';
    recordTurnUsage('claude', { model, inputTokens: 1_000_000 }, undefined, 'sess-a');
    // Different SDK session. Its first report is ABOVE the previous scope's
    // stored total, so the decrease check cannot see the boundary — only the
    // scope key can. Keyed by model alone this recorded 100000.
    recordTurnUsage('claude', { model, inputTokens: 1_100_000 }, undefined, 'sess-b');
    recordTurnUsage('claude', { model, inputTokens: 1_150_000 }, undefined, 'sess-b');
    const rows = getTurnUsageRows();
    expect(rows.map((r) => r.input_tokens)).toEqual([1_000_000, 1_100_000, 50_000]);
  });

  it('records a 0 delta (not the raw total) when a running total is unchanged', () => {
    const model = 'claude-opus-5';
    recordTurnUsage('claude', { model, inputTokens: 900, cacheWriteTokens: 4000 }, undefined, 'sess-a');
    // Same stream, next turn wrote no new cache: the cumulative cache-write
    // is identical. That is 0 tokens this turn, not another 4000.
    recordTurnUsage('claude', { model, inputTokens: 1200, cacheWriteTokens: 4000 }, undefined, 'sess-a');
    const rows = getTurnUsageRows();
    expect(rows[1]).toMatchObject({ input_tokens: 300, cache_write_tokens: 0 });
  });

  // The container-respawn regression that took codex off this path is NOT
  // testable here, and a test here would false-pass: with an empty memo this
  // module writes the raw value either way, so on or off the delta path the
  // row looks identical. What differs is what the PROVIDER hands over — a
  // thread-cumulative total vs this turn's own requests — so the guard lives
  // at providers/codex.token-usage.test.ts ("reports only this turn's requests
  // when a respawned container resumes a long-lived thread").

  it('keeps claude`s per-model baselines separate (its SDK counts modelUsage per model)', () => {
    recordTurnUsage('claude', { model: 'claude-opus-5', inputTokens: 1_000_000 }, undefined, 'sess-a');
    recordTurnUsage('claude', { model: 'claude-sonnet-5', inputTokens: 50_000 }, undefined, 'sess-a');
    recordTurnUsage('claude', { model: 'claude-opus-5', inputTokens: 1_010_000 }, undefined, 'sess-a');
    // Sonnet's 50k must not become Opus's baseline, and vice versa.
    expect(getTurnUsageRows().map((r) => [r.model, r.input_tokens])).toEqual([
      ['claude-opus-5', 1_000_000],
      ['claude-sonnet-5', 50_000],
      ['claude-opus-5', 10_000],
    ]);
  });

  it('does not lose a turn`s tokens when its INSERT fails — the baseline only advances on a written row', () => {
    const model = 'claude-opus-5';
    recordTurnUsage('claude', { model, inputTokens: 1_000_000 }, undefined, 'sess-a');

    // Force the next INSERT to fail the way a real one would (recordTurnUsage
    // swallows the error by contract — it must never fail the turn it meters).
    getOutboundDb().exec('ALTER TABLE turn_usage RENAME TO turn_usage_hidden');
    recordTurnUsage('claude', { model, inputTokens: 1_400_000 }, undefined, 'sess-a'); // 400k, lost to the failed write
    getOutboundDb().exec('ALTER TABLE turn_usage_hidden RENAME TO turn_usage');

    recordTurnUsage('claude', { model, inputTokens: 1_500_000 }, undefined, 'sess-a');

    // The surviving row must cover BOTH the failed turn and this one
    // (1,500,000 - 1,000,000). Advancing the memo before the write recorded
    // 100,000 here and lost the other 400,000 permanently.
    expect(getTurnUsageRows().map((r) => r.input_tokens)).toEqual([1_000_000, 500_000]);
  });
});

describe('turn_usage — phantom "listed but unused" model rows', () => {
  beforeEach(() => {
    initTestSessionDb();
    _resetCumulativeTrackingForTesting();
  });

  it('skips a cumulative-provider model whose running total did not move this turn', () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    // Turn 1: both models really ran.
    recordTurnUsage('claude', { model: 'opus', ...zero, inputTokens: 1000 }, undefined, 'sess-a');
    recordTurnUsage('claude', { model: 'haiku', ...zero, inputTokens: 40 }, undefined, 'sess-a');
    // Turn 2: only opus ran, but the SDK still lists haiku at its old total.
    recordTurnUsage('claude', { model: 'opus', ...zero, inputTokens: 3000 }, undefined, 'sess-a');
    recordTurnUsage('claude', { model: 'haiku', ...zero, inputTokens: 40 }, undefined, 'sess-a');

    const rows = getTurnUsageRows();
    expect(rows.map((r) => [r.model, r.input_tokens])).toEqual([
      ['opus', 1000],
      ['haiku', 40],
      ['opus', 2000],
    ]);
  });

  it('still records an all-zero row that carries cost — a real turn whose token counters were missed', () => {
    // Live case (2026-08-25): a claude row with four explicit zeros and
    // cost_usd 2.25. Dropping it would delete $2.25 of spend from the ledger.
    recordTurnUsage(
      'claude',
      { model: 'sonnet', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 2.25 },
      undefined,
      'sess-a',
    );
    expect(getTurnUsageRows().map((r) => r.cost_usd)).toEqual([2.25]);
  });

  it('still records a turn whose provider reported nothing at all (NULLs, not zeros)', () => {
    recordTurnUsage('claude', { model: 'opus' }, undefined, 'sess-a');
    const rows = getTurnUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBeNull();
  });

  it('still records an all-zero turn from a NON-cumulative provider — that is a real reading, not a stale listing', () => {
    // OpenCode sums a per-message map at the provider, so its zero means "this
    // turn genuinely consumed nothing measurable". Live data has one such turn;
    // hiding it would tidy away a provider coverage gap.
    recordTurnUsage('opencode', {
      model: 'opencode-go/ox-alpha-free',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    });
    expect(getTurnUsageRows()).toHaveLength(1);
  });
});

describe('turn_usage — table creation (real files, not the in-memory test mode)', () => {
  it('exists after connection init on a brand-new outbound.db', () => {
    const dbPath = tempDbPath();
    prepareOutboundFile(() => new Database(dbPath));
    const db = new Database(dbPath);
    ensureNanoclawOutboundSchema(db);
    expect(tableExists(db, 'turn_usage')).toBe(true);
    db.close();
  });

  it('backfills onto a pre-existing outbound.db that predates this table', () => {
    const dbPath = tempDbPath();
    // Simulate an old outbound.db: create it with only an unrelated table,
    // the way a session predating Fleet Hardening Phase 0.1 would look.
    const seed = new Database(dbPath);
    seed.exec('CREATE TABLE messages_out (id TEXT PRIMARY KEY)');
    seed.close();

    const reopened = new Database(dbPath);
    expect(tableExists(reopened, 'turn_usage')).toBe(false);
    ensureNanoclawOutboundSchema(reopened);
    expect(tableExists(reopened, 'turn_usage')).toBe(true);

    // And it's actually usable, not just present.
    reopened
      .prepare(
        `INSERT INTO turn_usage (ts, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES ($ts, $provider, $model, $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens, $cost_usd)`,
      )
      .run({
        $ts: new Date().toISOString(),
        $provider: 'claude',
        $model: null,
        $input_tokens: null,
        $output_tokens: null,
        $cache_read_tokens: null,
        $cache_write_tokens: null,
        $cost_usd: null,
      });
    const row = reopened.prepare('SELECT provider FROM turn_usage').get() as { provider: string };
    expect(row.provider).toBe('claude');
    reopened.close();
  });

  it('ALTERs steps/duration_ms/trigger/rate_limit_* onto a turn_usage table that has the table but not those columns', () => {
    const dbPath = tempDbPath();
    // Simulate a mid-generation outbound.db: turn_usage exists (base v0.1
    // shape) but predates every column added since.
    const seed = new Database(dbPath);
    seed.exec(`
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
    seed.close();

    const reopened = new Database(dbPath);
    const colsBefore = new Set(
      (reopened.prepare("PRAGMA table_info('turn_usage')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(colsBefore.has('steps')).toBe(false);
    expect(colsBefore.has('rate_limit_type')).toBe(false);

    ensureNanoclawOutboundSchema(reopened);

    const colsAfter = new Set(
      (reopened.prepare("PRAGMA table_info('turn_usage')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const c of [
      'steps',
      'duration_ms',
      'trigger',
      'rate_limit_type',
      'rate_limit_utilization',
      'rate_limit_resets_at',
    ]) {
      expect(colsAfter.has(c)).toBe(true);
    }
    reopened.close();
  });
});
