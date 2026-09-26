/**
 * Post-deploy crash-loop guard with automatic rollback.
 *
 * Runs from the entry bootstrap (src/index.ts) BEFORE the application module
 * graph is imported, because a bad dependency bump crashes at import time —
 * the circuit breaker at src/circuit-breaker.ts never gets to run, and
 * deploy.sh's own process group dies with the systemctl restart, so neither
 * can observe a post-restart crash loop. This guard is the only code that
 * provably executes on every boot of a broken build.
 *
 * Protocol: deploy.sh snapshots dist/ and node_modules/ (hardlink copies),
 * retags the spawn image as :pre-deploy, and writes data/deploy-rollback.json
 * just before restarting. Each boot while that manifest is fresh increments
 * data/deploy-boot-attempts.json. On the Nth boot (i.e. after N-1 straight
 * crashes) the guard restores the snapshots, resets the checkout, restarts the
 * long-running services that deploy recorded in `restartedUnits`, retags the
 * image, writes a "rolled-back" deploy status for the announcer, and exits so
 * systemd restarts into the restored build. A successful startup calls
 * markDeployBootHealthy() which disarms the guard.
 *
 * Must stay dependency-free (node builtins, and local modules that import only
 * node builtins): anything it imports becomes part of the surface it is
 * supposed to survive.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { readShadowFlag } from './shadow-flag.js';

// 3rd boot = 2 consecutive crashes after a deploy. One crash can be a fluke
// (OOM, transient port clash); two in a row right after a deploy is the
// deploy.
const MAX_BOOT_ATTEMPTS = 3;
// A manifest older than this is not "right after a deploy" — a crash 40
// minutes in is an application problem, not a rollback trigger.
const MANIFEST_WINDOW_MS = 30 * 60 * 1000;

// dist/deploy-crash-guard.js -> repo root; also correct for tsx on src/.
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface RollbackManifest {
  commit: string;
  imageBase: string;
  timestamp: string;
  /**
   * `node --version` at deploy time. The node_modules snapshot is ABI-tied
   * to this runtime (native modules like better-sqlite3 install per
   * NODE_MODULE_VERSION prebuilds): restoring it under a different Node
   * would produce a build that cannot load its native modules.
   */
  node?: string;
  /**
   * The long-running services this deploy restarted onto the deployed commit
   * (`long_running_repo_units` in scripts/deploy.sh; nanoclaw-v2 is never in
   * here — it is the service this guard is running inside). Rolling the
   * checkout back without restarting them leaves each one resident on the code
   * the reset just removed — the same defect as in the pre-handoff shell
   * trap, reproduced in the path that runs after that shell is dead.
   *
   * ABSENT and `[]` are different answers and are reported differently:
   * absent means a deploy.sh that predates sibling restarts wrote this manifest and
   * restarted nothing, `[]` means this deploy looked and found no siblings.
   */
  restartedUnits?: unknown;
}

/** A systemd unit id as `systemctl show -p Id` spells one. */
const UNIT_ID = /^[A-Za-z0-9:_.\\@-]+\.service$/;

type RestartedUnits = { kind: 'absent' } | { kind: 'units'; units: string[] } | { kind: 'malformed'; detail: string };

/**
 * Read `restartedUnits` fail-closed. A field that is present but not a list of
 * plain unit ids is never quietly downgraded to "nothing to restart" — that is
 * the shape that let a half-done rollback read as a complete one. It is
 * reported as malformed so the operator sees the rollback was partial.
 *
 * Only a MISSING KEY is `absent`. JSON cannot express `undefined`, so a parsed
 * manifest yields `undefined` exactly when the writer omitted the key — which
 * is the legacy signal. An explicit `null` is a manifest that says something
 * and says it wrong, and reading it as legacy-absence would collapse
 * present-but-malformed back into "nothing to do", which is the whole point of
 * having three answers rather than two.
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

/** Pure decision: what should this boot do? Exported for tests. */
export function evaluateBoot(
  manifest: RollbackManifest | null,
  priorAttempts: number,
  nowMs: number,
  nodeVersion: string = process.version,
): 'no-op' | 'stale' | 'arm' | 'rollback' | 'runtime-changed' {
  if (!manifest) return 'no-op';
  const age = nowMs - Date.parse(manifest.timestamp);
  if (!Number.isFinite(age) || age < 0 || age > MANIFEST_WINDOW_MS) return 'stale';
  // The Node executable changed between deploy and this boot (e.g. a runtime
  // upgrade). The snapshots are ABI-tied to the old runtime — rolling back
  // onto them would trade one broken build for another. Refuse, loudly.
  if (manifest.node && manifest.node !== nodeVersion) return 'runtime-changed';
  if (priorAttempts + 1 >= MAX_BOOT_ATTEMPTS) return 'rollback';
  return 'arm';
}

