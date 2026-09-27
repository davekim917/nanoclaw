import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * `sessions.engaged_at`: set when an agent actually engaged (mention, wake, or inbound agent-to-agent message) by
 * `markSessionEngaged`, first-write-wins; NULL when the row merely exists. `mention-sticky` and the thread-history
 * backfill both depend on set-versus-NULL being unambiguous (reading session existence as engagement minted phantom
 * sessions).
 * The backfill is a RECONSTRUCTION, not a record: pre-existing rows take the dashboard's engaged proxy (posted
 * something, or container not stopped), falling back to `last_active` then `created_at` so a matched row is never
 * NULL. Never read a backfilled value as when engagement happened. It self-heals on re-engagement, so do not open
 * per-session inbound.db files to refine it.
 */
export const migration052: Migration = {
  version: 52,
  name: 'sessions-engaged-at',
  up: (db: Database.Database) => {
    db.exec('ALTER TABLE sessions ADD COLUMN engaged_at TEXT');
    // COALESCE because a bare `<> 'stopped'` is NULL, not true, on a NULL row and would skip it.
    db.exec(`
      UPDATE sessions
         SET engaged_at = COALESCE(last_outbound_at, last_active, created_at)
       WHERE last_outbound_at IS NOT NULL
          OR COALESCE(container_status, 'stopped') <> 'stopped'
    `);
  },
};
