/**
 * Handler for the container's `provider_retry_primary` request.
 *
 * The mirror of `handleProviderUnavailable`, and deliberately the weaker of
 * the two: that one RECORDS an availability window, this one only CLEARS the
 * reporting session's own agent group's window and restarts that one session.
 *
 * Why it exists: a session serving from a provider fallback had no way back
 * except the clock. A user who typed `-m <primary model>` got the pin
 * discarded and a line telling them to wait out a window they cannot see —
 * measured 2026-09-21 22:38Z, an operator asked for Opus while the group was
 * parked on Codex and nothing at all happened. The container cannot route
 * itself (the provider is chosen at spawn from `provider_health`, which only
 * the host writes), so the request has to come back here.
 *
 * Clearing resets the failure streak as well as the window. That is the
 * point: the operator is asserting the account works, and if they are wrong
 * the next failing turn re-records the outage from 15m — one turn, not a
 * silent hour on the wrong runtime.
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

  // Ask the same resolver the spawn path uses, so "is this session actually
  // on a fallback right now" is answered by one implementation rather than by
  // re-deriving it from the provider names here. A session already on its
  // primary has nothing to clear — a stale request from a container that was
  // respawned between the write and this read lands here, and must not reset
  // a healthy group's failure streak.
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
  // `markProviderAvailable` is a CONDITIONAL update — it declines when the row
  // changed under it (`src/db/provider-health.ts`), which here means a fresh
  // outage was recorded between the resolve above and this write. Restarting
  // then would spawn straight back onto the fallback and burn a container for
  // nothing, so the request simply does not apply.
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
