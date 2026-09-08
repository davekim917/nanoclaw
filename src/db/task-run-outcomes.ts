/**
 * The queryable record of what a scheduled task run actually DID — see
 * migration 075 for the incident, and for why the occurrence row's own status
 * cannot answer this.
 *
 * One row per automatic task-run summary. The runner writes that summary as a
 * `task_log` outbound row carrying the provider's own `isError` bit, and
 * `delivery.ts` records it here on the way to the series run log — so the
 * outcome is a byproduct of a path that already runs, not a second reporting
 * channel that can rot independently.
 */
import { getDb } from './connection.js';

/** How long a run outcome is retained before the sweep's prune drops it. */
export const TASK_RUN_OUTCOME_RETENTION_DAYS = 30;

export interface TaskRunOutcomeInsert {
  agentGroupId: string;
  sessionId: string;
  seriesId: string;
  /** The `task_log` outbound row id — the idempotency key for a redelivery. */
  outboundId: string;
  outcome: 'ok' | 'failed';
  /** The model the turn actually ran on, as the runner resolved it. */
  model: string | null;
  /** Final text (truncated, secret-scrubbed) — for a failure, the error. */
  detail: string | null;
}

/** Newest-first slice of a series' history, as the streak reader needs it. */
export interface TaskRunOutcomeRow {
  id: number;
  outcome: 'ok' | 'failed';
  model: string | null;
  detail: string | null;
  recorded_at: string;
  escalated_at: string | null;
}

/**
 * Record one run outcome.
 *
 * `INSERT OR IGNORE`: delivery retries the same outbound row after a transient
 * failure, and a redelivery is the SAME fire — counting it twice would inflate
 * a streak into an escalation nobody's task earned.
 */
