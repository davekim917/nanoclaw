/**
 * Where `messaging_groups.name` came from (`"<platform>:<source>"`, e.g. `slack:classified`), so the raw metadata
 * fetch cannot clobber the classifier's enriched name on every restart. Read and written only through
 * `src/db/messaging-groups.ts`. The backfill stamps named rows `<channel_type>:adapter`, which preserves their
 * behavior; unnamed rows stay NULL.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration069: Migration = {
  version: 69,
  name: 'messaging-group-name-source',
  up(db: Database.Database) {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (cols.has('name_source')) return;
    db.exec(`ALTER TABLE messaging_groups ADD COLUMN name_source TEXT`);
    db.exec(`UPDATE messaging_groups SET name_source = channel_type || ':adapter' WHERE name IS NOT NULL`);
  },
};
