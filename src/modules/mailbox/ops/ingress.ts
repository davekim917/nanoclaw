/**
 * Inbound writes. Every insert goes through `runInsertMessage`, which allocates
 * the host-owned even seq and lets the fence guard triggers decide, inside the
 * same statement, whether the row lands inert.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../../config.js';
import { resolveInboundDbPath } from '../host-inbound.js';
import { recoverHotJournal } from '../openers.js';
import { migrateMessagesInTable, migrateSessionRoutingTable } from '../schema.js';

export {
  getInboundSourceSessionId,
  replaceDestinations,
  type DestinationRow,
} from '../../../mailbox/sqlite/session-db.js';

export interface MessageInsert {
  id: string;
  kind: string;
  timestamp: string;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  content: string;
  processAfter: string | null;
  recurrence: string | null;
  /** 1 = wake the agent (default); 0 = accumulate as context only. */
  trigger?: 0 | 1;
  /** Source session for agent-to-agent return routing. NULL on channel inbound. */
  sourceSessionId?: string | null;
  /** 1 = only deliver on the container's first poll. */
  onWake?: 0 | 1;
}

/** Host-owned inbound.db uses even seqs (the container's side is odd). */
export function nextEvenSeq(db: Database.Database): number {
  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  return maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);
}

export function runInsertMessage(db: Database.Database, message: MessageInsert, ignoreDuplicateId: boolean): boolean {
  migrateMessagesInTable(db);
  const originalTrigger = message.trigger ?? 1;
  const conflictClause = ignoreDuplicateId ? ' ON CONFLICT(id) DO NOTHING' : '';
  // Never read the fence first: that races release on another connection and
  // could tag a row with an already-released epoch, stranding it forever. The
  // AFTER INSERT guard decides atomically in the same statement.
  const result = db
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after, scheduled_for, recurrence, series_id, trigger, source_session_id, on_wake, repo_fence_epoch, repo_fence_original_trigger)
       VALUES (@id, @seq, @kind, @timestamp, 'pending', @platformId, @channelType, @threadId, @content, @processAfter,
               -- Occurrence identity is a TASK concept. A chat or system row's
               -- process_after is a plain "hold until", so it gets no slot.
               -- Tasks normally arrive via insertTaskRow; this covers the case
               -- writeSessionMessage's isScheduledTask branch already
               -- anticipates, so a task written through the general writer is
               -- not left slotless.
               CASE WHEN @kind = 'task' THEN @processAfter END,
               @recurrence, @id, @trigger, @sourceSessionId, @onWake, @repoFenceEpoch, @repoFenceOriginalTrigger)${conflictClause}`,
    )
    .run({
      ...message,
      trigger: originalTrigger,
      repoFenceEpoch: null,
      repoFenceOriginalTrigger: null,
      onWake: message.onWake ?? 0,
      sourceSessionId: message.sourceSessionId ?? null,
      seq: nextEvenSeq(db),
    });
  return result.changes > 0;
}

export function insertMessage(db: Database.Database, message: MessageInsert): void {
  runInsertMessage(db, message, false);
}

/** Only an id collision is ignored, never other constraints. */
export function insertMessageIfNew(db: Database.Database, message: MessageInsert): boolean {
  return runInsertMessage(db, message, true);
}

/**
 * The trigger id is the replay key: a duplicate returns false before either
 * insert; a fresh pair commits context then trigger in one transaction, so a
 * crash cannot expose a half-pair.
 */
export function insertMessageWithContextIfNew(
  db: Database.Database,
  trigger: MessageInsert,
  context: MessageInsert | null,
): boolean {
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM messages_in WHERE id = ? LIMIT 1').get(trigger.id) !== undefined) return false;
    if (context) runInsertMessage(db, context, false);
    runInsertMessage(db, trigger, false);
    return true;
  })();
}

/**
 * Inert until due admission rebuilds the recall marker from current host
 * state; the marker shares the trigger's due/on-wake boundary so no container
 * ever sees an unpaired trigger.
 */
export function insertDeferredMessageWithContextIfNew(db: Database.Database, message: MessageInsert): boolean {
  if (message.kind === 'system') throw new Error('deferred context triggers must not be system rows');
  const trigger: MessageInsert = { ...message, trigger: 0 };
  const marker: MessageInsert = {
    id: `recall-${message.id}`,
    kind: 'system',
    timestamp: message.timestamp,
    platformId: message.platformId,
    channelType: message.channelType,
    threadId: message.threadId,
    content: JSON.stringify({ subtype: 'recall_context', deferred: true }),
    processAfter: message.processAfter,
    recurrence: null,
    trigger: 0,
    sourceSessionId: message.sourceSessionId ?? null,
    onWake: message.onWake ?? 0,
  };
  return insertMessageWithContextIfNew(db, trigger, marker);
}

/**
 * Withdraw an unconsumed `on_wake` trigger and its recall partner. The row is
 * visible only on a container's FIRST poll, so if the restart it was written
 * for doesn't happen it later surfaces as a stale notice; it must still be
 * written first, so declining paths compensate here.
 *
 * `pending AND on_wake = 1` does NOT prove unconsumed: a claim lives in
 * outbound `processing_ack` until the next sweep syncs it, and deleting a
 * claimed row destroys the message a container is working on. So withdraw only
 * on proof: no container owns outbound.db (running OR spawning, the caller's
 * half) and no `processing_ack` for this id (this module's half). Fail closed:
 * `claimPossible` answers true when it cannot tell.
 *
 * @param claimPossible called once, immediately before the delete.
 * @returns true when an unconsumed row was withdrawn.
 */
export function withdrawUnconsumedWake(
  db: Database.Database,
  messageId: string,
  claimPossible: () => boolean,
): boolean {
  if (claimPossible()) return false;
  const withdrawn =
    db.prepare("DELETE FROM messages_in WHERE id = ? AND status = 'pending' AND on_wake = 1").run(messageId).changes >
    0;
  if (withdrawn) db.prepare("DELETE FROM messages_in WHERE id = ? AND kind = 'system'").run(`recall-${messageId}`);
  return withdrawn;
}

export function insertMessageWithContext(
  db: Database.Database,
  trigger: MessageInsert,
  context: MessageInsert | null,
): void {
  db.transaction(() => {
    if (context) runInsertMessage(db, context, false);
    runInsertMessage(db, trigger, false);
  })();
}

export function upsertSessionRouting(
  db: Database.Database,
  routing: {
    channel_type: string | null;
    platform_id: string | null;
    thread_id: string | null;
    spawn_task_id?: string | null;
    session_id?: string | null;
  },
): void {
  migrateSessionRoutingTable(db);
  db.prepare(
    `INSERT INTO session_routing (id, channel_type, platform_id, thread_id, spawn_task_id, session_id)
     VALUES (1, @channel_type, @platform_id, @thread_id, @spawn_task_id, @session_id)
     ON CONFLICT(id) DO UPDATE SET
       channel_type  = excluded.channel_type,
       platform_id   = excluded.platform_id,
       thread_id     = excluded.thread_id,
       spawn_task_id = COALESCE(excluded.spawn_task_id, session_routing.spawn_task_id),
       session_id    = COALESCE(excluded.session_id, session_routing.session_id)`,
  ).run({
    ...routing,
    spawn_task_id: routing.spawn_task_id ?? null,
    session_id: routing.session_id ?? null,
  });
}

/**
 * Unlike `upsertSessionRouting`, leaves the chat routing columns alone: the
 * dispatcher knows nothing of the session's destination and would null it.
 */
export function setSessionRoutingSpawnTaskId(db: Database.Database, taskId: string): void {
  migrateSessionRoutingTable(db);
  db.prepare(
    `INSERT INTO session_routing (id, spawn_task_id)
     VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET spawn_task_id = excluded.spawn_task_id`,
  ).run(taskId);
}

export interface SessionRouting {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

/** Null for a session that has never woken. */
export function readSessionRouting(db: Database.Database): SessionRouting | null {
  const row = db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
    | SessionRouting
    | undefined;
  if (!row) return null;
  if (!row.channel_type || !row.platform_id) return null;
  return row;
}

export function inboundHasMessage(db: Database.Database, messageId: string): boolean {
  return db.prepare('SELECT 1 FROM messages_in WHERE id = ? LIMIT 1').get(messageId) !== undefined;
}

/** False if the DB file does not exist (session not yet initialised). */
export function sessionInboundHasMessage(agentGroupId: string, sessionId: string, messageId: string): boolean {
  // Resolved, never reconstructed: the journal recovered below must be the
  // one in `.host/`, which a container cannot have written.
  const dbPath = resolveInboundDbPath(path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId));
  if (!fs.existsSync(dbPath)) return false;
  // Read-only, but a hot journal makes even a read-only SELECT fail, so
  // recover it first (best-effort; opens writable only when a journal exists).
  recoverHotJournal(dbPath);
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 5000');
  try {
    return inboundHasMessage(db, messageId);
  } finally {
    db.close();
  }
}
