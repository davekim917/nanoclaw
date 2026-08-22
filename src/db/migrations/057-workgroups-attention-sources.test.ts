import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from './index.js';
import { migration057 } from './057-workgroups-attention-sources.js';

/**
 * A pre-057 `workgroups` table, hand-rolled so rows can exist BEFORE the
 * migration runs — the only way to prove it adds no backfill and clobbers no
 * operator-set value.
 */
function preMigrationDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workgroups (
      id              TEXT PRIMARY KEY,
      display_name    TEXT,
      onecli_secrets  TEXT NOT NULL DEFAULT '[]',
      mnemon_store_id TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT
    );
  `);
  db.prepare(`INSERT INTO workgroups (id, created_at) VALUES ('example-labs', '2026-08-01T00:00:00.000Z')`).run();
  return db;
}

describe('migration057 — workgroups.attention_sources', () => {
  it('adds a nullable attention_sources column on a fresh migrated DB', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = (
      db.prepare('PRAGMA table_info(workgroups)').all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>
    ).filter((c) => c.name === 'attention_sources');
    expect(cols).toHaveLength(1);
    expect(cols[0]!.notnull).toBe(0);
    // NO default, unlike `onecli_secrets`. NULL ("declares nothing") and '[]'
    // ("declared, and empty") are different facts, and a default would erase
    // the difference — see the migration's header.
    expect(cols[0]!.dflt_value).toBeNull();
    db.close();
  });

  it('does NOT backfill: pre-existing rows stay NULL', () => {
    // There is nothing honest to backfill FROM. A declaration names an
    // install-specific channel and a directory layout, and no central data
    // implies either. Guessing one would be the first place this path invented
    // a binding.
    const db = preMigrationDb();
    migration057.up(db);
    const row = db.prepare(`SELECT attention_sources FROM workgroups WHERE id = 'example-labs'`).get() as {
      attention_sources: string | null;
    };
    expect(row.attention_sources).toBeNull();
    db.close();
  });

  it('leaves onecli_secrets alone', () => {
    const db = preMigrationDb();
    db.prepare(`UPDATE workgroups SET onecli_secrets = ? WHERE id = 'example-labs'`).run('["Example-Secret"]');
    migration057.up(db);
    const row = db.prepare(`SELECT onecli_secrets FROM workgroups WHERE id = 'example-labs'`).get() as {
      onecli_secrets: string;
    };
    expect(row.onecli_secrets).toBe('["Example-Secret"]');
    db.close();
  });

  it('is idempotent — re-running over an already-migrated table is a no-op', () => {
    const db = preMigrationDb();
    migration057.up(db);
    db.prepare(`UPDATE workgroups SET attention_sources = ? WHERE id = 'example-labs'`).run(
      '[{"kind":"release-board","root":"releases","channel_key":"slack:CEXAMPLE001"}]',
    );

    expect(() => migration057.up(db)).not.toThrow();

    const row = db.prepare(`SELECT attention_sources FROM workgroups WHERE id = 'example-labs'`).get() as {
      attention_sources: string | null;
    };
    expect(row.attention_sources).toBe(
      '[{"kind":"release-board","root":"releases","channel_key":"slack:CEXAMPLE001"}]',
    );
    db.close();
  });
});
