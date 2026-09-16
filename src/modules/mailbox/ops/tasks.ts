/**
 * Task rows: `messages_in` rows with `kind='task'`.
 *
 * Internal to `src/modules/mailbox/`. The scheduling module used to own this
 * SQL (`src/modules/scheduling/db.ts`, 404 L) and executed it on handles its
 * callers passed in; the seam moves the statements here and leaves that file a
 * façade of these ops (plan §4.4, Ingress row).
 *
 * Five statements are byte-identical to upstream's `src/mailbox/sqlite/tasks.ts`
 * and are RE-EXPORTED from there rather than copied — invariant I-2, one
 * implementation of any SQL statement. The rest are fork-only, because the
 * fork's task rows carry routing (`platform_id`/`channel_type`/`thread_id`),
 * land inert (`trigger = 0`, admitted later by the due-time recall seam), and
 * invalidate an already-admitted recall row on every live edit — none of which
 * upstream's task writer does.
 */
import type Database from 'better-sqlite3';

import { cancelTask, clearRecurrence } from '../../../mailbox/sqlite/tasks.js';
import { migrateMessagesInTable } from '../schema.js';
import { sqliteUtcToIso } from '../sqlite-utc.js';
import { nextEvenSeq } from './ingress.js';

// Byte-identical to the fork's own copies; upstream owns the implementation.
export {
  cancelAllTasks,
  cancelTask,
  clearRecurrence,
  deleteTask,
  trailingFailedRuns,
} from '../../../mailbox/sqlite/tasks.js';

/**
 * Insert one pending task occurrence. `seriesId` is the series join key — equal
 * to `id` for a brand-new series, or the existing series for a recurrence clone
 * or an on-demand run.
 *
 * New-style `ncl tasks` rows fire into an isolated system session and pass no
 * routing (platform/channel/thread default NULL). Fork: MCP-scheduled tasks
 * (actions.ts) and recurrence clones DO carry routing — channel-scoped tasks
 * post to their channel and thread-scoped loops report in-thread, so the
 * columns must survive every re-arm (task-reply routing, dac5d9b3).
 *
 * Not upstream's `insertTaskRow`: that one is built from `createTaskInboundRecord`,
 * which hardcodes `trigger: true` and NULL routing. A fork task row must land
 * inert (`trigger = 0`) so neither a warm poller nor the cold-wake query can
 * claim it before the host-owned due-admission seam builds its recall context.
 */
export interface TaskRowInsert {
  id: string;
  seriesId: string;
  processAfter: string | null;
  recurrence: string | null;
  content: string;
  status?: 'pending' | 'paused';
  platformId?: string | null;
  channelType?: string | null;
  threadId?: string | null;
}

export function insertTaskRow(db: Database.Database, row: TaskRowInsert): void {
  migrateMessagesInTable(db);
  db.prepare(
    `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, scheduled_for, recurrence, kind, platform_id, channel_type, thread_id, content, series_id, trigger)
     VALUES (@id, @seq, @timestamp, @status, 0, @processAfter, @processAfter, @recurrence, 'task', @platformId, @channelType, @threadId, @content, @seriesId, 0)`,
  ).run({
    status: 'pending',
    platformId: null,
    channelType: null,
    threadId: null,
    ...row,
    timestamp: new Date().toISOString(),
    seq: nextEvenSeq(db),
  });
}

/**
 * Fork resume: upstream flips `status` back to `pending` and stops there. The
 * fork must also drop the recall row an earlier admission may have paired to
 * the occurrence and move it to a fresh inert seq, or the resumed task would
 * wake with stale context.
 */
export function resumeTask(db: Database.Database, taskId: string): number {
  const resume = db.transaction(() => {
    const rows = db
      .prepare("SELECT id FROM messages_in WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status = 'paused'")
      .all(taskId, taskId) as Array<{ id: string }>;
    let touched = 0;
    for (const row of rows) {
      db.prepare("DELETE FROM messages_in WHERE id = ? AND kind = 'system'").run(`recall-${row.id}`);
      touched += db
        .prepare(
          `UPDATE messages_in
              SET seq = ?, status = 'pending', trigger = 0
            WHERE id = ? AND kind = 'task' AND status = 'paused'`,
        )
        .run(nextEvenSeq(db), row.id).changes;
    }
    return touched;
  });
  return resume.immediate();
}

