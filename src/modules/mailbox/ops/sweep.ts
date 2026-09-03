/**
 * Sweep-side reads and status transitions: due counting, staleness, retries,
 * processing-ack reconciliation and the tiered container-state read.
 * Internal to `src/modules/mailbox/`.
 */
import type Database from 'better-sqlite3';

import { migrateMessagesInTable } from '../schema.js';

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

/**
 * Fused read-outbound/write-inbound reconciliation. Upstream splits this into
 * `getTerminalProcessingAcks()` + `applyProcessingAcks()`; the fork keeps it
 * fused because both handles are already in scope inside a mailbox session and
 * the host sweep's control flow is written around one call.
 */
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
