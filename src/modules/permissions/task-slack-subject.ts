import { TASKS_SYSTEM_THREAD_ID } from '../../db/sessions.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { readSessionInbound } from '../mailbox/index.js';
import type { Session } from '../../types.js';

/**
 * Which messaging group should the Slack owner-safety gate judge for THIS
 * session?
 *
 * For an ordinary chat session that's simply `session.messaging_group_id`.
 * Task sessions are the problem case: `resolveTaskSession` creates them with
 * `messaging_group_id: null` by construction (one isolated session per task
 * series), so `isOwnerSafeSlackSession` hit its no-messaging-group fail-closed
 * branch on every scheduled fire and the host spawned the container under the
 * `-noslack` OneCLI identity. Symptom: every credentialed Slack call from a
 * scheduled task returned `not_authed` — the proxy had no token to inject —
 * while the same call from an interactive session in an allow-listed channel
 * worked fine.
 *
 * Blanket-trusting task sessions would be the wrong fix: a non-owner in a
 * shared channel can ask the agent to create a task (`ncl tasks`, available at
 * the default `cli_scope: group`), and that task would then read the owner's
 * Slack and post it wherever the task points. That is exactly the escalation
 * the owner-safe boundary exists to stop.
 *
 * So we judge the task by WHERE IT POSTS. A task row carries its delivery
 * routing (`channel_type` + `platform_id`); resolving that back to a
 * messaging group hands the existing gate a real subject and the boundary is
 * enforced unchanged — a task delivering into the owner's DM or an
 * operator-allow-listed group is owner-safe, a task delivering into a shared
 * channel is not and still spawns with Slack withheld.
 *
 * Fail-closed at every ambiguity: no destination recorded, an unresolvable
 * destination, or an unreadable inbound DB all return null, which the gate
 * treats as not-owner-safe.
 */
export async function resolveSlackSafetyMessagingGroupId(session: Session): Promise<string | null> {
  if (session.messaging_group_id) return session.messaging_group_id;

  // Per-series task sessions only (`system:tasks:<seriesId>`). The legacy
  // shared `system:tasks` session holds rows from MULTIPLE series that may
  // point at different destinations, so there is no single subject to judge —
  // it stays fail-closed.
  if (!session.thread_id?.startsWith(`${TASKS_SYSTEM_THREAD_ID}:`)) return null;

  try {
    // Read-only seam: the spawn gate must never provision or migrate the
    // session it is judging (invariant I-4). `undefined` is "no mailbox",
    // which falls through to the same fail-closed null as "no route".
    //
    // Same two options as the self-heal probe, and for the same reason: the
    // replaced `withInboundDb` opened READ-WRITE with a 5s busy_timeout, which
    // is both a longer wait and the mechanism that rolls a hot journal back.
    // Defaulting here makes the spawn gate stricter than the code it replaced,
    // and a gate that cannot resolve its route falls through to the fail-closed
    // null — which is what spawns every scheduled fire under the `-noslack`
    // identity, the regression this site exists to prevent.
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
