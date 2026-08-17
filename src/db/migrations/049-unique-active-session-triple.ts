/**
 * Migration 049 — unique active session triple
 *
 * A session is the (agent_group, messaging_group, thread) triple, and every
 * lookup (findSessionForAgent / findSessionByAgentGroup) filters
 * status='active' — but nothing in the schema ever said "one active session
 * per triple". resolveSession's find-then-create is synchronous today, so the
 * single-process host cannot interleave it; this index is the durable
 * guarantee that survives any future refactor adding an await between the two
 * halves (flagged in the 2026-08-17 continuation investigation as the one
 * theoretical double-create path).
 *
 * Partial, on purpose: closed sessions are history and may repeat a triple
 * (1,157 closed rows at migration time). COALESCE folds NULLs — a unique
 * index otherwise treats every NULL as distinct, which would exempt exactly
 * the NULL-heavy rows (agent-shared: both NULL; task sessions: mg NULL) the
 * invariant most needs to cover.
 *
 * Verified before authoring: zero duplicate triples exist among active rows,
 * so creation cannot fail on live data.
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
