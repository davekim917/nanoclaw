/**
 * Clears (never records) the reporting session's own group's provider window
 * and restarts that session, since the container cannot route itself.
 * Clearing also resets the failure streak: if the operator is wrong the next
 * failing turn re-records the outage.
 */

import { readContainerConfig } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { markProviderAvailable } from '../../db/provider-health.js';
import { getSession } from '../../db/sessions.js';
import { killContainer } from '../../container-runner.js';
import { requestWake } from '../../request-wake.js';
import { log } from '../../log.js';
import { resolveSpawnProvider } from '../../provider-fallback.js';
import type { Session } from '../../types.js';

export async function handleProviderRetryPrimary(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;
  const containerConfig = readContainerConfig(agentGroup.folder);

  // Same resolver as the spawn path. A stale request from a container already
  // back on its primary must not reset a healthy group's failure streak.
  const before = await resolveSpawnProvider({
    agentGroupId: agentGroup.id,
    sessionProvider: session.agent_provider,
    containerConfig,
  });
  if (!before.fallbackApplied) return;

  const cleared = await markProviderAvailable(agentGroup.id, before.primaryProvider);
  log.warn('Operator asked for the primary provider — fallback window cleared', {
    sessionId: session.id,
    agentGroup: agentGroup.name,
    primaryProvider: before.primaryProvider,
    fallbackProvider: before.provider,
    requestedModel: typeof content.requestedModel === 'string' ? content.requestedModel : null,
    cleared,
  });
  // Conditional update: declines when a fresh outage was recorded since the
  // resolve, and a restart then would land straight back on the fallback.
  if (!cleared) return;

  killContainer(
    session.id,
    'operator asked for the primary provider — respawning',
    async () => {
      const fresh = await getSession(session.id);
      if (fresh) void requestWake(fresh, 'container-restart');
    },
    'respawn_after_stop',
  );
}
