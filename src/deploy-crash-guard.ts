/**
 * Post-deploy crash-loop guard with automatic rollback. Runs from src/index.ts BEFORE the app module graph is
 * imported, because a bad dependency bump crashes at import time where nothing else can observe it.
 *
 * deploy.sh snapshots dist/ and node_modules/, retags the image :pre-deploy and writes data/deploy-rollback.json;
 * each boot inside the manifest window counts an attempt, and the Nth restores snapshots, resets the checkout,
 * restarts `restartedUnits`, retags and exits. markDeployBootHealthy() disarms it.
 *
 * Must stay dependency-free (node builtins only): anything it imports is part of the surface it must survive.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 3rd boot = 2 consecutive crashes after a deploy; one crash can be a fluke.
const MAX_BOOT_ATTEMPTS = 3;
const MANIFEST_WINDOW_MS = 30 * 60 * 1000;

// dist/deploy-crash-guard.js -> repo root; also correct for tsx on src/.
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface RollbackManifest {
  commit: string;
  imageBase: string;
  timestamp: string;
  /** `node --version` at deploy time; the node_modules snapshot is ABI-tied to it. */
  node?: string;
  /**
   * Sibling services this deploy restarted onto the deployed commit; a rollback must restart them too.
   * Absent means an older deploy.sh restarted nothing; `[]` means it looked and found none.
   */
  restartedUnits?: unknown;
}

const UNIT_ID = /^[A-Za-z0-9:_.\\@-]+\.service$/;

type RestartedUnits = { kind: 'absent' } | { kind: 'units'; units: string[] } | { kind: 'malformed'; detail: string };

/**
 * Fail-closed: a present field that isn't a list of unit ids is malformed, never "nothing to restart", so a
 * partial rollback can't read as complete. Only a missing key is `absent`; an explicit `null` is malformed.
 */
export function readRestartedUnits(raw: unknown): RestartedUnits {
  if (raw === undefined) return { kind: 'absent' };
  if (!Array.isArray(raw)) {
    return { kind: 'malformed', detail: `restartedUnits is ${raw === null ? 'null' : typeof raw}, not a list` };
  }
  const bad = raw.filter((u) => typeof u !== 'string' || !UNIT_ID.test(u));
  if (bad.length > 0) {
    return { kind: 'malformed', detail: `restartedUnits holds ${bad.length} entr(y/ies) that is not a unit id` };
  }
  return { kind: 'units', units: raw as string[] };
}

interface GuardDeps {
  execFile: (cmd: string, args: string[], opts: { cwd: string }) => string;
  exit: (code: number) => never;
  now: () => number;
}

const realDeps: GuardDeps = {
  execFile: (cmd, args, opts) => {
    return execFileSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8', stdio: 'pipe' });
  },
  exit: (code) => process.exit(code),
  now: () => Date.now(),
};

function manifestPath(root: string): string {
  return path.join(root, 'data', 'deploy-rollback.json');
}
function attemptsPath(root: string): string {
  return path.join(root, 'data', 'deploy-boot-attempts.json');
}
function statusPath(root: string): string {
  return path.join(root, 'logs', 'deploy-status.json');
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function unlinkQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Best-effort: nothing to clean up if the file is already gone.
  }
}

export function evaluateBoot(
  manifest: RollbackManifest | null,
  priorAttempts: number,
  nowMs: number,
  nodeVersion: string = process.version,
): 'no-op' | 'stale' | 'arm' | 'rollback' | 'runtime-changed' {
  if (!manifest) return 'no-op';
  const age = nowMs - Date.parse(manifest.timestamp);
  if (!Number.isFinite(age) || age < 0 || age > MANIFEST_WINDOW_MS) return 'stale';
  // Snapshots are ABI-tied to the deploy-time runtime; rolling back onto them under another Node breaks the build.
  if (manifest.node && manifest.node !== nodeVersion) return 'runtime-changed';
  if (priorAttempts + 1 >= MAX_BOOT_ATTEMPTS) return 'rollback';
  return 'arm';
}

function restoreSnapshot(root: string, name: string): boolean {
  const live = path.join(root, name);
  const snapshot = path.join(root, `${name}.pre-deploy`);
  const failed = path.join(root, `${name}.failed`);
  if (!fs.existsSync(snapshot)) return false;
  fs.rmSync(failed, { recursive: true, force: true });
  if (fs.existsSync(live)) fs.renameSync(live, failed);
  fs.renameSync(snapshot, live);
  return true;
}

