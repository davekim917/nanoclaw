import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from './index.js';
import { migration069 } from './069-messaging-group-name-source.js';

function columns(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{ name: string }>).map((c) => c.name),
  );
}

/** A messaging_groups table as it stood before this migration. */
function preMigrationDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messaging_groups (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      instance TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      name TEXT,
      is_group INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`);
  return db;
}

function insertMg(db: Database.Database, id: string, channelType: string, name: string | null): void {
  db.prepare(
    `INSERT INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, created_at)
     VALUES (?, ?, ?, ?, ?, 0, '2026-09-01T00:00:00.000Z')`,
  ).run(id, channelType, channelType, `p-${id}`, name);
}

function nameSource(db: Database.Database, id: string): string | null {
  return (db.prepare(`SELECT name_source FROM messaging_groups WHERE id = ?`).get(id) as { name_source: string | null })
    .name_source;
}

describe('migration069 — messaging-group-name-source', () => {
  it('adds name_source to messaging_groups on a fully migrated DB', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(columns(db).has('name_source')).toBe(true);
    db.close();
  });

  it('backfills already-named rows as adapter-sourced on their own platform', () => {
    // Behavior-preserving: before this column the raw metadata fetch overwrote
    // every name on every restart, so an adapter stamp is both the likeliest
    // truth about what is sitting in the column and the choice that leaves
    // these rows refreshing exactly as they did.
    const db = preMigrationDb();
    insertMg(db, 'mg-slack', 'slack', '#general');
    insertMg(db, 'mg-discord', 'discord', 'general');
    insertMg(db, 'mg-nameless', 'slack', null);

    migration069.up(db);

    expect(nameSource(db, 'mg-slack')).toBe('slack:adapter');
    expect(nameSource(db, 'mg-discord')).toBe('discord:adapter');
    // An empty name slot has no provenance to record — and accepts any source.
    expect(nameSource(db, 'mg-nameless')).toBeNull();
    db.close();
  });

  it('is idempotent — re-running up() neither throws nor rewrites existing provenance', () => {
    const db = preMigrationDb();
    insertMg(db, 'mg-1', 'slack', 'Group DM: Alice and Bob');
    migration069.up(db);
    db.prepare(`UPDATE messaging_groups SET name_source = 'slack:classified' WHERE id = 'mg-1'`).run();

    expect(() => migration069.up(db)).not.toThrow();
    expect(columns(db).has('name_source')).toBe(true);
    expect(nameSource(db, 'mg-1')).toBe('slack:classified');
    db.close();
  });
});
