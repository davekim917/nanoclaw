import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * One row per routing check (`src/thread-route-check.ts`): the score Jev gave a candidate thread for a post, and what
 * the host did with it, kept so the threshold can be re-tuned on live decisions. `score` is NULL when the check
 * failed; `error` says why.
 */
export const migration086: Migration = {
  version: 86,
  name: 'thread-route-checks',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_route_checks (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        checked_at           TEXT NOT NULL,
        agent_group_id       TEXT NOT NULL,
        messaging_group_id   TEXT NOT NULL,
        session_id           TEXT NOT NULL,
        message_out_id       TEXT NOT NULL,
        thread_key           TEXT NOT NULL,
        check_point          TEXT NOT NULL CHECK (check_point IN ('a', 'b', 'c')),
        candidate_thread_id  TEXT NOT NULL,
        thread_last_activity TEXT,
        score                REAL,
        threshold            REAL NOT NULL,
        decision             TEXT NOT NULL CHECK (decision IN ('keep', 'veto')),
        latency_ms           INTEGER NOT NULL,
        model                TEXT NOT NULL,
        error                TEXT,
        split_thread_key     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_thread_route_checks_checked_at ON thread_route_checks(checked_at);
    `);
  },
};
