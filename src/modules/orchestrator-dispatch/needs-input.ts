import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { authChildTaskAction } from './db/tasks.js';

/**
 * Spawned child reports it's blocked waiting on operator input.
 *
 *   - Only flips state when status='running' (no point flagging a terminal
 *     task; would race the dashboard's "Done" lane).
 *   - Truncates question to ≤500 chars for the same reasons spawn_progress
 *     truncates last_progress_message.
 *
 * The flag is cleared on the next successful steer write — see
 * `src/dashboard/steer.ts:applySteer`.
 */
export async function applySpawnNeedsInput(
  content: Record<string, unknown>,
  callerSession: Session,
): Promise<void> {
  const auth = authChildTaskAction(content, callerSession, 'applySpawnNeedsInput');
  if (!auth) return;
  const { task, taskId } = auth;

  const rawQuestion = (content.question as string | undefined) ?? null;
  const question = rawQuestion ? rawQuestion.slice(0, 500) : null;

  try {
    const result = getDb()
      .prepare(
        `UPDATE tasks
            SET needs_input = 1,
                steer_question = ?
          WHERE task_id = ?
            AND status = 'running'`,
      )
      .run(question, taskId);

    if (result.changes > 0) {
      void import('../../dashboard/api/events.js')
        .then((mod) =>
          mod.emitDashboardEvent('task_event', {
            task_id: taskId,
            kind: 'needs_input',
            agent_group_id: task.parent_agent_group_id,
          }),
        )
        .catch(() => {
          /* dashboard module may not be initialized in tests */
        });
    }
  } catch (err) {
    log.warn('applySpawnNeedsInput: DB update failed — silently swallowing', { taskId, err });
  }
}
