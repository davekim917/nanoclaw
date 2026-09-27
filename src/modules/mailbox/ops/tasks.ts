/**
 * Task rows: `messages_in` rows with `kind='task'`. Statements identical to
 * upstream's `src/mailbox/sqlite/tasks.ts` are re-exported from there, not
 * copied; the rest are fork-only because fork task rows carry routing, land
 * inert (`trigger = 0`), and invalidate an admitted recall on every live edit.
 */
import type Database from 'better-sqlite3';

import { cancelTask, clearRecurrence } from '../../../mailbox/sqlite/tasks.js';
import { migrateMessagesInTable } from '../schema.js';
import { sqliteUtcToIso } from '../sqlite-utc.js';
import { nextEvenSeq } from './ingress.js';

/**
 * Insert one pending task occurrence. `seriesId` equals `id` for a new series.
 *
 * Not upstream's `insertTaskRow`, which hardcodes `trigger: true` and NULL
 * routing: a fork task row must land inert (`trigger = 0`) so no poller claims
 * it before the due-admission seam builds its recall context, and channel- or
 * thread-scoped tasks carry routing that must survive every re-arm.
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
  /** Run --script on the host at fire time instead of in the container. */
  scriptHost?: boolean;
  /** false = never glue this series' channel posts into a rolling day-thread (one-thread-per-item series). */
  threadAnchor?: boolean;
  quietStatus?: boolean;
  /** true = fires resume one conversation instead of starting fresh. */
  continuous?: boolean;
  recurrence?: string | null;
  processAfter?: string;
  /**
   * Treat `processAfter` as an execution deadline only, leaving `scheduled_for`.
   * Run-now fires early without shifting the schedule, so the occurrence must
   * keep announcing its original slot; every other caller moves both.
   */
  keepScheduledFor?: boolean;
  /**
   * Per-fire model/effort pin, merged into content.flagIntent; values are
   * already validated by the caller. `null` on an axis CLEARS it. Never write
   * `''`: `parseTaskPin` reads it as absent while the key survives the next merge.
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
    update.continuous !== undefined ||
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
        if (update.continuous !== undefined) parsed.continuous = update.continuous;
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
          // Drop the key once both axes are gone: in a byte-level diff of the
          // content, `flagIntent: {}` reads as "something is still pinned here".
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

// Includes 'failed' AND 'expired' so one bad or missed fire doesn't strand the
// cron series. The next slot is the next cron occurrence after now, so a backlog
// of missed slots is skipped, not replayed. Upstream's version omits 'expired'
// and the routing columns, so this one is fork-owned.
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
    platformId: msg.platform_id,
    channelType: msg.channel_type,
    threadId: msg.thread_id,
  });
}

/**
 * Insert the series' next occurrence and clear the recurrence on the original
 * in ONE transaction. Split writes tear on a crash: a successor beside a
 * still-armed original re-clones the series (duplicate runs), while the reverse
 * order kills it. Unlike upstream's `armNextTask`, this writes an inert, routed row.
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

/** A live (pending/paused) task row captured before a board move, for re-insert on compensation. */
export interface TaskRowSnapshot {
  id: string;
  series_id: string;
  status: 'pending' | 'paused';
  process_after: string | null;
  /** Absent in snapshots recorded before this column existed; falls back to process_after. */
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
 * Re-insert a task row from a board-move snapshot, preserving its `series_id`
 * (a fresh id would sever the series) and its `status` (a paused source must
 * come back paused).
 */
export function restoreTaskRow(db: Database.Database, snapshot: TaskRowSnapshot): void {
  migrateMessagesInTable(db);
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, process_after, scheduled_for, recurrence, platform_id, channel_type, thread_id, content, series_id, trigger)
     VALUES (@id, @seq, @kind, @timestamp, @status, 0, @processAfter, @scheduledFor, @recurrence, @platformId, @channelType, @threadId, @content, @seriesId, 0)`,
  ).run({
    id: snapshot.id,
    seq: nextEvenSeq(db),
    timestamp: new Date().toISOString(),
    kind: snapshot.kind,
    status: snapshot.status,
    processAfter: snapshot.process_after,
    // The SAME occurrence, so it keeps the source's slot (`?? process_after`
    // covers a pre-column snapshot). Normalized because a pre-upgrade install can
    // hold SQLite's naive datetime shape, which breaks ISO string comparisons.
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
 * Cancel ONE task row by exact row id. Upstream's `cancelTask` matches the whole
 * series, so a caller acting on a row it read earlier could cancel a successor
 * armed in between and report success; here a changed row means zero touched.
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
 * Cancel one task occurrence and write its move-cancellation receipt in one
 * transaction. Recovery restores a source only when the exact move intent owns
 * this receipt, which is what tells two overlapping moves apart.
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
 * Board-cancel a series AND make it non-resurrectable: also clears recurrence on
 * TERMINAL rows of the series (crash residue), which `getCompletedRecurring`
 * would otherwise heal into a fresh successor. The count includes those terminal
 * clears, so cancelling a pure strand never reports 0.
 */
export function cancelSeriesWithStrandClear(db: Database.Database, taskId: string): number {
  return db.transaction(() => {
    const liveCancelled = cancelTask(db, taskId);

    // taskId may be a row id or a series_id; match the way cancelTask does.
    const seriesRows = db
      .prepare("SELECT DISTINCT series_id FROM messages_in WHERE (id = ? OR series_id = ?) AND kind = 'task'")
      .all(taskId, taskId) as Array<{ series_id: string | null }>;
    const seriesIds = seriesRows.map((r) => r.series_id).filter((s): s is string => s !== null);

    // Rows cancelled above already have recurrence NULL, so no double-count.
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
 * The ENTIRE prior row as `SELECT *` returned it, deliberately not a named
 * column list: a named list goes stale when `messages_in` gains a column.
 */
export interface TaskSeriesSnapshot {
  id: string;
  series_id: string;
  [column: string]: unknown;
}

/** `touchedId` is the only row the upsert may undo; `prior` is null when the upsert created it. */
export interface UpsertedTaskSeries {
  touchedId: string;
  prior: TaskSeriesSnapshot | null;
  /** The `recall-<id>` row beside `prior`, which the upsert deletes; see `restoreTaskSeries` for when it comes back. */
  priorRecall: TaskSeriesSnapshot | null;
}

/** A caller opted out of scheduleTask's normal active-series upsert. */
export interface TaskSeriesCollision {
  collision: true;
}

/**
 * Put back the ONE row an `upsertTaskSeries` inserted or updated, when
 * `scheduleTask`'s central-DB write fails (no transaction spans the two DBs).
 *
 * Addressed by ROW ID, never `series_id`: `ncl tasks run` puts a second live row
 * in the series, and a series-wide undo would cancel it. `touchedId`/`prior` come
 * from the upsert's own selection, since a second `LIMIT 1` query could pick a
 * different row. `prior === null` means removing the insert is the restore.
 *
 * Every column comes back exactly except `seq`, which is reallocated as a
 * re-schedule does. The recall partner comes back only when the task was
 * ADMITTED (`trigger = 1`): the due-admission sweep rebuilds recall only for
 * `trigger = 0` rows, so an admitted task without its partner would be
 * claimable without its context.
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
    // The update branch already removed this; kept so the undo stands on its own.
    db.prepare("DELETE FROM messages_in WHERE id = ? AND kind = 'system'").run(`recall-${touchedId}`);
    db.prepare('DELETE FROM messages_in WHERE id = ?').run(touchedId);
    if (!prior) return;
    // Written back from the snapshot's own keys, not via `restoreTaskRow` (which
    // hardcodes `tries`/`trigger` to 0). The recall partner goes first so the
    // pair keeps its order: context below its trigger, on adjacent seqs.
    if (priorRecall && prior.trigger === 1) insertWholeRow(priorRecall);
    insertWholeRow(prior);
  })();
}

/**
 * Idempotent series upsert used by `scheduleTask`. Active series (pending/paused)
 * update in place; terminal rows count as absent so a cancelled series can be
 * re-scheduled. An already-admitted recall is removed and the task moved to a
 * fresh inert seq, so the next due sweep rebuilds current context.
 */
export function upsertTaskSeries(
  db: Database.Database,
  row: {
    id: string;
    seriesId: string;
    processAfter: string;
    /**
     * The slot this occurrence is FOR, when it differs from `processAfter`. Only
     * a board move passes it: a source in retry backoff carries the backoff
     * deadline in `process_after`, which must not become the slot.
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
      // The WHOLE row, selected ONCE: only this selection knows which live row a
      // compensation must restore (see `restoreTaskSeries`).
      const activeRow = db
        .prepare("SELECT * FROM messages_in WHERE series_id = ? AND status IN ('pending', 'paused')")
        .get(row.seriesId) as TaskSeriesSnapshot | undefined;

      // This predicate deliberately lives beside the SELECT the generic
      // upsert actually uses. `getLiveTaskRow()` has board semantics that can
      // hide a pending manual run behind a terminal recurring strand; using it
      // here would let a move overwrite exactly the row it promised not to.
      if (row.rejectExistingLiveSeries && activeRow) return { collision: true };

      if (activeRow) {
        // Captured before the delete below, so a compensation restores the pair this upsert took apart.
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

export interface HostGatedTaskRow {
  id: string;
  series_id: string | null;
  content: string;
}

/** Due, unadmitted task rows a host-side pre-task script may still gate (same due predicate as `admitDueTaskContexts`). */
export function listDueTaskRows(db: Database.Database): HostGatedTaskRow[] {
  return db
    .prepare(
      `SELECT id, series_id, content FROM messages_in
        WHERE kind = 'task' AND status = 'pending' AND trigger = 0
          AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
    )
    .all() as HostGatedTaskRow[];
}

