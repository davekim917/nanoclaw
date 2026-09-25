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
 * gets `core.hooksPath` pointed at MANAGED_GIT_HOOKS_SCAN_DIR instead —
 * refreshed atomically on every host start, so the installed copy is never
 * more than one deploy stale.
 *
 * Two host-managed directories, nested under one parent (data/managed-git-hooks/):
 *   - scan/   the real hook + shared pattern lib, byte-identical to the
 *             shipped source at the last successful refresh THIS PROCESS ran.
 *   - refuse/ a hard-coded fallback hook (REFUSE_HOOK_CONTENT below, a
 *             compiled string constant — never a file read from REPO_ROOT)
 *             that prints one message and exits 1, unconditionally.
 *
 * Every spawn that would mount a scan-policy repo's hooks calls
 * decideHooksMountStrategy() (never a throwing assertion) to pick exactly one
 * of three outcomes — see its own doc comment for the fallback order and why
 * a mismatch never aborts the whole spawn.
 *
 * `core.hooksPath` itself IS the signal read elsewhere (container-runner.ts):
 * nothing re-derives "is this a scan-policy repo" from the repo name at
 * mount time — it reads whatever value sanitizeCanonicalConfig/the
 * migration pass already wrote into the repo's own .git/config, and that
 * value is always the ONE exported MANAGED_GIT_HOOKS_SCAN_DIR constant
 * (never re-derived per writer — any writer producing a
 * different string silently drops the repo out of hook coverage, since
 * nothing mounts at a `core.hooksPath` value that doesn't match exactly).
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
/** The ONE value every writer (sanitize template, migration pass, migration temp canonical) must use for core.hooksPath, and the ONE value every mount check compares against. */
export const MANAGED_GIT_HOOKS_SCAN_DIR = path.join(MANAGED_GIT_HOOKS_ROOT, 'scan');
export const MANAGED_GIT_HOOKS_REFUSE_DIR = path.join(MANAGED_GIT_HOOKS_ROOT, 'refuse');
export const MANAGED_HOOK_FILENAME = 'pre-push';
export const MANAGED_PATTERNS_FILENAME = 'nanoclaw-secret-patterns.sh';

// Computed lazily (never at module scope) — this module is imported
// transitively by repository-workspaces/index.ts, which a lot of unrelated
// tests pull in through a PARTIAL `./config.js` mock that has no reason to
// know about REPO_ROOT. A module-scope `path.join(REPO_ROOT, ...)` crashed
// every one of those at import time even though
// none of them ever call refreshManagedGitHooks. Only evaluate REPO_ROOT
// inside the function that actually reads it.
function hookSourcePath(): string {
  return path.join(REPO_ROOT, 'scripts', 'wiki-pre-push-hook.sh');
}
function patternsSourcePath(): string {
  return path.join(REPO_ROOT, 'scripts', 'lib', 'secret-scan.sh');
}

/**
 * Today: the wiki canonical repo per workgroup (data/repositories/<wg>/wiki).
 * A code repo stays hookless (core.hooksPath=/dev/null) — the hook's own
 * SECRET_BLOCK_RE has real false-positive vectors in code (PEM/AWS-example
 * fixtures, test tokens) that the wiki content shape doesn't. Widen this
 * list only after that false-positive rate is measured for code repos the
 * way it was measured for wiki (see scripts/wiki-pre-push-hook.sh's header
 * for the historical wiki numbers).
 *
 * The ONE list this predicate reads. The runner keeps its own copy of this
 * predicate (container/agent-runner/src/mcp-tools/git-worktrees.ts,
 * `isScanPolicyRepositoryName`, needed because it cannot import host src/ —
 * see that file's comment) sourced from
 * container/agent-runner/src/mcp-tools/scan-policy-repos.json, the same
 * array duplicated here rather than re-derived. src/managed-git-hooks.test.ts's
 * "runner/host scan-policy lists" test reads both and asserts they
 * deep-equal, so the two can never silently drift apart.
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
 * Validate every component of a managed-hooks directory path, not just the
 * leaf: `<root>/managed-git-hooks/scan` (or `refuse`) is
 * walked component by component via resolveContainedRealDirectory
 * (src/fs-safety.ts — the same helper host reconciliation uses to refuse a
 * container-planted symlink), which throws on any symlink or non-directory
 * anywhere in the chain AND asserts the final realpath is still contained
 * under the root's own realpath. An `lstat` on only the final component
 * would pass a symlinked `data/managed-git-hooks` parent straight through.
 * Returns the validated realpath.
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
 * Create `path.join(parent, name)` if missing and confirm it is a real,
 * non-symlink directory — `parent` itself must already be a validated real
 * directory (the caller's job; see ensureManagedDirChain below). Uses a
 * NON-recursive mkdirSync deliberately: a recursive
 * mkdir creates every missing intermediate component in one call, so if
 * `parent` turned out to be a symlink, the write would already have
 * happened INSIDE the symlink's target by the time any validation ran
 * afterward. One component at a time, lstat immediately after each
 * create, is what keeps validation ahead of every write instead of behind
 * it.
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

/**
 * Validate/create the full `<root>/managed-git-hooks/<leaf>` chain
 * component by component, BEFORE any file write — see
 * ensureRealDirectoryComponent's doc comment for why recursive mkdir is
 * never used here. `root` (DATA_DIR in production) is validated but never
 * created: it must already exist by the time the host is running, and
 * creating it here would be the wrong failure mode if it somehow didn't.
 */
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
 * Refresh MANAGED_GIT_HOOKS_SCAN_DIR from the shipped sources. Idempotent —
 * safe to call on every host start and to call more than once. The
 * directory itself is never replaced (only rename-in-place inside it) so a
 * container that bind-mounted it before a restart never sees a stale,
 * swapped inode (the existing per-repo `.git/config` file mount already has
 * this exact trap — see container-runner.ts's canonicalGitControlMounts).
 * Writes the lib before the hook so nothing ever observes a hook without
 * its sourced dependency.
 *
 * Records the resulting hashes in this process's own memory —
 * checkScanHooksIntegrity below compares the installed files against
 * THESE recorded values, never against a live re-read of REPO_ROOT. Without
 * this, any deploy that touched scripts/wiki-pre-push-hook.sh or
 * secret-scan.sh between boots would make every spawn's integrity check see
 * a live source that no longer matches the still-current (correct!)
 * installed snapshot, and mis-classify it as tampering.
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

/** scanDir -> the hashes THIS process's refreshManagedGitHooks last recorded for it. Never persisted; a fresh process has an empty map, which checkScanHooksIntegrity treats as "no refresh yet" (fail closed to the refuse hook, not an assertion that passes on stale luck). */
const recordedSnapshots = new Map<string, { hookSha256: string; patternsSha256: string }>();

/**
 * Non-throwing integrity check for the scan/ directory, compared against
 * THIS process's own boot-snapshot hashes (see refreshManagedGitHooks's doc
 * comment) — never a live re-read of REPO_ROOT. Returns false (never
 * throws) on any problem: missing/symlinked/foreign-owned directory, a
 * missing recorded snapshot (no refresh completed in this process yet),
 * a non-executable or non-regular hook file, or a content mismatch against
 * the recorded hash. Callers (decideHooksMountStrategy) treat false as
 * "fall back to the refuse hook", never as "abort the spawn".
 */
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
 * The refuse hook's ENTIRE content: a compiled string constant, never a
 * file read from REPO_ROOT — a live source read here would
 * bring the exact "deploy changed the file mid-uptime" failure mode this
 * fallback exists to survive back into the fallback itself. `/bin/sh`, one
 * message, unconditional `exit 1`; depends on neither bash nor the pattern
 * lib, so it can never itself fail closed for a reason OTHER than "the
 * managed scanner isn't trustworthy right now". Names an operator action
 * (investigate + respawn), never `--no-verify` — this hook is not a bypass
 * hint, it is the fallback for when the real gate can't be trusted.
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
 * Write (or overwrite) the refuse hook at `refuseDir`, atomically, mode
 * 0755 explicitly (git silently skips a 0644 hook and
 * exits 0, so an accidental non-executable write would be worse than no
 * write at all). Independent of refreshManagedGitHooks — has its own
 * try/catch at the boot call site, and is also called lazily from
 * decideHooksMountStrategy so a boot-time failure here doesn't permanently
 * strand every scan-policy repo without even the refuse fallback.
 */
export function ensureRefuseHook(refuseDir: string = MANAGED_GIT_HOOKS_REFUSE_DIR): void {
  ensureManagedDirChain(refuseDir);
  atomicWriteInDir(refuseDir, MANAGED_HOOK_FILENAME, REFUSE_HOOK_CONTENT, 0o755);
}

/**
 * Non-throwing integrity check for the refuse/ directory — validated as
 * strictly as the scan/ directory: real non-symlink directory chain,
 * host-owned, the hook file a real executable regular file whose content is
 * byte-identical to REFUSE_HOOK_CONTENT.
 */
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
 * The fallback order every scan-policy spawn decision goes through: git
 * itself runs NO hook and exits 0
 * when `core.hooksPath` points at a missing or non-executable path
 * (verified on git 2.43), so a degrade path that merely "mounts nothing"
 * would silently let pushes through unscanned — worse than doing nothing at
 * all. This never throws and never takes down the whole spawn:
 *
 *   1. 'scan'     — scan/ passes its integrity check (checkScanHooksIntegrity):
 *                   mount the real hook. The common, expected case.
 *   2. 'refuse'   — scan/ fails, but refuse/ validates (after a lazy
 *                   ensure-and-write attempt, since refuse/ exists
 *                   precisely for the case where the boot-time refresh
 *                   failed or never ran, so it can't depend on that
 *                   refresh having gone well either): mount the refuse
 *                   hook AT THE SCAN PATH's container path, so git still
 *                   runs a hook — one that unconditionally refuses the
 *                   push — rather than silently running none.
 *   3. 'withhold' — even the refuse hook won't validate: withhold every
 *                   mount for that repository (gitDir, control mounts,
 *                   lock, origin pin — the caller's job, following the
 *                   transfer-tombstone `continue` precedent in
 *                   container-runner.ts), so git in that worktree fails
 *                   outright instead of running with no hook at all.
 *
 * Callers must alert (log once) on 'refuse' and 'withhold' — this function
 * only decides, it never logs, so a caller iterating multiple repositories
 * can dedupe "once per boot per repo" itself.
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
 * Idempotent startup pass: for every scan-policy canonical repository
 * (discoverCanonicalRepositories — never the install checkout itself,
 * which isn't a canonical repo and isn't touched here), point
 * `core.hooksPath` at MANAGED_GIT_HOOKS_SCAN_DIR through safe-git's
 * targeted `git config --file` (never a full sanitizeCanonicalConfig
 * rewrite, which needs the repo's origin and would drop any non-template
 * key). Only changes a value that is unset or `/dev/null`; a scan-policy
 * repo whose hooksPath is already something else entirely is left untouched
 * and reported in `alerts`, never silently skipped or overwritten. Returns
 * counts only — never repo names, so this is safe to log/report verbatim.
 *
 * Each repository's migration attempt gets its OWN try/catch
 * (safeGitConfigGet/Set used to throw outside any per-repo guard — a
 * stale config.lock on one repo took the whole pass, and therefore boot,
 * down). A failure here counts toward `alerts` the same as a non-default
 * hooksPath does; the two are distinguished only in the log line, never in
 * the returned count, since both mean "this repo was left as it was."
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
        if (current === MANAGED_GIT_HOOKS_SCAN_DIR) continue; // already migrated
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
 * One-shot startup init — NOT an onHostStart registrant. onHostStart's six
 * registrants (worktree-cleanup, repo-freshness, plugin-updater, commit-scan,
 * daily-summary, backlog-canvas — see the import list at the top of
 * src/main.ts) are all recurring timers/intervals that `startHostModules`
 * only starts once the DB and delivery adapter are ready — deliberately
 * late, and host-lifecycle-timers.test.ts pins exactly those six as the
 * timer-handle contract. This module starts nothing recurring; it runs once
 * and returns. It also has a harder deadline: it must run after the boot
 * mount-quiescence door (src/main.ts's runBootMountQuiescence) and before
 * anything that can spawn a container — see initializeManagedGitHooks's own
 * call site in src/main.ts for the exact placement and why.
 *
 * Three independent steps, each with its own try/catch:
 * boot must never abort because this module failed, in whole or in part.
 * decideHooksMountStrategy's own fallback order (scan -> refuse -> withhold)
 * is what actually protects a real push from going unscanned if any of
 * these three steps had problems; this function's job is only to make the
 * best attempt it can at every boot, log clearly, and never throw.
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
