/**
 * Records an availability window for the reporting session's OWN agent group
 * only and restarts that one session: a container cannot mark another group's
 * provider dead.
 */

import { readContainerConfig } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { isProviderUnavailable, markProviderUnavailable, parseProviderResetAt } from '../../db/provider-health.js';
import { getSession } from '../../db/sessions.js';
import { containerIdentityFor, containerStartedAtMs, killContainer } from '../../container-runner.js';
import { requestWake } from '../../request-wake.js';
import { log } from '../../log.js';
import { resolveSpawnProvider } from '../../provider-fallback.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { PROVIDER_UNAVAILABLE_KILL } from '../sweep-continuation/kill-state.js';
import { followUpKill } from '../sweep-continuation/reap-respawn.js';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Codex `systemError` carries no structured cause, so the group leaves Codex
 * for at most an hour rather than riding the backoff to its 6h cap.
 */
export const SYSTEM_ERROR_PARK_MAX_MS = 60 * 60_000;

/**
 * Accepted only when it parses and lies in the future; otherwise fall back to
 * prose parsing/backoff. `markProviderUnavailable` still clamps the window.
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

  // No declared fallback: nowhere to route, and a window would only delay the
  // honest error.
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
  // 'quota' = a recognized spent account (its reset time is meaningful);
  // 'unavailable' earns only a short backoff. A measured reset is honoured as
  // the window end; one parsed from error prose is only an upper bound.
  const errorClass = str(content.classification) === 'quota' ? 'quota' : 'unavailable';
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

  // With every provider in cooldown a respawn just repeats the failure; the
  // message stays queued for the sweep.
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

  // Just this session: one exhausted account must not bounce every live
  // container in the group. The requeued message is answered on the fallback.
  const startedAtMs = containerStartedAtMs(containerIdentityFor(session.id)?.containerName ?? null);
  killContainer(
    session.id,
    PROVIDER_UNAVAILABLE_KILL,
    async () => {
      // Before the wake: once the replacement is spawning it owns the session
      // and the follow-up row would be refused.
      await followUpStrandedTurn(session, startedAtMs);
      const fresh = await getSession(session.id);
      if (fresh) void requestWake(fresh, 'container-restart');
    },
    // A real respawn, so a host that dies between kill and wake still owes it.
    'respawn_after_stop',
  );
}

/** Never throws: the respawn must follow whatever happens here. */
async function followUpStrandedTurn(session: Session, startedAtMs: number | null): Promise<void> {
  try {
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      followUpKill(mailbox, session, startedAtMs, { reason: PROVIDER_UNAVAILABLE_KILL }),
    );
  } catch (err) {
    log.warn('provider_unavailable: kill follow-up failed', { sessionId: session.id, err });
  }
}
