/** Host side of durable repository publication, refresh, and topic transfer. */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  quiesceSessionsForRepositoryMounts,
  releaseRepositoryMountQuiescence,
  wakeRepositoryMountSessions,
  RepositoryMountQuiescenceError,
  type RepositoryMountQuiescence,
} from '../../container-restart.js';
import { effectiveCheckoutMode } from '../../checkout-mode.js';
import { DATA_DIR, REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS } from '../../config.js';
import { MANAGED_GIT_HOOKS_SCAN_DIR, isScanPolicyRepositoryName } from '../../managed-git-hooks.js';
import { getAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import {
  DEPENDENCY_CACHE_DIRNAME,
  linkPackageDir,
  startDependencyCachePass,
  type DependencyCacheMode,
} from '../../dependency-cache.js';
import { registerDeliveryAction, type DeliveryActionResult } from '../../delivery.js';
import { containerRunsAsHostUser } from '../../github-token-file.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import { resolveStoragePolicy } from '../../storage-manager.js';
import { REPOSITORY_REQUEST_ID_PATTERN, runRepositoryActionDetached } from './job-runner.js';
import {
  assertRepositoryName,
  canonicalRepoDir,
  checkoutDirName,
  checkoutStagingRoot,
  cloneIdentity,
  defaultTopicBranch,
  isRepositoryLifecycleClaimed,
  listTopicCheckouts,
  readCheckoutMetadata,
  readOriginPin,
  readTransferTombstone,
  removeCheckoutInheritedTags,
  removeStaleCheckoutStaging,
  resolveRepositoryWorkUnit,
  topicWorktreesDir,
  transferTombstonePath,
  withHostRepositoryLock,
  withRepositoryLifecycleClaims,
  withWorkgroupRepositoryMountClaim,
  writeCheckoutInheritedTags,
  writeCheckoutMetadata,
  writeOriginPin,
  writeTransferTombstone,
  type CheckoutStartedFrom,
  type OriginPin,
  type RepositoryTransferTombstone,
  type RepositoryWorkUnit,
  type TopicCheckout,
} from '../../repository-workspaces.js';
import { observedOriginsSha256 } from '../../repository-migration-recovery.js';
import { sessionsHoldRepoIngressFence } from '../../repo-fence-recovery.js';
import { readSessionOutbound } from '../mailbox/index.js';
import { sessionDir, withExistingMailboxSession, writeSessionMessageIfNew } from '../../session-manager.js';
import { safeGitArgs, safeGitConfigGet, safeGitEnv } from '../../safe-git.js';
import type { Session } from '../../types.js';

export interface PublishStagedCanonicalInput {
  workgroupId: string;
  repo: string;
  origin: string;
  repositoryId: string;
  stagingPath: string;
  dataDir?: string;
}

export interface RepositorySourceSessionState {
  id: string;
  running: boolean;
  spawning: boolean;
  processing: boolean;
  activeTool: boolean;
  continuation: boolean;
}

export interface TransferRepositoryWorktreeInput {
  workgroupId: string;
  repo: string;
  source: RepositoryWorkUnit;
  destination: RepositoryWorkUnit;
  loadSourceSessions: () => Promise<RepositorySourceSessionState[]> | RepositorySourceSessionState[];
  /**
   * Asked under the lifecycle claims and BEFORE any quiescence, only when the
   * source tombstone already records a finished move to this destination.
   * Resolving true answers that move as it stands: nothing is drained or
   * stopped and no hook below runs. Resolving false takes the ordinary path,
   * whose recovery branch re-adopts and releases barriers a crashed attempt
   * left behind.
   */
  answerCompletedMoveWithoutQuiescence?: () => Promise<boolean> | boolean;
  beforeSourceActivityCheckWhileClaimed?: () => Promise<void> | void;
  beforeMoveWhileClaimed?: () => Promise<void> | void;
  afterMoveWhileClaimed?: (result: { sourcePath: string; destinationPath: string }) => Promise<void> | void;
  dataDir?: string;
}

class RepositorySourceActiveError extends Error {
  constructor(readonly sessionIds: string[]) {
    super(`source topic is active in session(s): ${sessionIds.join(', ')}`);
    this.name = 'RepositorySourceActiveError';
  }
}

function git(cwd: string, args: string[], timeout = 120_000): string {
  const config = path.join(cwd, '.git', 'config');
  return execFileSync('git', safeGitArgs(args, fs.existsSync(config) ? config : undefined), {
    cwd,
    env: safeGitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  }).trim();
}

function tryGit(cwd: string, args: string[], timeout = 120_000): string | null {
  try {
    return git(cwd, args, timeout);
  } catch {
    return null;
  }
}

function normalizeOrigin(value: string): string {
  if (process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN === '1' && path.isAbsolute(value)) {
    return fs.realpathSync(value).replace(/\/+$/, '');
  }
  const parsed = new URL(value);
  if (parsed.username || parsed.password) throw new Error('repository origin must not contain credentials');
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new Error('repository origin must be an HTTPS github.com URL');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('repository origin must not include query parameters or fragments');
  }
  return parsed
    .toString()
    .replace(/\.git\/?$/i, '')
    .replace(/\/+$/, '');
}

