/**
 * Continuation and ceiling accountability. Every stopped-session wake passes
 * through continuation admission (S9a), so a due scheduled row can never let
 * saved work bypass the throttle or cap. S9b holds nothing open: the attempt
 * increment and restore each take their own short window, with the wake
 * between them. S15/S10 run only in the session opened AFTER `killContainer`
 * returns, over the pre-kill `ctx.killSnapshot`.
 */
import type Database from 'better-sqlite3';

import { SELF_HEAL_ENABLED } from '../../config.js';
import {
  getContainerSpawnedAt,
  isContainerRunning,
  isContainerSpawning,
  sessionStillActive,
  containerOwnsOutbound,
} from '../../container-runner.js';
import { requestWake } from '../../request-wake.js';
import { syncDoneProposalMirror } from '../../dashboard/thread-close.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { type ForkContainerStateRow as ContainerState, type NanoclawMailboxSession } from '../mailbox/index.js';
import {
  ABSOLUTE_CEILING_MS,
  SWEEP_DUTY_INVENTORY,
  SweepWindowAbort,
  asSessionContext,
  withStoppedContainerSession,
  writeOutboundWhenStopped,
  registerSweepDuty,
  registerSweepDutySource,
  registerSweepKillFollowUp,
  writeSystemWake,
  type SessionRunner,
} from '../../host-sweep.js';
import { decideCeilingFollowUp, type CeilingFollowUp } from './decide.js';
import { ABSOLUTE_CEILING_KILL } from './kill-state.js';
import { ACCOUNT_FOR_STATE, followUpKill, RESTART_SURVIVAL_RULES } from './reap-respawn.js';

export { decideCeilingFollowUp, type CeilingFollowUp } from './decide.js';

// Ceiling-kill accountability: the heartbeat only moves during a turn, so work
// parked in a background task gets ceiling-killed and, without a follow-up,
// stays dead until a human pings. Narration is deliberately not evidence:
// "starting now" can be the final output of a completed turn.

export const CONTINUATION_WAKE_MIN_INTERVAL_MS = 10 * 60 * 1000;

export {
  canAttemptContinuationRecovery,
  incrementWorkContinuationResumeAttempt,
  migrateLegacyWorkContinuationForRecovery,
  readContinuationRecoveryAttemptAt,
  readWorkContinuation,
  restoreWorkContinuationResumeAttempt,
  WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
  type HostWorkContinuation,
} from '../mailbox/ops/continuation.js';
import {
  canAttemptContinuationRecovery,
  readWorkContinuation,
  WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
  type HostWorkContinuation,
} from '../mailbox/ops/continuation.js';

/** Test-only predicate over an injected outbound DB handle. */
export function _hasWorkContinuationForTesting(db: Database.Database): boolean {
  return readWorkContinuation(db) !== null;
}

export { hasDueRecoveryWake, parkDueRecoveryWakes } from '../mailbox/ops/recovery.js';

/** Throttle gate: wake only when the last spawn/recovery attempt is old. */
export function decideContinuationWake(args: {
  now: number;
  spawnedAtMs: number;
  lastRecoveryAttemptAtMs?: number;
}): boolean {
  const lastAttemptAtMs = Math.max(args.spawnedAtMs, args.lastRecoveryAttemptAtMs ?? 0);
  if (lastAttemptAtMs === 0) return true;
  return args.now - lastAttemptAtMs >= CONTINUATION_WAKE_MIN_INTERVAL_MS;
}

/**
 * Consume one recovery attempt for a STOPPED session's saved continuation, in
 * its own short session; the caller must not hold one for this key.
 */
async function incrementStoppedContinuationAttempt(
  run: SessionRunner,
  session: Session,
  expectedId: string,
): Promise<HostWorkContinuation | null> {
  try {
    // A container that came up during the open owns outbound.db and the
    // continuation's runner claim; writing would duplicate, park or lose the
    // work. Returning without consuming leaves the next tick to decide.
    const result = await withStoppedContainerSession(run, session, (mailbox) =>
      expectedId !== 'legacy-pending-next'
        ? mailbox.incrementWorkContinuationResumeAttempt(expectedId)
        : mailbox.migrateLegacyWorkContinuationForRecovery(),
    );
    return result ?? null;
  } catch (err) {
    // An opener failure must propagate: swallowing it would let S9b wake on a
    // stale plan through an unreadable mailbox.
    if (err instanceof SweepWindowAbort) throw err;
    log.warn('Failed to increment continuation recovery attempt', { sessionId: session.id, err });
    return null;
  }
}

