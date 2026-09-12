/**
 * Inbound writes: message inserts, session routing, destinations.
 *
 * Internal to `src/modules/mailbox/`. Every insert goes through
 * `runInsertMessage`, which allocates the host-owned even sequence and lets
 * the fence guard triggers decide, inside the same SQLite statement, whether
 * the row lands inert.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../../config.js';
import { resolveInboundDbPath } from '../host-inbound.js';
import { recoverHotJournal } from '../openers.js';
import { migrateMessagesInTable, migrateSessionRoutingTable } from '../schema.js';

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
  /** 1 = only deliver on the container's first poll (fresh start). */
  onWake?: 0 | 1;
}

/**
 * Next even seq number for host-owned inbound.db.
 *
 * Exported so the scheduling module's task helpers can maintain the
 * host-writes-even-seq invariant without duplicating the logic. Not part of
 * the general public API — imported by `src/modules/scheduling/db.ts` only.
 */
export function nextEvenSeq(db: Database.Database): number {
  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  return maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);
}

export function runInsertMessage(db: Database.Database, message: MessageInsert, ignoreDuplicateId: boolean): boolean {
  migrateMessagesInTable(db);
  const originalTrigger = message.trigger ?? 1;
  const conflictClause = ignoreDuplicateId ? ' ON CONFLICT(id) DO NOTHING' : '';
  // Always insert the caller's ordinary trigger shape. The AFTER INSERT guard
  // observes repo_ingress_fence in the same SQLite statement and atomically
  // converts the row to an inert, epoch-tagged row when a fence is active.
  // Reading the fence here first would race release on another connection:
  // a row could be tagged with an epoch only after that epoch's release had
  // already admitted its prior rows, stranding the new row forever.
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

/** Strict insert used by internal host flows; duplicate ids remain programmer errors. */
export function insertMessage(db: Database.Database, message: MessageInsert): void {
  runInsertMessage(db, message, false);
}

/** Channel replay insert; only an id collision is ignored, never other constraints. */
export function insertMessageIfNew(db: Database.Database, message: MessageInsert): boolean {
  return runInsertMessage(db, message, true);
}

/**
 * Idempotent channel-ingress insert for a logical recall/trigger pair.
 *
 * The trigger id is the replay key. A duplicate trigger returns false before
 * either insert, while a fresh trigger commits context first and trigger
 * second in one transaction. `nextEvenSeq` therefore gives the pair adjacent
 * even sequence values and a crash cannot expose a half-pair.
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
 * Persist a host-generated delayed/lifecycle turn inertly until the sweep's
 * due-admission seam replaces its marker with fresh recall context.
 *
 * The marker is intentionally shaped like a recall row and shares the
 * trigger's due/on-wake boundary. This keeps the pair atomic and prevents a
 * warm or fresh container from seeing an unpaired trigger. At due time,
 * `admitDueTaskContexts` rebuilds `recall-<id>` from current host state and
 * flips the trigger to wakeable.
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

/** Strict internal-host variant: duplicate ids retain the existing constraint error contract. */
/**
 * Withdraw an `on_wake` trigger row that no container has consumed, plus its
 * recall partner.
 *
 * This exists because `on_wake` rows are visible ONLY on a container's FIRST
 * poll — `selection.ts` adds `AND on_wake = 0` to every subsequent one. That
 * makes the row a promise with exactly one chance to be kept: written before a
 * restart that then does not happen, it is not merely wasted, it waits for
 * some unrelated future spawn and surfaces there as a stale "restarted to
 * apply X".
 *
 * It cannot be fixed by writing the row later instead. The row must exist
 * BEFORE any fresh container's first poll, or that container's one look at it
 * misses it. So the write stays first and the paths that decline compensate
 * here.
 *
 * `status = 'pending' AND on_wake = 1` narrows the delete, but it does NOT by
 * itself prove the row is unconsumed, and it was documented as if it did. A
 * container claims a message by writing `processing_ack` in `outbound.db`; the
 * inbound row it claimed stays `pending` until a later sweep tick runs
 * `syncProcessingAcks`. So there is a window, one sweep interval wide, in which
 * a claimed wake row still reads `pending` — and deleting it there destroys the
 * message a replacement container is already working on, which is strictly
 * worse than the stale notice this op exists to prevent.
 *
 * Hence `claimPossible`, evaluated HERE rather than by the caller, and the
 * withdrawal proceeds only on a proof that no container could have claimed:
 *
 *   - no container owns `outbound.db` — running OR spawning, since a container
 *     that has not finished spawning is about to poll — which is the caller's
 *     half, because the container registry is host state this module cannot
 *     see; and
 *   - no `processing_ack` row for this message id, in any status, which is this
 *     module's half.
 *
 * Both halves are needed. Ownership alone misses a container that claimed and
 * then exited; the ack alone misses one that is mid-poll, having selected the
 * row but not yet written its claim.
 *
 * Fail closed: `claimPossible` answers true when it cannot tell — an
 * `outbound.db` that is present but unopenable preserves the row. An unwithdrawn
 * wake row costs one stale "restarted to apply X" notice; a wrongly withdrawn
 * one costs the message.
 *
 * The recall partner is removed only when the trigger actually was — a consumed
 * trigger keeps its context. The host is the sole writer of `inbound.db`, so
 * there is no race with the container on the delete itself.
 *
 * @param claimPossible synchronous probe: could any container have claimed this
 *   message, or is that unprovable? Called once, immediately before the delete.
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
 * Record which dispatched task owns this session, leaving the chat routing
 * columns alone.
 *
 * Distinct from {@link upsertSessionRouting}, which REPLACES channel_type,
 * platform_id and thread_id with what the caller passed: the dispatcher knows
 * the task id and nothing about the session's chat destination, so writing
 * through the full upsert would null a routed session's destination.
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

/**
 * Read the session's default reply routing. Used by host-side code that
 * needs to surface a message to the user without going through the agent —
 * e.g. host-sweep's kill-ceiling notice when a container is reaped for
 * inactivity. Returns null on fresh sessions that haven't had a wake yet
 * (no row in session_routing).
 */
export function readSessionRouting(db: Database.Database): SessionRouting | null {
  const row = db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
    | SessionRouting
    | undefined;
  if (!row) return null;
  if (!row.channel_type || !row.platform_id) return null;
  return row;
}

export interface DestinationRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

export function replaceDestinations(db: Database.Database, entries: DestinationRow[]): void {
  const tx = db.transaction((rows: DestinationRow[]) => {
    db.prepare('DELETE FROM destinations').run();
    const stmt = db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (@name, @display_name, @type, @channel_type, @platform_id, @agent_group_id)`,
    );
    for (const row of rows) stmt.run(row);
  });
  tx(entries);
}

/**
 * Look up an inbound row's source_session_id by its message id. Returns null
 * if the row doesn't exist or the column is NULL (channel inbound or
 * pre-migration a2a inbound). Used by a2a routing to route replies back to
 * the originating session.
 */
export function getInboundSourceSessionId(db: Database.Database, messageId: string): string | null {
  const row = db.prepare('SELECT source_session_id FROM messages_in WHERE id = ?').get(messageId) as
    | { source_session_id: string | null }
    | undefined;
  return row?.source_session_id ?? null;
}

/**
 * Find the source_session_id of the most recent a2a inbound row from a
 * specific peer (by agent group id). Used as a peer-affinity fallback in
 * a2a routing when an outbound reply has no `in_reply_to` (e.g. the
 * container's send_message MCP tool path didn't thread the batch's
 * in_reply_to through).
 *
 * Heuristic: "the last time this peer talked to me, which session was it?"
 * Returns null when no prior a2a inbound from that peer carries a
 * non-null source_session_id (typical for pre-migration installs).
 */
export function getMostRecentPeerSourceSessionId(db: Database.Database, peerAgentGroupId: string): string | null {
  const row = db
    .prepare(
      `SELECT source_session_id FROM messages_in
        WHERE channel_type = 'agent'
          AND platform_id = ?
          AND source_session_id IS NOT NULL
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(peerAgentGroupId) as { source_session_id: string | null } | undefined;
  return row?.source_session_id ?? null;
}

/** Does this session's inbound.db already carry `messageId`? */
export function inboundHasMessage(db: Database.Database, messageId: string): boolean {
  return db.prepare('SELECT 1 FROM messages_in WHERE id = ? LIMIT 1').get(messageId) !== undefined;
}

/**
 * Check whether a message id already exists in a session's inbound.db.
 * Used by the steer write path's partial-write recovery (D5) to detect
 * whether a message was already inserted before a mid-write failure.
 *
 * Open-read-close per call — same discipline as all other inbound.db ops.
 * Returns false if the DB file does not exist (session not yet initialised).
 */
export function sessionInboundHasMessage(agentGroupId: string, sessionId: string, messageId: string): boolean {
  // Resolved, never reconstructed: since #749 the host-owned inbound.db lives
  // in `<session>/.host/`, and the journal this function recovers below must be
  // the one in THAT directory — the only one a container cannot have written.
  const dbPath = resolveInboundDbPath(path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId));
  if (!fs.existsSync(dbPath)) return false;
  // Read-only: this only ever runs one SELECT, and a writable open would take
  // a hot-journal rollback write on a session the reclaim may be archiving.
  //
  // But read-only alone is not enough, for the same reason openOutboundDb
  // recovers first: rolling a hot journal back is a WRITE, so a read-only
  // handle fails the plain SELECT with "attempt to write a readonly database"
  // and this function throws instead of answering. The writable open it
  // replaced rolled the journal back silently, so going read-only without this
  // line turns a self-healing read into a permanent throw on any session whose
  // host write was interrupted. Recovery is best-effort and only opens
  // writable when a journal actually exists, so the normal path stays
  // read-only.
  recoverHotJournal(dbPath);
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 5000');
  try {
    return inboundHasMessage(db, messageId);
  } finally {
    db.close();
  }
}
