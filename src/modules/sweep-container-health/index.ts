/**
 * Container health: provider self-heal (S11, first) and the running-container
 * SLA (S14, fallthrough) on the `session:health` exclusive chain, plus the OOM
 * notice hook inside S14's observe session. Every kill runs with no mailbox
 * session open (the caller's own run/runIn open and close around it).
 */
import fs from 'fs';

import { SELF_HEAL_ENABLED } from '../../config.js';
import { readContainerConfig } from '../../container-config.js';
import { resolveContainerResources } from '../../container-resources.js';
import { withCentralSync } from '../../db/central-lease.js';
import { markProviderUnavailable } from '../../db/provider-health.js';
import { resolveSpawnProvider } from '../../provider-fallback.js';
import { OomKillObserver } from '../../resource-oom-observer.js';
import { heartbeatPath } from '../../session-manager.js';
import {
  containerIdentityFor,
  getContainerSpawnedAt,
  isAdoptedContainer,
  isContainerRunning,
  isContainerSpawning,
  killContainer,
  sameContainerIdentity,
  sessionStillActive,
  containerOwnsOutbound,
  type ContainerIdentity,
} from '../../container-runner.js';
import { requestWake } from '../../request-wake.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { type ForkContainerStateRow as ContainerState, type NanoclawMailboxSession } from '../mailbox/index.js';
import { parseSqliteUtc } from '../mailbox/sqlite-utc.js';
import {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  SPAWN_GRACE_MS,
  SWEEP_DUTY_INVENTORY,
  asSessionContext,
  providerFailedTicks,
  registerSlaObservationHook,
  registerSweepDuty,
  registerSweepDutySource,
  runSlaObservationHooks,
  dutyFailureFields,
  runSweepKillFollowUps,
  writeOutboundWhenStopped,
  writeSystemWake,
  type SessionRunner,
  type StuckDecision,
  type SweepKillSnapshot,
  type SweepSessionContext,
} from '../../host-sweep.js';

const oomKillObserver = new OomKillObserver();

// Failed-provider self-heal. Keys on provider_status because it is the only
// column carrying the provider's own "I am done" verdict (today only Codex
// writes it), not provider_executing, which means "busy". Two consecutive ticks
// are required so a self-recovering transition never costs a kill.

const PROVIDER_HEAL_CONSECUTIVE_TICKS = 2;
export const PROVIDER_HEAL_MAX_ATTEMPTS = 2;
export const PROVIDER_HEAL_COOLDOWN_MS = 10 * 60 * 1000;
const PROVIDER_HEAL_ID_PREFIX = 'provider-heal-';

// The debounce Map's storage lives in host-sweep.ts so the driver's `!alive`
// cleanup stays synchronous; its semantics are this module's.

export type ProviderHealDecision = 'none' | 'wait' | 'heal' | 'park';

export function decideProviderHeal(args: {
  alive: boolean;
  providerStatus: string | null | undefined;
  consecutiveFailedTicks: number;
  priorAttempts: number;
  /** Age of the newest provider-heal marker row, or null when there is none. */
  msSinceLastAttempt: number | null;
}): ProviderHealDecision {
  if (!args.alive || args.providerStatus !== 'failed') return 'none';
  if (args.consecutiveFailedTicks < PROVIDER_HEAL_CONSECUTIVE_TICKS) return 'wait';
  if (args.priorAttempts >= PROVIDER_HEAL_MAX_ATTEMPTS) return 'park';
  if (args.msSinceLastAttempt !== null && args.msSinceLastAttempt < PROVIDER_HEAL_COOLDOWN_MS) return 'wait';
  return 'heal';
}

/** Advance (or reset) the two-tick debounce. Returns the new consecutive count. */
export function observeProviderStatus(sessionId: string, providerStatus: string | null | undefined): number {
  if (providerStatus !== 'failed') {
    providerFailedTicks.delete(sessionId);
    return 0;
  }
  const ticks = (providerFailedTicks.get(sessionId) ?? 0) + 1;
  providerFailedTicks.set(sessionId, ticks);
  return ticks;
}

export function countProviderHealAttemptsSinceRealInbound(mailbox: NanoclawMailboxSession): number {
  return mailbox.countRecoveryAttemptsSinceRealInbound(PROVIDER_HEAL_ID_PREFIX);
}