function normalizedRepositoryIdentity(origin: string, requested: string): string {
  if (process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN === '1' && path.isAbsolute(origin)) {
    if (!requested) throw new Error('repository identity is required for a local test origin');
    return requested;
  }
  const parsed = new URL(origin);
  const parts = parsed.pathname
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  if (parts.length !== 2) throw new Error('repository origin must identify exactly one GitHub owner/repository');
  const derived = `github.com/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
  if (requested.toLowerCase() !== derived) {
    throw new Error('repository identity does not match normalized origin');
  }
  return derived;
}

function assertNormalClone(repoPath: string, label: string): void {
  const rootStat = fs.lstatSync(repoPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`${label} must not be a symlink`);
  const gitDir = path.join(repoPath, '.git');
  const gitStat = fs.lstatSync(gitDir);
  if (gitStat.isSymbolicLink() || !gitStat.isDirectory()) throw new Error(`${label} must be a normal clone`);
  // A normal clone's .git never holds `commondir`, and Git follows one to
  // another repository's refs, objects and config. This is a fail-closed check
  // on a container-writable mount (the canonical .git is mounted read-write,
  // container-runner.ts:4406), not a structural fix: a separate issue tracks
  // the mount itself. It runs before any git command here, which would follow it.
  try {
    fs.lstatSync(path.join(gitDir, 'commondir'));
    throw new Error(`${label} must be a normal clone, and its .git holds a commondir file`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (git(repoPath, ['rev-parse', '--is-bare-repository'], 10_000) !== 'false') {
    throw new Error(`${label} must be a normal clone`);
  }
  if (fs.realpathSync(git(repoPath, ['rev-parse', '--show-toplevel'], 10_000)) !== fs.realpathSync(repoPath)) {
    throw new Error(`${label} repository identity is ambiguous`);
  }
}

function validateCloneOrigin(repoPath: string, expected: string): void {
  const actual = safeGitConfigGet(path.join(repoPath, '.git', 'config'), 'remote.origin.url');
  if (!actual) throw new Error('repository staging clone has no origin');
  const normalizedActual = normalizeOrigin(actual);
  const normalizedExpected = normalizeOrigin(expected);
  if (normalizedActual !== normalizedExpected) {
    const observed = [normalizedActual, normalizedExpected];
    throw new Error(
      `repository origin mismatch (${new Set(observed).size} distinct values; ` +
        `observedOriginsSha256=${observedOriginsSha256(observed)})`,
    );
  }
}

function fsyncParent(file: string): void {
  const fd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectories(...directories: string[]): void {
  for (const directory of new Set(directories.map((entry) => path.resolve(entry)))) {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** Replace container-controlled clone config with the minimal host contract. */
function sanitizeCanonicalConfig(repoPath: string, expectedOrigin: string): void {
  const config = path.join(repoPath, '.git', 'config');
  const objectsInfo = path.join(repoPath, '.git', 'objects', 'info');
  fs.mkdirSync(objectsInfo, { recursive: true, mode: 0o700 });
  for (const name of ['alternates', 'http-alternates']) {
    const alternate = path.join(objectsInfo, name);
    try {
      const stat = fs.lstatSync(alternate);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== 0) {
        throw new Error(`repository clone uses forbidden object alternates: ${alternate}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fs.writeFileSync(alternate, '', { flag: 'wx', mode: 0o600 });
    }
  }
  const origin = safeGitConfigGet(config, 'remote.origin.url');
  if (!origin || normalizeOrigin(origin) !== normalizeOrigin(expectedOrigin)) {
    throw new Error('repository config origin does not match the requested canonical');
  }
  const objectFormat = safeGitConfigGet(config, 'extensions.objectFormat');
  if (objectFormat && objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    throw new Error(`unsupported repository object format: ${objectFormat}`);
  }
  const formatVersion = objectFormat === 'sha256' ? '1' : '0';
  const escapedOrigin = normalizeOrigin(origin).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  // Scan-policy repos (today: the wiki canonical repo) point at the ONE
  // host-managed, read-only-mounted hook directory instead of /dev/null —
  // see managed-git-hooks.ts's header for why hooksPath itself is the
  // signal container-runner.ts reads to decide whether to mount it.
  const hooksPath = isScanPolicyRepositoryName(path.basename(repoPath)) ? MANAGED_GIT_HOOKS_SCAN_DIR : '/dev/null';
  // Quoted (#666 review P3-6): the backslash/quote escaping below is only
  // correct inside a quoted git-config value — written bare, a literal `\`
  // or `"` in the path would land unescaped instead of being interpreted,
  // corrupting the value silently.
  const escapedHooksPath = hooksPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const body =
    `[core]\n\trepositoryformatversion = ${formatVersion}\n\tfilemode = true\n\tbare = false\n` +
    `\tlogallrefupdates = true\n\thooksPath = "${escapedHooksPath}"\n\tfsmonitor = false\n` +
    (objectFormat === 'sha256' ? `[extensions]\n\tobjectFormat = sha256\n` : '') +
    `[remote "origin"]\n\turl = ${escapedOrigin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` +
    `[gc]\n\tauto = 0\n\tworktreePruneExpire = never\n`;
  const stat = fs.lstatSync(config);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('canonical Git config is not a regular file');
  const temp = `${config}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temp, body, { flag: 'wx', mode: stat.mode & 0o7777 });
    const fd = fs.openSync(temp, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, config);
    fsyncParent(config);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Published or never created.
    }
  }
}

export async function publishStagedCanonical(
  input: PublishStagedCanonicalInput,
): Promise<{ status: 'published' | 'existing'; canonicalPath: string }> {
  const dataDir = input.dataDir;
  const canonical = canonicalRepoDir(input.workgroupId, input.repo, dataDir);
  const normalizedInputOrigin = normalizeOrigin(input.origin);
  const repositoryId = normalizedRepositoryIdentity(normalizedInputOrigin, input.repositoryId);

  return withHostRepositoryLock(
    input.workgroupId,
    input.repo,
    () => {
      if (fs.existsSync(canonical)) {
        assertNormalClone(canonical, 'existing canonical repository');
        validateCloneOrigin(canonical, input.origin);
        sanitizeCanonicalConfig(canonical, input.origin);
        if (git(canonical, ['status', '--porcelain=v1', '--untracked-files=all'], 10_000) !== '') {
          throw new Error('existing canonical repository has local modifications and was left untouched');
        }
        const canonicalHead = git(canonical, ['rev-parse', '--verify', 'HEAD^{commit}'], 10_000);
        git(canonical, ['checkout', '-q', '--detach', canonicalHead], 30_000);
        const pin = readOriginPin(input.workgroupId, input.repo, dataDir);
        if (
          !pin ||
          pin.kind === 'local-only' ||
          normalizeOrigin(pin.origin) !== normalizedInputOrigin ||
          pin.repositoryId !== repositoryId
        ) {
          throw new Error(`origin pin conflict or repository identity mismatch for ${input.workgroupId}/${input.repo}`);
        }
        if (fs.existsSync(input.stagingPath)) {
          if (fs.realpathSync(input.stagingPath) === fs.realpathSync(canonical)) {
            throw new Error('repository staging path aliases the canonical');
          }
          assertNormalClone(input.stagingPath, 'idempotent repository staging path');
          validateCloneOrigin(input.stagingPath, input.origin);
          sanitizeCanonicalConfig(input.stagingPath, input.origin);
          if (git(input.stagingPath, ['status', '--porcelain=v1', '--untracked-files=all'], 10_000) !== '') {
            throw new Error('idempotent repository staging clone is dirty and was retained');
          }
          fs.rmSync(input.stagingPath, { recursive: true });
          fsyncDirectories(path.dirname(input.stagingPath));
          try {
            fs.rmdirSync(path.dirname(input.stagingPath));
          } catch {
            // The request root can contain retained diagnostics.
          }
        }
        return { status: 'existing' as const, canonicalPath: canonical };
      }

      // Validate staging only when publication is still needed. If the host
      // crashed after the atomic rename but before acknowledging the durable
      // action, the retry is idempotently satisfied by the matching canonical
      // even though the staging path no longer exists.
      assertNormalClone(input.stagingPath, 'repository staging path');
      validateCloneOrigin(input.stagingPath, input.origin);
      sanitizeCanonicalConfig(input.stagingPath, input.origin);
      if (git(input.stagingPath, ['status', '--porcelain=v1', '--untracked-files=all'], 10_000) !== '') {
        throw new Error('repository staging clone has local modifications and was left untouched');
      }
      const head = git(input.stagingPath, ['rev-parse', '--verify', 'HEAD^{commit}'], 10_000);
      // The host canonical must not own a user branch. Topic worktrees may
      // legitimately preserve or request the remote-default branch name.
      git(input.stagingPath, ['checkout', '-q', '--detach', head], 30_000);

      fs.mkdirSync(path.dirname(canonical), { recursive: true, mode: 0o700 });
      writeOriginPin(input.workgroupId, input.repo, { origin: normalizedInputOrigin, repositoryId }, dataDir);
      // Staging and canonicals both live under data/, so rename is atomic. An
      // EXDEV is a hard error rather than a copy fallback that could publish a
      // partially-copied canonical.
      fs.renameSync(input.stagingPath, canonical);
      fsyncDirectories(path.dirname(input.stagingPath), path.dirname(canonical));
      git(canonical, ['config', 'gc.auto', '0'], 10_000);
      git(canonical, ['config', 'gc.worktreePruneExpire', 'never'], 10_000);
      return { status: 'published' as const, canonicalPath: canonical };
    },
    dataDir,
  );
}

export async function refreshCanonicalFromLocalRefs(input: {
  workgroupId: string;
  repo: string;
  dataDir?: string;
}): Promise<{ oid: string; ref: string }> {
  const canonical = canonicalRepoDir(input.workgroupId, input.repo, input.dataDir);
  return withHostRepositoryLock(
    input.workgroupId,
    input.repo,
    () => {
      assertNormalClone(canonical, 'canonical repository');
      const status = git(canonical, ['status', '--porcelain=v1', '--untracked-files=all'], 10_000);
      if (status !== '') throw new Error('canonical repository has local modifications; refresh refused');
      const remoteHead = git(canonical, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], 10_000);
      if (!remoteHead.startsWith('refs/remotes/origin/')) throw new Error('origin/HEAD is not resolved');
      const oid = git(canonical, ['rev-parse', '--verify', `${remoteHead}^{commit}`], 10_000);
      // Keep the canonical detached so it never reserves a branch that a
      // topic worktree needs. Readers still see the freshly checked-out
      // remote-default tree from the host-only canonical.
      git(canonical, ['checkout', '-q', '--detach', remoteHead], 30_000);
      git(canonical, ['config', 'gc.auto', '0'], 10_000);
      git(canonical, ['config', 'gc.worktreePruneExpire', 'never'], 10_000);

      return { oid, ref: remoteHead };
    },
    input.dataDir,
  );
}

function removeOwnedTombstone(file: string): void {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('repository transfer tombstone is not a regular file');
    fs.unlinkSync(file);
    fsyncParent(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * The finished move the source tombstone records to this destination, or null
 * when the ordinary path still has something to do: a `prepared` phase, a
 * reverse tombstone to clean up, or filesystem state that does not match. The
 * same predicate as the recovery branch in `transferRepositoryWorktree`,
 * without the repairs that branch performs.
 */
function completedTransfer(
  input: TransferRepositoryWorktreeInput,
): { sourcePath: string; destinationPath: string } | null {
  const tombstone = readTransferTombstone(input.source, input.repo, input.dataDir);
  if (!tombstone || tombstone.phase !== 'moved' || tombstone.destinationWorkUnitKey !== input.destination.key) {
    return null;
  }
  if (readTransferTombstone(input.destination, input.repo, input.dataDir)) return null;
  if (fs.existsSync(tombstone.sourcePath) || !fs.existsSync(tombstone.destinationPath)) return null;
  return { sourcePath: tombstone.sourcePath, destinationPath: tombstone.destinationPath };
}

export async function transferRepositoryWorktree(
  input: TransferRepositoryWorktreeInput,
): Promise<{ sourcePath: string; destinationPath: string; alreadyMoved?: true }> {
  if (input.source.workgroupId !== input.workgroupId || input.destination.workgroupId !== input.workgroupId) {
    throw new Error('source and destination must use the same workgroup canonical');
  }
  if (input.source.key === input.destination.key) throw new Error('source and destination topics are identical');

  return withRepositoryLifecycleClaims([input.source, input.destination], async () => {
    // A duplicate of a finished move must not drain anything. The drains below
    // stop every container involved, and kill them all if one does not
    // quiesce in time, so an agent retrying a move that already landed would
    // pay that again for nothing. Tombstones and the move change only inside
    // this function under both lifecycle claims, which this call holds (topic
    // cleanup takes the same claim first, worktree-cleanup.ts), so reading
    // them here, before the Git lock, is sound.
    if (input.answerCompletedMoveWithoutQuiescence) {
      const completed = completedTransfer(input);
      if (completed && (await input.answerCompletedMoveWithoutQuiescence())) {
        return { ...completed, alreadyMoved: true as const };
      }
    }
    // Stop source writers at a safe turn boundary before taking the Git lock.
    // A draining source tool may itself need that lock; taking it first would
    // deadlock quiescence against the very Git operation we are waiting on.
    // The lifecycle claims already prevent a fresh source spawn in this gap.
    await input.beforeSourceActivityCheckWhileClaimed?.();
    return withHostRepositoryLock(
      input.workgroupId,
      input.repo,
      async () => {
        // Claims are acquired before observing activity. A source spawn that
        // begins afterward fails at the spawn gate; an already-running or
        // already-spawning session is either quiesced by the host action or
        // visible in this fresh snapshot. The lifecycle claims remain held,
        // so no fresh source writer can enter between the barrier and proof.
        const sourceSessions = await input.loadSourceSessions();
        const active = sourceSessions.filter(
          (session) =>
            session.running || session.spawning || session.processing || session.activeTool || session.continuation,
        );
        if (active.length > 0) {
          throw new RepositorySourceActiveError(active.map((session) => session.id));
        }

        // Destination siblings already mount the topic root. Stop them before
        // the moved directory can appear, otherwise a still-finishing turn can
        // mutate the transferred HEAD/index/bytes in the move-to-kill window.
        await input.beforeMoveWhileClaimed?.();

        const canonical = canonicalRepoDir(input.workgroupId, input.repo, input.dataDir);
        assertNormalClone(canonical, 'canonical repository');
        const sourcePath = path.join(topicWorktreesDir(input.source, input.dataDir), input.repo);
        const destinationPath = path.join(topicWorktreesDir(input.destination, input.dataDir), input.repo);
        const reverseTombstone = readTransferTombstone(input.destination, input.repo, input.dataDir);
        if (
          reverseTombstone &&
          (reverseTombstone.sourceWorkUnitKey !== input.destination.key ||
            reverseTombstone.destinationWorkUnitKey !== input.source.key)
        ) {
          throw new Error('destination topic is tombstoned by a different transfer');
        }
        const existingSourceTombstone = readTransferTombstone(input.source, input.repo, input.dataDir);
        if (existingSourceTombstone) {
          if (existingSourceTombstone.destinationWorkUnitKey !== input.destination.key) {
            throw new Error('source topic worktree was transferred onward to a different destination');
          }
          const sourceExists = fs.existsSync(existingSourceTombstone.sourcePath);
          const destinationExists = fs.existsSync(existingSourceTombstone.destinationPath);
          if (!sourceExists && destinationExists) {
            if (existingSourceTombstone.phase === 'prepared') {
              writeTransferTombstone(
                input.source,
                input.repo,
                { ...existingSourceTombstone, phase: 'moved' },
                input.dataDir,
              );
            }
            const recoveredResult = {
              sourcePath: existingSourceTombstone.sourcePath,
              destinationPath: existingSourceTombstone.destinationPath,
            };
            if (reverseTombstone) {
              removeOwnedTombstone(transferTombstonePath(input.destination, input.repo, input.dataDir));
            }
            await input.afterMoveWhileClaimed?.(recoveredResult);
            return recoveredResult;
          }
          if (sourceExists && !destinationExists && existingSourceTombstone.phase === 'prepared') {
            removeOwnedTombstone(transferTombstonePath(input.source, input.repo, input.dataDir));
          } else {
            throw new Error('repository transfer tombstone and filesystem state are inconsistent');
          }
        }
        if (!fs.existsSync(sourcePath)) throw new Error(`source worktree does not exist: ${sourcePath}`);
        const pointer = path.join(sourcePath, '.git');
        if (!fs.lstatSync(pointer).isFile()) throw new Error('source checkout is not a linked worktree');
        const common = git(sourcePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 10_000);
        if (fs.realpathSync(common) !== fs.realpathSync(path.join(canonical, '.git'))) {
          throw new Error('source worktree is attached to a different canonical');
        }

        if (fs.existsSync(destinationPath)) {
          const entries = fs.readdirSync(destinationPath);
          if (entries.length > 0) throw new Error(`destination is not empty: ${destinationPath}`);
          fs.rmdirSync(destinationPath);
        }

        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        const tombstone: RepositoryTransferTombstone = {
          version: 1,
          phase: 'prepared',
          workgroupId: input.workgroupId,
          repo: input.repo,
          sourceWorkUnitKey: input.source.key,
          destinationWorkUnitKey: input.destination.key,
          sourcePath,
          destinationPath,
          createdAt: new Date().toISOString(),
        };

        writeTransferTombstone(input.source, input.repo, tombstone, input.dataDir);
        try {
          git(canonical, ['worktree', 'move', sourcePath, destinationPath], 120_000);
          fsyncDirectories(path.dirname(sourcePath), path.dirname(destinationPath));
          writeTransferTombstone(input.source, input.repo, { ...tombstone, phase: 'moved' }, input.dataDir);
          if (reverseTombstone) {
            removeOwnedTombstone(transferTombstonePath(input.destination, input.repo, input.dataDir));
          }
        } catch (error) {
          // Restore the original path before reporting failure. The entire
          // worktree remains linked and byte-for-byte intact throughout.
          if (fs.existsSync(destinationPath) && !fs.existsSync(sourcePath)) {
            tryGit(canonical, ['worktree', 'move', destinationPath, sourcePath], 120_000);
            fsyncDirectories(path.dirname(destinationPath), path.dirname(sourcePath));
          }
          if (fs.existsSync(sourcePath) && !fs.existsSync(destinationPath)) {
            removeOwnedTombstone(transferTombstonePath(input.source, input.repo, input.dataDir));
          }
          throw error;
        }
        const result = { sourcePath, destinationPath };
        await input.afterMoveWhileClaimed?.(result);
        return result;
      },
      input.dataDir,
    );
  });
}

/**
 * Answer one repository action in the caller's own inbound queue.
 *
 * Opens its own short mailbox session. This runs on the detached job chain,
 * by which time the drain that dispatched the action has long returned, and
 * delivery holds no session while a handler runs (plan §4.5b).
 *
 * Existing-only, never provisioning: `prepare()` would open the
 * container-owned outbound.db read-write to apply its schema, and the request
 * this answers was read out of that very mailbox, so it exists. A session that
 * has vanished has no container left to read the answer.
 */
/** Structured fields a `repository_checkout` answer carries. Every other action answers with the message alone. */
export interface RepositoryActionResponseDetail {
  dirName?: string;
  branch?: string;
  created?: boolean;
  startedFrom?: CheckoutStartedFrom;
  objectsLinked?: boolean;
  farmsLinked?: number;
  retryable?: boolean;
}

async function response(
  session: Session,
  requestId: string,
  ok: boolean,
  message: string,
  detail: RepositoryActionResponseDetail = {},
): Promise<void> {
  const id = `repository-action-response-${requestId}`;
  const written = await withExistingMailboxSession(session.agent_group_id, session.id, async (mailbox) => {
    if (mailbox.inboundHasMessage(id)) return true;
    await mailbox.insertMessage({
      id,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ type: 'repository_action_response', requestId, ok, message, ...detail }),
      processAfter: null,
      recurrence: null,
      trigger: 0,
    });
    return true;
  });
  if (written === undefined) {
    log.warn('Repository action response dropped — session mailbox is gone', { requestId, sessionId: session.id });
  }
}

// ── repository_checkout (plan §5.2) ─────────────────────────────────────────
//
// One (thread, branch) gets one independent clone. The host builds it in the
// topic's staging dir (beside `worktrees/`, outside every container mount:
// checkoutStagingRoot), initializes it fully, and publishes it with one rename,
// so a checkout exists only once it is ready. The job runs on its work unit's
// own lane (job-runner.ts), takes that unit's lifecycle claim and the
// repository flock, and never quiesces anything.
//
// It runs on the host because inside a container the canonical and the topic
// root are different bind mounts: link(2) returns EXDEV across mounts, and Git
// would copy every object into every clone (plan §4.6).

export interface CheckoutFarmPolicy {
  /** `NANOCLAW_DEPENDENCY_CACHE`: `apply` links farms, `report` logs what it would link, `off` shares nothing (§5.7.8). */
  mode: DependencyCacheMode;
  /** The environment fingerprint; the agent image's when omitted. */
  fingerprint?: () => string | null;
}

export interface CheckoutRepositoryInput {
  workgroupId: string;
  workUnit: RepositoryWorkUnit;
  repo: string;
  /** `null`: the thread's primary checkout `<repo>`. */
  branch: string | null;
  requestId: string;
  dataDir?: string;
  farms?: CheckoutFarmPolicy;
}

export interface CheckoutRepositoryResult {
  dirName: string;
  path: string;
  /** The branch the checkout serves; `null` only for a legacy linked checkout on a detached HEAD. */
  branch: string | null;
  created: boolean;
  shape: 'clone' | 'linked';
  startedFrom?: CheckoutStartedFrom;
  objectsLinked?: boolean;
  farmsLinked: number;
}

/** A refusal the requester can act on; `retryable` when waiting a few seconds is the whole fix. */
export class RepositoryCheckoutError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'RepositoryCheckoutError';
  }
}

export interface RepositoryCheckoutHooks {
  afterStagingPopulated?: (stagingCheckoutPath: string) => Promise<void> | void;
}

let checkoutHooks: RepositoryCheckoutHooks = {};

/** Test seam: pause or fail a checkout once its staging clone is fully built. */
export function _setRepositoryCheckoutHooksForTesting(hooks: RepositoryCheckoutHooks | null): void {
  checkoutHooks = hooks ?? {};
}

/** The job-runner lane for one (workgroup, work unit). */
export function repositoryCheckoutLane(workgroupId: string, workUnit: RepositoryWorkUnit): string {
  return `checkout:${workgroupId}:${workUnit.id}`;
}

function gitWithInput(cwd: string, args: string[], input: string, timeout = 120_000): void {
  const config = path.join(cwd, '.git', 'config');
  execFileSync('git', safeGitArgs(args, fs.existsSync(config) ? config : undefined), {
    cwd,
    env: safeGitEnv(),
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout,
  });
}

/** Delete refs by name. A symbolic ref is deleted itself, never its target. */
function deleteRefs(repoPath: string, refs: string[]): void {
  if (refs.length === 0) return;
  gitWithInput(repoPath, ['update-ref', '--stdin'], refs.map((ref) => `option no-deref\ndelete ${ref}\n`).join(''));
}

/** A branch name `git branch` would accept, checked without letting `--branch` expand `@{-N}`. */
function assertCheckoutBranch(canonical: string, branch: string): void {
  if (
    !branch ||
    branch === 'HEAD' ||
    branch.startsWith('-') ||
    tryGit(canonical, ['check-ref-format', `refs/heads/${branch}`], 10_000) === null
  ) {
    throw new RepositoryCheckoutError(`Invalid branch name: ${JSON.stringify(branch)}`);
  }
}

function currentBranch(checkoutPath: string): string | null {
  return tryGit(checkoutPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 10_000);
}

/** The branch a checkout is FOR: a clone's recorded branch, a linked worktree's current one. `null` when unknown. */
function branchOfCheckout(checkout: TopicCheckout): string | null {
  if (checkout.shape === 'linked') return currentBranch(checkout.path);
  if (checkout.shape !== 'clone') return null;
  try {
    return readCheckoutMetadata(checkout.path)?.branch ?? null;
  } catch {
    return null;
  }
}

interface CheckoutTarget {
  dirName: string;
  path: string;
  /** The branch a new checkout here is created on (ignored when `existing`). */
  branch: string;
  existing: TopicCheckout | null;
}

/**
 * Which checkout serves (repo, branch) (plan §5.1): no branch -> `<repo>`;
 * `<repo>` absent -> `<repo>`, created on the branch; `<repo>`'s own branch ->
 * `<repo>`; anything else -> `<repo>@<slug>`. A `<repo>` whose branch cannot be
 * read serves only requests without a branch, and is then refused by validation.
 */
function selectCheckoutTarget(
  topicRoot: string,
  repo: string,
  branch: string | null,
  workUnit: RepositoryWorkUnit,
): CheckoutTarget {
  const checkouts = listTopicCheckouts(topicRoot);
  const named = (name: string): TopicCheckout | null => checkouts.find((checkout) => checkout.name === name) ?? null;
  const primary = named(repo);
  const at = (dirName: string, targetBranch: string, existing: TopicCheckout | null): CheckoutTarget => ({
    dirName,
    path: path.join(topicRoot, dirName),
    branch: targetBranch,
    existing,
  });
  if (branch === null) return at(repo, defaultTopicBranch(workUnit, repo), primary);
  if (!primary || branchOfCheckout(primary) === branch) return at(repo, branch, primary);
  const dirName = checkoutDirName(repo, branch);
  return at(dirName, branch, named(dirName));
}

/**
 * The resolution rules of plan §5.3, host side. A clone must still be on its
 * recorded branch (R3) with the origin its pin allows; a linked worktree must
 * belong to this workgroup's canonical. Anything else is refused and left
 * exactly as it is. Returns the branch the checkout serves.
 */
function validateExistingCheckout(input: {
  checkout: TopicCheckout;
  repo: string;
  branch: string | null;
  canonical: string;
  pin: OriginPin;
}): string | null {
  const { checkout } = input;
  if (checkout.shape === 'unknown') {
    throw new RepositoryCheckoutError(`${checkout.name} is not a Git checkout and was left untouched`);
  }
  if (checkout.shape === 'linked') {
    const common = tryGit(checkout.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 10_000);
    if (!common || fs.realpathSync(common) !== fs.realpathSync(path.join(input.canonical, '.git'))) {
      throw new RepositoryCheckoutError(
        `${checkout.name} is a linked worktree Git cannot serve from this workgroup's canonical; it was left untouched`,
      );
    }
    const current = currentBranch(checkout.path);
    if (input.branch !== null && current !== input.branch) {
      throw new RepositoryCheckoutError(
        `${checkout.name} is on '${current ?? 'detached HEAD'}', not '${input.branch}'; it was left untouched`,
      );
    }
    return current;
  }
  const metadata = readCheckoutMetadata(checkout.path);
  if (!metadata || metadata.repo !== input.repo) {
    throw new RepositoryCheckoutError(`${checkout.name} is a clone this host did not record; it was left untouched`);
  }
  const current = currentBranch(checkout.path);
  if (current !== metadata.branch) {
    throw new RepositoryCheckoutError(
      `${checkout.name} is on '${current ?? 'detached HEAD'}' but its recorded branch is '${metadata.branch}'. ` +
        'A checkout is never served for another branch; it was left untouched.',
    );
  }
  if (input.branch !== null && input.branch !== metadata.branch) {
    throw new RepositoryCheckoutError(
      `${checkout.name} is recorded for '${metadata.branch}', not '${input.branch}'; it was left untouched`,
    );
  }
  const configured = safeGitConfigGet(path.join(checkout.path, '.git', 'config'), 'remote.origin.url');
  if (input.pin.kind === 'local-only') {
    if (configured)
      throw new RepositoryCheckoutError(`${checkout.name} has an origin, but its canonical is local-only`);
  } else {
    let matches: boolean;
    try {
      matches = configured !== null && normalizeOrigin(configured) === normalizeOrigin(input.pin.origin);
    } catch {
      matches = false;
    }
    if (!matches)
      throw new RepositoryCheckoutError(`${checkout.name}'s origin does not match the workgroup's origin pin`);
  }
  return metadata.branch;
}

