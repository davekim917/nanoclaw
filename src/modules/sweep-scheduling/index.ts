/**
 * Scheduling + thread-close — S2-PR11 (docs/specs/upstream-host-sweep-seam/plan.md).
 *
 * Four duties, three of them the scheduled-task lifecycle and one the
 * operator-confirmed thread close:
 *
 *   T8 `thread-close-advance`   tick:post-session 20
 *   S5 `due-wake-admission`     session:plan 40   (host-gated scripts + admission + priority)
 *   S18 `recurrence-fanout`     session:tail 20
 *   S19 `spent-task-session-gc` session:tail 30   (strictly after S18 — constraint 13)
 *
 * The duties preserve the host sweep's ordering and session-window ownership.
 * S19 additionally preserves recall-paired waits and durable continuations;
 * it does not add a wake path. Nothing here kills or wakes, so every body runs
 * inside the window the driver already opened and holds no second session on
 * the same key (constraint 18, invariant I-3):
 * `runHostGatedTaskScripts` and `handleRecurrence` take the sweep's OWN
 * session as their first parameter (mailbox seam PR 4) rather than opening
 * one of their own.
 */
import { isContainerRunning } from '../../container-runner.js';
import { advanceThreadClosures } from '../../dashboard/thread-close.js';
import { hasUnresolvedMoveIntent } from '../../dashboard/api/scheduled-shared.js';
import { isTaskThread, updateSession } from '../../db/sessions.js';
import {
  SWEEP_DUTY_INVENTORY,
  asSessionContext,
  registerSweepDuty,
  registerSweepDutySource,
} from '../../host-sweep.js';
import { log } from '../../log.js';
import { admitDueTaskContexts } from '../../session-manager.js';
import { expireClosedSessionWork } from '../../session-close-expiry.js';
import type { NanoclawMailboxSession } from '../mailbox/index.js';
import { runHostGatedTaskScripts } from '../scheduling/host-script.js';

/** A per-task session with no live work and no running container is spent → close it. */
export function shouldCloseTaskSession(
  threadId: string | null,
  containerRunning: boolean,
  liveTaskCount: number,
  hasPendingRecallPairedTrigger: boolean,
  hasWorkContinuation: boolean,
): boolean {
  return (
    isTaskThread(threadId) &&
    !containerRunning &&
    liveTaskCount === 0 &&
    !hasPendingRecallPairedTrigger &&
    !hasWorkContinuation
  );
}

async function prepareDueWake(
  mailbox: NanoclawMailboxSession,
  agentGroupId: string,
  sessionId: string,
): Promise<{ admittedTasks: number; dueCount: number; wakePriority: 'interactive' | 'scheduled' }> {
  // Fleet-hardening Phase 1.1: run any opted-in (scriptHost) pre-task scripts
  // on the host BEFORE admission, so a gated/errored fire never becomes due
  // and never spawns a container. See host-script.ts's runHostGatedTaskScripts.
  //
  // `runHostGatedTaskScripts` and `admitDueTaskContexts` both take this
  // session: they are sweep callees with no other production caller, and a
  // SESSION parameter is the seam's sanctioned object — invariant I-9 forbids
  // handing out raw handles, not sessions, so neither callee lands on the
  // ratchet's allowlist. The script runner can spend the full pre-task timeout
  // per row, so the session is held across that work exactly as it was when
  // these lines passed a raw handle.
  //
  // `agentGroupId` rides along because the callee resolves the GROUP's
  // timezone for its local-time gate: a session parameter identifies the
  // mailbox, not the group whose zone override applies.
  await runHostGatedTaskScripts(mailbox, agentGroupId, sessionId);
  const admittedTasks = await admitDueTaskContexts(mailbox, agentGroupId, sessionId);
  const dueCount = mailbox.countDueMessages();
  return {
    admittedTasks,
    dueCount,
    wakePriority: dueCount > 0 ? mailbox.getDueWakePriority() : 'interactive',
  };
}

export async function _prepareDueWakeForTesting(
  mailbox: NanoclawMailboxSession,
  agentGroupId: string,
  sessionId: string,
): Promise<{ admittedTasks: number; dueCount: number; wakePriority: 'interactive' | 'scheduled' }> {
  return prepareDueWake(mailbox, agentGroupId, sessionId);
}