/** Age of the newest provider-heal marker row, or null when there is none. */
function providerHealLastAttemptAgeMs(mailbox: NanoclawMailboxSession, now: number): number | null {
  const ts = mailbox.latestRecoveryMarkerTimestamp(PROVIDER_HEAL_ID_PREFIX);
  if (!ts) return null;
  const at = parseSqliteUtc(ts);
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

/** Newest provider-heal marker id — the per-episode idempotency key for the parked notice. */
function providerHealLastAttemptId(mailbox: NanoclawMailboxSession): string | null {
  return mailbox.latestRecoveryMarkerId(PROVIDER_HEAL_ID_PREFIX);
}

/**
 * Kill the failed container and queue the accountability wake that respawns it.
 * The wake row is written BEFORE the kill so the attempt is durably counted
 * even if the kill fizzles; on_wake rows are only consumed by a fresh
 * container's first poll, so the dying one cannot steal it.
 */
async function applyProviderHeal(
  mailbox: NanoclawMailboxSession,
  session: Session,
  agentGroupFolder: string,
  containerState: ContainerState | null,
  target: ContainerIdentity | null,
): Promise<'healed' | 'stale-target'> {
  const failureReason = containerState?.provider_failure_reason ?? null;
  let primaryProvider: string | null = null;
  let routedTo: string | null = null;
  try {
    const containerConfig = readContainerConfig(agentGroupFolder);
    const resolveArgs = {
      agentGroupId: session.agent_group_id,
      sessionProvider: session.agent_provider,
      containerConfig,
    };
    primaryProvider = (await resolveSpawnProvider(resolveArgs)).primaryProvider;
    // No declared fallback means nowhere to route; respawn on the primary anyway
    // under the same cap rather than delaying the honest error.
    if (containerConfig.providerFallback?.provider && failureReason) {
      await markProviderUnavailable(session.agent_group_id, primaryProvider, 'unavailable', {
        message: failureReason,
      });
    }
    routedTo = (await resolveSpawnProvider(resolveArgs)).provider;
  } catch (err) {
    log.warn('self-heal: provider routing lookup failed — respawning as configured', { sessionId: session.id, err });
  }

  // Everything since the decision has yielded: if a replacement registered in
  // that window, the marker would be charged to a healthy container and the
  // kill would take it down. Refuse, keeping the attempt budget.
  const registered = containerIdentityFor(session.id);
  if (identityChanged(registered, target)) {
    log.info('self-heal: heal target was replaced before the marker — refusing', {
      class: 'failed-provider',
      sessionId: session.id,
      expected: target?.containerName ?? null,
      registered: registered?.containerName ?? null,
    });
    return 'stale-target';
  }

  const routedNote =
    routedTo && primaryProvider && routedTo !== primaryProvider ? `; this session is now running on ${routedTo}` : '';
  writeSystemWake(
    mailbox,
    session,
    `${PROVIDER_HEAL_ID_PREFIX}${Date.now()}`,
    `[system] Your previous container was restarted because its provider reported a hard failure` +
      `${failureReason ? ` (${failureReason})` : ''}${routedNote}. Anything in flight was lost. ` +
      `Check your durable checkpoints, resume what is safely resumable, and post ONE message accounting for ` +
      `state — done / lost / next. Re-check any work claims in claims/ before resuming a seam. ` +
      `If nothing was in flight, say so in one line.`,
    { kind: 'agent_provider_heal', provider: primaryProvider, routed_to: routedTo, failure_reason: failureReason },
  );

  log.warn('self-heal: restarting container on failed provider', {
    class: 'failed-provider',
    sessionId: session.id,
    provider: primaryProvider,
    routedTo,
    failureReason,
  });
  return 'healed';
}

/**
 * Must run with NO mailbox session open: `killContainer`'s respawn and status
 * cleanup open sessions on this key. Identity-fenced on `target`, because
 * `killContainer` kills whichever container is registered.
 */
function killForProviderHeal(session: Session, target: ContainerIdentity | null): void {
  const registered = containerIdentityFor(session.id);
  if (identityChanged(registered, target)) {
    log.info('self-heal: heal target was replaced before the kill — leaving the live container alone', {
      class: 'failed-provider',
      sessionId: session.id,
      expected: target?.containerName ?? null,
      registered: registered?.containerName ?? null,
    });
    return;
  }
  killContainer(
    session.id,
    'provider-failed-selfheal',
    () => {
      void requestWake(session, 'container-restart', {
        priority: 'interactive',
        guard: sessionStillActive(session.id),
      });
    },
    // A restart: the wake row is durable, so a host that dies before the
    // respawn still owes the session a container.
    'respawn_after_stop',
  );
}

/**
 * Idempotent per heal episode (keyed by the newest marker id); real inbound
 * resets the whole budget.
 */
export function notifyProviderHealParked(
  mailbox: NanoclawMailboxSession,
  _session: Session,
  failureReason: string | null,
  writeMessage: (message: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  }) => void = (message) => mailbox.writeOutboundDirect(message),
): boolean {
  const episode = providerHealLastAttemptId(mailbox) ?? 'unknown';
  const marker = `provider_heal_parked:${episode}`;
  if (mailbox.outboundHasContentLike(marker)) return false;
  const routing = mailbox.readSessionRouting();
  if (!routing) return false;
  writeMessage({
    id: `provider-heal-parked-${episode}`,
    kind: 'chat',
    platformId: routing.platform_id,
    channelType: routing.channel_type,
    threadId: routing.thread_id,
    content: JSON.stringify({
      text:
        `⚠️ My agent provider keeps failing${failureReason ? ` (${failureReason})` : ''} and ${PROVIDER_HEAL_MAX_ATTEMPTS} ` +
        `automatic restarts did not fix it. I have stopped retrying. Reply in this thread and I will try again.`,
      _system: { kind: marker, failure_reason: failureReason },
    }),
  });
  return true;
}