/** Did the clone hardlink the canonical's objects? Judged by one pack's (else one loose object's) link count. */
function objectsAreLinked(clonePath: string): boolean {
  const objects = path.join(clonePath, '.git', 'objects');
  const list = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).sort();
    } catch {
      return [];
    }
  };
  const pack = list(path.join(objects, 'pack')).find((name) => name.endsWith('.pack'));
  if (pack) return fs.statSync(path.join(objects, 'pack', pack)).nlink >= 2;
  for (const fanout of list(objects)) {
    if (!/^[0-9a-f]{2}$/.test(fanout)) continue;
    const loose = list(path.join(objects, fanout))[0];
    if (loose) return fs.statSync(path.join(objects, fanout, loose)).nlink >= 2;
  }
  return false;
}

/**
 * Steps 1-3 of plan §5.2, under the repository flock because they read the
 * canonical: clone, remote-ref hygiene, and the start point.
 */
function stageClone(input: { canonical: string; staging: string; branch: string; pin: OriginPin }): {
  startedFrom: CheckoutStartedFrom;
  startCommit: string;
  objectsLinked: boolean;
} {
  const { canonical, staging, branch, pin } = input;
  // 1. A local clone hardlinks the canonical's object files, copying only what
  // it cannot link, and without --shared it never writes objects/info/alternates,
  // so canonical GC cannot break the clone (plan §5.8).
  git(path.dirname(staging), ['clone', '--no-checkout', '--quiet', canonical, staging], 600_000);
  const objectsLinked = objectsAreLinked(staging);

  // 2. Remote-ref hygiene (M2). `git clone <canonical>` maps the canonical's own
  // refs/heads/* into refs/remotes/origin/* and guesses a local branch from its
  // detached HEAD (both seen in a scratch clone, 2026-09-11). Neither may
  // survive: the clone disposability proof trusts --remotes (plan §5.8).
  git(staging, ['update-ref', '--no-deref', 'HEAD', git(staging, ['rev-parse', '--verify', 'HEAD^{commit}'], 10_000)]);
  const cloned = git(staging, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'], 10_000)
    .split('\n')
    .filter(Boolean);
  deleteRefs(staging, cloned);
  // The guessed branch also got `branch.<name>` tracking config; drop it with the ref.
  for (const ref of cloned.filter((name) => name.startsWith('refs/heads/'))) {
    tryGit(staging, ['config', '--remove-section', `branch.${ref.slice('refs/heads/'.length)}`], 10_000);
  }
  if (pin.kind === 'local-only') {
    // M7: a local-only canonical has no origin, so neither does its clone.
    git(staging, ['remote', 'remove', 'origin'], 10_000);
  } else {
    git(staging, ['config', 'remote.origin.url', pin.origin], 10_000);
    git(staging, ['fetch', '--quiet', '--no-tags', canonical, '+refs/remotes/origin/*:refs/remotes/origin/*'], 600_000);
    // The glob copies origin/HEAD as a plain ref; the canonical's is symbolic.
    deleteRefs(staging, ['refs/remotes/origin/HEAD']);
    const originHead = tryGit(canonical, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], 10_000);
    if (originHead) git(staging, ['symbolic-ref', 'refs/remotes/origin/HEAD', originHead], 10_000);
  }

  // 3. The start point (R4): the most complete known state of the branch.
  // Every canonical object is already here, so committed-but-unpushed legacy
  // work in canonical refs/heads/B stays reachable.
  let startedFrom: CheckoutStartedFrom;
  let startCommit: string | null = tryGit(
    canonical,
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`],
    10_000,
  );
  if (startCommit) {
    startedFrom = 'canonical-local';
  } else if (pin.kind === 'local-only') {
    // Today's local-only rule (container git-worktrees.ts:465-468).
    startCommit = git(canonical, ['rev-parse', '--verify', 'HEAD^{commit}'], 10_000);
    startedFrom = 'local-head';
  } else {
    startCommit = tryGit(
      staging,
      ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`],
      10_000,
    );
    startedFrom = 'origin-branch';
    if (!startCommit) {
      startCommit = tryGit(staging, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD^{commit}'], 10_000);
      startedFrom = 'origin-head';
    }
    if (!startCommit) {
      throw new RepositoryCheckoutError(
        'the workgroup canonical has no origin/HEAD to start a new branch from; refresh it, then retry',
      );
    }
  }
  git(staging, ['update-ref', `refs/heads/${branch}`, startCommit], 10_000);
  if (startedFrom === 'origin-branch') {
    git(staging, ['branch', '--quiet', `--set-upstream-to=origin/${branch}`, branch], 10_000);
  }
  return { startedFrom, startCommit, objectsLinked };
}

