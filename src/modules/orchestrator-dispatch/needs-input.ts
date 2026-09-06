import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { authChildTaskAction, flagNeedsInput } from './db/tasks.js';

/**
 * Spawned child reports it's blocked waiting on operator input.
 *
 *   - Only flips state when status='running' (no point flagging a terminal
 *     task; would race the dashboard's "Done" lane).
 *   - Truncates question to ≤500 chars for the same reasons spawn_progress
 *     truncates last_progress_message.
 *   - The WHERE clause also gates on a real change (was-not-blocked OR
 *     question text differs) so a worker that re-calls spawn_request_steer
 *     with the same prompt doesn't repeatedly notify Slack.
 *
 * On a successful flip we post into the worker's own thread via the
 * channel adapter (same path as `steer.ts:_fireEchoAsync`). That keeps the
 * ping in-context — the operator sees it in the task's Slack/Discord
 * thread, and any reply they post there flows through the normal router
 * back into the child session's inbound DB, no manual re-dispatch needed.
 * Headless tasks (no `child_platform_thread_id`) skip the post; the
 * dashboard SSE is their only signal, which is by design.
 *
 * The flag is cleared on the next successful steer write — see
 * `src/dashboard/steer.ts:applySteer`.
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

  // Headless tasks (or those without a wired platform thread) have nothing
  // to ping — the dashboard SSE above is their only surface.
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
