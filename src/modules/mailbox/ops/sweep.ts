import type Database from 'better-sqlite3';

import { getProcessingClaims } from '../../../mailbox/sqlite/session-db.js';
import { migrateMessagesInTable } from '../schema.js';

export {
  deleteOrphanProcessingClaims,
  getProcessingClaims,
  type ProcessingClaim,
} from '../../../mailbox/sqlite/session-db.js';

/**
 * Earliest FUTURE process_after among pending rows, or null: a quiet session
 * may be skipped only until then, never past it.
 */
export function getNextFutureProcessAfter(db: Database.Database): string | null {
  migrateMessagesInTable(db);
  const row = db
    .prepare(
      `SELECT MIN(process_after) AS next FROM messages_in
       WHERE status = 'pending'
         AND repo_fence_epoch IS NULL
         AND process_after IS NOT NULL
         AND datetime(process_after) > datetime('now')`,
    )
    .get() as { next: string | null };
  return row.next;
}

export function countDueMessages(db: Database.Database): number {
  migrateMessagesInTable(db);
  return (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM messages_in
       WHERE status = 'pending'
         AND repo_fence_epoch IS NULL
         AND trigger = 1
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
      )
      .get() as { count: number }
  ).count;
}

/**
 * A due non-task row older than this no longer forces an interactive wake:
 * backlog must not let a stampede of old chat rows starve a live thread out of
 * the memory-budget queue. An entry already queued as interactive is never
 * demoted (admission only promotes).
 */
const INTERACTIVE_WAKE_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Interactive only when some due triggering row is non-task AND recent; no due
 * rows defaults to interactive (fail-safe under a racing writer). Age is from
 * INSERTION (`timestamp`), not `process_after`: backoff re-stamps process_after
 * on every retry and would keep old backlog "fresh" forever.
 */
export function getDueWakePriority(db: Database.Database): 'interactive' | 'scheduled' {
  migrateMessagesInTable(db);
  const freshCutoffIso = new Date(Date.now() - INTERACTIVE_WAKE_MAX_AGE_MS).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count,
              MAX(CASE WHEN kind <> 'task'
                        AND datetime(timestamp) >= datetime(?)
                       THEN 1 ELSE 0 END) AS has_interactive
         FROM messages_in
        WHERE status = 'pending'
          AND repo_fence_epoch IS NULL
          AND trigger = 1
          AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
    )
    .get(freshCutoffIso) as { count: number; has_interactive: number | null };
  return row.count > 0 && row.has_interactive === 0 ? 'scheduled' : 'interactive';
}

/**
 * Expire long-pending NON-RECURRING rows. Unscheduled rows age from
 * insertion, scheduled rows from their fire time (so a valid multi-day wait
 * isn't expired as it comes due). Recurring rows are NEVER expired here: they
 * cross the cutoff the moment they come due, and reaping one loses the fire and
 * can strand the series. Returns the number expired.
 */
export function expireStalePending(db: Database.Database, maxAgeMs: number): number {
  migrateMessagesInTable(db);
  const cutoffIso = new Date(Date.now() - maxAgeMs).toISOString();
  const result = db
    .prepare(
      `UPDATE messages_in
       SET status = 'expired'
       WHERE status = 'pending'
         AND repo_fence_epoch IS NULL
         AND recurrence IS NULL
         AND (
           (process_after IS NULL AND datetime(timestamp) < datetime(?))
           OR (process_after IS NOT NULL AND datetime(process_after) < datetime(?))
         )`,
    )
    .run(cutoffIso, cutoffIso);
  return result.changes;
}

/**
 * Expire every row still pinning a TERMINALLY CLOSED session: `closed` never
 * returns to active and new inbound creates a fresh session, so nothing here
 * can run, and while `('processing', 'pending')` rows survive
 * (`sessionHasOpenWork`) reclaim refuses the directory forever. No age cutoff,
 * recurrence or fence guard: each exists only for something an active session
 * can still do (re-fire, fence release, claim clearing), and none happens in a
 * closed one. Returns the number expired.
 */
export function expireClosedSessionPending(db: Database.Database): number {
  migrateMessagesInTable(db);
  return db.prepare("UPDATE messages_in SET status = 'expired' WHERE status IN ('pending', 'processing')").run()
    .changes;
}

/**
 * Fused (upstream splits it): maps the runner's two notions of "handled", a
 * terminal `processing_ack` and an answer in `messages_out`, onto
 * `messages_in.status`, which every host due-ness reader keys on. Returns ids
 * completed because they were already answered.
 */
