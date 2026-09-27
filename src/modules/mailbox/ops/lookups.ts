/**
 * Narrow named reads for the delivery family, deliberately specific rather than
 * one parameterized query: a "run this SQL" hatch would move the statement out
 * of the module in all but name.
 */
import type Database from 'better-sqlite3';

export interface InboundChatSenderRow {
  content?: string;
  channel_type?: string;
}

/**
 * Newest first. Both `chat` (legacy adapters) and `chat-sdk` (the bridge) must
 * be listed; other kinds carry no human sender.
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

export interface ChannelDestination {
  channel_type?: string;
  platform_id?: string;
}

/** The caller maps the address back to a central `messaging_groups` row. */
export function getChannelDestination(db: Database.Database, name: string): ChannelDestination | null {
  return (
    (db.prepare(`SELECT channel_type, platform_id FROM destinations WHERE name = ? AND type = 'channel'`).get(name) as
      | ChannelDestination
      | undefined) ?? null
  );
}

/**
 * Timestamp order, not `seq`: only the series' current declared contract
 * (e.g. the `threadAnchor` opt-out) is needed.
 */
export function getLatestTaskContent(db: Database.Database, seriesId: string): string | null {
  const row = db
    .prepare("SELECT content FROM messages_in WHERE kind = 'task' AND series_id = ? ORDER BY timestamp DESC LIMIT 1")
    .get(seriesId) as { content: string } | undefined;
  return row?.content ?? null;
}

/** Null when the row is not a task occurrence. */
export function getTaskOccurrenceSeriesId(db: Database.Database, occurrenceId: string): string | null {
  const row = db.prepare("SELECT series_id FROM messages_in WHERE id = ? AND kind = 'task'").get(occurrenceId) as
    | { series_id: string | null }
    | undefined;
  return row?.series_id ?? null;
}

export interface RoutedTaskRow {
  channel_type: string;
  platform_id: string;
  content: string;
}

/**
 * Isolated task sessions have no messaging group; the task row is the only
 * place the route lives. `seq` order, and null-route rows are skipped rather
 * than ending the search.
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

export interface InboundRoutingAnchor {
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  source_session_id: string | null;
}

export interface InboundRequestIdentity {
  id: string;
  seq: number;
  kind: string;
  trigger: number;
  channel_type: string | null;
  platform_id: string | null;
  content: string;
}

export function getInboundRequestIdentity(db: Database.Database, sequence: number): InboundRequestIdentity | null {
  return (
    (db
      .prepare(
        `SELECT id, seq, kind, trigger, channel_type, platform_id, content FROM messages_in
         WHERE seq = ? AND trigger = 1 AND kind IN ('chat', 'chat-sdk', 'task')
           AND COALESCE(channel_type, '') <> 'agent'`,
      )
      .get(sequence) as InboundRequestIdentity | undefined) ?? null
  );
}

export interface RecoverableLifecycleStatus {
  outboundId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  inReplyTo: string | null;
  platformMessageId: string;
}

/** Recovers a delivered typed lifecycle row after the host's in-memory map was lost. */
export function getRecoverableLifecycleStatus(
  inbound: Database.Database,
  outbound: Database.Database,
  outboundId?: string,
): RecoverableLifecycleStatus | null {
  const deliveredReceipt = inbound.prepare(
    `SELECT platform_message_id, lifecycle_terminal_at
     FROM delivered WHERE message_out_id = ? AND status = 'delivered'`,
  );
  const isDelivered = inbound.prepare("SELECT 1 FROM delivered WHERE message_out_id = ? AND status = 'delivered'");
  const rows = outbound
    .prepare(
      `SELECT id, seq, channel_type, platform_id, thread_id, in_reply_to, content
       FROM messages_out
       WHERE kind = 'status'
         AND CASE WHEN json_valid(content) THEN json_extract(content, '$.reporting.purpose') END = 'liveness'
         ${outboundId ? 'AND id = ?' : ''}
       ORDER BY seq DESC LIMIT 32`,
    )
    .all(...(outboundId ? [outboundId] : [])) as Array<{
    id: string;
    seq: number;
    channel_type: string | null;
    platform_id: string | null;
    thread_id: string | null;
    in_reply_to: string | null;
    content: string;
  }>;
  for (const row of rows) {
    let content: { reporting?: { version?: unknown; purpose?: unknown } };
    try {
      content = JSON.parse(row.content) as typeof content;
    } catch {
      continue;
    }
    if (content.reporting?.version !== 1 || content.reporting?.purpose !== 'liveness') continue;
    if (!row.channel_type || !row.platform_id) continue;
    const deliveryReceipt = deliveredReceipt.get(row.id) as
      | { platform_message_id: string | null; lifecycle_terminal_at: string | null }
      | undefined;
    if (!deliveryReceipt?.platform_message_id) continue;
    if (deliveryReceipt.lifecycle_terminal_at !== null) continue;
    const laterPublicIds = outbound
      .prepare("SELECT id FROM messages_out WHERE seq > ? AND kind IN ('chat','chat-sdk') ORDER BY seq DESC")
      .iterate(row.seq) as Iterable<{ id: string }>;
    for (const { id } of laterPublicIds) if (isDelivered.get(id) !== undefined) return null;
    return {
      outboundId: row.id,
      channelType: row.channel_type,
      platformId: row.platform_id,
      threadId: row.thread_id,
      inReplyTo: row.in_reply_to,
      platformMessageId: deliveryReceipt.platform_message_id,
    };
  }
  return null;
}

