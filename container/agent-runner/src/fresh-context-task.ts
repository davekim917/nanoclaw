/**
 * Scheduled task fires start with a fresh provider conversation by default,
 * through the same reset `/clear` uses. A task row keeps the session's
 * conversation only when it is (host src/modules/scheduling/fresh-context.ts):
 *   - thread-bound: its row routes into one specific thread (`thread_id` set,
 *     stamped at creation by `ncl tasks create --thread` / `--thread-id`,
 *     src/cli/resources/tasks.ts:308-329, and carried to every re-arm,
 *     src/modules/mailbox/ops/tasks.ts:330);
 *   - marked `continuous: true` (`ncl tasks create|update --continuous`);
 *   - a keyed `ncl tasks dispatch` event (`content.dispatch`), whose context key
 *     exists so events of one phase share a session (docs/keyed-task-dispatch.md:3); or
 *   - a retry of an interrupted fire (`tries > 0`).
 *
 * Only a batch made entirely of such fresh task rows resets, the same
 * conservative rule `quietStatus` follows (formatter.ts:287-308): any non-task
 * row in the batch (a chat message, a `wait` wake, a recovery notice) is input
 * to the existing conversation, and resetting under it would drop the memory
 * that row was sent to. System rows (recall context) are ignored, as there.
 * Task rows only ever land in their series' own task session (host
 * `resolveTaskSession`, src/session-manager.ts:428-444), never a chat session.
 */
import type { MessageInRow } from './db/messages-in.js';
import { hasFutureSelfWake } from './modules/mailbox/reads.js';
import { getWorkContinuation } from './modules/mailbox/session-state.js';

/** Whether this one task row's fire starts fresh. */
export function taskRowFiresFresh(m: MessageInRow): boolean {
  if (m.kind !== 'task') return false;
  if (m.thread_id) return false;
  // A retry of an interrupted fire (host stale sweep or crash deferral bump
  // `tries`) resumes the session that attempt stored at `init`, so it can see
  // the work it already did instead of redoing it blind.
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
 * Earlier work in this session that still needs its conversation: a queued or
 * running `continue_work` record, or a `wait` wake that is not yet due (host
 * row `schedule-wake-<id>`, src/modules/scheduled-wake/index.ts:96). A fire
 * that comes due meanwhile resumes instead of resetting under that work, so
 * the wake or continuation later lands in the conversation that set it.
 */
export function sessionHasOpenWork(): boolean {
  return getWorkContinuation() !== undefined || hasFutureSelfWake();
}

/** Whether this batch is a scheduled fire that resets the conversation now. */
export function startsFreshFire(messages: MessageInRow[]): boolean {
  return isFreshContextTaskBatch(messages) && !sessionHasOpenWork();
}