export interface TaskUpdate {
  prompt?: string;
  script?: string | null;
  /** Fleet-hardening Phase 1.1: run --script on the host at fire time instead of in the container. */
  scriptHost?: boolean;
  /** false = never glue this series' channel posts into a rolling day-thread (one-thread-per-item series). */
  threadAnchor?: boolean;
  quietStatus?: boolean;
  recurrence?: string | null;
  processAfter?: string;
  /**
   * Treat `processAfter` as an execution deadline only, leaving the row's
   * `scheduled_for` where it is.
   *
   * The board's run-now fires a task early WITHOUT shifting its schedule
   * (design §4.6), so the occurrence is still FOR its original slot and must
   * keep announcing that slot to the agent. Every other caller is a genuine
   * reschedule — a cron edit, a resume recomputed to the next future slot, an
   * explicit `--process-after` — and moves both.
   */
  keepScheduledFor?: boolean;
  /**
   * Per-fire model/effort pin (merged into content.flagIntent, not replaced).
   * Values are already validated against the agent's provider vocab by the
   * caller (resolveTaskFlagIntent → parseMessageFlags), so effort is a plain
   * string here — the same loose shape the chat-side FlagIntent carries.
   *
   * `null` on an axis CLEARS that axis — the one thing a merge cannot express
   * by value, because every storable pin is a non-empty string and `undefined`
   * already means "leave this axis alone". Writing `''` instead would be a
   * different bug: `parseTaskPin` (task-content.ts:56) reads `''` back as an
   * absent pin, so the series would DISPLAY unpinned while the key survives in
   * the envelope for the next merge to resurrect.
   */
  flagIntent?: { turnModel?: string | null; turnEffort?: string | null };
  chatLimit?: number;
}

/**
 * A host-gated script's output belongs to one fired occurrence, never its
 * successor. Keep source content byte-for-byte when there is no result so
 * legacy/plain envelopes are not needlessly rewritten.
 */
function withoutScriptOutput(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !Object.prototype.hasOwnProperty.call(parsed, 'scriptOutput')
    ) {
      return content;
    }
    delete (parsed as Record<string, unknown>).scriptOutput;
    return JSON.stringify(parsed);
  } catch {
    return content;
  }
}

// Merges content JSON in-place so callers can update prompt/script without
// clobbering other fields. Matches by id OR series_id so the live next
// occurrence of a recurring task is updated, not just the completed row the
// agent last saw. Returns the number of rows touched.
export function updateTask(db: Database.Database, taskId: string, update: TaskUpdate): number {
  migrateMessagesInTable(db);
  const setProcessAfter = update.processAfter !== undefined;
  const setRecurrence = update.recurrence !== undefined;
  const invalidatesScriptOutput = update.script !== undefined || update.scriptHost !== undefined;
  const mergeContent =
    update.prompt !== undefined ||
    update.script !== undefined ||
    update.scriptHost !== undefined ||
    update.threadAnchor !== undefined ||
    update.quietStatus !== undefined ||
    update.flagIntent !== undefined ||
    update.chatLimit !== undefined;

  const updateRows = db.transaction(() => {
    const rows = db
      .prepare(
        "SELECT id, content, recurrence FROM messages_in WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status IN ('pending', 'paused')",
      )
      .all(taskId, taskId) as Array<{ id: string; content: string; recurrence: string | null }>;

    // Schedule fields (recurrence / process_after) belong to the series'
    // recurring chain. A queued `run` row shares the series_id but carries
    // recurrence = NULL; stamping a recurrence onto it would rearm it as a
    // SECOND recurring chain and duplicate the series forever. When the
    // series has a recurring row, schedule edits target only those rows;
    // a pure one-shot (no recurring row anywhere) keeps the old behavior so
    // `--process-after` can still reschedule it. Content edits apply to
    // every live row either way — a queued run should execute the new prompt.
    const hasRecurringRow = rows.some((r) => r.recurrence != null);

    let touched = 0;
    for (const row of rows) {
      const applySchedule = (setProcessAfter || setRecurrence) && (!hasRecurringRow || row.recurrence != null);
      if (!applySchedule && !mergeContent) continue;
      let content = row.content;
      if (mergeContent) {
        const parsed = JSON.parse(row.content) as Record<string, unknown>;
        if (update.prompt !== undefined) parsed.prompt = update.prompt;
        if (update.chatLimit !== undefined) parsed.chatLimit = update.chatLimit;
        if (update.script !== undefined) parsed.script = update.script;
        if (update.scriptHost !== undefined) parsed.scriptHost = update.scriptHost;
        // The result is evidence of one particular script executed in one
        // particular mode. A changed script or host/container mode needs a
        // fresh run; prompt and provider-option edits still describe this same
        // occurrence and retain its already-computed result.
        if (invalidatesScriptOutput) delete parsed.scriptOutput;
        if (update.threadAnchor !== undefined) parsed.threadAnchor = update.threadAnchor;
        if (update.quietStatus !== undefined) parsed.quietStatus = update.quietStatus;
        if (update.flagIntent !== undefined) {
          // Merge, don't replace: a model-only change keeps an existing effort
          // pin (and vice versa). A `null` axis is the exception — it DELETES
          // its key, which is what "clear the pin" has to mean here.
          const merged: Record<string, unknown> = {
            ...((parsed.flagIntent as Record<string, unknown> | undefined) ?? {}),
          };
          for (const [key, value] of Object.entries(update.flagIntent)) {
            if (value === null) delete merged[key];
            else merged[key] = value;
          }
          // Drop the envelope key once both axes are gone, rather than leaving
          // `flagIntent: {}` behind. Readers tolerate either (parseTaskPin
          // answers null for a missing key, task-content.ts:56), but a
          // byte-level diff of the content is how an operator confirms a pin is
          // actually gone, and `{}` reads as "something is still pinned here".
          if (Object.keys(merged).length === 0) delete parsed.flagIntent;
          else parsed.flagIntent = merged;
        }
        content = JSON.stringify(parsed);
      }

      // Any live edit can change what the next provider invocation should
      // execute or when it should execute. Invalidate an already-admitted
      // recall and move the task to a fresh inert seq in the same transaction;
      // the due-admission seam will rebuild current context before waking.
      db.prepare("DELETE FROM messages_in WHERE id = ? AND kind = 'system'").run(`recall-${row.id}`);
      const sets: string[] = ['seq = ?', 'trigger = 0', 'content = ?'];
      const params: unknown[] = [nextEvenSeq(db), content];
      if (setProcessAfter && applySchedule) {
        sets.push('process_after = ?');
        params.push(update.processAfter);
        if (!update.keepScheduledFor) {
          sets.push('scheduled_for = ?');
          params.push(update.processAfter);
        }
      }
      if (setRecurrence && applySchedule) {
        sets.push('recurrence = ?');
        params.push(update.recurrence);
      }
      params.push(row.id);

      touched += db
        .prepare(
          `UPDATE messages_in
              SET ${sets.join(', ')}
            WHERE id = ? AND kind = 'task' AND status IN ('pending', 'paused')`,
        )
        .run(...params).changes;
    }
    return touched;
  });
  return updateRows.immediate();
}