/**
 * `null` is load-bearing: `schedule_wake` rejects an anchor that is not in the
 * caller's own session.
 */
export function getInboundRoutingAnchor(db: Database.Database, messageId: string): InboundRoutingAnchor | null {
  return (
    (db
      .prepare('SELECT platform_id, channel_type, thread_id, source_session_id FROM messages_in WHERE id = ?')
      .get(messageId) as InboundRoutingAnchor | undefined) ?? null
  );
}

/** The dedupe window is the caller's; the id prefix is the note's identity. */
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

/**
 * Only the list's WORDING comes from the container-written record; where to
 * edit comes from host-owned evidence (the delivered post and its platform id),
 * so a forged record cannot aim the host at a message the list never had.
 */
export interface TaskListSettlement {
  /**
   * Undelivered task_list rows written at or before the kill, recorded
   * delivered-unsent so none lands over the interrupted form.
   */
  staleRowIds: string[];
  edit: {
    channelType: string;
    platformId: string;
    threadId: string | null;
    platformMessageId: string;
    interruptedText: string;
    interruptedSubtext: string;
  } | null;
}

/**
 * Null when there is nothing to settle: no list, a finished or stale one (its
 * queued rows carry its real final state), or one touched after the kill began.
 */
export function getTaskListSettlement(
  inbound: Database.Database,
  outbound: Database.Database,
  killedAt: string,
): TaskListSettlement | null {
  let record: Record<string, unknown>;
  try {
    const row = outbound.prepare("SELECT value FROM session_state WHERE key = 'task_list'").get() as
      | { value: string }
      | undefined;
    if (!row) return null;
    record = JSON.parse(row.value) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (record.version !== 1 || record.finished === true || record.stale === true) return null;
  // Older runner snapshots lack `touchedAt`; fall back to `updatedAt`.
  const touchedAt = typeof record.touchedAt === 'string' ? record.touchedAt : record.updatedAt;
  if (typeof touchedAt !== 'string' || !(Date.parse(touchedAt) <= Date.parse(killedAt))) return null;
  const delivered = new Set(
    (inbound.prepare('SELECT message_out_id FROM delivered').all() as Array<{ message_out_id: string }>).map(
      (r) => r.message_out_id,
    ),
  );
  // julianday keeps the milliseconds datetime() truncates.
  const staleRowIds = (
    outbound
      .prepare("SELECT id FROM messages_out WHERE kind = 'task_list' AND julianday(timestamp) <= julianday(?)")
      .all(killedAt) as Array<{ id: string }>
  )
    .map((r) => r.id)
    .filter((id) => !delivered.has(id));

  // While a replacement post is still undelivered, the post it replaces is
  // the one on screen.
  let edit: TaskListSettlement['edit'] = null;
  const supersedes = record.supersedes as { outboundId?: unknown } | null | undefined;
  const candidates = [record.postOutboundId, supersedes?.outboundId].filter(
    (id): id is string => typeof id === 'string',
  );
  if (typeof record.interruptedText === 'string' && typeof record.interruptedSubtext === 'string') {
    for (const outboundId of candidates) {
      const post = outbound
        .prepare("SELECT channel_type, platform_id, thread_id FROM messages_out WHERE id = ? AND kind = 'task_list'")
        .get(outboundId) as
        | { channel_type: string | null; platform_id: string | null; thread_id: string | null }
        | undefined;
      const receipt = inbound
        .prepare("SELECT platform_message_id FROM delivered WHERE message_out_id = ? AND status = 'delivered'")
        .get(outboundId) as { platform_message_id: string | null } | undefined;
      if (post?.channel_type && post.platform_id && receipt?.platform_message_id) {
        edit = {
          channelType: post.channel_type,
          platformId: post.platform_id,
          threadId: post.thread_id,
          platformMessageId: receipt.platform_message_id,
          interruptedText: record.interruptedText,
          interruptedSubtext: record.interruptedSubtext,
        };
        break;
      }
    }
  }
  return { staleRowIds, edit };
}
