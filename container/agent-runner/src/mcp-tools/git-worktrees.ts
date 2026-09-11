/**
 * Git repository MCP tools.
 *
 * One host-owned normal canonical clone exists per (workgroup, repository).
 * Each thread's checkout lives under the topic root at
 * `/workspace/worktrees/<repo>` (primary) or `/workspace/worktrees/<repo>@<slug>`
 * (any other branch) — a linked worktree in `NANOCLAW_CHECKOUT_MODE=worktree`
 * (default), or an independent clone in `clone` mode (plan
 * docs/specs/repository-branch-clones/plan.md §5.2-§5.3). Resolution
 * (`resolveCheckout`) is shape-aware and branch-aware in both modes, so a
 * clone created under `clone` mode stays usable after a rollback to
 * `worktree` mode (R10). The host mounts the topic root and canonical
 * metadata at their exact host paths, so Git records paths that work
 * unchanged from both the host and every sibling container.
 */
import { dlopen } from 'bun:ffi';
import { execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { checkoutDirName, checkoutShapeAt } from './checkout-layout.js';
import { getMessageIn, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { evaluateReviewChurnGate } from '../review-churn-gate.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const LOCK_EX_NB = 2 | 4;
const LOCK_UN = 8;
const LOCK_WAIT_MS = 120_000;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const libc = dlopen('libc.so.6', {
  flock: { args: ['i32', 'i32'], returns: 'i32' },
});

type OriginPin =
  | { kind?: 'network'; origin: string; repositoryId: string }
  | { kind: 'local-only'; origin: null; repositoryId: string };

interface RepositoryContext {
  workgroupId: string;
  workUnitKey: string;
  dataDir: string;
  topicRoot: string;
  repo: string;
  canonical: string;
  gitDir: string;
  lockPath: string;
  pinPath: string;
  worktree: string;
  pin: OriginPin;
}

type ToolResult = ReturnType<typeof ok> | ReturnType<typeof err>;

function log(message: string): void {
  console.error(`[git-worktrees] ${message}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function validateSegment(value: string, label: string): string | null {
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..' || value === '.git') {
    return `Invalid ${label}: ${value}`;
  }
  return null;
}

// ── Checkout mode (plan §5.3 M1) ─────────────────────────────────────────────
//
// Controls creation only. Resolution (resolveCheckout) is shape-aware and
// branch-aware regardless of mode, so a clone made under `clone` mode keeps
// working after a rollback to `worktree` mode (R10, P2-18).

type CheckoutMode = 'worktree' | 'clone';

function checkoutMode(): CheckoutMode {
  return process.env.NANOCLAW_CHECKOUT_MODE === 'clone' ? 'clone' : 'worktree';
}

function runGitAt(cwd: string, args: string[], timeoutMs = 120_000): string {
  return execFileSync('git', args, {
    cwd,
    // Pass the caller's current environment explicitly. Git identity is
    // per-agent and can vary between calls, so each subprocess receives the
    // values present for this invocation.
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  }).trim();
}

/**
 * The branch and the commit it points at, read in ONE git invocation.
 *
 * Two commands can straddle a sibling checking out another branch — they share
 * this worktree — leaving a branch name from before the switch beside a commit
 * from after it. Everything downstream is then pinned to an identity that never
 * existed: the gate judges one PR's history while the refspec pushes the other
 * branch's commit. `status --porcelain=v2 --branch` reports both from a single
 * snapshot, so there is no window to lose rather than a smaller one.
 *
 * Unchanged by the branch-clones plan (§5.3): `context.worktree` and
 * `context.lockPath` already point at whichever checkout `resolveCheckout`
 * selected (see `contextForCheckout`), so this primitive never needs to know
 * about checkout shape at all.
 */
async function capturedIdentity(
  context: RepositoryContext,
): Promise<{ branch: string; head: string; lease: string } | null> {
  // The whole capture is one critical section, and the lock is taken HERE
  // rather than by each caller: an identity read outside it is the defect, so
  // the primitive that produces identities is the place it cannot happen. The
  // branch, the commit and the remote value are three reads of shared state
  // that must describe one instant — a sibling topic's `create_worktree` runs
  // its `fetch --prune` under this same lock, so a capture that straddled it
  // would pair this checkout's commit with a remote value the fetch had just
  // advanced, and the lease below would then name a commit this caller never
  // integrated.
  return await withRepositoryLock(context, () => {
    const worktree = context.worktree;
    const out = runGitAt(worktree, ['status', '--porcelain=v2', '--branch', '--untracked-files=no']);
    const oid = /^# branch\.oid (\S+)$/m.exec(out)?.[1];
    const head = /^# branch\.head (.+)$/m.exec(out)?.[1];
    if (!oid || !head || head === '(detached)' || oid === '(initial)') return null;
    // The remote value this caller actually integrated, read now rather than
    // left to `--force-with-lease` to infer at push time: a bare lease expects
    // whatever `refs/remotes/origin/<branch>` says when the push runs, so a
    // commit that landed while the gate was on the network would be adopted as
    // the expectation and then overwritten. An empty lease means the branch
    // must not exist on the remote yet.
    const lease = tryGitAt(worktree, ['rev-parse', `refs/remotes/origin/${head}`]) ?? '';
    return { branch: head, head: oid, lease };
  });
}

function tryGitAt(cwd: string, args: string[], timeoutMs = 120_000): string | null {
  try {
    return runGitAt(cwd, args, timeoutMs);
  } catch {
    return null;
  }
}

function runGitDir(gitDir: string, args: string[], timeoutMs = 120_000): string {
  return runGitAt(path.dirname(gitDir), [`--git-dir=${gitDir}`, ...args], timeoutMs);
}

function tryGitDir(gitDir: string, args: string[], timeoutMs = 120_000): string | null {
  try {
    return runGitDir(gitDir, args, timeoutMs);
  } catch {
    return null;
  }
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function contained(candidate: string, root: string): boolean {
  const absoluteCandidate = path.resolve(candidate);
  const absoluteRoot = path.resolve(root);
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(`${absoluteRoot}${path.sep}`);
}

function normalizeOrigin(value: string): string {
  if (process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN === '1' && path.isAbsolute(value)) {
    return canonicalPath(value).replace(/\/+$/, '');
  }
  const parsed = new URL(value);
  if (parsed.username || parsed.password) throw new Error('origin contains credentials');
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new Error('origin must use HTTPS github.com');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('origin must not include query parameters or fragments');
  }
  return parsed
    .toString()
    .replace(/\.git\/?$/i, '')
    .replace(/\/+$/, '');
}

function readPin(pinPath: string): OriginPin {
  let fd: number;
  try {
    fd = fs.openSync(pinPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('origin pin must not be a symlink');
    throw new Error(`origin pin is unavailable: ${pinPath}`);
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('origin pin must be a regular file');
    const parsed = JSON.parse(fs.readFileSync(fd, 'utf8')) as Partial<OriginPin>;
    if (typeof parsed.repositoryId !== 'string' || !parsed.repositoryId) {
      throw new Error('origin pin is malformed');
    }
    if (parsed.kind === 'local-only') {
      if (parsed.origin !== null || !parsed.repositoryId.startsWith('local-only:')) {
        throw new Error('local-only origin pin is malformed');
      }
      return { kind: 'local-only', origin: null, repositoryId: parsed.repositoryId };
    }
    if (typeof parsed.origin !== 'string') throw new Error('network origin pin is malformed');
    return { origin: normalizeOrigin(parsed.origin), repositoryId: parsed.repositoryId };
  } finally {
    fs.closeSync(fd);
  }
}

function contextFor(repo: string): RepositoryContext {
  const nameError = validateSegment(repo, 'repository name');
  if (nameError) throw new Error(nameError);

  const workgroupId = process.env.NANOCLAW_WORKGROUP_ID ?? '';
  const workUnitKey = process.env.NANOCLAW_WORK_UNIT_KEY ?? '';
  const dataDir = process.env.NANOCLAW_HOST_DATA_DIR ?? '';
  const topicRoot = process.env.NANOCLAW_HOST_TOPIC_WORKTREES_DIR ?? '';
  if (validateSegment(workgroupId, 'workgroup id')) throw new Error('repository workgroup context is unavailable');
  if (!workUnitKey) throw new Error('repository work-unit context is unavailable');
  if (!path.isAbsolute(dataDir) || !path.isAbsolute(topicRoot)) {
    throw new Error('host-native repository paths are unavailable');
  }

  const repositoriesRoot = path.join(dataDir, 'repositories', workgroupId);
  const stateRoot = path.join(dataDir, 'repository-state', workgroupId, repo);
  const canonical = path.join(repositoriesRoot, repo);
  const gitDir = path.join(canonical, '.git');
  const lockPath = path.join(stateRoot, 'repository.lock');
  const pinPath = path.join(stateRoot, 'origin.json');
  const worktree = path.join(topicRoot, repo);

  if (!contained(canonical, repositoriesRoot) || !contained(worktree, topicRoot)) {
    throw new Error('repository path escapes its trusted host root');
  }
  if (!fs.existsSync(gitDir) || !fs.lstatSync(gitDir).isDirectory() || fs.lstatSync(gitDir).isSymbolicLink()) {
    throw new Error(`canonical repository metadata is unavailable for ${repo}`);
  }
  if (runGitDir(gitDir, ['rev-parse', '--is-bare-repository'], 10_000) !== 'false') {
    throw new Error(`canonical repository is not a normal clone: ${repo}`);
  }
  const pin = readPin(pinPath);
  const configuredOrigin = tryGitDir(gitDir, ['config', '--get', 'remote.origin.url'], 10_000);
  if (pin.kind === 'local-only') {
    if (configuredOrigin !== null) throw new Error(`local-only canonical unexpectedly has an origin for ${repo}`);
  } else if (configuredOrigin === null || normalizeOrigin(configuredOrigin) !== normalizeOrigin(pin.origin)) {
    throw new Error(`canonical origin does not match the host origin pin for ${repo}`);
  }
  const workUnitId = createHash('sha256').update(`${workgroupId}\0${workUnitKey}`).digest('hex').slice(0, 32);
  const tombstonePath = path.join(stateRoot, 'transfers', `${workUnitId}.json`);
  if (fs.existsSync(tombstonePath)) {
    const stat = fs.lstatSync(tombstonePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('repository transfer tombstone is invalid');
    const tombstone = JSON.parse(fs.readFileSync(tombstonePath, 'utf8')) as {
      sourceWorkUnitKey?: string;
      destinationWorkUnitKey?: string;
    };
    if (tombstone.sourceWorkUnitKey !== workUnitKey || !tombstone.destinationWorkUnitKey) {
      throw new Error('repository transfer tombstone identity mismatch');
    }
    throw new Error(
      `This topic's ${repo} worktree was transferred to ${tombstone.destinationWorkUnitKey}; ` +
        'the source topic may not silently recreate it',
    );
  }
  return { workgroupId, workUnitKey, dataDir, topicRoot, repo, canonical, gitDir, lockPath, pinPath, worktree, pin };
}

function defaultBranch(context: RepositoryContext): string {
  const digest = createHash('sha256')
    .update(`${context.workgroupId}\0${context.workUnitKey}\0${context.repo}`)
    .digest('hex')
    .slice(0, 24);
  return `nc/topic-${digest}`;
}

function identity(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

/**
 * The flock loop shared by every checkout's lock, whatever its path: the
 * canonical `repository.lock` for a linked checkout, or a clone's own
 * `.git/nanoclaw-checkout.lock` (plan §5.3 "Locking"). The lock file itself
 * must already exist — `withRepositoryLock` relies on the host having
 * provisioned the canonical lock, and clone callers provision their own
 * on demand via `ensureCloneLock` before calling this.
 */
async function withFlockAt<T>(lockPath: string, fn: () => Promise<T> | T): Promise<T> {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('repository lock must not be a symlink');
    throw new Error(`repository lock is unavailable: ${lockPath}`);
  }
  const openedIdentity = identity(fs.fstatSync(fd));
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    while (libc.symbols.flock(fd, LOCK_EX_NB) !== 0) {
      if (Date.now() >= deadline) throw new Error(`timed out acquiring repository lock: ${lockPath}`);
      await Bun.sleep(25);
    }
    const current = fs.lstatSync(lockPath);
    if (!current.isFile() || current.isSymbolicLink() || identity(current) !== openedIdentity) {
      throw new Error('repository lock identity changed');
    }
    return await fn();
  } finally {
    libc.symbols.flock(fd, LOCK_UN);
    fs.closeSync(fd);
  }
}

