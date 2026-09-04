/**
 * Due-admission ops: the host-owned barrier that turns an inert scheduled or
 * deferred row into a wakeable turn.
 *
 * Internal to `src/modules/mailbox/`. The statements used to live in
 * `session-manager.ts` and executed on a handle its callers passed in (the
 * sweep's, the dashboard's run-now); the seam moves them here and leaves the
 * caller a named op on an open session (plan §4.4, Ingress row; invariant
 * I-2). The POLICY — which rows deserve a recall, what that recall says — is
 * deliberately NOT here: it stays with `session-manager.ts`, which composes
 * the recall row and hands it back for the transaction below to commit.
 */
import type Database from 'better-sqlite3';

import { nextEvenSeq, type MessageInsert } from './ingress.js';

/** One inert row the due sweep is considering for admission. */
export interface DueAdmissionRow {
  id: string;
  kind: string;
  timestamp: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  process_after: string | null;
  source_session_id: string | null;
  on_wake: 0 | 1;
}

/**
 * Put a crashed provider turn behind its retry deadline without exposing the
 * old pair to a warm poller.
 *
 * The existing recall row is retained as a no-schema admission marker, but
 * both rows become non-triggering and share the future `process_after`. Due
 * admission replaces that recall from current host state before restoring
 * `trigger = 1`.
 *
 * Rows without a recall keep their current trigger value. In particular, an
 * ordinary `trigger = 0` accumulated chat row cannot become a provider turn
 * merely because generic crash cleanup touched its id.
 */
export function deferForFreshContextRetry(db: Database.Database, messageId: string, backoffSec: number): void {
  const processAfter = new Date(Date.now() + backoffSec * 1000).toISOString();
  db.transaction(() => {
    const recallId = `recall-${messageId}`;
    const hasRecall =
      db.prepare("SELECT 1 FROM messages_in WHERE id = ? AND kind = 'system' LIMIT 1").get(recallId) !== undefined;
    const changed = db
      .prepare(
        `UPDATE messages_in
            SET tries = tries + 1,
                process_after = ?,
                trigger = CASE WHEN ? THEN 0 ELSE trigger END
          WHERE id = ? AND status = 'pending'`,
      )
      .run(processAfter, hasRecall ? 1 : 0, messageId).changes;
    if (changed === 1 && hasRecall) {
      db.prepare("UPDATE messages_in SET process_after = ?, trigger = 0 WHERE id = ? AND kind = 'system'").run(
        processAfter,
        recallId,
      );
    }
  }).immediate();
}

/**
 * Demote legacy live task rows that predate inert scheduling.
 *
 * Those were stored `trigger = 1`. Only UNPAIRED ones are demoted; an
 * already-admitted pair stays wakeable and untouched.
 */
export function demoteUnpairedLegacyTasks(db: Database.Database): void {
  db.prepare(
    `UPDATE messages_in
        SET trigger = 0
      WHERE kind = 'task'
        AND status = 'pending'
        AND trigger = 1
        AND NOT EXISTS (
          SELECT 1
            FROM messages_in AS recall
           WHERE recall.id = 'recall-' || messages_in.id
        )`,
  ).run();
}

/** The due-row predicate, shared by the select and the in-transaction re-check. */
const DUE_PREDICATE = `status = 'pending'
          AND trigger = 0
          AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
          AND (
            kind = 'task'
            OR EXISTS (
              SELECT 1
                FROM messages_in AS recall
               WHERE recall.id = 'recall-' || messages_in.id
                 AND recall.kind = 'system'
                 AND recall.trigger = 0
            )
          )`;

/** Every inert row that is due for admission, in seq order. */
export function listDueAdmissionRows(db: Database.Database): DueAdmissionRow[] {
  return db
    .prepare(
      `SELECT id, kind, timestamp, platform_id, channel_type, thread_id, content, process_after,
              source_session_id, on_wake
         FROM messages_in
        WHERE ${DUE_PREDICATE}
        ORDER BY seq`,
    )
    .all() as DueAdmissionRow[];
}

/**
 * Commit one admission: append the caller's freshly built recall row and move
 * the existing turn immediately after it, flipping `trigger = 1`.
 *
 * Returns false when the row stopped being due between the select and this
 * transaction — a concurrent sweep or a cancel got there first, which is a
 * no-op, not a fault. Identity, status, tries, series, recurrence, content and
 * routing all stay on the original row; `on_wake` is cleared on BOTH halves so
 * a container that was concurrently started by real inbound can still consume
 * the now-safe pair on a later poll.
 */
