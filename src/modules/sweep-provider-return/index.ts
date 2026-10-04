/**
 * Spawn-time routing alone never brings back a fallback session whose
 * container stays busy enough to outlive every idle reap.
 */
import { execFileSync } from 'child_process';

import { readContainerConfig } from '../../container-config.js';
import {
  containerIdentityFor,
  containerOwnsOutbound,
  killContainer,
  sameContainerIdentity,
  sessionStillActive,
  type ContainerIdentity,
} from '../../container-runner.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import {
  SWEEP_DUTY_INVENTORY,
  asSessionContext,
  registerSweepDuty,
  registerSweepDutySource,
  writeSystemWake,
  type ContainerObservation,
  type SweepSessionContext,
  type WakePlan,
} from '../../host-sweep.js';
import { log } from '../../log.js';
import { resolveProviderName } from '../../db/container-configs.js';
import { isProviderUnavailable } from '../../db/provider-health.js';
import { PROVIDER_FALLBACK_APPLIED_ENV } from '../../provider-fallback.js';
import { requestWake } from '../../request-wake.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';

const PROVIDER_RETURN_ID_PREFIX = 'provider-return-';
/** Synchronous on the host's only event loop: a stalled runtime must cost this attempt, not every session. */
const INSPECT_TIMEOUT_MS = 5_000;

export function isBetweenTurns(
  plan: Pick<WakePlan, 'dueCount' | 'workContinuation'>,
  observed: Pick<ContainerObservation, 'containerState' | 'processingClaimCount'>,
): boolean {
  if (plan.dueCount !== 0 || observed.processingClaimCount !== 0) return false;
  if (observed.containerState?.provider_executing === 1) return false;
  return plan.workContinuation?.phase !== 'running';
}

/**
 * The spawn marker is read back from the container itself so an adopted container (started by an earlier host)
 * is judged the same way as one this host spawned. The comparison runs inside the runtime's template: the
 * container env also carries credentials, which must never reach this process.
 */
function readFallbackMarker(containerName: string): boolean {
  const marker = `${PROVIDER_FALLBACK_APPLIED_ENV}=1`;
  const output = execFileSync(
    CONTAINER_RUNTIME_BIN,
    ['inspect', '--format', `{{range .Config.Env}}{{if eq . "${marker}"}}1{{end}}{{end}}`, containerName],
    { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: INSPECT_TIMEOUT_MS },
  );
  return output.trim() === '1';
}

/** Per session, the last container judged: a container's env cannot change, so each is inspected once. */
const fallbackMarkerBySession = new Map<string, { containerName: string; onFallback: boolean }>();

function evictEndedContainers(): void {
  for (const [sessionId, entry] of fallbackMarkerBySession) {
    if (containerIdentityFor(sessionId)?.containerName !== entry.containerName)
      fallbackMarkerBySession.delete(sessionId);
  }
}

function containerOnFallback(
  sessionId: string,
  containerName: string,
  readMarker: (containerName: string) => boolean,
): boolean | null {
  const cached = fallbackMarkerBySession.get(sessionId);
  if (cached?.containerName === containerName) return cached.onFallback;
  try {
    const onFallback = readMarker(containerName);
    evictEndedContainers();
    fallbackMarkerBySession.set(sessionId, { containerName, onFallback });
    return onFallback;
  } catch (err) {
    log.debug('provider-return: could not read the fallback marker — skipping this tick', { sessionId, err });
    return null;
  }
}

export function _resetProviderReturnForTesting(): void {
  fallbackMarkerBySession.clear();
}

export function _fallbackMarkerCacheSizeForTesting(): number {
  return fallbackMarkerBySession.size;
}

async function noteReturnInThread(session: Session, primaryProvider: string, fallbackProvider: string): Promise<void> {
  const written = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
    if (containerOwnsOutbound(session.id)) return false;
    const routing = mailbox.readSessionRouting();
    if (!routing) return false;
    mailbox.writeOutboundDirect({
      id: `${PROVIDER_RETURN_ID_PREFIX}note-${Date.now()}`,
      kind: 'chat',
      platformId: routing.platform_id,
      channelType: routing.channel_type,
      threadId: routing.thread_id,
      content: JSON.stringify({
        text: `⚙️ ${primaryProvider} is available again — this thread is moving back from ${fallbackProvider}.`,
        _system: { kind: 'provider_fallback_return', provider: primaryProvider, from: fallbackProvider },
      }),
    });
    return true;
  });
  if (!written) log.info('provider-return: thread note skipped', { sessionId: session.id });
}

