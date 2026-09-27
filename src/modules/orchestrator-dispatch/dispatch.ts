import { randomUUID } from 'crypto';

import { getChannelAdapter } from '../../channels/channel-registry.js';
import { centralTransaction } from '../../db/central-lease.js';
import { getDb } from '../../db/connection.js';
// Lazy import avoids a module-init cycle. The overloads below are re-declared
// explicitly: `Parameters<typeof f>` only resolves an overloaded function's LAST
// overload, which would force callers into one event kind.
import type {
  InboundMessagePayload as _IMP,
  TaskEventPayload as _TEP,
  SessionEventPayload as _SEP,
} from '../../dashboard/api/events.js';
let _emitDashboardEvent: (typeof import('../../dashboard/api/events.js'))['emitDashboardEvent'] | null = null;
async function lazyEmit(kind: 'inbound_message', payload: _IMP): Promise<void>;
async function lazyEmit(kind: 'task_event', payload: _TEP): Promise<void>;
async function lazyEmit(kind: 'session_event', payload: _SEP): Promise<void>;
async function lazyEmit(kind: string, payload: _IMP | _TEP | _SEP): Promise<void> {
  if (!_emitDashboardEvent) {
    try {
      const mod = await import('../../dashboard/api/events.js');
      _emitDashboardEvent = mod.emitDashboardEvent;
    } catch {
      return;
    }
  }
  try {
    (_emitDashboardEvent as (k: string, p: unknown) => void)(kind, payload);
  } catch {
    // non-fatal
  }
}
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { resolveSession, withMailboxSession, writeSessionMessage } from '../../session-manager.js';
import { requestWake } from '../../request-wake.js';
import type { Session } from '../../types.js';
import { CapabilityConfig, getCapabilityConfig, hasOrchestratorCapability } from './db/agent-group-capabilities.js';
import {
  Task,
  acquireCompletionLease,
  countActiveByParent,
  getTaskById,
  incrementCompletionAttempts,
  insertTaskAtomic,
  transitionToTerminal,
  updateArtifactColumn,
  getTaskByParentAndIdempotency,
} from './db/tasks.js';
import { computeRequestHash, deriveSpawnTaskId } from './derive-task-id.js';

const DEFAULT_CAPABILITY_CONFIG: CapabilityConfig = {
  concurrencyCap: 5,
  noProgressTimeoutSec: 1800,
  spawnDeadlineSec: 300,
  drainGraceSec: 120,
};

const completionInFlight = new Map<string, Promise<void>>();

