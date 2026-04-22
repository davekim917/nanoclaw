/**
 * Agent-to-agent message routing.
 *
 * Outbound messages with `channel_type === 'agent'` target another agent
 * group rather than a channel. Permission is enforced via `agent_destinations` —
 * the source agent must have a row for the target. Content is copied verbatim;
 * the target's formatter looks up the source agent in its own local map to
 * display a name.
 *
 * Self-messages are always allowed (used for system notes injected back into
 * an agent's own session, e.g. post-approval follow-up prompts).
 *
 * Core delivery.ts dispatches into this via a dynamic import guarded by a
 * `channel_type === 'agent'` check. When the module is absent the check in
 * core throws with a "module not installed" message so retry → mark failed.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { hasDestination } from './db/agent-destinations.js';

export interface RoutableAgentMessage {
  id: string;
  platform_id: string | null;
  content: string;
}

export async function routeAgentMessage(msg: RoutableAgentMessage, session: Session): Promise<void> {
  const targetAgentGroupId = msg.platform_id;
  if (!targetAgentGroupId) {
    throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
  }
  if (
    targetAgentGroupId !== session.agent_group_id &&
    !hasDestination(session.agent_group_id, 'agent', targetAgentGroupId)
  ) {
    throw new Error(
      `unauthorized agent-to-agent: ${session.agent_group_id} has no destination for ${targetAgentGroupId}`,
    );
  }
  if (!getAgentGroup(targetAgentGroupId)) {
    throw new Error(`target agent group ${targetAgentGroupId} not found for message ${msg.id}`);
  }
  const { session: targetSession } = resolveSession(targetAgentGroupId, null, null, 'agent-shared');
  writeSessionMessage(targetAgentGroupId, targetSession.id, {
    id: `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: msg.content,
  });
  log.info('Agent message routed', {
    from: session.agent_group_id,
    to: targetAgentGroupId,
    targetSession: targetSession.id,
  });
  const fresh = getSession(targetSession.id);
  if (fresh) await wakeContainer(fresh);
}
