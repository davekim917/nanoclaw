/**
 * What already stands to bring a stopped session back with nobody asking. Shared so the promise watch and the kill
 * follow-up cannot disagree about it. Free of top-level side effects.
 */
import type { NanoclawMailboxSession } from '../mailbox/index.js';

export interface ArmedState {
  dueCount: number;
  nextFutureProcessAfter: string | null;
  hasContinuation: boolean;
}

export function readArmedState(
  mailbox: Pick<NanoclawMailboxSession, 'countDueMessages' | 'getNextFutureProcessAfter' | 'readWorkContinuation'>,
): ArmedState {
  return {
    dueCount: mailbox.countDueMessages(),
    nextFutureProcessAfter: mailbox.getNextFutureProcessAfter(),
    hasContinuation: mailbox.readWorkContinuation() !== null,
  };
}

export type ArmedBy = 'wake-due' | 'wake-pending' | 'continuation-saved';

export function armedBy(state: ArmedState): ArmedBy | null {
  if (state.dueCount > 0) return 'wake-due';
  if (state.nextFutureProcessAfter) return 'wake-pending';
  if (state.hasContinuation) return 'continuation-saved';
  return null;
}
