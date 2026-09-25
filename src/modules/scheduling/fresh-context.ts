/**
 * Scheduled task fires start with a fresh provider conversation by default
 * (operator rule, 2026-09-22): independent sessions every fire unless a series
 * is explicitly continuous. The runner applies it
 * (container/agent-runner/src/fresh-context-task.ts); this side writes the
 * `continuous` flag, reports the effective mode, and builds the fire's recall
 * for a reset context.
 *
 * Why it matters: a series keeps ONE task session for its whole life
 * (`resolveTaskSession` in src/session-manager.ts), and the agent-runner
 * resumes that session's stored continuation on every batch (its poll loop),
 * so context would compound fire after fire; it resets only on rotation,
 * /clear, or an error recovery (context too long, a stale session). The reset clears only the provider continuation; the session row, its
 * id and `thread_id = system:tasks:<seriesId>` are untouched.
 *
 * A fire keeps the conversation only when its row is marked `continuous: true`
 * or is a keyed dispatch event (`content.dispatch`,
 * src/modules/mailbox/ops/task-dispatch.ts). A thread-bound row (`thread_id`
 * set by `--thread` / `--thread-id`) still starts fresh: the thread is where the
 * fire posts, not a conversation it resumes — every task row lands in its
 * series' own task session (`scheduleTask` → `resolveTaskSession`,
 * src/db/scheduled-tasks.ts), never the thread's chat session. This mirrors
 * `taskRowFiresFresh` in the runner; keep the two in step. The runner alone
 * also resumes a retry of an interrupted fire (`tries > 0`); recall built here
 * for such a retry just repeats bootstrap context the resumed session has.
 */

/** Whether a scheduled fire of a task row with this content starts fresh. */
export function taskFiresFresh(rawContent: string): boolean {
  try {
    const c = JSON.parse(rawContent) as { continuous?: unknown; dispatch?: unknown } | null;
    return c?.continuous !== true && c?.dispatch === undefined;
  } catch {
    return false;
  }
}
