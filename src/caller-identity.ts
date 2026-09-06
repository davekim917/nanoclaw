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
import { getMessagingGroup } from './db/messaging-groups.js';
import { withExistingMailboxSession } from './session-manager.js';
import type { Session } from './types.js';

/**
 * How many recent rows to scan past. `notifyAgent` writes its replies as
 * `kind='chat'` with `senderId: 'system'`, so a failed attempt's own error
 * notice lands *after* the user's message and would otherwise become the
 * "caller". Skip those and keep looking for a real human.
 */
const SCAN_DEPTH = 20;

/**
 * Resolve the session's most recent inbound chat senderId, namespaced.
 *
 * Opens its own short mailbox session: delivery action handlers now run with
 * no session open (plan §4.5b), so the two callers no longer have a handle to
 * lend. A session with no mailbox has no caller to derive, hence `null`.
 */
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
    // Fall back to the session's messaging_group for channel_type when
    // the message row didn't carry it.
    const mgFallback = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
    const channelType = row.channel_type ?? mgFallback?.channel_type ?? null;
    if (!channelType) continue;
    return `${channelType}:${rawId}`;
  }
  return null;
}
