/**
 * Host-managed pre-push secret-scan hook for scan-policy canonical
 * repositories.
 *
 * Canonical repositories are otherwise hookless by design:
 * sanitizeCanonicalConfig (src/modules/repository-workspaces/index.ts) and
 * the migration replacement path (src/repository-migration.ts) both write
 * `core.hooksPath = /dev/null` on every clone/republish, because an agent
 * can re-run `clone_repo` at any time and would silently strip a per-repo
 * hook installed any other way. A SCAN-POLICY repository (today: the
 * per-workgroup `wiki` canonical repo, isScanPolicyRepositoryName below)
 * gets `core.hooksPath` pointed at this module's ONE host-managed,
 * read-only-mounted directory instead — refreshed atomically on every host
 * start, so the installed copy is never more than one deploy stale, and a
 * spawn-time integrity check (assertManagedGitHooksIntegrity) throws
 * rather than mount a hook that doesn't match what shipped.
 *
 * `core.hooksPath` itself IS the signal read elsewhere (container-runner.ts):
 * nothing re-derives "is this a scan-policy repo" from the repo name at
 * mount time — it reads whatever value sanitizeCanonicalConfig/the
 * migration pass already wrote into the repo's own .git/config.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, REPO_ROOT } from './config.js';
import { onHostStart } from './host-lifecycle.js';
import { log } from './log.js';
import { repositoryConfigPath, safeGitConfigGet, safeGitConfigSet } from './safe-git.js';
import { discoverCanonicalRepositories, repositoriesRoot } from './repository-workspaces.js';

export const MANAGED_GIT_HOOKS_DIR = path.join(DATA_DIR, 'managed-git-hooks');
export const MANAGED_HOOK_FILENAME = 'pre-push';
export const MANAGED_PATTERNS_FILENAME = 'nanoclaw-secret-patterns.sh';

const HOOK_SOURCE = path.join(REPO_ROOT, 'scripts', 'wiki-pre-push-hook.sh');
const PATTERNS_SOURCE = path.join(REPO_ROOT, 'scripts', 'lib', 'secret-scan.sh');

/**
 * Today: the wiki canonical repo per workgroup (data/repositories/<wg>/wiki).
 * A code repo stays hookless (core.hooksPath=/dev/null) — the hook's own
 * SECRET_BLOCK_RE has real false-positive vectors in code (PEM/AWS-example
 * fixtures, test tokens) that the wiki content shape doesn't. Widen this
 * predicate only after that false-positive rate is measured for code repos
 * the way #666 measured it for wiki (see scripts/wiki-pre-push-hook.sh's
 * header for the historical wiki numbers).
 */