// Only tasks carry a recurrence (non-task writeSessionMessage never sets one),
// so getCompletedRecurring only ever returns task rows. The routing columns
// ride along so recurrence clones keep posting to their channel/thread.
export interface RecurringMessage {
  id: string;
  kind: string;
  content: string;
  recurrence: string;
  process_after: string | null;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  series_id: string;
}

// Includes 'failed' AND 'expired' so a single bad OR missed fire doesn't strand
// the cron series. 'failed' = the fire ran and errored; 'expired' = the fire was
// never claimed (host down / sweep delayed) and expireStalePending reaped the
// overdue pending row. Without 'expired' here, any recurring task that missed
// one fire died permanently — this stranded the daily wiki-synth across all
// memory-enabled agents on 2026-05-10. The historical row stays for audit;
// handleRecurrence inserts the next slot as a fresh pending row (nextRun = next
// cron occurrence after now, so a backlog of missed slots is skipped, not
// replayed). expireStalePending no longer expires recurring rows, so going
// forward 'expired' here mainly heals legacy strandings.
//
// Upstream's `getCompletedRecurring` omits 'expired' and returns four columns;
// the fork's clone needs the routing columns too, so this one is fork-owned.
export function getCompletedRecurring(db: Database.Database): RecurringMessage[] {
  return db
    .prepare("SELECT * FROM messages_in WHERE status IN ('completed', 'failed', 'expired') AND recurrence IS NOT NULL")
    .all() as RecurringMessage[];
}

export function insertRecurrence(
  db: Database.Database,
  msg: RecurringMessage,
  newId: string,
  nextRun: string | null,
  status: 'pending' | 'paused' = 'pending',
): void {
  insertTaskRow(db, {
    id: newId,
    seriesId: msg.series_id,
    processAfter: nextRun,
    recurrence: msg.recurrence,
    content: withoutScriptOutput(msg.content),
    status,
    // Carry routing forward — a channel/thread-scoped series must keep
    // posting to its channel/thread across every re-arm.
    platformId: msg.platform_id,
    channelType: msg.channel_type,
    threadId: msg.thread_id,
  });
}

/**
 * Insert the series' next occurrence and clear the recurrence on the original
 * in ONE durable step.
 *
 * Upstream names this `armNextTask` on `InboundMailbox` and the fork keeps that
 * name, but not upstream's body: upstream arms through `insertTaskRow`, which
 * writes `trigger = 1` and NULL routing. Split writes tear on a crash — an
 * inserted successor next to a still-armed original re-clones the series on the
 * following tick (duplicate runs), while the reverse order silently kills it.
 */
export function armNextTask(
  db: Database.Database,
  originalId: string,
  msg: RecurringMessage,
  newId: string,
  nextRun: string | null,
  status: 'pending' | 'paused' = 'pending',
): void {
  db.transaction(() => {
    insertRecurrence(db, msg, newId, nextRun, status);
    clearRecurrence(db, originalId);
  }).immediate();
}

/**
 * Snapshot of a single live task row, captured before a board move so the
 * source can be re-inserted faithfully on the compensation path. Mirrors the
 * `messages_in` columns the firing path reads (status is `pending` or `paused`
 * — terminal rows are never snapshotted).
 */
