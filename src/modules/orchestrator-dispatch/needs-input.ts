import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { authChildTaskAction, flagNeedsInput } from './db/tasks.js';

/**
 * Flags only a running task, and only on a real change (so a repeated call
 * doesn't re-notify). On a flip it posts into the worker's own thread, where an
 * operator reply routes straight back to the child; headless tasks rely on the
 * dashboard SSE. Cleared by the next steer write.
 */
export async function applySpawnNeedsInput(content: Record<string, unknown>, callerSession: Session): Promise<void> {
  const auth = await authChildTaskAction(content, callerSession, 'applySpawnNeedsInput');
  if (!auth) return;
  const { task, taskId } = auth;

  const rawQuestion = (content.question as string | undefined) ?? null;
  const question = rawQuestion ? rawQuestion.slice(0, 500) : null;

  let flipped: boolean;
  try {
    flipped = await flagNeedsInput(taskId, question);
  } catch (err) {
    log.warn('applySpawnNeedsInput: DB update failed — silently swallowing', { taskId, err });
    return;
  }

  if (!flipped) return;

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

  // Headless tasks: the dashboard SSE above is their only surface.
  if (task.surface_mode !== 'native_thread' || !task.child_platform_thread_id || !task.child_messaging_group_id) {
    return;
  }

  const mg = await getMessagingGroup(task.child_messaging_group_id);
  if (!mg) return;

  const adapter = getChannelAdapter(mg.channel_type);
  if (!adapter || typeof adapter.deliver !== 'function') return;

  const promptText = question ? `: ${question}` : '';
  try {
    await adapter.deliver(mg.platform_id, task.child_platform_thread_id, {
      kind: 'chat',
      content: { text: `🙋 Needs your input${promptText}. Reply in-thread or via dashboard.` },
    });
  } catch (err) {
    log.warn('applySpawnNeedsInput: adapter.deliver failed', { taskId, err });
  }
}
