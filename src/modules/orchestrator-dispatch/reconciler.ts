import { log } from '../../log.js';
import { getOrphanedTasks } from './db/tasks.js';
import { completeSpawnSideEffects } from './dispatch.js';

export async function runReconcilerSweep(): Promise<void> {
  const orphans = await getOrphanedTasks();
  if (orphans.length === 0) return;

  log.info('Reconciler: scheduling side-effects for orphaned tasks', { count: orphans.length });
  for (const task of orphans) {
    // Dedupes against any in-flight admit via the lease. Tests assert on this
    // exact setImmediate(fn, ...args) call shape.
    setImmediate(
      (taskId: string, groupId: string) => {
        void completeSpawnSideEffects(taskId, groupId);
      },
      task.task_id,
      task.parent_agent_group_id,
    );
  }
}

let startupRan = false;

export async function runReconcilerOnStartup(): Promise<void> {
  if (startupRan) return;
  startupRan = true;
  log.info('Reconciler: running startup scan for orphaned tasks');
  await runReconcilerSweep();
}
