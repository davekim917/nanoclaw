import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from './index.js';
import { migration063 } from './063-channel-instructions-profile.js';

function makeMigratedDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function columns(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare("PRAGMA table_info('messaging_group_agents')").all() as Array<{ name: string }>).map((c) => c.name),
  );
}

describe('migration063 — channel-instructions-profile', () => {
  it('adds instructions_profile to messaging_group_agents', () => {
    const db = makeMigratedDb();
    expect(columns(db).has('instructions_profile')).toBe(true);
    db.close();
  });

  it('leaves default_tone alone — instructions are a separate layer, not a rename', () => {
    // The whole point of the column is that voice and operating rules stop
    // sharing one slot. A migration that moved or replaced default_tone would
    // silently strip every channel's persona.
    const db = makeMigratedDb();
    const cols = columns(db);
    expect(cols.has('default_tone')).toBe(true);
    expect(cols.has('instructions_profile')).toBe(true);
    db.close();
  });

  it('defaults existing rows to NULL, so no channel gains instructions on upgrade', () => {
    const db = makeMigratedDb();
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, instance, platform_id, is_group, created_at)
       VALUES ('mg-1', 'declchan', 'declchan', 'p-1', 1, '2026-09-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at)
       VALUES ('ag-1', 'ag', 'ag', '2026-09-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO messaging_group_agents
         (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
          sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES ('mga-1', 'mg-1', 'ag-1', 'mention', NULL, 'all', 'drop', 'shared', 0, '2026-09-01T00:00:00.000Z')`,
    ).run();

    const row = db.prepare(`SELECT instructions_profile FROM messaging_group_agents WHERE id = 'mga-1'`).get() as {
      instructions_profile: string | null;
    };
    expect(row.instructions_profile).toBeNull();
    db.close();
  });

  it('is idempotent — re-running up() is a no-op', () => {
    const db = makeMigratedDb();
    expect(() => migration063.up(db)).not.toThrow();
    expect(columns(db).has('instructions_profile')).toBe(true);
    db.close();
  });
});
