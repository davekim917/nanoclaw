import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from './index.js';

function makeMigratedDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  // FK parents for the session rows below.
  db.prepare(
    "INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-1', 'ava', 'ava', '2026-08-17T00:00:00.000Z')",
  ).run();
  db.prepare(
    "INSERT INTO messaging_groups (id, channel_type, platform_id, name, instance, created_at) VALUES ('mg-1', 'slack', 'slack:C0EXAMPLE9', 'qa-room', 'default', '2026-08-17T00:00:00.000Z')",
  ).run();
  return db;
}

function insertSession(
  db: Database.Database,
  id: string,
  mg: string | null,
  thread: string | null,
  status = 'active',
): void {
  db.prepare(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, container_status, created_at)
     VALUES (?, 'ag-1', ?, ?, ?, 'stopped', '2026-08-17T00:00:00.000Z')`,
  ).run(id, mg, thread, status);
}

describe('migration049', () => {
  it('a second ACTIVE session on the same triple is rejected by the schema', () => {
    const db = makeMigratedDb();
    insertSession(db, 's-1', 'mg-1', 'thread-1');
    expect(() => insertSession(db, 's-2', 'mg-1', 'thread-1')).toThrow(/UNIQUE/);
    db.close();
  });

  it('NULLs are folded — two active agent-shared sessions (both NULL) are rejected too', () => {
    // A plain unique index treats every NULL as distinct, which would exempt
    // exactly the NULL-heavy rows (agent-shared, task sessions) from the
    // invariant. COALESCE in the index closes that.
    const db = makeMigratedDb();
    insertSession(db, 's-1', null, null);
    expect(() => insertSession(db, 's-2', null, null)).toThrow(/UNIQUE/);
    db.close();
  });

  it('closed history may repeat a triple — only the ACTIVE row is constrained', () => {
    const db = makeMigratedDb();
    insertSession(db, 's-old-1', 'mg-1', 'thread-1', 'closed');
    insertSession(db, 's-old-2', 'mg-1', 'thread-1', 'closed');
    insertSession(db, 's-live', 'mg-1', 'thread-1', 'active');
    expect(db.prepare('SELECT COUNT(*) c FROM sessions').get()).toEqual({ c: 3 });
    db.close();
  });

  it('distinct threads under one messaging group remain independent sessions', () => {
    const db = makeMigratedDb();
    insertSession(db, 's-1', 'mg-1', 'thread-1');
    insertSession(db, 's-2', 'mg-1', 'thread-2');
    insertSession(db, 's-3', 'mg-1', null); // the channel-level session
    expect(db.prepare('SELECT COUNT(*) c FROM sessions').get()).toEqual({ c: 3 });
    db.close();
  });
});
