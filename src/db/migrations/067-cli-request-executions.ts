import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 067 — cli_request_executions
 *
 * At-most-once execution ledger for the agent `ncl` transport
 * (`src/cli/delivery-action.ts`).
 *
 * The `cli_request` delivery action executes the command and THEN writes the
 * `cli_response` row. If that write throws — descriptor exhaustion, a session
 * reclaimed mid-flight, a transient SQLite error — the handler rejects, the
 * delivery loop counts a failed delivery and re-dispatches the same outbound
 * row on the next poll, running the command a second and third time
 * (`MAX_DELIVERY_ATTEMPTS` is 3). For `ncl tasks create`, whose series id
 * comes from `randomUUID()` per invocation, that is three scheduled series
 * where the agent asked for one (issue #273).
 *
 * The row is claimed BEFORE dispatch and completed with the response frame
 * after, so a retry replays the stored frame instead of re-running the
 * command. `session_id` is part of the key because request ids are minted
 * in-container as `cli-<ms>-<6 random chars>` and are only unique per session.
 *
 * `status`:
 *   - `executing` — claimed, outcome unknown. A retry that finds this row is
 *     the second attempt after the host died mid-dispatch; it must NOT re-run
 *     the command. A dispatch that throws before the command handler ran
 *     deletes its own claim, so `executing` never means "never started".
 *   - `done` — `response` holds the ResponseFrame JSON to replay.
 *
 * Rows are pruned by the host sweep, but never on a wall clock alone: an aged
 * claim that the delivery loop can still retry would re-open the exact hole
 * this table closes. The prune's index is (session_id, claimed_at) because the
 * terminal test is "does this session have a NEWER completed request" — see
 * `pruneCliRequestExecutions`.
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
