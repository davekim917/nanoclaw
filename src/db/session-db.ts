/**
 * SQL operations on per-session inbound/outbound DBs.
 *
 * These are NOT the central app DB — they're the cross-mount SQLite files
 * shared between host and container. Callers own the connection lifecycle
 * (open-write-close per op). See session-manager.ts header for invariants.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';

/** Apply the inbound or outbound schema to a DB file. Idempotent. */
export function ensureSchema(dbPath: string, schema: 'inbound' | 'outbound'): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.exec(schema === 'inbound' ? INBOUND_SCHEMA : OUTBOUND_SCHEMA);
  db.close();
}

/** Open the inbound DB for a session (host reads/writes). */
export function openInboundDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Open the outbound DB for a session (host reads only). */
export function openOutboundDb(dbPath: string): Database.Database {
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

export function insertMessage(
  db: Database.Database,
  message: {
    id: string;
    kind: string;
    timestamp: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
    processAfter: string | null;
    recurrence: string | null;
    /**
     * 1 = wake the agent (default); 0 = accumulate as context only.
     * Host countDueMessages gates on this; container reads everything.
     */
    trigger?: 0 | 1;
    /**
     * For agent-to-agent inbound: the source session id that emitted the
     * outbound message which became this inbound row. Used as the return
     * path for the target's reply. NULL on channel-side inbound.
     */
    sourceSessionId?: string | null;
    /**
     * 1 = only deliver on the container's first poll (fresh start).
     * Dying containers (past first poll) skip these rows.
     */
    onWake?: 0 | 1;
  },
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after, recurrence, series_id, trigger, source_session_id, on_wake)
     VALUES (@id, @seq, @kind, @timestamp, 'pending', @platformId, @channelType, @threadId, @content, @processAfter, @recurrence, @id, @trigger, @sourceSessionId, @onWake)`,
  ).run({
    ...message,
    trigger: message.trigger ?? 1,
    onWake: message.onWake ?? 0,
    sourceSessionId: message.sourceSessionId ?? null,
    seq: nextEvenSeq(db),
  });
}

export function countDueMessages(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM messages_in
       WHERE status = 'pending'
         AND trigger = 1
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))`,
      )
      .get() as { count: number }
  ).count;
}

/**
 * Mark long-pending NON-RECURRING rows as 'expired' so sweep stops re-waking
 * sessions on one-shot messages that have sat unprocessed for a day or more.
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
  const cutoffIso = new Date(Date.now() - maxAgeMs).toISOString();
  const nowIso = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE messages_in
       SET status = 'expired'
       WHERE status = 'pending'
         AND recurrence IS NULL
         AND timestamp < ?
         AND (process_after IS NULL OR process_after < ?)`,
    )
    .run(cutoffIso, nowIso);
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
}

/**
 * Read the container's current tool-in-flight state, if any. Returns null
 * when either the table doesn't exist yet (older session DB) or no tool is
 * active. Host sweep reads this to widen stuck-detection tolerance while
 * Bash is running with a long declared timeout.
 */
export function getContainerState(outDb: Database.Database): ContainerState | null {
  try {
    const row = outDb
      .prepare(
        `SELECT current_tool, tool_declared_timeout_ms, tool_started_at
           FROM container_state WHERE id = 1`,
      )
      .get() as ContainerState | undefined;
    return row ?? null;
  } catch {
    // Table not present on older session DBs — treat as "no tool in flight".
    return null;
  }
}

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
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  try {
    const row = db.prepare('SELECT 1 FROM messages_in WHERE id = ? LIMIT 1').get(messageId);
    return row !== undefined;
  } finally {
    db.close();
  }
}