export function registerSchedulingSweepDuties(): void {
  const id = SWEEP_DUTY_INVENTORY;

  registerSweepDuty({
    name: id.S5,
    phase: 'session:plan',
    order: 40,
    // 3. Admit due scheduled occurrences and lifecycle wakes with fresh
    // recall/capabilities immediately before they become wakeable. Task rows
    // stay trigger=0 from creation through this point; paired lifecycle wakes
    // stay trigger=0 throughout backoff. A warm poller cannot race ahead of
    // either context pair, and a repeated sweep is idempotent.
    run: async (ctx) => {
      const { session, agentGroupId, mailbox, plan } = asSessionContext(ctx);
      const preparedWake = await prepareDueWake(mailbox!, agentGroupId, session.id);
      plan.admittedTasks = preparedWake.admittedTasks;
      plan.dueCount = preparedWake.dueCount;
      plan.wakePriority = preparedWake.wakePriority;
      if (plan.admittedTasks > 0) {
        log.debug('Admitted due turns with fresh context', {
          sessionId: session.id,
          count: plan.admittedTasks,
        });
      }
    },
  });

  registerSweepDuty({
    name: id.S18,
    phase: 'session:tail',
    order: 20,
    // 8. Recurrence fanout for completed recurring tasks.
    // MODULE-HOOK:scheduling-recurrence:start
    // Takes this session (mailbox seam PR 4). Same rule as
    // `runHostGatedTaskScripts` in prepareDueWake: a sweep callee with no other
    // production caller receives the sweep's session, never a raw handle and
    // never its own nested open on the same key.
    run: async (ctx) => {
      const { session, mailbox } = asSessionContext(ctx);
      const { handleRecurrence } = await import('../scheduling/recurrence.js');
      await handleRecurrence(mailbox!, session);
    },
    // MODULE-HOOK:scheduling-recurrence:end
  });

  registerSweepDuty({
    name: id.S19,
    phase: 'session:tail',
    order: 30,
    // 9. GC spent task sessions. A task session is spent only after its live
    // task rows, recall-paired waits, and durable continuation are all gone and
    // no container is running. A future `wait` is inert (trigger=0) until due,
    // but it still needs this same active session for admission and respawn.
    // Runs after recurrence so a just-fired recurring series has already
    // re-armed its next pending row and is never collected. The per-task log
    // file in the workspace is the durable history and survives the close.
    run: async (ctx) => {
      const { session, mailbox } = asSessionContext(ctx);
      if (isTaskThread(session.thread_id)) {
        const liveTasks = mailbox!.countLiveTasks();
        const hasPendingWait = mailbox!.hasPendingRecallPairedTrigger();
        const hasWorkContinuation = mailbox!.readContinuationPresence() !== null;
        if (
          !shouldCloseTaskSession(
            session.thread_id,
            isContainerRunning(session.id),
            liveTasks,
            hasPendingWait,
            hasWorkContinuation,
          )
        ) {
          return;
        }
        // A move in flight looks EXACTLY like a spent session: it cancels the
        // source series before inserting into the target, so between those two
        // steps the source holds zero live rows and no container. Closing it
        // here is unrecoverable — `recoverMoveIntents` only acts on intents
        // older than one sweep interval, so it always arrives after this duty,
        // and its restore's `withQuietInvalidationSync` refuses on a session
        // row that is no longer active. The intent then stays unresolved and
        // the series stays cancelled, with nothing left that can repair it.
        //
        // Asked only once the cheap predicate above has already said "close",
        // so the ordinary spent session pays one central-DB read and a live
        // one pays nothing.
        if (await hasUnresolvedMoveIntent(session.id)) {
          log.info('Kept a spent task session open — an unresolved move intent still names it', {
            sessionId: session.id,
            threadId: session.thread_id,
          });
          return;
        }
        // Revalidate on the mailbox AFTER the only await on this path. A task,
        // paired wait, or continuation can land while the intent check yields;
        // closing it would strand work in a session no sweep visits again. No
        // await may sit between these reads and the UPDATE: the SQLite reads
        // run synchronously, so the decision and close share one turn.
        const workArrived =
          mailbox!.countLiveTasks() > 0 ||
          mailbox!.hasPendingRecallPairedTrigger() ||
          mailbox!.readContinuationPresence() !== null;
        if (workArrived) {
          log.info('Kept a spent task session open — work arrived during the intent check', {
            sessionId: session.id,
            threadId: session.thread_id,
          });
          return;
        }
        await updateSession(session.id, { status: 'closed' });
        // The ONLY active->closed transition on the host, and therefore the
        // whole of #520's leak: `expireStalePending` runs as duty S3 inside a
        // loop over ACTIVE sessions, so anything still `pending` here is out
        // of its reach the moment the row above flips, and pins the session
        // directory against reclaim forever via `sessionHasOpenWork`.
        //
        // Ordered AFTER the close, not before: the close is what makes the
        // expiry correct, so a failed `updateSession` must leave the rows
        // live. A crash in the gap is repaired by
        // `drainClosedSessionPendingBacklog` at the next boot. Nothing can
        // insert into this inbound in the gap — `findSessionForAgent` matches
        // active rows only. Uses the sweep's OWN session, never a second one
        // on the same key (constraint 18, invariant I-3).
        expireClosedSessionWork(mailbox!, session.id, 'spent-task-session-gc');
        log.info('Closed spent task session', { sessionId: session.id, threadId: session.thread_id });
      }
    },
  });

  registerSweepDuty({
    name: id.T8,
    phase: 'tick:post-session',
    order: 20,
    // Advance operator-confirmed thread closes: wait for the agent's wrap-up
    // confirmation, then clear its saved work, stop the container and archive —
    // in that order (src/dashboard/thread-close.ts). Central-DB scan of the few
    // in-flight rows, once per tick, after the per-session loop so container
    // state is current. Nothing here can START a close; only an operator can.
    run: async () => {
      try {
        // Awaited (mailbox seam PR 4): the close path became asynchronous when
        // its proposal reads moved behind the funnel, and an unawaited call
        // would let the tick finish while the close is still mid-flight —
        // rejections escaping this catch, and the duty reporting success it
        // has not had.
        await advanceThreadClosures();
      } catch (err) {
        log.warn('thread-close sweep step failed', { err });
      }
    },
  });
}

registerSweepDutySource('sweep-scheduling', registerSchedulingSweepDuties);
