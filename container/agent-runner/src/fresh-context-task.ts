/**
 * `freshContext` on a task row (`ncl tasks create|update --fresh-context`, host
 * src/modules/scheduling/fresh-context.ts): a scheduled fire of that series
 * starts with no resumed conversation, through the same reset `/clear` uses.
 *
 * Only a batch made entirely of flagged task rows qualifies, the same
 * conservative rule `quietStatus` follows (formatter.ts:287-308): any
 * non-task row in the batch (a chat message, a wake, a recovery notice) is
 * input to the existing conversation, and resetting under it would drop the
 * memory that row was sent to. System rows (recall context) are ignored, as
 * there. A series owns its own task session (host `resolveTaskSession`,
 * src/session-manager.ts:428-444), so a flagged row never lands in a chat
 * session in the first place.
 */
import type { MessageInRow } from './db/messages-in.js';

export function isFreshContextTaskBatch(messages: MessageInRow[]): boolean {
  const substantive = messages.filter((m) => m.kind !== 'system');
  return (
    substantive.length > 0 &&
    substantive.every((m) => {
      if (m.kind !== 'task') return false;
      try {
        return (JSON.parse(m.content) as { freshContext?: unknown } | null)?.freshContext === true;
      } catch {
        return false;
      }
    })
  );
}
