/**
 * Delivery action handlers for scheduling.
 *
 * The container can't write to inbound.db (host-owned). When the agent calls
 * schedule_task / cancel_task / etc. via MCP, the container writes a
 * `kind='system'` outbound message with an `action` field. The delivery path
 * reaches into this module via the delivery-action registry and we apply the
 * change here.
 *
 * Tasks belong to the channel-root session, not the calling thread session.
 * The `inDb` argument that delivery.ts passes is the **calling session's**
 * inbound.db; for the default (`scope:'channel'`) we ignore it and open the
 * channel-root session's inbound.db instead (resolved via
 * `resolveActiveSession`). Without this, an agent that schedules from a Slack
 * thread would have its task buried in that thread's inbound.db — invisible to
 * other threads, dead if the thread session is archived. See sessions.ts:62-72
 * for the load-bearing rationale.
 *
 * THREAD-SCOPED EXCEPTION (`scope:'thread'`): an opt-in recurring "loop" that
 * SHOULD live and report in the calling thread (e.g. "@bot run a loop in this
 * thread"). For these we deliberately keep the task in the calling per-thread
 * session's inbound (the passed `inDb`) and stamp the session's OWN
 * `thread_id`, so its fires wake that session and its replies post in-thread
 * (a per-thread session's outbound already carries `session.thread_id`). The
 * loop intentionally lives and dies with the thread session — correct for an
 * ephemeral, self-cancelling loop. The `thread_id` used is the
 * host-authoritative `session.thread_id`, NEVER the agent-supplied
 * `content.threadId`, so the cross-tenant routing invariant below still holds.
 * Management ops (cancel/pause/resume/update) resolve the calling session's
 * inbound first, then fall back to channel-root.
 *
 * Error notifications (`notifySchedulingFailure`, the "no live task matched"
 * notify in handleUpdateTask) still write to the **calling** session, since
 * that's where the agent's chat reply needs to surface.
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
import { getContainerConfig, resolveProviderName } from '../../db/container-configs.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { resolveActiveSession } from '../../db/scheduled-tasks.js';
import { getSession } from '../../db/sessions.js';
import { parseMessageFlags, type FlagIntent } from '../../flag-parser.js';
import { log } from '../../log.js';
import { openInboundDb, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { cancelTask, insertTask, pauseTask, resumeTask, updateTask, type TaskUpdate } from './db.js';

/** Per-fire model/effort a scheduled task carries; mirrors the chat FlagIntent. */
type TaskFlagIntent = Pick<FlagIntent, 'turnModel' | 'turnEffort'>;

/**
 * Resolve a `{ model?, effort? }` schedule/update payload into a per-fire
 * flagIntent, validated against the agent group's provider vocabulary. Reuses
 * the exact chat flag-parser (`-m1`/`-e1` = per-turn) so a task pin is resolved
 * and rejected identically to an interactive `-m1 sonnet -e1 medium` — no
 * second, drifting validation path. Returns `{ flagIntent }` on success (empty
 * object when neither field was given), or `{ error }` with a human-readable
 * reason the agent sees.
 */
function resolveTaskFlagIntent(
  content: Record<string, unknown>,
  session: Session,
): { flagIntent?: TaskFlagIntent; error?: string } {
  const model = typeof content.model === 'string' ? content.model.trim() : '';
  const effort = typeof content.effort === 'string' ? content.effort.trim() : '';
  if (!model && !effort) return {};

  const provider = resolveProviderName(session.agent_provider, getContainerConfig(session.agent_group_id)?.provider);
  const flagStr = [model ? `-m1 ${model}` : '', effort ? `-e1 ${effort}` : ''].filter(Boolean).join(' ');
  const parsed = parseMessageFlags(flagStr, provider);
  if (parsed.errors.length > 0) return { error: parsed.errors.join('; ') };

  const flagIntent: TaskFlagIntent = {};
  if (parsed.intent?.turnModel) flagIntent.turnModel = parsed.intent.turnModel;
  if (parsed.intent?.turnEffort) flagIntent.turnEffort = parsed.intent.turnEffort;
  return { flagIntent };
}

/**
 * Open the channel-root session's inbound.db for a (agent_group_id,
 * messaging_group_id) pair, run the operation, and close. Open-per-call is
 * required: the host invariant is one writer per file, opens-and-closes per
 * operation so cross-mount caches in any running container see the new rows
 * (see session-manager.ts:1-12).
 */