/**
 * Package dirs of a checkout: every tracked `package-lock.json`'s directory,
 * outside node_modules. Called only on a staging clone, which no container can
 * reach (checkoutStagingRoot).
 */
function checkoutPackageDirs(checkoutPath: string): string[] {
  const listed = git(checkoutPath, ['ls-files', '-z', '--', 'package-lock.json', '*/package-lock.json'], 60_000);
  const dirs = new Set<string>();
  for (const rel of listed.split('\0').filter(Boolean)) {
    if (rel.split('/').includes('node_modules')) continue;
    dirs.add(path.join(checkoutPath, path.dirname(rel)));
  }
  return [...dirs].sort();
}

/**
 * Link a farm into every package dir that has no `node_modules` and whose key
 * has a verified, strictly complete entry (plan §5.7.4, §5.7.5). All the
 * deciding is `linkPackageDir`'s, and so is the WARN on every refusal or link
 * failure. Returns how many farms it linked.
 */
function linkCheckoutFarms(
  checkoutPath: string,
  workgroupId: string,
  farms: CheckoutFarmPolicy,
  dataDir: string,
): number {
  if (farms.mode === 'off') return 0;
  const pkgDirs = checkoutPackageDirs(checkoutPath);
  if (pkgDirs.length === 0) return 0;
  const pass = startDependencyCachePass({
    mode: farms.mode === 'apply' ? 'apply' : 'report',
    // A sibling of v2-topics, as the sweep's (storage-manager.ts:2565), so every link stays on one mount.
    cacheRoot: path.join(path.resolve(dataDir), DEPENDENCY_CACHE_DIRNAME),
    now: Date.now(),
    // Only convert and GC decisions read reclaimable bytes; a link reclaims nothing.
    reclaimableBytes: () => 0,
    fingerprint: farms.fingerprint,
  });
  let linked = 0;
  for (const pkgDir of pkgDirs) {
    try {
      if (linkPackageDir(pass, workgroupId, pkgDir) === 'linked' && pass.mode === 'apply') linked += 1;
    } catch (err) {
      log.warn('Repository checkout could not link a dependency farm', { path: pkgDir, err });
    }
  }
  return linked;
}