/**
 * The container-state check must happen INSIDE the session, after the open and
 * immediately before the mutation.
 */
export function _incrementStoppedContinuationAttemptForTesting(
  session: Session,
  expectedId: string,
): Promise<HostWorkContinuation | null> {
  const run: SessionRunner = (action) => withExistingMailboxSession(session.agent_group_id, session.id, action);
  return incrementStoppedContinuationAttempt(run, session, expectedId);
}

/**
 * `refused` is not a failure: a container took `outbound.db` or the mailbox is
 * gone, and in both cases the host must not write.
 */
type RestoreOutcome = 'restored' | 'refused' | 'failed';

async function restoreStoppedContinuationAttempt(
  run: SessionRunner,
  session: Session,
  attempted: HostWorkContinuation,
  previous: HostWorkContinuation,
): Promise<RestoreOutcome> {
  try {
    const result = await withStoppedContainerSession(run, session, (mailbox) =>
      mailbox.restoreWorkContinuationResumeAttempt(attempted, previous),
    );
    return result === undefined ? 'refused' : 'restored';
  } catch (err) {
    if (err instanceof SweepWindowAbort) throw err;
    log.warn('Failed to restore continuation recovery attempt after rejected wake', { sessionId: session.id, err });
    return 'failed';
  }
}

export function notifyContinuationParked(
  mailbox: NanoclawMailboxSession,
  _session: Session,
  continuation: HostWorkContinuation,
  writeMessage: (message: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  }) => void = (message) => mailbox.writeOutboundDirect(message),
): boolean {
  const marker = `continuation_recovery_parked:${continuation.id}:${continuation.recovery_episode}`;
  if (mailbox.outboundHasContentLike(marker)) return false;
  const sourceRouting = continuation.source_message_id
    ? mailbox.readMessageRouting(continuation.source_message_id)
    : undefined;
  const routing =
    sourceRouting?.channel_type && sourceRouting.platform_id ? sourceRouting : mailbox.readSessionRouting();
  if (!routing) return false;
  writeMessage({
    id: `continuation-parked-${continuation.id}-${continuation.recovery_episode}`,
    kind: 'chat',
    platformId: routing.platform_id,
    channelType: routing.channel_type,
    threadId: routing.thread_id,
    content: JSON.stringify({
      text:
        `⚠️ I could not resume the interrupted work after ${WORK_CONTINUATION_RESUME_MAX_ATTEMPTS} automatic attempts. ` +
        `The task is still saved: ${continuation.task}. Reply in this thread and I will try again.`,
      _system: {
        kind: marker,
        continuation_id: continuation.id,
        recovery_episode: continuation.recovery_episode,
      },
    }),
  });
  return true;
}

const CEILING_RESPAWN_ID_PREFIX = 'ceiling-respawn-';

export function countToolRecoveryAttemptsSinceRealInbound(mailbox: NanoclawMailboxSession): number {
  return mailbox.countRecoveryAttemptsSinceRealInbound(`${CEILING_RESPAWN_ID_PREFIX}tool-`);
}

