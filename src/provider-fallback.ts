/**
 * Spawn-time provider selection.
 *
 * When a group's primary provider is inside a recorded unavailability window
 * (see `db/provider-health.ts`) and the group declares a `providerFallback`,
 * the spawn routes to the fallback instead of waking a container that can only
 * fail. The window expires on its own, so the next spawn returns to the
 * primary with no cron, probe, or operator action.
 *
 * Two rules this must respect, both learned the hard way:
 *
 * 1. `session.agent_provider` shadows `container.json` in
 *    `resolveProviderName`, so the fallback has to be applied AFTER normal
 *    resolution — overriding the file alone leaves a stamped session on the
 *    dead provider.
 * 2. The container reads its own provider from the bind-mounted
 *    `container.json`, which the host does not rewrite per spawn. The
 *    decision must therefore travel as env (`NANOCLAW_PROVIDER_OVERRIDE`,
 *    `NANOCLAW_MODEL_OVERRIDE`), mirroring how the assistant name already
 *    beats the file.
 */
import type { ContainerConfig } from './container-config.js';
import { isProviderUnavailable } from './db/provider-health.js';
import { resolveProviderName } from './db/container-configs.js';

export interface SpawnProviderDecision {
  /** Provider the container should actually run. */
  provider: string;
  /** Model/effort to force, when the fallback declares them. */
  model?: string;
  effort?: string;
  /** The provider that would have run had it been available. */
  primaryProvider: string;
  fallbackApplied: boolean;
}

export function resolveSpawnProvider(options: {
  agentGroupId: string;
  sessionProvider: string | null | undefined;
  containerConfig: Pick<ContainerConfig, 'provider' | 'model' | 'effort' | 'providerFallback'>;
  nowMs?: number;
}): SpawnProviderDecision {
  const { agentGroupId, sessionProvider, containerConfig, nowMs } = options;
  const primaryProvider = resolveProviderName(sessionProvider ?? null, containerConfig.provider);
  const fallback = containerConfig.providerFallback;

  // No declaration means an outage stays loud. Silently rerouting a group
  // that never asked for it would change which model answers a user with no
  // trace anywhere.
  if (!fallback?.provider) {
    return { provider: primaryProvider, primaryProvider, fallbackApplied: false };
  }
  const fallbackProvider = fallback.provider.toLowerCase();
  // A fallback pointing at the primary is a config mistake, not a fallback.
  if (fallbackProvider === primaryProvider) {
    return { provider: primaryProvider, primaryProvider, fallbackApplied: false };
  }
  if (!isProviderUnavailable(agentGroupId, primaryProvider, { nowMs })) {
    return { provider: primaryProvider, primaryProvider, fallbackApplied: false };
  }
  // Never bounce onto a fallback that is itself in cooldown — running the
  // primary and failing is more honest than thrashing between dead providers.
  if (isProviderUnavailable(agentGroupId, fallbackProvider, { nowMs })) {
    return { provider: primaryProvider, primaryProvider, fallbackApplied: false };
  }

  return {
    provider: fallbackProvider,
    model: fallback.model,
    effort: fallback.effort,
    primaryProvider,
    fallbackApplied: true,
  };
}