function checkoutFarmPolicyFromEnvironment(): CheckoutFarmPolicy {
  return { mode: resolveStoragePolicy().dependencyCacheMode ?? 'off' };
}

/** Steps 1-7 of plan §5.2 for a checkout that does not exist yet. */
async function createCheckout(input: {
  workgroupId: string;
  repo: string;
  requestId: string;
  dataDir: string;
  canonical: string;
  pin: OriginPin;
  topicRoot: string;
  target: CheckoutTarget;
  farms: CheckoutFarmPolicy;
}): Promise<CheckoutRepositoryResult> {
  const { target } = input;
  const requestRoot = path.join(checkoutStagingRoot(input.topicRoot), input.requestId);
  const staging = path.join(requestRoot, target.dirName);
  // Both live in the topic state dir, which no container mounts: staging
  // beside `worktrees/` (checkoutStagingRoot), and `worktrees/` itself, the
  // publish destination, which may not exist before the topic's first spawn.
  fs.mkdirSync(requestRoot, { recursive: true });
  fs.mkdirSync(input.topicRoot, { recursive: true });
  let staged: { startedFrom: CheckoutStartedFrom; startCommit: string; objectsLinked: boolean };
  let farmsLinked: number;
  let tagsRecorded = false;
  try {
    staged = await withHostRepositoryLock(
      input.workgroupId,
      input.repo,
      () => stageClone({ canonical: input.canonical, staging, branch: target.branch, pin: input.pin }),
      input.dataDir,
    );
    if (!staged.objectsLinked) {
      log.warn('Repository checkout copied Git objects instead of hardlinking them', {
        repo: input.repo,
        dirName: target.dirName,
        canonical: input.canonical,
      });
    }
    // 4. Materialize the working tree, then record what this checkout is.
    git(staging, ['checkout', '--quiet', '--force', target.branch], 600_000);
    git(staging, ['config', 'gc.auto', '0'], 10_000);
    writeCheckoutMetadata(staging, {
      version: 1,
      repo: input.repo,
      branch: target.branch,
      startCommit: staged.startCommit,
      startedFrom: staged.startedFrom,
    });
    await checkoutHooks.afterStagingPopulated?.(staging);
    // 5. Farms, now that the manifests exist.
    farmsLinked = linkCheckoutFarms(staging, input.workgroupId, input.farms, input.dataDir);
    // The tags the clone holds now are the ones it inherited from the canonical;
    // the disposability proof skips them while they stay unchanged (#672).
    const inheritedTags = git(staging, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/tags'], 60_000);
    // The publish rename keeps this identity; any other clone at the target has another.
    const identity = cloneIdentity(staging);
    if (identity === null) throw new RepositoryCheckoutError(`${target.dirName} staging has no .git directory`);
    // 6. Publish: one rename inside the topic root. rename(2) would replace an
    // empty directory, so anything already at the target refuses instead.
    if (fs.existsSync(target.path) || isSymlink(target.path)) {
      throw new RepositoryCheckoutError(`${target.dirName} already exists and is not a checkout this host can serve`);
    }
    // Recorded host-only (checkoutInheritedTagsPath), bound to this clone's
    // identity, once the target is known free.
    writeCheckoutInheritedTags(target.path, identity, inheritedTags);
    tagsRecorded = true;
    fs.renameSync(staging, target.path);
  } catch (error) {
    // Nothing outside this request's own staging dir was touched, apart from a
    // tag record for a publish that then failed.
    if (tagsRecorded) removeCheckoutInheritedTags(target.path);
    fs.rmSync(requestRoot, { recursive: true, force: true });
    throw error;
  }
  try {
    fsyncDirectories(input.topicRoot, requestRoot);
    fs.rmdirSync(requestRoot);
  } catch (error) {
    // Published: the checkout is ready either way, and an empty request dir is swept later.
    log.warn('Repository checkout published but could not tidy its staging dir', {
      requestRoot,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    dirName: target.dirName,
    path: target.path,
    branch: target.branch,
    created: true,
    shape: 'clone',
    startedFrom: staged.startedFrom,
    objectsLinked: staged.objectsLinked,
    farmsLinked,
  };
}

function isSymlink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The checkout serving (repo, branch) in this work unit's topic: reused when it
 * exists and passes validation, otherwise created (plan §5.2). Preconditions
 * come from the trusted work unit, never from payload paths.
 */
export async function checkoutRepository(input: CheckoutRepositoryInput): Promise<CheckoutRepositoryResult> {
  const dataDir = input.dataDir ?? DATA_DIR;
  const { workgroupId, workUnit, repo, branch, requestId } = input;
  assertRepositoryName(repo);
  assertRepositoryRequestId(requestId);
  // This function is the ONLY place a clone-shaped checkout is created or
  // served: the runner's create_worktree reaches it exclusively through
  // createCloneWorktree (container/agent-runner/src/mcp-tools/git-worktrees.ts:1106)
  // -> requestRepositoryCheckout's `repository_checkout` request (same file,
  // :985-989) -> applyRepositoryCheckoutAction above -> here -> createCheckout
  // -> stageClone, a full independent `git clone` with no `core.hooksPath`
  // set. The runner is expected to never route a scan-policy repo
  // (isScanPolicyRepositoryName) here at all — it pins that repo to
  // `worktree` mode itself (effectiveCheckoutModeFor, container/agent-runner/
  // src/mcp-tools/git-worktrees.ts:114-116) — but this host predicate is the
  // single source of truth (src/managed-git-hooks.ts), so a clone request
  // for such a repo is refused here too: if the runner's own copy of the
  // list (container/agent-runner/src/mcp-tools/scan-policy-repos.json) ever
  // drifted from the host's, that drift would otherwise be the only thing
  // standing between an unscanned clone and its remote push (#680 follow-up).
  if (isScanPolicyRepositoryName(repo)) {
    throw new RepositoryCheckoutError(
      `${repo} is under host-managed secret-scan policy and cannot be checked out as a clone; ` +
        'it must always be a linked worktree so its pushes are scanned',
    );
  }
  if (workUnit.workgroupId !== workgroupId) {
    throw new RepositoryCheckoutError('the checkout work unit belongs to another workgroup');
  }
  // Transfer and cleanup hold this claim for seconds to minutes, so the answer
  // is "retry", not "failed". The check and the claim below are one synchronous
  // step: withRepositoryLifecycleClaims tests and takes its keys before its
  // first await (repository-workspaces.ts:233-237).
  if (isRepositoryLifecycleClaimed(workUnit)) {
    throw new RepositoryCheckoutError(
      "this thread's repository checkouts are being moved or cleaned up; retry in a few seconds",
      true,
    );
  }
  return withRepositoryLifecycleClaims([workUnit], async () => {
    const canonical = canonicalRepoDir(workgroupId, repo, dataDir);
    if (!fs.existsSync(canonical)) {
      throw new RepositoryCheckoutError(`${repo} has no workgroup canonical; clone_repo it first`);
    }
    assertNormalClone(canonical, 'canonical repository');
    const pin = readOriginPin(workgroupId, repo, dataDir);
    if (!pin) throw new RepositoryCheckoutError(`${repo}'s workgroup canonical has no origin pin`);
    if (readTransferTombstone(workUnit, repo, dataDir)) {
      throw new RepositoryCheckoutError(`this thread's ${repo} checkout was transferred to another thread`);
    }
    if (branch !== null) assertCheckoutBranch(canonical, branch);

    const topicRoot = topicWorktreesDir(workUnit, dataDir);
    // This job is the one its lane is running, so no other staging entry in
    // this topic is being built: older ones are crash residue, and so is any
    // left by an earlier attempt at this same request (a replay after a host
    // restart), which was never published.
    removeStaleCheckoutStaging(topicRoot, { now: Date.now(), keep: requestId });
    fs.rmSync(path.join(checkoutStagingRoot(topicRoot), requestId), { recursive: true, force: true });

    const target = selectCheckoutTarget(topicRoot, repo, branch, workUnit);
    const farms = input.farms ?? checkoutFarmPolicyFromEnvironment();
    if (target.existing) {
      const served = validateExistingCheckout({ checkout: target.existing, repo, branch, canonical, pin });
      return {
        dirName: target.dirName,
        path: target.path,
        branch: served,
        created: false,
        shape: target.existing.shape === 'linked' ? 'linked' : 'clone',
        // A published checkout is live and container-writable, so the host
        // writes no farm into it (plan §5.2, rev 2.6): npm installs a private
        // tree there, and the sweep converts it once the topic is idle.
        farmsLinked: 0,
      };
    }
    return createCheckout({ workgroupId, repo, requestId, dataDir, canonical, pin, topicRoot, target, farms });
  });
}

const STARTED_FROM_NOTE: Record<CheckoutStartedFrom, string> = {
  'canonical-local': "from the canonical's local branch of that name (committed work preserved)",
  'origin-branch': 'from origin/<branch>, tracking it',
  'origin-head': 'as a new branch from origin/HEAD',
  'local-head': "as a new branch from the local-only canonical's HEAD",
};

function checkoutMessage(result: CheckoutRepositoryResult): string {
  const where = `/workspace/worktrees/${result.dirName}`;
  if (!result.created) {
    return `Checkout ready at ${where} (existing ${result.shape} on ${result.branch ?? 'detached HEAD'}; left untouched)`;
  }
  const from = result.startedFrom
    ? ` ${STARTED_FROM_NOTE[result.startedFrom].replace('<branch>', result.branch ?? '')}`
    : '';
  return `Checkout created at ${where} on branch ${result.branch}${from}`;
}

/**
 * `repository_checkout` (container -> host): `{requestId, repo, branch, workUnitKey}`.
 * Always answers in the requester's inbound with `repository-action-response-<requestId>`;
 * a refusal is an answer (`ok:false`), not a failed delivery.
 */
export async function applyRepositoryCheckoutAction(content: Record<string, unknown>, session: Session): Promise<void> {
  const startedAt = Date.now();
  const requestId = typeof content.requestId === 'string' ? content.requestId : '';
  // Unkeyable: no answer can be addressed, so the delivery loop keeps the row.
  assertRepositoryRequestId(requestId);
  const repo = typeof content.repo === 'string' ? content.repo : '';
  let lane = `checkout:session:${session.id}`;
  try {
    const workUnitKey = typeof content.workUnitKey === 'string' ? content.workUnitKey : '';
    const branch = content.branch ?? null;
    if (!repo || !workUnitKey || (branch !== null && typeof branch !== 'string')) {
      throw new RepositoryCheckoutError('repository_checkout payload is invalid');
    }
    if (!containerRunsAsHostUser()) {
      throw new RepositoryCheckoutError(
        'clone checkouts need containers that run as the host uid, and this host does not',
      );
    }
    const workgroupId = await workgroupForSession(session);
    const workUnit = await workUnitForSession(session, workgroupId);
    if (workUnit.key !== workUnitKey) {
      throw new RepositoryCheckoutError(
        "repository_checkout names a work unit that is not the requesting session's own",
      );
    }
    lane = repositoryCheckoutLane(workgroupId, workUnit);
    const result = await checkoutRepository({ workgroupId, workUnit, repo, branch, requestId });
    log.info('Repository checkout', {
      lane,
      mode: effectiveCheckoutMode(),
      repo,
      dirName: result.dirName,
      shape: result.shape,
      created: result.created,
      startedFrom: result.startedFrom ?? null,
      objectsLinked: result.objectsLinked ?? null,
      farmsLinked: result.farmsLinked,
      ms: Date.now() - startedAt,
      requestId,
      sessionId: session.id,
    });
    await response(session, requestId, true, checkoutMessage(result), {
      dirName: result.dirName,
      ...(result.branch !== null ? { branch: result.branch } : {}),
      created: result.created,
      ...(result.created ? { startedFrom: result.startedFrom, objectsLinked: result.objectsLinked } : {}),
      farmsLinked: result.farmsLinked,
    });
  } catch (error) {
    const retryable = error instanceof RepositoryCheckoutError && error.retryable;
    const message = error instanceof Error ? error.message : String(error);
    log.warn('Repository checkout refused', {
      lane,
      repo,
      requestId,
      sessionId: session.id,
      retryable,
      error: message,
    });
    await response(
      session,
      requestId,
      false,
      `Repository checkout failed for ${repo || 'an unnamed repository'}: ${message}`,
      {
        retryable,
      },
    );
  }
}

async function checkoutLaneForSession(session: Session): Promise<string> {
  try {
    const workgroupId = await workgroupForSession(session);
    return repositoryCheckoutLane(workgroupId, await workUnitForSession(session, workgroupId));
  } catch {
    // The apply reaches the same failure and answers it; any lane of its own will do.
    return `checkout:session:${session.id}`;
  }
}

/** Delivery-action entry: the job runs on its work unit's lane, never the global one. */
export async function dispatchRepositoryCheckout(
  content: Record<string, unknown>,
  session: Session,
): Promise<DeliveryActionResult> {
  return runRepositoryActionDetached(
    'repository_checkout',
    applyRepositoryCheckoutAction,
    content,
    session,
    await checkoutLaneForSession(session),
  );
}

function assertRepositoryRequestId(requestId: string): void {
  if (!REPOSITORY_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('repository action request id is invalid');
  }
}

function assertStagingPathOwnedBySession(session: Session, stagingPath: string): void {
  const sessionRoot = sessionDir(session.agent_group_id, session.id);
  const stagingRoot = path.join(sessionRoot, 'repository-staging');
  for (const [label, candidate] of [
    ['session', sessionRoot],
    ['repository staging', stagingRoot],
  ] as const) {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} root is not a trusted directory`);
  }
  const sessionReal = fs.realpathSync(sessionRoot);
  const stagingRootReal = fs.realpathSync(stagingRoot);
  const requestRoot = path.dirname(stagingPath);
  if (fs.existsSync(requestRoot)) {
    const requestStat = fs.lstatSync(requestRoot);
    if (requestStat.isSymbolicLink() || !requestStat.isDirectory()) {
      throw new Error('repository request staging root is not a trusted directory');
    }
  }
  const stagingReal = fs.existsSync(stagingPath) ? fs.realpathSync(stagingPath) : path.resolve(stagingPath);
  const stagingRootRelative = path.relative(sessionReal, stagingRootReal);
  const checkoutRelative = path.relative(stagingRootReal, stagingReal);
  if (
    stagingRootRelative.startsWith('..') ||
    path.isAbsolute(stagingRootRelative) ||
    checkoutRelative.startsWith('..') ||
    path.isAbsolute(checkoutRelative)
  ) {
    throw new Error('repository staging path escapes the requesting session');
  }
}

async function workgroupForSession(session: Session): Promise<string> {
  const group = await getAgentGroup(session.agent_group_id);
  if (!group) throw new Error(`agent group not found: ${session.agent_group_id}`);
  return group.workgroup_id ?? group.folder;
}

function uniqueSessionsById(...groups: Session[][]): Session[] {
  return [...new Map(groups.flat().map((candidate) => [candidate.id, candidate])).values()];
}

async function workUnitForSession(session: Session, workgroupId: string): Promise<RepositoryWorkUnit> {
  const messagingGroup = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : null;
  return resolveRepositoryWorkUnit({
    workgroupId,
    sessionId: session.id,
    platformId: messagingGroup?.platform_id ?? null,
    messagingGroupId: session.messaging_group_id ?? null,
    threadId: session.thread_id ?? null,
  });
}

export async function applyRepositoryPublishAction(content: Record<string, unknown>, session: Session): Promise<void> {
  const requestId = typeof content.requestId === 'string' ? content.requestId : '';
  const repo = typeof content.repo === 'string' ? content.repo : '';
  const origin = typeof content.origin === 'string' ? content.origin : '';
  const repositoryId = typeof content.repositoryId === 'string' ? content.repositoryId : '';
  if (!requestId || !repo || !origin || !repositoryId) throw new Error('repository_publish payload is invalid');
  assertRepositoryRequestId(requestId);
  const workgroupId = await workgroupForSession(session);
  const stagingRoot = path.join(sessionDir(session.agent_group_id, session.id), 'repository-staging', requestId);
  const stagingPath = path.join(stagingRoot, repo);
  if (path.dirname(stagingPath) !== stagingRoot) throw new Error('repository staging path escapes the request root');
  assertStagingPathOwnedBySession(session, stagingPath);

  let affectedSessions: Session[] = [];
  let mountSessions: Session[] = [];
  let releaseWakeSessions: Session[] = [];
  let quiescence: RepositoryMountQuiescence | null = null;
  try {
    await withWorkgroupRepositoryMountClaim(workgroupId, async () => {
      const groupIds = (await getAllAgentGroups())
        .filter((candidate) => (candidate.workgroup_id ?? candidate.folder) === workgroupId)
        .map((candidate) => candidate.id);
      mountSessions = (await Promise.all(groupIds.map((id) => getSessionsByAgentGroup(id)))).flat();

      // The mount claim closes new spawn admission. Wait for every already
      // admitted turn/tool to finish and stop all existing containers before
      // the first canonical publication mutation.
      quiescence = await quiesceSessionsForRepositoryMounts(
        mountSessions,
        `repository-publish:${requestId}`,
        REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS,
      );
      affectedSessions = quiescence.sessions;
      const published = await publishStagedCanonical({ workgroupId, repo, origin, repositoryId, stagingPath });
      const confirmation =
        published.status === 'published'
          ? `Repository ready: ${repo} is now the workgroup canonical. All sibling containers were restarted with consistent topic-worktree mounts.`
          : `Repository ready: ${repo} already matched the workgroup canonical. Sibling mounts were reconciled before continuing.`;
      // onWake is load-bearing: the container that requested publication is
      // deliberately among those stopped below, so a synchronous MCP response
      // cannot survive. Only the fresh container may consume this confirmation.
      await writeSessionMessageIfNew(session.agent_group_id, session.id, {
        id: `repository-publish-complete-${requestId}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: session.agent_group_id,
        channelType: 'agent',
        threadId: session.thread_id,
        content: JSON.stringify({ text: confirmation, sender: 'system', senderId: 'system' }),
        onWake: 1,
      });
      releaseWakeSessions = await releaseRepositoryMountQuiescence(quiescence);
      quiescence = null;
    });
    const sessionsToWake = uniqueSessionsById(affectedSessions, releaseWakeSessions, [session]);
    wakeRepositoryMountSessions(sessionsToWake);
  } catch (error) {
    if (error instanceof RepositoryMountQuiescenceError) {
      affectedSessions = error.quiescence.sessions;
      releaseWakeSessions = error.releaseWakeSessions;
      quiescence = error.barriersReleased ? null : error.quiescence;
    }
    let failure: unknown = error;
    let barriersReleased = quiescence === null;
    if (quiescence) {
      try {
        releaseWakeSessions = await releaseRepositoryMountQuiescence(quiescence);
        barriersReleased = true;
        quiescence = null;
      } catch (releaseError) {
        failure = new AggregateError(
          [error, releaseError],
          'repository publication failed and its ingress barrier could not be released',
        );
      }
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    const requesterWasStopped = mountSessions.some(
      (candidate) => candidate.id === session.id && affectedSessions.some((affected) => affected.id === candidate.id),
    );
    await writeSessionMessageIfNew(session.agent_group_id, session.id, {
      id: `repository-publish-failed-${requestId}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: session.thread_id,
      content: JSON.stringify({
        text: `Repository publication failed for ${repo}; the staging clone was retained. ${message}`,
        sender: 'system',
        senderId: 'system',
      }),
      onWake: requesterWasStopped ? 1 : 0,
    });
    if (barriersReleased) {
      const sessionsToWake = uniqueSessionsById(affectedSessions, releaseWakeSessions, [session]);
      wakeRepositoryMountSessions(sessionsToWake);
    }
    throw failure;
  }
}

export async function applyRepositoryRefreshAction(content: Record<string, unknown>, session: Session): Promise<void> {
  const requestId = typeof content.requestId === 'string' ? content.requestId : '';
  const repo = typeof content.repo === 'string' ? content.repo : '';
  if (!requestId || !repo) throw new Error('repository_refresh payload is invalid');
  assertRepositoryRequestId(requestId);
  const workgroupId = await workgroupForSession(session);
  try {
    // Refresh never reads or fetches from an agent checkout (plan §5.5, rev
    // 2.7); the host still validates reused checkouts and proves cleanup
    // candidates, as it does for linked worktrees. A `checkout` field
    // from a container that has not restarted since is ignored: a clone's .git
    // is container-writable, and a planted commondir or object alternate there
    // redirects a host fetch to another workgroup's repository. Containers
    // fetch origin into the canonical themselves, as linked worktrees do.
    await refreshCanonicalFromLocalRefs({ workgroupId, repo });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await response(session, requestId, false, `Host canonical refresh failed for ${repo}: ${message}`);
    log.error('repository refresh failed', { workgroupId, repo, sessionId: session.id, error: message });
    await writeSessionMessageIfNew(session.agent_group_id, session.id, {
      id: `repository-refresh-failed-${requestId}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: session.thread_id,
      content: JSON.stringify({
        text:
          `Repository warning: ${repo} fetched successfully in this topic, but the host canonical ` +
          `refresh failed and must not be treated as fresh. ${message}`,
        sender: 'system',
        senderId: 'system',
      }),
    });
    const { requestWake } = await import('../../request-wake.js');
    await requestWake(session, 'inbound-message');
    throw error;
  }
}

