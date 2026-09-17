/**
 * Narrow, named reads that used to be raw-handle queries in caller files
 * (destinations.ts, session-recap.ts, db/delivery-acks.ts). The rows are
 * returned in their on-disk shape so the callers' mapping code — and its
 * tolerance for partially populated rows — is unchanged.
 */
import { getInboundDb, getOutboundDb } from '../../mailbox/sqlite/connection.js';

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
 * Whether a reply the PERSON can read was written after `seq`. Asked of the DB
 * rather than counted in-process because `send_message`/`send_file` run in the
 * MCP server's own process (mcp-tools/server.ts) and write here directly.
 * Only `chat` rows reach a person: `status` is a progress label, `system` and
 * `task_log` are host-facing. A `chat` row to a peer agent or to some other
 * channel is `send_message(to: …)` delegating, not an answer, so the row must
 * land in the conversation the message came from — same channel, platform AND
 * thread — and carry no `threadKey`: a keyed post keeps the triggering
 * channel/platform on its row but delivery re-parents it under the key's own
 * incident thread (src/delivery.ts, "Keyed thread anchor"). With no routing to
 * match (legacy sessions), any un-keyed non-agent chat row counts.
 */
export function hasChatOutboundAfter(
  seq: number,
  conversation: { channelType: string | null; platformId: string | null; threadId: string | null },
): boolean {
  const db = getOutboundDb();
  const base =
    "SELECT 1 FROM messages_out WHERE seq > ? AND kind = 'chat' AND json_extract(content, '$.threadKey') IS NULL";
  if (conversation.channelType === null || conversation.platformId === null) {
    return db.prepare(`${base} AND channel_type IS NOT 'agent' LIMIT 1`).get(seq) != null;
  }
  return (
    db
      .prepare(`${base} AND channel_type = ? AND platform_id = ? AND thread_id IS ? LIMIT 1`)
      .get(seq, conversation.channelType, conversation.platformId, conversation.threadId) != null
  );
}
