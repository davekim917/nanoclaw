import { randomUUID } from 'crypto';

import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import { requestWake } from '../../request-wake.js';
import type { Session } from '../../types.js';
import { authChildTaskAction, transitionToTerminal } from './db/tasks.js';

export async function applySpawnComplete(content: Record<string, unknown>, callerSession: Session): Promise<void> {
  const auth = authChildTaskAction(content, callerSession, 'applySpawnComplete');
  if (!auth) return;
  const { task, taskId } = auth;

  const summary = (content.summary as string | undefined) ?? '';
  const now = new Date().toISOString();
  const transitioned = transitionToTerminal(taskId, 'completed', {
    completed_at: now,
    result_summary: summary,
  });

  // CAS returned false → already in terminal state; skip duplicate parent notification
  if (!transitioned) {
    log.debug('applySpawnComplete: task already in terminal state, skipping notify', { taskId });
    return;
  }

  // Dashboard SSE emit (post-build drift fix B5 — D6 plan callsite missing)
  void import('../../dashboard/api/events.js')
    .then((mod) =>
      mod.emitDashboardEvent('task_event', {
        task_id: taskId,
        kind: 'complete',
        agent_group_id: task.parent_agent_group_id,
      }),
    )
    .catch(() => {
      /* dashboard module may not be initialized in tests */
    });

  // Notify parent
  const parentSession = await getSession(task.parent_session_id);
  if (!parentSession) return;

  try {
    await writeSessionMessage(task.parent_agent_group_id, task.parent_session_id, {
      id: randomUUID(),
      kind: 'chat',
      timestamp: now,
      content: JSON.stringify({
        text: `Task completed: ${taskId}. Summary: ${summary}`,
        _task_update: { task_id: taskId, status: 'completed', result_summary: summary },
      }),
    });
    void requestWake(parentSession, 'inbound-message').catch((err) =>
      log.warn('applySpawnComplete: wakeContainer(parent) failed', { taskId, err }),
    );
  } catch (err) {
    log.warn('applySpawnComplete: failed to notify parent', { taskId, err });
  }
}

export async function applySpawnFailed(content: Record<string, unknown>, callerSession: Session): Promise<void> {
  const auth = authChildTaskAction(content, callerSession, 'applySpawnFailed');
  if (!auth) return;
  const { task, taskId } = auth;

  const summary = (content.summary as string | undefined) ?? '';
  const failReason = (content.fail_reason as string | undefined) ?? 'agent_error';
  const now = new Date().toISOString();
  const transitioned = transitionToTerminal(taskId, 'failed', {
    failed_at: now,
    result_summary: summary,
    fail_reason: failReason,
  });

  if (!transitioned) {
    log.debug('applySpawnFailed: task already in terminal state, skipping notify', { taskId });
    return;
  }

  // Dashboard SSE emit (post-build drift fix B5)
  void import('../../dashboard/api/events.js')
    .then((mod) =>
      mod.emitDashboardEvent('task_event', {
        task_id: taskId,
        kind: 'failed',
        agent_group_id: task.parent_agent_group_id,
      }),
    )
    .catch(() => {
      /* dashboard module may not be initialized in tests */
    });

  const parentSession = await getSession(task.parent_session_id);
  if (!parentSession) return;

  try {
    await writeSessionMessage(task.parent_agent_group_id, task.parent_session_id, {
      id: randomUUID(),
      kind: 'chat',
      timestamp: now,
      content: JSON.stringify({
        text: `Task failed: ${taskId}. Reason: ${failReason}. Summary: ${summary}`,
        _task_update: {
          task_id: taskId,
          status: 'failed',
          fail_reason: failReason,
          result_summary: summary,
        },
      }),
    });
    void requestWake(parentSession, 'inbound-message').catch((err) =>
      log.warn('applySpawnFailed: wakeContainer(parent) failed', { taskId, err }),
    );
  } catch (err) {
    log.warn('applySpawnFailed: failed to notify parent', { taskId, err });
  }
}
