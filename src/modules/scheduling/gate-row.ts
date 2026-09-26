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
 * Reorder the gate rows among the positions they already hold, by ascending
 * `seq`. Delivery reads in timestamp order, which a backward clock step or an
 * equal timestamp can invert; every other row keeps its place.
 */
export function orderGateRowsBySeq<T extends { kind: string; content: string; seq: number | null }>(rows: T[]): T[] {
  const slots = rows.flatMap((row, index) => (isGateRow(row) ? [index] : []));
  if (slots.length < 2) return rows;
  const bySeq = slots
    .map((index) => rows[index]!)
    .sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));
  const ordered = [...rows];
  slots.forEach((slot, k) => {
    ordered[slot] = bySeq[k]!;
  });
  return ordered;
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
