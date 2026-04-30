import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMnemonIngestMigrations } from '../db/migrations/019-mnemon-ingest-db.js';
import {
  recordOrIncrementFailure,
  getDueRetries,
  deleteAfterSuccess,
  getPoisonedSummary,
  setDeadLettersDb,
} from './dead-letters.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMnemonIngestMigrations(db);
  return db;
}

let db: Database.Database;

beforeEach(() => {
  db = freshDb();
  setDeadLettersDb(db);
});

afterEach(() => {
  db.close();
});

describe('dead-letters', () => {
  it('test_recordFailure_first_attempt', () => {
    const before = new Date();
    const result = recordOrIncrementFailure({
      itemType: 'turn-pair',
      itemKey: 'k1',
      agentGroupId: 'ag-1',
      error: 'something failed',
    });
    const after = new Date();

    expect(result.poisoned).toBe(false);
    expect(result.failureCount).toBe(1);

    const row = db.prepare(`SELECT * FROM dead_letters WHERE item_key = 'k1'`).get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.failure_count).toBe(1);
    expect(row.poisoned_at).toBeNull();

    const nextRetry = new Date(row.next_retry_at as string);
    const expectedMin = new Date(before.getTime() + 59_000);
    const expectedMax = new Date(after.getTime() + 61_000);
    expect(nextRetry.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
    expect(nextRetry.getTime()).toBeLessThanOrEqual(expectedMax.getTime());
  });

  it('test_recordFailure_third_attempt_poisons', () => {
    recordOrIncrementFailure({ itemType: 'turn-pair', itemKey: 'k1', agentGroupId: 'ag-1', error: 'err1' });
    recordOrIncrementFailure({ itemType: 'turn-pair', itemKey: 'k1', agentGroupId: 'ag-1', error: 'err2' });

    const result = recordOrIncrementFailure({
      itemType: 'turn-pair',
      itemKey: 'k1',
      agentGroupId: 'ag-1',
      error: 'err3',
    });

    expect(result.poisoned).toBe(true);
    expect(result.failureCount).toBe(3);

    const row = db.prepare(`SELECT * FROM dead_letters WHERE item_key = 'k1'`).get() as Record<string, unknown>;
    expect(row.failure_count).toBe(3);
    expect(row.poisoned_at).not.toBeNull();
    expect(row.next_retry_at).toBeNull();
  });

  it('test_getDueRetries_filters_poisoned', () => {
    const now = new Date();
    const past = new Date(now.getTime() - 120_000).toISOString();
    const future = new Date(now.getTime() + 120_000).toISOString();
    const nowIso = now.toISOString();

    db.prepare(
      `
      INSERT INTO dead_letters (id, item_type, item_key, agent_group_id, failure_count, last_error, last_attempted_at, next_retry_at, poisoned_at)
      VALUES (?, 'turn-pair', 'k1', 'ag-1', 3, 'e', ?, NULL, ?)
    `,
    ).run('id-1', nowIso, nowIso);

    db.prepare(
      `
      INSERT INTO dead_letters (id, item_type, item_key, agent_group_id, failure_count, last_error, last_attempted_at, next_retry_at, poisoned_at)
      VALUES (?, 'turn-pair', 'k2', 'ag-1', 1, 'e', ?, ?, NULL)
    `,
    ).run('id-2', nowIso, past);

    db.prepare(
      `
      INSERT INTO dead_letters (id, item_type, item_key, agent_group_id, failure_count, last_error, last_attempted_at, next_retry_at, poisoned_at)
      VALUES (?, 'turn-pair', 'k3', 'ag-1', 1, 'e', ?, ?, NULL)
    `,
    ).run('id-3', nowIso, future);

    const due = getDueRetries('ag-1', now);
    expect(due).toHaveLength(1);
    expect(due[0].itemKey).toBe('k2');
  });

  it('test_deleteAfterSuccess', () => {
    recordOrIncrementFailure({ itemType: 'turn-pair', itemKey: 'k1', agentGroupId: 'ag-1', error: 'err' });

    const before = db.prepare(`SELECT COUNT(*) AS c FROM dead_letters WHERE item_key = 'k1'`).get() as { c: number };
    expect(before.c).toBe(1);

    deleteAfterSuccess('k1');

    const after = db.prepare(`SELECT COUNT(*) AS c FROM dead_letters WHERE item_key = 'k1'`).get() as { c: number };
    expect(after.c).toBe(0);
  });
});
