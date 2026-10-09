/**
 * Never cleared at spawn: a primary that failed every first turn then restarted its cooldown at the base window
 * forever. Acts on the reporting session's own group only.
 */

import { markProviderAvailable } from '../../db/provider-health.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

export async function handleProviderTurnCompleted(content: Record<string, unknown>, session: Session): Promise<void> {
  const provider = typeof content.provider === 'string' ? content.provider.trim().toLowerCase() : '';
  const answeredAt = typeof content.completedAt === 'string' ? content.completedAt : '';
  if (!provider || !Number.isFinite(Date.parse(answeredAt))) {
    log.warn('provider_turn_completed: rejected — missing provider or completedAt', { sessionId: session.id });
    return;
  }
  const cleared = await markProviderAvailable(session.agent_group_id, provider, { answeredAt });
  if (cleared) {
    log.info('Provider answered a turn — failure streak cleared', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      provider,
    });
  }
}
