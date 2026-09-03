/**
 * Agent-runner source activation (mailbox seam PR 0).
 *
 * `container-runner.ts` bind-mounts a directory at /app/src for every
 * container spawn. Mounting the live checkout directly meant `git pull`
 * changed what the *next spawn* loaded mid-pull — a non-atomic, silent
 * window — before the host process restarted. This module snapshots
 * `container/agent-runner/src` once at host boot (`main.ts` calls
 * `activateAgentRunnerSource()` before anything can spawn) so activation
 * happens exactly at restart: copy to a temp dir under `data/agent-runner-src/`,
 * atomically rename it in, then prune every other snapshot — running
 * containers keep their already-bind-mounted inode, only new spawns see the
 * change. Rollback of a runner-source edit is therefore a host restart.
 * `NANOCLAW_AGENT_RUNNER_SRC_LIVE=1` mounts the checkout directly for local
 * dev (`pnpm run dev`) so edits take effect without a restart.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, REPO_ROOT } from './config.js';
import { log } from './log.js';

const DEFAULT_SOURCE_DIR = path.join(REPO_ROOT, 'container', 'agent-runner', 'src');

let activePath: string | undefined;
let activationCounter = 0;

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    count += entry.isDirectory() ? countFiles(full) : 1;
  }
  return count;
}

function bootStamp(): string {
  // e.g. 20260902T233000123Z-12345-0 — sortable, unique per process even
  // across two activations inside the same millisecond (a real host only
  // ever activates once per boot, but tests and any future re-activation
  // path must not collide on the directory name).
  const compact = new Date().toISOString().replace(/[-:]/g, '');
  activationCounter += 1;
  return `${compact}-${process.pid}-${activationCounter}`;
}

export function activateAgentRunnerSource(opts?: { sourceDir?: string; dataDir?: string; live?: boolean }): string {
  const sourceDir = opts?.sourceDir ?? DEFAULT_SOURCE_DIR;
  const dataDir = opts?.dataDir ?? DATA_DIR;
  const live = opts?.live ?? process.env.NANOCLAW_AGENT_RUNNER_SRC_LIVE === '1';

  if (live) {
    activePath = sourceDir;
    log.info('agent-runner source: mounting live checkout (NANOCLAW_AGENT_RUNNER_SRC_LIVE=1)', {
      path: sourceDir,
    });
    return activePath;
  }

  const root = path.join(dataDir, 'agent-runner-src');
  const stamp = bootStamp();
  const finalDir = path.join(root, stamp);
  const tmpDir = path.join(root, `${stamp}.tmp`);

  try {
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(sourceDir, tmpDir, { recursive: true });
    // Atomic within the same filesystem — the snapshot appears fully formed
    // or not at all; no spawn ever sees a partial copy.
    fs.renameSync(tmpDir, finalDir);

    for (const entry of fs.readdirSync(root)) {
      if (entry === stamp) continue;
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }

    activePath = finalDir;
    log.info('agent-runner source: snapshot activated', { path: finalDir, files: countFiles(finalDir) });
    return activePath;
  } catch (err) {
    // Never throw out of boot — fall back to the pre-PR-0 behavior (mount
    // the checkout directly) so the host still comes up.
    log.error('agent-runner source: snapshot failed, falling back to the checkout', {
      err: err instanceof Error ? err.message : String(err),
    });
    activePath = sourceDir;
    return activePath;
  }
}

export function agentRunnerSourcePath(): string {
  return activePath ?? DEFAULT_SOURCE_DIR;
}

export function resetAgentRunnerSourceForTesting(): void {
  activePath = undefined;
  activationCounter = 0;
}