export interface TaskRowSnapshot {
  id: string;
  series_id: string;
  status: 'pending' | 'paused';
  process_after: string | null;
  /**
   * Optional: a snapshot recorded in a `move_intent` audit row BEFORE this
   * column existed has no value here, and recovery must still be able to
   * restore from it. Absent means "fall back to process_after", which is what
   * the restored row's readers would do anyway.
   */
  scheduled_for?: string | null;
  recurrence: string | null;
  content: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  kind: string;
}

/** ISO-normalize a slot copied out of a session-DB column. NULL stays NULL. */
function isoSlot(value: string | null | undefined): string | null {
  return value == null ? null : sqliteUtcToIso(value);
}

/**
 * Re-insert a task row from a snapshot, preserving its identity (`series_id`)
 * AND its `status`. Used by the board move flow: compensation (§4.2 step 5,
 * restore source after a failed target insert) and the paused-snapshot staged
 * restore (§4.2 4a).
 *
 * This is `insertRecurrence`'s raw-insert shape with two deliberate differences:
 *   - `series_id` comes from the snapshot, NOT a fresh id. `insertTask` sets
 *     series_id = id, which would sever the series identity — exactly what a
 *     restore must not do.
 *   - `status` comes from the snapshot, overriding insertRecurrence's
 *     hardcoded `'pending'`. A paused source row must come back paused, or the
 *     restore would silently un-pause it.
 *
 * C1: writes no status value the firing path doesn't already read
 * (`pending`/`paused` are both existing live states).
 */
export function restoreTaskRow(db: Database.Database, snapshot: TaskRowSnapshot): void {
  migrateMessagesInTable(db);
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, process_after, scheduled_for, recurrence, platform_id, channel_type, thread_id, content, series_id, trigger)
     VALUES (@id, @seq, @kind, @timestamp, @status, 0, @processAfter, @scheduledFor, @recurrence, @platformId, @channelType, @threadId, @content, @seriesId, 0)`,
  ).run({
    id: snapshot.id,
    seq: nextEvenSeq(db),
    // ISO-8601 UTC, never datetime('now'): its naive 'YYYY-MM-DD HH:MM:SS'
    // shape is read as LOCAL time by `new Date()`, which skews display and
    // breaks string comparisons against the ISO values every other writer here
    // produces.
    timestamp: new Date().toISOString(),
    kind: snapshot.kind,
    status: snapshot.status,
    processAfter: snapshot.process_after,
    // A restore re-creates the SAME occurrence, so it carries the slot the
    // source row was for — not the restore's own moment. `?? process_after`
    // covers a pre-column audit snapshot.
    //
    // Normalized on the way through: both source columns can hold SQLite's
    // naive `YYYY-MM-DD HH:MM:SS` on a pre-upgrade install, and copying that
    // shape into `scheduled_for` would put a value here that every reader
    // compares as a string against ISO ones.
    scheduledFor: isoSlot(snapshot.scheduled_for ?? snapshot.process_after),
    recurrence: snapshot.recurrence,
    platformId: snapshot.platform_id,
    channelType: snapshot.channel_type,
    threadId: snapshot.thread_id,
    content: snapshot.content,
    seriesId: snapshot.series_id,
  });
}

/**
 * Cancel ONE task row, addressed by its exact row id.
 *
 * Upstream's `cancelTask` matches `id = ? OR series_id = ?`, so it cancels
 * whichever row of the series happens to be live when it runs. That is the
 * right verb for "cancel this series" and the wrong one for any caller acting
 * on a row it read EARLIER: between the read and the write, the occurrence it
 * approved can complete and recurrence can arm a successor, and the
 * series-wide cancel then consumes the successor while reporting success.
 *
 * The board move is exactly that caller — it snapshots one occurrence, writes
 * a durable move intent naming that row id, and cancels. Scoped to the id, a
 * changed row means zero touched, which is the move's existing abort-and-409
 * path rather than a silent swap.
 *
 * Same status filter and the same recurrence clear as `cancelTask`, so a row
 * cancelled through either name is in the same state afterwards.
 */
export function cancelTaskRow(db: Database.Database, rowId: string): number {
  return db
    .prepare(
      `UPDATE messages_in SET status = 'cancelled', recurrence = NULL
        WHERE id = ? AND kind = 'task' AND status IN ('pending', 'paused')`,
    )
    .run(rowId).changes;
}

/**
 * Cancel one task occurrence and write its move-cancellation receipt in the
 * same inbound-db transaction.
 *
 * A move intent is written to the central DB before cancellation, but it
 * cannot prove which of two overlapping moves changed the source. This
 * terminal system row is that proof: recovery restores a source only when the
 * exact intent owns this durable receipt. A crash commits both rows or neither.
 */
export function cancelTaskRowWithMoveReceipt(db: Database.Database, rowId: string, receiptId: string): number {
  migrateMessagesInTable(db);
  return db
    .transaction(() => {
      const cancelled = cancelTaskRow(db, rowId);
      if (cancelled === 0) return 0;
      db.prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, content)
         VALUES (?, ?, 'system', ?, 'completed', '{}')`,
      ).run(receiptId, nextEvenSeq(db), new Date().toISOString());
      return cancelled;
    })
    .immediate();
}