export function performRollback(
  root: string,
  manifest: RollbackManifest,
  attempts: number,
  deps: GuardDeps = realDeps,
): never {
  const restored: string[] = [];
  // Every step is individually caught: an escaping throw would crash the boot with the manifest still armed,
  // an infinite rollback loop.
  for (const name of ['dist', 'node_modules']) {
    try {
      if (restoreSnapshot(root, name)) restored.push(name);
    } catch (err) {
      console.error(`deploy-crash-guard: could not restore ${name}`, err);
    }
  }
  let commitReset = false;
  try {
    const tracked = deps.execFile('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root }).trim();
    if (tracked) {
      restored.push('tracked source changes preserved (commit reset skipped)');
    } else {
      deps.execFile('git', ['reset', '--hard', manifest.commit], { cwd: root });
      restored.push(`commit ${manifest.commit.slice(0, 8)}`);
      commitReset = true;
    }
  } catch (err) {
    console.error('deploy-crash-guard: git reset failed', err);
  }
  // Sibling services load source once at start and would keep running the rejected commit. Gated on the reset
  // having happened: otherwise src/ is the new commit plus edits, and a restart would move them onto that.
  // Failures go into `restored`, the operator-facing status.
  const siblings = readRestartedUnits(manifest.restartedUnits);
  if (siblings.kind === 'malformed') {
    restored.push(`SIBLING SERVICES NOT RESTARTED — ${siblings.detail}; restart them by hand`);
    console.error('deploy-crash-guard: unusable restartedUnits —', siblings.detail);
  } else if (!commitReset) {
    if (siblings.kind === 'units' && siblings.units.length > 0) {
      restored.push(`${siblings.units.length} sibling service(s) left running (commit reset skipped)`);
    }
  } else if (siblings.kind === 'absent') {
    console.error('deploy-crash-guard: manifest predates sibling restarts — no services to put back');
  } else {
    for (const unit of siblings.units) {
      try {
        deps.execFile('sudo', ['systemctl', 'restart', unit], { cwd: root });
        restored.push(unit);
      } catch (err) {
        restored.push(`${unit} FAILED TO RESTART — it is NOT running the restored code`);
        console.error(`deploy-crash-guard: could not restart ${unit}`, err);
      }
    }
  }
  if (manifest.imageBase) {
    try {
      deps.execFile('docker', ['inspect', `${manifest.imageBase}:pre-deploy`], { cwd: root });
      deps.execFile('docker', ['tag', `${manifest.imageBase}:pre-deploy`, `${manifest.imageBase}:latest`], {
        cwd: root,
      });
      restored.push('image');
    } catch {
      // No pre-deploy tag (deploy didn't rebuild the image) — nothing to undo.
    }
  }
  // `failed`, not a new status: an older restored announcer understands only ok/failed.
  const status = {
    status: 'failed',
    step: 'crash guard',
    error: `rolled back automatically after ${attempts} failed boots — restored ${restored.join(', ') || 'nothing (no snapshots found)'}; the deployed commit needs a fix before retrying`,
    timestamp: new Date(deps.now()).toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(statusPath(root)), { recursive: true });
    fs.writeFileSync(statusPath(root), JSON.stringify(status) + '\n');
  } catch (err) {
    console.error('deploy-crash-guard: could not write deploy status', err);
  }
  // Disarm before exiting: a failed rollback must not retry forever.
  unlinkQuiet(manifestPath(root));
  unlinkQuiet(attemptsPath(root));
  console.error('deploy-crash-guard: rolled back —', status.error);
  return deps.exit(1);
}

/** Never throws: a bug here must not block a normal boot. */
export function runDeployCrashGuard(root: string = DEFAULT_ROOT, deps: GuardDeps = realDeps): void {
  let rollback: { manifest: RollbackManifest; attempts: number } | null = null;
  try {
    const manifest = readJson<RollbackManifest>(manifestPath(root));
    const prior = readJson<{ attempts: number }>(attemptsPath(root))?.attempts ?? 0;
    const verdict = evaluateBoot(manifest, prior, deps.now());
    if (verdict === 'no-op') return;
    if (verdict === 'stale') {
      unlinkQuiet(manifestPath(root));
      unlinkQuiet(attemptsPath(root));
      return;
    }
    if (verdict === 'runtime-changed') {
      try {
        fs.mkdirSync(path.dirname(statusPath(root)), { recursive: true });
        fs.writeFileSync(
          statusPath(root),
          JSON.stringify({
            status: 'failed',
            step: 'crash guard',
            error: `Node runtime changed since deploy (${(manifest as RollbackManifest).node} -> ${process.version}); automatic rollback disabled — snapshots are ABI-tied to the old runtime. If the service is unhealthy, roll back manually (restore the previous Node executable, or reinstall dependencies under the current one).`,
            timestamp: new Date(deps.now()).toISOString(),
          }) + '\n',
        );
      } catch (err) {
        console.error('deploy-crash-guard: could not write runtime-changed status', err);
      }
      unlinkQuiet(manifestPath(root));
      unlinkQuiet(attemptsPath(root));
      return;
    }
    if (verdict === 'rollback') {
      rollback = { manifest: manifest as RollbackManifest, attempts: prior + 1 };
    } else {
      // 'arm': record this boot attempt before the risky imports run.
      fs.mkdirSync(path.dirname(attemptsPath(root)), { recursive: true });
      fs.writeFileSync(
        attemptsPath(root),
        JSON.stringify({ attempts: prior + 1, timestamp: new Date(deps.now()).toISOString() }) + '\n',
      );
    }
  } catch (err) {
    console.error('deploy-crash-guard: non-fatal error, continuing boot', err);
  }
  // Outside the never-throw envelope: performRollback handles its own errors and always exits.
  if (rollback) performRollback(root, rollback.manifest, rollback.attempts, deps);
}

export function markDeployBootHealthy(root: string = DEFAULT_ROOT): void {
  unlinkQuiet(manifestPath(root));
  unlinkQuiet(attemptsPath(root));
}
