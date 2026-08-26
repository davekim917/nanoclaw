/**
 * SQL operations on per-session inbound/outbound DBs.
 *
 * These are NOT the central app DB — they're the cross-mount SQLite files
 * shared between host and container. Callers own the connection lifecycle
 * (open-write-close per op). See session-manager.ts header for invariants.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { plantStorageActivityMarker } from '../storage-activity.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';

/** Apply the inbound or outbound schema to a DB file. Idempotent. */
export function ensureSchema(dbPath: string, schema: 'inbound' | 'outbound'): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  if (schema === 'inbound') {
    const existing = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_in'").get();
    if (existing) migrateMessagesInTable(db);
    db.exec(INBOUND_SCHEMA);
    migrateMessagesInTable(db);
  } else {
    db.exec(OUTBOUND_SCHEMA);
    const containerColumns = new Set(
      (db.prepare("PRAGMA table_info('container_state')").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!containerColumns.has('provider_executing')) {
      db.exec('ALTER TABLE container_state ADD COLUMN provider_executing INTEGER NOT NULL DEFAULT 0');
    }
  }
  db.close();
}

/**
 * Open the inbound DB for a session (host reads/writes).
 *
 * This is the single funnel every read-write inbound open passes through, so
 * it is where the storage-activity marker goes. The session reclaim runs in a
 * worker thread and its archive-then-delete is genuinely concurrent with this
 * one; without a marker, a writer that has opened but not yet written is
 * invisible to it and the row lands in an inode the reclaim then unlinks.
 * Guarding the funnel rather than each writer is what keeps the next writer
 * from having to remember.
 *
 * The marker's lifetime is the HANDLE's, not this function's, so the release
 * hangs off close(). A caller that leaks the handle leaks the marker and its
 * session stops being reclaimable — `tryRunWithStorageCleanupClaim` logs every
 * such skip so that is loud rather than silent.
 */
export function openInboundDb(dbPath: string): Database.Database {
  const release = plantStorageActivityMarker(path.dirname(dbPath), 'inbound-open');
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    // A pragma can throw after the handle exists, so close what was created
    // before releasing — otherwise the FD outlives the marker.
    db?.close();
    release();
    throw err;
  }
  // ponytail: patching close() beats a wrapper type — every existing caller
  // already closes, and a new return type would touch all ~20 of them. Known
  // ceiling: better-sqlite3 refuses close() while an iterator is open, which
  // would throw before the marker is released. No non-test caller iterates an
  // inbound handle today; revisit with an explicit release if one appears.
  const close = db.close.bind(db);
  db.close = function releasingClose(this: Database.Database): Database.Database {
    try {
      return close();
    } finally {
      release();
    }
  };
  return db;
}

/**
 * Roll back a hot journal before a READ-ONLY open.
 *
 * When a container is SIGKILLed mid-transaction (exit 137 / OOM kill), SQLite
 * leaves a `<db>-journal` next to outbound.db. Any later connection must roll
 * that journal back BEFORE it can read — and a rollback is a WRITE. The host's
 * outbound handle is read-only by design (the container owns writes), so it
 * can't perform the rollback, and every read fails with "attempt to write a
 * readonly database" — including the plain SELECT at the top of
 * `syncProcessingAcks`.
 *
 * That state is permanent and self-sustaining: the sweep can never mark those
 * messages complete, so it retries the same session every 60s forever. Observed
 * in the wild across 42 sessions and ~4k log errors before this fix.
 *
 * A brief read-write open lets SQLite perform the rollback and delete the
 * journal, restoring a consistent DB; the normal read-only path then works.
 * Safe alongside a running container — both sides use DELETE journal +
 * busy_timeout, the same basis on which `writeOutboundDirect` already writes
 * here. Best-effort: if recovery fails we fall through and let the real open
 * surface the error rather than masking it.
 */
