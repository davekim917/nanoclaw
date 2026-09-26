/**
 * Sweep-side reads and status transitions: due counting, staleness, retries,
 * processing-ack reconciliation and the tiered container-state read.
 * Internal to `src/modules/mailbox/`.
 */
import type Database from 'better-sqlite3';

import { getProcessingClaims } from '../../../mailbox/sqlite/session-db.js';
import { migrateMessagesInTable } from '../schema.js';

export {
  deleteOrphanProcessingClaims,
  getProcessingClaims,
  type ProcessingClaim,
} from '../../../mailbox/sqlite/session-db.js';

/**
 * Earliest FUTURE process_after among pending rows, or null. Used by the host
 * sweep's quiet-session cache: a session with nothing due may be skipped only
 * until its next scheduled row becomes due — never past it.
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
 * A due non-task row older than this no longer forces an interactive wake.
 * Nobody is sitting on the other end of a 15-minute-old message the way they
 * are for one sent seconds ago — rows past this age are backlog (channel
 * recovery after a restart, stale-reset retries) and must not let a stampede
 * of old chat rows starve a live thread out of the memory-budget queue.
 * Demotion is decided per wake attempt from row age; an entry already queued
 * as interactive is never demoted (admission promotes only, see
 * MemoryAdmissionController.request), so a fresh message that then waits in
 * a full queue keeps its class.
 */
const INTERACTIVE_WAKE_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Priority for a session wake based on the work that is due right now.
 * A wake is interactive only when some due triggering row is BOTH non-task
 * (chat, system notification, approval, agent message) AND recent — see
 * INTERACTIVE_WAKE_MAX_AGE_MS. Scheduled-task rows and aged backlog rows
 * classify as scheduled. No due rows defaults to interactive, which is the
 * fail-safe classification for callers racing with another writer.
 * Age is measured from INSERTION (`timestamp`), deliberately not from
 * `process_after`: stale-reset backoff stamps a fresh fire time on every
 * retry, which would keep months-old backlog permanently "fresh". Insertion
 * time is when the human-visible event actually happened, which is the only
 * thing interactive priority is about.
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
 * Mark long-pending NON-RECURRING rows as 'expired' so sweep stops re-waking
 * sessions on one-shot messages that have sat unprocessed for a day or more.
 * Unscheduled rows age from insertion; scheduled rows age from their fire
 * time, so a valid multi-day wait is not expired at the moment it becomes due.
 *
 * Recurring tasks (recurrence IS NOT NULL) are NEVER expired here. A recurring
 * row is inserted ~24h before its next daily fire, so it crosses the staleness
 * cutoff the moment it comes due — reaping it would silently lose that fire and
 * (since handleRecurrence only resumes completed/failed/expired rows) used to
 * strand the whole series. They instead stay 'pending' and are re-fired by the
 * sweep (caught up if a fire was missed), then advanced to their next slot by
 * handleRecurrence on completion. A missed recurring fire must resume the
 * schedule, never get reaped. (The earlier `process_after >= now` framing only
 * protected FUTURE-dated rows and let due recurring rows be reaped — that
 * stranded wiki-synth across all memory-enabled agents on 2026-05-10.)
 *
 * Returns the number of rows expired this call.
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
 * Mark every row that still pins a TERMINALLY CLOSED session as 'expired'.
 *
 * `closed` is terminal for a session row: the only transition back to 'active'
 * is from 'archiving' (`releaseArchivingRow`), never from 'closed', and
 * `findSessionForAgent` matches active rows only — the next inbound for the
 * same thread creates a FRESH session. So nothing left in a closed session's
 * inbound can ever be consumed.
 *
 * The status set is exactly the one `sessionHasOpenWork` (src/storage-manager.ts)
 * counts, `('processing', 'pending')`, because that predicate is what these
 * rows pin: while any of them survives, reclaim refuses to archive the
 * directory and the session dir is stranded forever.
 *
 * Unlike `expireStalePending` above this takes NO age cutoff and applies NO
 * recurrence or fence guard, and each omission is deliberate:
 *
 *  - Age is the wrong discriminator. The question is not "has this waited long
 *    enough" but "can this ever run", and for a closed session the answer is
 *    no at any age.
 *  - The recurrence guard exists because reaping a DUE recurring row skips a
 *    fire and used to strand the whole series (wiki-synth, 2026-05-10). What
 *    makes that guard work is `handleRecurrence` re-firing the row on a later
 *    sweep — and that is duty S18 inside the per-session loop, which iterates
 *    ACTIVE sessions only. In a closed session the guard protects nothing: the
 *    series cannot fire and cannot be advanced, so keeping the row 'pending'
 *    preserves no schedule, it only pins the directory. A live series also
 *    cannot reach the close in the first place — `countLiveTasks` counts
 *    pending/paused task rows and S19 refuses to close while it is non-zero —
 *    so a recurring row here is already an anomaly, not a working schedule.
 *  - A `repo_fence_epoch` row waits for an ingress fence release that only a
 *    running container in this session can produce; there will not be one.
 *  - `processing` is included for the same reason: the claiming container is
 *    gone, and the duties that clear orphaned claims (S4, S17) also only ever
 *    see active sessions, so nothing will ever ack it.
 *
 * Returns the number of rows expired this call.
 */
