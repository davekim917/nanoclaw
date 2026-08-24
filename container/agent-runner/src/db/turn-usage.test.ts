import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configureOutboundDb, initTestSessionDb, openOutboundDb } from './connection.js';
import { getTurnUsageRows, recordTurnUsage, _resetClaudeCumulativeTrackingForTesting } from './turn-usage.js';

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
    // The cumulative->delta tracking map (see toClaudeTurnDelta) is
    // module-level state, so it survives across `it` blocks unless reset —
    // without this, a model name reused in a later test would see a
    // leftover "last" value from an earlier test and compute a bogus delta.
    _resetClaudeCumulativeTrackingForTesting();
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
    // Provider is 'codex', not 'claude' — this test is about row ordering,
    // not usage math, and the Claude-only cumulative->delta transform (see
    // toClaudeTurnDelta) would otherwise turn this monotonic 1,2,3 sequence
    // into deltas, coupling an unrelated test to that behavior.
    recordTurnUsage('codex', { inputTokens: 1 });
    recordTurnUsage('codex', { inputTokens: 2 });
    recordTurnUsage('codex', { inputTokens: 3 });

    const rows = getTurnUsageRows();
    expect(rows.map((r) => r.input_tokens)).toEqual([1, 2, 3]);
  });

  it('a two-model turn (mirroring poll-loop dispatching a TurnUsageInfo[]) writes one attributed row per model summing to the turn total', () => {
    // Mirrors poll-loop.ts's `for (const usage of Array.isArray(...) ? ... : [...])`
    // dispatch for a Claude turn whose modelUsage had >1 key (Opus parent +
    // Sonnet subagent) — each model gets its own row instead of collapsing
    // under a NULL model.
    const usageByModel = [
      { model: 'claude-opus-5', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10, costUsd: 0.5 },
      { model: 'claude-sonnet-5', inputTokens: 3000, outputTokens: 800, cacheReadTokens: 20, cacheWriteTokens: 5, costUsd: 0.3 },
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
});

describe('turn_usage — Claude cumulative-usage delta fix', () => {
  beforeEach(() => {
    initTestSessionDb();
    _resetClaudeCumulativeTrackingForTesting();
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

  it('does NOT apply the delta transform to other providers (Codex/OpenCode already report per-turn values)', () => {
    const model = 'gpt-5.6-sol';
    recordTurnUsage('codex', { model, inputTokens: 1000 });
    recordTurnUsage('codex', { model, inputTokens: 1500 }); // a genuinely bigger turn, NOT cumulative
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
});

describe('turn_usage — table creation (real files, not the in-memory test mode)', () => {
  it('exists after connection init on a brand-new outbound.db', () => {
    const dbPath = tempDbPath();
    const db = openOutboundDb(() => new Database(dbPath));
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
    configureOutboundDb(reopened);
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
});