export async function applySpawnTask(content: Record<string, unknown>, callerSession: Session): Promise<void> {
  const idempotencyKey = content.idempotency_key as string | undefined;
  const taskContent = content.content as string | undefined;
  const deadline = (content.deadline as string | null | undefined) ?? null;

  if (!idempotencyKey || !taskContent) {
    await _notifyCaller(callerSession, 'spawn rejected: missing required fields (content, idempotency_key)');
    return;
  }

  // Children always run in the parent's agent group; there is no cross-group dispatch.
  const childAgentGroupId = callerSession.agent_group_id;

  // Resolved BEFORE the transaction: it consults the in-memory adapter
  // registry, and the transaction closure must stay DB-only.
  let surfaceMode: 'native_thread' | 'headless' = 'headless';
  if (callerSession.messaging_group_id !== null) {
    const mg = await getMessagingGroup(callerSession.messaging_group_id);
    if (mg) {
      const adapter = getChannelAdapter(mg.channel_type);
      if (adapter && typeof adapter.createThread === 'function') {
        surfaceMode = 'native_thread';
      }
    }
  }

  // BEGIN IMMEDIATE holds the write lock from the cap-count read through the
  // INSERT, so two parallel drains can't both pass the cap. DB-only closure:
  // every notification, wake and event runs after commit.
  let taskRow: Task | null = null;
  let replayResult: { message: string } | null = null;
  let notOrchestrator = false;

  await centralTransaction(async () => {
    // Capability read INSIDE the transaction, so a concurrent revoke either
    // commits first (rejected here) or waits for this commit.
    if (!(await hasOrchestratorCapability(callerSession.agent_group_id))) {
      notOrchestrator = true;
      return;
    }
    const capConfig =
      (await getCapabilityConfig(callerSession.agent_group_id, 'orchestrator')) ?? DEFAULT_CAPABILITY_CONFIG;

    // Idempotency replay PRECEDES the cap check.
    const existingByIdempotency = await getTaskByParentAndIdempotency(callerSession.id, idempotencyKey);
    if (existingByIdempotency) {
      const computedHash = computeRequestHash(taskContent, deadline);
      if (existingByIdempotency.request_hash !== computedHash) {
        replayResult = { message: `idempotency_key_reused_with_different_payload: key=${idempotencyKey}` };
        return;
      }
      replayResult = {
        message: `Task already exists: task_id=${existingByIdempotency.task_id} status=${existingByIdempotency.status}`,
      };
      return;
    }

    const activeCount = await countActiveByParent(callerSession.id);
    if (activeCount >= capConfig.concurrencyCap) {
      replayResult = {
        message: `spawn rejected: concurrency cap reached (${activeCount}/${capConfig.concurrencyCap})`,
      };
      return;
    }

    const requestHash = computeRequestHash(taskContent, deadline);

    const taskId = deriveSpawnTaskId(callerSession.id, idempotencyKey);
    const now = new Date().toISOString();
    taskRow = await insertTaskAtomic({
      task_id: taskId,
      idempotency_key: idempotencyKey,
      parent_session_id: callerSession.id,
      parent_agent_group_id: callerSession.agent_group_id,
      parent_messaging_group_id: callerSession.messaging_group_id,
      child_session_id: null,
      status: 'pending',
      task_content: taskContent,
      request_hash: requestHash,
      deadline,
      parent_platform_message_id: null,
      child_platform_thread_id: null,
      child_messaging_group_id: null,
      admitted_at: now,
      started_at: null,
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      last_progress_at: null,
      last_progress_message: null,
      fail_reason: null,
      result_summary: null,
      dispatch_completion_attempts: 0,
      completion_lease_at: null,
      surface_mode: surfaceMode,
    });

    // Parallel admit race: INSERT returned null, so read the winner.
    if (taskRow === null) {
      taskRow = await getTaskByParentAndIdempotency(callerSession.id, idempotencyKey);
      if (taskRow) {
        replayResult = {
          message: `Task already exists (parallel admit): task_id=${taskRow.task_id} status=${taskRow.status}`,
        };
        taskRow = null;
      }
    }
  }, 'applySpawnTask');

  if (notOrchestrator) {
    await _notifyCaller(callerSession, 'spawn rejected: not an orchestrator');
    return;
  }
  // TypeScript doesn't track mutation through the transaction callback.
  const postTxnReplay = replayResult as { message: string } | null;
  if (postTxnReplay) {
    await _notifyCaller(callerSession, postTxnReplay.message);
    void requestWake(callerSession, 'inbound-message').catch((err) =>
      log.warn('wakeContainer(caller) failed after replay notification', { err }),
    );
    return;
  }

  const finalTaskRow = taskRow as Task | null;
  if (!finalTaskRow) {
    log.warn('applySpawnTask: no task row after transaction (unexpected)', { callerSessionId: callerSession.id });
    return;
  }

  const admittedTask = finalTaskRow;

  await _notifyCaller(callerSession, `Task admitted: ${admittedTask.task_id}`);

  void requestWake(callerSession, 'inbound-message').catch((err) =>
    log.warn('wakeContainer(caller) failed after admit notification', { err }),
  );

  // Only AFTER commit.
  void lazyEmit('task_event', {
    task_id: admittedTask.task_id,
    kind: 'admit',
    agent_group_id: admittedTask.parent_agent_group_id,
    status: admittedTask.status,
    admitted_at: admittedTask.admitted_at,
  });

  // Tests assert on this exact setImmediate(fn, ...args) call shape.
  setImmediate(
    (taskId: string, groupId: string) => {
      void completeSpawnSideEffects(taskId, groupId);
    },
    admittedTask.task_id,
    childAgentGroupId,
  );
}

/** Called from applySpawnTask AND from the reconciler for crash recovery. */
export async function completeSpawnSideEffects(taskId: string, childAgentGroupId: string): Promise<void> {
  const existing = completionInFlight.get(taskId);
  if (existing) {
    return existing;
  }

  const promise = _runCompletionSideEffects(taskId, childAgentGroupId).catch((err) => {
    log.warn('completeSpawnSideEffects: unhandled error', { taskId, err });
  });
  completionInFlight.set(taskId, promise);
  void promise.finally(() => {
    completionInFlight.delete(taskId);
  });
  return promise;
}

