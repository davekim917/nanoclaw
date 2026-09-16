import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from './index.js';
import { migration081 } from './081-thread-key-anchors.js';

function insert(db: Database.Database, agentGroupId: string, threadKey: string, threadPlatformId: string): void {
  db.prepare(
    `INSERT INTO thread_key_anchors
       (agent_group_id, channel_type, platform_id, thread_key, thread_platform_id, created_at, last_used_at)
     VALUES (?, 'slack', 'slack:C1', ?, ?, '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z')`,
  ).run(agentGroupId, threadKey, threadPlatformId);
}

describe('migration081 — thread_key_anchors', () => {
  it('creates the table with the spec columns', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = (db.prepare('PRAGMA table_info(thread_key_anchors)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual([
      'agent_group_id',
      'channel_type',
      'platform_id',
      'thread_key',
      'thread_platform_id',
      'created_at',
      'last_used_at',
    ]);
    db.close();
  });

  it('keys on (agent group, channel, platform, key): the same key in another group is a separate row', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    insert(db, 'ag-1', 'k', 'ts-1');
    insert(db, 'ag-2', 'k', 'ts-2');
    expect(() => insert(db, 'ag-1', 'k', 'ts-3')).toThrow(/UNIQUE|PRIMARY KEY/);
    db.close();
  });

  it('is idempotent', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => migration081.up(db)).not.toThrow();
    db.close();
  });
});
