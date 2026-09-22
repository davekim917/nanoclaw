import type Database from 'better-sqlite3';
import { taskThreadId } from '../../../db/sessions.js';
import { shouldReapIdleTaskContainer } from '../../sweep-idle-reap/task-idle.js';
import { countDueMessages, getContainerState, getProcessingClaims } from './sweep.js';
import { readContinuationPresence } from './session-state.js';

export interface TaskSettlement {
  executionSettled: boolean;
  state: 'settled' | 'busy' | 'unknown';
  outcome: 'success' | 'error' | null;
  observedAt: string;
  reason: string;
}

/** Exact automatic single-event outcome. Legacy and batched outcomes cannot settle one event. */
export function readTaskOutcome(outbound: Database.Database, eventId: string): 'success' | 'error' | null {
  const rows = outbound
    .prepare("SELECT content FROM messages_out WHERE kind = 'task_log' AND in_reply_to = ? ORDER BY seq DESC")
    .all(eventId) as Array<{ content: string }>;
  for (const row of rows) {
    try {
      const value = JSON.parse(row.content) as { auto?: unknown; isError?: unknown; taskMessageIds?: unknown };
      if (
        value.auto !== true ||
        !Array.isArray(value.taskMessageIds) ||
        value.taskMessageIds.length !== 1 ||
        value.taskMessageIds[0] !== eventId
      )
        continue;
      if (value.isError !== undefined && typeof value.isError !== 'boolean') return null;
      return value.isError === true ? 'error' : 'success';
    } catch {
      return null;
    }
  }
  return null;
}

/** Host-owned facts only: no prompt, transcript, or artifact interpretation. */
export function readTaskSettlement(
  inbound: Database.Database,
  outbound: Database.Database | null,
  eventId: string,
  threadId: string | null,
  observer = false,
): TaskSettlement {
  const result = (
    state: TaskSettlement['state'],
    reason: string,
    outcome: TaskSettlement['outcome'] = null,
    executionSettled = false,
  ): TaskSettlement => ({ state, reason, outcome, executionSettled, observedAt: new Date().toISOString() });
  if (!outbound) return result('unknown', 'outbound-unavailable');
  try {
    const row = inbound
      .prepare("SELECT status, series_id, recurrence FROM messages_in WHERE id = ? AND kind = 'task'")
      .get(eventId) as { status: string; series_id: string | null; recurrence: string | null } | undefined;
    if (!row) return result('unknown', 'event-unavailable');
    const state = getContainerState(outbound);
    if (!state || (state.provider_executing !== 0 && state.provider_executing !== 1))
      return result('unknown', 'execution-state-unavailable');
    const idle = shouldReapIdleTaskContainer(
      threadId,
      countDueMessages(inbound),
      getProcessingClaims(outbound).length,
      state.provider_executing === 1,
      readContinuationPresence(outbound) !== null,
    );
    const observerSeries =
      observer && row.recurrence && row.series_id && threadId === taskThreadId(row.series_id) ? row.series_id : null;
    const obligations = (
      inbound
        .prepare(
          `SELECT COUNT(*) AS n FROM messages_in
      WHERE status IN ('pending', 'processing', 'paused') AND NOT COALESCE((
        ? IS NOT NULL AND kind = 'task' AND series_id = ? AND recurrence = ?
        AND status = 'pending' AND trigger = 0 AND datetime(process_after) > datetime('now')), 0)`,
        )
        .get(observerSeries, observerSeries, row.recurrence) as { n: number }
    ).n;
    if (!idle || obligations > 0) return result('busy', 'execution-or-input-outstanding');
    // Include future outbound actions: a wait not yet delivered has not become an inbound obligation.
    const delivered = new Set(
      (
        inbound.prepare("SELECT message_out_id FROM delivered WHERE status = 'delivered'").all() as Array<{
          message_out_id: string;
        }>
      ).map((r) => r.message_out_id),
    );
    const actions = outbound.prepare("SELECT id FROM messages_out WHERE kind = 'system'").all() as Array<{
      id: string;
    }>;
    if (actions.some((action) => !delivered.has(action.id))) return result('busy', 'outbound-action-outstanding');
    const outcome = readTaskOutcome(outbound, eventId);
    if (row.status !== 'completed' || outcome === null)
      return result('unknown', 'successful-terminal-outcome-unproven', outcome, true);
    return outcome === 'success'
      ? result('settled', 'successful-idle-event', outcome, true)
      : result('unknown', 'provider-error', outcome, true);
  } catch {
    return result('unknown', 'settlement-unreadable');
  }
}
