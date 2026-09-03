/**
 * T18 task-watchdog duty body (seam 2, S2-PR5) — moved out of
 * src/host-sweep.ts unchanged. Kept in its own file, sibling to index.ts, so
 * the acceptance-case suite (orchestrator.test.ts) can import it directly
 * without pulling in host-sweep.ts's whole registry import graph — the same
 * split S2-PR4 used for steer-idempotency.ts.
 *
 * DORMANT: no agent group holds the `orchestrator` capability (parked
 * 2026-08-11 — src/modules/orchestrator-dispatch/index.ts), so `getActiveTasks()`
 * returns nothing in production and this duty is a no-op.
 */
import { randomUUID } from 'crypto';

import { getSession } from '../../db/sessions.js';
import { hasContainerEverRun, isContainerRunning, sessionStillActive, wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import { getActiveTasks, transitionToTerminal } from '../orchestrator-dispatch/db/tasks.js';
import { getCapabilityConfig } from '../orchestrator-dispatch/db/agent-group-capabilities.js';
import { decideTaskAction, pendingTerminalSpawnOutboundSeenAt } from '../orchestrator-dispatch/watchdog.js';

const DEFAULT_NO_PROGRESS_TIMEOUT_SEC = 1800;
const DEFAULT_SPAWN_DEADLINE_SEC = 300;
const DEFAULT_DRAIN_GRACE_SEC = 120;

const ACTION_TO_FAIL_REASON: Record<string, string> = {
  'fail-deadline': 'deadline_exceeded',
  'fail-no-progress': 'no_progress_timeout',
  'fail-container-exit': 'container_exit',
  'fail-spawn-deadline': 'spawn_deadline',
};

export async function sweepTaskWatchdog(): Promise<void> {
  let tasks;
  try {
    tasks = getActiveTasks();
  } catch (err) {
    log.error('Task watchdog: failed to load active tasks', { err });
    return;
  }

  const now = Date.now();

  for (const task of tasks) {
    try {
      // Get child container status from in-memory container set.
      //
      // Three-state, not two. `'stopped'` means "ran and has since exited" —
      // ONLY then is `fail-container-exit` a correct reap. `null` covers two
      // legitimately-not-failed cases: (a) container hasn't been spawned yet
      // because the orchestrator's concurrency cap is queueing it, (b) wake
      // is in flight. Both look identical to `isContainerRunning` (returns
      // false) but neither should reap. `hasContainerEverRun` is the sticky
      // signal that disambiguates — set when activeContainers.add fires,
      // never cleared, so true iff this host has observed the container
      // running at some point in this process lifetime.
      let childContainerStatus: 'running' | 'stopped' | null = null;
      if (task.child_session_id !== null) {
        if (isContainerRunning(task.child_session_id)) {
          childContainerStatus = 'running';
        } else if (hasContainerEverRun(task.child_session_id)) {
          childContainerStatus = 'stopped';
        } else {
          childContainerStatus = null;
        }
      }

      // Check child's outbound.db for pending terminal spawn actions (drain-first guard).
      // Self-orchestration: child session lives in the SAME agent group as the parent,
      // so the lookup uses parent_agent_group_id.
      const terminalOutboundSeenAt =
        task.child_session_id !== null
          ? pendingTerminalSpawnOutboundSeenAt(task.parent_agent_group_id, task.child_session_id)
          : null;

      // Pull per-orchestrator timeout config; fall back to defaults when absent.
      const cap = getCapabilityConfig(task.parent_agent_group_id, 'orchestrator');
      const noProgressTimeoutSec = cap?.noProgressTimeoutSec ?? DEFAULT_NO_PROGRESS_TIMEOUT_SEC;
      const spawnDeadlineSec = cap?.spawnDeadlineSec ?? DEFAULT_SPAWN_DEADLINE_SEC;
      const drainGraceSec = cap?.drainGraceSec ?? DEFAULT_DRAIN_GRACE_SEC;

      const decision = decideTaskAction({
        now,
        task,
        childContainerStatus,
        terminalOutboundSeenAt,
        noProgressTimeoutSec,
        spawnDeadlineSec,
        drainGraceSec,
      });

      if (decision.action === 'ok') continue;

      const nowIso = new Date(now).toISOString();
      const failReason = ACTION_TO_FAIL_REASON[decision.action] ?? decision.action;
      if (!(decision.action in ACTION_TO_FAIL_REASON)) {
        log.warn('Task watchdog: unknown action, using raw value as fail_reason', { action: decision.action });
      }
      const transitioned = transitionToTerminal(task.task_id, 'failed', {
        fail_reason: failReason,
        failed_at: nowIso,
      });

      if (!transitioned) {
        // Already in terminal state (race with reconciler or another path) — skip notify.
        log.debug('Task watchdog: task already terminal, skipping notify', { taskId: task.task_id });
        continue;
      }

      // Dashboard SSE emit (post-build drift fix B5 — watchdog-fail emit callsite)
      void import('../../dashboard/api/events.js')
        .then((mod) =>
          mod.emitDashboardEvent('task_event', {
            task_id: task.task_id,
            kind: 'failed',
            agent_group_id: task.parent_agent_group_id,
          }),
        )
        .catch(() => {
          /* dashboard module may not be initialized in tests */
        });

      log.warn('Task watchdog: reaped task', {
        taskId: task.task_id,
        reason: decision.action,
        parentAgentGroupId: task.parent_agent_group_id,
        parentSessionId: task.parent_session_id,
      });

      const parentSession = getSession(task.parent_session_id);
      if (!parentSession) continue;

      try {
        // Mirror applySpawnFailed's notify shape — kind='chat' with visible
        // `text` so the orchestrator sees a normal turn input and reports
        // the failure to the user. The prior `kind='system'` envelope
        // (action `spawn_task_watchdog_fail`) had no consumer anywhere in
        // the codebase — it sat silently in the parent's inbound and no
        // human was ever told the task failed. The `_task_update` envelope
        // keeps the machine-readable surface for any future consumer that
        // wants to react to status transitions without parsing the text.
        await writeSessionMessage(task.parent_agent_group_id, task.parent_session_id, {
          id: randomUUID(),
          kind: 'chat',
          timestamp: nowIso,
          content: JSON.stringify({
            text:
              `Task failed (watchdog): ${task.task_id}. Reason: ${failReason}. ` +
              `The orchestrator should notify the user and decide whether to re-spawn.`,
            _task_update: {
              task_id: task.task_id,
              status: 'failed',
              fail_reason: failReason,
              source: 'watchdog',
            },
          }),
        });
        // `parentSession` was fetched before the awaited mailbox write above,
        // and the parent can be archived in that window — but so can it be
        // archived during the wake's own awaits, which a re-read here cannot
        // see. The proof travels with the wake.
        void wakeContainer(parentSession, 'interactive', {
          guard: sessionStillActive(parentSession.id),
        }).catch((err) => log.warn('Task watchdog: wakeContainer(parent) failed', { taskId: task.task_id, err }));
      } catch (err) {
        log.warn('Task watchdog: failed to notify parent', { taskId: task.task_id, err });
      }
    } catch (err) {
      log.error('Task watchdog: error processing task', { taskId: task.task_id, err });
    }
  }
}