async function withChannelInbound<T>(
  agentGroupId: string,
  messagingGroupId: string,
  fn: (inDb: Database.Database) => T,
): Promise<T> {
  const channel = await resolveActiveSession(agentGroupId, messagingGroupId);
  const db = openInboundDb(agentGroupId, channel.id);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

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
  const scopeThread = content.scope === 'thread';

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

  // Resolve an optional per-fire model/effort pin. Fail closed: a bad model
  // (e.g. "sonnet" on a codex agent) rejects the whole schedule so the agent
  // learns, rather than silently creating a task on the wrong/no model.
  const { flagIntent, error: flagError } = resolveTaskFlagIntent(content, session);
  if (flagError) {
    await notifySchedulingFailure(session, `schedule_task failed: ${flagError}`);
    return;
  }
  const taskContent = JSON.stringify({ prompt, script, ...(flagIntent ? { flagIntent } : {}) });

  // Thread-scoped loop: keep the task in the calling per-thread session's
  // inbound (reuse delivery's already-open handle — no second writer to the
  // same file) and stamp the host-authoritative session.thread_id so its fires
  // report in-thread. Requires the caller to actually be a thread session;
  // `scope:'thread'` from a channel-root session has no thread to bind to, so
  // it falls through to the channel-root path below.
  if (scopeThread && session.thread_id) {
    insertTask(inDb, {
      id: taskId,
      processAfter,
      recurrence,
      platformId: mg.platform_id,
      channelType: mg.channel_type,
      threadId: session.thread_id,
      content: taskContent,
    });
    log.info('Scheduled task created (thread-scoped)', {
      taskId,
      processAfter,
      recurrence,
      platformId: mg.platform_id,
      channelType: mg.channel_type,
      threadId: session.thread_id,
      callingSessionId: session.id,
    });
    return;
  }
  if (scopeThread && !session.thread_id) {
    log.warn('schedule_task: scope=thread requested from a non-thread session — falling back to channel-root', {
      taskId,
      sessionId: session.id,
    });
  }

  await withChannelInbound(session.agent_group_id, session.messaging_group_id, (channelInDb) => {
    insertTask(channelInDb, {
      id: taskId,
      processAfter,
      recurrence,
      platformId: mg.platform_id,
      channelType: mg.channel_type,
      threadId: null,
      content: taskContent,
    });
  });
  log.info('Scheduled task created', {
    taskId,
    processAfter,
    recurrence,
    platformId: mg.platform_id,
    channelType: mg.channel_type,
    callingSessionId: session.id,
  });
}

/**
 * Resolve which inbound holds a task series for a management op (cancel/pause/
 * resume/update). Thread-scoped loops live in the calling per-thread session's
 * inbound (delivery's already-open `inDb`); channel-scoped tasks live in the
 * channel-root session's. Try the calling thread session first (only when it IS
 * a thread session), then fall back to channel root when nothing matched. `op`
 * returns the number of rows touched. NOTE: a thread-scoped task can only be
 * managed from within its own thread — managing it from a different thread
 * checks that thread + channel-root and won't find it. That matches the model
 * (the loop belongs to its thread).
 */
async function applyTaskOp(
  session: Session,
  inDb: Database.Database,
  messagingGroupId: string,
  op: (db: Database.Database) => number,
): Promise<number> {
  if (session.thread_id) {
    const n = op(inDb);
    if (n > 0) return n;
  }
  return withChannelInbound(session.agent_group_id, messagingGroupId, (channelInDb) => op(channelInDb));
}

export async function handleCancelTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  if (!session.messaging_group_id) {
    log.warn('handleCancelTask: rejected — session has no messaging_group_id', { taskId, sessionId: session.id });
    return;
  }
  const touched = await applyTaskOp(session, inDb, session.messaging_group_id, (db) => cancelTask(db, taskId));
  log.info('Task cancelled', { taskId, touched });
}

export async function handlePauseTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  if (!session.messaging_group_id) {
    log.warn('handlePauseTask: rejected — session has no messaging_group_id', { taskId, sessionId: session.id });
    return;
  }
  const touched = await applyTaskOp(session, inDb, session.messaging_group_id, (db) => pauseTask(db, taskId));
  log.info('Task paused', { taskId, touched });
}

export async function handleResumeTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  if (!session.messaging_group_id) {
    log.warn('handleResumeTask: rejected — session has no messaging_group_id', { taskId, sessionId: session.id });
    return;
  }
  const touched = await applyTaskOp(session, inDb, session.messaging_group_id, (db) => resumeTask(db, taskId));
  log.info('Task resumed', { taskId, touched });
}

export async function handleUpdateTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  if (!session.messaging_group_id) {
    log.warn('handleUpdateTask: rejected — session has no messaging_group_id', { taskId, sessionId: session.id });
    return;
  }
  const update: TaskUpdate = {};
  if (typeof content.prompt === 'string') update.prompt = content.prompt;
  if (typeof content.processAfter === 'string') update.processAfter = content.processAfter;
  if (content.recurrence === null || typeof content.recurrence === 'string') {
    update.recurrence = content.recurrence as string | null;
  }
  if (content.script === null || typeof content.script === 'string') {
    update.script = content.script as string | null;
  }
  const { flagIntent, error: flagError } = resolveTaskFlagIntent(content, session);
  if (flagError) {
    await notifySchedulingFailure(session, `update_task failed: ${flagError}`);
    return;
  }
  if (flagIntent && (flagIntent.turnModel || flagIntent.turnEffort)) update.flagIntent = flagIntent;
  const touched = await applyTaskOp(session, inDb, session.messaging_group_id, (db) => updateTask(db, taskId, update));
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
