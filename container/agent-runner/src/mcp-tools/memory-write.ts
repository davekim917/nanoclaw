import { dlopen } from 'bun:ffi';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const DEFAULT_MEMORY_ROOT = '/workspace/workgroup/memory';
const GENERATED_MEMORY_RELATIVE_PATH = 'generated/memory.md';
const DEFAULT_LOCK_WAIT_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 15;
const WORKGROUP_LOCK_LEAF = '.memory-write.lock';
const ABANDONED_TEMP_PATTERN = /^\.memory-write-\d+-[a-f0-9]{32}\.tmp$/;
const LOCK_EX_NB = 2 | 4;
const LOCK_UN = 8;

const libc = dlopen('libc.so.6', {
  flock: {
    args: ['i32', 'i32'],
    returns: 'i32',
  },
});

export interface MemoryWriteInput {
  relative_path: string;
  content: string;
  expected_sha256: string | null;
}

export type MemoryWriteResult =
  | { status: 'success'; relative_path: string; sha256: string }
  | { status: 'conflict' | 'error'; relative_path: string; error: string };

export interface MemoryWriteOptions {
  rootDir?: string;
  lockWaitMs?: number;
  retryDelayMs?: number;
  beforeRename?: () => void | Promise<void>;
  beforeAtomicRename?: () => void;
  /** Host curator only. Container paths fail the canonical-host-root check. */
  allowGeneratedMemory?: boolean;
}