function writeCeilingRespawn(
  mailbox: NanoclawMailboxSession,
  session: Session,
  reason: 'continuation' | 'tool',
  recoveryKey: string,
  heartbeatAgeMs: number,
  workContinuation: HostWorkContinuation | null,
  ceilingMs: number = ABSOLUTE_CEILING_MS,
): void {
  const idleMinutes = Math.round(Math.max(ceilingMs, ABSOLUTE_CEILING_MS) / 60_000);
  const silentMinutes = Math.round(heartbeatAgeMs / 60_000);
  // Name the saved task, or the agent can't tell the wake IS its own
  // continuation and re-derives whether the work ran.
  const savedWork =
    reason === 'continuation' && workContinuation
      ? ` Your saved continuation (${workContinuation.id}) is still queued and resumes automatically right after ` +
        `this message — do NOT re-queue it with continue_work, and do not redo it if you find it already done. ` +
        `The saved task is: ${workContinuation.task}`
      : '';
  const text =
    `[system] Your previous container was killed by the ${idleMinutes}-minute idle ceiling ` +
    `(no active turn for ~${silentMinutes} min). If work was in flight: check your durable checkpoints, ` +
    `resume what is safely resumable, and ${ACCOUNT_FOR_STATE}. ${RESTART_SURVIVAL_RULES} ` +
    `If nothing was in flight, say so in one line.${savedWork}`;
  writeSystemWake(mailbox, session, `${CEILING_RESPAWN_ID_PREFIX}${recoveryKey}`, text, {
    kind: 'agent_ceiling_respawn',
    reason,
    heartbeat_age_ms: heartbeatAgeMs,
  });
}

/** The follow-up half of the kill-ceiling branch, driven only by durable work state or a fresh tool start. */
function applyCeilingFollowUp(
  mailbox: NanoclawMailboxSession,
  session: Session,
  containerState: ContainerState | null,
  workContinuation: HostWorkContinuation | null,
  heartbeatAgeMs: number,
  ceilingMs: number = ABSOLUTE_CEILING_MS,
): CeilingFollowUp {
  const priorToolAttempts = countToolRecoveryAttemptsSinceRealInbound(mailbox);
  const followUp = decideCeilingFollowUp({
    hasContinuation: workContinuation !== null && canAttemptContinuationRecovery(workContinuation),
    currentTool: containerState?.current_tool ?? null,
    toolStartedAt: containerState?.tool_started_at ?? null,
    priorToolAttempts,
    now: Date.now(),
    ceilingMs,
  });
  if (followUp.action !== 'wake-accountable') return followUp;

  // Shadow mode gates only the wedged-tool wake, never the continuation wake.
  if (followUp.reason === 'tool' && !SELF_HEAL_ENABLED) {
    log.info('self-heal: would queue wedged-tool accountability wake', {
      class: 'wedged-tool',
      sessionId: session.id,
      currentTool: containerState?.current_tool ?? null,
      toolStartedAt: containerState?.tool_started_at ?? null,
      heartbeatAgeMs,
      ceilingMs,
      priorToolAttempts,
      maxAttempts: WORK_CONTINUATION_RESUME_MAX_ATTEMPTS,
    });
    return { action: 'none' };
  }

  const recoveryKey =
    followUp.reason === 'continuation'
      ? `continuation-${workContinuation!.id}-${workContinuation!.recovery_episode}-${workContinuation!.resume_attempts}`
      : `tool-${encodeURIComponent(containerState?.tool_started_at ?? 'unknown')}`;
  writeCeilingRespawn(mailbox, session, followUp.reason, recoveryKey, heartbeatAgeMs, workContinuation, ceilingMs);
  log.info('Queued ceiling-kill accountability wake', { sessionId: session.id, reason: followUp.reason });
  return followUp;
}

/** Test-only re-export with injected session-DB handles. */
export function _applyCeilingFollowUpForTesting(
  mailbox: NanoclawMailboxSession,
  session: Session,
  containerState: ContainerState | null,
  workContinuation: HostWorkContinuation | null,
  heartbeatAgeMs: number,
  ceilingMs: number = ABSOLUTE_CEILING_MS,
): CeilingFollowUp {
  return applyCeilingFollowUp(mailbox, session, containerState, workContinuation, heartbeatAgeMs, ceilingMs);
}

/**
 * Tell the user the container was reaped. Skips when no inbound was in flight
 * (`pendingClaims === 0`): the ceiling fires on every idle container, and
 * without that gate every quiet session is spammed every half hour.
 */
