#!/usr/bin/env -S pnpm exec tsx
/**
 * One-shot archive-then-reclaim sweep for idle thread worktrees.
 *
 * Runs the SAME collector/policy the storage manager applies on its hourly
 * cadence (see collectThreadCacheActions / createArchiveThreadWorktreeAction
 * in src/storage-manager.ts) in a standalone process, so a backlog can be
 * drained without waiting for a host restart to deploy the policy.
 *
 * Safety parity with the in-daemon run:
 *  - central DB opened for the session-activity map (busy/live protection)
 *  - isContainerRunning approximated from sessions.container_status —
 *    conservative: any claimed-running session protects its thread
 *  - per-dir cleanup claims prevent racing the live daemon's storage worker
 *
 * Usage: pnpm exec tsx scripts/reclaim-idle-thread-worktrees.ts [--dry-run]
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { getRawDb, initDb } from '../src/db/connection.js';
import { getStorageReport } from '../src/storage-manager.js';

const dryRun = process.argv.includes('--dry-run');

await initDb(path.join(DATA_DIR, 'v2.db'));
const running = new Set(
  (getRawDb().prepare("SELECT id FROM sessions WHERE container_status = 'running'").all() as Array<{ id: string }>).map(
    (r) => r.id,
  ),
);

const report = getStorageReport({
  mode: dryRun ? 'dry-run' : 'apply',
  includeDocker: false,
  isContainerRunning: (id) => running.has(id),
  force: true, // one-shot operator run — bypass the scan cadence throttle
});

const archives = report.actions.filter(
  (a) => a.kind === 'archive-thread-worktree' || a.kind === 'archive-session',
);
let reclaimed = 0;
for (const action of archives) {
  const line = `${action.status.toUpperCase().padEnd(8)} ${Math.round(action.estimatedBytes / 1048576)} MB  ${action.path}${action.error ? `  ERROR: ${action.error}` : ''}`;
  console.log(line);
  if (action.status === 'applied') reclaimed += action.estimatedBytes;
}
const planned = archives.reduce((t, a) => t + a.estimatedBytes, 0);
console.log(
  `\n${dryRun ? `DRY-RUN: would reclaim ${Math.round(planned / 1048576)}` : `Reclaimed ${Math.round(reclaimed / 1048576)}`} MB across ${archives.length} dir(s) ` +
    `(skipped: live=${report.skipped.liveSessions + report.skipped.liveThreads} busy=${report.skipped.busySessions} fresh=${report.skipped.freshSessions + report.skipped.freshThreads})`,
);
