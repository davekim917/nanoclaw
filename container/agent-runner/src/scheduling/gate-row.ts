/**
 * One outbound gate row per pre-task script execution, written BEFORE the occurrence is acked. `in_reply_to` stays
 * null (any answering row would settle the occurrence before its ack), and no `auto` flag, so a host without the
 * gate lane treats it as a run-log note.
 */
import { randomUUID } from 'node:crypto';

import { writeMessageOut } from '../db/messages-out.js';

/** false = not written; the caller leaves the occurrence unacked so it reruns. */
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
