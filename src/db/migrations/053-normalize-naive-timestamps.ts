import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Normalizes naive `YYYY-MM-DD HH:MM:SS` values (from `datetime('now')`) to ISO-8601 UTC. Mixed shapes break string
 * comparison (space 0x20 sorts below 'T' 0x54, so 11pm loses to 7am the same day), silently corrupting `MAX(col)` and
 * `col >= ?`. The value is already UTC, so conversion is lossless; the exact 19-character LIKE guard leaves ISO rows
 * alone and makes a re-run a no-op.
 * `chat_sdk_subscriptions.subscribed_at` is excluded: its DDL default still emits the naive shape, so converting it
 * would re-create mixed shapes on the next insert.
 */

/** Columns whose writers now emit ISO, so converting the residue is pure repair. */
const COLUMNS: Array<[table: string, column: string]> = [
  ['sessions', 'last_outbound_at'],
  ['messaging_groups', 'created_at'],
  ['user_roles', 'granted_at'],
  ['agent_destinations', 'created_at'],
  ['memories', 'updated_at'],
  ['backlog_items', 'updated_at'],
  ['backlog_items', 'resolved_at'],
  ['dashboard_tokens', 'used_at'],
  // 052 backfills engaged_at from other columns and so copies their naive residue; this migration runs after it on
  // purpose.
  ['sessions', 'engaged_at'],
];

export const migration053: Migration = {
  version: 53,
  name: 'normalize-naive-timestamps',
  up(db: Database.Database) {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    for (const [table, column] of COLUMNS) {
      // agent_destinations comes from an optional module migration, so a valid install can lack the table.
      if (!tables.has(table)) continue;
      db.prepare(
        `UPDATE "${table}"
            SET "${column}" = replace("${column}", ' ', 'T') || '.000Z'
          WHERE "${column}" LIKE '____-__-__ __:__:__'`,
      ).run();
    }
  },
};
