/**
 * Façade over the task ops in `src/modules/mailbox/ops/tasks.ts`, kept for
 * callers that still hold raw handles. cancel/pause/resume match any live row
 * in the series, not just the exact id: each recurrence is a new row, and the
 * id the agent remembers is usually the completed one.
 */
export {
  // Byte-identical to upstream's; the module re-exports upstream's own copies.
  cancelTask,
  pauseTask,
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
