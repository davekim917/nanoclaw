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
 *
 * What counts: `chat` (send_message, send_file, dispatched result blocks) and
 * `chat-sdk` (send_card / ask_user_question, mcp-tools/interactive.ts:93,156 —
 * a card is a documented way to answer). `status` is a progress label;
 * `system` and `task_log` are host-facing.
 *
 * Where it must land: the conversation the message came from — same channel,
 * platform AND thread. A row to a peer agent or another channel is
 * `send_message(to: …)` delegating, not an answer.
 *
 * `threadKey` only disqualifies a row when that conversation is un-threaded.
 * Delivery re-parents a keyed post under the key's own incident thread only
 * when the row has no thread_id (`keyAddr` requires `baseThreadId === null`,
 * src/delivery.ts:1575); with a thread_id the key has no effect and the post
 * lands in that thread (core.ts THREAD_KEY_DESCRIPTION says the same).
 *
 * With no routing to match (legacy sessions), any un-keyed non-agent row counts.
 * An unreadable row answers `true` — see the catch.
 */
export function hasChatOutboundAfter(
  seq: number,
  conversation: { channelType: string | null; platformId: string | null; threadId: string | null },
): boolean {
  // Fails OPEN: json_extract throws on a row whose content is not JSON, and a
  // nudge is a nicety — never worth killing the turn that asked.
  try {
    const db = getOutboundDb();
    const base = "SELECT 1 FROM messages_out WHERE seq > ? AND kind IN ('chat', 'chat-sdk')";
    const unkeyed = "json_extract(content, '$.threadKey') IS NULL";
    if (conversation.channelType === null || conversation.platformId === null) {
      return db.prepare(`${base} AND ${unkeyed} AND channel_type IS NOT 'agent' LIMIT 1`).get(seq) != null;
    }
    const keyClause = conversation.threadId === null ? ` AND ${unkeyed}` : '';
    return (
      db
        .prepare(`${base} AND channel_type = ? AND platform_id = ? AND thread_id IS ?${keyClause} LIMIT 1`)
        .get(seq, conversation.channelType, conversation.platformId, conversation.threadId) != null
    );
  } catch {
    return true;
  }
}
