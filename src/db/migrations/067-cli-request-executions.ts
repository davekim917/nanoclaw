import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * At-most-once execution ledger for the agent `ncl` transport (`src/cli/delivery-action.ts`). The command runs BEFORE
 * the `cli_response` write, so a failed write made the delivery loop re-run it (three `ncl tasks create` series for
 * one ask). The row is claimed before dispatch and completed with the response frame, so a retry replays the frame.
 * `session_id` is in the key because request ids are only unique per session.
 * `executing` means claimed, outcome unknown: a retry must NOT re-run it (a dispatch that throws before the handler
 * ran deletes its claim). `done` holds the frame to replay.
 * Never pruned on a wall clock alone, since an aged claim the loop can still retry would reopen the hole: a row is
 * terminal once its session has a NEWER completed request by rowid, not `claimed_at` (wall clock is not monotonic
 * across a restart plus NTP step). See `pruneCliRequestExecutions`.
 */
export const migration067: Migration = {
  version: 67,
  name: 'cli-request-executions',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cli_request_executions (
        session_id   TEXT NOT NULL,
        request_id   TEXT NOT NULL,
        command      TEXT NOT NULL,
        status       TEXT NOT NULL,   -- 'executing' | 'done'
        response     TEXT,            -- ResponseFrame JSON; NULL until done
        claimed_at   TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (session_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cli_request_executions_prune
        ON cli_request_executions(session_id, claimed_at);
    `);
  },
};