/**
 * Absence is not change: null on either side is handled by the availability
 * checks, and refusing on null would silently disable self-heal wherever an
 * identity is unavailable.
 */
function identityChanged(a: ContainerIdentity | null, b: ContainerIdentity | null): boolean {
  if (!a || !b) return false;
  return !sameContainerIdentity(a, b);
}

/**
 * Every heal input is stale by action time, and the heal's wake row (written
 * before the kill) is counted forever, so a container that already exited
 * must not spend an attempt. Caller holds the central lease.
 */
function providerHealTargetUnavailableReason(sessionId: string): string | null {
  const liveness = sessionStillActive(sessionId)();
  if (liveness !== true) return typeof liveness === 'object' ? liveness.reason : 'session is not wakeable';
  if (!isContainerRunning(sessionId)) return 'container already exited';
  return null;
}

/**
 * Always advances the debounce; acts only when NANOCLAW_SELF_HEAL is armed.
 * Returns true when it claims the exclusive phase.
 */
async function sweepProviderHeal(
  run: SessionRunner,
  session: Session,
  agentGroupFolder: string,
  containerState: ContainerState | null,
  observedContainer: ContainerIdentity | null,
  writeParkedMessage?: Parameters<typeof notifyProviderHealParked>[3],
): Promise<boolean> {
  const providerStatus = containerState?.provider_status ?? null;
  const consecutiveFailedTicks = observeProviderStatus(session.id, providerStatus);
  const budget = await run((mailbox) => ({
    priorAttempts: countProviderHealAttemptsSinceRealInbound(mailbox),
    msSinceLastAttempt: providerHealLastAttemptAgeMs(mailbox, Date.now()),
  }));
  if (!budget) return false;
  const { priorAttempts, msSinceLastAttempt } = budget;
  const decision = decideProviderHeal({
    alive: true,
    providerStatus,
    consecutiveFailedTicks,
    priorAttempts,
    msSinceLastAttempt,
  });
  if (decision === 'none' || decision === 'wait') return false;

  const bounds = {
    class: 'failed-provider',
    sessionId: session.id,
    providerStatus,
    consecutiveFailedTicks,
    priorAttempts,
    maxAttempts: PROVIDER_HEAL_MAX_ATTEMPTS,
    msSinceLastAttempt,
    cooldownMs: PROVIDER_HEAL_COOLDOWN_MS,
    failureReason: containerState?.provider_failure_reason ?? null,
  };
  if (!SELF_HEAL_ENABLED) {
    log.info(`self-heal: would ${decision} failed provider`, bounds);
    return false;
  }

  // A target that is already gone needs no kill and keeps its attempt budget.
  // Still returns TRUE: `false` would let S12/S13/S14 act on the same stale
  // observation. The identity snapshot is taken in the SAME synchronous block
  // so a later replacement is refused rather than charged and killed.
  const { unavailable, registered } = await withCentralSync(
    () => ({
      unavailable: providerHealTargetUnavailableReason(session.id),
      registered: containerIdentityFor(session.id),
    }),
    'provider-heal target check',
  );
  if (unavailable) {
    log.info(`self-heal: ${decision} target already gone — nothing to do this pass`, {
      ...bounds,
      reason: unavailable,
    });
    return true;
  }

  // The decision is valid only for the container it was made about: compare
  // against the identity paired with the observation, not a fresh re-read
  // (which would compare a replacement against itself).
  if (identityChanged(registered, observedContainer)) {
    log.info(`self-heal: ${decision} target was replaced since the health observation — refusing`, {
      ...bounds,
      observed: observedContainer?.containerName ?? null,
      registered: registered?.containerName ?? null,
    });
    return true;
  }
  const target = observedContainer ?? registered;

  if (decision === 'park') {
    // Kill first, then post: outbound.db has one writer and the container must
    // be stopped first. No onExit: parked means no respawn until real inbound.
    log.warn('self-heal: provider heal budget exhausted — parking', bounds);
    // Fenced again because a replacement can land between the checks.
    if (identityChanged(containerIdentityFor(session.id), target)) {
      log.info('self-heal: park target was replaced before the kill — leaving the live container alone', bounds);
      return true;
    }
    killContainer(session.id, 'provider-failed-selfheal-parked');
    try {
      await run((mailbox) =>
        // A respawn in the gap after the kill owns outbound.db; the notice is
        // idempotent, so skipping it costs nothing.
        writeOutboundWhenStopped(session, mailbox, () =>
          notifyProviderHealParked(
            mailbox,
            session,
            containerState?.provider_failure_reason ?? null,
            writeParkedMessage,
          ),
        ),
      );
    } catch (err) {
      log.warn('self-heal: parked notice failed', { sessionId: session.id, err });
    }
    return true;
  }

  // Wake row first (durably counted even if the kill fizzles), then the kill.
  const outcome = await run((mailbox) => applyProviderHeal(mailbox, session, agentGroupFolder, containerState, target));
  if (outcome === undefined) return false;
  // A refused heal still claims the phase, for the same reason as above.
  if (outcome === 'stale-target') return true;
  killForProviderHeal(session, target);
  return true;
}