async function withRepositoryLock<T>(context: RepositoryContext, fn: () => Promise<T> | T): Promise<T> {
  return withFlockAt(context.lockPath, fn);
}

/** Creates `<clone>/.git/nanoclaw-checkout.lock` on demand — no host mount provisions it (plan §5.3 "Locking"). */
function ensureCloneLock(checkoutPath: string): string {
  const file = path.join(checkoutPath, '.git', 'nanoclaw-checkout.lock');
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return file;
}

async function withCheckoutLock<T>(checkoutPath: string, fn: () => Promise<T> | T): Promise<T> {
  return withFlockAt(ensureCloneLock(checkoutPath), fn);
}

function worktreeCommonDir(worktree: string): string | null {
  return tryGitAt(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 10_000);
}

function validateExistingWorktree(context: RepositoryContext, branchArg: string | undefined): ToolResult | null {
  if (!fs.existsSync(context.worktree)) return null;
  const pointer = path.join(context.worktree, '.git');
  if (!fs.existsSync(pointer)) {
    return err(`Existing topic path is not a Git worktree and was left untouched: ${context.worktree}`);
  }
  const pointerStat = fs.lstatSync(pointer);
  if (!pointerStat.isFile()) {
    return err(`Existing topic checkout is not a linked worktree and was left untouched: ${context.worktree}`);
  }
  const common = worktreeCommonDir(context.worktree);
  if (!common || canonicalPath(common) !== canonicalPath(context.gitDir)) {
    return err(`Existing topic worktree is attached to different canonical metadata: ${context.worktree}`);
  }
  if (branchArg) {
    const current = tryGitAt(context.worktree, ['branch', '--show-current'], 10_000) ?? '';
    if (current !== branchArg) {
      return err(
        `Worktree at ${context.worktree} is on '${current || 'detached HEAD'}', not requested branch '${branchArg}'. ` +
          'Existing worktrees are never branch-switched automatically.',
      );
    }
  }
  const current = tryGitAt(context.worktree, ['branch', '--show-current'], 10_000) || 'detached HEAD';
  return ok(`Worktree ready at ${context.worktree} (existing ${current}; left untouched)`);
}

