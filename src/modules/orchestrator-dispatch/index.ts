/**
 * Orchestrator self-spawn module.
 *
 * PARKED since 2026-08-11: no agent group holds the `orchestrator` capability, so none of
 * these actions fire and the reconciler sweep (src/modules/sweep-orchestrator/) is a no-op.
 * Kept compiled + tested pending a new fan-out strategy. Do not delete, do not re-grant
 * without a decision. See docs/specs/orchestrator-dispatch/spawn-rework-plan.md.
 *
 * `grantCapability()` alone is NOT a restore: nothing reaps an admitted task any more — no
 * deadline, no-progress timeout, spawn deadline or child-exit check — so a stalled or dead
 * child would stay `running` forever, hold its parent's concurrency slot, and keep
 * `revokeCapability()` answering `tasks_in_flight`. Restoring dispatch needs a task reaper
 * first.
 *
 * Registers 5 delivery actions for the spawn pipeline:
 *   - spawn_task      (orchestrator → host: admit new task)
 *   - spawn_complete  (child → host: task done)
 *   - spawn_failed    (child → host: task failed)
 *   - spawn_cancel    (orchestrator → host: cancel a running task)
 *   - spawn_progress  (child → host: heartbeat update)
 *
 * Spawned children always run in the SAME agent group as the parent — they share
 * workspace, memory, CLAUDE.md, channels. Only the session/thread is isolated.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { applySpawnTask } from './dispatch.js';
import { applySpawnComplete, applySpawnFailed } from './completion.js';
import { applySpawnProgress } from './progress.js';
import { applySpawnCancel } from './cancellation.js';
import { applySpawnNeedsInput } from './needs-input.js';

// NOTE: registerDeliveryAction is side-effect-only and safe at module-import time
// (it just adds to an in-memory map). The reconciler startup scan, however, queries
// the central DB and MUST run AFTER initDb() + runMigrations() in main(). Re-export
// the startup hook so src/index.ts can call it at the right moment instead of
// running it here at module-import time (which would crash because the DB isn't ready).
const ORCHESTRATOR_ACTION = unguarded(
  'same-agent-group session orchestration; handlers derive parent and child scope from trusted session state',
);
registerDeliveryAction('spawn_task', applySpawnTask, ORCHESTRATOR_ACTION);
registerDeliveryAction('spawn_complete', applySpawnComplete, ORCHESTRATOR_ACTION);
registerDeliveryAction('spawn_failed', applySpawnFailed, ORCHESTRATOR_ACTION);
registerDeliveryAction('spawn_cancel', applySpawnCancel, ORCHESTRATOR_ACTION);
registerDeliveryAction('spawn_progress', applySpawnProgress, ORCHESTRATOR_ACTION);
registerDeliveryAction('spawn_request_steer', applySpawnNeedsInput, ORCHESTRATOR_ACTION);

export { runReconcilerOnStartup } from './reconciler.js';
