import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * A task whose AGENT TURN fails leaves no record any consumer can see: every occurrence still records SUCCESS,
 * because the runner marks the batch completed before the result is handled, `markFailed` has no caller, and the
 * host's ack sync maps only `script-skip:error` to failed (the mark is terminal-once). So `trailingFailedRuns` reads
 * 0 for an erroring agent. This table is an OBSERVER that closes the visibility gap without changing that lifecycle:
 * one row per task-run summary with the provider's `is_error` and the model that ran.
 * Central, because spent task sessions are garbage-collected and this history must outlive them. `escalated_at` is
 * the anti-spam marker on the outcome itself: an episode is escalated when its current failure streak contains a
 * stamp, so a success re-arms with no operation. No FK to `agent_groups`: a cascade would erase the evidence for the
 * very group whose tasks were dying; the retention prune bounds the table.
 */
export const migration075: Migration = {
  version: 75,
  name: 'task-run-outcomes',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_run_outcomes (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_group_id   TEXT NOT NULL,
        session_id       TEXT NOT NULL,
        series_id        TEXT NOT NULL,
        outbound_id      TEXT NOT NULL,
        outcome          TEXT NOT NULL CHECK (outcome IN ('ok', 'failed')),
        model            TEXT,
        detail           TEXT,
        recorded_at      TEXT NOT NULL,
        escalated_at     TEXT,
        UNIQUE (session_id, outbound_id)
      );

      -- The escalation sweep's only read: newest-first history for one series.
      CREATE INDEX IF NOT EXISTS idx_task_run_outcomes_series
        ON task_run_outcomes (agent_group_id, series_id, id DESC);

      -- The retention prune's only read.
      CREATE INDEX IF NOT EXISTS idx_task_run_outcomes_recorded_at
        ON task_run_outcomes (recorded_at);
    `);
  },
};