async function sessionsForWorkUnit(
  workUnit: RepositoryWorkUnit,
): Promise<Array<Session & { platform_id: string | null }>> {
  const rows = await getDb().all<Session & { platform_id: string | null }>(
    `SELECT s.*, mg.platform_id
         FROM sessions s
         JOIN agent_groups ag ON ag.id = s.agent_group_id
         LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
        WHERE COALESCE(ag.workgroup_id, ag.folder) = ?`,
    workUnit.workgroupId,
  );
  return rows.filter((row) => {
    const unit = resolveRepositoryWorkUnit({
      workgroupId: workUnit.workgroupId,
      sessionId: row.id,
      platformId: row.platform_id,
      messagingGroupId: row.messaging_group_id,
      threadId: row.thread_id,
    });
    return unit.key === workUnit.key;
  });
}

type TransferSourceRow = Pick<Session, 'id' | 'messaging_group_id' | 'thread_id'> & {
  platform_id: string | null;
};

function externalThreadAliases(platformId: string, storedThreadId: string): Set<string> {
  const aliases = new Set([storedThreadId]);
  const prefix = `${platformId}:`;
  if (storedThreadId.startsWith(prefix) && storedThreadId.length > prefix.length) {
    aliases.add(storedThreadId.slice(prefix.length));
  } else {
    aliases.add(`${platformId}:${storedThreadId}`);
  }
  return aliases;
}