export function syncProcessingAcks(inDb: Database.Database, outDb: Database.Database): string[] {
  const completed = outDb
    .prepare(
      "SELECT message_id, status FROM processing_ack WHERE status IN ('completed', 'failed', 'script-skip:error')",
    )
    .all() as Array<{ message_id: string; status: string }>;

  if (completed.length > 0) {
    // `script-skip:error` lands as FAILED, so recurrence derives the failure
    // streak from the rows themselves.
    const completeStmt = inDb.prepare(
      "UPDATE messages_in SET status = 'completed' WHERE id = ? AND status NOT IN ('completed', 'failed')",
    );
    const failStmt = inDb.prepare(
      "UPDATE messages_in SET status = 'failed' WHERE id = ? AND status NOT IN ('completed', 'failed')",
    );
    inDb.transaction(() => {
      for (const { message_id, status } of completed) {
        (status === 'script-skip:error' ? failStmt : completeStmt).run(message_id);
      }
    })();
  }

  const answered = completeAnsweredPendingRows(inDb, outDb);
  closeOrphanRecallRows(inDb);
  return answered;
}

/**
 * Expire pending `recall-<X>` rows whose target is already terminal (e.g. a
 * script-gated fire acks only the task). Nothing re-pairs them, and
 * `expireStalePending` would only get to them a day later. A row counts as a
 * recall only by the runner's own test (`kind = 'system'`, `recall-` prefix AND
 * `subtype: 'recall_context'`). Idempotent.
 */
export function closeOrphanRecallRows(inDb: Database.Database): number {
  return inDb
    .prepare(
      `UPDATE messages_in
          SET status = 'expired'
        WHERE id >= 'recall-' AND id < 'recall.'
          AND kind = 'system'
          AND status = 'pending'
          AND json_valid(content)
          AND json_extract(content, '$.subtype') = 'recall_context'
          AND EXISTS (
            SELECT 1 FROM messages_in AS target
             WHERE target.id = substr(messages_in.id, 8)
               AND target.status IN ('completed', 'failed', 'expired', 'cancelled')
          )`,
    )
    .run().changes;
}

/**
 * The runner's `parseDbUtc`, statement for statement: the package trees can't
 * share it, and any difference is how host and runner would disagree.
 */
function parseRunnerUtc(value: string): number {
  let s = value.includes('T') ? value : value.replace(' ', 'T');
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z';
  return Date.parse(s);
}

/** Mirrors the runner's `isResponded`: NaN on either side compares false → not answered. */
function answeredSinceDue(answeredAt: string, processAfter: string | null): boolean {
  if (processAfter === null) return true;
  return parseRunnerUtc(answeredAt) >= parseRunnerUtc(processAfter);
}

export const ANSWERED_LOOKUP_CHUNK = 500;

/**
 * Complete due rows with no ack that the runner treats as answered (a non-status
 * reply at/after `process_after`) and will never select again, e.g. a claim
 * deleted at the next container's startup. Otherwise the host counts them due
 * forever and a recurring series never re-arms. The predicate strictly mirrors
 * the runner's (positive comparison, so NaN keeps a row selectable). "Answered,
 * not resumed", never "ran successfully". Rows with any ack are left alone.
 */
