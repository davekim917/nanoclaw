/**
 * Task DB helpers used by the scheduling module.
 *
 * Tasks are `messages_in` rows with `kind='task'`. This module doesn't own
 * its own table — it piggybacks on the core schema. That's why there's no
 * `module-scheduling-*.ts` migration file.
 *
 * **This file is a façade.** Every statement it used to run now lives in
 * `src/modules/mailbox/ops/tasks.ts`, inside the mailbox module, and is
 * reachable as an op on a mailbox session (plan §4.4, Ingress row; invariant
 * I-2: one implementation of any SQL statement). The handle-taking signatures
 * survive because their remaining callers — `host-sweep.ts` (PR 5) and the
 * dashboard's scheduled-board routes (PR 6) — still hold raw handles; those
 * batches convert them to `withMailboxSession(...)` + the session ops of the
 * same name, after which this file goes away.
 *
 * cancel/pause/resume match any live row in the series, not just the exact id.
 * Recurring tasks get a new row per occurrence (see handleRecurrence), all
 * sharing series_id. Matching by id alone would only hit the completed row
 * the agent remembers, missing the live next occurrence.
 */
export {
  // Byte-identical to upstream's; the module re-exports upstream's own copies.
  cancelAllTasks,
  cancelTask,
  clearRecurrence,
  deleteTask,
  pauseTask,
  trailingFailedRuns,
  // Fork-only semantics (routing columns, inert inserts, recall invalidation).
  cancelSeriesWithStrandClear,
  getCompletedRecurring,
  insertRecurrence,
  insertTaskRow,
  restoreTaskRow,
  resumeTask,
  updateTask,
  type RecurringMessage,
  type TaskRowSnapshot,
  type TaskUpdate,
} from '../mailbox/index.js';