export function recoverHotJournal(dbPath: string): boolean {
  if (!fs.existsSync(`${dbPath}-journal`) || !fs.existsSync(dbPath)) return false;
  try {
    const db = new Database(dbPath);
    db.pragma('busy_timeout = 5000');
    // Touching the DB is what forces the rollback; the read itself is incidental.
    db.prepare('SELECT 1').get();
    db.close();
    return !fs.existsSync(`${dbPath}-journal`);
  } catch {
    return false;
  }
}

/** Open the outbound DB for a session (host reads only). */
export function openOutboundDb(dbPath: string): Database.Database {
  // Cheap existsSync guard — no cost on the normal path, where no journal exists.
  recoverHotJournal(dbPath);
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * Open the outbound DB writable. Normal host path is read-only (the container
 * owns writes); this exists for the narrow pre-wake case where the host emits
 * a deny/flag-confirmation directly to outbound, and for orphan-claim cleanup
 * after a container is killed.
 */
export function openOutboundDbWritable(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  return db;
}

// Alias for the upstream name; both reach the same writable open path.
export const openOutboundDbRw = openOutboundDbWritable;

/**
 * Ensure session_routing has the spawn_task_id and session_id columns the
 * upsert needs. Handles three cases idempotently:
 *   1. Pre-Phase-1 sessions (no extra columns)            → ADD spawn_task_id + session_id
 *   2. Phase-1 sessions (have legacy dispatch_task_id)    → RENAME to spawn_task_id
 *   3. Post-rework sessions (already have spawn_task_id)  → no-op
 *
 * SQLite ALTER TABLE RENAME COLUMN requires 3.25+ (better-sqlite3 ships 3.45+).
 */
export function migrateSessionRoutingTable(db: Database.Database): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(session_routing)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (existing.has('dispatch_task_id') && !existing.has('spawn_task_id')) {
    db.exec('ALTER TABLE session_routing RENAME COLUMN dispatch_task_id TO spawn_task_id');
    existing.delete('dispatch_task_id');
    existing.add('spawn_task_id');
  }
  for (const col of ['spawn_task_id TEXT', 'session_id TEXT']) {
    const colName = col.split(' ')[0]!;
    if (!existing.has(colName)) {
      db.exec(`ALTER TABLE session_routing ADD COLUMN ${col}`);
    }
  }
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

// ---------------------------------------------------------------------------
// messages_in
// ---------------------------------------------------------------------------

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

export interface RepoIngressFence {
  epoch: string;
  generation: string;
  state: 'active' | 'released';
}

export function repoIngressFenceAckToken(fence: Pick<RepoIngressFence, 'epoch' | 'generation'>): string {
  return JSON.stringify([fence.epoch, fence.generation]);
}

export interface RepoIngressAdmissionResult {
  admittedRows: number;
  wakeRequired: boolean;
}

export interface RepoIngressReleaseResult extends RepoIngressAdmissionResult {
  released: boolean;
}

const REPOSITORY_MOUNT_BARRIER_ACK_KEY = 'repository_mount_barrier_ack';

/** Exact-epoch acknowledgement written by the container at a provider-idle poll boundary. */
export function readRepositoryMountBarrierAck(outDb: Database.Database): string | null {
  try {
    const row = outDb.prepare('SELECT value FROM session_state WHERE key = ?').get(REPOSITORY_MOUNT_BARRIER_ACK_KEY) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    // Missing/corrupt outbound state is never an acknowledgement.
    return null;
  }
}

function installRepoIngressFenceGuards(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_in_repo_fence_insert_guard
    BEFORE INSERT ON messages_in
    WHEN
      (NEW.repo_fence_epoch IS NULL AND NEW.repo_fence_original_trigger IS NOT NULL)
      OR (NEW.repo_fence_epoch IS NOT NULL AND NEW.repo_fence_original_trigger IS NULL)
      OR (NEW.repo_fence_epoch IS NOT NULL AND NEW.trigger <> 0)
      OR (NEW.repo_fence_original_trigger IS NOT NULL AND NEW.repo_fence_original_trigger NOT IN (0, 1))
    BEGIN
      SELECT RAISE(ABORT, 'repository-fenced inbound rows must be tagged, inert, and retain their original trigger');
    END;

    CREATE TRIGGER IF NOT EXISTS messages_in_repo_fence_update_guard
    BEFORE UPDATE OF trigger, repo_fence_epoch, repo_fence_original_trigger ON messages_in
    WHEN
      (NEW.repo_fence_epoch IS NULL AND NEW.repo_fence_original_trigger IS NOT NULL)
      OR (NEW.repo_fence_epoch IS NOT NULL AND NEW.repo_fence_original_trigger IS NULL)
      OR (NEW.repo_fence_epoch IS NOT NULL AND NEW.trigger <> 0)
      OR (NEW.repo_fence_original_trigger IS NOT NULL AND NEW.repo_fence_original_trigger NOT IN (0, 1))
    BEGIN
      SELECT RAISE(ABORT, 'repository-fenced inbound rows must be tagged, inert, and retain their original trigger');
    END;

    CREATE TRIGGER IF NOT EXISTS messages_in_repo_fence_auto_tag_insert
    AFTER INSERT ON messages_in
    WHEN NEW.repo_fence_epoch IS NULL
      AND EXISTS (SELECT 1 FROM repo_ingress_fence WHERE id = 1 AND state = 'active')
    BEGIN
      UPDATE messages_in
      SET repo_fence_epoch = (SELECT epoch FROM repo_ingress_fence WHERE id = 1),
          repo_fence_original_trigger = NEW.trigger,
          trigger = 0
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS messages_in_repo_fence_auto_tag_trigger_update
    AFTER UPDATE OF trigger ON messages_in
    WHEN NEW.repo_fence_epoch IS NULL
      AND NEW.trigger = 1
      AND EXISTS (SELECT 1 FROM repo_ingress_fence WHERE id = 1 AND state = 'active')
    BEGIN
      UPDATE messages_in
      SET repo_fence_epoch = (SELECT epoch FROM repo_ingress_fence WHERE id = 1),
          repo_fence_original_trigger = NEW.trigger,
          trigger = 0
      WHERE id = NEW.id;
    END;
  `);
}

export function readRepoIngressFence(db: Database.Database): RepoIngressFence | null {
  const row = db.prepare('SELECT epoch, generation, state FROM repo_ingress_fence WHERE id = 1').get() as
    | RepoIngressFence
    | undefined;
  return row ?? null;
}

/** Activate the per-session DB mirror of a publication fence. Idempotent for the same epoch. */
export function activateRepoIngressFence(db: Database.Database, epoch: string): RepoIngressFence {
  if (!epoch) throw new Error('repository ingress fence epoch must not be empty');
  migrateMessagesInTable(db);
  return db.transaction(() => {
    const current = readRepoIngressFence(db);
    if (current?.state === 'active' && current.epoch !== epoch) {
      throw new Error(`repository ingress fence ${current.epoch} is already active`);
    }
    if (current?.state === 'active') return current;
    const generation = randomUUID();
    db.prepare(
      `INSERT INTO repo_ingress_fence (id, epoch, generation, state) VALUES (1, ?, ?, 'active')
       ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, generation = excluded.generation, state = 'active'`,
    ).run(epoch, generation);
    return { epoch, generation, state: 'active' as const };
  })();
}

function admitTaggedRows(db: Database.Database, epoch: string, messageId?: string): RepoIngressAdmissionResult {
  const idFilter = messageId === undefined ? '' : " AND (id = @messageId OR id = 'recall-' || @messageId)";
  const wakeRequired =
    (db
      .prepare(
        `SELECT 1 FROM messages_in
           WHERE repo_fence_epoch = @epoch
             AND repo_fence_original_trigger = 1
             AND status = 'pending'
             AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))${idFilter}
           LIMIT 1`,
      )
      .get({ epoch, messageId: messageId ?? null }) as { 1: number } | undefined) !== undefined;
  const result = db
    .prepare(
      `UPDATE messages_in
       SET trigger = repo_fence_original_trigger,
           repo_fence_epoch = NULL,
           repo_fence_original_trigger = NULL
       WHERE repo_fence_epoch = @epoch${idFilter}`,
    )
    .run({ epoch, messageId: messageId ?? null });
  return { admittedRows: result.changes, wakeRequired };
}

/**
 * Admit one logical inbound unit after a writer discovers its observed fence
 * epoch was already released or replaced. Replays are harmless.
 */
export function admitRepoIngressFenceMessage(
  db: Database.Database,
  epoch: string,
  messageId: string,
): RepoIngressAdmissionResult {
  migrateMessagesInTable(db);
  return db.transaction(() => {
    const current = readRepoIngressFence(db);
    if (current?.state === 'active' && current.epoch === epoch) {
      return { admittedRows: 0, wakeRequired: false };
    }
    return admitTaggedRows(db, epoch, messageId);
  })();
}

/** Release a matching active epoch and restore every tagged row exactly once. */
export function releaseRepoIngressFence(
  db: Database.Database,
  epoch: string,
  generation: string,
): RepoIngressReleaseResult {
  migrateMessagesInTable(db);
  return db.transaction(() => {
    const current = readRepoIngressFence(db);
    if (!current || current.epoch !== epoch || current.generation !== generation || current.state !== 'active') {
      return { released: false, admittedRows: 0, wakeRequired: false };
    }
    db.prepare(
      "UPDATE repo_ingress_fence SET state = 'released' WHERE id = 1 AND epoch = ? AND generation = ? AND state = 'active'",
    ).run(epoch, generation);
    const admitted = admitTaggedRows(db, epoch);
    return { released: true, ...admitted };
  })();
}

function runInsertMessage(db: Database.Database, message: MessageInsert, ignoreDuplicateId: boolean): boolean {
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
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after, recurrence, series_id, trigger, source_session_id, on_wake, repo_fence_epoch, repo_fence_original_trigger)
       VALUES (@id, @seq, @kind, @timestamp, 'pending', @platformId, @channelType, @threadId, @content, @processAfter, @recurrence, @id, @trigger, @sourceSessionId, @onWake, @repoFenceEpoch, @repoFenceOriginalTrigger)${conflictClause}`,
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
export const INTERACTIVE_WAKE_MAX_AGE_MS = 15 * 60 * 1000;

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