/** A crash or concurrent topic-root recreation can leave the exact repo slot
 * as an empty directory while Git still owns its linked admin record. Removing
 * an empty directory is the atomic proof that no agent bytes are present; the
 * branch/index safety decision still happens below against the private admin. */
function removeEmptyTopicPlaceholder(context: RepositoryContext): void {
  try {
    const stat = fs.lstatSync(context.worktree);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(context.worktree).length !== 0) return;
    fs.rmdirSync(context.worktree);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ENOTEMPTY') throw error;
  }
}

function branchOwner(gitDir: string, branch: string): string | null {
  const porcelain = tryGitDir(gitDir, ['worktree', 'list', '--porcelain'], 10_000) ?? '';
  let currentPath: string | null = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) currentPath = line.slice('worktree '.length);
    if (line === `branch refs/heads/${branch}` && currentPath) return currentPath;
    if (line === '') currentPath = null;
  }
  return null;
}

function managedTopicLocator(context: RepositoryContext, owner: string): string | null {
  const topicsRoot = canonicalPath(path.join(context.dataDir, 'v2-topics', context.workgroupId));
  const relative = path.relative(topicsRoot, canonicalPath(owner));
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep);
  if (parts.length !== 3 || parts[1] !== 'worktrees' || parts[2] !== context.repo) return null;
  return /^(?:thread|task|conversation|session)-[a-f0-9]{32}$/.test(parts[0]!) ? parts[0]! : null;
}

function worktreePathIsMissing(owner: string): boolean {
  try {
    fs.lstatSync(owner);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return true;
    throw new Error(`worktree owner path is unreadable: ${owner}`);
  }
}

interface LinkedWorktreeAdminRecord {
  adminDir: string;
  owner: string;
}

function linkedWorktreeAdminRecords(gitDir: string): LinkedWorktreeAdminRecord[] {
  const root = path.join(gitDir, 'worktrees');
  let entries: fs.Dirent[];
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('linked-worktree admin root is invalid');
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  return entries.map((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`linked-worktree admin entry is invalid: ${entry.name}`);
    }
    const adminDir = path.join(root, entry.name);
    const gitdirFile = path.join(adminDir, 'gitdir');
    const stat = fs.lstatSync(gitdirFile);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`linked-worktree gitdir record is invalid: ${entry.name}`);
    }
    const pointer = fs.readFileSync(gitdirFile, 'utf8').trim();
    if (!path.isAbsolute(pointer) || path.basename(pointer) !== '.git') {
      throw new Error(`linked-worktree gitdir record is malformed: ${entry.name}`);
    }
    return { adminDir, owner: path.dirname(path.resolve(pointer)) };
  });
}

