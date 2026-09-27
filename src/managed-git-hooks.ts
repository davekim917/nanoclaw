/**
 * Host-managed pre-push secret-scan hook for scan-policy canonical repositories (others stay hookless with
 * `core.hooksPath=/dev/null`, since an agent re-running `clone_repo` would strip any per-repo hook). `scan/` holds
 * the real hook and pattern lib as of this process's last refresh; `refuse/` holds a compiled fallback that
 * always exits 1.
 *
 * `core.hooksPath` itself is the mount signal: every writer must use exactly MANAGED_GIT_HOOKS_SCAN_DIR, or the
 * repo silently drops out of hook coverage.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, REPO_ROOT } from './config.js';
import { resolveContainedRealDirectory } from './fs-safety.js';
import { log } from './log.js';
import { repositoryConfigPath, safeGitConfigGet, safeGitConfigSet } from './safe-git.js';
import { discoverCanonicalRepositories, repositoriesRoot } from './repository-workspaces.js';

const MANAGED_GIT_HOOKS_ROOT = path.join(DATA_DIR, 'managed-git-hooks');
/** The ONE core.hooksPath value every writer must use and every mount check compares against. */
export const MANAGED_GIT_HOOKS_SCAN_DIR = path.join(MANAGED_GIT_HOOKS_ROOT, 'scan');
export const MANAGED_GIT_HOOKS_REFUSE_DIR = path.join(MANAGED_GIT_HOOKS_ROOT, 'refuse');
export const MANAGED_HOOK_FILENAME = 'pre-push';
export const MANAGED_PATTERNS_FILENAME = 'nanoclaw-secret-patterns.sh';

// Lazy: many tests import this transitively under a partial `./config.js` mock without REPO_ROOT.
function hookSourcePath(): string {
  return path.join(REPO_ROOT, 'scripts', 'wiki-pre-push-hook.sh');
}
function patternsSourcePath(): string {
  return path.join(REPO_ROOT, 'scripts', 'lib', 'secret-scan.sh');
}

/**
 * The hook's secret patterns have measured false-positive vectors in code repos; widen only after measuring.
 * The runner's copy lives in `scan-policy-repos.json`; managed-git-hooks.test.ts asserts they deep-equal.
 */
export const SCAN_POLICY_REPOSITORY_NAMES: readonly string[] = ['wiki'];

export function isScanPolicyRepositoryName(name: string): boolean {
  return SCAN_POLICY_REPOSITORY_NAMES.includes(name);
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readSourceOrThrow(file: string): Buffer {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe managed-hook source: ${file}`);
  return fs.readFileSync(file);
}

function atomicWriteInDir(dir: string, filename: string, content: Buffer, mode: number): void {
  const dest = path.join(dir, filename);
  const temp = path.join(dir, `${filename}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(temp, content, { mode });
    const fd = fs.openSync(temp, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, dest);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Published or never created.
    }
  }
  const dirFd = fs.openSync(dir, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

/**
 * Validate every component (via resolveContainedRealDirectory), not just the leaf: an lstat on the leaf alone
 * passes a symlinked parent. Returns the validated realpath.
 */
function validateManagedDirChain(dir: string): string {
  const leaf = path.basename(dir);
  const middle = path.basename(path.dirname(dir));
  const root = path.dirname(path.dirname(dir));
  return resolveContainedRealDirectory(root, middle, leaf);
}

function isHostOwned(dir: string): boolean {
  if (!process.getuid) return true;
  return fs.lstatSync(dir).uid === process.getuid();
}

/**
 * Create one component and confirm it is a real directory. NON-recursive on purpose: a recursive mkdir through a
 * symlinked parent writes inside its target before any validation runs.
 */
function ensureRealDirectoryComponent(parent: string, name: string): string {
  const target = path.join(parent, name);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    fs.mkdirSync(target, { mode: 0o755 });
    stat = fs.lstatSync(target);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`unsafe managed-hooks path component (not a real directory): ${target}`);
  }
  return target;
}

/** Component by component, before any write. `root` is validated but never created. */
function ensureManagedDirChain(dir: string): void {
  const leaf = path.basename(dir);
  const middle = path.basename(path.dirname(dir));
  const root = path.dirname(path.dirname(dir));
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`unsafe managed-hooks root (not a real directory): ${root}`);
  }
  const managedRoot = ensureRealDirectoryComponent(root, middle);
  ensureRealDirectoryComponent(managedRoot, leaf);
}

