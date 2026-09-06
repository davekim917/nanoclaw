/**
 * Container health — S2-PR10 (docs/specs/upstream-host-sweep-seam/plan.md).
 *
 * Owns the `session:health` chain's first and last branches (S11 provider
 * self-heal, S14 running-container SLA) plus the SLA observation hook that
 * rides inside S14's own observe session (S16 OOM / memory-pressure notice).
 * S12/S13 (the two idle reaps, S2-PR3's family) stay registered in
 * `host-sweep.ts` at orders 20/30 in between — the exclusive chain's order
 * is heal (10) → idle-task-reap (20) → idle-chat-reap (30) → SLA (40,
 * fallthrough), and this module owns only the two ends of it.
 *
 * Bodies below are moved from `src/host-sweep.ts` UNCHANGED (same statements,
 * log strings, thresholds). Every kill here (`provider-failed-selfheal`,
 * `-parked`, `killForProviderHeal`'s own call, `absolute-ceiling`,
 * `claim-stuck`) runs at mailbox depth 0 — the caller's own `run`/`runIn`
 * open and close a session around it, never held across it (invariant I-3).
 */
import fs from 'fs';

import { SELF_HEAL_ENABLED } from '../../config.js';
import { readContainerConfig } from '../../container-config.js';
import { resolveContainerResources } from '../../container-resources.js';
import { markProviderUnavailable } from '../../db/provider-health.js';
import { resolveSpawnProvider } from '../../provider-fallback.js';
import { OomKillObserver } from '../../resource-oom-observer.js';
import { heartbeatPath } from '../../session-manager.js';
import {
  getContainerSpawnedAt,
  isAdoptedContainer,
  isContainerRunning,
  isContainerSpawning,
  killContainer,
  sessionStillActive,
  containerOwnsOutbound,
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

// ─────────────────────────────────────────────────────────────────────────────
// Failed-provider self-heal (S11).
//
// A container whose provider has given up writes provider_status='failed' and
// then sits alive-but-useless until a human notices. Nothing reaps it: it holds
// a claim so the idle reapers pass, and the absolute ceiling only fires after
// 30 more silent minutes and then leaves the session dead until the next ping.
//
// Detection keys on provider_status because it is the only column carrying the
// provider's own "I am done" verdict. Today only the Codex provider ever writes
// it (container/agent-runner/src/providers/codex.ts) — Claude and OpenCode
// never do — so this heals Codex sessions only until they follow. It is
// deliberately NOT built on provider_executing: that flag says "busy", not
// "given up", and a wedged provider can be either.
//
// Two consecutive sweep ticks are required so a transition the container
// recovers from on its own never costs it a kill.
// ─────────────────────────────────────────────────────────────────────────────

/** Consecutive `failed` observations required before acting. */
export const PROVIDER_HEAL_CONSECUTIVE_TICKS = 2;
export const PROVIDER_HEAL_MAX_ATTEMPTS = 2;
export const PROVIDER_HEAL_COOLDOWN_MS = 10 * 60 * 1000;
const PROVIDER_HEAL_ID_PREFIX = 'provider-heal-';

// sessionId → consecutive ticks observed with provider_status === 'failed'.
// The Map itself is a driver-owned export of host-sweep.ts (imported above) —
// its storage has to live there so the driver's own `!alive` cleanup can stay
// synchronous (see the export's doc comment). The SEMANTICS below — the
// two-tick debounce and its reset rules — are entirely this module's.

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
export function providerHealLastAttemptAgeMs(mailbox: NanoclawMailboxSession, now: number): number | null {
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
function applyProviderHeal(
  mailbox: NanoclawMailboxSession,
  session: Session,
  agentGroupFolder: string,
  containerState: ContainerState | null,
): void {
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
    primaryProvider = resolveSpawnProvider(resolveArgs).primaryProvider;
    // A group with no declared fallback has nowhere to route, so recording a
    // health window would only delay the honest error an operator needs to see.
    // Owner-approved: respawn on the primary anyway, under the same cap.
    if (containerConfig.providerFallback?.provider && failureReason) {
      markProviderUnavailable(session.agent_group_id, primaryProvider, 'unavailable', { message: failureReason });
    }
    routedTo = resolveSpawnProvider(resolveArgs).provider;
  } catch (err) {
    log.warn('self-heal: provider routing lookup failed — respawning as configured', { sessionId: session.id, err });
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
}

/**
 * The kill half of a provider heal.
 *
 * Split out of `applyProviderHeal` so it can run with NO mailbox session open.
 * `killContainer`'s `onExit` respawns the session, and its status-cleanup hop
 * through `delivery.ts` opens a session of its own — both on THIS key. Running
 * either from inside a session would trip the same-key nesting guard
 * (invariant I-3); the wake row is already durable by the time we get here,
 * which is the ordering the heal has always relied on.
 */
function killForProviderHeal(session: Session): void {
  killContainer(
    session.id,
    'provider-failed-selfheal',
    () => {
      void requestWake(session, 'container-restart', {
        priority: 'interactive',
        guard: sessionStillActive(session.id),
      });
    },
    // The heal is a restart: the wake row is already durable, so a host that
    // dies before the respawn still owes the session a container.
    'respawn_after_stop',
  );
}

/**
 * One visible notice when the attempt budget is spent, shaped like
 * notifyContinuationParked. Idempotent per heal episode: the key is the newest
 * marker row's id, which only changes when a fresh heal runs, and real inbound
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
 * Why this session must not be healed right now, or `null` when it may be
 * (fork issue #343).
 *
 * Every input to the decision above is stale by the time it is acted on.
 * `containerState` comes from the driver's observe read (W3), the `alive`
 * verdict that admitted this session to the health phase was taken before
 * that, and this function then awaits a mailbox open of its own for the
 * attempt budget. A container that self-exits anywhere in that window is
 * already gone by the kill: `killContainer` is a harmless no-op, but the
 * accountability wake row the heal branch writes FIRST is counted forever by
 * `countProviderHealAttemptsSinceRealInbound`, so the next genuine failure
 * starts one attempt down and parks a heal early. The park branch's kill rests
 * on the same stale read.
 *
 * Checked here, ahead of both branches, rather than immediately around
 * `killContainer`: the attempt is what must not be spent, and the attempt is
 * written before the kill.
 *
 * Synchronous and cheap — one central-DB row and the container-state lookup
 * the host already keeps in memory — so it adds no suspension point of its own
 * to widen the window it closes.
 */
function providerHealTargetUnavailableReason(sessionId: string): string | null {
  const liveness = sessionStillActive(sessionId)();
  if (liveness !== true) return typeof liveness === 'object' ? liveness.reason : 'session is not wakeable';
  if (!isContainerRunning(sessionId)) return 'container already exited';
  return null;
}

/**
 * Detection + action for one alive session. Always advances the debounce;
 * acts only when NANOCLAW_SELF_HEAL is armed. Returns true when the container
 * was killed, so the caller skips the reap/SLA checks for this tick.
 *
 * `containerState` is read by the caller (it needs it for the reap decisions
 * too); everything else this needs is read inside its own short session, and
 * every kill happens between two of them.
 */
async function sweepProviderHeal(
  run: SessionRunner,
  session: Session,
  agentGroupFolder: string,
  containerState: ContainerState | null,
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

  // #343: nothing below may act on a target that is already gone. Skipping
  // costs nothing — a container that exited on its own needs no kill, and the
  // session keeps its full attempt budget for a failure that is still real.
  //
  // Returns TRUE, and the distinction matters more than the saving does. This
  // is an exclusive phase's first claimant: `false` means "not mine, try the
  // next one", and S12/S13/S14 would then act on the SAME stale observation
  // that brought us here — reaping, killing for the ceiling or a stuck claim,
  // resetting claims, writing OOM telemetry and an accountability wake, all
  // against a container that no longer exists. Before this guard existed the
  // heal branch reached `killContainer` (a no-op on a dead container), spent an
  // attempt and returned `true`, so the chain stopped. Claiming the slot keeps
  // that behaviour exactly and drops only the wasted attempt, which is the
  // whole point of the fix.
  const unavailable = providerHealTargetUnavailableReason(session.id);
  if (unavailable) {
    log.info(`self-heal: ${decision} target already gone — nothing to do this pass`, {
      ...bounds,
      reason: unavailable,
    });
    return true;
  }

  if (decision === 'park') {
    // Kill first, then post: outbound.db has exactly one writer, and the
    // container must be confirmed stopped before the host writes to it (same
    // ordering as the kill-ceiling notice). No onExit — parked means no
    // respawn until real inbound resets the budget.
    log.warn('self-heal: provider heal budget exhausted — parking', bounds);
    killContainer(session.id, 'provider-failed-selfheal-parked');
    try {
      await run((mailbox) =>
        // Same yield boundary as the kill-ceiling notice: the park kill is
        // above, this session opened after it, and a respawn in that gap owns
        // outbound.db. The notice is one-per-episode and idempotent, so
        // skipping it costs nothing a later tick cannot redo. Mailbox seam
        // PR 5b (#332) made `writeOutboundWhenStopped` the single guarded
        // body for every host-side outbound write; it travels with this one.
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

  // Wake row first (durably counted even if the kill fizzles), session closed,
  // then the kill and its respawn.
  const wrote = await run((mailbox) => {
    applyProviderHeal(mailbox, session, agentGroupFolder, containerState);
    return true;
  });
  if (!wrote) return false;
  killForProviderHeal(session);
  return true;
}

/** Test-only entry point over an injected session. */
export function _sweepProviderHealForTesting(
  mailbox: NanoclawMailboxSession,
  session: Session,
  agentGroupFolder: string,
  containerState: ContainerState | null,
  writeParkedMessage?: Parameters<typeof notifyProviderHealParked>[3],
): Promise<boolean> {
  return sweepProviderHeal(
    async (action) => action(mailbox),
    session,
    agentGroupFolder,
    containerState,
    writeParkedMessage,
  );
}

/** Test-only: clear the debounce between cases. */
export function _resetProviderHealTicksForTesting(): void {
  providerFailedTicks.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Running-container SLA (S14): absolute ceiling + per-claim stuck rules.
// ─────────────────────────────────────────────────────────────────────────────

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

function activeOperationTimeoutMs(state: ContainerState | null): number | null {
  if (!state || (state.current_tool !== 'Bash' && state.current_tool !== 'CodexItem')) return null;
  return typeof state.tool_declared_timeout_ms === 'number' ? state.tool_declared_timeout_ms : null;
}

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem + DB reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ message_id: string; status_changed: string }>;
  // Wall-clock when the host spawned the current container. Optional;
  // omit (or pass 0) to disable the grace check. Used to gate the
  // kill-claim path so a fresh container has SPAWN_GRACE_MS to clean its
  // own pre-existing claims before being killed for them.
  spawnedAtMs?: number;
  // True when this host ADOPTED the container from a previous host rather
  // than spawning it. `spawnedAtMs` is then the adoption instant, not a
  // spawn, so the "heartbeat predates the spawn" test below stops meaning
  // what it means for a fresh container.
  adopted?: boolean;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims, adopted } = args;
  const spawnedAtMs = args.spawnedAtMs ?? 0;
  const declaredOperationMs = activeOperationTimeoutMs(containerState);

  // Ceiling check only applies when we have an actual heartbeat timestamp.
  // A freshly-spawned container hasn't had any SDK activity yet so no
  // heartbeat file exists — if we treated that as infinitely stale we'd
  // kill every container within seconds of spawn. Genuinely-dead containers
  // that never wrote a heartbeat are caught by the separate "container
  // process not running" cleanup path, not here. If a fresh container is
  // hanging at the gate (claimed a message but never did anything) the
  // claim-stuck check below handles it.
  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredOperationMs ?? 0);
    if (heartbeatAge > ceiling) {
      // Skip kill when the stale heartbeat is from a PRIOR container
      // instance AND we're still inside the spawn-grace window. The
      // heartbeat file persists across container restarts at a host-side
      // path mounted into /workspace/.heartbeat — the new container
      // inherits the previous instance's stale mtime until its first
      // poll-loop iteration touches it. Without this, a host restart
      // (or any post-crash respawn for a session whose previous heartbeat
      // had already aged past the ceiling) SIGKILLs the fresh container
      // before the agent-runner can mark itself alive, creating an
      // infinite spawn → kill → respawn loop.
      // An ADOPTED container is excluded, because for it the predicate is
      // false by construction and would be generous for the wrong reason: its
      // `spawnedAt` is the adoption instant, so a heartbeat older than it is
      // this container's OWN and genuinely stale. Without the `!adopted`
      // guard a wedged survivor would buy a fresh grace window on every host
      // restart and never be killed (plan §3.5 divergence 11).
      const inSpawnGrace = spawnedAtMs > 0 && now - spawnedAtMs < SPAWN_GRACE_MS;
      const heartbeatFromPriorContainer = !adopted && spawnedAtMs > 0 && heartbeatMtimeMs < spawnedAtMs;
      if (!(inSpawnGrace && heartbeatFromPriorContainer)) {
        return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
      }
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredOperationMs ?? 0);
  // True only for claims this container could have produced itself; older
  // claims are leftovers from a prior crashed container and the fresh one
  // gets SPAWN_GRACE_MS to clean them on startup before we kill for them.
  const inGrace = spawnedAtMs > 0 && now - spawnedAtMs < SPAWN_GRACE_MS;
  for (const claim of claims) {
    const claimedAt = parseSqliteUtc(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    if (inGrace && claimedAt < spawnedAtMs) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

/**
 * Post-kill follow-ups, started from the container's OWN exit (Codex final).
 *
 * `killContainer` only REQUESTS the stop: it calls `stopContainer` (or SIGKILLs)
 * and returns, while `activeContainers` is cleared by the spawn path's own
 * `close` handler whenever the child actually goes. Running the chain on the
 * next line therefore raced the exit — `containerOwnsOutbound` was still true,
 * the early-out fired, and the ceiling notice, the orphan-claim reset and the
 * accountability wake were skipped for good, with nothing to retry them. The
 * positive tests missed it because their `killContainer` mock cleared
 * `isContainerRunning` synchronously, which production does not.
 *
 * So the chain hangs off `onExit`, which `stopRunningContainer` registers as a
 * `once('close')` AFTER the spawn path's finalizer — so by the time it runs the
 * session is already out of `activeContainers` and the host may write. The
 * per-write `writeOutboundWhenStopped` guards inside each follow-up are
 * unchanged and still do the real work: `runSweepKillFollowUps` awaits between
 * follow-ups, so a replacement can still take the session mid-chain.
 *
 * Two paths `onExit` cannot cover, both handled here:
 *  - nothing to kill (the container already exited, or never ran). No callback
 *    is ever invoked, so the chain runs inline — ownership is already false.
 *  - a kill deferred behind an in-flight spawn. `killContainer` queues the
 *    callback in `pendingKills` and fires it when that spawn's container is
 *    stopped, which is the behaviour we want and needs nothing here.
 *
 * The chain is asynchronous with respect to the tick that ordered the kill, so
 * a rejection is logged and never thrown into it, exactly as the detached wake
 * does. `_settlePostKillForTesting` is how a case waits for it.
 */
const postKillChains = new Set<Promise<void>>();

function trackPostKill(work: Promise<void>, sessionId: string): void {
  const tracked = work
    .catch((err: unknown) => {
      // Classification survives the detach. A follow-up that throws is tagged
      // with its duty and window by `runDutyBody`, and the per-session catch in
      // the driver is what normally turns that tag into 'Host sweep duty
      // failed' — but this chain outlives the tick, so that catch never sees
      // it. Reported here in the same shape, on the same field pair every
      // post-deploy check filters on.
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

/**
 * Kill, then run the follow-ups when the container is actually gone.
 *
 * `snapshot` is read BEFORE the kill (the claims a reset would clear), so it is
 * captured by the caller and closed over here.
 */
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
        // Early-out only, and now a genuine one: a REPLACEMENT container took
        // the session between the exit and this open. It is not what makes the
        // writes safe — each follow-up carries its own
        // `writeOutboundWhenStopped` immediately before its own mutation.
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
  // Read + the observation hooks in one session, so the decision and the
  // telemetry row see the same snapshot. The kill below then runs with nothing
  // open (invariant I-3).
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
    // Snapshot BEFORE the kill so the follow-ups have the pre-kill state —
    // resetStuckProcessingRows clears the claims, so a read afterward would
    // always be empty.
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

// ─────────────────────────────────────────────────────────────────────────────
// OOM / memory-pressure notice (S16) — the SLA duty's own observation hook.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn cgroup memory telemetry into something the AGENT can act on.
 *
 * The kernel kills children inside the cgroup, never PID 1, so the container
 * survives and nothing surfaces: agents read an OOM-killed chromium as "the
 * browser crashed", an OOM-killed `npm ci` as "probably buffering", and
 * vanished MCP servers as "infrastructure instability". Reconstructed
 * transcripts show they diagnose it correctly the moment they are TOLD — so
 * the notice below is the whole fix; the detection already worked and just
 * ended in a log file nobody in the container can read.
 *
 * The row is onWake=0 (the container is alive — this path only runs for
 * running containers) and trigger=0 via insertDeferredMessageWithContextIfNew,
 * so it can never wake a dead container; it rides along with the next real
 * message or the next turn.
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
    // Resource validation already fails closed in the spawn path. Keep OOM
    // diagnostics available even if an operator edits the file mid-run.
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

/**
 * Test-only entry point for the running-container SLA, including both post-kill
 * write paths. Builds the minimum session context the duty reads: the SLA and
 * its follow-ups touch `session`, `agentGroupId`, `agentGroupFolder` and the
 * two window openers, nothing else. Moved here with `enforceRunningContainerSla`
 * itself (S2-PR10) — it was host-sweep.ts's while the body still lived there.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Registrations — S11, S14, and S16's SLA-observation hook.
// ─────────────────────────────────────────────────────────────────────────────

export function registerContainerHealthSweepDuties(): void {
  const id = SWEEP_DUTY_INVENTORY;

  registerSweepDuty({
    name: id.S11,
    phase: 'session:health',
    order: 10,
    // 6a. Failed-provider self-heal. Runs first: a container whose provider has
    // given up is not idle and not merely stuck, and healing it beats both
    // reaping it as idle and waiting out the 30-minute ceiling. Returns true
    // only when it killed the container, in which case the reap/SLA checks
    // below have nothing left to decide this tick — which is exactly the
    // `claims()` contract of an exclusive phase.
    claims: (ctx) =>
      sweepProviderHeal(ctx.run, ctx.session, ctx.agentGroupFolder, ctx.observed?.containerState ?? null),
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
    // 6. Running-container SLA: absolute ceiling + per-claim stuck rules. The
    // fallthrough — no claims(), so it runs when nothing above it claimed.
    run: (ctx) => enforceRunningContainerSla(asSessionContext(ctx)),
  });

  registerSlaObservationHook({
    name: id.S16,
    order: 10,
    // OOM / memory-pressure notice. SLA-only by construction: it is reached only
    // when the exclusive chain falls through to the SLA branch, and it must see
    // the same containerState snapshot the decision does.
    run: (ctx, state, mailbox) => {
      reportContainerOomTelemetry(mailbox, ctx.session, ctx.agentGroupFolder, state);
    },
  });
}

registerSweepDutySource('sweep-container-health', registerContainerHealthSweepDuties);
