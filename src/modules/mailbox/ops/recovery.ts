/**
 * Reads and writes the host sweep's self-heal accountability paths need:
 * the deferred recovery-wake rows it plants in `messages_in`, the per-class
 * attempt markers it counts them by, and the small outbound probes its
 * one-notice-per-episode gates use.
 *
 * Moved verbatim out of `src/host-sweep.ts` for the mailbox seam
 * (docs/specs/upstream-mailbox-seam/plan.md §4.4, "Sweep / container state").
 * The SQL lives here; every cap, throttle and message body stays in the sweep.
 * Internal to `src/modules/mailbox/`.
 */
import type Database from 'better-sqlite3';

/** Id prefixes of the deferred wake rows the sweep parks when a budget is spent. */
const RECOVERY_WAKE_ID_PATTERNS =
  "(id LIKE 'ceiling-respawn-%' OR id LIKE 'host-restart-%' OR id LIKE 'provider-heal-%')";

export function hasDueRecoveryWake(inDb: Database.Database, nowIso: string): boolean {
  return Boolean(
    inDb
      .prepare(
        `SELECT 1 FROM messages_in
         WHERE status = 'pending'
           AND trigger = 1
           AND (process_after IS NULL OR datetime(process_after) <= datetime(?))
           AND ${RECOVERY_WAKE_ID_PATTERNS}
         LIMIT 1`,
      )
      .get(nowIso),
  );
}

export function parkDueRecoveryWakes(inDb: Database.Database, nowIso: string): number {
  return inDb
    .prepare(
      `UPDATE messages_in
       SET status = 'completed'
       WHERE status = 'pending'
         AND trigger = 1
         AND (process_after IS NULL OR datetime(process_after) <= datetime(?))
         AND ${RECOVERY_WAKE_ID_PATTERNS}`,
    )
    .run(nowIso).changes;
}

/**
 * How many self-heal marker rows carrying `idPrefix` were written since the
 * last genuine (non-system) inbound message. Real user input is what resets a
 * recovery budget, so the cap is expressed against it rather than a wall clock.
 */
export function countRecoveryAttemptsSinceRealInbound(inDb: Database.Database, idPrefix: string): number {
  const row = inDb
    .prepare(
      `SELECT COUNT(*) AS count FROM messages_in
       WHERE id LIKE ?
         AND datetime(timestamp) > COALESCE((
           SELECT MAX(datetime(timestamp)) FROM messages_in
           WHERE kind != 'system'
             AND COALESCE(
               json_extract(CASE WHEN json_valid(content) THEN content ELSE '{}' END, '$.senderId'),
               ''
             ) != 'system'
             AND COALESCE(
               json_extract(CASE WHEN json_valid(content) THEN content ELSE '{}' END, '$.sender'),
               ''
             ) != 'system'
         ), datetime('0001-01-01T00:00:00.000Z'))`,
    )
    .get(`${idPrefix}%`) as { count: number };
  return row.count;
}

/** Newest timestamp among marker rows carrying `idPrefix`, or null when there is none. */
export function latestRecoveryMarkerTimestamp(inDb: Database.Database, idPrefix: string): string | null {
  const row = inDb.prepare('SELECT MAX(timestamp) AS ts FROM messages_in WHERE id LIKE ?').get(`${idPrefix}%`) as
    | { ts: string | null }
    | undefined;
  return row?.ts ?? null;
}

/** Newest marker id carrying `idPrefix` — the per-episode idempotency key. */
export function latestRecoveryMarkerId(inDb: Database.Database, idPrefix: string): string | null {
  const row = inDb.prepare('SELECT MAX(id) AS id FROM messages_in WHERE id LIKE ?').get(`${idPrefix}%`) as
    | { id: string | null }
    | undefined;
  return row?.id ?? null;
}

export interface InboundMessageRouting {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

/** Routing carried by one specific inbound row, or undefined when it is gone. */
export function readMessageRouting(inDb: Database.Database, messageId: string): InboundMessageRouting | undefined {
  return inDb.prepare('SELECT channel_type, platform_id, thread_id FROM messages_in WHERE id = ?').get(messageId) as
    | InboundMessageRouting
    | undefined;
}

/** Most recent messages_in timestamp for a session, or null if it has none. */
export function latestInboundTimestamp(inDb: Database.Database): string | null {
  const row = inDb.prepare('SELECT timestamp FROM messages_in ORDER BY seq DESC LIMIT 1').get() as
    | { timestamp: string }
    | undefined;
  return row?.timestamp ?? null;
}

/** Most recent messages_out timestamp, or null if the session never produced output. */
export function latestOutboundTimestamp(outDb: Database.Database): string | null {
  const row = outDb.prepare('SELECT timestamp FROM messages_out ORDER BY seq DESC LIMIT 1').get() as
    | { timestamp: string }
    | undefined;
  return row?.timestamp ?? null;
}

/**
 * Backfill a completed status on the host-owned inbound row whose reply was
 * already written. Deliberately narrower than `markMessageFailed`: only a row
 * still 'pending' is moved, so a terminal status is never overwritten.
 */
export function markInboundCompletedIfPending(inDb: Database.Database, messageId: string): void {
  inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ? AND status = 'pending'").run(messageId);
}

/** Has any outbound row's content ever carried this marker? One-notice-per-episode gate. */
export function outboundHasContentLike(outDb: Database.Database, marker: string): boolean {
  return outDb.prepare('SELECT 1 FROM messages_out WHERE content LIKE ? LIMIT 1').get(`%${marker}%`) !== undefined;
}

/** Same probe bounded to the recent past — the racing-sweep-tick duplicate gate. */
export function outboundHasRecentContentLike(outDb: Database.Database, marker: string, withinSeconds: number): boolean {
  return (
    outDb
      .prepare(
        `SELECT 1 FROM messages_out
          WHERE datetime(timestamp) > datetime('now', ?)
            AND content LIKE ?
          LIMIT 1`,
      )
      .get(`-${withinSeconds} seconds`, `%${marker}%`) !== undefined
  );
}

/**
 * Did the container already answer this input? Progress rows are not answers —
 * the `kind != 'status'` filter matches the container-side pending-message
 * query so an interrupted turn that emitted only status updates is retried.
 */
export function hasNonStatusReplyTo(outDb: Database.Database, messageId: string): boolean {
  return (
    outDb.prepare("SELECT 1 FROM messages_out WHERE in_reply_to = ? AND kind != 'status' LIMIT 1").get(messageId) !==
    undefined
  );
}

export interface DirectOutboundRow {
  id: string;
  kind: string;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  content: string;
}

/**
 * The fork's host-side direct write into the container-owned outbound.db.
 *
 * Deliberately NOT upstream's `writeDirect`: upstream normalizes the sequence
 * to the next even number across both files, the fork takes `MAX(seq) + 2`
 * within messages_out. Keeping the fork statement keeps the on-disk sequence
 * unchanged for live sessions, which is what "no on-disk change" means for
 * this PR series.
 *
 * Safe with a container running: both sides open with DELETE journal +
 * busy_timeout, and the even host seq stays out of the container's odd space.
 */
export function writeOutboundDirectRow(writableOutDb: Database.Database, message: DirectOutboundRow): void {
  writableOutDb
    .prepare(
      `INSERT OR IGNORE INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      message.id,
      new Date().toISOString(),
      message.kind,
      message.platformId,
      message.channelType,
      message.threadId,
      message.content,
    );
}
