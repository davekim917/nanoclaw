import { getDb } from '../../../db/connection.js';
import { log } from '../../../log.js';
import type { Session } from '../../../types.js';

export type TerminalTaskStatus = 'completed' | 'failed' | 'cancelled';

export interface Task {
  task_id: string;
  idempotency_key: string;
  parent_session_id: string;
  parent_agent_group_id: string;
  parent_messaging_group_id: string | null;
  child_session_id: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  task_content: string;
  request_hash: string;
  deadline: string | null;
  parent_platform_message_id: string | null;
  child_platform_thread_id: string | null;
  child_messaging_group_id: string | null;
  admitted_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  last_progress_at: string | null;
  last_progress_message: string | null;
  fail_reason: string | null;
  result_summary: string | null;
  dispatch_completion_attempts: number;
  completion_lease_at: string | null;
  surface_mode: 'pending' | 'native_thread' | 'headless';
  needs_input: number;
  steer_question: string | null;
  archived_at: string | null;
  created_at: string;
}

const ALLOWED_ARTIFACT_COLUMNS = new Set([
  'parent_platform_message_id',
  'child_platform_thread_id',
  'child_messaging_group_id',
  'child_session_id',
  'last_progress_at',
  'last_progress_message',
  'started_at',
]);

type TaskInsert = Omit<Task, 'created_at' | 'needs_input' | 'steer_question' | 'archived_at'> &
  Partial<Pick<Task, 'needs_input' | 'steer_question' | 'archived_at'>>;

export function insertTaskAtomic(row: TaskInsert): Task | null {
  const createdAt = new Date().toISOString();
  const params = {
    ...row,
    needs_input: row.needs_input ?? 0,
    steer_question: row.steer_question ?? null,
    archived_at: row.archived_at ?? null,
    created_at: createdAt,
  };
  const result = getDb()
    .prepare(
      `INSERT INTO tasks (
        task_id, idempotency_key, parent_session_id, parent_agent_group_id,
        parent_messaging_group_id, child_session_id,
        status, task_content, request_hash, deadline, parent_platform_message_id,
        child_platform_thread_id, child_messaging_group_id, admitted_at,
        started_at, completed_at, failed_at, cancelled_at, last_progress_at,
        last_progress_message, fail_reason, result_summary,
        dispatch_completion_attempts, completion_lease_at, surface_mode,
        needs_input, steer_question, archived_at, created_at
      ) VALUES (
        @task_id, @idempotency_key, @parent_session_id, @parent_agent_group_id,
        @parent_messaging_group_id, @child_session_id,
        @status, @task_content, @request_hash, @deadline, @parent_platform_message_id,
        @child_platform_thread_id, @child_messaging_group_id, @admitted_at,
        @started_at, @completed_at, @failed_at, @cancelled_at, @last_progress_at,
        @last_progress_message, @fail_reason, @result_summary,
        @dispatch_completion_attempts, @completion_lease_at, @surface_mode,
        @needs_input, @steer_question, @archived_at, @created_at
      )
      ON CONFLICT(parent_session_id, idempotency_key) DO NOTHING
      RETURNING *`,
    )
    .get(params) as Task | undefined;

  return result ?? null;
}

export function getTaskById(id: string): Task | null {
  return (getDb().prepare(`SELECT * FROM tasks WHERE task_id = ?`).get(id) as Task | undefined) ?? null;
}

