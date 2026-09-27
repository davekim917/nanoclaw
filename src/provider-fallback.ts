/**
 * Spawn-time provider selection: while the primary is in a recorded unavailability window and the group declares
 * `providerFallback`, spawn the fallback; the window expires on its own. Applied AFTER normal resolution
 * (`session.agent_provider` shadows container.json), and carried as env (`NANOCLAW_PROVIDER_OVERRIDE`,
 * `NANOCLAW_MODEL_OVERRIDE`) because the container reads its provider from a container.json the host does not
 * rewrite per spawn.
 */
import type { ContainerConfig } from './container-config.js';
import { isProviderUnavailable } from './db/provider-health.js';
import { resolveProviderName } from './db/container-configs.js';

export interface SpawnProviderDecision {
  provider: string;
  model?: string;
  effort?: string;
  primaryProvider: string;
  fallbackApplied: boolean;
}

/**
 * Identity, filesystem, tools, tone and instructions stay with the group; every model/effort layer belongs to the
 * source provider and is removed so the target resolves its own defaults.
 */
export function applyProviderFallbackRuntime(
  containerConfig: Pick<ContainerConfig, 'provider' | 'model' | 'effort' | 'defaultModel' | 'defaultEffort'>,
  decision: Pick<SpawnProviderDecision, 'provider' | 'model' | 'effort'>,
): void {
  containerConfig.provider = decision.provider;
  containerConfig.model = decision.model;
  containerConfig.effort = decision.effort;
  containerConfig.defaultModel = undefined;
  containerConfig.defaultEffort = undefined;
}

/** A marker separate from the provider: the target can equal the file provider when the session's differs. */
export function providerFallbackRuntimeEnv(
  decision: Pick<SpawnProviderDecision, 'provider' | 'model'>,
): Record<string, string> {
  return {
    NANOCLAW_PROVIDER_OVERRIDE: decision.provider,
    NANOCLAW_PROVIDER_FALLBACK_APPLIED: '1',
    ...(decision.model ? { NANOCLAW_MODEL_OVERRIDE: decision.model } : {}),
  };
}

export async function resolveSpawnProvider(options: {
  agentGroupId: string;
  sessionProvider: string | null | undefined;
  containerConfig: Pick<ContainerConfig, 'provider' | 'model' | 'effort' | 'providerFallback'>;
  nowMs?: number;
}): Promise<SpawnProviderDecision> {
  const { agentGroupId, sessionProvider, containerConfig, nowMs } = options;
  const primaryProvider = resolveProviderName(sessionProvider ?? null, containerConfig.provider);
  const fallback = containerConfig.providerFallback;

  // No declaration: the outage stays loud rather than silently changing which model answers.
  if (!fallback?.provider) {
    return { provider: primaryProvider, primaryProvider, fallbackApplied: false };
  }
  const fallbackProvider = fallback.provider.toLowerCase();
  // A fallback pointing at the primary is a config mistake, not a fallback.
  if (fallbackProvider === primaryProvider) {
    return { provider: primaryProvider, primaryProvider, fallbackApplied: false };
  }
  if (!(await isProviderUnavailable(agentGroupId, primaryProvider, { nowMs }))) {
    return { provider: primaryProvider, primaryProvider, fallbackApplied: false };
  }
  // Never onto a fallback in cooldown: failing on the primary beats thrashing between dead providers.
  if (await isProviderUnavailable(agentGroupId, fallbackProvider, { nowMs })) {
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
