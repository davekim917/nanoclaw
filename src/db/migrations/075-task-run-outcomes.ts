import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * A scheduled task whose AGENT TURN fails leaves no record any consumer can see.
 *
 * Observed 2026-09-07: a group migrated codex → claude at 03:37Z kept four
 * tasks pinned to a model belonging to its old provider. The pin is validated
 * at CREATE time and never re-validated at fire time, so every later fire
 * handed the wrong provider's model to the agent and the turn errored. One
 * `15,45 * * * *` series failed 21 consecutive times over ~14 hours and nobody
 * was told.
 *
 * The failures were NOT unrecorded — all 21 occurrence rows exist, and the
 * series run log holds 21 verbatim copies of the error. Every record said
 * SUCCESS, because three independent things stand between an errored agent turn
 * and the occurrence status:
 *
 *   1. `poll-loop.ts` marks the batch completed BEFORE the result event is
 *      handled (`markCompleted(initialBatchIds)`, ~30 lines earlier).
 *   2. `markFailed` (container/agent-runner/src/db/messages-in.ts) has zero
 *      callers in the runner.
 *   3. The host's ack sync maps only `script-skip:error` to failed
 *      (`src/mailbox/sqlite/index.ts`, `ack.status === 'script-skip:error' ?
 *      fail : complete`), so a literal `'failed'` ack would record `completed`
 *      anyway — and both statements guard `status NOT IN ('completed','failed')`,
 *      making the mark terminal-once so (1) cannot be corrected afterwards.
 *
 * So `trailingFailedRuns` — the streak `recurrence.ts` throttles and auto-pauses
 * on — reads 0 for an erroring agent, and always has. It counts pre-task script
 * failures and stuck-message MAX_TRIES failures, never a turn outcome.
 *
 * Fixing that chain is the true root cause and is a turn-lifecycle change
 * (when an occurrence becomes terminal, plus the ack mapping). This table is
 * the OBSERVER that closes the visibility gap without touching the lifecycle:
 * one row per automatic task-run summary, carrying the provider's own `is_error`
 * verdict and the model that actually ran.
 *
 * Central DB, not the session's `inbound.db`, because S19 `spent-task-session-gc`
 * closes spent task sessions and this history has to outlive that.
 *
 * `escalated_at` is the anti-spam marker, deliberately a column on the outcome
 * it marks rather than a second table. An episode is open when the CURRENT
 * trailing-failure streak contains a stamped row, so re-arming needs no
 * operation at all: a successful run ends the streak, and the next streak
 * contains no stamp. A separate ledger could disagree with the outcomes it
 * summarizes; a column cannot.
 *
 * No FK to `agent_groups`: the trace's job is to survive, and a cascade delete
 * would erase the evidence of exactly the group whose tasks were dying. The
 * sweep's retention prune bounds the table instead.
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
