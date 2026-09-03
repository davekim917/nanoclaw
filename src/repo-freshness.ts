/**
 * Local-only canonical refresh recovery worker.
 *
 * Network fetches happen only inside the requesting container's scoped
 * identity. This worker advances clean host canonical working trees from refs
 * already fetched into their mounted `.git` directories; it never invokes a
 * remote or falls back to host credentials.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { onHostShutdown, onHostStart } from './host-lifecycle.js';
import { log } from './log.js';
import { refreshCanonicalFromLocalRefs } from './modules/repository-workspaces/index.js';
import { discoverCanonicalRepositories, repositoriesRoot, repositoryCoordinationDir } from './repository-workspaces.js';

const FRESHNESS_INTERVAL_MS = 10 * 60 * 1000;
const STARTUP_DELAY_MS = 90_000;

export interface CanonicalRefreshTarget {
  workgroupId: string;
  repo: string;
  canonicalPath: string;
}

export interface CanonicalRefreshState {
  ts: string;
  ok: boolean;
  oid: string | null;
  ref: string | null;
  error?: string;
}

export function discoverCanonicalRefreshTargets(dataDir: string = DATA_DIR): CanonicalRefreshTarget[] {
  const root = repositoriesRoot(dataDir);
  let workgroups: fs.Dirent[];
  try {
    workgroups = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const targets: CanonicalRefreshTarget[] = [];
  for (const entry of workgroups.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    let repositories;
    try {
      repositories = discoverCanonicalRepositories(entry.name, dataDir);
    } catch (err) {
      log.error('repo-freshness: invalid canonical workgroup directory', { workgroupId: entry.name, err });
      continue;
    }
    for (const repository of repositories) {
      targets.push({ workgroupId: entry.name, repo: repository.name, canonicalPath: repository.path });
    }
  }
  return targets;
}

function writeState(target: CanonicalRefreshTarget, state: CanonicalRefreshState, dataDir: string): void {
  const directory = repositoryCoordinationDir(target.workgroupId, target.repo, dataDir);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'refresh.json');
  const temp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Published or never created.
    }
  }
}

export async function refreshOne(
  target: CanonicalRefreshTarget,
  dataDir: string = DATA_DIR,
): Promise<CanonicalRefreshState> {
  const ts = new Date().toISOString();
  try {
    const refreshed = await refreshCanonicalFromLocalRefs({
      workgroupId: target.workgroupId,
      repo: target.repo,
      dataDir,
    });
    const state: CanonicalRefreshState = { ts, ok: true, oid: refreshed.oid, ref: refreshed.ref };
    writeState(target, state, dataDir);
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const state: CanonicalRefreshState = { ts, ok: false, oid: null, ref: null, error: message };
    writeState(target, state, dataDir);
    log.error('repo-freshness: local canonical refresh failed', {
      workgroupId: target.workgroupId,
      repo: target.repo,
      error: message,
    });
    return state;
  }
}

let running = false;

export async function runFreshnessOnce(dataDir: string = DATA_DIR): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const target of discoverCanonicalRefreshTargets(dataDir)) {
      await refreshOne(target, dataDir);
    }
  } finally {
    running = false;
  }
}

let intervalHandle: NodeJS.Timeout | null = null;
let startupHandle: NodeJS.Timeout | null = null;

export function startRepoFreshness(): void {
  if (intervalHandle || startupHandle) return;
  startupHandle = setTimeout(() => {
    startupHandle = null;
    void runFreshnessOnce().catch((err) => log.error('Repo freshness: startup run failed', { err }));
  }, STARTUP_DELAY_MS);
  startupHandle.unref?.();
  intervalHandle = setInterval(
    () => void runFreshnessOnce().catch((err) => log.error('Repo freshness: periodic run failed', { err })),
    FRESHNESS_INTERVAL_MS,
  );
  intervalHandle.unref?.();
}

export function stopRepoFreshness(): void {
  if (startupHandle) clearTimeout(startupHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  startupHandle = null;
  intervalHandle = null;
}

onHostStart(function repoFreshnessHostStart() {
  // UNGUARDED — a synchronous startup failure must abort boot (§4.2).
  startRepoFreshness();
  log.info('Repo freshness worker started');
});

onHostShutdown(function repoFreshnessHostShutdown() {
  try {
    stopRepoFreshness();
  } catch (err) {
    log.error('Repo freshness worker failed to stop', { err });
  }
});