function linkedWorktreeIsLocked(adminDir: string): boolean {
  try {
    fs.lstatSync(path.join(adminDir, 'locked'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function linkedWorktreeIndexMatchesHead(context: RepositoryContext, adminDir: string): boolean {
  const index = path.join(adminDir, 'index');
  const stat = fs.lstatSync(index);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('linked-worktree index is invalid');
  try {
    runGitAt(context.canonical, [`--git-dir=${adminDir}`, 'diff-index', '--cached', '--quiet', 'HEAD', '--'], 10_000);
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw new Error('linked-worktree index could not be compared with HEAD', { cause: error });
  }
}

function missingOwnerRemovalBlocker(context: RepositoryContext, targetOwner: string): string | null {
  const records = linkedWorktreeAdminRecords(context.gitDir);
  const target = records.find((record) => path.resolve(record.owner) === path.resolve(targetOwner));
  if (!target) return `linked metadata for ${targetOwner} could not be identified`;
  if (linkedWorktreeIsLocked(target.adminDir)) return `linked metadata for ${targetOwner} is locked`;
  if (!linkedWorktreeIndexMatchesHead(context, target.adminDir)) {
    return `missing worktree ${target.owner} has staged changes in its linked index`;
  }
  return null;
}

async function queueHostAction(action: string, payload: Record<string, unknown>): Promise<string> {
  const requestId = `repo-${Date.now()}-${randomBytes(8).toString('hex')}`;
  if (process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT === 'disabled') return requestId;
  await writeMessageOut({
    id: requestId,
    kind: 'system',
    content: JSON.stringify({ action, requestId, ...payload }),
  });
  return requestId;
}

/** `checkoutDirNameValue`, when given, is threaded onto the refresh payload (plan §5.5) so the host can fast-forward the canonical from that specific clone. */
async function emitRefresh(context: RepositoryContext, checkoutDirNameValue?: string): Promise<void> {
  await queueHostAction('repository_refresh', {
    repo: context.repo,
    workUnitKey: context.workUnitKey,
    ...(checkoutDirNameValue ? { checkout: checkoutDirNameValue } : {}),
  });
}

async function createLinkedWorktree(context: RepositoryContext, branchArg: string | undefined): Promise<ToolResult> {
  const branch = branchArg ?? defaultBranch(context);
  if (tryGitDir(context.gitDir, ['check-ref-format', '--branch', branch], 10_000) === null) {
    return err(`Invalid branch name: ${branch}`);
  }

  // Every network-backed invocation refreshes shared refs through this
  // container's scoped identity. Local-only repositories are a migration
  // preservation state and start new worktrees from the canonical HEAD.
  let baseRef: string;
  if (context.pin.kind === 'local-only') {
    baseRef = runGitDir(context.gitDir, ['rev-parse', '--verify', 'HEAD^{commit}'], 10_000);
  } else {
    runGitDir(context.gitDir, ['fetch', 'origin', '--prune'], 300_000);
    runGitDir(context.gitDir, ['remote', 'set-head', 'origin', '--auto'], 120_000);
    baseRef = runGitDir(context.gitDir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], 10_000);
    runGitDir(context.gitDir, ['rev-parse', '--verify', `${baseRef}^{commit}`], 10_000);
  }
  removeEmptyTopicPlaceholder(context);
  const existing = validateExistingWorktree(context, branchArg);
  if (existing) {
    if (context.pin.kind !== 'local-only') await emitRefresh(context);
    return existing;
  }

  let owner = branchOwner(context.gitDir, branch);
  if (owner && canonicalPath(owner) === canonicalPath(context.worktree) && worktreePathIsMissing(owner)) {
    // A killed or externally removed current topic can leave only Git's linked-worktree
    // registration behind. The branch ref survives removal, but a private
    // linked index may contain the last recoverable staged blobs. Remove only
    // this proven-clean registration only when its path is this container's
    // observable topic mount. Sibling topic paths are intentionally unmounted,
    // so ENOENT for them is not evidence that the host checkout is missing.
    // Repository-wide prune would also delete
    // unrelated missing owners whose private indexes still hold staged work.
    const blocker = missingOwnerRemovalBlocker(context, owner);
    if (blocker) {
      return err(`Branch '${branch}' has a missing registered owner, but automatic cleanup refused: ${blocker}`);
    }
    runGitDir(context.gitDir, ['worktree', 'remove', '--force', owner], 120_000);
    owner = branchOwner(context.gitDir, branch);
    if (owner) {
      return err(`Branch '${branch}' still has a registered owner after targeted automatic cleanup: ${owner}`);
    }
  }
  if (owner && canonicalPath(owner) !== canonicalPath(context.worktree)) {
    if (canonicalPath(owner) === canonicalPath(context.canonical)) {
      return err(
        `Branch '${branch}' is checked out by the canonical repository. ` +
          "Retry without an explicit branch to use this topic's generated branch, or choose a different branch name. " +
          'No prune or host cleanup is needed.',
      );
    }
    const locator = managedTopicLocator(context, owner);
    if (locator) {
      return err(
        `Branch '${branch}' is already checked out by another managed topic at ${owner}. ` +
          `To preserve and move that exact checkout, retry create_worktree with continueFromThreadId: '${locator}'. ` +
          'Do not delete or prune it.',
      );
    }
    return err(
      `Branch '${branch}' is already checked out by an unmanaged worktree at ${owner}. ` +
        'Preserve it and coordinate with that checkout owner; do not delete or prune it.',
    );
  }

  fs.mkdirSync(context.topicRoot, { recursive: true });
  const localExists = tryGitDir(context.gitDir, ['show-ref', '--verify', `refs/heads/${branch}`], 10_000) !== null;
  const remoteExists =
    tryGitDir(context.gitDir, ['show-ref', '--verify', `refs/remotes/origin/${branch}`], 10_000) !== null;
  if (localExists && branchArg) {
    runGitDir(context.gitDir, ['worktree', 'add', context.worktree, branch]);
  } else if (localExists) {
    // A surviving generated ref without a checkout can contain unpushed work
    // after an unexpected directory/admin loss. Never reset it. Normal host
    // cleanup deletes this exact ref only after proving it remote-contained;
    // any unexplained survivor is reattached losslessly.
    runGitDir(context.gitDir, ['worktree', 'add', context.worktree, branch]);
  } else if (remoteExists) {
    runGitDir(context.gitDir, ['worktree', 'add', '-b', branch, context.worktree, `refs/remotes/origin/${branch}`]);
  } else {
    runGitDir(context.gitDir, ['worktree', 'add', '-b', branch, context.worktree, baseRef]);
  }

  if (context.pin.kind !== 'local-only') {
    await emitRefresh(context);
    return ok(`Worktree created at ${context.worktree} on branch ${branch}; host canonical refresh queued`);
  }
  return ok(
    `Worktree created at ${context.worktree} on branch ${branch} from the preserved local-only canonical; ` +
      'fetch, push, and PR operations remain unavailable until an operator publishes an origin',
  );
}

// ── resolveCheckout (plan §5.3) ──────────────────────────────────────────────

interface CloneCheckoutMetadata {
  version: 1;
  repo: string;
  branch: string;
  startCommit: string;
  startedFrom: 'canonical-local' | 'origin-branch' | 'origin-head' | 'local-head';
}

function cloneMetadataPath(checkoutPath: string): string {
  return path.join(checkoutPath, '.git', 'nanoclaw-checkout.json');
}

/** Throws with a descriptive, non-mutating error on any malformed metadata. */
function readCloneMetadataStrict(checkoutPath: string): CloneCheckoutMetadata {
  const file = cloneMetadataPath(checkoutPath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    throw new Error(`Clone checkout at ${checkoutPath} is missing its metadata file and was left untouched`, {
      cause: error,
    });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Clone checkout metadata must be a regular file: ${checkoutPath}`);
  }
  let parsed: Partial<CloneCheckoutMetadata>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CloneCheckoutMetadata>;
  } catch (error) {
    throw new Error(`Clone checkout metadata is not valid JSON: ${checkoutPath}`, { cause: error });
  }
  if (
    parsed.version !== 1 ||
    typeof parsed.repo !== 'string' ||
    typeof parsed.branch !== 'string' ||
    typeof parsed.startCommit !== 'string' ||
    (parsed.startedFrom !== 'canonical-local' &&
      parsed.startedFrom !== 'origin-branch' &&
      parsed.startedFrom !== 'origin-head' &&
      parsed.startedFrom !== 'local-head')
  ) {
    throw new Error(`Clone checkout metadata is malformed: ${checkoutPath}`);
  }
  return parsed as CloneCheckoutMetadata;
}

function writeCloneMetadata(checkoutPath: string, metadata: CloneCheckoutMetadata): void {
  const file = cloneMetadataPath(checkoutPath);
  const temp = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  fs.writeFileSync(temp, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Lenient — used only for routing between `<repo>` and `<repo>@<slug>`. Never throws. */
function readCloneRecordedBranch(checkoutPath: string): string | null {
  try {
    return readCloneMetadataStrict(checkoutPath).branch;
  } catch {
    return null;
  }
}

function currentGitBranch(worktreePath: string): string | null {
  return tryGitAt(worktreePath, ['branch', '--show-current'], 10_000);
}

function pathExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

interface ResolvedCheckout {
  path: string;
  dirName: string;
  shape: 'clone' | 'linked';
  branch: string;
}

/**
 * Thrown by `resolveCheckout` specifically when nothing exists yet at the
 * candidate path — as opposed to something existing there but being invalid
 * (unknown shape, an R3 mismatch, a detached HEAD, an origin-pin mismatch).
 * Callers that fall back to a mode-specific creation path on "not found"
 * (`create_worktree` in worktree mode) must NOT fall back on any other
 * failure: a mismatched checkout is refused, not silently worked around
 * (R3, P2-7).
 */
class CheckoutNotFoundError extends Error {}

function validateCloneCandidate(
  context: RepositoryContext,
  checkoutPath: string,
  dirName: string,
  branch: string | null,
): ResolvedCheckout {
  const metadata = readCloneMetadataStrict(checkoutPath);
  const currentBranch = currentGitBranch(checkoutPath);
  if (!currentBranch) {
    throw new Error(`Clone checkout at ${checkoutPath} is on a detached HEAD and was left untouched`);
  }
  // R3: a checkout's current branch must equal its recorded branch, or it is
  // refused, not reused, for any branch.
  if (metadata.branch !== currentBranch) {
    throw new Error(
      `Clone checkout at ${checkoutPath} is on '${currentBranch}', not its recorded branch '${metadata.branch}'. ` +
        'It was left untouched and is not served for any branch.',
    );
  }
  if (branch !== null && currentBranch !== branch) {
    throw new CheckoutNotFoundError(`No checkout exists yet for ${context.repo} on branch '${branch}'`);
  }
  const configuredOrigin = tryGitAt(checkoutPath, ['config', '--get', 'remote.origin.url'], 10_000);
  if (context.pin.kind === 'local-only') {
    if (configuredOrigin !== null) {
      throw new Error(`Clone checkout at ${checkoutPath} unexpectedly has an origin for a local-only repository`);
    }
  } else if (configuredOrigin === null || normalizeOrigin(configuredOrigin) !== normalizeOrigin(context.pin.origin)) {
    throw new Error(`Clone checkout at ${checkoutPath} origin does not match the host origin pin for ${context.repo}`);
  }
  return { path: checkoutPath, dirName, shape: 'clone', branch: currentBranch };
}

function validateLinkedCandidate(
  context: RepositoryContext,
  checkoutPath: string,
  dirName: string,
  branch: string | null,
): ResolvedCheckout {
  const pointer = path.join(checkoutPath, '.git');
  const pointerStat = fs.lstatSync(pointer);
  if (!pointerStat.isFile()) {
    throw new Error(`Existing topic checkout is not a linked worktree and was left untouched: ${checkoutPath}`);
  }
  const common = worktreeCommonDir(checkoutPath);
  if (!common || canonicalPath(common) !== canonicalPath(context.gitDir)) {
    throw new Error(`Existing topic worktree is attached to different canonical metadata: ${checkoutPath}`);
  }
  const current = tryGitAt(checkoutPath, ['branch', '--show-current'], 10_000) ?? '';
  if (branch !== null) {
    if (current !== branch) {
      throw new CheckoutNotFoundError(`No checkout exists yet for ${context.repo} on branch '${branch}'`);
    }
  } else if (!current) {
    throw new Error(`Worktree at ${checkoutPath} is on a detached HEAD and was left untouched`);
  }
  return { path: checkoutPath, dirName, shape: 'linked', branch: current || branch! };
}

function validateCandidate(
  context: RepositoryContext,
  checkoutPath: string,
  dirName: string,
  branch: string | null,
): ResolvedCheckout {
  if (!pathExists(checkoutPath)) {
    throw new CheckoutNotFoundError(
      `No checkout exists yet for ${context.repo}${branch ? ` on branch '${branch}'` : ''}`,
    );
  }
  const shape = checkoutShapeAt(checkoutPath);
  if (shape === 'clone') return validateCloneCandidate(context, checkoutPath, dirName, branch);
  if (shape === 'linked') return validateLinkedCandidate(context, checkoutPath, dirName, branch);
  throw new Error(`Checkout at ${checkoutPath} has unrecognized Git metadata and was left untouched`);
}

/**
 * Picks the checkout serving `(repo, branch)` by the plan §5.1 rule, without
 * creating anything: no branch, or the primary checkout's own branch already
 * matches, resolves to `<repo>`; otherwise `<repo>@<slug>`. Shape- and
 * branch-aware in both modes (§5.3) — a clone left over from a `clone`-mode
 * period resolves the same way after a rollback to `worktree` mode (R10).
 * Throws, mutating nothing, on an unknown shape or an R3 mismatch.
 */
function resolveCheckout(context: RepositoryContext, branch: string | null): ResolvedCheckout {
  const primaryPath = context.worktree;
  if (branch === null) return validateCandidate(context, primaryPath, context.repo, null);

  if (pathExists(primaryPath)) {
    const shape = checkoutShapeAt(primaryPath);
    const primaryBranch =
      shape === 'clone'
        ? readCloneRecordedBranch(primaryPath)
        : shape === 'linked'
          ? currentGitBranch(primaryPath)
          : null;
    if (primaryBranch === branch) {
      return validateCandidate(context, primaryPath, context.repo, branch);
    }
  }
  const dirName = checkoutDirName(context.repo, branch);
  return validateCandidate(context, path.join(context.topicRoot, dirName), dirName, branch);
}

/**
 * Yields a context whose `.worktree`/`.lockPath` point at the RESOLVED
 * checkout, so every downstream primitive (`capturedIdentity`,
 * `withRepositoryLock`, the git_commit/git_push/open_pr handler bodies) keeps
 * operating on `context.worktree`/`context.lockPath` completely unchanged
 * (plan §5.3: "capturedIdentity and the refspec push are unchanged").
 */
function contextForCheckout(context: RepositoryContext, resolved: ResolvedCheckout): RepositoryContext {
  return {
    ...context,
    worktree: resolved.path,
    lockPath: resolved.shape === 'clone' ? ensureCloneLock(resolved.path) : context.lockPath,
  };
}

function worktreeForTool(
  repo: string,
  branch?: string,
): { context: RepositoryContext; checkout: ResolvedCheckout } | { error: ToolResult } {
  const branchArg = branch && branch.trim() ? branch.trim() : null;
  try {
    const context = contextFor(repo);
    const resolved = resolveCheckout(context, branchArg);
    log(`resolved ${repo}${branchArg ? `@${branchArg}` : ''} -> ${resolved.shape} at ${resolved.path}`);
    return { context: contextForCheckout(context, resolved), checkout: resolved };
  } catch (error) {
    return { error: err(error instanceof Error ? error.message : String(error)) };
  }
}

// ── Clone creation (plan §5.2-§5.3) ──────────────────────────────────────────

interface RepositoryActionResponsePayload {
  requestId: string;
  ok: boolean;
  message: string;
  dirName?: string;
  branch?: string;
  created?: boolean;
  startedFrom?: string;
  objectsLinked?: boolean;
  farmsLinked?: number;
  retryable?: boolean;
}

// Overridable only for tests — production always uses the plan's 120s/5s.
function repositoryCheckoutPollTimeoutMs(): number {
  const raw = Number(process.env.NANOCLAW_REPOSITORY_CHECKOUT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

function repositoryCheckoutRetryDelayMs(): number {
  const raw = Number(process.env.NANOCLAW_REPOSITORY_CHECKOUT_RETRY_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5_000;
}

async function pollRepositoryActionResponse(
  requestId: string,
  timeoutMs: number,
): Promise<RepositoryActionResponsePayload | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // The host writes the answer at this exact id (src/modules/repository-workspaces/index.ts:595).
    // getMessageIn opens a fresh read-only handle per call, the cross-mount
    // visibility rule findCliResponse relies on (mailbox/sqlite/operations.ts:94-101).
    const row = getMessageIn(`repository-action-response-${requestId}`);
    if (row && row.status === 'pending') {
      markCompleted([row.id]);
      return JSON.parse(row.content) as RepositoryActionResponsePayload;
    }
    await Bun.sleep(200);
  }
  return null;
}

/** Writes `repository_checkout` and polls for its response (plan §5.3 steps 1-2), retrying once on `retryable:true`. */
async function requestRepositoryCheckout(
  context: RepositoryContext,
  branch: string | null,
): Promise<RepositoryActionResponsePayload> {
  const requestId = await queueHostAction('repository_checkout', {
    repo: context.repo,
    branch,
    workUnitKey: context.workUnitKey,
  });
  let response = await pollRepositoryActionResponse(requestId, repositoryCheckoutPollTimeoutMs());
  if (!response) {
    throw new Error(`Timed out waiting for the host to complete repository checkout ${requestId} for ${context.repo}`);
  }
  if (!response.ok && response.retryable) {
    await Bun.sleep(repositoryCheckoutRetryDelayMs());
    const retryId = await queueHostAction('repository_checkout', {
      repo: context.repo,
      branch,
      workUnitKey: context.workUnitKey,
    });
    response = await pollRepositoryActionResponse(retryId, repositoryCheckoutPollTimeoutMs());
    if (!response) {
      throw new Error(`Timed out waiting for the host to complete repository checkout ${retryId} for ${context.repo}`);
    }
  }
  return response;
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd,
      stdio: 'ignore',
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

interface FreshnessNote {
  branch: string;
  status: 'moved-fast-forward' | 'moved-reset' | 'left-as-is';
  diverged: boolean;
}

/**
 * The container-side post-step after every clone-mode `create_worktree`
 * response, for a network pin only (plan §5.3 step 3). Runs under the
 * per-checkout lock so it is idempotent: a real `git fetch` through this
 * container's own scoped identity (the host never talks to GitHub), then —
 * only when the checkout is pristine (HEAD still at the recorded
 * `startCommit` and a clean status) — moves it to fresh remote state and
 * records the new `startCommit`. A non-pristine checkout, or one that started
 * from preserved local work (`canonical-local`), is left exactly as is.
 */
async function runCloneFreshnessStep(
  context: RepositoryContext,
  checkoutPath: string,
  dirName: string,
): Promise<FreshnessNote> {
  return await withCheckoutLock(checkoutPath, async () => {
    runGitAt(checkoutPath, ['fetch', 'origin', '--prune'], 300_000);

    const metadata = readCloneMetadataStrict(checkoutPath);
    const head = runGitAt(checkoutPath, ['rev-parse', 'HEAD'], 10_000);
    const status = runGitAt(checkoutPath, ['status', '--porcelain'], 10_000);
    const pristine = head === metadata.startCommit && status === '';

    const finish = async (note: FreshnessNote): Promise<FreshnessNote> => {
      await emitRefresh(context, dirName);
      return note;
    };

    if (!pristine || metadata.startedFrom === 'canonical-local') {
      const originCommit = tryGitAt(
        checkoutPath,
        ['rev-parse', '--verify', `refs/remotes/origin/${metadata.branch}`],
        10_000,
      );
      const diverged =
        metadata.startedFrom === 'origin-branch' &&
        originCommit !== null &&
        !isAncestor(checkoutPath, head, originCommit);
      return finish({ branch: metadata.branch, status: 'left-as-is', diverged });
    }

    if (metadata.startedFrom === 'origin-branch') {
      const originCommit = tryGitAt(
        checkoutPath,
        ['rev-parse', '--verify', `refs/remotes/origin/${metadata.branch}`],
        10_000,
      );
      if (originCommit && isAncestor(checkoutPath, head, originCommit)) {
        runGitAt(checkoutPath, ['merge', '--ff-only', originCommit], 30_000);
        writeCloneMetadata(checkoutPath, {
          ...metadata,
          startCommit: runGitAt(checkoutPath, ['rev-parse', 'HEAD'], 10_000),
        });
        return finish({ branch: metadata.branch, status: 'moved-fast-forward', diverged: false });
      }
      const diverged = originCommit !== null && !isAncestor(checkoutPath, head, originCommit);
      return finish({ branch: metadata.branch, status: 'left-as-is', diverged });
    }

    if (metadata.startedFrom === 'origin-head') {
      const originHeadRef = tryGitAt(checkoutPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], 10_000);
      if (originHeadRef) {
        const freshHead = tryGitAt(checkoutPath, ['rev-parse', '--verify', `${originHeadRef}^{commit}`], 10_000);
        if (freshHead) {
          runGitAt(checkoutPath, ['reset', '--keep', freshHead], 30_000);
          writeCloneMetadata(checkoutPath, { ...metadata, startCommit: freshHead });
          return finish({ branch: metadata.branch, status: 'moved-reset', diverged: false });
        }
      }
      return finish({ branch: metadata.branch, status: 'left-as-is', diverged: false });
    }

    // startedFrom === 'local-head': a brand-new branch with nothing upstream
    // to compare against yet.
    return finish({ branch: metadata.branch, status: 'left-as-is', diverged: false });
  });
}

async function createCloneWorktree(context: RepositoryContext, branch: string | null): Promise<ToolResult> {
  const response = await requestRepositoryCheckout(context, branch);
  if (!response.ok) return err(response.message || `repository checkout failed for ${context.repo}`);

  const dirName = response.dirName ?? checkoutDirName(context.repo, branch);
  const checkoutPath = path.join(context.topicRoot, dirName);
  const resolvedBranch = response.branch ?? branch ?? dirName;

  if (context.pin.kind === 'local-only') {
    // Local-only pins skip the whole post-step, including refresh (today's
    // rule for linked worktrees, `git-worktrees.ts:541-547`, carried over).
    return ok(
      `Worktree ready at ${checkoutPath} on branch ${resolvedBranch} from the preserved local-only canonical; ` +
        'fetch, push, and PR operations remain unavailable until an operator publishes an origin',
    );
  }

  const note = await runCloneFreshnessStep(context, checkoutPath, dirName);
  const divergedNote = note.diverged ? '; origin has diverged from this checkout' : '';
  return ok(
    `Worktree ready at ${checkoutPath} on branch ${note.branch} (${note.status}${divergedNote}); ` +
      'host canonical refresh queued',
  );
}

export const cloneRepoTool: McpToolDefinition = {
  tool: {
    name: 'clone_repo',
    description:
      "Clone a GitHub repository through this container's scoped identity, then durably publish one host-owned canonical clone for the workgroup. Idempotent when name, origin, and repository identity match.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'HTTPS github.com repository URL.' },
        name: { type: 'string', description: 'Optional repository name. Defaults to the URL leaf.' },
      },
      required: ['url'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const requestedUrl = typeof args.url === 'string' ? args.url : '';
    let normalizedUrl: string;
    let parsed: URL;
    try {
      normalizedUrl = normalizeOrigin(requestedUrl);
      parsed = new URL(normalizedUrl);
    } catch (error) {
      const safeMessages = new Set([
        'origin contains credentials',
        'origin must use HTTPS github.com',
        'origin must not include query parameters or fragments',
      ]);
      const message =
        error instanceof Error && safeMessages.has(error.message) ? error.message : 'Invalid repository URL';
      return err(message);
    }
    const parts = parsed.pathname
      .replace(/^\//, '')
      .replace(/\.git\/?$/i, '')
      .split('/')
      .filter(Boolean);
    if (parts.length !== 2) return err('GitHub URL must identify exactly one owner/repository');
    const repo = typeof args.name === 'string' && args.name ? args.name : parts[1]!;
    const nameError = validateSegment(repo, 'repository name');
    if (nameError) return err(nameError);
    const workgroupId = process.env.NANOCLAW_WORKGROUP_ID ?? '';
    if (validateSegment(workgroupId, 'workgroup id')) return err('repository workgroup context is unavailable');

    const requestId = `repo-${Date.now()}-${randomBytes(8).toString('hex')}`;
    const stageRoot = path.join('/workspace', 'repository-staging', requestId);
    const stageRepo = path.join(stageRoot, repo);
    fs.mkdirSync(stageRoot, { recursive: true });
    try {
      execFileSync('git', ['clone', normalizedUrl, stageRepo], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300_000,
      });
      runGitAt(stageRepo, ['config', 'gc.auto', '0'], 10_000);
      runGitAt(stageRepo, ['config', 'gc.worktreePruneExpire', 'never'], 10_000);
    } catch (error) {
      return err(`git clone failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (process.env.NANOCLAW_REPOSITORY_ACTION_TRANSPORT === 'disabled') {
      return ok(`Repository staged at ${stageRepo} (test transport)`);
    }
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'repository_publish',
        requestId,
        repo,
        origin: normalizedUrl,
        repositoryId: `github.com/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`,
      }),
    });
    return ok(
      `Repository publication queued durably for ${repo}. The workgroup will respawn with consistent mounts, ` +
        'and this topic will receive an explicit success or failure message after the host action finishes.',
    );
  },
};

