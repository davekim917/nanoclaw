/**
 * Continuation and ceiling accountability.
 *
 * Seven registrations, all of them about work the host promised on an agent's
 * behalf and must still answer for after a crash or a ceiling kill:
 *
 *   session:plan   S6  done-proposal-mirror            (50)
 *                  S7  continuation-read               (60)
 *                  S8  continuation-recovery-parking   (70)
 *                  S9a continuation-wake-eligibility   (80)
 *   session:wake   S9b container-wake                  (10)  — NOTHING open
 *   kill follow-up S15 kill-ceiling-notice             (10)
 *                  S10 ceiling-kill-accountability     (30)
 *
 * Constraint 9: every stopped-session wake passes through continuation
 * admission, so S9a's `WakePlan` verdict is what S9b consumes — a due
 * scheduled row can never let saved work bypass the throttle or the cap.
 * Constraint 18: S9b holds nothing open. The attempt increment and the
 * attempt restore each take their own short window through
 * `ctx.runIn('session:wake', …)`, with `wakeContainer` between them at mailbox
 * depth 0. Constraint 12: S15 and S10 run only inside the session the SLA duty
 * opens AFTER `killContainer` returns, over `ctx.killSnapshot` — the claims and
 * the continuation the SLA read in its own observe session, BEFORE the kill.
 *
 * Storage stays in the mailbox module (`../mailbox/ops/{continuation,recovery}.ts`);
 * this module owns the throttle, the cap and the notices, and re-exports the
 * storage half unchanged so existing import paths and signatures survive.
 *
 * Every body below is moved from `src/host-sweep.ts` UNCHANGED — same
 * statements, log strings, thresholds and helper calls.
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

export { decideCeilingFollowUp, type CeilingFollowUp } from './decide.js';

// ─────────────────────────────────────────────────────────────────────────────
// Ceiling-kill accountability wake.
//
// The absolute ceiling fires whenever a container goes 30 min without a
// heartbeat — including right after the agent parked long-running work in an
// in-container background task and ended its turn (the heartbeat only moves
// while a turn is active). Respawn is wake-on-inbound, so without a follow-up
// the session stays dead until a human pings — which reads as "said it was
// working, then went silent for hours," and the background job's state (plus
// /tmp) is gone by the time anyone looks.
//
// When the kill interrupted an explicit continuation or a freshly-started
// tool, queue an on_wake accountability row. Status/narration is deliberately
// not evidence: "starting now" can be the final output of a completed turn.
// The continuation record owns the two-attempt recovery cap; genuine inbound
// resets that counter in the runner without deleting the saved task.
// ─────────────────────────────────────────────────────────────────────────────

export const CONTINUATION_WAKE_MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * The durable work-continuation record and its SQL live in the mailbox module
 * (`src/modules/mailbox/ops/continuation.ts`) — the sweep owns the throttle
 * and the cap, not the storage. Re-exported unchanged so `host-restart-warn`
 * and the existing tests keep their import path and signatures.
 */
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

/**
 * The deferred recovery-wake rows the sweep parks when a budget is spent.
 * SQL in the mailbox module; re-exported unchanged for the existing tests.
 */
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
 * Consume one recovery attempt for a STOPPED session's saved continuation.
 *
 * Its own short mailbox session: the caller must not be holding one for this
 * key (invariant I-3), and the write only ever runs with the container
 * confirmed stopped, which is what makes a host write to the container-owned
 * outbound.db safe.
 */
async function incrementStoppedContinuationAttempt(
  run: SessionRunner,
  session: Session,
  expectedId: string,
): Promise<HostWorkContinuation | null> {
  try {
    // A container that came up during the open now owns both outbound.db and
    // the continuation's runner claim. Writing here would push the record back
    // to `queued`, drop that runner_id and consume a recovery attempt the fresh
    // runner never got — saved work duplicated, parked early, or lost.
    // Returning without consuming the attempt leaves the next tick to decide.
    const result = await withStoppedContainerSession(run, session, (mailbox) =>
      expectedId !== 'legacy-pending-next'
        ? mailbox.incrementWorkContinuationResumeAttempt(expectedId)
        : mailbox.migrateLegacyWorkContinuationForRecovery(),
    );
    return result ?? null;
  } catch (err) {
    // An OPENER failure was already classified and logged by the window, and it
    // is unwinding the session — swallowing it here would hand S9b a null and
    // let it wake the container on W1's stale plan through an unreadable
    // mailbox. Everything else keeps the pre-seam outcome exactly: warn, return
    // null, and let a due-count wake proceed without the continuation.
    if (err instanceof SweepWindowAbort) throw err;
    log.warn('Failed to increment continuation recovery attempt', { sessionId: session.id, err });
    return null;
  }
}

