import { isTaskThread } from '../../db/sessions.js';

/** Shared execution-idle conjunction; future obligations are a separate settlement check. */
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
