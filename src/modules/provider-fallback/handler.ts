/**
 * Handler for the container's `provider_unavailable` report.
 *
 * Deliberately narrow: it records an availability window for the reporting
 * session's OWN agent group and restarts that one session. It takes no
 * provider name on faith beyond the group's own configuration — a container
 * cannot mark some other group's provider dead.
 */

import { readContainerConfig } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { isProviderUnavailable, markProviderUnavailable, parseProviderResetAt } from '../../db/provider-health.js';
import { getSession } from '../../db/sessions.js';
import { killContainer, wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { resolveSpawnProvider } from '../../provider-fallback.js';
import type { Session } from '../../types.js';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function handleProviderUnavailable(content: Record<string, unknown>, session: Session): Promise<void> {
  const reportedProvider = str(content.provider);
  if (!reportedProvider) {
    log.warn('provider_unavailable: rejected — missing provider', { sessionId: session.id });
    return;
  }
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  // Only act when the group actually declares a fallback. Without one there
  // is nowhere to route, and recording a window would just delay the honest
  // error the operator needs to see.
  const containerConfig = readContainerConfig(agentGroup.folder);
  const fallbackProvider = containerConfig.providerFallback?.provider;
  if (!fallbackProvider) {
    log.warn('provider_unavailable: no providerFallback declared — leaving the outage visible', {
      sessionId: session.id,
      agentGroup: agentGroup.name,
      provider: reportedProvider,
    });
    return;
  }

  const message = str(content.message) ?? null;
  // 'quota' means a recognized spent account (the reported reset time is
  // meaningful); 'unavailable' is any other unrecovered provider failure,
  // which only earns a short backoff window.
  const errorClass = str(content.classification) === 'quota' ? 'quota' : 'unavailable';
  const until = markProviderUnavailable(agentGroup.id, reportedProvider.toLowerCase(), errorClass, {
    resetAt: errorClass === 'quota' ? parseProviderResetAt(message) : null,
    message,
  });
  log.warn('Provider recorded unavailable — sessions will spawn on the fallback', {
    sessionId: session.id,
    agentGroup: agentGroup.name,
    provider: reportedProvider,
    fallbackProvider,
    unavailableUntil: until,
  });

  // Respawn only when the next spawn would actually land somewhere believed
  // healthy. With every provider in cooldown a respawn would just restart the
  // same failure — the message stays queued and the normal sweep retries it
  // once a window expires.
  const next = resolveSpawnProvider({
    agentGroupId: agentGroup.id,
    sessionProvider: session.agent_provider,
    containerConfig,
  });
  if (isProviderUnavailable(agentGroup.id, next.provider)) {
    log.warn('Provider fallback exhausted too — leaving the session queued rather than respawn-looping', {
      sessionId: session.id,
      agentGroup: agentGroup.name,
      provider: reportedProvider,
      fallbackProvider,
    });
    return;
  }

  // Respawn just this session. The pending message was requeued when the turn
  // failed, so the fresh container answers it on the fallback provider —
  // session-scoped on purpose: one exhausted account must not bounce every
  // live container in the group.
  killContainer(session.id, 'provider quota exhausted — respawning on fallback', async () => {
    const fresh = await getSession(session.id);
    if (fresh) void wakeContainer(fresh);
  });
}
