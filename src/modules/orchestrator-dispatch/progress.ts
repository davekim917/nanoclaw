import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { authChildTaskAction } from './db/tasks.js';

export async function applySpawnProgress(content: Record<string, unknown>, callerSession: Session): Promise<void> {
  const auth = authChildTaskAction(content, callerSession, 'applySpawnProgress');
  if (!auth) return;
  const { task, taskId } = auth;

  const message = (content.message as string | undefined) ?? '';
  const truncated = message.slice(0, 500);
  const now = new Date().toISOString();

  try {
    // Status guard — only update on active tasks. A late progress message on an
    // already-terminal task should not pollute timestamps post-dating cancelled_at /
    // completed_at / failed_at, which would break the lifecycle invariant.
    const result = await getDb().run(
      `UPDATE tasks SET last_progress_at = ?, last_progress_message = ? WHERE task_id = ? AND status IN ('pending', 'running')`,
      now,
      truncated,
      taskId,
    );

    if (result.changes > 0) {
      void import('../../dashboard/api/events.js')
        .then((mod) =>
          mod.emitDashboardEvent('task_event', {
            task_id: taskId,
            kind: 'progress',
            agent_group_id: task.parent_agent_group_id,
          }),
        )
        .catch(() => {
          /* dashboard module may not be initialized in tests */
        });
    }
  } catch (err) {
    log.warn('applySpawnProgress: DB update failed — silently swallowing', { taskId, err });
  }
}
