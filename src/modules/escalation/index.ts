/**
 * Owner-escalation module — the unmutable "was this actually you?" lane.
 *
 * The container agent's `escalate_to_owner` MCP tool writes a kind='system'
 * outbound row with action 'escalate_to_owner'. That row is NOT kind='chat',
 * so the runner's physical chat budget (muteChat / chatLimit) never touches
 * it by construction: a muted watcher or capped standup task can still ask a
 * human to confirm a suspicious instruction, without re-opening a general
 * chat bypass.
 *
 * Delivery reuses the approvals primitive: the question lands as an approval
 * card in the first reachable owner/admin DM (pickApprover chain). Approve
 * relays "confirmed — proceed"; plain reject relays a decline to the agent
 * via the shared finalizeReject path.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { registerDeliveryAction, type DeliveryActionResult } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { registerApprovalHandler, requestApproval } from '../approvals/index.js';
import { pickOwnersFirst } from '../approvals/primitive.js';

/**
 * OWNERS-FIRST candidate order — the reverse of pickApprover. An escalation's
 * question is addressed to the owner personally ("was this actually you?");
 * routing it to a group admin sends the question to someone who cannot
 * answer it (observed live: the card landed in a teammate's DM while the
 * owner saw nothing). Admins remain as reachability fallback only.
 */
function escalationApprovers(agentGroupId: string): Promise<string[]> {
  return pickOwnersFirst(agentGroupId);
}

const MAX_QUESTION_CHARS = 1500;
const ALLOWED_KEYS = new Set(['action', 'question']);

// Abuse valve: an agent that spams escalations is pinging a human directly,
// which is self-limiting socially — but cap it mechanically too.
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 3;
const recentBySession = new Map<string, number[]>();

async function applyOwnerEscalation(content: Record<string, unknown>, session: Session): Promise<DeliveryActionResult> {
  const question = typeof content.question === 'string' ? content.question.trim() : '';
  const unknownKeys = Object.keys(content).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0 || question === '' || question.length > MAX_QUESTION_CHARS) {
    log.warn('escalate_to_owner rejected: invalid payload', {
      sessionId: session.id,
      questionChars: question.length,
      unknownKeys,
    });
    throw new Error('escalate_to_owner rejected: invalid payload');
  }

  const now = Date.now();
  // Prune the whole map, not just this session's entry — long-lived hosts
  // otherwise accumulate one array per session that ever escalated.
  for (const [key, stamps] of recentBySession) {
    const live = stamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    if (live.length === 0) recentBySession.delete(key);
    else if (live.length !== stamps.length) recentBySession.set(key, live);
  }
  const recent = recentBySession.get(session.id) ?? [];
  if (recent.length >= RATE_LIMIT_MAX) {
    log.warn('escalate_to_owner rate-limited', { sessionId: session.id, recent: recent.length });
    throw new Error(`escalate_to_owner rejected: rate limit (${RATE_LIMIT_MAX}/hour per session)`);
  }
  recent.push(now);
  recentBySession.set(session.id, recent);

  const agentName = (await getAgentGroup(session.agent_group_id))?.name ?? session.agent_group_id;
  const delivered = await requestApproval({
    session,
    agentName,
    action: 'owner_escalation',
    payload: { question },
    title: `🚩 Escalation from ${agentName}`,
    question,
    deliveryTarget: 'admin',
    approvers: await escalationApprovers(session.agent_group_id),
  });
  if (!delivered) {
    // requestApproval already notified the agent about the specific failure.
    log.warn('escalate_to_owner: could not reach an approver', { sessionId: session.id });
  }
  return undefined;
}

registerApprovalHandler('owner_escalation', async ({ notify, userId }) => {
  await notify(`Escalation answered by ${userId || 'an admin'}: CONFIRMED — proceed.`);
});

registerDeliveryAction(
  'escalate_to_owner',
  applyOwnerEscalation,
  unguarded(
    'question-only DM to the owner/admin approval chain via the approvals primitive; no state change, rate-limited per session',
  ),
);
