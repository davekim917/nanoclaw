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