export function expireClosedSessionPending(db: Database.Database): number {
  migrateMessagesInTable(db);
  return db.prepare("UPDATE messages_in SET status = 'expired' WHERE status IN ('pending', 'processing')").run()
    .changes;
}

/**
 * Fused read-outbound/write-inbound reconciliation. Upstream splits this into
 * `getTerminalProcessingAcks()` + `applyProcessingAcks()`; the fork keeps it
 * fused because both handles are already in scope inside a mailbox session and
 * the host sweep's control flow is written around one call.
 *
 * This is the one place the runner's notion of "handled" is mapped onto
 * `messages_in.status`, which is what every host reader of due-ness keys on
 * (`countDueMessages`, `getDueWakePriority`, recurrence fan-out). The runner
 * has TWO ways of treating a row as handled, and both are reconciled here:
 * a terminal `processing_ack`, and an answer in `messages_out`
 * (`completeAnsweredPendingRows` below).
 *
 * Returns the ids completed because they were already answered, so the caller
 * can log them; terminal-ack syncs are the normal path and stay silent.
 */
export function syncProcessingAcks(inDb: Database.Database, outDb: Database.Database): string[] {
  const completed = outDb
    .prepare(
      "SELECT message_id, status FROM processing_ack WHERE status IN ('completed', 'failed', 'script-skip:error')",
    )
    .all() as Array<{ message_id: string; status: string }>;

  if (completed.length > 0) {
    // `script-skip:error` (pre-task script crashed) lands as a FAILED run —
    // semantically true, and it lets recurrence derive the trailing failed
    // streak from the occurrence rows themselves (no stored counter).
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
 * Close every pending `recall-<X>` row whose target `<X>` is already terminal:
 * `completed`, `failed`, `expired`, or `cancelled` (an admitted task cancelled
 * before the runner claimed it keeps its recall, `cancelTask` in
 * src/mailbox/sqlite/tasks.ts; nothing revives a cancelled row).
 *
 * Admission writes the recall row beside its turn (`admitDueRow`) and a normal turn claims and
 * acks both. A turn that ends without claiming its recall leaves it pending: a
 * script-gated or script-errored task fire, where the runner acks only the task
 * (`completed` or `script-skip:error`) and defers the
 * unclaimed rest, or a /clear
 * completed inline. The runner's selection already treats such a row as dead,
 * nothing re-pairs it once its target is terminal (admission needs the target pending,
 * `DUE_PREDICATE`), and `expireStalePending` above expires
 * it 24 hours later anyway. This expires it on the same tick instead, so a
 * watcher on a 5-minute cadence stops carrying a day of dead recall payloads
 * through every poll's candidate windows.
 *
 * A row counts as a recall only by the runner's own test — `kind = 'system'`,
 * the `recall-` id prefix AND `subtype: 'recall_context'` content
 * (`recallTargetId` in the runner's mailbox selection),
 * which both writers stamp (the session manager for the admitted recall;
 * ingress for the deferred marker). A system row
 * that merely shares the prefix is not ours to expire.
 *
 * `expired` is exactly the state `expireStalePending` would give it. The query
 * also matches orphans left before this ran, so the first tick after deploy
 * clears each visited session's backlog. Idempotent.
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
 * Complete due wake rows the runner will never select again because they are
 * already answered.
 *
 * The runner drops a pending row from selection when `messages_out` holds a
 * non-status row with `in_reply_to` = its id, written at/after the row's
 * `process_after` (any time, for a row without one) — `isResponded` in the
 * runner's mailbox selection. `in_reply_to` is stamped from the CLAIMED batch
 * by the runner's poll loop, so such a row was claimed
 * once. Normally the claim turns terminal and the sync above completes the
 * row. It does not when the turn ends without `markCompleted` — a batch
 * deferred to the fallback provider keeps its 'processing' claim
 * — and the next container's startup then deletes
 * every 'processing' claim (`clearStaleProcessingAcks`). What is
 * left is a row with no ack at all that the runner treats as handled and the
 * host still counts as due: the wake duty sees due work behind a running
 * container, the idle-task reap sees due work and declines, and a recurring
 * row is exempt from `expireStalePending`, so its series never re-arms
 * (observed live 2026-09-15: one series silent for 57 hours across two containers).
 *
 * The predicate is a strict mirror of the runner's, so this can only complete
 * a row the runner would never run — including on malformed data: the runner's
 * `ts >= parseDbUtc(process_after)` is false when either side is NaN, so the
 * row stays selectable there, and `answeredSinceDue` below is the same POSITIVE
 * comparison rather than its negation. Completing here means "answered, will
 * not be resumed", never "ran successfully". It is no grace period's business: the
 * answer's timestamp and the row's `process_after` are both already written,
 * and only the host moves `process_after` (synchronously, not under this
 * call). A row carrying ANY ack is left alone — a live claim belongs to the
 * container, a terminal one to the sync above, an orphan 'processing' one to
 * `resetStuckProcessingRows` in sweep-session-core.
 *
 * Writes inbound only. The due filter is `countDueMessages`' own, so the rows
 * considered are exactly the rows that hold a session "due".
 */
/**
 * The runner's own timestamp reading, statement for statement (`parseDbUtc` in
 * the runner's mailbox selection) — the two
 * package trees cannot share a module, and a looser or stricter parse here is
 * exactly how the host and the runner would come to disagree again.
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

/** Ids per grouped `messages_out` read in `completeAnsweredPendingRows`. */
export const ANSWERED_LOOKUP_CHUNK = 500;

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

  // ONE grouped read per chunk, never one per due row: `messages_out.in_reply_to`
  // is unindexed, so each lookup is a scan of the session's whole outbound
  // history, and a backlog of due rows would multiply that inside the sweep's
  // synchronous turn. Same statement shape as the runner's own read in its
  // mailbox selection. Chunked under SQLite's bound-variable limit (999 on
  // older builds).
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
  /**
   * True when some other message in this session holds a 'processing' claim:
   * the rows above are waiting behind that turn rather than unclaimed with
   * nothing running.
   */
  queuedBehindActiveWork: boolean;
}

/**
 * Recurring occurrences that have been DUE and wake-eligible since before
 * `cutoffIso` and that no container has acknowledged.
 *
 * The due filter is `countDueMessages`' own, narrowed to recurring rows that
 * carry a `process_after`: these are the rows that hold a session "due" and
 * that `expireStalePending` never reaps, so nothing else ever ends their wait.
 *
 * A row with an ack of its own (any status) is somebody's and is left out —
 * see `hasProcessingAck`. A claim on a DIFFERENT row does not hide this one: a
 * turn that never ends starves every row queued behind it, and that is exactly
 * the stuck schedule this read exists to surface. `queuedBehindActiveWork`
 * reports that case so the alert can say so. `outDb` is null for a session
 * that has never run a container: nothing can have claimed.
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

/**
 * Has a container acknowledged this inbound message at all?
 *
 * ANY row, in ANY status — deliberately not just `'processing'`. The question
 * is whether a container ever reached the message, and a claim it has since
 * finished is still a claim: by the time the host asks, the row may already
 * read `completed`, `failed` or `script-skip:error`.
 *
 * This is the only durable record of consumption the host can see promptly.
 * `messages_in.status` is NOT: the container claims by writing here, in
 * `outbound.db`, and the inbound row stays `pending` until a later sweep tick
 * runs `syncProcessingAcks`. Anything that reads inbound `status` to decide
 * whether a message was consumed has a window, one sweep interval wide, in
 * which a claimed message looks untouched.
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
  /** memory.events:max — ceiling hits that forced reclaim (pre-kill signal). */
  memory_max_events?: number | null;
  memory_telemetry_at?: string | null;
  /**
   * When the container's CURRENT query first produced a provider event; null
   * until it has, and between queries. Written by the runner
   * (container/agent-runner/src/modules/mailbox/container-state.ts,
   * `markProviderQueryEvent`); undefined on an outbound.db an older runner
   * created, which the claim rule reads as "no forgiveness".
   */
  provider_query_event_at?: string | null;
}

/**
 * Read the container's current tool-in-flight state, if any. Returns null
 * when either the table doesn't exist yet (older session DB) or no tool is
 * active. Host sweep reads this to widen stuck-detection tolerance while a
 * declared Bash operation or a bounded native Codex item is in flight.
 */
export function getContainerState(outDb: Database.Database): ContainerState | null {
  // Widest column set first, narrowing on each failure. Session DBs are
  // migrated forward by the CONTAINER (connection.ts forwardColumns), so a
  // session whose container has not respawned since a column was added still
  // has the older shape — dropping straight to the tool-only tier would
  // silently take resource telemetry away from every such session.
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
// `provider_executing` is the one fork column the HOST adds itself
// (schema.ts's ensureSchema), because the reap decision needs it; every other
// fork column arrives when the container first boots and runs its own
// ensureNanoclawOutboundSchema. Without this tier a session DB the host
// prepared but no container has booted yet drops straight to the tool-only
// tier and the column the host just added reads back as undefined.
const CONTAINER_STATE_EXECUTING_COLUMNS = `${CONTAINER_STATE_TOOL_COLUMNS}, provider_executing`;
const CONTAINER_STATE_COLUMN_TIERS = [
  // Newest first. A DB whose container has not yet run a runner that adds
  // provider_query_event_at fails this SELECT with "no such column" and reads
  // the tier below, exactly as it did before the column existed.
  `${CONTAINER_STATE_MEMORY_COLUMNS}, memory_max_events, provider_query_event_at`,
  `${CONTAINER_STATE_MEMORY_COLUMNS}, memory_max_events`,
  CONTAINER_STATE_MEMORY_COLUMNS,
  CONTAINER_STATE_PROVIDER_COLUMNS,
  CONTAINER_STATE_EXECUTING_COLUMNS,
  CONTAINER_STATE_TOOL_COLUMNS,
];
