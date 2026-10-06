/**
 * Due-admission ops: the host-owned barrier that turns an inert scheduled or
 * deferred row into a wakeable turn. The recall POLICY stays in
 * session-manager.ts; these only commit its decision.
 */
import type Database from 'better-sqlite3';

import { nextEvenSeq, type MessageInsert } from './ingress.js';
import { DUE_NOW } from './sweep.js';

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
 * Defers a crashed turn without exposing the old pair to a warm poller: both
 * rows go non-triggering with the future `process_after`, and admission later
 * rebuilds the recall before restoring `trigger = 1`. Rows without a recall
 * keep their trigger, so a `trigger = 0` chat row never becomes a turn here.
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

/** Only UNPAIRED legacy `trigger = 1` task rows are demoted; an admitted pair stays wakeable. */
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

/** A `trigger = 0` row admission turns into a turn once it is due; any other one stays context for good. */
export const ADMISSIBLE = `trigger = 0
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

/** Shared by the select and the in-transaction re-check. */
const DUE_PREDICATE = `status = 'pending'
          AND ${DUE_NOW}
          AND ${ADMISSIBLE}`;

/**
 * Matches a deferred wait (trigger=0) or an admitted due turn (trigger=1). A
 * recall marker alone does not: its trigger has already ended.
 */
export function hasPendingRecallPairedTrigger(db: Database.Database): boolean {
  return (
    db
      .prepare(
        `SELECT 1
           FROM messages_in AS pending_turn
          WHERE pending_turn.status = 'pending'
            AND pending_turn.kind != 'system'
            AND EXISTS (
              SELECT 1
                FROM messages_in AS recall
               WHERE recall.id = 'recall-' || pending_turn.id
                 AND recall.kind = 'system'
                 AND recall.status = 'pending'
            )
          LIMIT 1`,
      )
      .get() !== undefined
  );
}

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
 * Appends the caller's recall row and moves the turn right after it with
 * `trigger = 1`. False when the row stopped being due meanwhile (a no-op, not
 * a fault). `on_wake` is cleared on BOTH halves so a container started
 * concurrently by real inbound can still consume the pair on a later poll.
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
 * Its text ("the host stopped your container mid-work") is false for an adopted container.
 */
const HOST_RESTART_NOTE_KIND = 'agent_host_restart';

interface SurvivorWakeRow {
  id: string;
  system_kind: string | null;
}

/**
 * `on_wake = 1` rows are selectable only on a container's FIRST poll, so an
 * adopted survivor can never reach them. `agent_host_restart` notes are
 * WITHDRAWN with their recall (delivering one would make the agent discard live
 * state); the rest are CONVERTED and re-seqed to the front, because selection
 * is `ORDER BY seq DESC LIMIT n` and an old seq may never surface. The pair
 * keeps its `recall.seq = task.seq - 2` spacing.
 *
 * `claimed` is invoked immediately before each row is touched; an unprovable
 * case must answer `true`, leaving the row as it is.
 */
export function reconcileSurvivorWakeRows(
  db: Database.Database,
  claimed: (messageId: string) => boolean,
): { converted: number; withdrawn: number } {
  // `kind != 'system'`: recall markers move with their trigger. `json_extract`
  // because content need not be JSON.
  const rows = db
    .prepare(
      `SELECT id,
              CASE WHEN json_valid(content) THEN json_extract(content, '$._system.kind') END AS system_kind
         FROM messages_in
        WHERE status = 'pending'
          AND on_wake = 1
          AND kind != 'system'
        ORDER BY seq`,
    )
    .all() as SurvivorWakeRow[];

  let converted = 0;
  let withdrawn = 0;
  for (const row of rows) {
    if (claimed(row.id)) continue;
    if (row.system_kind === HOST_RESTART_NOTE_KIND) {
      if (withdrawWakePair(db, row.id)) withdrawn += 1;
      continue;
    }
    if (convertWakePair(db, row.id)) converted += 1;
  }
  return { converted, withdrawn };
}

function withdrawWakePair(db: Database.Database, messageId: string): boolean {
  return db.transaction(() => {
    const gone =
      db.prepare("DELETE FROM messages_in WHERE id = ? AND status = 'pending' AND on_wake = 1").run(messageId).changes >
      0;
    if (gone) db.prepare("DELETE FROM messages_in WHERE id = ? AND kind = 'system'").run(`recall-${messageId}`);
    return gone;
  })();
}

/**
 * Both target seqs are above the current max, so no `seq` collision; a lone
 * trigger takes the recall slot itself.
 */
function convertWakePair(db: Database.Database, messageId: string): boolean {
  return db.transaction(() => {
    const recallId = `recall-${messageId}`;
    const hasRecall =
      db.prepare("SELECT 1 FROM messages_in WHERE id = ? AND kind = 'system' LIMIT 1").get(recallId) !== undefined;
    const recallSeq = nextEvenSeq(db);
    const moved =
      db
        .prepare("UPDATE messages_in SET seq = ?, on_wake = 0 WHERE id = ? AND status = 'pending' AND on_wake = 1")
        .run(hasRecall ? recallSeq + 2 : recallSeq, messageId).changes > 0;
    if (moved && hasRecall) {
      db.prepare("UPDATE messages_in SET seq = ?, on_wake = 0 WHERE id = ? AND kind = 'system'").run(
        recallSeq,
        recallId,
      );
    }
    return moved;
  })();
}

/**
 * Proves a run-now admission landed before a fire is reported; anything less
 * turns a failed request into a silent later run.
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

/** Run-now's undo: the row stayed inert, so no early fire results. */
export function restoreInertTaskSchedule(db: Database.Database, taskId: string, processAfter: string | null): void {
  db.prepare(
    `UPDATE messages_in
        SET process_after = ?
      WHERE id = ? AND kind = 'task' AND status = 'pending' AND trigger = 0`,
  ).run(processAfter, taskId);
}

export interface PendingUpgradeRow extends DueAdmissionRow {
  status: 'pending' | 'processing';
}

const UNPAIRED_PREDICATE = `status IN ('pending', 'processing')
          AND trigger = 1
          AND kind NOT IN ('system', 'task')
          AND NOT EXISTS (
            SELECT 1
              FROM messages_in AS recall
             WHERE recall.id = 'recall-' || messages_in.id
          )`;

/**
 * Scheduled tasks are excluded: they are admitted immediately before
 * execution, so pairing them now would build stale context.
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
 * Runs with no containers present (proved by the startup gates), so a
 * `processing` row can go back to pending. False when the row was paired or
 * ended meanwhile.
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
