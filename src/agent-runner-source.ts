/**
 * Snapshots `container/agent-runner/src` once at host boot (copy, then atomic rename) and serves it as every spawn's
 * /app/src, so a `git pull` never changes what the next spawn loads before a restart. Pruning is separate and only
 * removes a snapshot no running container mounts: a bind mount pins the directory, not its entries.
 * `NANOCLAW_AGENT_RUNNER_SRC_LIVE=1` mounts the checkout directly for local dev.
 *
 * The agent-runner dependency hash is captured at the same moment, from the same checkout, because the image's
 * node_modules must match the source this host mounts, not whatever a later pull put on disk.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { CONTAINER_NAME_PREFIX, DATA_DIR, REPO_ROOT } from './config.js';
import { log } from './log.js';

const DEFAULT_SOURCE_DIR = path.join(REPO_ROOT, 'container', 'agent-runner', 'src');

let activePath: string | undefined;
let activationCounter = 0;
let bootDepsHash: string | undefined;

/** sha256(sha256(package.json) || sha256(bun.lock)), 16 hex chars; must stay byte-identical to container/build.sh. */
export function agentRunnerDepsHashOf(pkg: Buffer, lock: Buffer): string {
  const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
  return createHash('sha256')
    .update(sha(pkg) + sha(lock))
    .digest('hex')
    .slice(0, 16);
}

function captureBootDepsHash(runnerDir: string): string | undefined {
  try {
    return agentRunnerDepsHashOf(
      fs.readFileSync(path.join(runnerDir, 'package.json')),
      fs.readFileSync(path.join(runnerDir, 'bun.lock')),
    );
  } catch (err) {
    log.warn('agent-runner source: could not hash the dependency files beside the snapshot; checking the checkout', {
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    count += entry.isDirectory() ? countFiles(full) : 1;
  }
  return count;
}

function bootStamp(): string {
  // Sortable, and unique even for two activations in one millisecond.
  const compact = new Date().toISOString().replace(/[-:]/g, '');
  activationCounter += 1;
  return `${compact}-${process.pid}-${activationCounter}`;
}

export function activateAgentRunnerSource(opts?: { sourceDir?: string; dataDir?: string; live?: boolean }): string {
  const sourceDir = opts?.sourceDir ?? DEFAULT_SOURCE_DIR;
  const dataDir = opts?.dataDir ?? DATA_DIR;
  const live = opts?.live ?? process.env.NANOCLAW_AGENT_RUNNER_SRC_LIVE === '1';
  bootDepsHash = undefined;

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
    // Atomic on one filesystem: no spawn ever sees a partial copy.
    fs.renameSync(tmpDir, finalDir);

    activePath = finalDir;
    bootDepsHash = captureBootDepsHash(path.dirname(sourceDir));
    log.info('agent-runner source: snapshot activated', { path: finalDir, files: countFiles(finalDir) });
    return activePath;
  } catch (err) {
    // Never throw out of boot: fall back to mounting the checkout directly.
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

/** The dependency hash of the snapshot this host mounts; undefined while it mounts the checkout itself. */
export function agentRunnerBootDepsHash(): string | undefined {
  return bootDepsHash;
}

/**
 * Host mount sources of every running `CONTAINER_NAME_PREFIX` container, via `docker inspect`; the prefix must be
 * the spawn path's own, since a listing matching nothing prunes a live snapshot. Null (never an empty set) when
 * docker cannot be queried, so a hiccup prunes nothing.
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
 * Remove every snapshot except the active one and any a running container mounts (read from docker, so adopted
 * containers count). Best-effort: failures are logged, never thrown. Call only after the boot quiescence door has
 * proved its stop set gone.
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
  bootDepsHash = undefined;
}