interface LockRecord {
  owner: string;
  acquiredAt: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface ResolvedMemoryPath {
  workgroup: string;
  workgroupIdentity: FileIdentity;
  root: string;
  rootIdentity: FileIdentity;
  parent: string;
  parentIdentity: FileIdentity;
  target: string;
  relativePath: string;
}

interface DirectoryAnchor {
  fd: number;
  procPath: string;
}

interface KernelLock {
  fd: number;
  identity: FileIdentity;
  owner: string;
  path: string;
}

class MemoryConflictError extends Error {}

export function sha256Text(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * The lock is deliberately workgroup-wide rather than per memory path. Memory
 * writes are rare, and one stable inode gives every sibling container the same
 * kernel-owned serialization point without putting coordination bytes in the
 * canonical memory tree.
 */
export function memoryLockPath(_target: string, rootDir = path.dirname(_target)): string {
  return path.join(path.dirname(rootDir), WORKGROUP_LOCK_LEAF);
}

function ownerToken(): string {
  return `${Date.now()}-${randomBytes(16).toString('hex')}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function identityFromStat(stat: fs.Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(actual: FileIdentity, expected: FileIdentity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function assertOrdinaryFileOrMissing(filePath: string, label: string): void {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

function identityOf(filePath: string): FileIdentity {
  return identityFromStat(fs.lstatSync(filePath));
}

function openDirectoryAnchor(directory: string, expected: FileIdentity, label: string): DirectoryAnchor {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory() || !sameIdentity(identityFromStat(stat), expected)) {
      throw new Error(`${label} directory identity changed`);
    }
    const procPath = `/proc/self/fd/${fd}`;
    if (!fs.statSync(procPath).isDirectory()) throw new Error(`${label} directory anchor is unavailable`);
    return { fd, procPath };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

function resolveMemoryPath(relativePath: string, rootDir: string): ResolvedMemoryPath {
  if (!relativePath || relativePath.includes('\0')) throw new Error('relative_path is required');
  if (path.isAbsolute(relativePath)) throw new Error('relative_path must be relative');
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => segment === '..')) throw new Error('relative_path must not contain traversal');
  if (path.extname(relativePath) !== '.md') throw new Error('relative_path must end in .md');

  let root: string;
  try {
    root = fs.realpathSync(rootDir);
  } catch {
    throw new Error('memory root is unavailable');
  }
  const rootIdentity = identityOf(root);
  const workgroup = path.dirname(root);
  const workgroupIdentity = identityOf(workgroup);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('relative_path escapes the memory root');

  const parent = path.dirname(target);
  let realParent: string;
  try {
    realParent = fs.realpathSync(parent);
  } catch {
    throw new Error('relative_path parent directory does not exist');
  }
  const parentIdentity = identityOf(parent);
  if (realParent !== root && !realParent.startsWith(`${root}${path.sep}`)) {
    throw new Error('relative_path parent escapes the memory root');
  }

  // realpath(parent) catches symlink escapes, but even an in-root symlink is
  // rejected: memory writes resolve through ordinary directories only.
  let cursor = root;
  for (const segment of path.relative(root, parent).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('relative_path must not traverse symlinks');
  }
  assertOrdinaryFileOrMissing(target, 'memory file');

  return {
    workgroup,
    workgroupIdentity,
    root,
    rootIdentity,
    parent,
    parentIdentity,
    target,
    relativePath,
  };
}

function openStableLock(lockPath: string): { fd: number; identity: FileIdentity } {
  let fd: number;
  try {
    const existing = fs.lstatSync(lockPath);
    if (existing.isSymbolicLink()) throw new Error('memory lock must not be a symlink');
    if (!existing.isFile()) throw new Error('memory lock must be a regular file');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  try {
    // The first creator uses create-only semantics. All later writers open the
    // same inode without following links; the file is intentionally retained.
    fd = fs.openSync(lockPath, 'wx+', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    try {
      fd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    } catch (openErr) {
      if ((openErr as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new Error('memory lock must not be a symlink');
      }
      throw openErr;
    }
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('memory lock must be a regular file');
    return { fd, identity: identityFromStat(stat) };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

function assertStableLockIdentity(lock: KernelLock): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lock.path);
  } catch {
    throw new Error('memory lock identity changed');
  }
  if (stat.isSymbolicLink()) throw new Error('memory lock must not be a symlink');
  if (!stat.isFile()) throw new Error('memory lock must be a regular file');
  if (!sameIdentity(identityFromStat(stat), lock.identity)) throw new Error('memory lock identity changed');
}

async function acquireMemoryLock(
  workgroupAnchor: DirectoryAnchor,
  waitMs: number,
  retryDelayMs: number,
): Promise<KernelLock> {
  const lockPath = path.join(workgroupAnchor.procPath, WORKGROUP_LOCK_LEAF);
  const opened = openStableLock(lockPath);
  const owner = ownerToken();
  const deadline = Date.now() + Math.max(0, waitMs);

  try {
    while (true) {
      if (libc.symbols.flock(opened.fd, LOCK_EX_NB) === 0) break;
      if (Date.now() >= deadline) throw new Error('timed out acquiring memory file lock');
      await delay(Math.max(1, Math.min(retryDelayMs, deadline - Date.now())));
    }

    const lock: KernelLock = {
      fd: opened.fd,
      identity: opened.identity,
      owner,
      path: lockPath,
    };
    assertStableLockIdentity(lock);
    const record: LockRecord = { owner, acquiredAt: Date.now() };
    fs.ftruncateSync(opened.fd, 0);
    fs.writeSync(opened.fd, JSON.stringify(record), 0, 'utf8');
    fs.fsyncSync(opened.fd);
    return lock;
  } catch (err) {
    fs.closeSync(opened.fd);
    throw err;
  }
}

function releaseMemoryLock(lock: KernelLock): void {
  try {
    libc.symbols.flock(lock.fd, LOCK_UN);
  } finally {
    fs.closeSync(lock.fd);
  }
}

function cleanupAbandonedTemps(rootAnchor: DirectoryAnchor): void {
  let removed = false;
  for (const entry of fs.readdirSync(rootAnchor.procPath, { withFileTypes: true })) {
    if (!ABANDONED_TEMP_PATTERN.test(entry.name)) continue;
    const tempPath = path.join(rootAnchor.procPath, entry.name);
    const stat = fs.lstatSync(tempPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('memory temp must be a regular file');
    }
    fs.unlinkSync(tempPath);
    removed = true;
  }
  if (removed) fs.fsyncSync(rootAnchor.fd);
}

function currentHash(target: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('memory file must not be a symlink');
    }
    throw err;
  }

  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('memory file must be a regular file');
    return createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function assertExpectedState(target: string, expected: string | null): void {
  const actual = currentHash(target);
  if (expected === null) {
    if (actual !== null) throw new MemoryConflictError('create-only path already exists');
    return;
  }
  if (actual === null) throw new MemoryConflictError('expected file does not exist');
  if (actual !== expected) throw new MemoryConflictError('expected_sha256 does not match the current file');
}

export async function writeMemoryFile(
  input: MemoryWriteInput,
  options: MemoryWriteOptions = {},
): Promise<MemoryWriteResult> {
  const relativePath = typeof input.relative_path === 'string' ? input.relative_path : '';
  let resolved: ResolvedMemoryPath;
  try {
    if (typeof input.content !== 'string') throw new Error('content must be a string');
    if (relativePath === GENERATED_MEMORY_RELATIVE_PATH) {
      if (!options.allowGeneratedMemory) throw new Error('generated/memory.md is reserved for the host curator');
      const moduleRepoRoot = path.resolve(import.meta.dir, '../../../..');
      const canonicalHostRoot = path.join(moduleRepoRoot, 'data', 'workgroups');
      const requestedRoot = path.resolve(options.rootDir ?? DEFAULT_MEMORY_ROOT);
      if (!requestedRoot.startsWith(`${canonicalHostRoot}${path.sep}`)) {
        throw new Error('generated/memory.md requires a canonical host workgroup root');
      }
    }
    if (
      input.expected_sha256 !== null &&
      (typeof input.expected_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_sha256))
    ) {
      throw new Error('expected_sha256 must be null or a lowercase SHA-256 hex digest');
    }
    resolved = resolveMemoryPath(relativePath, options.rootDir ?? DEFAULT_MEMORY_ROOT);
  } catch (err) {
    return {
      status: 'error',
      relative_path: relativePath,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let workgroupAnchor: DirectoryAnchor | null = null;
  let rootAnchor: DirectoryAnchor | null = null;
  let parentAnchor: DirectoryAnchor | null = null;
  let lock: KernelLock | null = null;
  let tmpPath: string | null = null;
  try {
    workgroupAnchor = openDirectoryAnchor(resolved.workgroup, resolved.workgroupIdentity, 'workgroup');
    rootAnchor = openDirectoryAnchor(resolved.root, resolved.rootIdentity, 'memory root');
    parentAnchor = openDirectoryAnchor(resolved.parent, resolved.parentIdentity, 'memory parent');
    lock = await acquireMemoryLock(
      workgroupAnchor,
      options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
      options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    );
    assertStableLockIdentity(lock);
    cleanupAbandonedTemps(rootAnchor);

    const anchoredTarget = path.join(parentAnchor.procPath, path.basename(resolved.target));
    assertOrdinaryFileOrMissing(anchoredTarget, 'memory file');
    assertExpectedState(anchoredTarget, input.expected_sha256);

    tmpPath = path.join(rootAnchor.procPath, `.memory-write-${lock.owner}.tmp`);
    const fd = fs.openSync(tmpPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, input.content, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    await options.beforeRename?.();
    assertStableLockIdentity(lock);
    assertOrdinaryFileOrMissing(anchoredTarget, 'memory file');
    assertExpectedState(anchoredTarget, input.expected_sha256);
    // Test-only race seam: source and destination remain anchored to open
    // directory descriptors, so replacing string-path ancestors cannot redirect
    // the atomic rename outside the canonical filesystem objects.
    options.beforeAtomicRename?.();
    assertStableLockIdentity(lock);
    fs.renameSync(tmpPath, anchoredTarget);
    tmpPath = null;
    fs.fsyncSync(parentAnchor.fd);

    return {
      status: 'success',
      relative_path: relativePath,
      sha256: sha256Text(input.content),
    };
  } catch (err) {
    return {
      status: err instanceof MemoryConflictError ? 'conflict' : 'error',
      relative_path: relativePath,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Temp may not have been created or may already be gone.
      }
    }
    if (lock) releaseMemoryLock(lock);
    if (parentAnchor) fs.closeSync(parentAnchor.fd);
    if (rootAnchor) fs.closeSync(rootAnchor.fd);
    if (workgroupAnchor) fs.closeSync(workgroupAnchor.fd);
  }
}

export const writeMemoryFileTool: McpToolDefinition = {
  tool: {
    name: 'write_memory_file',
    description:
      'Atomically create or update one Markdown file beneath /workspace/workgroup/memory. Pass null expected_sha256 for create-only; pass the current lowercase SHA-256 digest for an update.',
    inputSchema: {
      type: 'object',
      properties: {
        relative_path: { type: 'string', description: 'Relative .md path beneath the workgroup memory root.' },
        content: { type: 'string', description: 'Complete UTF-8 Markdown file content.' },
        expected_sha256: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
          description: 'Current lowercase SHA-256 digest, or null for a unique create-only path.',
        },
      },
      required: ['relative_path', 'content', 'expected_sha256'],
      additionalProperties: false,
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const result = await writeMemoryFile({
      relative_path: typeof args.relative_path === 'string' ? args.relative_path : '',
      content: typeof args.content === 'string' ? args.content : (args.content as never),
      expected_sha256:
        args.expected_sha256 === null || typeof args.expected_sha256 === 'string'
          ? args.expected_sha256
          : (args.expected_sha256 as never),
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      ...(result.status === 'error' ? { isError: true } : {}),
    };
  },
};

registerTools([writeMemoryFileTool]);
