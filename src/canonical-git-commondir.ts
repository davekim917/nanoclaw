/**
 * The self-referential `commondir` sentinel every workgroup canonical `.git` carries. Git honours `commondir` in any
 * git dir, and a canonical's `.git` is mounted read-write into topic containers, so a container could otherwise
 * point host Git at another workgroup's repository. "." resolves to the git dir itself while a linked worktree's
 * "../.." still lands on the canonical; an EMPTY file is fatal to every Git command, hence ".", never "". The host
 * bind-mounts the sentinel read-only over its own path.
 */
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { safeGitArgs, safeGitEnv } from './safe-git.js';

/** The exact bytes of the sentinel. Anything else in a canonical `commondir` is foreign. */
const CANONICAL_COMMONDIR_SENTINEL = '.\n';

export type CanonicalCommondirState = 'absent' | 'sentinel' | 'foreign';

export function canonicalCommondirPath(gitDir: string): string {
  return path.join(gitDir, 'commondir');
}

/**
 * Absent, exactly the sentinel, or `foreign` (other content, symlink, dir, FIFO, second hard link). Throws only on
 * an unexpected I/O fault. nlink must be 1: the read-only overlay protects the name, not the inode, so an alias
 * made before the overlay (or while staging a clone) stays writable; it is refused, never removed. The type checks
 * are deliberately redundant: a symlink with a two-byte target passes the size check (container-runner.test.ts).
 */
export function readCanonicalCommondir(gitDir: string): CanonicalCommondirState {
  const file = canonicalCommondirPath(gitDir);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
  const expected = Buffer.from(CANONICAL_COMMONDIR_SENTINEL);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size !== expected.length) return 'foreign';
  // O_NOFOLLOW refuses a symlink swapped in after the lstat; O_NONBLOCK keeps a
  // FIFO swapped in from blocking the host on open.
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'absent';
    if (code === 'ELOOP') return 'foreign';
    throw error;
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) return 'foreign';
    const buffer = Buffer.alloc(expected.length + 1);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return read === expected.length && buffer.subarray(0, read).equals(expected) ? 'sentinel' : 'foreign';
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Leave `<gitDir>/commondir` as exactly the sentinel, creating it when absent; never overwrites, so a foreign file
 * comes back `foreign`. Created by fsynced temp file plus link(2), which fails with EEXIST where rename would
 * replace a container's file, and Git never sees a partial file. Must stay synchronous: between link and unlink
 * the sentinel has two names, and only the one event loop keeps other host spawns out of that gap; a container
 * linking the temp name there leaves nlink 2, which the final read refuses.
 */
export function ensureCanonicalCommondirSentinel(gitDir: string): CanonicalCommondirState {
  const existing = readCanonicalCommondir(gitDir);
  if (existing !== 'absent') return existing;
  const file = canonicalCommondirPath(gitDir);
  const temp = path.join(gitDir, `commondir.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    // Readable by the container's Git whatever uid it runs as; the content is not secret.
    fs.writeFileSync(temp, CANONICAL_COMMONDIR_SENTINEL, { flag: 'wx', mode: 0o644 });
    const fd = fs.openSync(temp, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(temp, file);
    } catch (error) {
      // Someone else created it first: judge what is there now, below.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Never created.
    }
  }
  // After the unlink, so the directory entry that persists is the one-name sentinel.
  const dirFd = fs.openSync(gitDir, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
  return readCanonicalCommondir(gitDir);
}

/**
 * Does Git itself resolve `gitDir`'s common dir to `expectedCommonDir`? Uses `--git-dir` and safeGitEnv so no
 * discovery walk or inherited GIT_DIR/GIT_COMMON_DIR answers; any failure answers false.
 */
export function gitCommonDirIs(gitDir: string, expectedCommonDir: string): boolean {
  try {
    const common = execFileSync(
      'git',
      safeGitArgs([`--git-dir=${gitDir}`, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
      { cwd: gitDir, env: safeGitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
    ).trim();
    return common !== '' && fs.realpathSync(common) === fs.realpathSync(expectedCommonDir);
  } catch {
    return false;
  }
}

/** Thrown by canonicalGitControlMounts when a canonical's `commondir` is not, and cannot be made, the sentinel. */
export class ForeignCanonicalCommondirError extends Error {
  constructor(
    readonly path: string,
    readonly state: CanonicalCommondirState,
  ) {
    super(`Canonical repository .git holds a commondir that is not the sentinel: ${path}`);
    this.name = 'ForeignCanonicalCommondirError';
  }
}
