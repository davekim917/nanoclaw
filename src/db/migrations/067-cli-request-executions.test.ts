import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from './index.js';

function makeMigratedDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('migration067 — cli-request-executions', () => {
  it('creates the ledger with the columns the at-most-once claim needs', () => {
    const db = makeMigratedDb();
    const cols = new Set(
      (db.prepare("PRAGMA table_info('cli_request_executions')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(cols).toEqual(
      new Set(['session_id', 'request_id', 'command', 'status', 'response', 'claimed_at', 'completed_at']),
    );
    db.close();
  });

  it('keys on (session_id, request_id) — a container request id is only unique per session', () => {
    // `ncl` mints ids as `cli-<ms>-<6 random chars>`, so two sessions can
    // legitimately hold the same one. A request_id-only key would make one
    // session's claim silently suppress the other session's command.
    const db = makeMigratedDb();
    const pk = (db.prepare("PRAGMA table_info('cli_request_executions')").all() as Array<{ name: string; pk: number }>)
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pk).toEqual(['session_id', 'request_id']);

    const insert = db.prepare(
      `INSERT INTO cli_request_executions (session_id, request_id, command, status, claimed_at)
       VALUES (?, ?, 'tasks-create', 'executing', '2026-09-03T00:00:00.000Z')`,
    );
    insert.run('sess-a', 'cli-1-abcdef');
    expect(() => insert.run('sess-b', 'cli-1-abcdef')).not.toThrow();
    expect(() => insert.run('sess-a', 'cli-1-abcdef')).toThrow();
    db.close();
  });

  it('is idempotent — re-running the migration on a populated table keeps the rows', () => {
    const db = makeMigratedDb();
    db.prepare(
      `INSERT INTO cli_request_executions (session_id, request_id, command, status, claimed_at)
       VALUES ('s', 'r', 'groups-list', 'done', '2026-09-03T00:00:00.000Z')`,
    ).run();
    runMigrations(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM cli_request_executions').get() as { n: number }).n).toBe(1);
    db.close();
  });
});
