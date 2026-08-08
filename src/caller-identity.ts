/**
 * Derive the human caller behind a container-emitted privileged action.
 *
 * Both `modules/permissions/grant.ts` and `modules/channel-config/index.ts`
 * gate on "who sent the message that led to this action". Neither can trust
 * the agent's own claim, so both read the session's latest inbound chat row.
 * This used to be copy-pasted in each; the copies drifted out of sync with
 * the chat-SDK migration (they still filtered `kind='chat'` and so matched
 * nothing but the host's own system notices), which silently denied every
 * legitimate admin. One implementation, both callers.
 */
import type Database from 'better-sqlite3';

import { getMessagingGroup } from './db/messaging-groups.js';
import type { Session } from './types.js';

/**
 * How many recent rows to scan past. `notifyAgent` writes its replies as
 * `kind='chat'` with `senderId: 'system'`, so a failed attempt's own error
 * notice lands *after* the user's message and would otherwise become the
 * "caller". Skip those and keep looking for a real human.
 */
const SCAN_DEPTH = 20;

/** Resolve the session's most recent inbound chat senderId, namespaced. */
export function deriveCallerId(session: Session, inDb: Database.Database): string | null {
  // `chat` / `chat-sdk` only — `task` / `system` / `webhook` rows carry no
  // human sender. Both chat kinds must be listed: the chat-SDK bridge writes
  // `chat-sdk`, legacy adapters write `chat`.
  const rows = inDb
    .prepare(
      `SELECT content, channel_type FROM messages_in
       WHERE kind IN ('chat', 'chat-sdk')
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(SCAN_DEPTH) as Array<{ content?: string; channel_type?: string }>;

  for (const row of rows) {
    if (!row.content) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.content) as Record<string, unknown>;
    } catch {
      continue;
    }
    const rawId = (() => {
      const direct = parsed.senderId;
      if (typeof direct === 'string' && direct.length > 0) return direct;
      const author = parsed.author as { userId?: unknown } | undefined;
      if (typeof author?.userId === 'string' && author.userId.length > 0) return author.userId;
      return null;
    })();
    if (!rawId || rawId === 'system') continue;
    if (rawId.includes(':')) return rawId;
    // Fall back to the session's messaging_group for channel_type when
    // the message row didn't carry it.
    const mgFallback = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
    const channelType = row.channel_type ?? mgFallback?.channel_type ?? null;
    if (!channelType) continue;
    return `${channelType}:${rawId}`;
  }
  return null;
}