/**
 * Host-owned equivalent of the container's processing_ack for a gated fire.
 * Only an unadmitted row: once admitted, the container runs it and records it.
 */
export function resolvePendingTask(db: Database.Database, taskId: string, status: 'completed' | 'failed'): void {
  db.prepare("UPDATE messages_in SET status = ? WHERE id = ? AND status = 'pending' AND trigger = 0").run(
    status,
    taskId,
  );
}

/** Carry a host-run script's output into the row the container will execute. */
export function setPendingTaskContent(db: Database.Database, taskId: string, content: string): void {
  db.prepare("UPDATE messages_in SET content = ? WHERE id = ? AND status = 'pending' AND trigger = 0").run(
    content,
    taskId,
  );
}

/** One task series as the admin CLI renders it; `row_id`/`series_id` split is what `ncl tasks get` resolves by. */
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

/** The live rows of every task series, one per series, next fire first. No status filter means pending AND paused. */
export function listCliTaskSeries(db: Database.Database, status?: 'pending' | 'paused'): CliTaskRow[] {
  const statusSql = status ? 'status = ?' : "status IN ('pending', 'paused')";
  // One row per series, chosen as getCliTaskRow chooses: the schedule-carrying
  // row wins over a transient `ncl tasks run` row (same series_id, NULL recurrence).
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
 * One task by row id OR series id. Order: live first, then the row carrying the
 * schedule, then newest. An agent remembers the id it created, which after the
 * first fire names a completed row. The middle term keeps a `ncl tasks run` row
 * (same series, NULL recurrence) from making a recurring series read as `once`;
 * it keys on `recurrence IS NOT NULL`, not `id = series_id`, because re-arms
 * mint new row ids.
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
