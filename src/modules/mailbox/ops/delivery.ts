/**
 * Delivery bookkeeping: the host-owned `delivered` table and the read of due
 * outbound rows. Internal to `src/modules/mailbox/`.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';

export interface OutboundMessage {
  id: string;
  seq: number | null;
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

/**
 * Every id in `messages_out`, due or not.
 *
 * The delivery loop arms a session as quiet only when nothing is outstanding,
 * and a row scheduled for later sits in a file that may never change again —
 * so "outstanding" has to mean every undelivered id, not just the due ones.
 */
export function listOutboundMessageIds(db: Database.Database): string[] {
  return (db.prepare('SELECT id FROM messages_out').all() as Array<{ id: string }>).map((row) => row.id);
}

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
  // Bound ISO, matching `markDelivered`/`markDeliveryFailed` below, which
  // overwrite this same column on this same row. `datetime('now')` wrote the
  // naive shape, so a still-pending row's `delivered_at` sorted and parsed
  // differently from a resolved one (CLAUDE.md, Timestamps).
  db.prepare(
    "INSERT OR IGNORE INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, NULL, 'pending', ?)",
  ).run(messageOutId, new Date().toISOString());
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

/** Mark an existing delivered lifecycle row as terminal without changing its delivery identity. */
export function markLifecycleTerminal(db: Database.Database, messageOutId: string): boolean {
  const result = db
    .prepare(
      `UPDATE delivered
       SET lifecycle_terminal_at = COALESCE(lifecycle_terminal_at, ?)
       WHERE message_out_id = ? AND status = 'delivered'`,
    )
    .run(new Date().toISOString(), messageOutId);
  return result.changes > 0;
}

/**
 * The quiet-delivery gate's view of a session's outbound file.
 *
 * The delivery sweep arms a session as quiet off `(mtime, size)` of
 * outbound.db and re-polls when either moves. That is a storage question, not
 * a mailbox-session one — it must be answered BEFORE any handle is opened, and
 * for sessions that have no mailbox at all — so it lives here as a path-level
 * op rather than on `MailboxSession`.
 *
 * `null` means "do not arm": the file is absent, unreadable, or carries a hot
 * journal, and a hot journal means a rollback (a write) is still owed on it, so
 * the pre-rollback stat is ambiguous. See `recoverHotJournal` in the openers.
 */
export function outboundStorageStat(dbPath: string): { mtimeNs: bigint; size: number } | null {
  try {
    if (fs.existsSync(`${dbPath}-journal`)) return null;
    const stat = fs.statSync(dbPath, { bigint: true });
    return { mtimeNs: stat.mtimeNs, size: Number(stat.size) };
  } catch {
    return null;
  }
}
