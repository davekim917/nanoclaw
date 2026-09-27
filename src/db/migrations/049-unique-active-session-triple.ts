/**
 * One ACTIVE session per (agent_group, messaging_group, thread): the durable guarantee against a double-create if
 * `resolveSession`'s find-then-create ever gains an await. Partial, because closed sessions may repeat a triple.
 * COALESCE folds NULLs, since a unique index treats each NULL as distinct and would exempt exactly the agent-shared
 * and task sessions.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration049: Migration = {
  version: 49,
  name: 'unique-active-session-triple',
  up(db: Database.Database) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active_triple
        ON sessions(agent_group_id, COALESCE(messaging_group_id, ''), COALESCE(thread_id, ''))
        WHERE status = 'active';
    `);
  },
};
