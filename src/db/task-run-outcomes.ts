/**
 * What a scheduled task run actually DID (the occurrence row's own status cannot say; see migration 075). Two lanes,
 * kept apart by `source` so neither can end the other's episode: `turn` (one row per task-run summary, carrying the
 * provider's `isError` bit, recorded by `delivery.ts`) and `gate` (one row per occurrence whose pre-task script ran,
 * keyed `'gate:'
 * <occurrence id>` and overwritten by each re-execution).
 */
import type { GateObservation } from '../modules/scheduling/observation.js';
import { getDb } from './connection.js';

export type OutcomeLane = 'turn' | 'gate';

const TASK_RUN_OUTCOME_RETENTION_DAYS = 30;

export interface TaskRunOutcomeInsert {
  agentGroupId: string;
  sessionId: string;
  seriesId: string;
  /** The `task_log` outbound row id: the idempotency key for a redelivery. */
  outboundId: string;
  outcome: 'ok' | 'failed';
  /** As the runner resolved it. */
  model: string | null;
  /** Truncated and secret-scrubbed; for a failure, the error. */
  detail: string | null;
}

export interface TaskRunOutcomeRow {
  id: number;
  outcome: 'ok' | 'failed';
  model: string | null;
  detail: string | null;
  recorded_at: string;
  escalated_at: string | null;
}

/**
 * `INSERT OR IGNORE`: a redelivery is the SAME fire, and counting it twice would inflate a streak into an unearned
 * escalation.
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
 * Replaces any earlier execution of the same occurrence. `escalated_at` is not assigned, so an alert already
 * delivered stays delivered.
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

/** Lanes whose newest row failed, which are exactly the lanes with an open failure episode. */
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
 * The turn lane's current failure episode: length, whether escalated, start, and the newest failure.
 * ONE statement, deliberately: reading the last-success boundary and then aggregating as two awaits let a success
 * inserted between them count as another failure, alerting on a task at the moment it recovered. A driver transaction
 * is not an option (the fork's zero-open-transactions invariant, pinned by `src/db/raw-db-ratchet.test.ts` and
 * `transaction-closures.test.ts`), and episode rows are also filtered `outcome = 'failed'`.
 * `COUNT(escalated_at)` answers "already escalated" over the WHOLE episode, so no read window can hide the marker.
 * Derived from history, never a stored counter that someone must remember to reset.
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

export interface GateEpisode {
  rows: number;
  escalated: boolean;
  /** Earliest `recorded_at` in the episode. */
  firstRecordedAt: string;
  /** Earliest declared `since`, if any row declared one. */
  earliestSince: string | null;
  /** The smallest bound: a newer bound can shorten the deadline, never extend it. */
  boundMs: number | null;
  newest: {
    id: number;
    observation: GateObservation | null;
    detail: string | null;
    recorded_at: string;
  };
}

/** Consecutive non-ok gate rows after the lane's last ok, or null when the newest row is ok or the lane is empty. */
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

/** Stamps the episode onto the failure that triggered it. */
export async function markEscalated(outcomeId: number): Promise<void> {
  await getDb().run('UPDATE task_run_outcomes SET escalated_at = ? WHERE id = ?', new Date().toISOString(), outcomeId);
}

/**
 * Drops outcomes past retention, but never a row of a still-open failure episode: deleting the stamped failure of a
 * series broken longer than retention would make it report `escalated: false` and alert again. A row survives if it
 * sits above its lane's most recent success; with no success at all, `COALESCE(..., 0)` preserves the whole history.
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
