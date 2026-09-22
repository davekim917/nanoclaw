import { isTaskThread } from '../../db/sessions.js';

/**
 * Scheduled-task containers have no interactive follow-up window to preserve.
 * Once the provider is not executing, no message is claimed, and no work is
 * due, reap the container immediately so background work does not hold a
 * memory reservation until the general 30-minute idle ceiling.
 *
 * This deliberately does NOT key on `provider_status`. Every container clears
 * that column to 'idle' at startup (clearStaleProcessingAcks →
 * clearProviderHealthState,
 * container/agent-runner/src/modules/mailbox/container-state.ts), and only the
 * Codex provider ever writes it again — so for every other provider the old
 * `providerStatus === 'idle'` term was true from second one of the container's
 * life and the guard did nothing. `provider_executing` is the maintained
 * equivalent, and it exists because the other three terms are all things the
 * HOST can see — a due inbound row, a processing claim, a work_continuation
 * record. Work the runner drives on its own behalf shows up in none of them,
 * and every such window was a silent mid-work kill until the runner started
 * publishing this flag (the scope helpers in that same container-state.ts):
 *
 *   - the pre-task script batch, which by design runs BEFORE the rows it
 *     belongs to are claimed and may take NANOCLAW_TASK_SCRIPT_TIMEOUT_MS
 *     (120s default) — several sweep ticks;
 *   - any turn after the first one in a stream: the initial batch is marked
 *     completed at its `result`, so a pushed follow-up turn (wrapping-retry
 *     nudge, post-compaction bootstrap re-injection) and a durable
 *     continuation both execute holding nothing;
 *   - the turn-end git checkpoint, after the batch is already completed.
 *
 * It tracks turns, not stream lifetime — set on the prompt that starts one,
 * cleared on the `result` that ends it — so a container parked in an open
 * multi-turn stream still reaps on the same tick it goes quiet. The turn and
 * the bracketed windows are tracked as separate scopes on the container side,
 * because a pre-task script for an in-turn follow-up runs concurrently with
 * the turn it belongs to; the host sees their union.
 *
 * A container that dies mid-window cannot clear the flag, so the fresh one
 * clears it at startup (clearStaleProcessingAcks) and the 30-minute heartbeat
 * ceiling remains the backstop.
 *
 * An active work_continuation also blocks the reap. `continue_work` is the
 * only sanctioned way to promise follow-up, and between turn end and
 * continuation admission the container has no claim and is not executing —
 * reaping there punished the agent for doing the sanctioned thing and
 * demoted it to the throttled 10-minute host recovery path. The chat path
 * has always guarded this; the task path now matches.
 */
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
