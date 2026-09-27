/**
 * Owner escalation. The row is kind='system', not 'chat', so the runner's chat
 * budget never mutes it: a muted or capped agent can still ask a human to
 * confirm a suspicious instruction, without opening a general chat bypass.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { registerDeliveryAction, type DeliveryActionResult } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { registerApprovalHandler, requestApproval } from '../approvals/index.js';
import { pickOwnersFirst } from '../approvals/primitive.js';

/**
 * OWNERS first (the reverse of pickApprover): the question is for the owner
 * personally; admins are only a reachability fallback.
 */
function escalationApprovers(agentGroupId: string): Promise<string[]> {
  return pickOwnersFirst(agentGroupId);
}

const MAX_QUESTION_CHARS = 1500;
const ALLOWED_KEYS = new Set(['action', 'question']);

// Abuse valve: an agent that spams escalations pings a human directly.
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
  // Prune the whole map, not just this session's entry, or it grows forever.
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
