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
 * The two ways to be wrong are not equal. Answering "yes" wrongly skips a
 * nudge, which is what happened before this existed. Answering "no" wrongly
 * nudges an agent that already replied, and it replies twice. So this matches
 * loosely and fails open:
 *
 *   - kind: `chat` (send_message, send_file, dispatched result blocks) and
 *     `chat-sdk` (send_card / ask_user_question, mcp-tools/interactive.ts:93,156).
 *     One `system` action also counts: `request_choice` posts a card the
 *     person sees and returns without waiting (mcp-tools/request-choice.ts:208).
 *     With no `to` it targets the session's own conversation and its row
 *     carries no routing; with `to` the content names `channelType`/`platformId`.
 *     Every other `system` action is host-facing or goes elsewhere
 *     (`escalate_to_owner` → the owner's DM), as are `status` (a progress
 *     label) and `task_log`.
 *   - where: the person's channel + platform. A row to a peer agent or another
 *     channel is `send_message(to: …)` delegating, not an answer.
 *   - NOT the thread, and NOT `threadKey`. No single authority decides the
 *     thread a reply lands in: the MCP tools stamp `getSessionRouting()`
 *     (mcp-tools/core.ts:224), final-text blocks stamp the channel's newest
 *     inbound row or the batch anchor (`sendToDestination`, poll-loop.ts), and
 *     delivery re-parents null-thread rows under the turn or key anchor
 *     (src/delivery.ts:1575-1588). Two review rounds each modelled that wrong
 *     and produced a false "no"; any row in the person's channel counts.
 *
 * With no routing to match (legacy sessions), any non-agent row counts. An
 * unreadable DB answers `true`.
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