export async function sweepProviderReturn(
  ctx: SweepSessionContext,
  deps: { readMarker?: (containerName: string) => boolean } = {},
): Promise<boolean> {
  const { session, observed, plan } = ctx;
  if (!observed || !isBetweenTurns(plan, observed)) return false;
  const target: ContainerIdentity | null = observed.containerIdentity;
  if (!target) return false;

  let containerConfig: ReturnType<typeof readContainerConfig>;
  try {
    containerConfig = readContainerConfig(ctx.agentGroupFolder);
  } catch (err) {
    log.debug('provider-return: container config unreadable — skipping', { sessionId: session.id, err });
    return false;
  }
  // Asked directly, not inferred from the spawn resolver: it also picks the primary when the fallback is in cooldown.
  const primaryProvider = resolveProviderName(session.agent_provider, containerConfig.provider);
  if (await isProviderUnavailable(session.agent_group_id, primaryProvider)) return false;
  if (containerOnFallback(session.id, target.containerName, deps.readMarker ?? readFallbackMarker) !== true) {
    return false;
  }

  const fallbackProvider = containerConfig.providerFallback?.provider ?? 'its fallback provider';
  // A replacement registered since the observation is a different container; claim the phase so no later duty acts
  // on the stale observation either.
  if (!sameContainerIdentity(containerIdentityFor(session.id), target)) return true;

  // The plan and observation are snapshots from before the awaits above; the container may have taken a turn since.
  const wrote = await ctx.run((mailbox) => {
    const current = {
      dueCount: mailbox.countDueMessages(),
      workContinuation: mailbox.readWorkContinuation(),
      containerState: mailbox.getContainerState(),
      processingClaimCount: mailbox.getProcessingClaimRows().length,
    };
    if (!isBetweenTurns(current, current)) return false;
    return writeSystemWake(
      mailbox,
      session,
      `${PROVIDER_RETURN_ID_PREFIX}${Date.now()}`,
      `[system] This session ran on ${fallbackProvider} while ${primaryProvider} was unavailable. ${primaryProvider} ` +
        `is available again, so your container was restarted between turns and you are back on ${primaryProvider}. ` +
        `Nothing was in flight, but your conversation memory does not include what happened on ${fallbackProvider}: ` +
        `catch up from this thread and your durable notes before acting. If work was underway, continue it; ` +
        `otherwise stay silent.`,
      { kind: 'provider_fallback_return', provider: primaryProvider, from: fallbackProvider },
    );
  });
  if (!wrote) return false;

  if (!sameContainerIdentity(containerIdentityFor(session.id), target)) return true;
  log.warn('provider-return: primary available again — restarting the fallback container', {
    sessionId: session.id,
    containerName: target.containerName,
    primaryProvider,
    fallbackProvider,
  });
  fallbackMarkerBySession.delete(session.id);
  killContainer(
    session.id,
    'provider fallback ended — returning to the primary',
    async () => {
      await noteReturnInThread(session, primaryProvider, fallbackProvider).catch((err) =>
        log.warn('provider-return: thread note failed', { sessionId: session.id, err }),
      );
      await requestWake(session, 'container-restart', {
        priority: 'interactive',
        guard: sessionStillActive(session.id),
      });
    },
    'respawn_after_stop',
  );
  return true;
}

function registerProviderReturnSweepDuties(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.FORK6,
    phase: 'session:health',
    order: 15,
    // After self-heal (a failing container is healed, not returned), before the idle reaps.
    claims: (ctx) => sweepProviderReturn(ctx),
    run: (ctx) => {
      log.debug('Provider-fallback return handled this tick', { sessionId: asSessionContext(ctx).session.id });
    },
  });
}

registerSweepDutySource('sweep-provider-return', registerProviderReturnSweepDuties);
