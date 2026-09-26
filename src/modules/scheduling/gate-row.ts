/**
 * Container gate rows: the runner's record of one pre-task script execution,
 * written before it acks the occurrence as a `task_log` outbound row
 * `{"gate":{occurrenceId, wakeAgent, observation?, error?}}` with no `auto`
 * flag and a null `in_reply_to` (a non-null one would let the sweep complete
 * the occurrence as answered before its ack).
 *
 * A crash between the gate row and the ack re-runs the script and writes a
 * second row for the same occurrence. The ledger upsert keeps whichever is
 * recorded last, so rows are recorded in `seq` order and a failed recording is
 * retried in place rather than skipped or given up.
 */
import { taskSeriesId } from '../../db/sessions.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { recordGateResult, type RawGateResult } from './observation.js';

function gatePayload(content: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const gate = (parsed as { gate?: unknown }).gate;
  return gate !== null && typeof gate === 'object' && !Array.isArray(gate) ? (gate as Record<string, unknown>) : null;
}

export function isGateRow(msg: { kind: string; content: string }): boolean {
  return msg.kind === 'task_log' && gatePayload(msg.content) !== null;
}

/**
 * Put every gate row ahead of every row the runner wrote after it (higher
 * `seq`), and the gate rows themselves in `seq` order. Delivery reads in
 * timestamp order, which a backward clock step or an equal timestamp can
 * invert; a failing gate row stops the drain, and that holds back only what
 * was written after it if nothing written after it is ahead of it. The other
 * rows keep their relative order.
 */
export function orderGateRowsBySeq<T extends { kind: string; content: string; seq: number | null }>(rows: T[]): T[] {
  const seqOf = (row: T): number => row.seq ?? Number.MAX_SAFE_INTEGER;
  const gates = rows.filter(isGateRow).sort((a, b) => seqOf(a) - seqOf(b));
  if (gates.length === 0) return rows;
  const ordered: T[] = [];
  let next = 0;
  for (const row of rows) {
    if (isGateRow(row)) continue;
    while (next < gates.length && seqOf(gates[next]!) < seqOf(row)) ordered.push(gates[next++]!);
    ordered.push(row);
  }
  return [...ordered, ...gates.slice(next)];
}

function rawResult(gate: Record<string, unknown>): RawGateResult {
  if (typeof gate.error === 'string') return { error: gate.error };
  if (typeof gate.wakeAgent !== 'boolean') return { error: 'gate row carried neither a result nor an error' };
  return {
    result: Object.prototype.hasOwnProperty.call(gate, 'observation')
      ? { wakeAgent: gate.wakeAgent, observation: gate.observation }
      : { wakeAgent: gate.wakeAgent },
  };
}

/**
 * Record a gate row. Returns false for any other row.
 *
 * The series is the host's, never the container's: a task session's own
 * series, or else the series of the named occurrence in this session's
 * inbound. A container can therefore only record against its own series.
 * Throws when the ledger write fails; delivery then retries the row.
 */
export async function recordGateRow(
  msg: { id: string; kind: string; content: string },
  session: Session,
): Promise<boolean> {
  if (msg.kind !== 'task_log') return false;
  const gate = gatePayload(msg.content);
  if (!gate) return false;

  const occurrenceId = typeof gate.occurrenceId === 'string' && gate.occurrenceId !== '' ? gate.occurrenceId : null;
  const seriesId =
    occurrenceId === null
      ? null
      : (taskSeriesId(session.thread_id) ??
        (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
          mailbox.getTaskOccurrenceSeriesId(occurrenceId),
        )) ??
        null);
  if (occurrenceId === null || seriesId === null) {
    log.error('Gate row names no occurrence of this session — dropped unrecorded', {
      id: msg.id,
      sessionId: session.id,
      occurrenceId,
    });
    return true;
  }

  await recordGateResult({
    agentGroupId: session.agent_group_id,
    sessionId: session.id,
    seriesId,
    occurrenceId,
    raw: rawResult(gate),
  });
  return true;
}
