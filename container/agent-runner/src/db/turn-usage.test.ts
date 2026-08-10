import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configureOutboundDb, initTestSessionDb, openOutboundDb } from './connection.js';
import { getTurnUsageRows, recordTurnUsage } from './turn-usage.js';

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
    recordTurnUsage('claude', { inputTokens: 1 });
    recordTurnUsage('claude', { inputTokens: 2 });
    recordTurnUsage('claude', { inputTokens: 3 });

    const rows = getTurnUsageRows();
    expect(rows.map((r) => r.input_tokens)).toEqual([1, 2, 3]);
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