/** Swap a directory with its .pre-deploy snapshot; previous content -> .failed. */
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
  // Every step is individually caught: a throw escaping this function would
  // itself crash the boot with the manifest still armed — an infinite
  // rollback loop, i.e. the guard causing the downtime it exists to prevent.
  for (const name of ['dist', 'node_modules']) {
    try {
      // Renaming dist/ out from under the running process is safe on Linux —
      // this file is already loaded from its inode.
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
  // Put the services this deploy restarted back onto the restored checkout.
  // Same reasoning as the pre-handoff shell trap, in the path that runs after
  // that shell is dead: nanoclaw-codex-sync runs `tsx src/...`, loads the
  // source once at process start, and would otherwise keep serving — and
  // mirroring — the commit this rollback just rejected, while the host reports
  // a successful automatic rollback.
  //
  // Gated on the commit actually being reset, exactly as the shell trap is: if
  // it was skipped to preserve tracked changes, src/ is the new commit plus
  // uncommitted edits, and restarting would move the sibling onto THAT rather
  // than back. Leaving it alone is the conservative half of an already
  // ambiguous state, and the status line above says the state exists.
  //
  // Never throws: every restart is caught individually, because an escape here
  // would crash the boot with the manifest still armed — an infinite rollback
  // loop. But a failure is never silent either: it goes into `restored`, which
  // is the operator-facing status the announcer reads.
  const siblings = readRestartedUnits(manifest.restartedUnits);
  if (siblings.kind === 'malformed') {
    restored.push(`SIBLING SERVICES NOT RESTARTED — ${siblings.detail}; restart them by hand`);
    console.error('deploy-crash-guard: unusable restartedUnits —', siblings.detail);
  } else if (!commitReset) {
    if (siblings.kind === 'units' && siblings.units.length > 0) {
      restored.push(`${siblings.units.length} sibling service(s) left running (commit reset skipped)`);
    }
  } else if (siblings.kind === 'absent') {
    // Said, not inferred from silence: an older manifest restarted nothing,
    // so there is nothing to undo — which is a different fact from `[]`.
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
  // Deliberately `failed`, not a new status value: if the FIRST deploy
  // carrying this guard is the one that crash-loops, the restored dist's
  // announcer only understands ok/failed and silently consumes anything
  // else. `failed` + this step/error reads correctly on every build.
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

/**
 * Entry gate. Never throws: a bug here must not block a normal boot.
 * Runs before the app module graph is imported.
 */
export function runDeployCrashGuard(root: string = DEFAULT_ROOT, deps: GuardDeps = realDeps): void {
  let rollback: { manifest: RollbackManifest; attempts: number } | null = null;
  try {
    // A shadow host never retags images or restarts services, whatever
    // manifest its data directory holds.
    if (readShadowFlag(root)) return;
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
      // Disarm and say why: automatic rollback across a Node change would
      // restore ABI-mismatched native modules. The operator owns this one.
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
  // Outside the never-throw envelope: performRollback contains its own
  // per-step error handling and always ends in deps.exit.
  if (rollback) performRollback(root, rollback.manifest, rollback.attempts, deps);
}

/** Called by main once startup completed — the deploy is good; disarm. */
export function markDeployBootHealthy(root: string = DEFAULT_ROOT): void {
  unlinkQuiet(manifestPath(root));
  unlinkQuiet(attemptsPath(root));
}
