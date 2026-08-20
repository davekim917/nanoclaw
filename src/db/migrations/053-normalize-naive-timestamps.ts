import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 053 — normalize naive timestamps to ISO-8601 UTC
 *
 * SQLite's `datetime('now')` writes UTC in the naive shape
 * `YYYY-MM-DD HH:MM:SS`, which CLAUDE.md's Timestamps rule forbids for
 * anything written from JS: `new Date('2026-08-20 07:00:00')` parses it as
 * LOCAL time, and — the sharper failure — string comparison against an ISO
 * value is wrong for the same date. Space is 0x20 and 'T' is 0x54, so
 * `'2026-08-20 23:00:00' < '2026-08-20T07:00:00.000Z'`: 11pm loses to 7am.
 * Any `MAX(col)` / `col >= ?` over a mixed-shape column silently picks the
 * wrong row (e.g. dashboard/api/observatory.ts's `MAX(last_outbound_at)`,
 * db/backlog.ts's `resolved_at >= $since`).
 *
 * Today every naive column here is either uniformly naive (accidentally
 * self-consistent) or holds a handful of historical naive rows among ISO
 * ones. `sessions.last_outbound_at` is the uniform case: its writer
 * (db/sessions.ts `bumpLastOutbound`) is being switched to
 * `new Date().toISOString()` in the same change, and THAT WRITER FIX AND THIS
 * MIGRATION MUST SHIP TOGETHER — either one alone produces the mixed shape
 * that activates the bug.
 *
 * Conversion is deterministic and lossless: `datetime('now')` is already UTC,
 * so `2026-08-20 07:00:00` is exactly `2026-08-20T07:00:00.000Z`. The LIKE
 * guard pins the exact 19-character naive shape (no trailing `%`), so ISO
 * rows are untouched and re-running is a no-op.
 *
 * Deliberately NOT normalized:
 *   - `chat_sdk_subscriptions.subscribed_at` — its value comes from migration
 *     002's `DEFAULT (datetime('now'))`, a DDL default rather than a JS writer,
 *     and that default still emits the naive shape on every new subscription.
 *     Converting the existing rows would therefore re-manufacture the mixed
 *     shape as soon as the next row lands — for no reader's benefit, since
 *     nothing in src/ reads the column. It stays excluded until the DDL
 *     default is changed.
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
  // Writer fixed in 2994587f (it now binds one ISO value for both the
  // expires_at comparison and this write), so the residue is safe to convert.
  ['dashboard_tokens', 'used_at'],
  // Added when 052 merged. That migration creates engaged_at and backfills it
  // from COALESCE(last_outbound_at, last_active, created_at) — copying whatever
  // shape those columns happen to hold — so the column is born carrying naive
  // residue even though its only writer, markSessionEngaged, emits ISO. This
  // migration runs last by design, after 052 has populated it, which is exactly
  // the case the "last on purpose" note in the array refers to. Without this
  // entry, engaged_at would be the one naive column left in a normalized table.
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
      // ponytail: skip rather than assume. agent_destinations arrives from an
      // optional module migration, so a valid install can lack the table.
      if (!tables.has(table)) continue;
      db.prepare(
        `UPDATE "${table}"
            SET "${column}" = replace("${column}", ' ', 'T') || '.000Z'
          WHERE "${column}" LIKE '____-__-__ __:__:__'`,
      ).run();
    }
  },
};