/**
 * Test-only entry point for the stopped-container recovery admission — the
 * TOCTOU site: the container-state check must happen INSIDE the session, after
 * the open and immediately before the mutation.
 *
 * Lives here rather than in host-sweep.ts because
 * `incrementStoppedContinuationAttempt` belongs to this family; the shim lives
 * with its body, as the SLA entry point does. Its signature and the
 * cases that call it are unchanged.
 */
export function _incrementStoppedContinuationAttemptForTesting(
  session: Session,
  expectedId: string,
): Promise<HostWorkContinuation | null> {
  const run: SessionRunner = (action) => withExistingMailboxSession(session.agent_group_id, session.id, action);
  return incrementStoppedContinuationAttempt(run, session, expectedId);
}

/**
 * What became of a restore. `refused` is not a failure: it is
 * `withStoppedContainerSession` answering `undefined`, which means either a
 * container took `outbound.db` or the mailbox is gone — in both cases the host
 * must not write, and both are ordinary.
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
    // Same split as the increment above: an opener failure is the window's to
    // report and unwind; anything else keeps the pre-seam warn-and-continue.
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
  // Name the saved task. Without it the agent reads a generic "you were
  // killed" notice, cannot tell the wake IS its own continuation, and burns a
  // turn re-deriving whether the promised work ran (observed 2026-08-16).
  const savedWork =
    reason === 'continuation' && workContinuation
      ? ` Your saved continuation (${workContinuation.id}) is still queued and resumes automatically right after ` +
        `this message — do NOT re-queue it with continue_work, and do not redo it if you find it already done. ` +
        `The saved task is: ${workContinuation.task}`
      : '';
  const text =
    `[system] Your previous container was killed by the ${idleMinutes}-minute idle ceiling ` +
    `(no active turn for ~${silentMinutes} min). If work was in flight: check your durable checkpoints, ` +
    `resume what is safely resumable, and post ONE message accounting for state — done / lost / next. ` +
    `Re-check any work claims in claims/ before resuming a seam — a sibling may have taken it over while you were down. ` +
    `In-container background tasks, sleeps, and /tmp do not survive a restart; before going idle with ` +
    `work in flight, checkpoint to a durable path and call continue_work, or use wait for a real time delay. ` +
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

  // Shadow mode gates the wedged-tool wake only. The continuation wake is
  // long-shipped behaviour on a path this change did not touch, so flipping the
  // flag must never take it away.
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
 * Tell the user we just reaped their container for inactivity. The
 * outbound.db write lands on the normal delivery path — no container
 * involvement needed (it's already dead).
 *
 * Three gates, all skip with a debug log:
 *   1. No session_routing yet (fresh session that never woke).
 *   2. `pendingClaims === 0` — no inbound was in-flight when we killed,
 *      meaning no user was actually waiting. The ceiling fires on every
 *      idle 30-min container; without this gate the chat spams every
 *      operator across every quiet session every half hour.
 *   3. Duplicate notice in the last 60s (racing sweep tick).
 *
 * The write goes through the mailbox session's own writable outbound handle,
 * which the module opens lazily — so a tick that never reaches this branch
 * never opens outbound.db for writing at all, and the earlier
 * `writableOutDb` test seam is gone with it.
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
    // Idempotency: if a kill-ceiling notice was already written within the
    // last 60s (e.g. a sweep raced and re-fired), skip the duplicate. The
    // check is by content marker rather than a dedicated column to avoid
    // a schema migration. Cheap query against an already-open handle.
    const recent = mailbox.outboundHasRecentContentLike('agent_restart_inactivity', 60);
    if (recent) {
      log.debug('kill-ceiling notify skipped — duplicate within 60s', {
        sessionId: session.id,
      });
      return;
    }
    const minutes = Math.round(heartbeatAgeMs / 60_000);
    const id = `sys-kill-ceiling-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Don't ask the user to resend: the kill-ceiling branch runs
    // resetStuckProcessingRows immediately after, which defers every claimed
    // pending message behind fresh-context retry admission. Unclaimed pending
    // rows just sit until the next wake. Either way the system recovers
    // the user's existing input — a resend would just create duplicates.
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
      // Machine-readable marker so the idempotency check above (and any
      // future consumer that wants to react) doesn't need to grep prose.
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

/** Test-only alias kept so the existing suite's call sites read unchanged. */
export function _notifyKillCeilingForTesting(
  mailbox: NanoclawMailboxSession,
  session: Session,
  heartbeatAgeMs: number,
  pendingClaims: number,
  containerState?: ContainerState | null,
): void {
  notifyKillCeiling(mailbox, session, heartbeatAgeMs, pendingClaims, containerState);
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrations — S6, S7, S8, S9a (session:plan), S9b (session:wake, nothing
// open) and the two ceiling kill follow-ups S15 and S10.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wakes S9b has started and not yet settled.
 *
 * The wake is detached, so its follow-up work outlives the tick that started
 * it. Two things need that fact to be observable:
 *
 *  - a rejection must be LOGGED, not thrown into a tick that has moved on and
 *    would otherwise report a duty failure for a session it has finished with;
 *  - a test has to be able to wait for it. `_settleDetachedWakesForTesting`
 *    is the only sanctioned way — an acceptance case that asserts on the
 *    attempt restore is asserting on work that is deliberately no longer
 *    synchronous with the duty, and a timer-based wait would be flaky.
 *
 * Entries remove themselves, so this set is empty whenever nothing is in
 * flight and it cannot grow without bound.
 */
const detachedWakes = new Map<string, Promise<void>>();

function trackDetachedWake(work: Promise<void>, sessionId: string): void {
  const tracked = work
    .catch((err: unknown) => {
      // Never rethrown. The tick that started this wake is gone; the only
      // thing left to do about a failure is say so. `SweepWindowAbort` from
      // the restore's own short window lands here too — same treatment, since
      // the session it names is no longer being swept.
      log.warn('Detached container wake follow-up failed', { sessionId, err });
    })
    .finally(() => {
      // Only if it is still OURS. Keyed by session, so a later tick that
      // legitimately started a new wake must not have its entry deleted by an
      // older one settling.
      if (detachedWakes.get(sessionId) === tracked) detachedWakes.delete(sessionId);
    });
  detachedWakes.set(sessionId, tracked);
}

/**
 * Test-only: forget every tracked follow-up.
 *
 * The map is keyed by session id and every suite here reuses one — so a case
 * that leaves an entry behind would silently suppress the NEXT case's wake,
 * which is the dedupe working and the test lying. Called from `beforeEach`.
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
    // Mirror the container's own `propose_done` record onto the central
    // `sessions` row so the Observatory list can show "proposes closing"
    // without opening a per-session SQLite file per row. Free here — the
    // session is already open and it is one SELECT — and deliberately NOT the
    // copy the close path trusts (see thread-close.ts). Isolated: a mirror
    // failure must never cost this session its sweep.
    //
    // `syncDoneProposalMirror` takes the PARSED proposal, so the read is the module's own op and no handle leaves the
    // session. The `hasOutbound` guard is kept for what it costs: a
    // never-woken session has no proposal to mirror and no outbound file to
    // open looking for one.
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
    // 4. Durable continuation state is a wake source, but its automatic crash
    // recovery is both throttled and hard-capped per continuation id.
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
      if (plan.workContinuation && plan.workContinuation.resume_attempts >= WORK_CONTINUATION_RESUME_MAX_ATTEMPTS) {
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
    // Every stopped-session wake must pass through continuation recovery
    // admission, even when an unrelated scheduled row is already due. The runner
    // retains its prior owner claim until this path clears it, so a scheduled
    // wake cannot make saved work bypass the throttle or cap.
    run: (ctx) => {
      const { session, mailbox, plan } = asSessionContext(ctx);
      plan.continuationWakeEligible =
        // Gates S9b's attempt increment, which writes outbound.db (7199be48).
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

  // ── session:wake (W2) — NOTHING open ───────────────────────────────────────

  registerSweepDuty({
    name: id.S9b,
    phase: 'session:wake',
    order: 10,
    // 5. Wake a container if work is due and nothing is running.
    run: async (ctx) => {
      const c = asSessionContext(ctx);
      const { session, plan } = c;
      // A spawn for this session is already in flight. `wakeContainer`
      // dedupes by session, so calling it again returns the SAME promise —
      // and wrapping that promise in a fresh `.then()` every tick is what made
      // the follow-ups accumulate: one closure per tick, each retaining this
      // context and its snapshot, for as long as the spawn is queued behind
      // another on the projection worker. That can be tens of ticks.
      //
      // So: at most ONE follow-up per session. Checked BEFORE the attempt
      // increment, not after — the in-flight wake already claimed an attempt,
      // and consuming a second here would spend the budget twice for one spawn.
      // `isContainerSpawning` covers the spawns this duty did not start
      // (router ingress, agent-route), which need the same restraint.
      if (detachedWakes.has(session.id) || isContainerSpawning(session.id)) {
        // Same reasoning as the `reportWoke(true)` below: a container that is
        // starting must not be observed and must not take a quiet mark.
        c.reportWoke(true);
        return;
      }
      // `session.archived_at` gates admission alongside the checks above, and
      // BEFORE the continuation-attempt increment below — not folded into the
      // `if` a few lines down. `unwakeableReason` already refuses an archived
      // session with "session is archived" — but
      // that refusal comes back as the same `false` a transient spawn failure
      // returns, which by design leaves the due row pending for the next tick
      // (see the comment on `wakeContainer never throws` below). An archived
      // session can never take a wake (nothing ever clears `archived_at` —
      // `unarchiveSessionById` has no callers), so without this gate the row
      // is retried and refused every tick, forever, logging this duty's INFO
      // line each time with no backoff and no terminal state. Early return,
      // mirroring the `detachedWakes`/`isContainerSpawning` shape above,
      // rather than an extra clause on the `if` below: `plan.continuationWakeEligible`
      // being true would otherwise still reach `incrementStoppedContinuationAttempt`
      // and consume an attempt EVERY tick for a wake that can never happen —
      // the attempt is spent, but the restore that undoes a refused wake hangs
      // off the `wakeInFlight` promise from the `requestWake` call below, which
      // an archived session never reaches. No `reportWoke` call: nothing
      // started, so `justWoke` stays at its default `false`, exactly like the
      // "nothing due" case this duty already falls through with no wake.
      // `scripts/health-sentinel.sh` is what reports the stranded row to the
      // operator instead, once per cooldown rather than once per tick. Reads
      // the tick's own session snapshot rather than a fresh row — the same
      // staleness this duty's `status` check already tolerates a few lines
      // below, and `archived_at` only ever transitions unset → set, so a stale
      // read can under-skip (retried next tick) but never over-skip.
      if (session.archived_at != null) return;
      // Both of these open a mailbox of their own, so both go through the
      // window — an unopenable mailbox here is 'Host sweep mailbox unopenable'
      // with window 'session:wake', not the helper's legacy warning, and it
      // takes no quiet mark (W2 never backs off).
      const wakeRun: SessionRunner = (action) => c.runIn('session:wake', action);
      const resumedContinuation = plan.continuationWakeEligible
        ? await incrementStoppedContinuationAttempt(wakeRun, session, plan.workContinuation!.id)
        : null;
      const continuationWake = resumedContinuation !== null;
      // Snapshotted for the deferred restore below: `plan` belongs to the
      // session context and the tick moves on, so the detached continuation
      // must not read it later.
      const continuationForRestore = plan.workContinuation;
      if ((plan.dueCount > 0 || continuationWake) && !isContainerRunning(session.id)) {
        log.info('Waking container for due messages', {
          sessionId: session.id,
          count: plan.dueCount,
          priority: plan.wakePriority,
          continuationId: resumedContinuation?.id,
        });
        // wakeContainer never throws — transient spawn failures (OneCLI down,
        // etc.) return false and leave messages pending for the next tick.
        // Classification is passed into the atomic admission decision so a
        // scheduled wake can never reserve memory as interactive first.
        // Re-read immediately before the wake. `session` came from the tick's
        // `getActiveSessions()` snapshot, taken before a serial per-session
        // loop that awaits container spawns, so by this duty it can be many
        // seconds old — and the storage worker this same tick starts closes
        // rows with `UPDATE sessions SET status = 'archiving' … WHERE status =
        // 'active'`. `wakeContainer`'s only liveness gate reads `status` off
        // the object it is handed, so a stale one defeats it and spawns a
        // container `getActiveSessions()` will never return: no stuck
        // detection, no heartbeat ceiling, no claim tolerance. Every other
        // by-id caller already re-reads (`router.ts`, `agent-route.ts`,
        // `container-restart.ts`); this one did not.
        //
        // DETACHED. The per-session loop is serial, and a spawn can take
        // 20-47 s because `ensureArchiveProjection` awaits ONE worker thread
        // that serialises builds — so awaiting here made the tick's cost track
        // the number of containers that happened to be due, not the number of
        // sessions. Measured on B2's boot: ticks at ~800 sessions ranged 9.7 s
        // (0 spawns) to 456 s (8 spawns) on identical code. Starting the wake
        // and walking on removes the whole of that from `sessionsMs`.
        //
        // Nothing about the wake itself changes: same guard, same priority,
        // same admission, same `wakeContainer`. Only who waits.
        const wakeStartedAtMs = Date.now();
        const wakeInFlight = requestWake(session, 'due-message', {
          priority: plan.wakePriority,
          guard: sessionStillActive(session.id),
        });
        // Time the loop actually spent inside the call — after the detach this
        // is `wakeContainer`'s synchronous prologue up to its first await, so a
        // non-trivial `spawnWaitMs` on the tick-timing line means someone put
        // an await back.
        c.reportWake({ awaited: false, waitMs: Date.now() - wakeStartedAtMs });
        // `justWoke` for the rest of this tick's windows, exactly as an awaited
        // wake would be. It closes TWO gates, and both must stay closed for a
        // container that is starting:
        //
        //  - the driver's observe read (`alive && !justWoke && plan.hasOutbound`),
        //    which exists to be skipped on the tick that woke a container: it
        //    has not yet cleared stale `processing_ack` rows from a previous
        //    crash, and reading claims now is what produces the spawn-kill loop;
        //  - the quiet-mark branch, which must never mark a session with a
        //    spawn in flight.
        //
        // Reporting FALSE would open both the moment `isContainerRunning` flips
        // true between here and the driver's own `alive = isContainerRunning(…)`
        // a few lines later — the one ordering that distinguishes the two
        // values, and the one where false is wrong. (Everywhere else they are
        // indistinguishable: a detached spawn has not started yet, so `alive` is
        // false and the observe read is skipped either way, and the quiet branch
        // is already unreachable because S9b only wakes when `dueCount > 0` or a
        // continuation is present, both of which fail its predicate.)
        c.reportWoke(true);
        // The attempt restore hangs off the promise. It runs in its own short
        // window like the increment above, it can outlive this tick, and it can
        // NEVER throw into it: a rejection here is the wake's own fault
        // reporting, and the tick has already moved on.
        //
        // A REFUSED restore is logged at info, not warn, and the consumed
        // attempt is deliberately not chased. `withStoppedContainerSession`
        // answers `undefined` for exactly two reasons, and neither is a fault:
        // a container now owns `outbound.db`, or the mailbox is gone. The
        // detach widens the first — the wake's answer can arrive 20-47 s later,
        // and any path (router ingress, agent-route, another sweep) can have
        // started a container in between. Writing the record back THEN would
        // break the one-writer rule `writeOutboundWhenStopped` exists to
        // enforce, and it would be wrong on its own terms: a running container
        // owns the continuation, will work it, and rewrites the record itself.
        // The attempt is consumed by a container that is up, which is what the
        // wake asked for. The case where the attempt would really be lost — no
        // container ever came up — is the case where the guard permits the
        // write and the restore lands.
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

  // ── Kill follow-ups — inside the session opened AFTER killContainer returns ─

  registerSweepKillFollowUp({
    name: id.S15,
    order: 10,
    // Posted AFTER the kill to honor the outbound.db single-writer invariant;
    // the module opens the writable outbound handle lazily, only for this write.
    // notifyKillCeiling itself gates on `pendingClaims === 0` (no user was
    // waiting) to avoid spamming restart notices on quiet sessions that just
    // naturally reached the 30-min idle ceiling. Ceiling kills only — the
    // claim-stuck branch has never notified.
    run: (ctx, outcome, mailbox) => {
      if (outcome.action !== 'kill-ceiling') return;
      const snapshot = ctx.killSnapshot!;
      // Per-write: `runSweepKillFollowUps` awaits between follow-ups, so the
      // window's early-out cannot vouch for ownership at THIS write.
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
    // Accountability wake: if the kill plausibly interrupted parked work, queue
    // an on_wake row so the session respawns (next sweep tick's due-wake step)
    // and answers for the interruption instead of staying dead until the next
    // human ping. Best-effort — a failure here must not break the sweep's kill
    // path. Ceiling kills only.
    run: (ctx, outcome, mailbox) => {
      if (outcome.action !== 'kill-ceiling') return;
      const snapshot = ctx.killSnapshot!;
      // INSIDE the guard even though the row itself is inbound (host-owned, no
      // single-writer hazard): a replacement that took the session has already
      // recovered from this kill, so the row is `on_wake = 1`, the live
      // replacement never consumes it, and it instead greets the NEXT fresh
      // container with a stale "your previous container was killed" notice —
      // while counting against that class's recovery-attempt cap. Skipping is
      // correct, not merely safe.
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
    },
  });
}

registerSweepDutySource('sweep-continuation', registerContinuationSweepDuties);
