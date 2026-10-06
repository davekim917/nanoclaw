/** SQL for the sweep's self-heal paths; every cap, throttle and message body stays in the sweep. */
import type Database from 'better-sqlite3';

/** Id prefixes of the deferred wake rows the sweep parks when a budget is spent. */
const RECOVERY_WAKE_ID_PREFIXES = ['ceiling-respawn-', 'reap-respawn-', 'host-restart-', 'provider-heal-'];
const RECOVERY_WAKE_ID_PATTERNS = `(${RECOVERY_WAKE_ID_PREFIXES.map((prefix) => `id LIKE '${prefix}%'`).join(' OR ')})`;

export function isRecoveryWakeId(id: string): boolean {
  return RECOVERY_WAKE_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

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
 * Marker rows since the last genuine (non-system) inbound: real user input is
 * what resets a recovery budget, not a wall clock.
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

export function latestRecoveryMarkerTimestamp(inDb: Database.Database, idPrefix: string): string | null {
  const row = inDb.prepare('SELECT MAX(timestamp) AS ts FROM messages_in WHERE id LIKE ?').get(`${idPrefix}%`) as
    | { ts: string | null }
    | undefined;
  return row?.ts ?? null;
}

/** The per-episode idempotency key. */
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

export function readMessageRouting(inDb: Database.Database, messageId: string): InboundMessageRouting | undefined {
  return inDb.prepare('SELECT channel_type, platform_id, thread_id FROM messages_in WHERE id = ?').get(messageId) as
    | InboundMessageRouting
    | undefined;
}

export function latestInboundTimestamp(inDb: Database.Database): string | null {
  const row = inDb.prepare('SELECT timestamp FROM messages_in ORDER BY seq DESC LIMIT 1').get() as
    | { timestamp: string }
    | undefined;
  return row?.timestamp ?? null;
}

export function latestOutboundTimestamp(outDb: Database.Database): string | null {
  const row = outDb.prepare('SELECT timestamp FROM messages_out ORDER BY seq DESC LIMIT 1').get() as
    | { timestamp: string }
    | undefined;
  return row?.timestamp ?? null;
}

export interface OutboundChatRow {
  id: string;
  timestamp: string;
  content: string;
  in_reply_to: string | null;
}

export function latestOutboundChat(outDb: Database.Database): OutboundChatRow | null {
  const row = outDb
    .prepare(
      "SELECT id, timestamp, content, in_reply_to FROM messages_out WHERE kind = 'chat' ORDER BY seq DESC LIMIT 1",
    )
    .get() as OutboundChatRow | undefined;
  return row ?? null;
}

/** Moves only a still-'pending' row, so a terminal status is never overwritten. */
export function markInboundCompletedIfPending(inDb: Database.Database, messageId: string): void {
  inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ? AND status = 'pending'").run(messageId);
}

/** One-notice-per-episode gate. */
export function outboundHasContentLike(outDb: Database.Database, marker: string): boolean {
  return outDb.prepare('SELECT 1 FROM messages_out WHERE content LIKE ? LIMIT 1').get(`%${marker}%`) !== undefined;
}

/** The racing-sweep-tick duplicate gate. */
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
 * Progress rows are not answers: `kind != 'status'` matches the container's
 * pending query, so a turn that emitted only status updates is retried.
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
 * Deliberately NOT upstream's `writeDirect` (which renumbers seq across both
 * files): `MAX(seq) + 2` within messages_out keeps live sessions' on-disk
 * sequence unchanged. Safe with a container running: DELETE journal +
 * busy_timeout on both sides, and the even host seq stays out of the
 * container's odd space.
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