/**
 * Refresh the scan dir from the shipped sources, idempotently. The directory is never replaced (a container that
 * mounted it would keep a stale inode); lib is written before hook. Records the hashes in process memory: the
 * integrity check compares against these, not a live REPO_ROOT read, which a mid-uptime deploy would change.
 */
export function refreshManagedGitHooks(scanDir: string = MANAGED_GIT_HOOKS_SCAN_DIR): {
  hookSha256: string;
  patternsSha256: string;
} {
  ensureManagedDirChain(scanDir);
  const patterns = readSourceOrThrow(patternsSourcePath());
  const hook = readSourceOrThrow(hookSourcePath());
  atomicWriteInDir(scanDir, MANAGED_PATTERNS_FILENAME, patterns, 0o644);
  atomicWriteInDir(scanDir, MANAGED_HOOK_FILENAME, hook, 0o755);
  const snapshot = { hookSha256: sha256(hook), patternsSha256: sha256(patterns) };
  recordedSnapshots.set(scanDir, snapshot);
  return snapshot;
}

/** Never persisted: an empty map means "no refresh yet" and fails closed to the refuse hook. */
const recordedSnapshots = new Map<string, { hookSha256: string; patternsSha256: string }>();

/** Against this process's recorded snapshot; false on any problem, which callers treat as "use the refuse hook". */
function checkScanHooksIntegrity(scanDir: string): boolean {
  const snapshot = recordedSnapshots.get(scanDir);
  if (!snapshot) return false;
  try {
    validateManagedDirChain(scanDir);
    if (!isHostOwned(scanDir)) return false;
    const hookPath = path.join(scanDir, MANAGED_HOOK_FILENAME);
    const hookStat = fs.lstatSync(hookPath);
    if (hookStat.isSymbolicLink() || !hookStat.isFile() || (hookStat.mode & 0o111) === 0) return false;
    if (sha256(fs.readFileSync(hookPath)) !== snapshot.hookSha256) return false;
    const patternsPath = path.join(scanDir, MANAGED_PATTERNS_FILENAME);
    const patternsStat = fs.lstatSync(patternsPath);
    if (patternsStat.isSymbolicLink() || !patternsStat.isFile()) return false;
    if (sha256(fs.readFileSync(patternsPath)) !== snapshot.patternsSha256) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Compiled constant, never a REPO_ROOT read, so a mid-uptime deploy cannot break the fallback. `/bin/sh`, no lib.
 * Names an operator action, never `--no-verify`.
 */
const REFUSE_HOOK_CONTENT = Buffer.from(
  [
    '#!/bin/sh',
    '# nanoclaw-managed-hook: wiki-pre-push-secret-scan (refuse fallback)',
    'echo "pre-push refused: the managed secret-scan hook is unavailable on this host right now (a boot-time integrity check failed, or no refresh has completed on this process yet)." >&2',
    'echo "This is not a scan result -- no content was scanned. An operator must investigate (host logs, data/managed-git-hooks/) and restart this container (ncl groups restart) before wiki pushes will work again." >&2',
    'exit 1',
    '',
  ].join('\n'),
  'utf8',
);

/**
 * Explicitly 0755: git silently skips a non-executable hook and exits 0. Also called lazily by
 * decideHooksMountStrategy, so a boot-time failure does not strand repos without the fallback.
 */
export function ensureRefuseHook(refuseDir: string = MANAGED_GIT_HOOKS_REFUSE_DIR): void {
  ensureManagedDirChain(refuseDir);
  atomicWriteInDir(refuseDir, MANAGED_HOOK_FILENAME, REFUSE_HOOK_CONTENT, 0o755);
}

/** As strict as scan/: real dir chain, host-owned, executable regular file byte-identical to REFUSE_HOOK_CONTENT. */
function checkRefuseHookIntegrity(refuseDir: string): boolean {
  try {
    validateManagedDirChain(refuseDir);
    if (!isHostOwned(refuseDir)) return false;
    const hookPath = path.join(refuseDir, MANAGED_HOOK_FILENAME);
    const stat = fs.lstatSync(hookPath);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o111) === 0) return false;
    return fs.readFileSync(hookPath).equals(REFUSE_HOOK_CONTENT);
  } catch {
    return false;
  }
}

export type HooksMountStrategy = 'scan' | 'refuse' | 'withhold';

