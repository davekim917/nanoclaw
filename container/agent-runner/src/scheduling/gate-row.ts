/**
 * The runner's half of the scheduled-task gate lane: one outbound row per
 * pre-task script execution, written BEFORE the occurrence is acked or handed
 * to the agent. The host judges and records it; this side only forwards what
 * the script produced.
 *
 * `in_reply_to` stays null: the host sweep completes a pending row that any
 * non-status outbound row answers, which would settle the occurrence before its
 * ack. No `auto` flag either, so a host without the gate lane treats the row as
 * a run-log note and never as a turn outcome.
 */
import { randomUUID } from 'node:crypto';

import { writeMessageOut } from '../db/messages-out.js';

/**
 * Write the gate row for one execution: its parsed result, or `failure` when
 * there is none. Returns false when the row could not be written; the caller
 * then leaves the occurrence unacked so it runs again, rather than acting on a
 * result the host never saw.
 */
export async function writeGateRow(
  occurrenceId: string,
  result: { wakeAgent: boolean; observation?: unknown } | null,
  failure: string,
): Promise<boolean> {
  const gate =
    result === null
      ? { occurrenceId, wakeAgent: false, error: failure }
      : {
          occurrenceId,
          wakeAgent: result.wakeAgent,
          ...(Object.prototype.hasOwnProperty.call(result, 'observation') ? { observation: result.observation } : {}),
        };
  try {
    await writeMessageOut({
      id: `gate-${randomUUID()}`,
      kind: 'task_log',
      in_reply_to: null,
      content: JSON.stringify({ gate }),
    });
    return true;
  } catch (err) {
    console.error(`[task-script] gate row for ${occurrenceId} not written; leaving it unacked: ${String(err)}`);
    return false;
  }
}
