/**
 * Scheduled fires start a fresh provider conversation unless the series is
 * `continuous` or the row is a keyed dispatch event. A series keeps ONE task
 * session for life and the runner resumes its continuation every batch, so
 * context would otherwise compound fire after fire. A thread-bound row still
 * starts fresh: the thread is where it posts, not a conversation it resumes.
 * Mirrors the runner's `taskRowFiresFresh`; keep the two in step.
 */

export function taskFiresFresh(rawContent: string): boolean {
  try {
    const c = JSON.parse(rawContent) as { continuous?: unknown; dispatch?: unknown } | null;
    return c?.continuous !== true && c?.dispatch === undefined;
  } catch {
    return false;
  }
}
