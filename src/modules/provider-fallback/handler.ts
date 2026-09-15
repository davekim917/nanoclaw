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
import { killContainer } from '../../container-runner.js';
import { requestWake } from '../../request-wake.js';
import { log } from '../../log.js';
import { resolveSpawnProvider } from '../../provider-fallback.js';
import type { Session } from '../../types.js';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Bound for the coarse Codex `systemError` park (plan item 0.7). That wedge
 * carries no structured cause — it may be a spent account, a dead thread, or
 * an app-server bug — so the group leaves Codex for at most an hour rather
 * than riding the failure-streak backoff out to its 6h cap.
 */
export const SYSTEM_ERROR_PARK_MAX_MS = 60 * 60_000;

/**
 * A container-reported MEASURED reset (ISO), accepted only when it parses and
 * lies in the future; anything else falls back to prose parsing / backoff,
 * the safe direction. The container is trusted only about its own group's
 * provider, and only to shorten or lengthen a window `markProviderUnavailable`
 * still clamps.
 */
export function measuredResetAt(value: unknown, nowMs = Date.now()): string | null {
  const raw = str(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed <= nowMs) return null;
  return new Date(parsed).toISOString();
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
  // Read → park (Codex, plan item 0.7): the container's pre-turn rate-limit
  // park arrives here as classification 'quota' with `resetAt` = the
  // exhausted window's own reset (container/agent-runner/src/providers/
  // codex.ts `parkedTurnEvents` → poll-loop.ts `reportProviderUnavailable`).
  // A measured reset is honoured as the window end; a reset parsed out of
  // error prose stays an upper bound on the backoff schedule.
  const measured = errorClass === 'quota' ? measuredResetAt(content.resetAt) : null;
  const systemError = str(content.reason) === 'system_error';
  const until = await markProviderUnavailable(agentGroup.id, reportedProvider.toLowerCase(), errorClass, {
    resetAt: measured ?? (errorClass === 'quota' ? parseProviderResetAt(message) : null),
    honorResetAt: measured !== null,
    maxCooldownMs: systemError ? SYSTEM_ERROR_PARK_MAX_MS : undefined,
    message,
  });
  log.warn('Provider recorded unavailable — sessions will spawn on the fallback', {
    sessionId: session.id,
    agentGroup: agentGroup.name,
    provider: reportedProvider,
    fallbackProvider,
    unavailableUntil: until,
    measuredResetAt: measured,
    reason: str(content.reason) ?? null,
  });

  // Respawn only when the next spawn would actually land somewhere believed
  // healthy. With every provider in cooldown a respawn would just restart the
  // same failure — the message stays queued and the normal sweep retries it
  // once a window expires.
  const next = await resolveSpawnProvider({
    agentGroupId: agentGroup.id,
    sessionProvider: session.agent_provider,
    containerConfig,
  });
  if (await isProviderUnavailable(agentGroup.id, next.provider)) {
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
  killContainer(
    session.id,
    'provider quota exhausted — respawning on fallback',
    async () => {
      const fresh = await getSession(session.id);
      if (fresh) void requestWake(fresh, 'container-restart');
    },
    // A real respawn, so a host that dies between the kill and the wake still
    // owes it. The boot respawn re-resolves the provider, so the session comes
    // back on the fallback either way.
    'respawn_after_stop',
  );
}
