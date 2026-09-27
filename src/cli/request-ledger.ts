/**
 * At-most-once execution ledger for the agent `ncl` transport. The command runs before the response write, and a
 * failed write re-dispatches the outbound row, so without a claim the command re-runs. Keyed (session_id, request_id)
 * because request ids are only unique per session.
 * A claim is never handed back: once the host has acted it cannot prove nothing happened (`dispatch()` posts approval
 * cards before it can fail), so an exception means "outcome unknown", not "nothing ran".
 */
import { getDb } from '../db/connection.js';
import { log } from '../log.js';
import type { ResponseFrame } from './frame.js';

export type CliRequestClaim =
  /** The caller owns dispatching it. */
  | { state: 'fresh' }
  /**
   * Claimed with no result to replay (still running, host died, `dispatch()` threw, or the payload was pruned). It
   * may have applied, so it must not re-run.
   */
  | { state: 'executing' }
  /** Replay this frame instead of dispatching. */
  | { state: 'done'; response: ResponseFrame };

/** Atomic: the INSERT wins the row or conflicts in one statement. */
export async function claimCliRequest(sessionId: string, requestId: string, command: string): Promise<CliRequestClaim> {
  const claimed = await getDb().get<{ request_id: string }>(
    `INSERT INTO cli_request_executions (session_id, request_id, command, status, claimed_at)
     VALUES (@session_id, @request_id, @command, 'executing', @claimed_at)
     ON CONFLICT(session_id, request_id) DO NOTHING
     RETURNING request_id`,
    {
      session_id: sessionId,
      request_id: requestId,
      command,
      // ISO, never `datetime('now')`.
      claimed_at: new Date().toISOString(),
    },
  );

  if (claimed) return { state: 'fresh' };

  const row = await getDb().get<{ status: string; response: string | null }>(
    `SELECT status, response FROM cli_request_executions WHERE session_id = ? AND request_id = ?`,
    sessionId,
    requestId,
  );

  // A separate await from the INSERT, but the prune only deletes rows with `completed_at` set, which a just-claimed
  // row lacks. If it vanished anyway, fail closed: an unknown outcome must never become a second execution.
  if (!row) return { state: 'executing' };

  if (row.status === 'done' && row.response) {
    try {
      return { state: 'done', response: JSON.parse(row.response) as ResponseFrame };
    } catch (err) {
      // A corrupt cached frame still proves the command ran.
      log.warn('Stored cli_request response is not parseable — refusing to re-execute', {
        sessionId,
        requestId,
        err: err instanceof Error ? err.message : String(err),
      });
      return { state: 'executing' };
    }
  }

  // Still executing, or done with its payload pruned: either way it must not run again.
  return { state: 'executing' };
}

/** A retry after this replays `response` verbatim. */
export async function completeCliRequest(sessionId: string, requestId: string, response: ResponseFrame): Promise<void> {
  await getDb().run(
    `UPDATE cli_request_executions
        SET status = 'done', response = @response, completed_at = @completed_at
      WHERE session_id = @session_id AND request_id = @request_id AND status != 'done'`,
    {
      session_id: sessionId,
      request_id: requestId,
      response: JSON.stringify(response),
      completed_at: new Date().toISOString(),
    },
  );
}

/** Rows younger than this are never touched; the delivery loop's retries land well within it. */
const PRUNE_FLOOR_SECONDS = 600;

/** After this, a claim keeps its "it ran" fact but drops its payload. */
const PAYLOAD_RETENTION_DAYS = 7;

/**
 * NOT an age-based delete: a restart mid-retry resets the in-memory attempt counter, so an old undelivered row can
 * still be re-dispatched, and dropping its claim would re-run the command.
 * The terminal test is ordering: `drainSession` stops at the first failed row, so a NEWER completed request in the
 * same session proves this one's outbound row is terminal. "Newer" is by `rowid`, not `claimed_at`, since wall clock
 * is not monotonic across a restart plus NTP step; `claimed_at` only feeds the conservative floor.
 * The newest claim per session survives and loses only its payload after a week, which then reports `executing`
 * rather than re-running.
 */
export async function pruneCliRequestExecutions(): Promise<void> {
  try {
    await getDb().run(
      `DELETE FROM cli_request_executions
        WHERE completed_at IS NOT NULL
          AND datetime(claimed_at) < datetime('now', '-${PRUNE_FLOOR_SECONDS} seconds')
          AND EXISTS (
                SELECT 1
                  FROM cli_request_executions newer
                 WHERE newer.session_id = cli_request_executions.session_id
                   AND newer.completed_at IS NOT NULL
                   AND newer.rowid > cli_request_executions.rowid
              )`,
    );

    await getDb().run(
      `UPDATE cli_request_executions
          SET response = NULL
        WHERE response IS NOT NULL
          AND datetime(claimed_at) < datetime('now', '-${PAYLOAD_RETENTION_DAYS} days')`,
    );
  } catch (err) {
    log.warn('pruneCliRequestExecutions: failed', { err });
  }
}