/** True only when this exact move's cancellation receipt is durable. */
export function hasMoveCancellationReceipt(db: Database.Database, receiptId: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM messages_in WHERE id = ? AND kind = 'system' AND status = 'completed' LIMIT 1")
    .get(receiptId);
}

/**
 * Board-cancel a series AND make it non-resurrectable. `cancelTask` cancels
 * the live row(s) and clears their recurrence, but crash residue
 * (`recurrence.ts` insert-then-clear) or a swallowed-parse strand can leave a
 * TERMINAL row (`completed`/`failed`/`expired`) still carrying recurrence —
 * which `getCompletedRecurring` would heal into a fresh successor, silently
 * undoing the cancel. This clears recurrence on those terminal rows of the same
 * series too (§4.3 resurrection guard).
 *
 * Returns touched-count = live rows cancelled + terminal recurrence-clears, so
 * the cancel verb is reachable on a PURE strand (no live row, just a terminal
 * recurrence-set row — §4.0 footnote: cancel's touched-count includes terminal
 * clears so strand cleanup never reports a misleading 0).
 *
 * C1: only sets recurrence=NULL on terminal rows — an existing data operation
 * (clearRecurrence), removing rows from the sweep's input without changing any
 * firing-path code or minting a new status value.
 */
export function cancelSeriesWithStrandClear(db: Database.Database, taskId: string): number {
  return db.transaction(() => {
    // 1. Cancel live rows (and clear their recurrence) via existing semantics.
    const liveCancelled = cancelTask(db, taskId);

    // 2. Resolve the affected series so terminal-row cleanup is scoped to them.
    //    taskId may be a row id or a series_id; match the same way cancelTask
    //    does, then collect distinct series_ids.
    const seriesRows = db
      .prepare("SELECT DISTINCT series_id FROM messages_in WHERE (id = ? OR series_id = ?) AND kind = 'task'")
      .all(taskId, taskId) as Array<{ series_id: string | null }>;
    const seriesIds = seriesRows.map((r) => r.series_id).filter((s): s is string => s !== null);

    // 3. Clear recurrence on terminal rows of those series. The just-cancelled
    //    rows already have recurrence NULL (step 1), so `recurrence IS NOT NULL`
    //    naturally excludes them — no double-count.
    let terminalCleared = 0;
    for (const seriesId of seriesIds) {
      terminalCleared += db
        .prepare(
          `UPDATE messages_in SET recurrence = NULL
             WHERE series_id = ? AND kind = 'task'
               AND status IN ('completed', 'failed', 'expired')
               AND recurrence IS NOT NULL`,
        )
        .run(seriesId).changes;
    }

    return liveCancelled + terminalCleared;
  })();
}

/**
 * The ENTIRE prior row, column for column, as `SELECT *` returned it.
 *
 * Deliberately NOT a named subset, and deliberately not `TaskRowSnapshot`. The
 * first version of this was a column list, and it omitted `tries` and
 * `trigger`: `restoreTaskRow` hardcodes both to 0, which is right for its
 * board-move caller (a row arriving in a new session) and wrong for an undo,
 * so a restored row came back with its retry count zeroed. A named list is also
 * a list that goes stale the next time a column is added to `messages_in`, and
 * nothing fails loudly when it does.
 *
 * So the shape is open on purpose: whatever columns the table has, the snapshot
 * has, and `restoreTaskSeries` writes all of them back. `id` and `series_id`
 * are named only because the restore reasons about them explicitly.
 */
export interface TaskSeriesSnapshot {
  id: string;
  series_id: string;
  [column: string]: unknown;
}

/**
 * What one `upsertTaskSeries` did, in the terms a compensation needs.
 *
 * `touchedId` is the row it inserted or updated — the ONLY row it may undo.
 * `prior` is that row as it stood before, or `null` when the upsert created it.
 */
export interface UpsertedTaskSeries {
  touchedId: string;
  prior: TaskSeriesSnapshot | null;
  /**
   * The `recall-<id>` context row as it stood beside `prior`, or `null`.
   *
   * Captured because the upsert DELETES it, and whether that deletion should be
   * undone depends on the task row's own `trigger` — see `restoreTaskSeries`.
   */
  priorRecall: TaskSeriesSnapshot | null;
}

/** A caller opted out of scheduleTask's normal active-series upsert. */
export interface TaskSeriesCollision {
  collision: true;
}