async function _runCompletionSideEffects(taskId: string, childAgentGroupId: string): Promise<void> {
  const leaseRow = await acquireCompletionLease(taskId);
  if (!leaseRow) {
    log.debug('completeSpawnSideEffects: lease held by another worker, skipping', { taskId });
    return;
  }

  const releaseLeaseAndFinish = async (): Promise<void> => {
    try {
      await getDb().run(`UPDATE tasks SET completion_lease_at = NULL WHERE task_id = ?`, taskId);
    } catch (err) {
      log.warn('completeSpawnSideEffects: failed to release lease', { taskId, err });
    }
  };

  try {
    const task = await getTaskById(taskId);
    if (!task || task.status !== 'pending') {
      return;
    }

    if (task.surface_mode === 'native_thread') {
      await _runThreadedPath(task, childAgentGroupId);
    } else {
      await _runHeadlessPath(task, childAgentGroupId);
    }
  } catch (err) {
    log.warn('completeSpawnSideEffects: error during completion', { taskId, err });
    const attempts = await incrementCompletionAttempts(taskId);
    if (attempts >= 5) {
      await transitionToTerminal(taskId, 'failed', {
        fail_reason: 'completion_exhausted',
        failed_at: new Date().toISOString(),
      });
      log.warn('completeSpawnSideEffects: task marked completion_exhausted', { taskId, attempts });
    }
  } finally {
    await releaseLeaseAndFinish();
  }
}

async function _runThreadedPath(task: Task, childAgentGroupId: string): Promise<void> {
  const taskId = task.task_id;

  // adapter_unavailable does NOT consume retry budget.
  const mg = task.parent_messaging_group_id ? await getMessagingGroup(task.parent_messaging_group_id) : undefined;
  if (!mg) {
    await transitionToTerminal(taskId, 'failed', {
      fail_reason: 'adapter_unavailable',
      failed_at: new Date().toISOString(),
    });
    return;
  }

  const adapter = getChannelAdapter(mg.channel_type);
  if (!adapter || typeof adapter.createThread !== 'function') {
    await transitionToTerminal(taskId, 'failed', {
      fail_reason: 'adapter_unavailable',
      failed_at: new Date().toISOString(),
    });
    return;
  }

  {
    const current = await getTaskById(taskId);
    if (!current || current.status !== 'pending') return;

    if (current.parent_platform_message_id === null) {
      const truncContent = task.task_content.slice(0, 100);
      const { messageId } = await adapter.postParent!(mg.platform_id, `Spawned task: ${truncContent}`);
      const updated = await updateArtifactColumn(taskId, 'parent_platform_message_id', messageId);
      if (!updated) return; // status-CAS rejected — another path won
    }
  }

  {
    const current = await getTaskById(taskId);
    if (!current || current.status !== 'pending') return;

    if (current.child_platform_thread_id === null) {
      const parentMsgId = current.parent_platform_message_id!;
      const { threadId } = await adapter.createThread!(
        mg.platform_id,
        parentMsgId,
        `Task: ${task.task_content.slice(0, 80)}`,
        task.task_content,
      );
      // Slack: threadId IS parent_platform_message_id.
      const childMgId = task.parent_messaging_group_id;
      const updated = await updateArtifactColumn(taskId, 'child_platform_thread_id', threadId);
      if (!updated) return;
      if (childMgId) {
        await updateArtifactColumn(taskId, 'child_messaging_group_id', childMgId);
      }
    }
  }

  // Write order: tasks row, routing stamp, first inbound, then wake LAST.
  {
    const current = await getTaskById(taskId);
    if (!current || current.status !== 'pending') return;

    if (current.child_session_id === null) {
      // createThread returns the BARE thread id; session routing needs the
      // chat-sdk encoded form (mg.platform_id carries the scheme+channel
      // prefix), or the bridge rejects every child outbound.
      const bareThreadId = current.child_platform_thread_id!;
      const encodedThreadId = bareThreadId.includes(':') ? bareThreadId : `${mg.platform_id}:${bareThreadId}`;
      const { session: childSession } = await resolveSession(
        childAgentGroupId,
        task.parent_messaging_group_id,
        encodedThreadId,
        'per-thread',
      );

      const now = new Date().toISOString();
      const updated = await getDb().run(
        `UPDATE tasks SET child_session_id = ?, started_at = ?, last_progress_at = ?, status = 'running'
             WHERE task_id = ? AND status = 'pending' AND child_session_id IS NULL`,
        childSession.id,
        now,
        now,
        taskId,
      );
      if (updated.changes === 0) return;

      await _writeSpawnTaskIdToRouting(childSession.agent_group_id, childSession.id, taskId);

      // Stamp the spawn thread's routing on the brief: the runner's
      // per-destination thread resolver needs it, or child replies land at
      // channel root instead of the spawn thread.
      await writeSessionMessage(childSession.agent_group_id, childSession.id, {
        id: randomUUID(),
        kind: 'chat',
        timestamp: now,
        channelType: mg.channel_type,
        platformId: mg.platform_id,
        threadId: encodedThreadId,
        content: JSON.stringify({ _spawn: { task_id: taskId }, text: task.task_content }),
      });

      void requestWake(childSession, 'agent-created').catch((err) =>
        log.warn('wakeContainer(child) failed in threaded path', { taskId, err }),
      );

      const parentSession = await _resolveParentSession(task);
      if (parentSession) {
        const threadUrl = `Thread started: ${current.child_platform_thread_id}`;
        await _notifyParent(task, threadUrl);
        void requestWake(parentSession, 'inbound-message').catch((err: unknown) =>
          log.warn('wakeContainer(parent) failed after threaded completion', { taskId, err }),
        );
      }
    }
  }
}

