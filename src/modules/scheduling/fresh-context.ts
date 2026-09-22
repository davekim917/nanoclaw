/**
 * Per-series `freshContext` (`ncl tasks create|update --fresh-context`): every
 * scheduled fire of the series starts with no resumed provider conversation.
 *
 * A series keeps ONE task session for its whole life
 * (`resolveTaskSession`, src/session-manager.ts:428-444), and the agent-runner
 * resumes that session's stored continuation on every batch
 * (container/agent-runner/src/poll-loop.ts, `migrateLegacyContinuation`). For a
 * watcher that keeps its state in files, the resumed conversation only grows
 * the context each fire pays for. The runner reads the flag
 * (container/agent-runner/src/fresh-context-task.ts); this side only
 * writes and reports it. Absent = false, so every existing series is unchanged.
 */

/** Whether a task row's content carries `freshContext: true`. */
export function taskFreshContext(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { freshContext?: unknown } | null)?.freshContext === true;
  } catch {
    return false;
  }
}
