import { isTaskThread } from '../../db/sessions.js';

/**
 * Task containers have no interactive follow-up window, so reap as soon as
 * execution is idle. Keys on `provider_executing`, not `provider_status`: only
 * Codex ever writes the latter past startup, and runner-driven work (pre-task
 * scripts, follow-up turns, turn-end checkpoint) holds no host-visible claim.
 * An active work_continuation also blocks the reap, since between turn end and
 * continuation admission the container holds no claim.
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
