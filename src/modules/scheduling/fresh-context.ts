/**
 * Scheduled task fires start with a fresh provider conversation by default
 * (operator rule, 2026-09-22): independent sessions every fire unless a series
 * is explicitly continuous. The runner applies it
 * (container/agent-runner/src/fresh-context-task.ts); this side writes the
 * `continuous` flag, reports the effective mode, and builds the fire's recall
 * for a reset context.
 *
 * Why it matters: a series keeps ONE task session for its whole life
 * (`resolveTaskSession`, src/session-manager.ts:428-444), and the agent-runner
 * resumes that session's stored continuation on every batch
 * (container/agent-runner/src/poll-loop.ts:456; the only other resets are
 * rotation, :463-471, and /clear, :656-660), so context compounded fire after
 * fire. The reset clears only the provider continuation; the session row, its
 * id and `thread_id = system:tasks:<seriesId>` are untouched.
 *
 * A fire keeps the conversation when its row is thread-bound (`thread_id` set:
 * `ncl tasks create --thread` / `--thread-id`, src/cli/resources/tasks.ts:308-329,
 * carried by every re-arm, src/modules/mailbox/ops/tasks.ts:330), marked
 * `continuous: true`, or a keyed dispatch event (`content.dispatch`,
 * src/modules/mailbox/ops/task-dispatch.ts:152). This mirrors
 * `taskRowFiresFresh` in the runner; keep the two in step. The runner alone
 * also resumes a retry of an interrupted fire (`tries > 0`); recall built here
 * for such a retry just repeats bootstrap context the resumed session has.
 */

/** Whether a scheduled fire of a task row with this routing thread and content starts fresh. */
export function taskFiresFresh(threadId: string | null | undefined, rawContent: string): boolean {
  if (threadId) return false;
  try {
    const c = JSON.parse(rawContent) as { continuous?: unknown; dispatch?: unknown } | null;
    return c?.continuous !== true && c?.dispatch === undefined;
  } catch {
    return false;
  }
}
