/**
 * Delivery bookkeeping: the host-owned `delivered` table and the read of due
 * outbound rows. Internal to `src/modules/mailbox/`.
 */
import type Database from 'better-sqlite3';

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