/**
 * Put back the ONE row an `upsertTaskSeries` inserted or updated.
 *
 * `scheduleTask` writes to TWO databases with no transaction spanning them: the
 * task row in the session's `inbound.db`, and `sessions.task_routing_platform_id`
 * in the central DB, which is what the Observatory renders the series' channel
 * from. Statement order cannot make that atomic in either direction — it only
 * chooses which side is left ahead when the other fails. So the second write
 * failing is compensated rather than ordered around.
 *
 * Addressed by ROW ID, never by `series_id`. A series can hold more than one
 * live row: `ncl tasks run` inserts a `<series>-run` occurrence alongside the
 * scheduled one, deliberately, so an on-demand fire reports to the same
 * destination (`src/cli/resources/tasks.ts`). A compensation that cleared every
 * live row of the series would cancel that sibling occurrence outright, and
 * `prior` could only put one of them back — turning a failed re-schedule into
 * silent data loss on a row it never touched.
 *
 * `touchedId` and `prior` therefore both come from `upsertTaskSeries`' OWN
 * selection rather than a second query. Two lookups over an unordered
 * `SELECT … LIMIT 1` could disagree about which live row is "the" one, and
 * disagreeing here means restoring a row that was never overwritten.
 *
 * `prior === null` means the upsert INSERTED, and removing that insert is the
 * restore.
 *
 * Two fields do not come back byte-identical, both deliberately:
 *   - `seq` is freshly allocated, because the row is re-inserted. A successful
 *     re-schedule re-seqs too, so this is a state the series reaches normally.
 *
 * The RECALL PARTNER comes back only when the task row it belongs to was
 * ADMITTED (`trigger = 1`), and that condition is the whole subtlety. An inert
 * task (`trigger = 0`) has its context rebuilt by the due-admission sweep, so
 * leaving the recall deleted is exactly where a normal re-schedule leaves it.
 * An ADMITTED task is different: the sweep rebuilds recall only for
 * `trigger = 0` rows, so it will never rebuild this one — and a restored
 * `trigger = 1` task with no recall partner is claimable by a container without
 * the context row the pair exists to guarantee. The first version of this undo
 * restored `trigger` faithfully and dropped the partner, which produced exactly
 * that.
 *
 * EVERY OTHER COLUMN comes back exactly, including ones nobody thought to name
 * — `tries`, `trigger`, `timestamp` — because the restore is built from the
 * snapshot's own keys rather than from a list written here.
 */
export function restoreTaskSeries(
  db: Database.Database,
  touchedId: string,
  prior: TaskSeriesSnapshot | null,
  priorRecall: TaskSeriesSnapshot | null = null,
): void {
  const insertWholeRow = (row: TaskSeriesSnapshot): void => {
    const columns = Object.keys(row).filter((column) => column !== 'seq');
    const values: Record<string, unknown> = { seq: nextEvenSeq(db) };
    for (const column of columns) values[column] = row[column];
    db.prepare(
      `INSERT INTO messages_in (seq, ${columns.join(', ')})
       VALUES (@seq, ${columns.map((column) => `@${column}`).join(', ')})`,
    ).run(values);
  };
  db.transaction(() => {
    // The update branch already removed this; the insert branch never had one.
    // Kept so the undo is complete on its own terms rather than by relying on
    // what the upsert happened to do first.
    db.prepare("DELETE FROM messages_in WHERE id = ? AND kind = 'system'").run(`recall-${touchedId}`);
    db.prepare('DELETE FROM messages_in WHERE id = ?').run(touchedId);
    if (!prior) return;
    // EVERY column the snapshot carries, written back by name FROM THE SNAPSHOT
    // ITSELF. Not `restoreTaskRow`: that is the board-move insert, which names
    // its columns and hardcodes `tries` and `trigger` to 0 — correct for a row
    // arriving in a new session, wrong for a row going back to what it was.
    // Building the statement from the row's own keys is what makes a column
    // added to `messages_in` tomorrow restore correctly with no edit here.
    //
    // `seq` is the single exception, and it is reallocated rather than
    // restored: a successful re-schedule allocates a fresh one too, so this is
    // a value the row reaches normally.
    // The recall partner goes back FIRST, so the pair keeps its original order:
    // context below its trigger, on adjacent even seqs, exactly as
    // `insertMessageWithContext` writes it.
    if (priorRecall && prior.trigger === 1) insertWholeRow(priorRecall);
    insertWholeRow(prior);
  })();
}

/**
 * Idempotent series upsert used by `scheduleTask`.
 *
 * Active series (pending/paused) → UPDATE in place; terminal rows
 * (completed/failed/cancelled) are treated as absent so a fresh row is
 * inserted, enabling re-scheduling after cancellation. A due row may already
 * have been admitted as recall + trigger before an operator reschedules it;
 * the stale recall is removed and the task moves to a fresh inert seq in the
 * same transaction, so the next due sweep builds current context before making
 * it wakeable again.
 */
