/**
 * The queryable record of what a scheduled task run actually DID — see
 * migration 075 for the incident, and for why the occurrence row's own status
 * cannot answer this.
 *
 * Two lanes, kept apart by `source` so neither can end the other's episode:
 *
 *   - `turn`: one row per automatic task-run summary. The runner writes that
 *     summary as a `task_log` outbound row carrying the provider's own
 *     `isError` bit, and `delivery.ts` records it on the way to the run log.
 *   - `gate`: one row per occurrence whose pre-task script ran, keyed
 *     `'gate:' || <occurrence id>` and overwritten by every re-execution, so
 *     the row is always the result the occurrence acted on (migration 084).
 */
import type { GateObservation } from '../modules/scheduling/observation.js';
import { getDb } from './connection.js';

export type OutcomeLane = 'turn' | 'gate';

/** How long a run outcome is retained before the sweep's prune drops it. */
const TASK_RUN_OUTCOME_RETENTION_DAYS = 30;

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

export interface GateOutcomeUpsert {
  agentGroupId: string;
  sessionId: string;
  seriesId: string;
  occurrenceId: string;
  observation: GateObservation;
  outcome: 'ok' | 'failed';
  boundMs: number | null;
  since: string | null;
  detail: string | null;
}

/**
 * Record one execution of an occurrence's pre-task script, replacing any
 * earlier execution of the same occurrence. `escalated_at` is not assigned, so
 * an alert already delivered for this row stays delivered.
 */
export async function upsertGateOutcome(row: GateOutcomeUpsert): Promise<void> {
  await getDb().run(
    `INSERT INTO task_run_outcomes
       (agent_group_id, session_id, series_id, outbound_id, outcome, model, detail, recorded_at,
        source, observation, bound_ms, since)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'gate', ?, ?, ?)
     ON CONFLICT (session_id, outbound_id) DO UPDATE SET
       agent_group_id = excluded.agent_group_id,
       series_id      = excluded.series_id,
       outcome        = excluded.outcome,
       model          = NULL,
       detail         = excluded.detail,
       recorded_at    = excluded.recorded_at,
       source         = 'gate',
       observation    = excluded.observation,
       bound_ms       = excluded.bound_ms,
       since          = excluded.since`,
    row.agentGroupId,
    row.sessionId,
    row.seriesId,
    `gate:${row.occurrenceId}`,
    row.outcome,
    row.detail,
    new Date().toISOString(),
    row.observation,
    row.boundMs,
    row.since,
  );
}

/**
 * The lanes the escalation sweep has to look at: those whose newest row
 * failed, which is exactly the lanes with a non-empty failure episode.
 */
export async function listSeriesWithFailures(): Promise<
  Array<{ agent_group_id: string; series_id: string; source: OutcomeLane }>
> {
  return getDb().all<{ agent_group_id: string; series_id: string; source: OutcomeLane }>(
    `SELECT t.agent_group_id, t.series_id, t.source
       FROM task_run_outcomes t
       JOIN (SELECT MAX(id) AS id FROM task_run_outcomes GROUP BY agent_group_id, series_id, source) newest
         ON newest.id = t.id
      WHERE t.outcome = 'failed'`,
  );
}

/**
 * The turn lane's current failure episode: how long it is, whether it has
 * already been escalated, when it started, and the failure that ends it.
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
          AND source = 'turn'
          AND outcome = 'failed'
          AND id > COALESCE(
                (SELECT MAX(ok.id)
                   FROM task_run_outcomes ok
                  WHERE ok.agent_group_id = :ag
                    AND ok.series_id = :series
                    AND ok.source = 'turn'
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

/** The gate lane's open episode, aggregated in one statement. */
export interface GateEpisode {
  rows: number;
  escalated: boolean;
  /** Earliest `recorded_at` in the episode. */
  firstRecordedAt: string;
  /** Earliest declared `since` in the episode, if any row declared one. */
  earliestSince: string | null;
  /** Smallest bound in the episode: a newer bound can shorten the deadline, never extend it. */
  boundMs: number | null;
  newest: {
    id: number;
    observation: GateObservation | null;
    detail: string | null;
    recorded_at: string;
  };
}

/**
 * The run of consecutive non-ok gate rows after the lane's last ok, or null
 * when the lane's newest row is ok (or the lane is empty).
 */
export async function readGateEpisode(agentGroupId: string, seriesId: string): Promise<GateEpisode | null> {
  const row = await getDb().get<{
    rows: number;
    stamped: number;
    first_recorded_at: string | null;
    earliest_since: string | null;
    bound_ms: number | null;
    newest_id: number | null;
    newest_observation: GateObservation | null;
    newest_detail: string | null;
    newest_recorded_at: string | null;
  }>(
    `WITH episode AS (
       SELECT id, observation, detail, recorded_at, escalated_at, bound_ms, since
         FROM task_run_outcomes
        WHERE agent_group_id = :ag
          AND series_id = :series
          AND source = 'gate'
          AND outcome = 'failed'
          AND id > COALESCE(
                (SELECT MAX(ok.id)
                   FROM task_run_outcomes ok
                  WHERE ok.agent_group_id = :ag
                    AND ok.series_id = :series
                    AND ok.source = 'gate'
                    AND ok.outcome = 'ok'),
                0)
     )
     SELECT (SELECT COUNT(*) FROM episode)                                   AS rows,
            (SELECT COUNT(escalated_at) FROM episode)                        AS stamped,
            (SELECT MIN(recorded_at) FROM episode)                           AS first_recorded_at,
            (SELECT MIN(since) FROM episode)                                 AS earliest_since,
            (SELECT MIN(bound_ms) FROM episode)                              AS bound_ms,
            (SELECT id FROM episode ORDER BY id DESC LIMIT 1)                AS newest_id,
            (SELECT observation FROM episode ORDER BY id DESC LIMIT 1)       AS newest_observation,
            (SELECT detail FROM episode ORDER BY id DESC LIMIT 1)            AS newest_detail,
            (SELECT recorded_at FROM episode ORDER BY id DESC LIMIT 1)       AS newest_recorded_at`,
    { ag: agentGroupId, series: seriesId },
  );
  if (!row || row.rows === 0 || row.newest_id == null || row.first_recorded_at == null) return null;
  return {
    rows: row.rows,
    escalated: row.stamped > 0,
    firstRecordedAt: row.first_recorded_at,
    earliestSince: row.earliest_since,
    boundMs: row.bound_ms,
    newest: {
      id: row.newest_id,
      observation: row.newest_observation,
      detail: row.newest_detail,
      recorded_at: row.newest_recorded_at!,
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
 * survives if it sits above the most recent success in its series' own lane. A series with no
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
                  AND ok.source = task_run_outcomes.source
                  AND ok.outcome = 'ok'),
              0)`,
    cutoff,
  );
  return result.changes;
}
