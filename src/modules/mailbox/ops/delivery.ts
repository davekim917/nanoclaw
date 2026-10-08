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
  /** When the runner queued the row (ISO). */
  timestamp?: string;
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
 * Every id in `messages_out`, due or not: a session is armed quiet only when
 * nothing is outstanding, and a future row sits in a file that may never change.
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
 * 'pending' (gate awaiting a human) is INSERT OR IGNORE so it never clobbers
 * an existing row; 'delivered'/'failed' must overwrite 'pending' so the
 * container's awaitDeliveryAck sees the final decision.
 */
export function markPending(db: Database.Database, messageOutId: string): void {
  // Bound ISO like the resolving writers that overwrite this column.
  db.prepare(
    "INSERT OR IGNORE INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, NULL, 'pending', ?)",
  ).run(messageOutId, new Date().toISOString());
}

/**
 * `notice` (a routing veto) reaches the agent through the runner's ack wait. It is written in the same transaction as
 * the delivered row, so an ack is never read without it; without one the statement is the plain upsert.
 */
export function markDelivered(
  db: Database.Database,
  messageOutId: string,
  platformMessageId: string | null,
  notice?: string,
): void {
  const upsert = () =>
    db
      .prepare(
        `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at)
         VALUES (?, ?, 'delivered', ?)
         ON CONFLICT(message_out_id) DO UPDATE SET
           platform_message_id = excluded.platform_message_id,
           status = 'delivered',
           error = NULL,
           delivered_at = excluded.delivered_at`,
      )
      .run(messageOutId, platformMessageId ?? null, new Date().toISOString());
  if (notice === undefined) {
    upsert();
    return;
  }
  db.transaction(() => {
    upsert();
    db.prepare('UPDATE delivered SET notice = ? WHERE message_out_id = ?').run(notice, messageOutId);
  })();
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
 * Path-level (answered BEFORE any handle opens, and for sessions with no
 * mailbox). `null` means "do not arm": absent, unreadable, or a hot journal,
 * whose pending rollback makes the stat ambiguous.
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
