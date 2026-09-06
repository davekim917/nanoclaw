import { randomUUID } from 'crypto';

import { getChannelAdapter } from '../../channels/channel-registry.js';
import { centralTransaction } from '../../db/central-lease.js';
import { getDb } from '../../db/connection.js';
// Lazy import to avoid module-init cycle (events.ts imports nothing from dispatch.ts).
// The import() call is memoized by Node's module cache after the first resolution.
//
// TS quirk: `Parameters<typeof emitDashboardEvent>` only resolves to the LAST
// overload of an overloaded function, so a rest-spread signature here would
// silently force callers into one specific event kind. Re-declare each
// overload explicitly so the type-system honors all of them.
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

/** In-process deduplication guard for completeSpawnSideEffects. */
const completionInFlight = new Map<string, Promise<void>>();

export async function applySpawnTask(content: Record<string, unknown>, callerSession: Session): Promise<void> {
  const idempotencyKey = content.idempotency_key as string | undefined;
  const taskContent = content.content as string | undefined;
  const deadline = (content.deadline as string | null | undefined) ?? null;

  if (!idempotencyKey || !taskContent) {
    await _notifyCaller(callerSession, 'spawn rejected: missing required fields (content, idempotency_key)');
    return;
  }

  // Self-orchestration: spawned children always run in the SAME agent group as
  // the parent. They share workspace, memory, CLAUDE.md, channels — only the
  // session/thread is isolated. There is no cross-group dispatch primitive.
  const childAgentGroupId = callerSession.agent_group_id;

  // Surface mode — per-channel capability check (cycle-3 S24). Resolved BEFORE
  // the admission transaction: it reads the messaging group (whose channel
  // type never changes) and consults the in-memory adapter registry, and a
  // central transaction closure is DB-only (plan §4.4) — no adapter lookups
  // inside it.
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

  // All admission steps inside a single central transaction. The driver opens
  // it IMMEDIATE (write lock from BEGIN) so the cap-count read holds the write
  // lock through the INSERT — prevents two parallel delivery drains from the
  // same orchestrator both reading the same count, both passing the cap check,
  // and both succeeding INSERT (cap exceeded). Cycle-3 S3-C /
  // Concurrency-reviewer #5. The closure is DB-only: every notification, wake
  // and dashboard event below runs after commit, never after a rollback.
  let taskRow: Task | null = null;
  let replayResult: { message: string } | null = null;
  let notOrchestrator = false;

  await centralTransaction(async () => {
    // Step 0: Auth — the caller's agent_group must hold the orchestrator
    // capability, read INSIDE the transaction (fork issue #452, site 1). Read
    // before the closure, the awaited check yields, and a `revokeCapability`
    // landing in that window admits one task after the revoke. Under BEGIN
    // IMMEDIATE the revoke either commits before this read (rejected here) or
    // waits for this commit (the task is admitted while the capability still
    // held). The same holds for the cap config the count below is judged by.
    if (!(await hasOrchestratorCapability(callerSession.agent_group_id))) {
      notOrchestrator = true;
      return;
    }
    const capConfig =
      (await getCapabilityConfig(callerSession.agent_group_id, 'orchestrator')) ?? DEFAULT_CAPABILITY_CONFIG;

    // Step 1: Idempotency replay PRECEDES cap (cycle-3 M20)
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

    // Step 2: Concurrency cap — only for NEW admissions
    const activeCount = await countActiveByParent(callerSession.id);
    if (activeCount >= capConfig.concurrencyCap) {
      replayResult = {
        message: `spawn rejected: concurrency cap reached (${activeCount}/${capConfig.concurrencyCap})`,
      };
      return;
    }

    // Step 3: Compute request_hash
    const requestHash = computeRequestHash(taskContent, deadline);

    // Step 4: surface_mode was resolved above, before the transaction.

    // Step 5: Atomic INSERT
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

    // Parallel admit race: if INSERT returned null, SELECT the winner
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

  // Post-transaction handling — every notification/wake is an external effect
  // and runs after commit, never inside the closure.
  if (notOrchestrator) {
    await _notifyCaller(callerSession, 'spawn rejected: not an orchestrator');
    return;
  }
  // TypeScript doesn't track mutation through the transaction callback,
  // so we assert the type here.
  const postTxnReplay = replayResult as { message: string } | null;
  if (postTxnReplay) {
    await _notifyCaller(callerSession, postTxnReplay.message);
    // P11 carry-forward: wake caller so it sees the notification on next turn
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

  // Sync admit notification — failure logged but NOT thrown
  await _notifyCaller(callerSession, `Task admitted: ${admittedTask.task_id}`);

  // P11 carry-forward: wake caller so it sees the admit notification
  void requestWake(callerSession, 'inbound-message').catch((err) =>
    log.warn('wakeContainer(caller) failed after admit notification', { err }),
  );

  // Emit dashboard event AFTER transaction committed (kind='admit')
  void lazyEmit('task_event', {
    task_id: admittedTask.task_id,
    kind: 'admit',
    agent_group_id: admittedTask.parent_agent_group_id,
    status: admittedTask.status,
    admitted_at: admittedTask.admitted_at,
  });

  // Schedule side-effect completion. Pass the resolved child agent group id
  // so the side-effect path doesn't need to re-derive it. Args stay on
  // setImmediate's own (fn, ...args) forwarding — a test asserts on that
  // exact call shape. completeSpawnSideEffects internally .catch()es
  // _runCompletionSideEffects, so the promise it returns never rejects —
  // void is safe here.
  setImmediate(
    (taskId: string, groupId: string) => {
      void completeSpawnSideEffects(taskId, groupId);
    },
    admittedTask.task_id,
    childAgentGroupId,
  );
}

/**
 * Post-admit side-effect completion: postParent → createThread → openSession.
 * Called via setImmediate from applySpawnTask AND from the reconciler for crash recovery.
 */
export async function completeSpawnSideEffects(taskId: string, childAgentGroupId: string): Promise<void> {
  // In-process deduplication guard
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
  // Acquire durable lease — returns null if another worker holds it
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

  // Resolve adapter — if adapter no longer has createThread, mark failed immediately
  // (adapter_unavailable does NOT consume retry budget — cycle-3 fix / Codex #43)
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

  // Step 1: postParent
  {
    const current = await getTaskById(taskId);
    if (!current || current.status !== 'pending') return;

    if (current.parent_platform_message_id === null) {
      const truncContent = task.task_content.slice(0, 100);
      // Per-adapter signature: postParent(platformId, text) — no channelType prefix
      const { messageId } = await adapter.postParent!(mg.platform_id, `Spawned task: ${truncContent}`);
      const updated = await updateArtifactColumn(taskId, 'parent_platform_message_id', messageId);
      if (!updated) return; // status-CAS rejected — another path won
    }
  }

  // Step 2: createThread
  {
    const current = await getTaskById(taskId);
    if (!current || current.status !== 'pending') return;

    if (current.child_platform_thread_id === null) {
      const parentMsgId = current.parent_platform_message_id!;
      // Per-adapter signature: createThread(platformId, parentMsgId, title, first)
      const { threadId } = await adapter.createThread!(
        mg.platform_id,
        parentMsgId,
        `Task: ${task.task_content.slice(0, 80)}`,
        task.task_content,
      );
      // Slack: threadId IS parent_platform_message_id (cycle-3 M25)
      const childMgId = task.parent_messaging_group_id;
      const updated = await updateArtifactColumn(taskId, 'child_platform_thread_id', threadId);
      if (!updated) return;
      if (childMgId) {
        await updateArtifactColumn(taskId, 'child_messaging_group_id', childMgId);
      }
    }
  }

  // Step 3: openSession (cycle-3 M21 write order)
  {
    const current = await getTaskById(taskId);
    if (!current || current.status !== 'pending') return;

    if (current.child_session_id === null) {
      // chat-sdk encodes thread IDs as `<scheme>:<channel>:<thread>` (Slack)
      // or `<scheme>:<guild>:<channel>:<thread>` (Discord). createThread
      // returns the BARE thread id (parent message ts on Slack), which is
      // what `child_platform_thread_id` stores for direct adapter calls.
      // For session routing the chat-sdk adapter needs the encoded form, or
      // the bridge rejects every outbound with "Invalid Slack thread ID"
      // and child status/chat messages never reach the spawn thread.
      // mg.platform_id already contains the scheme+channel prefix.
      const bareThreadId = current.child_platform_thread_id!;
      const encodedThreadId = bareThreadId.includes(':') ? bareThreadId : `${mg.platform_id}:${bareThreadId}`;
      const { session: childSession } = await resolveSession(
        childAgentGroupId,
        task.parent_messaging_group_id,
        encodedThreadId,
        'per-thread',
      );

      // a. UPDATE tasks first (cycle-3 M21)
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

      // b. Write spawn_task_id to child's inbound.db session_routing
      await _writeSpawnTaskIdToRouting(childSession.agent_group_id, childSession.id, taskId);

      // c. Write first inbound to child — stamp the spawn thread's routing
      // onto the brief inbound. The agent-runner's per-destination thread
      // resolver (poll-loop.ts `resolveDestinationThread`) looks up the
      // most-recent inbound matching channelType+platformId to find the
      // thread the child should reply into. Without these fields the
      // lookup misses and the child's chat outbound lands at channel root
      // instead of in its spawn thread — invisible to anyone watching the
      // thread, so all per-task progress/results stayed in the dark.
      //
      // threadId stored here is the chat-sdk encoded form (computed above)
      // so the value the child stamps on its outbound matches what the
      // delivery bridge expects.
      await writeSessionMessage(childSession.agent_group_id, childSession.id, {
        id: randomUUID(),
        kind: 'chat',
        timestamp: now,
        channelType: mg.channel_type,
        platformId: mg.platform_id,
        threadId: encodedThreadId,
        content: JSON.stringify({ _spawn: { task_id: taskId }, text: task.task_content }),
      });

      // d. Wake child LAST (cycle-3 M21)
      void requestWake(childSession, 'agent-created').catch((err) =>
        log.warn('wakeContainer(child) failed in threaded path', { taskId, err }),
      );

      // Notify parent with thread URL
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

    // a. UPDATE tasks first (cycle-3 M21)
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

    // b. Write spawn_task_id to child's inbound.db session_routing
    await _writeSpawnTaskIdToRouting(childSession.agent_group_id, childSession.id, taskId);

    // c. Write first inbound
    await writeSessionMessage(childSession.agent_group_id, childSession.id, {
      id: randomUUID(),
      kind: 'chat',
      timestamp: now,
      content: JSON.stringify({ _spawn: { task_id: taskId }, text: task.task_content }),
    });

    // d. Wake child LAST
    void requestWake(childSession, 'agent-created').catch((err) =>
      log.warn('wakeContainer(child) failed in headless path', { taskId, err }),
    );

    // Notify parent (no platform URL in headless mode)
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
  // `withMailboxSession` — the PROVISIONING one. I-4 governs reads, and this
  // is a write on a child session `resolveSession` just created, which may
  // have no mailbox on disk at all yet; its first inbound message is written
  // one line later through the same provisioning path. Taking the
  // existing-only funnel here would skip the stamp on exactly that child and
  // leave it running with no `spawn_task_id`, so `mountSpawnTools()` would
  // give it no way to report progress or completion — while the very next call
  // provisions the mailbox anyway.
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
