/**
 * PARKED: no agent group holds the `orchestrator` capability, so none of these
 * actions fire. Kept compiled and tested; do not delete, do not re-grant
 * without a decision. `grantCapability()` alone is NOT a restore: nothing reaps
 * an admitted task any more, so a stalled child would stay `running` forever
 * and hold its parent's concurrency slot. Children run in the parent's agent
 * group; only the session/thread is isolated.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { applySpawnTask } from './dispatch.js';
import { applySpawnComplete, applySpawnFailed } from './completion.js';
import { applySpawnProgress } from './progress.js';
import { applySpawnCancel } from './cancellation.js';
import { applySpawnNeedsInput } from './needs-input.js';

// The reconciler startup scan queries the central DB and MUST run after
// initDb() + runMigrations(), so it is re-exported for main() rather than run here.
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