export function resolveTransferSourceWorkUnit(
  workgroupId: string,
  sourceThreadId: string,
  rows: TransferSourceRow[],
): RepositoryWorkUnit {
  const resolvedRows = rows.map((row) => ({
    row,
    unit: resolveRepositoryWorkUnit({
      workgroupId,
      sessionId: row.id,
      platformId: row.platform_id,
      messagingGroupId: row.messaging_group_id,
      threadId: row.thread_id,
    }),
  }));

  // Managed locators are a separate namespace from adapter-owned thread IDs.
  // Otherwise an external ID that happens to equal another topic's locator
  // makes the only exact, host-generated identity ambiguous.
  if (/^(?:thread|conversation|task|session)-[a-f0-9]{32}$/.test(sourceThreadId)) {
    const locatorUnits = new Map<string, RepositoryWorkUnit>();
    for (const { unit } of resolvedRows) {
      if (`${unit.kind}-${unit.id}` === sourceThreadId) locatorUnits.set(unit.key, unit);
    }
    if (locatorUnits.size > 1) {
      throw new Error(`source thread is ambiguous in workgroup ${workgroupId}: ${sourceThreadId}`);
    }
    if (locatorUnits.size === 1) return [...locatorUnits.values()][0];
    // Adapter-owned IDs are not constrained by the managed locator grammar.
    // If no exact managed identity exists, retain the legacy alias lookup.
  }

  const units = new Map<string, RepositoryWorkUnit>();
  for (const { row, unit } of resolvedRows) {
    const aliases = new Set<string>();
    if (row.thread_id) {
      aliases.add(row.thread_id);
      if (row.platform_id && row.messaging_group_id) {
        for (const alias of externalThreadAliases(row.platform_id, row.thread_id)) aliases.add(alias);
      }
    }
    if (!aliases.has(sourceThreadId)) continue;
    units.set(unit.key, unit);
  }
  if (units.size === 0) throw new Error(`source thread is unknown in workgroup ${workgroupId}: ${sourceThreadId}`);
  if (units.size !== 1) {
    throw new Error(`source thread is ambiguous in workgroup ${workgroupId}: ${sourceThreadId}`);
  }
  return [...units.values()][0];
}

async function sourceSessionStates(
  source: RepositoryWorkUnit,
  rowsOverride?: Array<Session & { platform_id: string | null }>,
): Promise<RepositorySourceSessionState[]> {
  const rows = rowsOverride ?? (await sessionsForWorkUnit(source));
  const { isContainerRunning, isContainerSpawning } = await import('../../container-runner.js');
  const states: RepositorySourceSessionState[] = [];
  for (const row of rows) {
    const running = isContainerRunning(row.id);
    const spawning = isContainerSpawning(row.id);
    // Closed sessions cannot accept another turn or continuation. Once their
    // runtime is stopped, stale outbound claims are residue, not a possible
    // writer; the exact checkout transfer is the recovery path for that work.
    if (row.status === 'closed' && !running && !spawning) {
      states.push({
        id: row.id,
        running: false,
        spawning: false,
        processing: false,
        activeTool: false,
        continuation: false,
      });
      continue;
    }
    let processing: boolean;
    let activeTool = false;
    let continuation = false;
    try {
      // Read-only seam: the quiescence probe must never provision or migrate a
      // session it is only inspecting. Hot-journal recovery is load-bearing:
      // an unreadable existing mailbox must fail closed rather than strand a
      // recoverable processing claim behind a crash artifact.
      const state = readSessionOutbound(
        { agentGroupId: row.agent_group_id, sessionId: row.id },
        (mailbox) => ({
          processing: mailbox.getProcessingClaimRows().length > 0,
          activeTool: Boolean(mailbox.getContainerState()?.current_tool),
          continuation: mailbox.hasWorkContinuation(),
        }),
        { busyTimeoutMs: 5000, recoverJournal: true },
      );
      if (!state) {
        // A missing mailbox on a non-terminal session may mean it is between
        // creation and first boot. Transfer without proof remains unsafe.
        throw new Error(`no outbound mailbox for session ${row.id}`);
      } else {
        processing = state.processing;
        activeTool = state.activeTool;
        continuation = state.continuation;
      }
    } catch {
      // An unreadable non-terminal mailbox is unknown state, so fail closed.
      processing = true;
    }
    states.push({
      id: row.id,
      running,
      spawning,
      processing,
      activeTool,
      continuation,
    });
  }
  return states;
}

