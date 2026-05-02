/**
 * Delivery action handlers for scheduling.
 *
 * The container can't write to inbound.db (host-owned). When the agent calls
 * schedule_task / cancel_task / etc. via MCP, the container writes a
 * `kind='system'` outbound message with an `action` field. The delivery path
 * reaches into this module via the delivery-action registry and we apply the
 * change to inbound.db here.
 *
 * SECURITY (post-2026-05-02 cross-tenant leak): the host MUST NOT trust
 * agent-supplied routing fields (`platformId`/`channelType`/`threadId`) on
 * the system action. A compromised agent or a future MCP-tool bug can stamp
 * an arbitrary tenant's channel and the host would happily route the recap
 * there. The session is the authority — derive routing from
 * `session.messaging_group_id` and post to the channel root (`thread_id=null`)
 * regardless of what the container sent. Tasks scheduled in a session with no
 * messaging_group_id are rejected.
 */
import type Database from 'better-sqlite3';

import { wakeContainer } from '../../container-runner.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { cancelTask, insertTask, pauseTask, resumeTask, updateTask, type TaskUpdate } from './db.js';

async function notifySchedulingFailure(session: Session, message: string): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text: message, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) =>
      log.error('Failed to wake container after scheduling failure notification', { err }),
    );
  }
}

export async function handleScheduleTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const prompt = content.prompt as string;
  const script = content.script as string | null;
  const processAfter = content.processAfter as string;
  const recurrence = (content.recurrence as string) || null;

  // Authoritative routing comes from the session — NOT from agent-supplied
  // content. Reject schedules from sessions without a wired messaging group
  // (e.g., internal/background sessions); those have no chat surface to
  // deliver into and silently using session-routing fallback re-introduces
  // the cross-tenant leak class.
  if (!session.messaging_group_id) {
    log.warn('handleScheduleTask: rejected — session has no messaging_group_id', {
      taskId,
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
    });
    await notifySchedulingFailure(
      session,
      `schedule_task failed: this session has no chat destination wired. Schedule from a wired chat session.`,
    );
    return;
  }
  const mg = getMessagingGroup(session.messaging_group_id);
  if (!mg) {
    log.error('handleScheduleTask: session.messaging_group_id references missing MG', {
      taskId,
      messagingGroupId: session.messaging_group_id,
    });
    await notifySchedulingFailure(session, `schedule_task failed: messaging group not found.`);
    return;
  }

  insertTask(inDb, {
    id: taskId,
    processAfter,
    recurrence,
    platformId: mg.platform_id,
    channelType: mg.channel_type,
    threadId: null,
    content: JSON.stringify({ prompt, script }),
  });
  log.info('Scheduled task created', {
    taskId,
    processAfter,
    recurrence,
    platformId: mg.platform_id,
    channelType: mg.channel_type,
    sessionId: session.id,
  });
}

export async function handleCancelTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  cancelTask(inDb, taskId);
  log.info('Task cancelled', { taskId });
}

export async function handlePauseTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  pauseTask(inDb, taskId);
  log.info('Task paused', { taskId });
}

export async function handleResumeTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  resumeTask(inDb, taskId);
  log.info('Task resumed', { taskId });
}

export async function handleUpdateTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const update: TaskUpdate = {};
  if (typeof content.prompt === 'string') update.prompt = content.prompt;
  if (typeof content.processAfter === 'string') update.processAfter = content.processAfter;
  if (content.recurrence === null || typeof content.recurrence === 'string') {
    update.recurrence = content.recurrence as string | null;
  }
  if (content.script === null || typeof content.script === 'string') {
    update.script = content.script as string | null;
  }
  const touched = updateTask(inDb, taskId, update);
  log.info('Task updated', { taskId, touched, fields: Object.keys(update) });
  if (touched === 0) {
    // Notify the agent that update_task matched nothing. Replicates the
    // old notifyAgent helper that used to live in delivery.ts — inlined
    // here so scheduling doesn't depend on delivery's private helpers.
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `update_task: no live task matched id "${taskId}".`,
        sender: 'system',
        senderId: 'system',
      }),
    });
    const fresh = getSession(session.id);
    if (fresh) {
      wakeContainer(fresh).catch((err) =>
        log.error('Failed to wake container after update_task notification', { err }),
      );
    }
  }
}
