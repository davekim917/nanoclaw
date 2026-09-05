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
 * then atomically rename it in. Pruning old snapshots is a SEPARATE step
 * (`pruneAgentRunnerSnapshots()`, called from `main.ts` after orphan
 * containers from a previous host process have been stopped): a bind mount
 * pins the directory, not its entries, so deleting an old snapshot's
 * contents out from under a still-running container would empty its
 * `/app/src` live. Pruning therefore only removes a snapshot once no
 * running container has it mounted. Rollback of a runner-source edit is a
 * host restart. `NANOCLAW_AGENT_RUNNER_SRC_LIVE=1` mounts the checkout
 * directly for local dev (`pnpm run dev`) so edits take effect without a
 * restart.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_NAME_PREFIX, DATA_DIR, REPO_ROOT } from './config.js';
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
    // or not at all; no spawn ever sees a partial copy. Pruning old
    // snapshots is a separate call (pruneAgentRunnerSnapshots) — see the
    // module header for why activation must not also delete.
    fs.renameSync(tmpDir, finalDir);

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

/**
 * Default `referencedPaths` for pruneAgentRunnerSnapshots: the host mount
 * source of every mount on every running container whose name carries
 * `CONTAINER_NAME_PREFIX`, read via `docker inspect`. That prefix is the same
 * constant the spawn path names the container with (src/config.ts), because a
 * successful listing that matches nothing returns an EMPTY set here and would
 * prune a snapshot a live container still has mounted.
 * Returns null (never an empty set) when docker itself
 * cannot be queried, so a Docker hiccup fails toward "prune nothing" rather
 * than toward deleting a snapshot a live container still has mounted.
 */
function defaultReferencedPaths(): Set<string> | null {
  try {
    const psOut = execFileSync('docker', ['ps', '-q', '--filter', `name=${CONTAINER_NAME_PREFIX}`], {
      encoding: 'utf-8',
    });
    const ids = psOut
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const referenced = new Set<string>();
    for (const id of ids) {
      const inspectOut = execFileSync(
        'docker',
        ['inspect', '--format', '{{range .Mounts}}{{.Source}}{{"\\n"}}{{end}}', id],
        { encoding: 'utf-8' },
      );
      for (const line of inspectOut.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) referenced.add(trimmed);
      }
    }
    return referenced;
  } catch (err) {
    log.warn('agent-runner source: could not list running container mounts, pruning nothing', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Removes every snapshot under `data/agent-runner-src/` except the active
 * one and any still mounted by a running container. Best-effort: a failure
 * removing one entry is logged and skipped, never thrown — pruning is
 * housekeeping, not a boot-blocking step. Call only after orphan containers
 * from a previous host process have been stopped (`main.ts` calls this
 * right after `cleanupOrphansStrict()`); once container adoption across
 * restarts (mailbox seam 2) lands, `referencedPaths` must keep covering
 * adopted containers too, or a live one can lose its mount out from under it.
 */
export function pruneAgentRunnerSnapshots(opts?: {
  dataDir?: string;
  referencedPaths?: () => Set<string> | null;
}): void {
  const dataDir = opts?.dataDir ?? DATA_DIR;
  const referencedPathsFn = opts?.referencedPaths ?? defaultReferencedPaths;
  const root = path.join(dataDir, 'agent-runner-src');

  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return; // nothing snapshotted yet (or dataDir doesn't exist) — nothing to prune
  }

  const referenced = referencedPathsFn();
  if (referenced === null) {
    log.warn('agent-runner source: skipping snapshot pruning this pass — referenced-mounts check failed');
    return;
  }

  const activeBasename = activePath ? path.basename(activePath) : undefined;
  for (const entry of entries) {
    if (entry === activeBasename) continue;
    const full = path.join(root, entry);
    if (referenced.has(full)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch (err) {
      log.warn('agent-runner source: failed to remove a stale snapshot', {
        path: full,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function resetAgentRunnerSourceForTesting(): void {
  activePath = undefined;
  activationCounter = 0;
}
