/**
 * Idle reaps on the `session:health` exclusive chain: heal (10) → task reap
 * (20) → chat reap (30) → SLA (40). Known hazard: the task idle reaper can
 * kill a task-script container mid-run.
 */
import { isTaskThread } from '../../db/sessions.js';
import { killContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { isContinuationParked, type HostWorkContinuation } from '../mailbox/index.js';
import {
  registerSweepDuty,
  registerSweepDutySource,
  SWEEP_DUTY_INVENTORY,
  type SweepSessionContext,
} from '../../host-sweep.js';

import { shouldReapIdleTaskContainer } from './task-idle.js';
export { shouldReapIdleTaskContainer } from './task-idle.js';

const id = SWEEP_DUTY_INVENTORY;

function holdsLiveContinuation(continuation: HostWorkContinuation | null): boolean {
  return continuation !== null && !isContinuationParked(continuation);
}

/**
 * Chat containers get a quiet-duration floor before reaping (a human may reply
 * within seconds). Keys on provider-agnostic signals, not `provider_status`
 * (only Codex writes it past startup). `provider_executing` must block the
 * reap: a turn waiting on a background agent emits nothing and holds no row,
 * claim or continuation, so message quiet is not idleness.
 */
export const CHAT_IDLE_REAP_MS = 15 * 60 * 1000;

export function shouldReapIdleChatContainer(
  threadId: string | null,
  dueMessageCount: number,
  processingClaimCount: number,
  providerExecuting: boolean,
  hasActiveContinuation: boolean,
  lastOutboundAtMs: number | null,
  lastInboundAtMs: number | null,
  now: number,
): boolean {
  if (isTaskThread(threadId)) return false; // task threads use shouldReapIdleTaskContainer
  if (dueMessageCount !== 0 || processingClaimCount !== 0 || hasActiveContinuation) return false;
  if (providerExecuting) return false;
  if (lastOutboundAtMs === null) return false;
  // Idleness is the newest activity in EITHER direction: a container that has
  // consumed a fresh message but not yet emitted anything looks idle from
  // outbound alone, and no other guard covers it.
  const lastActivityAtMs = Math.max(lastOutboundAtMs, lastInboundAtMs ?? 0);
  return now - lastActivityAtMs >= CHAT_IDLE_REAP_MS;
}

function registerIdleReapSweepDuties(): void {
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
        holdsLiveContinuation(ctx.plan.workContinuation),
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
        ctx.observed!.containerState?.provider_executing === 1,
        holdsLiveContinuation(ctx.plan.workContinuation),
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

registerSweepDutySource('sweep-idle-reap', registerIdleReapSweepDuties);
