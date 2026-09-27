import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * One active channel-root session per (agent_group_id, messaging_group_id): lookup-then-insert let concurrent
 * schedule_task calls create duplicates, hiding one task pile. Dedupes first (keeps the most recently active row,
 * archives the rest), then adds a partial unique index; NULL messaging groups (agent-shared sessions) stay
 * unconstrained because SQLite treats NULLs as distinct.
 */
export const migration024: Migration = {
  version: 24,
  name: 'sessions-channel-root-unique',
  up: (db: Database.Database) => {
    const dups = db
      .prepare(
        `SELECT agent_group_id, messaging_group_id
           FROM sessions
          WHERE thread_id IS NULL AND status = 'active' AND messaging_group_id IS NOT NULL
          GROUP BY agent_group_id, messaging_group_id
          HAVING COUNT(*) > 1`,
      )
      .all() as Array<{ agent_group_id: string; messaging_group_id: string }>;

    for (const { agent_group_id, messaging_group_id } of dups) {
      const rows = db
        .prepare(
          `SELECT id
             FROM sessions
            WHERE agent_group_id = ? AND messaging_group_id = ?
              AND thread_id IS NULL AND status = 'active'
            ORDER BY COALESCE(last_active, created_at) DESC, created_at DESC, id ASC`,
        )
        .all(agent_group_id, messaging_group_id) as Array<{ id: string }>;
      const [, ...archive] = rows;
      for (const a of archive) {
        db.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(a.id);
      }
    }

    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS sessions_channel_root_unique
         ON sessions(agent_group_id, messaging_group_id)
         WHERE thread_id IS NULL AND status = 'active' AND messaging_group_id IS NOT NULL`,
    );
  },
};