export function markMessageFailed(db: Database.Database, messageId: string): void {
  db.prepare("UPDATE messages_in SET status = 'failed' WHERE id = ?").run(messageId);
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

export function retryWithBackoff(db: Database.Database, messageId: string, backoffSec: number): void {
  const processAfter = new Date(Date.now() + backoffSec * 1000).toISOString();
  db.prepare('UPDATE messages_in SET tries = tries + 1, process_after = ? WHERE id = ?').run(processAfter, messageId);
}

export function getMessageForRetry(
  db: Database.Database,
  messageId: string,
  status: string,
): { id: string; tries: number; processAfter: string | null } | undefined {
  return db
    .prepare('SELECT id, tries, process_after as processAfter FROM messages_in WHERE id = ? AND status = ?')
    .get(messageId, status) as { id: string; tries: number; processAfter: string | null } | undefined;
}

export function syncProcessingAcks(inDb: Database.Database, outDb: Database.Database): void {
  const completed = outDb
    .prepare(
      "SELECT message_id, status FROM processing_ack WHERE status IN ('completed', 'failed', 'script-skip:error')",
    )
    .all() as Array<{ message_id: string; status: string }>;

  if (completed.length === 0) return;

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

export interface ProcessingClaim {
  message_id: string;
  status_changed: string;
}

/** Return processing_ack rows still in 'processing' with their claim timestamps. */
export function getProcessingClaims(outDb: Database.Database): ProcessingClaim[] {
  return outDb
    .prepare("SELECT message_id, status_changed FROM processing_ack WHERE status = 'processing'")
    .all() as ProcessingClaim[];
}

/**
 * Delete orphan 'processing' rows. Called by the host after killing a
 * container so the leftover claim doesn't trip claim-stuck on the next sweep
 * tick (which would kill the freshly respawned container before its
 * agent-runner can run its own startup cleanup).
 *
 * Safe because the host only writes to outbound.db when no container is
 * running (we just killed it). Returns the number of rows deleted.
 */
export function deleteOrphanProcessingClaims(outDb: Database.Database): number {
  return outDb.prepare("DELETE FROM processing_ack WHERE status = 'processing'").run().changes;
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
const CONTAINER_STATE_COLUMN_TIERS = [
  `${CONTAINER_STATE_MEMORY_COLUMNS}, memory_max_events`,
  CONTAINER_STATE_MEMORY_COLUMNS,
  CONTAINER_STATE_PROVIDER_COLUMNS,
  CONTAINER_STATE_TOOL_COLUMNS,
];

// ---------------------------------------------------------------------------
// messages_out (read-only from host)
// ---------------------------------------------------------------------------

export interface OutboundMessage {
  id: string;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  in_reply_to: string | null;
}

export function getDueOutboundMessages(db: Database.Database): OutboundMessage[] {
  return db
    .prepare(
      `SELECT * FROM messages_out
       WHERE (deliver_after IS NULL OR datetime(deliver_after) <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as OutboundMessage[];
}

// ---------------------------------------------------------------------------
// delivered
// ---------------------------------------------------------------------------

export function getDeliveredIds(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare('SELECT message_out_id FROM delivered').all() as Array<{ message_out_id: string }>).map(
      (r) => r.message_out_id,
    ),
  );
}

/**
 * UPSERT the `delivered` row for a message_out id. Three flavors:
 *   - 'pending'   — gate dispatched, awaiting human. INSERT-only (idempotent).
 *   - 'delivered' — gate approved / message sent successfully.
 *   - 'failed'    — gate rejected/timed out / delivery threw.
 *
 * `delivered` and `failed` must overwrite an earlier 'pending' row so the
 * container's awaitDeliveryAck sees the final decision instead of staying
 * stuck on 'pending'. 'pending' uses INSERT OR IGNORE because once a row
 * exists (pending or resolved) we don't want to clobber it by accident.
 */
export function markPending(db: Database.Database, messageOutId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, NULL, 'pending', datetime('now'))",
  ).run(messageOutId);
}

export function markDelivered(db: Database.Database, messageOutId: string, platformMessageId: string | null): void {
  db.prepare(
    `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at)
     VALUES (?, ?, 'delivered', ?)
     ON CONFLICT(message_out_id) DO UPDATE SET
       platform_message_id = excluded.platform_message_id,
       status = 'delivered',
       error = NULL,
       delivered_at = excluded.delivered_at`,
  ).run(messageOutId, platformMessageId ?? null, new Date().toISOString());
}

export function markDeliveryFailed(db: Database.Database, messageOutId: string, errorMessage?: string): void {
  db.prepare(
    `INSERT INTO delivered (message_out_id, platform_message_id, status, error, delivered_at)
     VALUES (?, NULL, 'failed', ?, ?)
     ON CONFLICT(message_out_id) DO UPDATE SET
       status = 'failed',
       error = excluded.error,
       delivered_at = excluded.delivered_at`,
  ).run(messageOutId, errorMessage ?? null, new Date().toISOString());
}

/** Ensure the delivered table has columns added after initial schema. */
export function migrateDeliveredTable(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info('delivered')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('platform_message_id')) {
    db.prepare('ALTER TABLE delivered ADD COLUMN platform_message_id TEXT').run();
  }
  if (!cols.has('status')) {
    db.prepare("ALTER TABLE delivered ADD COLUMN status TEXT NOT NULL DEFAULT 'delivered'").run();
  }
  if (!cols.has('error')) {
    db.prepare('ALTER TABLE delivered ADD COLUMN error TEXT').run();
  }
}

// LEGACY-COMPAT(v1-tasks): adds columns added to messages_in after the initial
// v2 schema to pre-existing session DBs — this lazy, on-open migration IS the
// upgrade path for old installs (there is no central migration for session
// DBs). No-op on fresh installs where the columns are in the baseline schema.
// Backfills existing rows so invariants hold (series_id = id).
export function migrateMessagesInTable(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has('series_id')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN series_id TEXT').run();
    db.prepare('UPDATE messages_in SET series_id = id WHERE series_id IS NULL').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id)').run();
  }
  if (!cols.has('trigger')) {
    // All pre-existing rows got written with the old "every inbound wakes
    // the agent" semantics, so backfill 1 and default 1 for new inserts.
    db.prepare('ALTER TABLE messages_in ADD COLUMN trigger INTEGER NOT NULL DEFAULT 1').run();
  }
  if (!cols.has('source_session_id')) {
    // For agent-to-agent return-path routing. NULL on existing rows is fine —
    // their replies fall back to the legacy "newest active session" lookup.
    db.prepare('ALTER TABLE messages_in ADD COLUMN source_session_id TEXT').run();
  }
  if (!cols.has('on_wake')) {
    // 1 = only deliver on the container's first poll (fresh start).
    // All existing rows are normal messages, so default 0.
    db.prepare('ALTER TABLE messages_in ADD COLUMN on_wake INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!cols.has('repo_fence_epoch')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN repo_fence_epoch TEXT').run();
  }
  if (!cols.has('repo_fence_original_trigger')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN repo_fence_original_trigger INTEGER').run();
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS repo_ingress_fence (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      epoch TEXT NOT NULL,
      generation TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'released'))
    )
  `);
  const fenceCols = new Set(
    (db.prepare("PRAGMA table_info('repo_ingress_fence')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!fenceCols.has('generation')) {
    db.prepare('ALTER TABLE repo_ingress_fence ADD COLUMN generation TEXT').run();
    db.prepare('UPDATE repo_ingress_fence SET generation = lower(hex(randomblob(16))) WHERE generation IS NULL').run();
  }
  installRepoIngressFenceGuards(db);
  // Read-path enabler for the Scheduled Tasks Board (design §4.8). Added
  // unconditionally — existing DBs already carry `series_id` (so the branch
  // above is skipped) yet still need this compound index. Created on the next
  // write-path open; board read-only opens tolerate its absence and fall back
  // to the scan. Idempotent via IF NOT EXISTS. Read-path only; C1 untouched.
  db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_in_series_seq ON messages_in(series_id, seq DESC)').run();
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

// ---------------------------------------------------------------------------
// Dashboard helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a message id already exists in a session's inbound.db.
 * Used by the steer write path's partial-write recovery (D5) to detect
 * whether a message was already inserted before a mid-write failure.
 *
 * Open-read-close per call — same discipline as all other inbound.db ops.
 * Returns false if the DB file does not exist (session not yet initialised).
 */
export function sessionInboundHasMessage(agentGroupId: string, sessionId: string, messageId: string): boolean {
  const dbPath = path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId, 'inbound.db');
  if (!fs.existsSync(dbPath)) return false;
  // Read-only: this only ever runs one SELECT, and a writable open would take
  // a hot-journal rollback write on a session the reclaim may be archiving.
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 5000');
  try {
    const row = db.prepare('SELECT 1 FROM messages_in WHERE id = ? LIMIT 1').get(messageId);
    return row !== undefined;
  } finally {
    db.close();
  }
}
