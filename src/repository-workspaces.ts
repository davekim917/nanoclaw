/**
 * Host-owned repository layout and canonical topic identity.
 *
 * The host resolves every path from trusted DB identity. Containers receive
 * only the resulting topic root, canonical `.git`, pin, and stable lock mounts;
 * they never choose a workgroup or canonical host path themselves.
 */
import { execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { readCanonicalCommondir, type CanonicalCommondirState } from './canonical-git-commondir.js';
import { DATA_DIR } from './config.js';
import { ensureLockFile, withFileLock } from './file-lock.js';
import { safeGitArgs, safeGitEnv } from './safe-git.js';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TASK_THREAD_PREFIX = 'system:tasks:';

type RepositoryWorkUnitKind = 'thread' | 'conversation' | 'task' | 'session';

export interface RepositoryWorkUnit {
  workgroupId: string;
  kind: RepositoryWorkUnitKind;
  key: string;
  id: string;
}

export interface RepositoryWorkUnitInput {
  workgroupId: string;
  sessionId: string;
  platformId: string | null;
  messagingGroupId: string | null;
  threadId: string | null;
}

export interface CanonicalRepository {
  name: string;
  path: string;
  gitDir: string;
  lockPath: string;
  originPinPath: string;
}

export type OriginPin =
  | {
      /** Existing pins omit kind for backward compatibility. */
      kind?: 'network';
      origin: string;
      repositoryId: string;
    }
  | {
      /** Migration-only state for a repository that never had a remote: linked worktrees work; fetch/push/PR fail closed. */
      kind: 'local-only';
      origin: null;
      repositoryId: string;
    };

export interface RepositoryTransferTombstone {
  version: 1;
  phase: 'prepared' | 'moved';
  workgroupId: string;
  repo: string;
  sourceWorkUnitKey: string;
  destinationWorkUnitKey: string;
  sourcePath: string;
  destinationPath: string;
  createdAt: string;
}

const activeLifecycleClaims = new Set<string>();
const activeWorkgroupMountClaims = new Set<string>();

function assertSegment(value: string, label: string): void {
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..' || value.endsWith('.lock')) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

export function assertWorkgroupId(workgroupId: string): void {
  assertSegment(workgroupId, 'workgroup id');
}

export function assertRepositoryName(repo: string): void {
  assertSegment(repo, 'repository name');
  if (repo === '.git') throw new Error(`Invalid repository name: ${repo}`);
}

export function repositoriesRoot(dataDir: string = DATA_DIR): string {
  return path.join(path.resolve(dataDir), 'repositories');
}

export function repositoryStateRoot(dataDir: string = DATA_DIR): string {
  return path.join(path.resolve(dataDir), 'repository-state');
}

export function canonicalRepoDir(workgroupId: string, repo: string, dataDir: string = DATA_DIR): string {
  assertWorkgroupId(workgroupId);
  assertRepositoryName(repo);
  return path.join(repositoriesRoot(dataDir), workgroupId, repo);
}

export function canonicalGitDir(workgroupId: string, repo: string, dataDir: string = DATA_DIR): string {
  return path.join(canonicalRepoDir(workgroupId, repo, dataDir), '.git');
}

export function repositoryCoordinationDir(workgroupId: string, repo: string, dataDir: string = DATA_DIR): string {
  assertWorkgroupId(workgroupId);
  assertRepositoryName(repo);
  return path.join(repositoryStateRoot(dataDir), workgroupId, repo);
}

export function repositoryLockPath(workgroupId: string, repo: string, dataDir: string = DATA_DIR): string {
  return path.join(repositoryCoordinationDir(workgroupId, repo, dataDir), 'repository.lock');
}

export function originPinPath(workgroupId: string, repo: string, dataDir: string = DATA_DIR): string {
  return path.join(repositoryCoordinationDir(workgroupId, repo, dataDir), 'origin.json');
}

export function ensureRepositoryLock(workgroupId: string, repo: string, dataDir: string = DATA_DIR): string {
  return ensureLockFile(repositoryLockPath(workgroupId, repo, dataDir));
}

/** Exclusive, 120s wait, lock identity verified after acquisition (mechanism in `file-lock.ts`). */
export async function withHostRepositoryLock<T>(
  workgroupId: string,
  repo: string,
  fn: () => Promise<T> | T,
  dataDir: string = DATA_DIR,
): Promise<T> {
  return withFileLock(ensureRepositoryLock(workgroupId, repo, dataDir), fn, {
    label: `repository lock for ${workgroupId}/${repo}`,
  });
}

export async function withRepositoryLifecycleClaims<T>(
  workUnits: readonly RepositoryWorkUnit[],
  fn: () => Promise<T> | T,
): Promise<T> {
  const keys = [...new Set(workUnits.map((unit) => `${unit.workgroupId}:${unit.id}`))].sort();
  for (const key of keys) {
    if (activeLifecycleClaims.has(key)) throw new Error(`repository lifecycle is already claimed: ${key}`);
  }
  for (const key of keys) activeLifecycleClaims.add(key);
  try {
    return await fn();
  } finally {
    for (const key of keys) activeLifecycleClaims.delete(key);
  }
}

export function isRepositoryLifecycleClaimed(workUnit: RepositoryWorkUnit): boolean {
  return activeLifecycleClaims.has(`${workUnit.workgroupId}:${workUnit.id}`);
}

export async function withWorkgroupRepositoryMountClaim<T>(workgroupId: string, fn: () => Promise<T> | T): Promise<T> {
  assertWorkgroupId(workgroupId);
  if (activeWorkgroupMountClaims.has(workgroupId)) {
    throw new Error(`repository mount reconciliation is already active for ${workgroupId}`);
  }
  activeWorkgroupMountClaims.add(workgroupId);
  try {
    return await fn();
  } finally {
    activeWorkgroupMountClaims.delete(workgroupId);
  }
}

export function isWorkgroupRepositoryMountClaimed(workgroupId: string): boolean {
  return activeWorkgroupMountClaims.has(workgroupId);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function workUnitKey(kind: RepositoryWorkUnitKind, ...identity: string[]): string {
  // A structured tuple keeps adapter identifiers' delimiters unambiguous before hashing.
  return JSON.stringify([kind, ...identity]);
}

export function resolveRepositoryWorkUnit(input: RepositoryWorkUnitInput): RepositoryWorkUnit {
  assertWorkgroupId(input.workgroupId);
  if (!input.sessionId) throw new Error('session id is required for repository work-unit resolution');

  let kind: RepositoryWorkUnitKind;
  let key: string;
  const taskAnchor = input.threadId?.startsWith(TASK_THREAD_PREFIX)
    ? input.threadId.slice(TASK_THREAD_PREFIX.length)
    : null;
  if (input.messagingGroupId && input.platformId && input.threadId && taskAnchor === null) {
    kind = 'thread';
    key = workUnitKey(kind, input.platformId, input.threadId);
  } else if (taskAnchor !== null) {
    if (!taskAnchor) throw new Error('scheduled task repository work-unit is missing its stable anchor');
    kind = 'task';
    key = workUnitKey(kind, taskAnchor);
  } else if (input.messagingGroupId && input.platformId) {
    kind = 'conversation';
    key = workUnitKey(kind, input.platformId);
  } else {
    kind = 'session';
    key = workUnitKey(kind, input.sessionId);
  }

  return {
    workgroupId: input.workgroupId,
    kind,
    key,
    id: sha256(`${input.workgroupId}\0${key}`).slice(0, 32),
  };
}

export function topicsRoot(dataDir: string = DATA_DIR): string {
  return path.join(path.resolve(dataDir), 'v2-topics');
}

export function topicStateDir(workUnit: RepositoryWorkUnit, dataDir: string = DATA_DIR): string {
  assertWorkgroupId(workUnit.workgroupId);
  if (!/^[a-f0-9]{32}$/.test(workUnit.id)) throw new Error(`Invalid repository work-unit id: ${workUnit.id}`);
  return path.join(topicsRoot(dataDir), workUnit.workgroupId, `${workUnit.kind}-${workUnit.id}`);
}

export function topicWorktreesDir(workUnit: RepositoryWorkUnit, dataDir: string = DATA_DIR): string {
  return path.join(topicStateDir(workUnit, dataDir), 'worktrees');
}

export function defaultTopicBranch(workUnit: RepositoryWorkUnit, repo: string): string {
  assertRepositoryName(repo);
  const digest = sha256(`${workUnit.workgroupId}\0${workUnit.key}\0${repo}`).slice(0, 24);
  return `nc/topic-${digest}`;
}

export function transferTombstonesDir(workgroupId: string, repo: string, dataDir: string = DATA_DIR): string {
  return path.join(repositoryCoordinationDir(workgroupId, repo, dataDir), 'transfers');
}

export function transferTombstonePath(workUnit: RepositoryWorkUnit, repo: string, dataDir: string = DATA_DIR): string {
  return path.join(transferTombstonesDir(workUnit.workgroupId, repo, dataDir), `${workUnit.id}.json`);
}

export function readTransferTombstone(
  workUnit: RepositoryWorkUnit,
  repo: string,
  dataDir: string = DATA_DIR,
): RepositoryTransferTombstone | null {
  const file = transferTombstonePath(workUnit, repo, dataDir);
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('repository transfer tombstone is not a regular file');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RepositoryTransferTombstone;
    if (
      parsed.version !== 1 ||
      (parsed.phase !== 'prepared' && parsed.phase !== 'moved') ||
      parsed.workgroupId !== workUnit.workgroupId ||
      parsed.repo !== repo ||
      parsed.sourceWorkUnitKey !== workUnit.key
    ) {
      throw new Error('repository transfer tombstone identity mismatch');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function writeTransferTombstone(
  source: RepositoryWorkUnit,
  repo: string,
  tombstone: RepositoryTransferTombstone,
  dataDir: string = DATA_DIR,
): void {
  if (
    tombstone.version !== 1 ||
    (tombstone.phase !== 'prepared' && tombstone.phase !== 'moved') ||
    tombstone.workgroupId !== source.workgroupId ||
    tombstone.repo !== repo ||
    tombstone.sourceWorkUnitKey !== source.key
  ) {
    throw new Error('repository transfer tombstone identity mismatch');
  }
  atomicJson(transferTombstonePath(source, repo, dataDir), tombstone);
}

/** Durable JSON write: temp file, fsync, rename, fsync of the parent directory. */
export function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    const fd = fs.openSync(temp, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    const parentFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(parentFd);
    } finally {
      fs.closeSync(parentFd);
    }
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Published or never created.
    }
  }
}

export function fsyncDirectories(...directories: string[]): void {
  for (const directory of new Set(directories.map((entry) => path.resolve(entry)))) {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** One canonical repository that cannot be served, and why. */
interface UnusableCanonicalRepository {
  name: string;
  path: string;
  /** The message the throwing form raises, and what a caller logs when it skips this repository. */
  reason: string;
  /** The cause is a `commondir` that is not the sentinel, or one that could not be read. */
  commondir: boolean;
}

export interface CanonicalRepositoryClassification {
  repositories: CanonicalRepository[];
  unusable: UnusableCanonicalRepository[];
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Why `repoPath` cannot be served, or null. `commondir` is read BEFORE any Git probe: Git follows a foreign commondir. */
function containedNormalCloneProblem(repoPath: string, root: string): { reason: string; commondir: boolean } | null {
  const gitDir = path.join(repoPath, '.git');
  let repoReal: string;
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(root);
    const repoStat = fs.lstatSync(repoPath);
    if (repoStat.isSymbolicLink() || !repoStat.isDirectory()) {
      return { reason: `canonical repository entry is not a real directory: ${repoPath}`, commondir: false };
    }
    repoReal = fs.realpathSync(repoPath);
  } catch (error) {
    return {
      reason: `canonical repository entry is not a real directory: ${repoPath}: ${describeError(error)}`,
      commondir: false,
    };
  }
  if (!repoReal.startsWith(`${rootReal}${path.sep}`)) {
    return { reason: `canonical repository escapes its workgroup namespace: ${repoPath}`, commondir: false };
  }
  let gitStat: fs.Stats;
  try {
    gitStat = fs.lstatSync(gitDir);
  } catch (error) {
    return {
      reason: `canonical repository has missing or unreadable Git metadata: ${repoPath}: ${describeError(error)}`,
      commondir: false,
    };
  }
  if (gitStat.isSymbolicLink() || !gitStat.isDirectory()) {
    return { reason: `canonical repository has invalid Git metadata: ${repoPath}`, commondir: false };
  }
  let commondirState: CanonicalCommondirState;
  try {
    commondirState = readCanonicalCommondir(gitDir);
  } catch (error) {
    return {
      reason: `canonical repository .git holds an unreadable commondir: ${gitDir}: ${describeError(error)}`,
      commondir: true,
    };
  }
  if (commondirState === 'foreign') {
    return {
      reason: `canonical repository .git holds a commondir that is not the sentinel: ${gitDir}`,
      commondir: true,
    };
  }
  let bare: string;
  try {
    bare = execFileSync('git', safeGitArgs(['-C', repoPath, 'rev-parse', '--is-bare-repository']), {
      encoding: 'utf8',
      env: safeGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }).trim();
  } catch (error) {
    return {
      reason: `canonical repository could not be probed by Git: ${repoPath}: ${describeError(error)}`,
      commondir: false,
    };
  }
  if (bare !== 'false') return { reason: `canonical repository is not a normal clone: ${repoPath}`, commondir: false };
  return null;
}

/**
 * Every canonical repository, split into servable and not, judged one repository at a time: a namespace problem
 * still throws, but a bad repository withholds only its own mounts.
 */
export function classifyCanonicalRepositories(
  workgroupId: string,
  dataDir: string = DATA_DIR,
): CanonicalRepositoryClassification {
  assertWorkgroupId(workgroupId);
  const workgroupRoot = path.join(repositoriesRoot(dataDir), workgroupId);
  try {
    const stat = fs.lstatSync(workgroupRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`canonical workgroup namespace is not a real directory: ${workgroupRoot}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { repositories: [], unusable: [] };
    throw error;
  }
  const entries = fs.readdirSync(workgroupRoot, { withFileTypes: true });

  const repositories: CanonicalRepository[] = [];
  const unusable: UnusableCanonicalRepository[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const repoPath = path.join(workgroupRoot, entry.name);
    let problem: { reason: string; commondir: boolean } | null;
    let served: CanonicalRepository | null = null;
    try {
      assertRepositoryName(entry.name);
      problem =
        !entry.isDirectory() || entry.isSymbolicLink()
          ? { reason: `invalid entry in canonical repository namespace: ${repoPath}`, commondir: false }
          : containedNormalCloneProblem(repoPath, workgroupRoot);
      if (!problem) {
        // Inside the try: an I/O fault on one repository's coordination files makes only that repository unusable.
        served = {
          name: entry.name,
          path: repoPath,
          gitDir: path.join(repoPath, '.git'),
          lockPath: ensureRepositoryLock(workgroupId, entry.name, dataDir),
          originPinPath: originPinPath(workgroupId, entry.name, dataDir),
        };
      }
    } catch (error) {
      problem = { reason: describeError(error), commondir: false };
    }
    if (problem || !served) {
      unusable.push({
        name: entry.name,
        path: repoPath,
        ...(problem ?? { reason: `canonical repository could not be prepared: ${repoPath}`, commondir: false }),
      });
      continue;
    }
    repositories.push(served);
  }
  return { repositories, unusable };
}

/** All-or-nothing form (the first unusable repository throws), for callers that skip the whole workgroup on any bad repository. */
export function discoverCanonicalRepositories(workgroupId: string, dataDir: string = DATA_DIR): CanonicalRepository[] {
  const { repositories, unusable } = classifyCanonicalRepositories(workgroupId, dataDir);
  if (unusable.length > 0) throw new Error(unusable[0].reason);
  return repositories;
}

/**
 * An HTTPS github.com owner/repo URL becomes lowercase `github.com/<owner>/<repo>`, so activation's and
 * publication's forms compare equal; any other identity is returned unchanged.
 */
function normalizedPinIdentity(repositoryId: string): string {
  if (!/^https:\/\//i.test(repositoryId) || !URL.canParse(repositoryId)) return repositoryId;
  const parsed = new URL(repositoryId);
  if (parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return repositoryId;
  }
  const parts = parsed.pathname
    .replace(/\.git\/?$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  if (parts.length !== 2) return repositoryId;
  return `github.com/${parts[0]!.toLowerCase()}/${parts[1]!.toLowerCase()}`;
}

function validateOriginPin(pin: OriginPin): OriginPin {
  if (!pin.repositoryId) throw new Error('origin pin requires repository identity');
  if (pin.kind === 'local-only') {
    if (pin.origin !== null || !pin.repositoryId.startsWith('local-only:')) {
      throw new Error('local-only origin pin is malformed');
    }
    return { kind: 'local-only', origin: null, repositoryId: pin.repositoryId };
  }
  if (!pin.origin) throw new Error('network origin pin requires an origin');
  if (process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN === '1' && path.isAbsolute(pin.origin)) {
    return { origin: fs.realpathSync(pin.origin).replace(/\/+$/, ''), repositoryId: pin.repositoryId };
  }
  if (!URL.canParse(pin.origin)) {
    throw new Error('origin pin must be an absolute HTTPS github.com URL');
  }
  const parsed = new URL(pin.origin);
  if (parsed.username || parsed.password) throw new Error('origin pin must not contain credentials or URL authority');
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new Error('origin pin must be an HTTPS github.com URL');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('origin pin must not include query parameters or fragments');
  }
  parsed.pathname = parsed.pathname.replace(/\.git\/?$/i, '');
  return { origin: parsed.toString().replace(/\/+$/, ''), repositoryId: normalizedPinIdentity(pin.repositoryId) };
}

export function readOriginPin(workgroupId: string, repo: string, dataDir: string = DATA_DIR): OriginPin | null {
  const file = originPinPath(workgroupId, repo, dataDir);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('origin pin must not be a symlink', { cause: error });
    }
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('origin pin must be a regular file');
    return validateOriginPin(JSON.parse(fs.readFileSync(fd, 'utf8')) as OriginPin);
  } finally {
    fs.closeSync(fd);
  }
}

export function writeOriginPin(
  workgroupId: string,
  repo: string,
  requestedPin: OriginPin,
  dataDir: string = DATA_DIR,
): void {
  const pin = validateOriginPin(requestedPin);
  const existing = readOriginPin(workgroupId, repo, dataDir);
  if (existing) {
    if (existing.kind === pin.kind && existing.origin === pin.origin && existing.repositoryId === pin.repositoryId)
      return;
    throw new Error(`origin pin conflict for ${workgroupId}/${repo}`);
  }

  const file = originPinPath(workgroupId, repo, dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(pin, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
    const parentFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      fs.fsyncSync(parentFd);
    } finally {
      fs.closeSync(parentFd);
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch {
      // Already atomically published or never created.
    }
  }
}

// Checkout layout: `worktrees/<repo>` is the primary checkout, `worktrees/<repo>@<slug>` any other branch's.
// Duplicated on purpose in container/agent-runner/src/mcp-tools/checkout-layout.ts; both are pinned by
// checkout-layout.fixtures.json.

const CHECKOUT_SLUG = /^[A-Za-z0-9._-]+$/;
const CHECKOUT_SLUG_MAX_CHARS = 80;

export type CheckoutShape = 'clone' | 'linked' | 'unknown';

export interface TopicCheckout {
  name: string;
  repo: string;
  slug: string | null;
  path: string;
  shape: CheckoutShape;
}

/** `<repo>` for no branch, else `<repo>@<slug>`. A lossy slug carries the branch's hash, so `feat/x` and `feat-x` never collide. */
export function checkoutDirName(repo: string, branch: string | null): string {
  if (branch === null) return repo;
  let slug = branch
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, CHECKOUT_SLUG_MAX_CHARS);
  if (slug !== branch) slug += `-${createHash('sha256').update(branch, 'utf8').digest('hex').slice(0, 8)}`;
  return `${repo}@${slug}`;
}

/** `{repo, slug}` for a checkout dir name; `null` for anything else, every dot-prefixed name included. */
export function parseCheckoutDirName(name: string): { repo: string; slug: string | null } | null {
  if (name.startsWith('.')) return null;
  const at = name.indexOf('@');
  const repo = at === -1 ? name : name.slice(0, at);
  if (!SAFE_SEGMENT.test(repo)) return null;
  if (at === -1) return { repo, slug: null };
  const slug = name.slice(at + 1);
  return CHECKOUT_SLUG.test(slug) ? { repo, slug } : null;
}

/**
 * The only enumerator of a topic's checkouts: directories whose names parse,
 * each with the shape its `.git` gives it (a directory is a clone, a file a
 * linked worktree, anything else `unknown`). A missing topic dir has none; any
 * other read failure throws, so no caller can mistake "unreadable" for "empty".
 */
export function listTopicCheckouts(topicWorktreesDir: string): TopicCheckout[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(topicWorktreesDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const checkouts: TopicCheckout[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parsed = parseCheckoutDirName(entry.name);
    if (!parsed) continue;
    const checkoutPath = path.join(topicWorktreesDir, entry.name);
    checkouts.push({ name: entry.name, ...parsed, path: checkoutPath, shape: checkoutShape(checkoutPath) });
  }
  return checkouts.sort((a, b) => a.name.localeCompare(b.name));
}

function checkoutShape(checkoutPath: string): CheckoutShape {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(path.join(checkoutPath, '.git'));
  } catch {
    return 'unknown';
  }
  if (stat.isDirectory()) return 'clone';
  return stat.isFile() ? 'linked' : 'unknown';
}

// Clones are built under `<topic>/checkout-staging/` and published into `worktrees/` by one rename. Staging sits
// BESIDE `worktrees/`, never inside: `worktrees/` is container-writable, so a planted symlink could steer the
// host's staging into host data.

const CHECKOUT_STAGING_DIRNAME = 'checkout-staging';
const CHECKOUT_METADATA_FILENAME = 'nanoclaw-checkout.json';
/** A staging entry this old, on a lane with no job running, is crash residue. */
const CHECKOUT_STAGING_STALE_MS = 60 * 60 * 1000;

export type CheckoutStartedFrom = 'canonical-local' | 'origin-branch' | 'origin-head' | 'local-head';

const CHECKOUT_STARTED_FROM: ReadonlySet<string> = new Set<CheckoutStartedFrom>([
  'canonical-local',
  'origin-branch',
  'origin-head',
  'local-head',
]);

/** `<clone>/.git/nanoclaw-checkout.json`, written by the host when it creates a clone. */
export interface CheckoutMetadata {
  version: 1;
  repo: string;
  branch: string;
  startCommit: string;
  startedFrom: CheckoutStartedFrom;
}

export function checkoutStagingRoot(topicWorktreesDir: string): string {
  // Beside the worktrees root in the topic state dir, outside every container mount.
  return path.join(path.dirname(topicWorktreesDir), CHECKOUT_STAGING_DIRNAME);
}

function checkoutMetadataPath(checkoutPath: string): string {
  return path.join(checkoutPath, '.git', CHECKOUT_METADATA_FILENAME);
}

/** The clone's recorded identity; `null` when the file is absent, a throw when it is not a valid record. */
export function readCheckoutMetadata(checkoutPath: string): CheckoutMetadata | null {
  const file = checkoutMetadataPath(checkoutPath);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`checkout metadata is unreadable: ${file}`, { cause: error });
  }
  let parsed: Partial<CheckoutMetadata>;
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`checkout metadata is not a regular file: ${file}`);
    parsed = JSON.parse(fs.readFileSync(fd, 'utf8')) as Partial<CheckoutMetadata>;
  } finally {
    fs.closeSync(fd);
  }
  if (
    parsed.version !== 1 ||
    typeof parsed.repo !== 'string' ||
    typeof parsed.branch !== 'string' ||
    !parsed.branch ||
    typeof parsed.startCommit !== 'string' ||
    !/^[0-9a-f]{40,64}$/.test(parsed.startCommit) ||
    typeof parsed.startedFrom !== 'string' ||
    !CHECKOUT_STARTED_FROM.has(parsed.startedFrom)
  ) {
    throw new Error(`checkout metadata is malformed: ${file}`);
  }
  return {
    version: 1,
    repo: parsed.repo,
    branch: parsed.branch,
    startCommit: parsed.startCommit,
    startedFrom: parsed.startedFrom,
  };
}

export function writeCheckoutMetadata(checkoutPath: string, metadata: CheckoutMetadata): void {
  const file = checkoutMetadataPath(checkoutPath);
  const fd = fs.openSync(file, 'wx', 0o644);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Inherited tags: a clone copies every canonical tag, and the disposability proof would count them as unpushed
// work. The host records the tags a new clone holds (outside every container mount) and the proof drops a tag
// only while it is unchanged. The canonical is never read at proof time: its refs are container-writable. The
// record carries the clone's identity, so a replacement clone at the same path ignores it.

const CHECKOUT_TAGS_DIRNAME = 'checkout-tags';

/**
 * `<dev>:<ino>:<birth ns>` of the clone's `.git` directory, or `null` when it
 * is not a directory. rename(2) keeps all three; a new directory never matches
 * (inode reuse would also need the same birth time to the nanosecond).
 */
export function cloneIdentity(checkoutPath: string): string | null {
  try {
    const stat = fs.lstatSync(path.join(checkoutPath, '.git'), { bigint: true });
    return stat.isDirectory() ? `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` : null;
  } catch {
    return null;
  }
}

/** `<topic>/checkout-tags/<dirName>` for the checkout at `<topic>/worktrees/<dirName>`. */
export function checkoutInheritedTagsPath(checkoutPath: string): string {
  return path.join(path.dirname(path.dirname(checkoutPath)), CHECKOUT_TAGS_DIRNAME, path.basename(checkoutPath));
}

/** Record the tags a just-built clone inherited (`for-each-ref` output), keyed to its cloneIdentity. */
export function writeCheckoutInheritedTags(checkoutPath: string, identity: string, forEachRef: string): void {
  const file = checkoutInheritedTagsPath(checkoutPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const tags = forEachRef === '' || forEachRef.endsWith('\n') ? forEachRef : `${forEachRef}\n`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o644);
    try {
      fs.writeFileSync(fd, `clone ${identity}\n${tags}`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/** Recorded tags for the clone at `checkoutPath`; null (no exemption) when absent, unreadable, for another clone, or malformed. */
export function readCheckoutInheritedTags(recordPath: string, checkoutPath: string): Map<string, string> | null {
  let text: string;
  let fd: number;
  try {
    fd = fs.openSync(recordPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    text = fs.readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
  const [header, ...lines] = text.split('\n');
  const identity = cloneIdentity(checkoutPath);
  if (identity === null || header !== `clone ${identity}`) return null;
  const tags = new Map<string, string>();
  for (const line of lines) {
    if (!line) continue;
    const match = /^([0-9a-f]{40,64}) (refs\/tags\/\S+)$/.exec(line);
    if (!match) return null;
    tags.set(match[2]!, match[1]!);
  }
  return tags;
}

/** Drop the record of a checkout that is gone. A record left behind is replaced when that name is next built. */
export function removeCheckoutInheritedTags(checkoutPath: string): void {
  fs.rmSync(checkoutInheritedTagsPath(checkoutPath), { force: true });
}

/** Delete stale staging entries. Safe only when the caller is its topic lane's one running job (or proves the lane idle). */
export function removeStaleCheckoutStaging(
  topicWorktreesDir: string,
  options: { now: number; keep?: string; maxAgeMs?: number },
): string[] {
  const root = checkoutStagingRoot(topicWorktreesDir);
  const maxAgeMs = options.maxAgeMs ?? CHECKOUT_STAGING_STALE_MS;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (entry.name === options.keep) continue;
    const full = path.join(root, entry.name);
    const stat = fs.lstatSync(full);
    if (options.now - stat.mtimeMs < maxAgeMs) continue;
    fs.rmSync(full, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed.sort();
}