function notifyKillCeiling(
  mailbox: NanoclawMailboxSession,
  session: Session,
  heartbeatAgeMs: number,
  pendingClaims: number,
  containerState?: ContainerState | null,
): void {
  try {
    if (pendingClaims === 0) {
      log.debug('kill-ceiling notify skipped — no pending claims, user was not waiting', {
        sessionId: session.id,
      });
      return;
    }
    const routing = mailbox.readSessionRouting();
    if (!routing) {
      log.debug('kill-ceiling notify skipped — no session_routing', {
        sessionId: session.id,
      });
      return;
    }
    // Dedupe a racing sweep tick by content marker.
    const recent = mailbox.outboundHasRecentContentLike('agent_restart_inactivity', 60);
    if (recent) {
      log.debug('kill-ceiling notify skipped — duplicate within 60s', {
        sessionId: session.id,
      });
      return;
    }
    const minutes = Math.round(heartbeatAgeMs / 60_000);
    const id = `sys-kill-ceiling-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Don't ask the user to resend: the kill branch defers every claimed
    // message for retry, so a resend would only create duplicates.
    const providerFailure =
      containerState?.provider_status === 'failed' ||
      containerState?.provider_status === 'recovering' ||
      containerState?.provider_status === 'suspect';
    const failureReason = containerState?.provider_failure_reason?.slice(0, 300) ?? null;
    const text = providerFailure
      ? `⚠️ Codex control-plane recovery did not complete` +
        (failureReason ? ` (${failureReason})` : '') +
        `. The host is restarting the agent runner; your existing messages will be retried automatically — ` +
        `no need to resend.`
      : `⚠️ The agent runner stopped updating for ${minutes} minutes and the host is restarting it. ` +
        `Your last messages will be picked up automatically on the next wake — no need to resend.`;
    const content = JSON.stringify({
      text,
      // Machine-readable marker for the idempotency check above.
      _system: {
        kind: 'agent_restart_inactivity',
        heartbeat_age_ms: heartbeatAgeMs,
        provider_status: containerState?.provider_status ?? null,
        provider_failure_reason: failureReason,
      },
    });
    mailbox.writeOutboundDirect({
      id,
      kind: 'chat',
      platformId: routing.platform_id,
      channelType: routing.channel_type,
      threadId: routing.thread_id,
      content,
    });
  } catch (err) {
    log.warn('kill-ceiling notify failed', { sessionId: session.id, err });
  }
}

export function _notifyKillCeilingForTesting(
  mailbox: NanoclawMailboxSession,
  session: Session,
  heartbeatAgeMs: number,
  pendingClaims: number,
  containerState?: ContainerState | null,
): void {
  notifyKillCeiling(mailbox, session, heartbeatAgeMs, pendingClaims, containerState);
}

/**
 * Wakes S9b has started and not yet settled. A rejection must be LOGGED, not
 * thrown into a tick that has moved on. Entries remove themselves.
 */
const detachedWakes = new Map<string, Promise<void>>();

function trackDetachedWake(work: Promise<void>, sessionId: string): void {
  const tracked = work
    .catch((err: unknown) => {
      // Never rethrown: the tick that started this wake is gone.
      log.warn('Detached container wake follow-up failed', { sessionId, err });
    })
    .finally(() => {
      // Only if still OURS: a newer wake for this session must keep its entry.
      if (detachedWakes.get(sessionId) === tracked) detachedWakes.delete(sessionId);
    });
  detachedWakes.set(sessionId, tracked);
}

/**
 * Test-only. Entries are keyed by session id, so a leftover entry would
 * silently suppress the next case's wake. Call from `beforeEach`.
 */
export function _resetDetachedWakesForTesting(): void {
  detachedWakes.clear();
}

/** Test-only: how many detached follow-ups are in flight (the dedupe set). */
export function _detachedWakeCountForTesting(): number {
  return detachedWakes.size;
}

/** Test-only: settle every wake S9b has started but not yet finished with. */
export function _settleDetachedWakesForTesting(): Promise<void> {
  return Promise.all([...detachedWakes.values()]).then(() => undefined);
}

function registerContinuationSweepDuties(): void {
  const id = SWEEP_DUTY_INVENTORY;

  registerSweepDuty({
    name: id.S6,
    phase: 'session:plan',
    order: 50,
    // Mirror `propose_done` onto the central row for the Observatory list. NOT
    // the copy the close path trusts. Isolated: a mirror failure must never cost
    // this session its sweep.
    run: async (ctx) => {
      const { session, mailbox } = asSessionContext(ctx);
      if (mailbox!.hasOutbound()) {
        try {
          await syncDoneProposalMirror(session.id, mailbox!.readDoneProposal());
        } catch (err) {
          log.warn('done_proposal mirror failed', { sessionId: session.id, err });
        }
      }
    },
  });

  registerSweepDuty({
    name: id.S7,
    phase: 'session:plan',
    order: 60,
    // Automatic crash recovery is throttled and hard-capped per continuation id.
    run: (ctx) => {
      const { mailbox, plan } = asSessionContext(ctx);
      plan.workContinuation = mailbox!.readWorkContinuation();
    },
  });

  registerSweepDuty({
    name: id.S8,
    phase: 'session:plan',
    order: 70,
    run: (ctx) => {
      const { session, mailbox, plan } = asSessionContext(ctx);
      if (plan.workContinuation && !canAttemptContinuationRecovery(plan.workContinuation)) {
        const continuation = plan.workContinuation;
        writeOutboundWhenStopped(session, mailbox!, () => {
          const parked = mailbox!.parkDueRecoveryWakes(new Date().toISOString());
          if (parked > 0) {
            plan.dueCount = mailbox!.countDueMessages();
            plan.wakePriority = plan.dueCount > 0 ? mailbox!.getDueWakePriority() : 'interactive';
          }
          if (plan.dueCount === 0) notifyContinuationParked(mailbox!, session, continuation);
        });
      }
    },
  });

  registerSweepDuty({
    name: id.S9a,
    phase: 'session:plan',
    order: 80,
    // Every stopped-session wake must pass through this admission, even when an
    // unrelated row is due, so a scheduled wake can't bypass the throttle or cap.
    run: (ctx) => {
      const { session, mailbox, plan } = asSessionContext(ctx);
      plan.continuationWakeEligible =
        // Gates S9b's attempt increment, which writes outbound.db.
        !containerOwnsOutbound(session.id) &&
        plan.workContinuation !== null &&
        canAttemptContinuationRecovery(plan.workContinuation) &&
        decideContinuationWake({
          now: Date.now(),
          spawnedAtMs: getContainerSpawnedAt(session.id),
          lastRecoveryAttemptAtMs: mailbox!.readContinuationRecoveryAttemptAt(plan.workContinuation),
        });
    },
  });

  registerSweepDuty({
    name: id.S9b,
    phase: 'session:wake',
    order: 10,
    run: async (ctx) => {
      const c = asSessionContext(ctx);
      const { session, plan } = c;
      // At most ONE follow-up per session, checked BEFORE the attempt increment:
      // `wakeContainer` returns the same promise for an in-flight spawn, so a
      // second follow-up would spend the budget twice. `isContainerSpawning`
      // covers spawns this duty did not start.
      if (detachedWakes.has(session.id) || isContainerSpawning(session.id)) {
        // A starting container must not be observed or take a quiet mark.
        c.reportWoke(true);
        return;
      }
      // Archived sessions can never take a wake (nothing clears `archived_at`),
      // and the refusal looks like a transient failure, so without this early
      // return the row is retried and an attempt consumed every tick forever.
      // It must come BEFORE the attempt increment below.
      if (session.archived_at != null) return;
      // Both open their own mailbox, so both go through the window.
      const wakeRun: SessionRunner = (action) => c.runIn('session:wake', action);
      const resumedContinuation = plan.continuationWakeEligible
        ? await incrementStoppedContinuationAttempt(wakeRun, session, plan.workContinuation!.id)
        : null;
      const continuationWake = resumedContinuation !== null;
      // Snapshotted: the detached restore must not read `plan` after the tick moves on.
      const continuationForRestore = plan.workContinuation;
      if ((plan.dueCount > 0 || continuationWake) && !isContainerRunning(session.id)) {
        log.info('Waking container for due messages', {
          sessionId: session.id,
          count: plan.dueCount,
          priority: plan.wakePriority,
          continuationId: resumedContinuation?.id,
        });
        // wakeContainer never throws: transient spawn failures return false and
        // leave messages pending for the next tick.
        // The guard re-reads the session: this snapshot can be many seconds old,
        // and wakeContainer's own liveness gate reads `status` off the object it
        // is handed, so a stale one spawns a container no sweep will ever see.
        // DETACHED: spawns can take 20-47 s behind one projection worker, and
        // awaiting made tick cost scale with due containers.
        const wakeStartedAtMs = Date.now();
        const wakeInFlight = requestWake(session, 'due-message', {
          priority: plan.wakePriority,
          guard: sessionStillActive(session.id),
        });
        // A non-trivial `waitMs` here means someone put an await back.
        c.reportWake({ awaited: false, waitMs: Date.now() - wakeStartedAtMs });
        // `justWoke` must be true for a starting container: it skips the observe
        // read (stale processing_ack rows would cause a spawn-kill loop) and the
        // quiet mark.
        c.reportWoke(true);
        // The restore runs in its own window and must never throw into the tick.
        // A REFUSED restore is expected (a container now owns outbound.db, or the
        // mailbox is gone): that container owns the continuation, so the
        // consumed attempt is deliberately not chased.
        trackDetachedWake(
          wakeInFlight.then(async (woke) => {
            if (woke || !resumedContinuation) return;
            const outcome = await restoreStoppedContinuationAttempt(
              wakeRun,
              session,
              resumedContinuation,
              continuationForRestore!,
            );
            if (outcome === 'refused') {
              log.info('Deferred continuation-attempt restore skipped — the host may not write outbound.db', {
                sessionId: session.id,
                continuationId: resumedContinuation.id,
              });
            }
          }),
          session.id,
        );
      }
    },
  });

  registerSweepKillFollowUp({
    name: id.S15,
    order: 10,
    // Posted AFTER the kill for the outbound.db single-writer invariant.
    // Ceiling kills only.
    run: (ctx, outcome, mailbox) => {
      if (outcome.action !== 'kill-ceiling') return;
      const snapshot = ctx.killSnapshot!;
      // Per-write: follow-ups await between each other, so the window's
      // early-out cannot vouch for ownership at THIS write.
      writeOutboundWhenStopped(ctx.session, mailbox, () =>
        notifyKillCeiling(
          mailbox,
          ctx.session,
          outcome.heartbeatAgeMs,
          snapshot.pendingClaims,
          snapshot.containerState,
        ),
      );
    },
  });

  registerSweepKillFollowUp({
    name: id.S10,
    order: 30,
    // Queue an on_wake row so the session respawns and answers for the
    // interruption. Best-effort; ceiling kills only.
    run: async (ctx, outcome, mailbox) => {
      if (outcome.action !== 'kill-ceiling') return;
      const snapshot = ctx.killSnapshot!;
      // Inside the guard although the row is inbound: a replacement that took
      // the session has already recovered, and the row would instead greet the
      // NEXT container with a stale notice and count against its cap.
      writeOutboundWhenStopped(ctx.session, mailbox, () => {
        try {
          applyCeilingFollowUp(
            mailbox,
            ctx.session,
            snapshot.containerState,
            snapshot.workContinuation,
            outcome.heartbeatAgeMs,
            outcome.ceilingMs,
          );
        } catch (err) {
          log.warn('ceiling-kill follow-up failed', { sessionId: ctx.session.id, err });
        }
      });
      // After the branch above, so a wake it queued counts as armed here.
      try {
        await followUpKill(mailbox, ctx.session, ctx.observed?.containerIdentity?.containerName ?? null, {
          reason: ABSOLUTE_CEILING_KILL,
          minutes: Math.round(Math.max(outcome.ceilingMs, ABSOLUTE_CEILING_MS) / 60_000),
        });
      } catch (err) {
        log.warn('ceiling-kill follow-up failed', { sessionId: ctx.session.id, err });
      }
    },
  });
}

registerSweepDutySource('sweep-continuation', registerContinuationSweepDuties);