async function _runHeadlessPath(task: Task, childAgentGroupId: string): Promise<void> {
  const taskId = task.task_id;

  const current = await getTaskById(taskId);
  if (!current || current.status !== 'pending') return;

  if (current.child_session_id === null) {
    const { session: childSession } = await resolveSession(
      childAgentGroupId,
      null,
      taskId, // synthetic thread_id = task_id (C4 safe: mgId=null → no adapter.deliver)
      'per-thread',
    );

    const now = new Date().toISOString();
    const updated = await getDb().run(
      `UPDATE tasks SET child_session_id = ?, started_at = ?, last_progress_at = ?, status = 'running'
           WHERE task_id = ? AND status = 'pending' AND child_session_id IS NULL`,
      childSession.id,
      now,
      now,
      taskId,
    );
    if (updated.changes === 0) return;

    await _writeSpawnTaskIdToRouting(childSession.agent_group_id, childSession.id, taskId);

    await writeSessionMessage(childSession.agent_group_id, childSession.id, {
      id: randomUUID(),
      kind: 'chat',
      timestamp: now,
      content: JSON.stringify({ _spawn: { task_id: taskId }, text: task.task_content }),
    });

    void requestWake(childSession, 'agent-created').catch((err) =>
      log.warn('wakeContainer(child) failed in headless path', { taskId, err }),
    );

    await _notifyParent(task, `Headless task running: ${taskId}`);
    const parentSession = await _resolveParentSession(task);
    if (parentSession) {
      void requestWake(parentSession, 'inbound-message').catch((err: unknown) =>
        log.warn('wakeContainer(parent) failed after headless completion', { taskId, err }),
      );
    }
  }
}

async function _writeSpawnTaskIdToRouting(agentGroupId: string, sessionId: string, taskId: string): Promise<void> {
  // PROVISIONING session on purpose: the child was just created and may have
  // no mailbox yet; the existing-only funnel would skip the stamp and leave it
  // unable to report progress or completion.
  await withMailboxSession(agentGroupId, sessionId, (mailbox) => mailbox.setSessionRoutingSpawnTaskId(taskId));
}

async function _resolveParentSession(task: Task): Promise<Session | null> {
  const session = await getSession(task.parent_session_id);
  return session ?? null;
}

async function _notifyCaller(session: Session, message: string): Promise<void> {
  try {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: randomUUID(),
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ text: message }),
    });
  } catch (err) {
    log.warn('applySpawnTask: failed to notify caller', { sessionId: session.id, err });
  }
}

async function _notifyParent(task: Task, message: string): Promise<void> {
  try {
    const parentSession = await getSession(task.parent_session_id);
    if (!parentSession) return;
    await writeSessionMessage(task.parent_agent_group_id, task.parent_session_id, {
      id: randomUUID(),
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ text: message }),
    });
  } catch (err) {
    log.warn('completeSpawnSideEffects: failed to notify parent', { taskId: task.task_id, err });
  }
}
