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
 */
import { getDb } from '../db/connection.js';
import { log } from '../log.js';
import type { ResponseFrame } from './frame.js';

export type CliRequestClaim =
  /** Nothing has run for this request id — the caller owns dispatching it. */
  | { state: 'fresh' }
  /**
   * A previous attempt claimed the request and never recorded an outcome — the
   * host died between dispatch and completion. The command may or may not have
   * applied, so it must not be re-run.
   */
  | { state: 'executing' }
  /** The command already ran; replay this frame instead of dispatching. */
  | { state: 'done'; response: ResponseFrame };

/**
 * Claim the request for execution, or report what a previous attempt did with
 * it. Atomic: the INSERT either wins the row or conflicts, in one statement.
 */
export function claimCliRequest(sessionId: string, requestId: string, command: string): CliRequestClaim {
  const db = getDb();

  const claimed = db
    .prepare(
      `INSERT INTO cli_request_executions (session_id, request_id, command, status, claimed_at)
       VALUES (@session_id, @request_id, @command, 'executing', @claimed_at)
       ON CONFLICT(session_id, request_id) DO NOTHING
       RETURNING request_id`,
    )
    .get({
      session_id: sessionId,
      request_id: requestId,
      command,
      // ISO, never datetime('now') — the naive shape is misparsed as local
      // time by `new Date()`. See the CLAUDE.md timestamp rule.
      claimed_at: new Date().toISOString(),
    }) as { request_id: string } | undefined;

  if (claimed) return { state: 'fresh' };

  const row = db
    .prepare(`SELECT status, response FROM cli_request_executions WHERE session_id = ? AND request_id = ?`)
    .get(sessionId, requestId) as { status: string; response: string | null } | undefined;

  // The INSERT conflicted, so the row existed a statement ago. better-sqlite3
  // is synchronous and the host is single-threaded, so nothing can have
  // deleted it in between — but if it somehow has, fail closed: an unknown
  // outcome must never become a second execution.
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

  return { state: 'executing' };
}

/** Record the outcome. A retry after this replays `response` verbatim. */
export function completeCliRequest(sessionId: string, requestId: string, response: ResponseFrame): void {
  getDb()
    .prepare(
      `UPDATE cli_request_executions
          SET status = 'done', response = @response, completed_at = @completed_at
        WHERE session_id = @session_id AND request_id = @request_id AND status != 'done'`,
    )
    .run({
      session_id: sessionId,
      request_id: requestId,
      response: JSON.stringify(response),
      completed_at: new Date().toISOString(),
    });
}

/**
 * Drop a claim whose command provably never ran.
 *
 * `dispatch()` turns every command-handler failure into an error frame, so an
 * exception escaping it comes from its own pre-handler plumbing — registry
 * lookup, container-config read, guard evaluation, approval carding. Releasing
 * the claim there keeps the pre-#273 behavior for a genuinely failed dispatch:
 * the delivery loop retries and the command gets its first real attempt.
 */
export function releaseCliRequest(sessionId: string, requestId: string): void {
  getDb()
    .prepare(`DELETE FROM cli_request_executions WHERE session_id = ? AND request_id = ? AND status = 'executing'`)
    .run(sessionId, requestId);
}

/** Retry window is seconds; an hour of history is already generous. */
const CLI_REQUEST_LEDGER_TTL_SECONDS = 3600;

/**
 * Sweep step. Completed frames are only needed while the delivery loop can
 * still retry the row, and an `executing` row only has to outlive the retry
 * that follows a host restart.
 */
export function pruneCliRequestExecutions(): void {
  try {
    getDb()
      .prepare(
        `DELETE FROM cli_request_executions
          WHERE datetime(claimed_at) < datetime('now', '-${CLI_REQUEST_LEDGER_TTL_SECONDS} seconds')`,
      )
      .run();
  } catch (err) {
    log.warn('pruneCliRequestExecutions: failed', { err });
  }
}
