/**
 * A scheduled task fire starts a fresh provider conversation unless the row is
 * `continuous`, a keyed `dispatch` event, or a retry (`tries > 0`); mirror of host
 * src/modules/scheduling/fresh-context.ts. Only an all-task batch resets (system
 * rows ignored): any other row is input to the existing conversation, and
 * resetting under it drops the memory it was sent to. A thread-bound task row
 * still starts fresh: task rows only land in their own task session.
 */
import type { MessageInRow } from './db/messages-in.js';
import { hasFutureSelfWake } from './modules/mailbox/reads.js';
import { getWorkContinuation } from './modules/mailbox/session-state.js';

export function taskRowFiresFresh(m: MessageInRow): boolean {
  if (m.kind !== 'task') return false;
  // A retry resumes the session its interrupted attempt stored, so it sees the work already done.
  if (m.tries > 0) return false;
  try {
    const c = JSON.parse(m.content) as { continuous?: unknown; dispatch?: unknown } | null;
    return c?.continuous !== true && c?.dispatch === undefined;
  } catch {
    return false;
  }
}

export function isFreshContextTaskBatch(messages: MessageInRow[]): boolean {
  const substantive = messages.filter((m) => m.kind !== 'system');
  return substantive.length > 0 && substantive.every(taskRowFiresFresh);
}

/**
 * An open `continue_work` or a not-yet-due `wait` wake: a fire due meanwhile
 * resumes, so that work later lands in the conversation that set it.
 */
export function sessionHasOpenWork(): boolean {
  return getWorkContinuation() !== undefined || hasFutureSelfWake();
}

export function startsFreshFire(messages: MessageInRow[]): boolean {
  return isFreshContextTaskBatch(messages) && !sessionHasOpenWork();
}