/** Test-only entry point over an injected session. */
export function _sweepProviderHealForTesting(
  mailbox: NanoclawMailboxSession,
  session: Session,
  agentGroupFolder: string,
  containerState: ContainerState | null,
  writeParkedMessage?: Parameters<typeof notifyProviderHealParked>[3],
  // Defaulted: production pairs this with the observation.
  observedContainer: ContainerIdentity | null = containerIdentityFor(session.id),
): Promise<boolean> {
  return sweepProviderHeal(
    async (action) => action(mailbox),
    session,
    agentGroupFolder,
    containerState,
    observedContainer,
    writeParkedMessage,
  );
}

/** Test-only: clear the debounce between cases. */
export function _resetProviderHealTicksForTesting(): void {
  providerFailedTicks.clear();
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Null means "no forgiveness": a missing or malformed start falls back to the
 * claim rule.
 */
function inFlightToolStartedAtMs(state: ContainerState | null): number | null {
  if (!state?.current_tool || typeof state.tool_started_at !== 'string' || state.tool_started_at === '') return null;
  const startedAt = parseSqliteUtc(state.tool_started_at);
  return Number.isFinite(startedAt) ? startedAt : null;
}

/**
 * True while the provider is mid-turn in a query that has already produced an
 * event: alive but possibly silent for long (the heartbeat moves only per
 * provider event). False for a query that emitted nothing ("hung at the gate")
 * and for runners that don't write `provider_query_event_at`.
 */
function providerQueryIsLive(state: ContainerState | null, heartbeatMtimeMs: number): boolean {
  if (heartbeatMtimeMs === 0 || state?.provider_executing !== 1) return false;
  const eventAt = state.provider_query_event_at;
  return typeof eventAt === 'string' && eventAt !== '' && Number.isFinite(parseSqliteUtc(eventAt));
}

function activeOperationTimeoutMs(state: ContainerState | null): number | null {
  if (!state || (state.current_tool !== 'Bash' && state.current_tool !== 'CodexItem')) return null;
  return typeof state.tool_declared_timeout_ms === 'number' ? state.tool_declared_timeout_ms : null;
}

/** Pure: every filesystem and DB read happens in the caller. */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ message_id: string; status_changed: string }>;
  // Omit or 0 to disable the spawn-grace check.
  spawnedAtMs?: number;
  // For an ADOPTED container `spawnedAtMs` is the adoption instant, not a spawn.
  adopted?: boolean;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims, adopted } = args;
  const spawnedAtMs = args.spawnedAtMs ?? 0;
  const declaredOperationMs = activeOperationTimeoutMs(containerState);

  // No heartbeat file means a fresh container, not an infinitely stale one;
  // a fresh container hung at the gate is the claim rule's job.
  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredOperationMs ?? 0);
    if (heartbeatAge > ceiling) {
      // The heartbeat file outlives container restarts, so a fresh container
      // inherits a stale mtime until its first poll; killing then loops
      // spawn → kill forever. Excluded for ADOPTED containers: their older
      // heartbeat is their own, and a wedged survivor would otherwise buy a
      // fresh grace window on every host restart.
      const inSpawnGrace = spawnedAtMs > 0 && now - spawnedAtMs < SPAWN_GRACE_MS;
      const heartbeatFromPriorContainer = !adopted && spawnedAtMs > 0 && heartbeatMtimeMs < spawnedAtMs;
      if (!(inSpawnGrace && heartbeatFromPriorContainer)) {
        return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
      }
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredOperationMs ?? 0);
  // Claims older than this container's spawn are a prior crash's leftovers,
  // which the fresh one gets SPAWN_GRACE_MS to clean.
  const inGrace = spawnedAtMs > 0 && now - spawnedAtMs < SPAWN_GRACE_MS;
  const toolStartedAtMs = inFlightToolStartedAtMs(containerState);
  const queryIsLive = providerQueryIsLive(containerState, heartbeatMtimeMs);
  for (const claim of claims) {
    const claimedAt = parseSqliteUtc(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    if (inGrace && claimedAt < spawnedAtMs) continue;
    // A tool already running when the message was claimed explains the held
    // claim (the runner holds mid-turn follow-up claims until consumed). Only
    // the claim rule is forgiven; the ceiling above still reaps a wedged tool.
    if (toolStartedAtMs !== null && toolStartedAtMs < claimedAt) continue;
    // Same for a live, event-producing query with no tool (a long think).
    if (queryIsLive) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

/**
 * Post-kill follow-ups hang off the container's own exit: `killContainer` only
 * REQUESTS the stop, and running the chain inline raced the exit (ownership
 * still true, every follow-up skipped for good). The per-write guards in each
 * follow-up still do the real work, since a replacement can take the session
 * mid-chain. Rejections are logged, never thrown into the tick.
 */
const postKillChains = new Set<Promise<void>>();

function trackPostKill(work: Promise<void>, sessionId: string): void {
  const tracked = work
    .catch((err: unknown) => {
      // This chain outlives the tick, so the driver's catch never sees it;
      // report in the same shape post-deploy checks filter on.
      const fields = dutyFailureFields(err);
      if (fields.duty) log.error('Host sweep duty failed', { err, sessionId, ...fields });
      else log.warn('Post-kill follow-up chain failed', { sessionId, err });
    })
    .finally(() => {
      postKillChains.delete(tracked);
    });
  postKillChains.add(tracked);
}

/** Test-only: settle every post-kill chain still running. */
export function _settlePostKillForTesting(): Promise<void> {
  return Promise.all([...postKillChains]).then(() => undefined);
}

/** Test-only: forget every tracked chain, so one case cannot leak into the next. */
export function _resetPostKillForTesting(): void {
  postKillChains.clear();
}

/** `snapshot` is read BEFORE the kill (a reset clears the claims). */
function killThenFollowUp(
  ctx: SweepSessionContext,
  decision: StuckDecision,
  snapshot: SweepKillSnapshot,
  reason: string,
): void {
  const sessionId = ctx.session.id;
  const chain = (): Promise<void> =>
    ctx
      .runIn('session:health:post-kill', (mailbox) => {
        // Early-out only: each follow-up carries its own ownership guard.
        if (containerOwnsOutbound(sessionId)) return;
        return runSweepKillFollowUps(ctx, decision, mailbox, snapshot);
      })
      .then(() => undefined);

  const wasThere = isContainerRunning(sessionId) || isContainerSpawning(sessionId);
  killContainer(sessionId, reason, wasThere ? () => trackPostKill(chain(), sessionId) : undefined);
  // Nothing to kill: no `close` will ever fire, so the chain would be lost.
  // Ownership is already false, so this is the one case that may run inline.
  if (!wasThere) trackPostKill(chain(), sessionId);
}

async function enforceRunningContainerSla(ctx: SweepSessionContext): Promise<void> {
  const session = ctx.session;
  // The decision and the telemetry see the same snapshot; the kill below runs
  // with nothing open.
  const observed = await ctx.runIn('session:health:sla-observe', async (mailbox) => {
    const containerState = mailbox.getContainerState();
    await runSlaObservationHooks(ctx, containerState, mailbox);
    const decision = decideStuckAction({
      now: Date.now(),
      heartbeatMtimeMs: heartbeatMtimeMs(ctx.agentGroupId, session.id),
      containerState,
      claims: mailbox.getProcessingClaimRows(),
      spawnedAtMs: getContainerSpawnedAt(session.id),
      adopted: isAdoptedContainer(session.id),
    });
    // Snapshot BEFORE the kill: the reset clears the claims.
    return {
      containerState,
      decision,
      pendingClaims: decision.action === 'kill-ceiling' ? mailbox.getProcessingClaimRows().length : 0,
      workContinuation: decision.action === 'kill-ceiling' ? mailbox.readWorkContinuation() : null,
    };
  });
  if (!observed) return;
  const { containerState, decision, pendingClaims, workContinuation } = observed;

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    killThenFollowUp(
      ctx,
      decision,
      { reason: 'absolute-ceiling', containerState, pendingClaims, workContinuation },
      'absolute-ceiling',
    );
    return;
  }

  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
  });
  killThenFollowUp(
    ctx,
    decision,
    { reason: 'claim-stuck', containerState, pendingClaims, workContinuation },
    'claim-stuck',
  );
}