export const createWorktreeTool: McpToolDefinition = {
  tool: {
    name: 'create_worktree',
    description:
      "Create or reuse a checkout of repo for this thread. With no branch, this is the thread's own checkout at " +
      "/workspace/worktrees/<repo>. With branch, it is that branch's own independent checkout — still " +
      "/workspace/worktrees/<repo> when the thread's checkout is already on it, otherwise " +
      '/workspace/worktrees/<repo>@<branch>. Any number of threads may hold the same branch at once; share work by ' +
      "pushing, never by switching a checkout another thread may be using — a checkout's branch is never switched " +
      'automatically, so request the branch you need instead. Files under node_modules may be shared and read-only ' +
      'across checkouts; never chmod them — run npm ci or npm install for a private writable copy when dependencies ' +
      'must change. continueFromThreadId moves an inactive legacy linked checkout here instead of creating a new one. ' +
      'Typical flow from here: git_commit → git_push → open_pr.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name already published for this workgroup.' },
        branch: { type: 'string', description: 'Optional explicit branch. Defaults to the stable topic branch.' },
        continueFromThreadId: {
          type: 'string',
          description:
            'Optional source external thread id or managed topic locator shown by a branch collision; the exact ' +
            'inactive worktree moves to this topic. The source tombstone records the next owner: from the original ' +
            'topic, call create_worktree with that destination locator only while it still owns the checkout. If it moved ' +
            'onward, request the transfer from the current owner. Never recreate, delete, or prune a sibling branch.',
        },
      },
      required: ['repo'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const branch = typeof args.branch === 'string' && args.branch ? args.branch : undefined;
    const continueFromThreadId =
      typeof args.continueFromThreadId === 'string' && args.continueFromThreadId
        ? args.continueFromThreadId
        : undefined;
    if (continueFromThreadId) {
      const nameError = validateSegment(repo, 'repository name');
      if (nameError) return err(nameError);
      const workgroupId = process.env.NANOCLAW_WORKGROUP_ID ?? '';
      const workUnitKey = process.env.NANOCLAW_WORK_UNIT_KEY ?? '';
      if (validateSegment(workgroupId, 'workgroup id') || !workUnitKey) {
        return err('repository work-unit context is unavailable');
      }
      await queueHostAction('repository_transfer', {
        repo,
        sourceThreadId: continueFromThreadId,
        destinationWorkUnitKey: workUnitKey,
      });
      return ok(
        `Repository transfer queued durably for ${repo}. This topic will restart after the exact linked ` +
          'worktree has moved, then receive an explicit success or failure message.',
      );
    }
    let context: RepositoryContext;
    try {
      context = contextFor(repo);
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }

    // Resolve what already exists here, in EITHER mode, before deciding how
    // to create anything. A checkout that resolves but is INVALID (an R3
    // mismatch, an origin-pin drift) is refused right here rather than
    // silently falling through to a mode-specific creation path, which would
    // ignore it and act on an unrelated path or an unrelated host action
    // (R3, P2-7). Only a clean "nothing here yet" falls through.
    let existing: ResolvedCheckout | null = null;
    try {
      existing = resolveCheckout(context, branch ?? null);
    } catch (error) {
      if (!(error instanceof CheckoutNotFoundError)) {
        return err(error instanceof Error ? error.message : String(error));
      }
    }

    if (existing?.shape === 'clone' && checkoutMode() === 'worktree') {
      // A clone-shaped checkout left over from a clone-mode period is served
      // as-is (R10, P2-18) — worktree-mode creation below only knows how to
      // create or reuse a LINKED worktree at the primary position, and has
      // no idea a `<repo>@<slug>` clone exists at all.
      return ok(`Checkout ready at ${existing.path} on branch ${existing.branch} (existing clone; left untouched)`);
    }

    if (checkoutMode() === 'clone' && existing?.shape !== 'linked') {
      try {
        return await createCloneWorktree(context, branch ?? null);
      } catch (error) {
        return err(`create_worktree failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // worktree mode, or a legacy linked checkout reused unchanged in clone
    // mode (R10, §5.10, P2-11): createLinkedWorktree runs its own
    // fetch-then-reuse-or-create flow exactly as today.
    try {
      return await withRepositoryLock(context, () => createLinkedWorktree(context, branch));
    } catch (error) {
      return err(`create_worktree failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

export const gitCommitTool: McpToolDefinition = {
  tool: {
    name: 'git_commit',
    description:
      'Stage and commit all changes in this checkout. Returns the short commit SHA. Stages every dirty file in ' +
      'the checkout, including any left by same-topic siblings sharing it — coordinate before committing. Never add ' +
      '"Co-Authored-By" trailers or "Generated with Claude Code" footers to the message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name.' },
        message: { type: 'string', description: 'Commit message.' },
        branch: {
          type: 'string',
          description:
            "Optional branch selecting which of this thread's checkouts to commit in. Defaults to the primary " +
            'checkout for repo.',
        },
      },
      required: ['repo', 'message'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const message = typeof args.message === 'string' ? args.message : '';
    const branchArg = typeof args.branch === 'string' ? args.branch : undefined;
    if (!message.trim()) return err('message is required');
    const resolved = worktreeForTool(repo, branchArg);
    if ('error' in resolved) return resolved.error;
    try {
      return await withRepositoryLock(resolved.context, () => {
        runGitAt(resolved.context.worktree, ['add', '-A']);
        runGitAt(resolved.context.worktree, [
          '-c',
          'user.email=agent@nanoclaw.local',
          '-c',
          'user.name=agent',
          'commit',
          '--no-verify',
          '-m',
          message,
        ]);
        return ok(`Committed ${runGitAt(resolved.context.worktree, ['rev-parse', '--short', 'HEAD'])}`);
      });
    } catch (error) {
      return err(`git commit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

export const gitPushTool: McpToolDefinition = {
  tool: {
    name: 'git_push',
    description:
      "Push this checkout's branch through the container-scoped origin identity. Sends the branch and commit " +
      'as they stood when the call started, so work a sibling adds meanwhile is not carried along — push again to ' +
      'send it. Refused while the pr-review-loop churn gate is holding: three review rounds on one finding class ' +
      'means the fix belongs in the primitive every flagged site calls, not at one more site.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name.' },
        force: { type: 'boolean', description: 'Use --force-with-lease.' },
        branch: {
          type: 'string',
          description:
            "Optional branch selecting which of this thread's checkouts to push. Defaults to the primary checkout " +
            'for repo.',
        },
      },
      required: ['repo'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const branchArg = typeof args.branch === 'string' ? args.branch : undefined;
    const resolved = worktreeForTool(repo, branchArg);
    if ('error' in resolved) return resolved.error;
    const worktree = resolved.context.worktree;
    try {
      // A container agent's push path is this tool, not the skill's
      // `codex-review.sh push`, so the gate has to sit here or it does not
      // exist for container review loops. It fails open — only an explicit
      // refusal stops the push.
      //
      // The identity is captured under the repository lock (see
      // `capturedIdentity`); the gate then runs OUTSIDE it, deliberately,
      // because it makes its own `gh` calls and holding the lock across them
      // would stall every sibling topic on this repo. Same-topic siblings
      // share this worktree,
      // so the checkout can change underneath the verdict — a commit, a
      // rewrite, a checkout of another branch at the same commit. Rather than
      // detect each of those, the branch and commit are captured once, up
      // front, and everything downstream NAMES them: the gate is asked about
      // that branch and that commit, and the push sends them as an explicit
      // refspec. Nothing downstream reads the checkout again, so what reaches
      // the remote is what the gate looked at, or nothing. Work a sibling adds
      // in the window is simply not pushed here; it gets its own verdict on
      // its own push.
      const identity = await capturedIdentity(resolved.context);
      if (!identity) return err('Cannot push a detached HEAD; create or switch to a branch explicitly');
      const { branch, head } = identity;

      const gate = evaluateReviewChurnGate({
        worktree,
        branch,
        head,
        force: args.force === true,
        lease: identity.lease,
      });
      if (gate.status === 'refused') return err(gate.message);

      return await withRepositoryLock(resolved.context, async () => {
        const push = [
          'push',
          ...(args.force === true ? [`--force-with-lease=refs/heads/${branch}:${identity.lease}`] : []),
          'origin',
          `${head}:refs/heads/${branch}`,
        ];
        runGitAt(worktree, push, 300_000);
        // `-u` does not apply to a refspec whose source is a commit, so the
        // tracking config the old form set is restored explicitly. Best effort:
        // it is a convenience, and the push has already landed.
        tryGitAt(worktree, ['branch', `--set-upstream-to=origin/${branch}`, branch]);
        // A clone records the push only in its own remote-tracking refs, so the
        // refresh names it for the host to absorb them (plan §5.5).
        await emitRefresh(
          resolved.context,
          resolved.checkout.shape === 'clone' ? resolved.checkout.dirName : undefined,
        );
        return ok(
          `Pushed ${branch} at ${head.slice(0, 8)} to origin${args.force === true ? ' (force-with-lease)' : ''}. ` +
            `Pass branch=${branch} to open_pr so the PR is opened for this push, not for the checkout.`,
        );
      });
    } catch (error) {
      return err(`git push failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

export const openPrTool: McpToolDefinition = {
  tool: {
    name: 'open_pr',
    description:
      "Open a GitHub pull request from this checkout's branch. After it opens: add_ship_log to record it, " +
      'update_backlog_item to resolve any backlog item it addresses, and add_backlog_item for any new bugs found along the way.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Optional pull request body.' },
        branch: {
          type: 'string',
          description:
            'Branch to open the PR for, and to select the checkout — pass the branch git_push reported. Without it, ' +
            "the primary checkout's current branch is used, which a same-topic sibling can have switched since the push.",
        },
      },
      required: ['repo', 'title'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const title = typeof args.title === 'string' ? args.title : '';
    const body = typeof args.body === 'string' ? args.body : '';
    if (!title.trim()) return err('title is required');
    const branchArg = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined;
    // `branch` selects the checkout holding it. When none does (the push came
    // from a checkout a same-topic sibling has since switched), the PR still
    // opens for it: `gh` needs only some checkout of the repository to run in,
    // and `--head` names the branch.
    let resolved = worktreeForTool(repo, branchArg);
    if ('error' in resolved && branchArg) resolved = worktreeForTool(repo);
    if ('error' in resolved) return resolved.error;
    try {
      // Bound to a named branch, never to whatever is checked out when `gh`
      // runs: same-topic siblings share the worktree, and `gh pr create`
      // defaults `--head` to the current branch, so a switch mid-call would
      // open the PR for the sibling's branch — or push theirs to open it.
      //
      // `branch` is what closes the window between a push and this call, which
      // no locking here can reach: git_push names the branch it pushed, and
      // passing that name back makes this call describe that push rather than
      // the checkout as it now stands, whichever checkout `gh` runs in. Absent
      // it, the branch is captured under the lock, which is correct whenever
      // the checkout has not moved.
      let head = branchArg;
      if (!head) {
        const identity = await capturedIdentity(resolved.context);
        if (!identity) return err('Cannot open a PR from a detached HEAD; create or switch to a branch explicitly');
        head = identity.branch;
      }
      const url = execFileSync('gh', ['pr', 'create', '--head', head, '--title', title, '--body', body], {
        cwd: resolved.context.worktree,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      }).trim();
      return ok(`PR opened: ${url}`);
    } catch (error) {
      return err(`gh pr create failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

export const gitWorktreeTools: McpToolDefinition[] = [
  cloneRepoTool,
  createWorktreeTool,
  gitCommitTool,
  gitPushTool,
  openPrTool,
];

registerTools(gitWorktreeTools);