export function isScanPolicyRepositoryName(name: string): boolean {
  return name === 'wiki';
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readSourceOrThrow(file: string): Buffer {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe managed-hook source: ${file}`);
  return fs.readFileSync(file);
}

/** Write `content` to `<dir>/<filename>` atomically: temp file in the same directory, fsync, rename, fsync the directory. */
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
 * Refresh MANAGED_GIT_HOOKS_DIR from the shipped sources. Idempotent — safe
 * to call on every host start and to call more than once. The directory
 * itself is never replaced (only rename-in-place inside it) so a container
 * that bind-mounted it before a restart never sees a stale, swapped inode
 * (the existing per-repo `.git/config` file mount already has this exact
 * trap — see container-runner.ts's canonicalGitControlMounts). Writes the
 * lib before the hook so nothing ever observes a hook without its sourced
 * dependency.
 */
export function refreshManagedGitHooks(hooksDir: string = MANAGED_GIT_HOOKS_DIR): {
  hookSha256: string;
  patternsSha256: string;
} {
  fs.mkdirSync(hooksDir, { recursive: true, mode: 0o755 });
  const dirStat = fs.lstatSync(hooksDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`managed git hooks path is not a real directory: ${hooksDir}`);
  }
  const patterns = readSourceOrThrow(PATTERNS_SOURCE);
  const hook = readSourceOrThrow(HOOK_SOURCE);
  atomicWriteInDir(hooksDir, MANAGED_PATTERNS_FILENAME, patterns, 0o644);
  atomicWriteInDir(hooksDir, MANAGED_HOOK_FILENAME, hook, 0o755);
  return { hookSha256: sha256(hook), patternsSha256: sha256(patterns) };
}

/**
 * Fail-closed spawn-time assertion. Git itself fails OPEN when a hook is
 * missing or not executable (verified on git 2.43: a missing hooks dir, or
 * a 0644 hook, both give rc=0 with at most a hint) — so a spawn that mounts
 * a scan-policy repo must not proceed on a managed-hooks dir that is
 * anything other than exactly what refreshManagedGitHooks last wrote.
 * Throws; callers (container-runner.ts) let that abort the spawn.
 */
export function assertManagedGitHooksIntegrity(hooksDir: string = MANAGED_GIT_HOOKS_DIR): void {
  const dirStat = fs.lstatSync(hooksDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`managed git hooks directory is unsafe: ${hooksDir}`);
  }
  if (process.getuid && dirStat.uid !== process.getuid()) {
    throw new Error(`managed git hooks directory is not host-owned: ${hooksDir}`);
  }
  const hookPath = path.join(hooksDir, MANAGED_HOOK_FILENAME);
  const hookStat = fs.lstatSync(hookPath);
  if (hookStat.isSymbolicLink() || !hookStat.isFile() || (hookStat.mode & 0o111) === 0) {
    throw new Error(`managed pre-push hook is not a safe executable file: ${hookPath}`);
  }
  const installedHook = fs.readFileSync(hookPath);
  const shippedHook = readSourceOrThrow(HOOK_SOURCE);
  if (!installedHook.equals(shippedHook)) {
    throw new Error(`managed pre-push hook content does not match the shipped source: ${hookPath}`);
  }
  const patternsPath = path.join(hooksDir, MANAGED_PATTERNS_FILENAME);
  const patternsStat = fs.lstatSync(patternsPath);
  if (patternsStat.isSymbolicLink() || !patternsStat.isFile()) {
    throw new Error(`managed secret-patterns file is not a safe regular file: ${patternsPath}`);
  }
  const installedPatterns = fs.readFileSync(patternsPath);
  const shippedPatterns = readSourceOrThrow(PATTERNS_SOURCE);
  if (!installedPatterns.equals(shippedPatterns)) {
    throw new Error(`managed secret-patterns content does not match the shipped source: ${patternsPath}`);
  }
}

export interface CanonicalHooksPathMigrationResult {
  /** Repos whose core.hooksPath was unset or /dev/null and is now the managed dir. */
  updated: number;
  /** workgroupId/repo pairs whose EXISTING core.hooksPath was neither of those — alerted, never overwritten. */
  alerts: string[];
}

/**
 * Idempotent startup pass: for every scan-policy canonical repository
 * (discoverCanonicalRepositories — never the install checkout itself,
 * which isn't a canonical repo and isn't touched here), point
 * `core.hooksPath` at MANAGED_GIT_HOOKS_DIR through safe-git's targeted
 * `git config --file` (never a full sanitizeCanonicalConfig rewrite, which
 * needs the repo's origin and would drop any non-template key). Only
 * changes a value that is unset or `/dev/null`; a scan-policy repo whose
 * hooksPath is already something else entirely is left untouched and
 * reported in `alerts`, never silently skipped or overwritten. Returns
 * counts only — never repo names, so this is safe to log/report verbatim.
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
      const configPath = repositoryConfigPath(repository.gitDir);
      const current = safeGitConfigGet(configPath, 'core.hooksPath');
      if (current === MANAGED_GIT_HOOKS_DIR) continue; // already migrated
      if (current !== null && current !== '/dev/null') {
        alerts.push(`${entry.name}/${repository.name}`);
        continue;
      }
      safeGitConfigSet(configPath, 'core.hooksPath', MANAGED_GIT_HOOKS_DIR);
      updated += 1;
    }
  }
  if (alerts.length > 0) {
    log.error('managed-git-hooks: scan-policy repo(s) have a non-default core.hooksPath, left untouched', {
      count: alerts.length,
    });
  }
  return { updated, alerts };
}

onHostStart(function managedGitHooksHostStart() {
  // UNGUARDED — a synchronous startup failure must abort boot: a host that
  // cannot guarantee the managed hook is genuine must not spawn a container
  // that would mount it.
  const { hookSha256 } = refreshManagedGitHooks();
  const { updated, alerts } = migrateExistingCanonicalHooksPath();
  log.info('Managed git hooks refreshed', { hookSha256, hooksPathMigrated: updated, hooksPathAlerts: alerts.length });
});