/**
 * The kernel kills children inside the cgroup, never PID 1, so nothing surfaces
 * to the agent unless it is told. The row is onWake=0/trigger=0, so it can never
 * wake a dead container; it rides along with the next turn.
 */
function reportContainerOomTelemetry(
  mailbox: NanoclawMailboxSession,
  session: Session,
  agentGroupFolder: string,
  state: ContainerState | null,
): void {
  if (typeof state?.memory_oom_kill_events !== 'number' && typeof state?.memory_max_events !== 'number') return;
  const spawnedAtMs = getContainerSpawnedAt(session.id);
  const decision = oomKillObserver.observe(session.id, spawnedAtMs, {
    oomKillCount: state.memory_oom_kill_events,
    pressureCount: state.memory_max_events,
    now: Date.now(),
  });

  let configuredLimitMb: number | null = null;
  try {
    configuredLimitMb = resolveContainerResources(readContainerConfig(agentGroupFolder).resources).memory.limitMb;
  } catch {
    // Keep OOM diagnostics even if the file was edited into an invalid state mid-run.
  }
  const cgroupMaxMb =
    typeof state.memory_max_bytes === 'number' ? Math.round(state.memory_max_bytes / 1024 / 1024) : null;
  const limitMb = configuredLimitMb ?? cgroupMaxMb;
  const limitText = limitMb === null ? 'its memory limit' : `its ${limitMb} MB memory limit`;

  if (decision.killDelta > 0) {
    log.warn('Container cgroup OOM kill observed', {
      sessionId: session.id,
      agentGroup: agentGroupFolder,
      newOomKills: decision.killDelta,
      oomKillCount: decision.killCount,
      oomEventCount: state.memory_oom_events ?? null,
      memoryPressureEvents: decision.pressureCount,
      notifiedAgent: decision.notifyKills,
      configuredLimitMb,
      cgroupMaxMb,
      peakMb: typeof state.memory_peak_bytes === 'number' ? Math.round(state.memory_peak_bytes / 1024 / 1024) : null,
      currentMb:
        typeof state.memory_current_bytes === 'number' ? Math.round(state.memory_current_bytes / 1024 / 1024) : null,
      telemetryAt: state.memory_telemetry_at ?? null,
    });
  }

  if (decision.notifyKills) {
    const plural = decision.killCount === 1 ? 'process' : 'processes';
    writeSystemWake(
      mailbox,
      session,
      `oom-kill-${spawnedAtMs}-${decision.killCount}`,
      `[system] The Linux kernel has killed ${decision.killCount} ${plural} inside this container for exceeding ` +
        `${limitText}, which is shared by EVERY process here — your agent, MCP servers, browsers, test runners, ` +
        `builds. Your container itself survived, so nothing reported an error to you. The cgroup exposes only a ` +
        `counter, so the names of the killed processes are not available. Symptoms this explains: a command exiting ` +
        `with no output or a bare non-zero status, npm/pnpm installs dying silently, a browser or MCP server ` +
        `disappearing mid-run, test failures that do not reproduce. Remedy: cut in-container parallelism ` +
        `(jest --maxWorkers=2, vitest poolOptions.maxThreads, make -j2), do not run installs or suites concurrently, ` +
        `close browser sessions when done, and write large output to a file instead of buffering it. Do NOT retry ` +
        `the same command unchanged — it will be killed again.`,
      { kind: 'agent_container_oom', oom_kill_count: decision.killCount, memory_limit_mb: limitMb },
      0,
    );
    return;
  }

  if (decision.notifyPressure) {
    log.warn('Container memory pressure without kills', {
      sessionId: session.id,
      agentGroup: agentGroupFolder,
      memoryPressureEvents: decision.pressureCount,
      configuredLimitMb,
      cgroupMaxMb,
    });
    writeSystemWake(
      mailbox,
      session,
      `oom-pressure-${spawnedAtMs}`,
      `[system] This container has hit ${limitText} ${decision.pressureCount} times and had to reclaim memory to ` +
        `stay under it. Nothing has been killed yet — this is the warning before that. The limit is shared by every ` +
        `process here. If you are about to run something memory-heavy (a full test suite, a build, a browser, a ` +
        `large install), reduce its parallelism now rather than after the kernel starts killing processes.`,
      { kind: 'agent_container_memory_pressure', memory_pressure_events: decision.pressureCount },
      0,
    );
  }
}