export async function recordTaskRunOutcome(row: TaskRunOutcomeInsert): Promise<void> {
  await getDb().run(
    `INSERT OR IGNORE INTO task_run_outcomes
       (agent_group_id, session_id, series_id, outbound_id, outcome, model, detail, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    row.agentGroupId,
    row.sessionId,
    row.seriesId,
    row.outboundId,
    row.outcome,
    row.model,
    row.detail,
    new Date().toISOString(),
  );
}

/**
 * The series the escalation sweep has to look at — those holding a failure.
 *
 * A series whose history is all successes has a zero streak by construction, so
 * scanning it would buy a query a tick per healthy task forever.
 */
export async function listSeriesWithFailures(): Promise<Array<{ agent_group_id: string; series_id: string }>> {
  return getDb().all<{ agent_group_id: string; series_id: string }>(
    "SELECT DISTINCT agent_group_id, series_id FROM task_run_outcomes WHERE outcome = 'failed'",
  );
}

/**
 * The series' current failure episode: how long it is, whether it has already
 * been escalated, when it started, and the failure that ends it.
 *
 * ONE statement, deliberately. The earlier version read the last-success
 * boundary and then aggregated above it as two awaited operations, so a success
 * inserted by `delivery.ts` between them was counted by the aggregate — which
 * bounded by id, not outcome — and reported as another failure. A recovering
 * task could be alerted on at the exact moment it recovered, off a streak that
 * never existed. Two guards, because either alone leaves a hole:
 *
 *   - the whole read is a single statement, so boundary, count and newest row
 *     share one snapshot (a driver transaction is NOT an option here: the fork
 *     holds the "zero open driver transactions" invariant that
 *     `src/db/raw-db-ratchet.test.ts` and `transaction-closures.test.ts` both
 *     pin, and a read is not worth breaking it for);
 *   - the episode rows are filtered `outcome = 'failed'` rather than trusted to
 *     be failures by virtue of sitting above the boundary.
 *
 * Aggregates, not a row walk: `COUNT(*)` is the exact streak at any length and
 * `COUNT(escalated_at)` — which counts non-nulls — answers "already escalated"
 * over the WHOLE episode, so no read window can hide the marker. Only the
 * newest failure's fields are selected, because only it is rendered.
 *
 * Derived from history rather than stored as a counter, for the same reason
 * `trailingFailedRuns` is: a stored counter has to be reset by somebody, and
 * the somebody goes missing on exactly the paths that fail.
 */
export async function readFailureStreak(
  agentGroupId: string,
  seriesId: string,
): Promise<{ streak: number; escalated: boolean; firstFailureAt: string | null; newest: TaskRunOutcomeRow | null }> {
  const row = await getDb().get<{
    streak: number;
    stamped: number;
    first_failure_at: string | null;
    newest_id: number | null;
    newest_model: string | null;
    newest_detail: string | null;
    newest_recorded_at: string | null;
    newest_escalated_at: string | null;
  }>(
    `WITH episode AS (
       SELECT id, model, detail, recorded_at, escalated_at
         FROM task_run_outcomes
        WHERE agent_group_id = :ag
          AND series_id = :series
          AND outcome = 'failed'
          AND id > COALESCE(
                (SELECT MAX(ok.id)
                   FROM task_run_outcomes ok
                  WHERE ok.agent_group_id = :ag
                    AND ok.series_id = :series
                    AND ok.outcome = 'ok'),
                0)
     )
     SELECT (SELECT COUNT(*) FROM episode)                                  AS streak,
            (SELECT COUNT(escalated_at) FROM episode)                       AS stamped,
            (SELECT MIN(recorded_at) FROM episode)                          AS first_failure_at,
            (SELECT id FROM episode ORDER BY id DESC LIMIT 1)               AS newest_id,
            (SELECT model FROM episode ORDER BY id DESC LIMIT 1)            AS newest_model,
            (SELECT detail FROM episode ORDER BY id DESC LIMIT 1)           AS newest_detail,
            (SELECT recorded_at FROM episode ORDER BY id DESC LIMIT 1)      AS newest_recorded_at,
            (SELECT escalated_at FROM episode ORDER BY id DESC LIMIT 1)     AS newest_escalated_at`,
    { ag: agentGroupId, series: seriesId },
  );

  const streak = row?.streak ?? 0;
  if (streak === 0 || row?.newest_id == null) {
    return { streak: 0, escalated: false, firstFailureAt: null, newest: null };
  }
  return {
    streak,
    escalated: (row.stamped ?? 0) > 0,
    firstFailureAt: row.first_failure_at,
    newest: {
      id: row.newest_id,
      outcome: 'failed',
      model: row.newest_model,
      detail: row.newest_detail,
      recorded_at: row.newest_recorded_at!,
      escalated_at: row.newest_escalated_at,
    },
  };
}

/** Stamp the episode onto the failure that triggered it. */
export async function markEscalated(outcomeId: number): Promise<void> {
  await getDb().run('UPDATE task_run_outcomes SET escalated_at = ? WHERE id = ?', new Date().toISOString(), outcomeId);
}

/**
 * Drop outcomes past the retention window — but never one belonging to a
 * failure episode that is still open.
 *
 * Age alone is the wrong predicate. A series broken continuously for longer
 * than the retention window would have its STAMPED failure deleted while newer
 * failures survived, so `readFailureStreak` would report `escalated: false` and
 * alert again — then again each time the new marker aged out. That is the
 * capped-slice bug from round 1 wearing a different hat: the marker outliving
 * its episode is the actual invariant, and a row limit and a time limit both
 * violate it.
 *
 * So the delete is bounded by the episode boundary, not just the clock: a row
 * survives if it sits above its series' most recent success. A series with no
 * success at all has `COALESCE(..., 0)`, so `id <= 0` matches nothing and its
 * entire history is preserved — correct, because all of it is one live episode.
 * Closed history still ages out normally.
 */
export async function pruneTaskRunOutcomes(retentionDays = TASK_RUN_OUTCOME_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await getDb().run(
    `DELETE FROM task_run_outcomes
      WHERE recorded_at < ?
        AND id <= COALESCE(
              (SELECT MAX(ok.id)
                 FROM task_run_outcomes ok
                WHERE ok.agent_group_id = task_run_outcomes.agent_group_id
                  AND ok.series_id = task_run_outcomes.series_id
                  AND ok.outcome = 'ok'),
              0)`,
    cutoff,
  );
  return result.changes;
}
