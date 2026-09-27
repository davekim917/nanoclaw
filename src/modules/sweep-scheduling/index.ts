/**
 * Scheduled-task lifecycle and thread-close duties. Nothing here kills or
 * wakes: every body runs inside the session the driver already opened and
 * never opens a second session on the same key.
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
  // Host-gated pre-task scripts run BEFORE admission, so a gated/errored fire
  // never becomes due. `agentGroupId` is needed because the local-time gate
  // uses the GROUP's timezone, which the session does not identify. A row
  // whose host result could not be recorded is withheld from admission.
  const unrecorded = await runHostGatedTaskScripts(mailbox, agentGroupId, sessionId);
  const admittedTasks = await admitDueTaskContexts(mailbox, agentGroupId, sessionId, unrecorded);
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

function registerSchedulingSweepDuties(): void {
  const id = SWEEP_DUTY_INVENTORY;

  registerSweepDuty({
    name: id.S5,
    phase: 'session:plan',
    order: 40,
    // Task rows and paired lifecycle wakes stay trigger=0 until admitted here,
    // so a warm poller cannot race ahead of their context. Idempotent.
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
    run: async (ctx) => {
      const { session, mailbox, alive } = asSessionContext(ctx);
      const { handleRecurrence } = await import('../scheduling/recurrence.js');
      await handleRecurrence(mailbox!, session);
      // Guarded separately: it changes no state, so its throw must not fail
      // the fan-out that keeps every schedule moving.
      try {
        const { escalateOverdueOccurrences } = await import('../scheduling/overdue.js');
        await escalateOverdueOccurrences(mailbox!, session, alive);
      } catch (err) {
        log.warn('Overdue occurrence check failed', { sessionId: session.id, err });
      }
    },
  });

  registerSweepDuty({
    name: id.S19,
    phase: 'session:tail',
    order: 30,
    // Must run after recurrence (S18) so a just-fired series has re-armed its
    // next row. A future `wait` is inert until due but still needs this session.
    run: async (ctx) => {
      const { session, mailbox } = asSessionContext(ctx);
      if (isTaskThread(session.thread_id)) {
        // Keyed dispatch receipts must stay addressable by the active-session lookup.
        if (mailbox!.hasTaskDispatchEvents()) return;
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
        // A move in flight looks exactly like a spent session (source cancelled
        // before target insert), and closing it is unrecoverable: move recovery
        // runs later and refuses an inactive session.
        if (await hasUnresolvedMoveIntent(session.id)) {
          log.info('Kept a spent task session open — an unresolved move intent still names it', {
            sessionId: session.id,
            threadId: session.thread_id,
          });
          return;
        }
        // Delivery visits active sessions only, so an unrecorded pre-task
        // result would never be recorded after close.
        if (mailbox!.hasUnrecordedGateRows()) {
          log.info('Kept a spent task session open — a pre-task result is not recorded yet', {
            sessionId: session.id,
            threadId: session.thread_id,
          });
          return;
        }
        // Revalidate AFTER the only await on this path; no await may sit
        // between these synchronous reads and the UPDATE.
        const workArrived =
          mailbox!.hasTaskDispatchEvents() ||
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
        // The ONLY active->closed transition, so the one place pending work can
        // leak (S3 expiry only visits active sessions). Ordered AFTER the close
        // so a failed update leaves rows live; a crash in the gap is repaired at
        // boot by `drainClosedSessionPendingBacklog`.
        expireClosedSessionWork(mailbox!, session, 'spent-task-session-gc');
        log.info('Closed spent task session', { sessionId: session.id, threadId: session.thread_id });
      }
    },
  });

  registerSweepDuty({
    name: id.T8,
    phase: 'tick:post-session',
    order: 20,
    // Advance operator-confirmed thread closes. Nothing here can START a
    // close; only an operator can.
    run: async () => {
      try {
        // Awaited, or the duty reports success while the close is mid-flight.
        await advanceThreadClosures();
      } catch (err) {
        log.warn('thread-close sweep step failed', { err });
      }
    },
  });
}

registerSweepDutySource('sweep-scheduling', registerSchedulingSweepDuties);
