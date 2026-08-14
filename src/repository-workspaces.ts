/**
 * Host-owned repository layout and canonical topic identity.
 *
 * The host resolves every path from trusted DB identity. Containers receive
 * only the resulting topic root, canonical `.git`, pin, and stable lock mounts;
 * they never choose a workgroup or canonical host path themselves.
 */
import { execFileSync, spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { safeGitArgs, safeGitEnv } from './safe-git.js';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TASK_THREAD_PREFIX = 'system:tasks:';

export type RepositoryWorkUnitKind = 'thread' | 'conversation' | 'task' | 'session';

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
      /**
       * A migration-only preservation state for a repository that never had a
       * remote. It remains usable through linked worktrees, but fetch/push/PR
       * operations fail closed until an operator deliberately publishes it.
       */
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

function openStableRegularFile(file: string): number {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx+', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    } catch (openError) {
      if ((openError as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new Error(`Repository coordination file must not be a symlink: ${file}`, { cause: openError });
      }
      throw openError;
    }
  }
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    fs.closeSync(fd);
    throw new Error(`Repository coordination path must be a regular file: ${file}`);
  }
  return fd;
}

export function ensureRepositoryLock(workgroupId: string, repo: string, dataDir: string = DATA_DIR): string {
  const file = repositoryLockPath(workgroupId, repo, dataDir);
  const fd = openStableRegularFile(file);
  fs.closeSync(fd);
  fs.chmodSync(file, 0o600);
  return file;
}

export async function withHostRepositoryLock<T>(
  workgroupId: string,
  repo: string,
  fn: () => Promise<T> | T,
  dataDir: string = DATA_DIR,
): Promise<T> {
  const lock = ensureRepositoryLock(workgroupId, repo, dataDir);
  const before = fs.lstatSync(lock);
  const holder = spawn('flock', ['-x', '-w', '120', lock, 'sh', '-c', 'printf ready; read _'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  await new Promise<void>((resolve, reject) => {
    let output = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      holder.kill('SIGTERM');
      reject(new Error(`timed out acquiring repository lock for ${workgroupId}/${repo}`));
    }, 125_000);
    holder.stdout.setEncoding('utf8');
    holder.stderr.setEncoding('utf8');
    holder.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    holder.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.includes('ready')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    holder.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    holder.once('close', (code) => {
      if (!output.includes('ready')) {
        clearTimeout(timeout);
        reject(new Error(`failed to acquire repository lock (${code}): ${stderr.trim()}`));
      }
    });
  });

  try {
    const after = fs.lstatSync(lock);
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error(`repository lock identity changed for ${workgroupId}/${repo}`);
    }
    return await fn();
  } finally {
    holder.stdin.end('\n');
    await new Promise<void>((resolve) => {
      if (holder.exitCode !== null) return resolve();
      holder.once('close', () => resolve());
    });
  }
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
  // External identifiers may contain any delimiter used by a chat adapter.
  // A structured tuple keeps their boundaries unambiguous before the key is
  // hashed or used by lifecycle claims, transfers, and branch derivation.
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

export function topicGraphifyCacheDir(workUnit: RepositoryWorkUnit, dataDir: string = DATA_DIR): string {
  return path.join(topicStateDir(workUnit, dataDir), 'graphify-cache');
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
  const file = transferTombstonePath(source, repo, dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(tombstone, null, 2)}\n`, { mode: 0o600 });
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

function assertContainedNormalClone(repoPath: string, root: string): void {
  const gitDir = path.join(repoPath, '.git');
  const rootReal = fs.realpathSync(root);
  const repoStat = fs.lstatSync(repoPath);
  if (repoStat.isSymbolicLink() || !repoStat.isDirectory()) {
    throw new Error(`canonical repository entry is not a real directory: ${repoPath}`);
  }
  const repoReal = fs.realpathSync(repoPath);
  if (!repoReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error(`canonical repository escapes its workgroup namespace: ${repoPath}`);
  }
  let gitStat: fs.Stats;
  try {
    gitStat = fs.lstatSync(gitDir);
  } catch (error) {
    throw new Error(
      `canonical repository has missing or unreadable Git metadata: ${repoPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (gitStat.isSymbolicLink() || !gitStat.isDirectory()) {
    throw new Error(`canonical repository has invalid Git metadata: ${repoPath}`);
  }
  const bare = execFileSync('git', safeGitArgs(['-C', repoPath, 'rev-parse', '--is-bare-repository']), {
    encoding: 'utf8',
    env: safeGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  }).trim();
  if (bare !== 'false') throw new Error(`canonical repository is not a normal clone: ${repoPath}`);
}

export function discoverCanonicalRepositories(workgroupId: string, dataDir: string = DATA_DIR): CanonicalRepository[] {
  assertWorkgroupId(workgroupId);
  const workgroupRoot = path.join(repositoriesRoot(dataDir), workgroupId);
  try {
    const stat = fs.lstatSync(workgroupRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`canonical workgroup namespace is not a real directory: ${workgroupRoot}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries = fs.readdirSync(workgroupRoot, { withFileTypes: true });

  const repositories: CanonicalRepository[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    assertRepositoryName(entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`invalid entry in canonical repository namespace: ${path.join(workgroupRoot, entry.name)}`);
    }
    const repoPath = path.join(workgroupRoot, entry.name);
    assertContainedNormalClone(repoPath, workgroupRoot);
    repositories.push({
      name: entry.name,
      path: repoPath,
      gitDir: path.join(repoPath, '.git'),
      lockPath: ensureRepositoryLock(workgroupId, entry.name, dataDir),
      originPinPath: originPinPath(workgroupId, entry.name, dataDir),
    });
  }
  return repositories;
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
  return { origin: parsed.toString().replace(/\/+$/, ''), repositoryId: pin.repositoryId };
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