export async function applyRepositoryTransferAction(content: Record<string, unknown>, session: Session): Promise<void> {
  const requestId = typeof content.requestId === 'string' ? content.requestId : '';
  const repo = typeof content.repo === 'string' ? content.repo : '';
  const sourceThreadId = typeof content.sourceThreadId === 'string' ? content.sourceThreadId : '';
  const destinationWorkUnitKey =
    typeof content.destinationWorkUnitKey === 'string' ? content.destinationWorkUnitKey : '';
  if (!requestId || !repo || !sourceThreadId || !destinationWorkUnitKey) {
    throw new Error('repository_transfer payload is invalid');
  }
  assertRepositoryRequestId(requestId);

  let affectedSessions: Session[] = [];
  let releaseWakeSessions: Session[] = [];
  let sourceSessions: Array<Session & { platform_id: string | null }> = [];
  let sourceFailureNoticePersisted = false;
  const pendingQuiescences: RepositoryMountQuiescence[] = [];
  const rememberQuiescence = (value: RepositoryMountQuiescence): void => {
    pendingQuiescences.push(value);
    affectedSessions = uniqueSessionsById(affectedSessions, value.sessions);
  };
  const releaseQuiescence = async (value: RepositoryMountQuiescence): Promise<void> => {
    releaseWakeSessions = uniqueSessionsById(releaseWakeSessions, await releaseRepositoryMountQuiescence(value));
    const index = pendingQuiescences.indexOf(value);
    if (index >= 0) pendingQuiescences.splice(index, 1);
  };
  try {
    // Resolution belongs inside the recovery boundary. The container has
    // already durably queued the request and returned control to the agent; a
    // lookup rejection must therefore produce the same explicit failure wake
    // as a later Git/quiescence rejection instead of becoming a log-only job.
    const workgroupId = await workgroupForSession(session);
    const destination = await workUnitForSession(session, workgroupId);
    if (destination.key !== destinationWorkUnitKey) throw new Error('destination repository work-unit changed');
    const sourceRows = await getDb().all<TransferSourceRow>(
      `SELECT s.id, s.messaging_group_id, s.thread_id, mg.platform_id
           FROM sessions s
           JOIN agent_groups ag ON ag.id = s.agent_group_id
           LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
          WHERE COALESCE(ag.workgroup_id, ag.folder) = ?`,
      workgroupId,
    );
    const source = resolveTransferSourceWorkUnit(workgroupId, sourceThreadId, sourceRows);
    const sourceEpoch = `repository-transfer-source:${requestId}`;
    const destinationEpoch = `repository-transfer:${requestId}`;

    const transferred = await transferRepositoryWorktree({
      workgroupId,
      repo,
      source,
      destination,
      // A new request for a move that already landed has no barrier of its
      // own to release, so it answers without draining. A replay of THIS
      // request can still hold its barriers after a crash, and only the
      // quiescing path re-adopts and releases them.
      answerCompletedMoveWithoutQuiescence: async () =>
        !(await sessionsHoldRepoIngressFence(
          uniqueSessionsById(await sessionsForWorkUnit(source), await sessionsForWorkUnit(destination)),
          [sourceEpoch, destinationEpoch],
        )),
      beforeSourceActivityCheckWhileClaimed: async () => {
        sourceSessions = await sessionsForWorkUnit(source);
        rememberQuiescence(
          await quiesceSessionsForRepositoryMounts(sourceSessions, sourceEpoch, REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS),
        );
        // Re-read under the lifecycle claim. A row created while barriers
        // activated cannot spawn, but it must still participate in the final
        // active-state proof instead of escaping through a stale row snapshot.
        sourceSessions = await sessionsForWorkUnit(source);
      },
      loadSourceSessions: () => sourceSessionStates(source, sourceSessions),
      beforeMoveWhileClaimed: async () => {
        rememberQuiescence(
          await quiesceSessionsForRepositoryMounts(
            await sessionsForWorkUnit(destination),
            destinationEpoch,
            REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS,
          ),
        );
      },
      afterMoveWhileClaimed: async (result) => {
        const destinationSessions = await sessionsForWorkUnit(destination);
        for (const destinationSession of destinationSessions) {
          await writeSessionMessageIfNew(destinationSession.agent_group_id, destinationSession.id, {
            id: `repository-transfer-complete-${requestId}`,
            kind: 'chat',
            timestamp: new Date().toISOString(),
            platformId: destinationSession.agent_group_id,
            channelType: 'agent',
            threadId: destinationSession.thread_id,
            content: JSON.stringify({
              text:
                `Repository transfer complete: ${repo} moved exactly from ${result.sourcePath} to ` +
                `${result.destinationPath}. This topic was restarted with the correct canonical metadata mount.`,
              sender: 'system',
              senderId: 'system',
            }),
            onWake: 1,
          });
        }
        for (const sourceSession of sourceSessions.filter((candidate) => candidate.status === 'active')) {
          try {
            await writeSessionMessageIfNew(sourceSession.agent_group_id, sourceSession.id, {
              id: `repository-transfer-source-complete-${requestId}`,
              kind: 'chat',
              timestamp: new Date().toISOString(),
              platformId: sourceSession.agent_group_id,
              channelType: 'agent',
              threadId: sourceSession.thread_id,
              content: JSON.stringify({
                text:
                  `Repository handoff complete: ${repo} moved exactly from this topic to ${result.destinationPath}. ` +
                  'No work was discarded. Coordinate with the destination topic for further edits; the exact checkout ' +
                  'can be transferred back later with create_worktree if needed.',
                sender: 'system',
                senderId: 'system',
              }),
              onWake: 1,
            });
          } catch (notificationError) {
            log.warn('Repository transfer source completion notice could not be persisted', {
              requestId,
              sourceSessionId: sourceSession.id,
              error: notificationError instanceof Error ? notificationError.message : String(notificationError),
            });
          }
        }
        for (const pending of [...pendingQuiescences].reverse()) await releaseQuiescence(pending);
      },
    });
    if (transferred.alreadyMoved) {
      await writeSessionMessageIfNew(session.agent_group_id, session.id, {
        id: `repository-transfer-complete-${requestId}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: session.agent_group_id,
        channelType: 'agent',
        threadId: session.thread_id,
        content: JSON.stringify({
          text:
            `Repository transfer already complete: ${repo} is at ${transferred.destinationPath} in this topic. ` +
            'Nothing was moved or restarted; continue working there.',
          sender: 'system',
          senderId: 'system',
        }),
        // A plain row: this answer stopped no container, and an on_wake row
        // is read only by a fresh container's first poll.
        onWake: 0,
      });
      wakeRepositoryMountSessions([session]);
      return;
    }
    const sessionsToWake = uniqueSessionsById(
      affectedSessions,
      releaseWakeSessions,
      sourceSessions.filter((candidate) => candidate.status === 'active'),
      [session],
    );
    wakeRepositoryMountSessions(sessionsToWake);
  } catch (error) {
    if (error instanceof RepositoryMountQuiescenceError) {
      affectedSessions = uniqueSessionsById(affectedSessions, error.quiescence.sessions);
      releaseWakeSessions = uniqueSessionsById(releaseWakeSessions, error.releaseWakeSessions);
      if (!error.barriersReleased && !pendingQuiescences.includes(error.quiescence)) {
        pendingQuiescences.push(error.quiescence);
      }
    }
    let failure: unknown = error;
    for (const pending of [...pendingQuiescences].reverse()) {
      try {
        await releaseQuiescence(pending);
      } catch (releaseError) {
        failure = new AggregateError(
          [failure, releaseError],
          'repository transfer failed and its ingress barrier could not be released',
        );
        break;
      }
    }
    const barriersReleased = pendingQuiescences.length === 0;
    const message = failure instanceof Error ? failure.message : String(failure);
    const requesterWasStopped = affectedSessions.some((candidate) => candidate.id === session.id);
    const activeSource = error instanceof RepositorySourceActiveError;
    const sourceSessionsToNotify = sourceSessions.filter((candidate) => candidate.status === 'active');
    const stoppedSessionIds = new Set(affectedSessions.map((candidate) => candidate.id));
    for (const sourceSession of sourceSessionsToNotify) {
      try {
        await writeSessionMessageIfNew(sourceSession.agent_group_id, sourceSession.id, {
          id: `repository-transfer-source-failed-${requestId}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          platformId: sourceSession.agent_group_id,
          channelType: 'agent',
          threadId: sourceSession.thread_id,
          content: JSON.stringify({
            text: activeSource
              ? `Repository handoff requested for ${repo}, but this topic still has durable active or continued work. ` +
                'Finish or checkpoint that work and let the continuation chain complete; the requesting topic was told ' +
                'to retry. Do not delete or prune anything, and no host action is needed.'
              : `Repository handoff finalization for ${repo} encountered an error. No source work was discarded. ` +
                'Do not recreate or prune the checkout; the requesting topic can safely retry using the durable ' +
                `transfer state. Recovery error: ${message}`,
            sender: 'system',
            senderId: 'system',
          }),
          onWake: stoppedSessionIds.has(sourceSession.id) ? 1 : 0,
        });
        sourceFailureNoticePersisted = true;
      } catch (notificationError) {
        log.warn('Repository transfer source failure notice could not be persisted', {
          requestId,
          sourceSessionId: sourceSession.id,
          error: notificationError instanceof Error ? notificationError.message : String(notificationError),
        });
      }
    }
    await writeSessionMessageIfNew(session.agent_group_id, session.id, {
      id: `repository-transfer-failed-${requestId}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: session.thread_id,
      content: JSON.stringify({
        text:
          (activeSource
            ? `Repository transfer for ${repo} is waiting on active work in the source topic. ` +
              (sourceFailureNoticePersisted
                ? 'The source agent was notified; '
                : 'Wait for the source topic to finish or checkpoint; ') +
              'retry the same create_worktree transfer afterward. No host action is needed. '
            : `Repository transfer for ${repo} needs recovery; no source work was deleted. ` +
              'Retry the same transfer after resolving this error: ') + message,
        sender: 'system',
        senderId: 'system',
      }),
      onWake: requesterWasStopped ? 1 : 0,
    });
    if (barriersReleased) {
      const sessionsToWake = uniqueSessionsById(affectedSessions, releaseWakeSessions, sourceSessionsToNotify, [
        session,
      ]);
      wakeRepositoryMountSessions(sessionsToWake);
    }
    throw failure;
  }
}

// All four run OFF the serial delivery drain (job-runner.ts): a publish's
// quiescence now waits up to REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS for sibling
// containers to reach a safe point, and no other session's outbound messages may
// queue behind that. `repository_refresh` joins them because it contends for the
// same per-repository flock that a detached transfer holds across its whole
// quiescence — left inline it would simply move the delivery block. Publish,
// refresh and transfer share the global lane; `repository_checkout` runs on its
// work unit's own lane, so it never waits behind them (plan §5.2, M6).
//
// MAX_DELIVERY_ATTEMPTS no longer applies to these rows: the runner owns the
// `delivered` row (deferAck) and gives each action exactly one attempt per host
// process. A retry is not free here — every attempt re-fences and re-kills every
// sibling container in the workgroup, so three attempts at a quiescence that has
// already timed out cost three fleet-wide restarts to reach the same failure.
// The give-up path keeps the orphan-fence release the delivery loop used to run.
registerDeliveryAction(
  'repository_publish',
  (content, session) =>
    runRepositoryActionDetached('repository_publish', applyRepositoryPublishAction, content, session),
  unguarded(
    'workgroup-scoped publication of a locally validated container clone; no host network or ambient credentials',
  ),
);
registerDeliveryAction(
  'repository_refresh',
  (content, session) =>
    runRepositoryActionDetached('repository_refresh', applyRepositoryRefreshAction, content, session),
  unguarded('local-only canonical checkout refresh from refs already fetched by the scoped container'),
);
registerDeliveryAction(
  'repository_transfer',
  (content, session) =>
    runRepositoryActionDetached('repository_transfer', applyRepositoryTransferAction, content, session),
  unguarded('same-workgroup exact linked-worktree move after fail-closed lifecycle checks'),
);
registerDeliveryAction(
  'repository_checkout',
  dispatchRepositoryCheckout,
  unguarded(
    "thread-scoped host clone of the workgroup canonical into the requester's own topic; host-local, no network or ambient credentials",
  ),
);
