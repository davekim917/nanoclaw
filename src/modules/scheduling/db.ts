/**
 * Task DB helpers used by the scheduling module.
 *
 * Tasks are `messages_in` rows with `kind='task'`. This module doesn't own
 * its own table — it piggybacks on the core schema. That's why there's no
 * `module-scheduling-*.ts` migration file.
 *
 * cancel/pause/resume match any live row in the series, not just the exact id.
 * Recurring tasks get a new row per occurrence (see handleRecurrence), all
 * sharing series_id. Matching by id alone would only hit the completed row
 * the agent remembers, missing the live next occurrence.
 */
import type Database from 'better-sqlite3';

import { nextEvenSeq } from '../../db/session-db.js';

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
 */
export function insertTaskRow(
  db: Database.Database,
  row: {
    id: string;
    seriesId: string;
    processAfter: string | null;
    recurrence: string | null;
    content: string;
    status?: 'pending' | 'paused';
    platformId?: string | null;
    channelType?: string | null;
    threadId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id, trigger)
     VALUES (@id, @seq, @timestamp, @status, 0, @processAfter, @recurrence, 'task', @platformId, @channelType, @threadId, @content, @seriesId, 0)`,
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

// cancel/pause/resume return the number of rows touched so callers can resolve
// which inbound.db holds the series (thread-scoped tasks live in the calling
// per-thread session's inbound; channel-scoped tasks live in the channel-root
// session's). A caller tries its own session first and falls back to channel
// root only when 0 rows matched.
// Cancel marks the live row 'cancelled' (not 'completed') so a never-fired
// occurrence is distinguishable from a real run and never inflates run history;
// recurrence is cleared so the series isn't re-armed by handleRecurrence.
export function cancelTask(db: Database.Database, taskId: string): number {
  return db
    .prepare(
      "UPDATE messages_in SET status = 'cancelled', recurrence = NULL WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status IN ('pending', 'paused')",
    )
    .run(taskId, taskId).changes;
}

export function cancelAllTasks(db: Database.Database): number {
  return db
    .prepare(
      "UPDATE messages_in SET status = 'cancelled', recurrence = NULL WHERE kind = 'task' AND status IN ('pending', 'paused')",
    )
    .run().changes;
}

export function pauseTask(db: Database.Database, taskId: string): number {
  return db
    .prepare(
      "UPDATE messages_in SET status = 'paused' WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status = 'pending'",
    )
    .run(taskId, taskId).changes;
}

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

export function deleteTask(db: Database.Database, taskId: string): number {
  return db.prepare("DELETE FROM messages_in WHERE (id = ? OR series_id = ?) AND kind = 'task'").run(taskId, taskId)
    .changes;
}

export interface TaskUpdate {
  prompt?: string;
  script?: string | null;
  /** Fleet-hardening Phase 1.1: run --script on the host at fire time instead of in the container. */
  scriptHost?: boolean;
  quietStatus?: boolean;
  recurrence?: string | null;
  processAfter?: string;
  /**
   * Per-fire model/effort pin (merged into content.flagIntent, not replaced).
   * Values are already validated against the agent's provider vocab by the
   * caller (resolveTaskFlagIntent → parseMessageFlags), so effort is a plain
   * string here — the same loose shape the chat-side FlagIntent carries.
   */
  flagIntent?: { turnModel?: string; turnEffort?: string };
  chatLimit?: number;
}

// Merges content JSON in-place so callers can update prompt/script without
// clobbering other fields. Matches by id OR series_id so the live next
// occurrence of a recurring task is updated, not just the completed row the
// agent last saw. Returns the number of rows touched.
export function updateTask(db: Database.Database, taskId: string, update: TaskUpdate): number {
  const setProcessAfter = update.processAfter !== undefined;
  const setRecurrence = update.recurrence !== undefined;
  const mergeContent =
    update.prompt !== undefined ||
    update.script !== undefined ||
    update.scriptHost !== undefined ||
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
        if (update.quietStatus !== undefined) parsed.quietStatus = update.quietStatus;
        if (update.flagIntent !== undefined) {
          // Merge, don't replace: a model-only change keeps an existing effort
          // pin (and vice versa).
          const existing = (parsed.flagIntent as Record<string, unknown> | undefined) ?? {};
          parsed.flagIntent = { ...existing, ...update.flagIntent };
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
export function getCompletedRecurring(db: Database.Database): RecurringMessage[] {
  return db
    .prepare("SELECT * FROM messages_in WHERE status IN ('completed', 'failed', 'expired') AND recurrence IS NOT NULL")
    .all() as RecurringMessage[];
}

/**
 * Trailing consecutive FAILED occurrences of a series, newest backwards until
 * the first completed run. This IS the script-failure streak — derived from
 * the occurrence history, no stored counter to update or reset. Deliberately
 * counts ANY failed occurrence (script-skip:error acks AND stuck-message
 * failures from host-sweep's MAX_TRIES path): a series failing for either
 * reason should throttle, not spin.
 */
export function trailingFailedRuns(db: Database.Database, seriesKey: string): number {
  const rows = db
    .prepare(
      `SELECT status FROM messages_in
        WHERE (series_id = ? OR id = ?) AND kind = 'task' AND status IN ('completed', 'failed')
        ORDER BY seq DESC`,
    )
    .all(seriesKey, seriesKey) as Array<{ status: string }>;
  let streak = 0;
  for (const r of rows) {
    if (r.status !== 'failed') break;
    streak++;
  }
  return streak;
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
    content: msg.content,
    status,
    // Carry routing forward — a channel/thread-scoped series must keep
    // posting to its channel/thread across every re-arm.
    platformId: msg.platform_id,
    channelType: msg.channel_type,
    threadId: msg.thread_id,
  });
}

export function clearRecurrence(db: Database.Database, messageId: string): void {
  db.prepare('UPDATE messages_in SET recurrence = NULL WHERE id = ?').run(messageId);
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
  recurrence: string | null;
  content: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  kind: string;
}

/**
 * Re-insert a task row from a snapshot, preserving its identity (`series_id`)
 * AND its `status`. Used by the board move flow: compensation (§4.2 step 5,
 * restore source after a failed target insert) and the paused-snapshot staged
 * restore (§4.2 4a).
 *
 * This is `insertRecurrence`'s raw-insert shape (db.ts:149-170) with two
 * deliberate differences:
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
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, process_after, recurrence, platform_id, channel_type, thread_id, content, series_id, trigger)
     VALUES (@id, @seq, @kind, datetime('now'), @status, 0, @processAfter, @recurrence, @platformId, @channelType, @threadId, @content, @seriesId, 0)`,
  ).run({
    id: snapshot.id,
    seq: nextEvenSeq(db),
    kind: snapshot.kind,
    status: snapshot.status,
    processAfter: snapshot.process_after,
    recurrence: snapshot.recurrence,
    platformId: snapshot.platform_id,
    channelType: snapshot.channel_type,
    threadId: snapshot.thread_id,
    content: snapshot.content,
    seriesId: snapshot.series_id,
  });
}

/**
 * Board-cancel a series AND make it non-resurrectable. `cancelTask` cancels
 * the live row(s) and clears their recurrence, but crash residue
 * (`recurrence.ts:36-37` insert-then-clear) or a swallowed-parse strand can
 * leave a TERMINAL row (`completed`/`failed`/`expired`) still carrying
 * recurrence — which `getCompletedRecurring` (db.ts:143-146) would heal into a
 * fresh successor, silently undoing the cancel. This clears recurrence on
 * those terminal rows of the same series too (§4.3 resurrection guard).
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
