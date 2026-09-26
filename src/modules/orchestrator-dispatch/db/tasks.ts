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

/**
 * The three exports `applySpawnTask`'s admission transaction calls —
 * `insertTaskAtomic`, `getTaskByParentAndIdempotency`, `countActiveByParent` —
 * run on the async driver, because a `centralTransaction` closure may await
 * driver statements and nothing else. Every other export runs on the driver
 * too.
 *
 * None of them needs `centralTransaction`. Each is ONE statement, and each
 * mutation is already compare-and-set in SQL — `WHERE status = 'pending'`,
 * `WHERE status IN ('pending','running')`, `WHERE archived_at IS NULL`,
 * `WHERE needs_input = 1`, `RETURNING` — so a caller that loses a race sees
 * `changes === 0` and takes the same branch it took before the conversion.
 */
export async function insertTaskAtomic(row: TaskInsert): Promise<Task | null> {
  const createdAt = new Date().toISOString();
  const params = {
    ...row,
    needs_input: row.needs_input ?? 0,
    steer_question: row.steer_question ?? null,
    archived_at: row.archived_at ?? null,
    created_at: createdAt,
  };
  const result = await getDb().get<Task>(
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
    params,
  );

  return result ?? null;
}

export async function getTaskById(id: string): Promise<Task | null> {
  return (await getDb().get<Task>(`SELECT * FROM tasks WHERE task_id = ?`, id)) ?? null;
}

export async function getTaskByParentAndIdempotency(
  parentSessionId: string,
  idempotencyKey: string,
): Promise<Task | null> {
  return (
    (await getDb().get<Task>(
      `SELECT * FROM tasks WHERE parent_session_id = ? AND idempotency_key = ?`,
      parentSessionId,
      idempotencyKey,
    )) ?? null
  );
}

export async function acquireCompletionLease(taskId: string, leaseExpirySec: number = 60): Promise<Task | null> {
  const now = new Date().toISOString();
  // Compute expired threshold: now minus leaseExpirySec
  const expiredBefore = new Date(Date.now() - leaseExpirySec * 1000).toISOString();

  const result = await getDb().get<Task>(
    `UPDATE tasks
          SET completion_lease_at = ?
        WHERE task_id = ?
          AND status = 'pending'
          AND (completion_lease_at IS NULL OR completion_lease_at < ?)
        RETURNING *`,
    now,
    taskId,
    expiredBefore,
  );

  return result ?? null;
}

export async function updateArtifactColumn(taskId: string, columnName: string, value: string): Promise<boolean> {
  if (!ALLOWED_ARTIFACT_COLUMNS.has(columnName)) {
    throw new Error(`updateArtifactColumn: column '${columnName}' is not in the allowed artifact set`);
  }
  const result = await getDb().run(
    `UPDATE tasks
          SET "${columnName}" = ?
        WHERE task_id = ?
          AND status = 'pending'
          AND "${columnName}" IS NULL`,
    value,
    taskId,
  );

  return result.changes === 1;
}

export async function transitionToTerminal(
  taskId: string,
  terminalStatus: TerminalTaskStatus,
  extraCols: Record<string, unknown>,
): Promise<boolean> {
  const sets: string[] = [`status = ?`];
  const values: unknown[] = [terminalStatus];

  for (const [col, val] of Object.entries(extraCols)) {
    sets.push(`"${col}" = ?`);
    values.push(val);
  }
  values.push(taskId);

  // Always at least two positional parameters (the status and the task id), so
  // the driver's single-object named-parameter overload can never be selected
  // by accident even when `extraCols` is empty.
  const result = await getDb().run(
    `UPDATE tasks
          SET ${sets.join(', ')}
        WHERE task_id = ?
          AND status IN ('pending', 'running')`,
    ...values,
  );

  return result.changes === 1;
}

export function getOrphanedTasks(): Promise<Task[]> {
  const expiredBefore = new Date(Date.now() - 60 * 1000).toISOString();
  return getDb().all<Task>(
    `SELECT * FROM tasks
        WHERE status = 'pending'
          AND admitted_at IS NOT NULL
          AND child_session_id IS NULL
          AND (completion_lease_at IS NULL OR completion_lease_at < ?)`,
    expiredBefore,
  );
}

export async function incrementCompletionAttempts(taskId: string): Promise<number> {
  const result = await getDb().get<{ dispatch_completion_attempts: number }>(
    `UPDATE tasks
          SET dispatch_completion_attempts = dispatch_completion_attempts + 1
        WHERE task_id = ?
        RETURNING dispatch_completion_attempts`,
    taskId,
  );

  return result?.dispatch_completion_attempts ?? 0;
}

export async function getTaskByChildSession(childSessionId: string): Promise<Task | null> {
  return (await getDb().get<Task>(`SELECT * FROM tasks WHERE child_session_id = ?`, childSessionId)) ?? null;
}

/**
 * Two-column auth for child→host action handlers (spawn_progress,
 * spawn_complete, spawn_failed, spawn_request_steer). Resolves task_id from
 * the action content, looks up the task, and verifies the calling session
 * owns it (`task.child_session_id === callerSession.id`). Logs and returns
 * null on any failure — never throws. `actionLabel` is the prefix used in
 * log lines so the originating handler stays greppable.
 */
export async function authChildTaskAction(
  content: Record<string, unknown>,
  callerSession: Session,
  actionLabel: string,
): Promise<{ task: Task; taskId: string } | null> {
  const taskId = content.task_id as string | undefined;
  if (!taskId) {
    log.warn(`${actionLabel}: missing task_id — silently skipping`, { sessionId: callerSession.id });
    return null;
  }
  const task = await getTaskById(taskId);
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
 * Flip `needs_input=1` on a running task with the optional question text.
 * Returns true when the row actually changed — callers gate SSE emits on
 * this so a no-op (already-flagged with same question) doesn't trigger
 * dashboard refetches. Shared by `applySpawnNeedsInput` (child MCP path)
 * and the host-side delivery hook that catches `ask_question` outbound
 * messages from spawn-child sessions.
 */
export async function flagNeedsInput(taskId: string, question: string | null): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE tasks
          SET needs_input = 1,
              steer_question = ?
        WHERE task_id = ?
          AND status = 'running'
          AND (needs_input = 0 OR steer_question IS NOT ?)`,
    question,
    taskId,
    question,
  );
  return result.changes > 0;
}

/**
 * Sweep helper used by `host-sweep.ts:autoArchiveOldCompleted`. Archives
 * every completed task whose `completed_at < cutoffIso` and isn't already
 * archived. Failed tasks are intentionally excluded — operator must
 * dismiss those explicitly.
 */
export async function autoArchiveCompletedBefore(
  cutoffIso: string,
  archivedAt: string = new Date().toISOString(),
): Promise<number> {
  const result = await getDb().run(
    `UPDATE tasks
          SET archived_at = ?
        WHERE status = 'completed'
          AND archived_at IS NULL
          AND completed_at IS NOT NULL
          AND completed_at < ?`,
    archivedAt,
    cutoffIso,
  );
  return result.changes;
}

export async function countActiveByParent(parentSessionId: string): Promise<number> {
  const row = await getDb().get<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM tasks
        WHERE parent_session_id = ? AND status IN ('pending', 'running')`,
    parentSessionId,
  );
  return row?.cnt ?? 0;
}