/**
 * git runs NO hook and exits 0 when `core.hooksPath` is missing or non-executable (git 2.43), so "mount nothing"
 * would let pushes through unscanned. Never throws:
 *   1. 'scan'     — scan/ passes its integrity check: mount the real hook.
 *   2. 'refuse'   — else, after a lazy ensure, mount the refuse hook AT THE SCAN path so git refuses the push.
 *   3. 'withhold' — else the caller withholds every mount for the repo, so git fails outright.
 * Never logs; callers alert on 'refuse'/'withhold' and dedupe per repo.
 */
export function decideHooksMountStrategy(
  scanDir: string = MANAGED_GIT_HOOKS_SCAN_DIR,
  refuseDir: string = MANAGED_GIT_HOOKS_REFUSE_DIR,
): HooksMountStrategy {
  if (checkScanHooksIntegrity(scanDir)) return 'scan';
  try {
    ensureRefuseHook(refuseDir);
  } catch (err) {
    log.error('managed-git-hooks: failed to (re)write the refuse fallback hook', { err });
  }
  if (checkRefuseHookIntegrity(refuseDir)) return 'refuse';
  return 'withhold';
}

export interface CanonicalHooksPathMigrationResult {
  /** Repos whose core.hooksPath was unset or /dev/null and is now the managed scan dir. */
  updated: number;
  /** workgroupId/repo pairs whose EXISTING core.hooksPath was neither of those — alerted, never overwritten. */
  alerts: string[];
}

/**
 * Idempotent startup pass pointing each scan-policy canonical repo's unset or `/dev/null` hooksPath at the scan
 * dir (targeted `git config --file`). Any other existing value, or a per-repo failure, lands in `alerts` and is
 * never overwritten. Returns counts only, safe to log.
 */
export function migrateExistingCanonicalHooksPath(dataDir: string = DATA_DIR): CanonicalHooksPathMigrationResult {
  const root = repositoriesRoot(dataDir);
  let workgroups: fs.Dirent[];
  try {
    workgroups = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { updated: 0, alerts: [] };
  }
  let updated = 0;
  const alerts: string[] = [];
  for (const entry of workgroups.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    let repositories;
    try {
      repositories = discoverCanonicalRepositories(entry.name, dataDir);
    } catch (err) {
      log.error('managed-git-hooks: invalid canonical workgroup directory during hooksPath migration', {
        workgroupId: entry.name,
        err,
      });
      continue;
    }
    for (const repository of repositories) {
      if (!isScanPolicyRepositoryName(repository.name)) continue;
      try {
        const configPath = repositoryConfigPath(repository.gitDir);
        const current = safeGitConfigGet(configPath, 'core.hooksPath');
        if (current === MANAGED_GIT_HOOKS_SCAN_DIR) continue;
        if (current !== null && current !== '/dev/null') {
          alerts.push(`${entry.name}/${repository.name}`);
          continue;
        }
        safeGitConfigSet(configPath, 'core.hooksPath', MANAGED_GIT_HOOKS_SCAN_DIR);
        updated += 1;
      } catch (err) {
        log.error('managed-git-hooks: hooksPath migration failed for one repository (left untouched)', {
          workgroupId: entry.name,
          repo: repository.name,
          err,
        });
        alerts.push(`${entry.name}/${repository.name}`);
      }
    }
  }
  if (alerts.length > 0) {
    log.error('managed-git-hooks: scan-policy repo(s) have a non-default core.hooksPath, left untouched', {
      count: alerts.length,
    });
  }
  return { updated, alerts };
}

/**
 * One-shot, not an onHostStart registrant (those are recurring timers pinned by host-lifecycle-timers.test.ts).
 * Must run after the boot mount-quiescence door and before anything can spawn. Each step has its own try/catch
 * and this never throws; the mount strategy's fallback order is what protects pushes.
 */
export function initializeManagedGitHooks(): void {
  try {
    ensureRefuseHook();
  } catch (err) {
    log.error('managed-git-hooks: refuse-hook write failed at startup', { err });
  }

  let hookSha256: string | undefined;
  try {
    ({ hookSha256 } = refreshManagedGitHooks());
  } catch (err) {
    log.error('managed-git-hooks: scan-dir refresh failed at startup', { err });
  }

  let updated = 0;
  let alertCount = 0;
  try {
    const migration = migrateExistingCanonicalHooksPath();
    updated = migration.updated;
    alertCount = migration.alerts.length;
  } catch (err) {
    log.error('managed-git-hooks: hooksPath migration pass failed at startup', { err });
  }

  log.info('Managed git hooks initialized', { hookSha256, hooksPathMigrated: updated, hooksPathAlerts: alertCount });
}
