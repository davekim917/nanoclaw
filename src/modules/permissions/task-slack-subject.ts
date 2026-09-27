import { TASKS_SYSTEM_THREAD_ID } from '../../db/sessions.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { readSessionInbound } from '../mailbox/index.js';
import type { Session } from '../../types.js';

/**
 * Which messaging group the Slack owner-safety gate judges for this session.
 * Task sessions have no messaging group, and blanket-trusting them would let a
 * non-owner create a task that reads the owner's Slack, so a task is judged by
 * WHERE IT POSTS. Every ambiguity returns null (not owner-safe).
 */
export async function resolveSlackSafetyMessagingGroupId(session: Session): Promise<string | null> {
  if (session.messaging_group_id) return session.messaging_group_id;

  // Per-series task sessions only: the shared `system:tasks` session mixes
  // destinations, so it has no single subject and stays fail-closed.
  if (!session.thread_id?.startsWith(`${TASKS_SYSTEM_THREAD_ID}:`)) return null;

  try {
    // Read-only: the spawn gate must never provision or migrate the session it
    // judges. The 5s busy timeout and journal recovery are required: without
    // them an unresolved route spawns every scheduled fire under `-noslack`.
    const row = readSessionInbound(
      { agentGroupId: session.agent_group_id, sessionId: session.id },
      (mailbox) => mailbox.getLatestTaskDeliveryRoute(),
      { busyTimeoutMs: 5000, recoverJournal: true },
    );

    if (!row?.channel_type) return null;
    return (await getMessagingGroupByPlatform(row.channel_type, row.platform_id))?.id ?? null;
  } catch (err) {
    log.warn('Slack safety subject lookup failed for task session', { sessionId: session.id, err });
    return null;
  }
}
