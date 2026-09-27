/**
 * The human caller behind a container-emitted privileged action (grant.ts, channel-config): never the agent's own
 * claim, but the sender of the session's latest inbound chat row. One implementation for both callers.
 */
import { getMessagingGroup } from './db/messaging-groups.js';
import { withExistingMailboxSession } from './session-manager.js';
import type { Session } from './types.js';

/** `notifyAgent` writes `kind='chat'` notices as `senderId: 'system'` after the user's message; scan past them. */
const SCAN_DEPTH = 20;

/** Namespaced senderId, or null when the session has no mailbox. Opens its own short mailbox session. */
export async function deriveCallerId(session: Session): Promise<string | null> {
  const rows =
    (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.getRecentInboundChatSenders(SCAN_DEPTH),
    )) ?? [];

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
    const mgFallback = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
    const channelType = row.channel_type ?? mgFallback?.channel_type ?? null;
    if (!channelType) continue;
    return `${channelType}:${rawId}`;
  }
  return null;
}
