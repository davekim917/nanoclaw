/** Narrow named reads returning on-disk row shapes, so callers' mapping code is unchanged. */
import { getInboundDb, getOutboundDb, openInboundDb } from '../../mailbox/sqlite/connection.js';

export interface DestinationRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

export function getDestinationRows(): DestinationRow[] {
  return getInboundDb().prepare('SELECT * FROM destinations ORDER BY name').all() as DestinationRow[];
}

export function findDestinationRowByName(name: string): DestinationRow | undefined {
  return getInboundDb().prepare('SELECT * FROM destinations WHERE name = ?').get(name) as DestinationRow | undefined;
}

export function findDestinationRowByRouting(channelType: string, platformId: string): DestinationRow | undefined {
  const db = getInboundDb();
  return channelType === 'agent'
    ? (db.prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?").get(platformId) as
        | DestinationRow
        | undefined)
    : (db
        .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
        .get(channelType, platformId) as DestinationRow | undefined);
}

export interface RecapRow {
  timestamp: string;
  content: string;
}

/** Completed chat turns the user sent, newest first. Throws if the table is absent. */
export function readRecapInboundRows(limit: number): RecapRow[] {
  return getInboundDb()
    .prepare(
      `SELECT timestamp, content FROM messages_in
         WHERE kind IN ('chat', 'chat-sdk')
           AND status = 'completed'
         ORDER BY timestamp DESC
         LIMIT ?`,
    )
    .all(limit) as RecapRow[];
}

/** Chat replies this session wrote, newest first. Throws if the table is absent. */
export function readRecapOutboundRows(limit: number): RecapRow[] {
  return getOutboundDb()
    .prepare(
      `SELECT timestamp, content FROM messages_out
         WHERE kind = 'chat'
         ORDER BY timestamp DESC
         LIMIT ?`,
    )
    .all(limit) as RecapRow[];
}

export interface DeliveredRow {
  status: string;
  platform_message_id: string | null;
  error: string | null;
}

/** The host's delivery verdict for one outbound row, or undefined until it lands. */
export function readDeliveredRow(messageOutId: string): DeliveredRow | undefined {
  return getInboundDb()
    .prepare('SELECT status, platform_message_id, error FROM delivered WHERE message_out_id = ?')
    .get(messageOutId) as DeliveredRow | undefined;
}

/** Highest outbound seq written so far, 0 when none — a watermark for `hasChatOutboundAfter`. */
export function maxOutboundSeq(): number {
  const row = getOutboundDb().prepare('SELECT MAX(seq) AS seq FROM messages_out').get() as { seq: number | null };
  return row.seq ?? 0;
}

/**
 * Whether a reply the PERSON can read was written after `seq`. Asked of the DB because the MCP server writes
 * from its own process. Matches loosely and fails open (unreadable DB = true): a false "no" makes the agent
 * reply twice. Counts chat/chat-sdk rows and `request_choice` system cards in the person's channel and
 * platform, in ANY thread: no single authority decides a reply's thread.
 */
export function hasChatOutboundAfter(
  seq: number,
  conversation: { channelType: string | null; platformId: string | null },
): boolean {
  try {
    const db = getOutboundDb();
    const base = 'SELECT 1 FROM messages_out WHERE seq > ?1';
    const chat = "kind IN ('chat', 'chat-sdk')";
    const card = "kind = 'system' AND json_extract(content, '$.action') = 'request_choice'";
    const cardTo = "json_extract(content, '$.platformId')";
    if (conversation.channelType === null || conversation.platformId === null) {
      return (
        db.prepare(`${base} AND ((${chat} AND channel_type IS NOT 'agent') OR (${card})) LIMIT 1`).get(seq) != null
      );
    }
    return (
      db
        .prepare(
          `${base} AND ((${chat} AND channel_type = ?2 AND platform_id = ?3)
             OR (${card} AND (${cardTo} IS NULL
               OR (${cardTo} = ?3 AND json_extract(content, '$.channelType') = ?2)))) LIMIT 1`,
        )
        .get(seq, conversation.channelType, conversation.platformId) != null
    );
  } catch {
    return true;
  }
}

/** Is a `wait` wake still pending and not yet due? Fresh handle: the host writes continuously. bun:sqlite returns null for a missing row. */
export function hasFutureSelfWake(): boolean {
  const db = openInboundDb();
  try {
    return (
      db
        .prepare(
          `SELECT 1 FROM messages_in
            WHERE id LIKE 'schedule-wake-%' AND status = 'pending'
              AND process_after IS NOT NULL AND datetime(process_after) > datetime('now')
            LIMIT 1`,
        )
        .get() != null
    );
  } finally {
    db.close();
  }
}
