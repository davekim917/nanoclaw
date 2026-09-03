/**
 * Narrow named reads the host's delivery family needs from a session's
 * inbound.db. Internal to `src/modules/mailbox/`.
 *
 * Each op exists because exactly one caller used to run its SELECT on a raw
 * handle the delivery loop handed it (plan §4.5b, invariant I-9). They are
 * deliberately specific rather than one parameterized query: a generic
 * "run this SQL" escape hatch would move the statement out of the module
 * again in everything but name.
 */
import type Database from 'better-sqlite3';

/** One inbound chat row, as `caller-identity.ts` scans it for a human sender. */
export interface InboundChatSenderRow {
  content?: string;
  channel_type?: string;
}

/**
 * The most recent inbound chat rows, newest first.
 *
 * `chat` / `chat-sdk` only — `task` / `system` / `webhook` rows carry no human
 * sender. Both chat kinds must be listed: the chat-SDK bridge writes
 * `chat-sdk`, legacy adapters write `chat`.
 */
export function getRecentInboundChatSenders(db: Database.Database, limit: number): InboundChatSenderRow[] {
  return db
    .prepare(
      `SELECT content, channel_type FROM messages_in
       WHERE kind IN ('chat', 'chat-sdk')
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(limit) as InboundChatSenderRow[];
}

/** A named `type='channel'` destination row the host wrote before the last wake. */
export interface ChannelDestination {
  channel_type?: string;
  platform_id?: string;
}

/**
 * Resolve a destination name to its (channel_type, platform_id) address.
 *
 * `destinations` lives in the session's inbound.db (the host writes it at each
 * wake, the container reads it live); the caller maps the address back to a
 * central `messaging_groups` row.
 */
export function getChannelDestination(db: Database.Database, name: string): ChannelDestination | null {
  return (
    (db.prepare(`SELECT channel_type, platform_id FROM destinations WHERE name = ? AND type = 'channel'`).get(name) as
      | ChannelDestination
      | undefined) ?? null
  );
}

/**
 * The newest task occurrence of a series, by wall-clock timestamp.
 *
 * Delivery reads the series' own row to answer the per-series thread-anchor
 * opt-out (`content.threadAnchor === false`). Timestamp order, not `seq`:
 * this only ever needs the series' current declared contract, and the
 * timestamp is what the fires carry.
 */
export function getLatestTaskContent(db: Database.Database, seriesId: string): string | null {
  const row = db
    .prepare("SELECT content FROM messages_in WHERE kind = 'task' AND series_id = ? ORDER BY timestamp DESC LIMIT 1")
    .get(seriesId) as { content: string } | undefined;
  return row?.content ?? null;
}

/** The delivery route and payload a host-authored task occurrence carries. */
export interface RoutedTaskRow {
  channel_type: string;
  platform_id: string;
  content: string;
}

/**
 * The newest task occurrence of a series that carries a delivery route.
 *
 * Isolated scheduled-task sessions have no central messaging_group_id; their
 * host-authored task row is the only place the route lives. `seq` order (not
 * timestamp) because the caller wants the latest ROW, and rows with a null
 * route are skipped rather than ending the search.
 */
export function getLatestRoutedTaskRow(db: Database.Database, seriesId: string): RoutedTaskRow | null {
  return (
    (db
      .prepare(
        `SELECT channel_type, platform_id, content
           FROM messages_in
          WHERE kind = 'task'
            AND series_id = ?
            AND channel_type IS NOT NULL
            AND platform_id IS NOT NULL
       ORDER BY seq DESC
          LIMIT 1`,
      )
      .get(seriesId) as RoutedTaskRow | undefined) ?? null
  );
}

/** Routing carried by one inbound row, used to anchor a reply to it. */
export interface InboundRoutingAnchor {
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  source_session_id: string | null;
}

/**
 * The routing of one inbound row in THIS session.
 *
 * `schedule_wake` anchors its deferred row to the message the agent replied
 * to; a miss means the anchor is not in the caller's session and the request
 * is rejected, so `null` is a load-bearing answer, not a fallback.
 */
export function getInboundRoutingAnchor(db: Database.Database, messageId: string): InboundRoutingAnchor | null {
  return (
    (db
      .prepare('SELECT platform_id, channel_type, thread_id, source_session_id FROM messages_in WHERE id = ?')
      .get(messageId) as InboundRoutingAnchor | undefined) ?? null
  );
}

/**
 * True when this session already carries a host-restart accountability note
 * timestamped at or after `since`.
 *
 * The dedupe window is the caller's (`host-restart-warn.ts`); the id prefix is
 * the note's identity, so the predicate belongs to the row shape rather than
 * to the caller.
 */
export function hasRestartNoteSince(db: Database.Database, since: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM messages_in
          WHERE id LIKE 'host-restart-%' AND datetime(timestamp) >= datetime(?)
          LIMIT 1`,
      )
      .get(since) !== undefined
  );
}