export { reportContainerOomTelemetry as _reportContainerOomTelemetryForTesting };

/** Test-only: builds the minimum session context the SLA and its follow-ups read. */
export function _enforceRunningContainerSlaForTesting(
  run: SessionRunner,
  session: Session,
  agentGroupId: string,
  agentGroupFolder: string,
): Promise<void> {
  const ctx: SweepSessionContext = {
    now: Date.now(),
    sessions: [session],
    activeContainerSessionIds: new Set<string>(),
    session,
    agentGroupId,
    agentGroupFolder,
    mailbox: null,
    hasOutbound: true,
    alive: true,
    justWoke: false,
    plan: {
      dueCount: 0,
      wakePriority: 'interactive',
      admittedTasks: 0,
      workContinuation: null,
      continuationWakeEligible: false,
      hasOutbound: true,
    },
    observed: null,
    killSnapshot: null,
    run,
    runIn: (_window, action) => run(action),
    reportWoke: () => {},
    reportWake: () => {},
  };
  return enforceRunningContainerSla(ctx);
}

function registerContainerHealthSweepDuties(): void {
  const id = SWEEP_DUTY_INVENTORY;

  registerSweepDuty({
    name: id.S11,
    phase: 'session:health',
    order: 10,
    // Runs first: healing beats reaping as idle or waiting out the ceiling.
    // Returns true only when it acted, per the exclusive-phase `claims()` contract.
    claims: (ctx) =>
      sweepProviderHeal(
        ctx.run,
        ctx.session,
        ctx.agentGroupFolder,
        ctx.observed?.containerState ?? null,
        ctx.observed?.containerIdentity ?? null,
      ),
    run: (ctx) => {
      log.debug('Provider self-heal handled this tick — skipping reap/SLA checks', {
        sessionId: asSessionContext(ctx).session.id,
      });
    },
  });

  registerSweepDuty({
    name: id.S14,
    phase: 'session:health',
    order: 40,
    // The fallthrough: no claims(), so it runs when nothing above claimed.
    run: (ctx) => enforceRunningContainerSla(asSessionContext(ctx)),
  });

  registerSlaObservationHook({
    name: id.S16,
    order: 10,
    // Reached only on SLA fallthrough; must see the decision's containerState snapshot.
    run: (ctx, state, mailbox) => {
      reportContainerOomTelemetry(mailbox, ctx.session, ctx.agentGroupFolder, state);
    },
  });
}

registerSweepDutySource('sweep-container-health', registerContainerHealthSweepDuties);