export function upsertTaskSeries(
  db: Database.Database,
  row: {
    id: string;
    seriesId: string;
    processAfter: string;
    /**
     * The slot this occurrence is FOR, when it differs from `processAfter`.
     * Only the board's move flow passes it: a source row in retry backoff
     * carries the backoff deadline in `process_after`, and stamping the
     * destination's slot from that would change the occurrence's identity as a
     * side effect of moving it. Everyone else arms a slot and a run time that
     * are the same instant.
     */
    scheduledFor?: string | null;
    recurrence: string;
    content: string;
    /** Insert a paused task atomically (used only by a paused move). */
    status?: 'pending' | 'paused';
    /** Refuse, rather than overwrite, the exact live row this upsert selected. */
    rejectExistingLiveSeries?: boolean;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
  },
): UpsertedTaskSeries | TaskSeriesCollision {
  migrateMessagesInTable(db);
  return db
    .transaction((): UpsertedTaskSeries | TaskSeriesCollision => {
      // The WHOLE row, and selected ONCE. `scheduleTask` has to be able to undo
      // this write when its central-DB companion fails, and the only place that
      // knows WHICH live row was chosen is here. A caller re-running this SELECT
      // could land on a different row when the series has more than one live
      // occurrence (`ncl tasks run` creates exactly that), and would then
      // restore a row this never overwrote.
      //
      // `SELECT *`, not a column list: a named list silently drops whatever it
      // forgets, which is how `tries` and `trigger` were lost from the first
      // version of this snapshot, and it goes stale the next time a column is
      // added to `messages_in`.
      const activeRow = db
        .prepare("SELECT * FROM messages_in WHERE series_id = ? AND status IN ('pending', 'paused')")
        .get(row.seriesId) as TaskSeriesSnapshot | undefined;

      // This predicate deliberately lives beside the SELECT the generic
      // upsert actually uses. `getLiveTaskRow()` has board semantics that can
      // hide a pending manual run behind a terminal recurring strand; using it
      // here would let a move overwrite exactly the row it promised not to.
      if (row.rejectExistingLiveSeries && activeRow) return { collision: true };

      if (activeRow) {
        // Captured BEFORE the delete below, in the same statement sequence that
        // chose the task row, so the pair a compensation puts back is the pair
        // this upsert actually took apart.
        const priorRecall =
          (db.prepare("SELECT * FROM messages_in WHERE id = ? AND kind = 'system'").get(`recall-${activeRow.id}`) as
            | TaskSeriesSnapshot
            | undefined) ?? null;
        db.prepare("DELETE FROM messages_in WHERE id = ? AND kind = 'system'").run(`recall-${activeRow.id}`);
        db.prepare(
          `UPDATE messages_in
            SET seq           = ?,
                process_after = ?,
                scheduled_for = ?,
                recurrence    = ?,
                content       = ?,
                platform_id   = ?,
                channel_type  = ?,
                thread_id     = ?,
                tries         = 0,
                trigger       = 0
          WHERE id = ?`,
        ).run(
          nextEvenSeq(db),
          row.processAfter,
          // The slot moves with the deadline on a re-schedule, unless the caller
          // named one: this IS a reschedule, not a run-now, so absent an
          // explicit slot the occurrence is now FOR the new time.
          isoSlot(row.scheduledFor ?? row.processAfter),
          row.recurrence,
          row.content,
          row.platformId,
          row.channelType,
          row.threadId,
          activeRow.id,
        );
        return { touchedId: activeRow.id, prior: activeRow, priorRecall };
      }

      db.prepare(
        `INSERT INTO messages_in
         (id, seq, kind, timestamp, status, tries, process_after, scheduled_for, recurrence, series_id, content,
          platform_id, channel_type, thread_id, trigger)
       VALUES (?, ?, 'task', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        row.id,
        nextEvenSeq(db),
        new Date().toISOString(),
        row.status ?? 'pending',
        row.processAfter,
        isoSlot(row.scheduledFor ?? row.processAfter),
        row.recurrence,
        row.seriesId,
        row.content,
        row.platformId,
        row.channelType,
        row.threadId,
      );
      return { touchedId: row.id, prior: null, priorRecall: null };
    })
    .immediate();
}

/* ─── Host-gated pre-task scripts ─────────────────────────────────────────── */

export interface HostGatedTaskRow {
  id: string;
  content: string;
}

/**
 * Due task rows that a host-side pre-task script may still gate.
 *
 * Same query shape as `admitDueTaskContexts`' own due-row select (status =
 * 'pending', trigger = 0, process_after due), narrowed to kind = 'task' since
 * only task rows carry a script.
 */
export function listDueTaskRows(db: Database.Database): HostGatedTaskRow[] {
  return db
    .prepare(
      `SELECT id, content FROM messages_in
        WHERE kind = 'task' AND status = 'pending' AND trigger = 0
          AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
    )
    .all() as HostGatedTaskRow[];
}

/** Host-owned equivalent of the container's processing_ack for a gated fire. */
export function resolvePendingTask(db: Database.Database, taskId: string, status: 'completed' | 'failed'): void {
  db.prepare("UPDATE messages_in SET status = ? WHERE id = ? AND status = 'pending'").run(status, taskId);
}

/** Carry a host-run script's output into the row the container will execute. */
export function setPendingTaskContent(db: Database.Database, taskId: string, content: string): void {
  db.prepare("UPDATE messages_in SET content = ? WHERE id = ? AND status = 'pending' AND trigger = 0").run(
    content,
    taskId,
  );
}

/* ─── `ncl tasks` board ────────────────────────────────────────────────────── */

/**
 * One task series as the admin CLI renders it.
 *
 * Wider than the dashboard's {@link ScheduledTaskRow} on purpose: the CLI's
 * table shows `tries` and the aggregated `seq`, and its `row_id`/`series_id`
 * split is what `ncl tasks get <id>` resolves a series by.
 */
export interface CliTaskRow {
  row_id: string;
  series_id: string | null;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  content: string;
  timestamp: string;
  tries: number;
  seq: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
}

/**
 * The live rows of every task series, one per series, next fire first.
 *
 * `GROUP BY series_id` with `MAX(seq)` collapses a series to its newest live
 * occurrence — the CronJob-like view the CLI list shows. Without a status
 * filter it means pending AND paused; a paused series still has a next run.
 */
export function listCliTaskSeries(db: Database.Database, status?: 'pending' | 'paused'): CliTaskRow[] {
  const statusSql = status ? 'status = ?' : "status IN ('pending', 'paused')";
  // One row per series, chosen the same way getCliTaskRow chooses: the row that
  // carries the schedule wins over a transient `ncl tasks run` row, which shares
  // the series_id but has a NULL recurrence. The previous GROUP BY + MAX(seq)
  // relied on SQLite's bare-column rule and therefore returned whichever row was
  // newest — the run row — listing a recurring series as `once` and due now.
  return db
    .prepare(
      `SELECT row_id, series_id, status, process_after, recurrence, content, timestamp, tries,
              platform_id, channel_type, thread_id, seq
         FROM (
           SELECT id AS row_id, series_id, status, process_after, recurrence, content, timestamp, tries,
                  platform_id, channel_type, thread_id, seq,
                  ROW_NUMBER() OVER (
                    PARTITION BY series_id
                    ORDER BY CASE WHEN recurrence IS NOT NULL THEN 0 ELSE 1 END, seq DESC
                  ) AS rn
             FROM messages_in
            WHERE kind = 'task'
              AND ${statusSql}
         )
        WHERE rn = 1
        ORDER BY datetime(process_after) ASC, seq ASC`,
    )
    .all(...(status ? [status] : [])) as CliTaskRow[];
}

/**
 * One task by row id OR series id, live occurrence preferred.
 *
 * The ORDER BY is the whole point: an agent remembers the id it created, which
 * after the first fire names a `completed` row while the series' live next
 * occurrence carries a different row id. Live first, then the row that carries
 * the schedule, then newest.
 *
 * That middle term exists because `ncl tasks run` inserts a SECOND live row for
 * the same series with `recurrence = NULL` (deliberately — see runTaskCommand:
 * a run-now row must not be re-armed into a phantom series). Both rows are
 * `pending`, so they tied on the status term and `seq DESC` handed back the
 * newer run row — making `tasks get`/`tasks list` report a recurring series as
 * `recurrence: null` / schedule `once`. The series was never damaged, but it
 * read exactly like data loss, which invites a destructive "repair".
 *
 * Preferring `recurrence IS NOT NULL` and not `id = series_id` is deliberate:
 * `insertRecurrence` re-arms each occurrence under a NEW row id while carrying
 * the recurrence forward, so after the first fire the live series row's id no
 * longer equals its series_id. One-shots keep their old behaviour — every row
 * has a NULL recurrence, so the tie falls through to `seq DESC` as before.
 */
export function getCliTaskRow(db: Database.Database, id: string): CliTaskRow | undefined {
  return db
    .prepare(
      `SELECT id AS row_id, series_id, status, process_after, recurrence, content, timestamp, tries, seq,
              platform_id, channel_type, thread_id
         FROM messages_in
        WHERE kind = 'task'
          AND (id = ? OR series_id = ?)
        ORDER BY CASE WHEN status IN ('pending', 'paused') THEN 0 ELSE 1 END,
                 CASE WHEN recurrence IS NOT NULL THEN 0 ELSE 1 END,
                 seq DESC
        LIMIT 1`,
    )
    .get(id, id) as CliTaskRow | undefined;
}

/** A task row without its routing columns — what the create paths echo back. */
export type CreatedTaskRow = Omit<CliTaskRow, 'platform_id' | 'channel_type' | 'thread_id'>;

/** The row a freshly created series inserted, as the create paths echo it back. */
export function getCreatedTaskRow(db: Database.Database, id: string): CreatedTaskRow | undefined {
  return db
    .prepare(
      `SELECT id AS row_id, series_id, status, process_after, recurrence, content, timestamp, tries, seq
         FROM messages_in WHERE id = ?`,
    )
    .get(id) as CreatedTaskRow | undefined;
}
