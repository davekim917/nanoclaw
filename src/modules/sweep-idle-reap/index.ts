/**
 * Sweep family: idle reaps (seam 2, S2-PR3 — plan.md §5 "S2-PR3 idle reaps
 * (G28)", §8 "S2-PR3 — idle reaps"). Registers S12 (idle-task-reap) and S13
 * (idle-chat-reap) on the `session:health` exclusive chain at order 20/30 —
 * heal (S11, order 10, stays in host-sweep.ts until PR 10) runs first, then
 * this module's two reaps, then the running-container SLA (S14, order 40,
 * the fallthrough — also stays until PR 10).
 *
 * Moved from src/host-sweep.ts UNCHANGED (cut/paste, same statements, same
 * log strings, same thresholds): both predicates and their `run()` bodies are
 * byte-identical to the pre-move source. Behavior-preserving move only — fork
 * issue #259 (the scheduled-task idle reaper killing a task-script container
 * mid-run) is OPEN and intentionally NOT fixed here.
 */
import { isTaskThread } from '../../db/sessions.js';
import { killContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { registerSweepDuty, SWEEP_DUTY_INVENTORY, type SweepSessionContext } from '../../host-sweep.js';

const id = SWEEP_DUTY_INVENTORY;

/**
 * Scheduled-task containers have no interactive follow-up window to preserve.
 * Once the provider is not executing, no message is claimed, and no work is
 * due, reap the container immediately so background work does not hold a
 * memory reservation until the general 30-minute idle ceiling.
 *
 * This deliberately does NOT key on `provider_status`. Every container clears
 * that column to 'idle' at startup (clearStaleProcessingAcks →
 * clearProviderHealthState, container/agent-runner/src/db/connection.ts), and
 * only the Codex provider ever writes it again — so for every other provider
 * the old `providerStatus === 'idle'` term was true from second one of the
 * container's life and the guard did nothing. `provider_executing` is the
 * maintained equivalent: the shared poll loop sets it around every turn for
 * every provider, including the runner-pushed follow-up turns (wrapping-retry
 * nudges, post-compaction bootstrap re-injection) that hold no processing
 * claim and would otherwise be killable mid-turn.
 *
 * An active work_continuation also blocks the reap. `continue_work` is the
 * only sanctioned way to promise follow-up, and between turn end and
 * continuation admission the container has no claim and is not executing —
 * reaping there punished the agent for doing the sanctioned thing and
 * demoted it to the throttled 10-minute host recovery path. The chat path
 * has always guarded this; the task path now matches.
 */
export function shouldReapIdleTaskContainer(
  threadId: string | null,
  dueMessageCount: number,
  processingClaimCount: number,
  providerExecuting: boolean,
  hasActiveContinuation: boolean,
): boolean {
  return (
    isTaskThread(threadId) &&
    dueMessageCount === 0 &&
    processingClaimCount === 0 &&
    !providerExecuting &&
    !hasActiveContinuation
  );
}

/**
 * Chat/channel containers have an interactive follow-up window worth
 * preserving (a human may reply within seconds), so unlike task containers
 * they get a quiet-duration floor before reaping. `provider_status` is not
 * usable here — every container clears it to 'idle' at startup and only the
 * Codex provider (container/agent-runner/src/providers/codex.ts) writes it
 * again, so for other providers it reads 'idle' for the container's whole
 * life. This keys on the durable, provider-agnostic signal instead: no due
 * message, no
 * claimed message, no pending work_continuation promise, and the container's
 * last outbound row (chat or status) is older than CHAT_IDLE_REAP_MS. State
 * lives entirely in inbound.db/outbound.db, so the next @mention respawns
 * and resumes exactly like a stuck-ceiling kill does today.
 */
export const CHAT_IDLE_REAP_MS = 15 * 60 * 1000;

export function shouldReapIdleChatContainer(
  threadId: string | null,
  dueMessageCount: number,
  processingClaimCount: number,
  hasActiveContinuation: boolean,
  lastOutboundAtMs: number | null,
  lastInboundAtMs: number | null,
  now: number,
): boolean {
  if (isTaskThread(threadId)) return false; // task threads use shouldReapIdleTaskContainer
  if (dueMessageCount !== 0 || processingClaimCount !== 0 || hasActiveContinuation) return false;
  if (lastOutboundAtMs === null) return false;
  // Idleness is the newest activity in EITHER direction, not just outbound.
  // A container that has consumed a fresh message but not yet emitted its
  // first status looks identical to an idle one from outbound alone, and the
  // other guards do not cover it: the row is already `completed` so dueCount
  // is 0, and processing claims are not written on this path. Observed live
  // 2026-08-12 — a user message landed 16.0 min after the previous reply and
  // the reaper killed the container 11s into the turn, so the turn produced
  // no answer at all. 15 min after the last reply is precisely when a human
  // returns to a thread, so this was the common case, not an edge.
  const lastActivityAtMs = Math.max(lastOutboundAtMs, lastInboundAtMs ?? 0);
  return now - lastActivityAtMs >= CHAT_IDLE_REAP_MS;
}

/**
 * Registers S12/S13. A named export (not just an import-time side effect) so
 * a test that calls host-sweep.ts's `_resetSweepRegistryForTesting()` (which
 * restores only host-sweep.ts's OWN builtins — it cannot know about a family
 * module it never imports) can re-arm this module's duties afterward. See the
 * call sites in src/host-sweep-registry.test.ts.
 */
export function registerIdleReapSweepDuties(): void {
  registerSweepDuty({
    name: id.S12,
    phase: 'session:health',
    order: 20,
    claims: (ctx) =>
      shouldReapIdleTaskContainer(
        ctx.session.thread_id,
        ctx.plan.dueCount,
        ctx.observed!.processingClaimCount,
        ctx.observed!.containerState?.provider_executing === 1,
        ctx.plan.workContinuation !== null,
      ),
    run: (ctx) => {
      const { session } = ctx as SweepSessionContext;
      log.info('Reaping idle scheduled-task container', { sessionId: session.id, threadId: session.thread_id });
      killContainer(session.id, 'scheduled-task-idle');
    },
  });

  registerSweepDuty({
    name: id.S13,
    phase: 'session:health',
    order: 30,
    claims: (ctx) =>
      shouldReapIdleChatContainer(
        ctx.session.thread_id,
        ctx.plan.dueCount,
        ctx.observed!.processingClaimCount,
        ctx.plan.workContinuation !== null,
        ctx.observed!.lastOutboundAtMs,
        ctx.observed!.lastInboundAtMs,
        Date.now(),
      ),
    run: (ctx) => {
      const { session } = ctx as SweepSessionContext;
      log.info('Reaping idle chat container', {
        sessionId: session.id,
        threadId: session.thread_id,
        idleFloorMs: CHAT_IDLE_REAP_MS,
      });
      killContainer(session.id, 'chat-idle-reap');
    },
  });
}

registerIdleReapSweepDuties();
