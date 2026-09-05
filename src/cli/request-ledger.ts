/**
 * At-most-once execution ledger for the agent `ncl` transport.
 *
 * The `cli_request` delivery action runs the command and then writes the
 * response row. A failure of that WRITE re-dispatches the outbound row, which
 * before this ledger re-ran the command — up to `MAX_DELIVERY_ATTEMPTS` (3)
 * executions of a single `ncl tasks create` (issue #273).
 *
 * The claim is taken before dispatch and completed with the response frame
 * after it, so the retry replays a stored result instead of executing again.
 * The key is (session_id, request_id): request ids are minted in-container as
 * `cli-<ms>-<6 random chars>` and are only unique within a session.
 *
 * A claim is never handed back. Once the host has started acting on a request
 * it cannot prove that nothing happened — `dispatch()` posts approval cards
 * before it can fail, so an exception is "outcome unknown", not "nothing ran".
 */
import { getDb, getRawDb } from '../db/connection.js';
import { log } from '../log.js';
import type { ResponseFrame } from './frame.js';

export type CliRequestClaim =
  /** Nothing has run for this request id — the caller owns dispatching it. */
  | { state: 'fresh' }
  /**
   * A previous attempt claimed the request and left no result to replay: it is
   * still running, the host died mid-dispatch, `dispatch()` threw, or the prune
   * dropped a week-old payload. The command may or may not have applied, so it
   * must not be re-run.
   */
  | { state: 'executing' }
  /** The command already ran; replay this frame instead of dispatching. */
  | { state: 'done'; response: ResponseFrame };

/**
 * Claim the request for execution, or report what a previous attempt did with
 * it. Atomic: the INSERT either wins the row or conflicts, in one statement.
 */
export async function claimCliRequest(
  sessionId: string,
  requestId: string,
  command: string,
): Promise<CliRequestClaim> {
  const claimed = await getDb().get<{ request_id: string }>(
    `INSERT INTO cli_request_executions (session_id, request_id, command, status, claimed_at)
     VALUES (@session_id, @request_id, @command, 'executing', @claimed_at)
     ON CONFLICT(session_id, request_id) DO NOTHING
     RETURNING request_id`,
    {
      session_id: sessionId,
      request_id: requestId,
      command,
      // ISO, never datetime('now') — the naive shape is misparsed as local
      // time by `new Date()`. See the CLAUDE.md timestamp rule.
      claimed_at: new Date().toISOString(),
    },
  );

  if (claimed) return { state: 'fresh' };

  const row = await getDb().get<{ status: string; response: string | null }>(
    `SELECT status, response FROM cli_request_executions WHERE session_id = ? AND request_id = ?`,
    sessionId,
    requestId,
  );

  // The INSERT conflicted, so the row existed a statement ago. Seam 3: this
  // read is now a separate awaited driver call, not one synchronous run with
  // the INSERT above, so in principle something could delete the row in
  // between — but only `pruneCliRequestExecutions` ever deletes a row here,
  // and it only touches ones with `completed_at IS NOT NULL`, which a just-
  // claimed ('executing') row never has. If it somehow has vanished anyway,
  // fail closed: an unknown outcome must never become a second execution.
  if (!row) return { state: 'executing' };

  if (row.status === 'done' && row.response) {
    try {
      return { state: 'done', response: JSON.parse(row.response) as ResponseFrame };
    } catch (err) {
      // A corrupt cached frame is still proof the command ran. Report the
      // ambiguous state rather than re-executing.
      log.warn('Stored cli_request response is not parseable — refusing to re-execute', {
        sessionId,
        requestId,
        err: err instanceof Error ? err.message : String(err),
      });
      return { state: 'executing' };
    }
  }

  // Either still executing, or `done` with the payload dropped by the prune's
  // backstop below. Both mean the same thing to a caller: the command was
  // dispatched and its result is not available to replay, so do not run it
  // again.
  return { state: 'executing' };
}

/** Record the outcome. A retry after this replays `response` verbatim. */
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

/**
 * A row younger than this is never touched, whatever else is true of it. The
 * delivery loop's three attempts land within a couple of sweep cycles, so this
 * is already an order of magnitude of slack on the ordinary retry.
 */
const PRUNE_FLOOR_SECONDS = 600;

/** After this long, a claim keeps its "it ran" fact but drops its payload. */
const PAYLOAD_RETENTION_DAYS = 7;

/**
 * Sweep step.
 *
 * Deliberately NOT an age-based delete. A claim is only safe to drop once its
 * outbound row can no longer be re-dispatched, and elapsed time does not prove
 * that: a host that restarts mid-retry resets the delivery loop's in-memory
 * attempt counter, so an hours-old undelivered row is still retryable, and
 * deleting its claim would let the command run a second time — the hole this
 * table exists to close.
 *
 * The terminal test is ordering, not age. `drainSession` breaks on the first
 * failed row and resumes from it, so a session's later outbound rows cannot be
 * delivered past a stuck one. A NEWER completed request from the same session
 * is therefore proof that this one's outbound row already reached a terminal
 * state — delivered, or dropped by `markDeliveryFailed` after three attempts.
 * Either way nothing will dispatch it again.
 *
 * "Newer" is the table's implicit `rowid` (insertion order), not `claimed_at`.
 * The primary key is a composite (session_id, request_id), so SQLite still
 * assigns every row a monotonically increasing rowid; wall-clock time does
 * not have that guarantee — a host restart followed by an NTP step backward
 * can hand a chronologically later claim an earlier `claimed_at` than one
 * that preceded it, which would let this query prune a still-retryable claim
 * out from under an in-flight retry and reopen the exact hole this table
 * exists to close. `claimed_at` is still the PRUNE_FLOOR_SECONDS gate below —
 * that's a conservative floor, not a correctness proof, so wall-clock slop
 * there only ever makes pruning more cautious, never less.
 *
 * That leaves the newest claim per session, plus any claim from a session that
 * never spoke again. Those keep their row and lose only their cached response
 * after a week, which costs a replay its stored frame but not the at-most-once
 * guarantee: a claim with no payload reports `executing`, and the agent is told
 * the command was dispatched rather than having it run again.
 */
export function pruneCliRequestExecutions(): void {
  try {
    const db = getRawDb();

    db.prepare(
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
    ).run();

    db.prepare(
      `UPDATE cli_request_executions
          SET response = NULL
        WHERE response IS NOT NULL
          AND datetime(claimed_at) < datetime('now', '-${PAYLOAD_RETENTION_DAYS} days')`,
    ).run();
  } catch (err) {
    log.warn('pruneCliRequestExecutions: failed', { err });
  }
}