export function getTaskByParentAndIdempotency(parentSessionId: string, idempotencyKey: string): Task | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM tasks WHERE parent_session_id = ? AND idempotency_key = ?`)
      .get(parentSessionId, idempotencyKey) as Task | undefined) ?? null
  );
}

export function acquireCompletionLease(taskId: string, leaseExpirySec: number = 60): Task | null {
  const now = new Date().toISOString();
  // Compute expired threshold: now minus leaseExpirySec
  const expiredBefore = new Date(Date.now() - leaseExpirySec * 1000).toISOString();

  const result = getDb()
    .prepare(
      `UPDATE tasks
          SET completion_lease_at = ?
        WHERE task_id = ?
          AND status = 'pending'
          AND (completion_lease_at IS NULL OR completion_lease_at < ?)
        RETURNING *`,
    )
    .get(now, taskId, expiredBefore) as Task | undefined;

  return result ?? null;
}

export function updateArtifactColumn(taskId: string, columnName: string, value: string): boolean {
  if (!ALLOWED_ARTIFACT_COLUMNS.has(columnName)) {
    throw new Error(`updateArtifactColumn: column '${columnName}' is not in the allowed artifact set`);
  }
  const result = getDb()
    .prepare(
      `UPDATE tasks
          SET "${columnName}" = ?
        WHERE task_id = ?
          AND status = 'pending'
          AND "${columnName}" IS NULL`,
    )
    .run(value, taskId);

  return result.changes === 1;
}

export function transitionToTerminal(
  taskId: string,
  terminalStatus: TerminalTaskStatus,
  extraCols: Record<string, unknown>,
): boolean {
  const sets: string[] = [`status = ?`];
  const values: unknown[] = [terminalStatus];

  for (const [col, val] of Object.entries(extraCols)) {
    sets.push(`"${col}" = ?`);
    values.push(val);
  }
  values.push(taskId);

  const result = getDb()
    .prepare(
      `UPDATE tasks
          SET ${sets.join(', ')}
        WHERE task_id = ?
          AND status IN ('pending', 'running')`,
    )
    .run(...(values as Parameters<typeof getDb>));

  return result.changes === 1;
}

export function getOrphanedTasks(): Task[] {
  const expiredBefore = new Date(Date.now() - 60 * 1000).toISOString();
  return getDb()
    .prepare(
      `SELECT * FROM tasks
        WHERE status = 'pending'
          AND admitted_at IS NOT NULL
          AND child_session_id IS NULL
          AND (completion_lease_at IS NULL OR completion_lease_at < ?)`,
    )
    .all(expiredBefore) as Task[];
}

export function incrementCompletionAttempts(taskId: string): number {
  const result = getDb()
    .prepare(
      `UPDATE tasks
          SET dispatch_completion_attempts = dispatch_completion_attempts + 1
        WHERE task_id = ?
        RETURNING dispatch_completion_attempts`,
    )
    .get(taskId) as { dispatch_completion_attempts: number } | undefined;

  return result?.dispatch_completion_attempts ?? 0;
}

export function getTaskByChildSession(childSessionId: string): Task | null {
  return (
    (getDb().prepare(`SELECT * FROM tasks WHERE child_session_id = ?`).get(childSessionId) as Task | undefined) ?? null
  );
}

export function getActiveTasks(): Task[] {
  return getDb().prepare(`SELECT * FROM tasks WHERE status IN ('pending', 'running')`).all() as Task[];
}

/**
 * Two-column auth for child→host action handlers (spawn_progress,
 * spawn_complete, spawn_failed, spawn_request_steer). Resolves task_id from
 * the action content, looks up the task, and verifies the calling session
 * owns it (`task.child_session_id === callerSession.id`). Logs and returns
 * null on any failure — never throws. `actionLabel` is the prefix used in
 * log lines so the originating handler stays greppable.
 */
export function authChildTaskAction(
  content: Record<string, unknown>,
  callerSession: Session,
  actionLabel: string,
): { task: Task; taskId: string } | null {
  const taskId = content.task_id as string | undefined;
  if (!taskId) {
    log.warn(`${actionLabel}: missing task_id — silently skipping`, { sessionId: callerSession.id });
    return null;
  }
  const task = getTaskById(taskId);
  if (!task) {
    log.warn(`${actionLabel}: task not found — silently skipping`, { taskId });
    return null;
  }
  if (task.child_session_id !== callerSession.id) {
    log.warn(`${actionLabel}: auth mismatch — silently skipping`, {
      taskId,
      expected: task.child_session_id,
      got: callerSession.id,
    });
    return null;
  }
  return { task, taskId };
}

/**
 * Clear the needs_input flag and the optional steer_question text. Invoked
 * by the steer write path so the operator's reply transparently unblocks
 * the worker. Guarded `WHERE needs_input = 1` so the partial index drives
 * the lookup and rows that weren't waiting on steer don't trigger writes.
 */
export function clearNeedsInput(taskId: string): void {
  getDb()
    .prepare(
      `UPDATE tasks
          SET needs_input = 0,
              steer_question = NULL
        WHERE task_id = ?
          AND needs_input = 1`,
    )
    .run(taskId);
}

/**
 * Soft-delete a task from the dashboard's default view. Returns true when
 * the row actually flipped (was not already archived) — callers gate SSE
 * emits on this so a no-op archive doesn't trigger refetches.
 */
export function archiveTaskById(taskId: string, archivedAt: string = new Date().toISOString()): boolean {
  const result = getDb()
    .prepare(`UPDATE tasks SET archived_at = ? WHERE task_id = ? AND archived_at IS NULL`)
    .run(archivedAt, taskId);
  return result.changes > 0;
}

export function unarchiveTaskById(taskId: string): void {
  getDb().prepare(`UPDATE tasks SET archived_at = NULL WHERE task_id = ?`).run(taskId);
}

/**
 * Bulk archive: every non-archived task in `groupId` with the given
 * terminal status. Returns the row count. Callers (dashboard bulk endpoint,
 * scope-checked by the handler) are responsible for verifying the caller
 * is admin-of `groupId` before invoking.
 */
export function bulkArchiveByGroupAndStatus(
  groupId: string,
  status: TerminalTaskStatus,
  archivedAt: string = new Date().toISOString(),
): number {
  const result = getDb()
    .prepare(
      `UPDATE tasks
          SET archived_at = ?
        WHERE parent_agent_group_id = ?
          AND status = ?
          AND archived_at IS NULL`,
    )
    .run(archivedAt, groupId, status);
  return result.changes;
}

/**
 * Sweep helper used by `host-sweep.ts:autoArchiveOldCompleted`. Archives
 * every completed task whose `completed_at < cutoffIso` and isn't already
 * archived. Failed tasks are intentionally excluded — operator must
 * dismiss those explicitly.
 */
export function autoArchiveCompletedBefore(
  cutoffIso: string,
  archivedAt: string = new Date().toISOString(),
): number {
  const result = getDb()
    .prepare(
      `UPDATE tasks
          SET archived_at = ?
        WHERE status = 'completed'
          AND archived_at IS NULL
          AND completed_at IS NOT NULL
          AND completed_at < ?`,
    )
    .run(archivedAt, cutoffIso);
  return result.changes;
}

export function countActiveByParent(parentSessionId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) as cnt FROM tasks
        WHERE parent_session_id = ? AND status IN ('pending', 'running')`,
    )
    .get(parentSessionId) as { cnt: number };
  return row.cnt;
}