export function completeAnsweredPendingRows(inDb: Database.Database, outDb: Database.Database): string[] {
  migrateMessagesInTable(inDb);
  const due = inDb
    .prepare(
      `SELECT id, process_after AS processAfter FROM messages_in
       WHERE status = 'pending'
         AND repo_fence_epoch IS NULL
         AND trigger = 1
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
    )
    .all() as Array<{ id: string; processAfter: string | null }>;
  if (due.length === 0) return [];

  // ONE grouped read per chunk, never per row: `in_reply_to` is unindexed.
  // Chunked under SQLite's bound-variable limit.
  const answeredAt = new Map<string, string>();
  for (let start = 0; start < due.length; start += ANSWERED_LOOKUP_CHUNK) {
    const ids = due.slice(start, start + ANSWERED_LOOKUP_CHUNK).map((row) => row.id);
    const rows = outDb
      .prepare(
        `SELECT in_reply_to AS id, MAX(timestamp) AS ts
           FROM messages_out
          WHERE in_reply_to IN (${ids.map(() => '?').join(', ')})
            AND kind != 'status'
          GROUP BY in_reply_to`,
      )
      .all(...ids) as Array<{ id: string; ts: string }>;
    for (const row of rows) answeredAt.set(row.id, row.ts);
  }
  if (answeredAt.size === 0) return [];

  const completeStmt = inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ? AND status = 'pending'");
  const backfilled: string[] = [];
  for (const { id, processAfter } of due) {
    const ts = answeredAt.get(id);
    if (ts === undefined) continue;
    if (!answeredSinceDue(ts, processAfter)) continue;
    if (hasProcessingAck(outDb, id)) continue;
    if (completeStmt.run(id).changes > 0) backfilled.push(id);
  }
  return backfilled;
}

interface OverdueRecurringRow {
  id: string;
  seriesId: string | null;
  processAfter: string;
}

export interface OverdueRecurringRows {
  rows: OverdueRecurringRow[];
  /** Some other message holds a 'processing' claim: these rows are queued behind that turn. */
  queuedBehindActiveWork: boolean;
}

/**
 * Recurring occurrences DUE since before `cutoffIso` with no ack of their own
 * (`expireStalePending` never reaps them). A claim on a DIFFERENT row does not
 * hide them: a turn that never ends starves the queue, which is what this
 * surfaces. `outDb` is null when no container ever ran.
 */
export function listOverdueRecurringRows(
  inDb: Database.Database,
  outDb: Database.Database | null,
  cutoffIso: string,
): OverdueRecurringRows {
  migrateMessagesInTable(inDb);
  const rows = inDb
    .prepare(
      `SELECT id, series_id AS seriesId, process_after AS processAfter FROM messages_in
       WHERE status = 'pending'
         AND repo_fence_epoch IS NULL
         AND trigger = 1
         AND recurrence IS NOT NULL
         AND process_after IS NOT NULL
         AND datetime(process_after) <= datetime(?)
       ORDER BY seq`,
    )
    .all(cutoffIso) as OverdueRecurringRow[];
  if (!outDb) return { rows, queuedBehindActiveWork: false };
  const unacked = rows.filter((row) => !hasProcessingAck(outDb, row.id));
  return {
    rows: unacked,
    queuedBehindActiveWork: unacked.length > 0 && getProcessingClaims(outDb).length > 0,
  };
}

interface UndeliveredGateRow {
  id: string;
  occurrenceId: string | null;
  seriesId: string | null;
  writtenAt: string;
}

interface WithheldHostGatedRow {
  id: string;
  seriesId: string | null;
  processAfter: string;
}

export interface StuckGateResults {
  undeliveredGateRows: UndeliveredGateRow[];
  withheldHostGatedRows: WithheldHostGatedRow[];
}

/**
 * Delivery retries an unrecorded gate row forever (blocking later rows), and S5
 * withholds a host-gated occurrence whose result couldn't be recorded: both
 * correct and both silent, hence this read. A recorded host wake carries
 * `scriptOutput` (JSON null included).
 */
export function listStuckGateResults(
  inDb: Database.Database,
  outDb: Database.Database | null,
  cutoffIso: string,
): StuckGateResults {
  migrateMessagesInTable(inDb);
  const withheldHostGatedRows = inDb
    .prepare(
      `SELECT id, series_id AS seriesId, process_after AS processAfter FROM messages_in
       WHERE kind = 'task'
         AND status = 'pending'
         AND trigger = 0
         AND repo_fence_epoch IS NULL
         AND process_after IS NOT NULL
         AND datetime(process_after) <= datetime(?)
         AND CASE WHEN json_valid(content) THEN json_extract(content, '$.scriptHost') END = 1
         AND CASE WHEN json_valid(content) THEN json_type(content, '$.scriptOutput') END IS NULL
       ORDER BY seq`,
    )
    .all(cutoffIso) as WithheldHostGatedRow[];
  return {
    undeliveredGateRows: outDb ? undeliveredGateRows(inDb, outDb, cutoffIso) : [],
    withheldHostGatedRows,
  };
}

/** `cutoffIso` null means any age. */
function undeliveredGateRows(
  inDb: Database.Database,
  outDb: Database.Database,
  cutoffIso: string | null,
): UndeliveredGateRow[] {
  const isDelivered = inDb.prepare('SELECT 1 FROM delivered WHERE message_out_id = ? LIMIT 1');
  const seriesOf = inDb.prepare("SELECT series_id FROM messages_in WHERE id = ? AND kind = 'task'").pluck();
  const candidates = outDb
    .prepare(
      `SELECT id, timestamp AS writtenAt,
              CASE WHEN json_valid(content) THEN json_extract(content, '$.gate.occurrenceId') END AS occurrenceId
         FROM messages_out
        WHERE kind = 'task_log'
          AND CASE WHEN json_valid(content) THEN json_type(content, '$.gate') END = 'object'
          AND (@cutoff IS NULL OR datetime(timestamp) <= datetime(@cutoff))
        ORDER BY seq`,
    )
    .all({ cutoff: cutoffIso }) as Array<{ id: string; writtenAt: string; occurrenceId: unknown }>;
  return candidates
    .filter((row) => isDelivered.get(row.id) === undefined)
    .map((row) => {
      const occurrenceId = typeof row.occurrenceId === 'string' ? row.occurrenceId : null;
      return {
        id: row.id,
        writtenAt: row.writtenAt,
        occurrenceId,
        seriesId: occurrenceId === null ? null : ((seriesOf.get(occurrenceId) as string | null | undefined) ?? null),
      };
    });
}

/** Delivery visits active sessions only, so closing a session holding one would lose the result. */
export function hasUnrecordedGateRows(inDb: Database.Database, outDb: Database.Database | null): boolean {
  return outDb !== null && undeliveredGateRows(inDb, outDb, null).length > 0;
}

/**
 * ANY ack in ANY status: a finished claim is still a claim. `messages_in.status`
 * is not a consumption record: it stays `pending` for up to one sweep interval
 * after the container claims.
 */
export function hasProcessingAck(outDb: Database.Database, messageId: string): boolean {
  return outDb.prepare('SELECT 1 FROM processing_ack WHERE message_id = ? LIMIT 1').get(messageId) !== undefined;
}

export interface ContainerState {
  current_tool: string | null;
  tool_declared_timeout_ms: number | null;
  tool_started_at: string | null;
  provider_status?: string | null;
  provider_executing?: number | null;
  provider_last_event_at?: string | null;
  provider_last_probe_at?: string | null;
  provider_probe_failures?: number | null;
  provider_recovery_attempts?: number | null;
  provider_failure_reason?: string | null;
  memory_current_bytes?: number | null;
  memory_peak_bytes?: number | null;
  memory_max_bytes?: number | null;
  memory_oom_events?: number | null;
  memory_oom_kill_events?: number | null;
  /** Ceiling hits that forced reclaim (pre-kill signal). */
  memory_max_events?: number | null;
  memory_telemetry_at?: string | null;
  /**
   * When the CURRENT query first produced a provider event; null until then.
   * Undefined on an older runner's DB, which the claim rule reads as "no forgiveness".
   */
  provider_query_event_at?: string | null;
}

/** Null when the table doesn't exist yet or no tool is active. */
export function getContainerState(outDb: Database.Database): ContainerState | null {
  // Widest column set first: the CONTAINER migrates columns forward, so a DB
  // whose container hasn't respawned has the older shape.
  for (const columns of CONTAINER_STATE_COLUMN_TIERS) {
    try {
      const row = outDb.prepare(`SELECT ${columns} FROM container_state WHERE id = 1`).get() as
        | ContainerState
        | undefined;
      return row ?? null;
    } catch {
      // Try the next-narrower tier.
    }
  }
  return null;
}

const CONTAINER_STATE_TOOL_COLUMNS = 'current_tool, tool_declared_timeout_ms, tool_started_at';
const CONTAINER_STATE_PROVIDER_COLUMNS =
  `${CONTAINER_STATE_TOOL_COLUMNS}, provider_status, provider_executing, provider_last_event_at, ` +
  'provider_last_probe_at, provider_probe_failures, provider_recovery_attempts, provider_failure_reason';
const CONTAINER_STATE_MEMORY_COLUMNS =
  `${CONTAINER_STATE_PROVIDER_COLUMNS}, memory_current_bytes, memory_peak_bytes, memory_max_bytes, ` +
  'memory_oom_events, memory_oom_kill_events, memory_telemetry_at';
// `provider_executing` is the one fork column the HOST adds (the reap needs it),
// so a DB no container has booted yet still has it.
const CONTAINER_STATE_EXECUTING_COLUMNS = `${CONTAINER_STATE_TOOL_COLUMNS}, provider_executing`;
const CONTAINER_STATE_COLUMN_TIERS = [
  // Newest first; a missing column fails over to the tier below.
  `${CONTAINER_STATE_MEMORY_COLUMNS}, memory_max_events, provider_query_event_at`,
  `${CONTAINER_STATE_MEMORY_COLUMNS}, memory_max_events`,
  CONTAINER_STATE_MEMORY_COLUMNS,
  CONTAINER_STATE_PROVIDER_COLUMNS,
  CONTAINER_STATE_EXECUTING_COLUMNS,
  CONTAINER_STATE_TOOL_COLUMNS,
];