export function admitDueRow(db: Database.Database, recall: MessageInsert, taskId: string): boolean {
  return db.transaction(() => {
    const stillDue = db.prepare(`SELECT 1 FROM messages_in WHERE id = ? AND ${DUE_PREDICATE}`).get(taskId);
    if (!stillDue) return false;
    db.prepare("DELETE FROM messages_in WHERE id = ? AND kind = 'system'").run(recall.id);

    const recallSeq = nextEvenSeq(db);
    db.prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content,
          process_after, recurrence, series_id, trigger, source_session_id, on_wake)
       VALUES
         (@id, @seq, @kind, @timestamp, 'pending', @platformId, @channelType, @threadId, @content,
          @processAfter, NULL, @id, 0, @sourceSessionId, @onWake)`,
    ).run({ ...recall, seq: recallSeq });
    const changed = db
      .prepare(
        `UPDATE messages_in
            SET seq = ?, trigger = 1, on_wake = 0
          WHERE id = ? AND status = 'pending' AND trigger = 0`,
      )
      .run(recallSeq + 2, taskId).changes;
    if (changed !== 1) throw new Error(`due turn ${taskId} changed during context admission`);
    return true;
  })();
}

/**
 * Has a task row been admitted — a `trigger = 1` pending task sitting exactly
 * two seqs after its own inert recall row?
 *
 * The run-now gate asks this to prove its admission landed before it reports a
 * fire; anything less would turn a failed request into a silent later run.
 */
export function taskPairIsAdmitted(db: Database.Database, taskId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1
           FROM messages_in AS task
           JOIN messages_in AS recall
             ON recall.id = 'recall-' || task.id
            AND recall.seq = task.seq - 2
            AND recall.kind = 'system'
            AND recall.trigger = 0
          WHERE task.id = ?
            AND task.kind = 'task'
            AND task.status = 'pending'
            AND task.trigger = 1`,
      )
      .get(taskId) !== undefined
  );
}

/**
 * Put an inert task row back on its previous schedule.
 *
 * The run-now gate's undo: the row stayed inert, so restoring `process_after`
 * leaves only the pre-existing fire rather than converting a failed run-now
 * into an early one.
 */
export function restoreInertTaskSchedule(db: Database.Database, taskId: string, processAfter: string | null): void {
  db.prepare(
    `UPDATE messages_in
        SET process_after = ?
      WHERE id = ? AND kind = 'task' AND status = 'pending' AND trigger = 0`,
  ).run(processAfter, taskId);
}

/* ─── Startup pre-turn-context upgrade ─────────────────────────────────────── */

/** An already-triggering row that predates the pre-turn context contract. */
export interface PendingUpgradeRow extends DueAdmissionRow {
  status: 'pending' | 'processing';
}

/** The predicate for a live turn that never got a recall pair. */
const UNPAIRED_PREDICATE = `status IN ('pending', 'processing')
          AND trigger = 1
          AND kind NOT IN ('system', 'task')
          AND NOT EXISTS (
            SELECT 1
              FROM messages_in AS recall
             WHERE recall.id = 'recall-' || messages_in.id
          )`;

/**
 * Live turns written before the pre-turn context contract was activated.
 *
 * Scheduled tasks are excluded on purpose: their due-time seam admits context
 * immediately before execution, so pairing them here would build a context
 * that is stale by the time they fire.
 */
export function listUnpairedPendingUpgradeRows(db: Database.Database): PendingUpgradeRow[] {
  return db
    .prepare(
      `SELECT id, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after,
              source_session_id, on_wake
         FROM messages_in
        WHERE ${UNPAIRED_PREDICATE}
        ORDER BY seq`,
    )
    .all() as PendingUpgradeRow[];
}

/**
 * Commit one startup upgrade: append the recall row and move the turn after
 * it, returning a `processing` row to `pending`.
 *
 * Containers are absent when this runs (the migration and startup gates prove
 * that first), so a row left in `processing` can safely go back to pending.
 * Returns false when the row was paired or ended between the select and here.
 */
export function admitPendingUpgradeRow(db: Database.Database, recall: MessageInsert, messageId: string): boolean {
  return db.transaction(() => {
    const stillUnpaired = db.prepare(`SELECT 1 FROM messages_in WHERE id = ? AND ${UNPAIRED_PREDICATE}`).get(messageId);
    if (!stillUnpaired) return false;

    const recallSeq = nextEvenSeq(db);
    db.prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content,
          process_after, recurrence, series_id, trigger, source_session_id, on_wake)
       VALUES
         (@id, @seq, @kind, @timestamp, 'pending', @platformId, @channelType, @threadId, @content,
          @processAfter, NULL, @id, 0, @sourceSessionId, @onWake)`,
    ).run({ ...recall, seq: recallSeq });
    const changed = db
      .prepare(
        `UPDATE messages_in
            SET seq = ?, status = 'pending'
          WHERE id = ?
            AND status IN ('pending', 'processing')
            AND trigger = 1`,
      )
      .run(recallSeq + 2, messageId).changes;
    if (changed !== 1) throw new Error(`pending upgrade turn ${messageId} changed during context admission`);
    return true;
  })();
}
