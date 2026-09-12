/**
 * The self-referential `commondir` sentinel every workgroup canonical `.git` carries (#669).
 *
 * Git honours a `commondir` file in any git dir, not only in a linked
 * worktree's admin dir, and then reads refs, objects and config from the
 * directory it names. A canonical's `.git` is mounted read-write into every
 * topic container at its exact host path (container-runner.ts:4536), so a
 * container could otherwise create one and point host Git at another
 * workgroup's repository.
 *
 * A `commondir` holding "." resolves the common dir to the git dir itself:
 * get_common_dir_noenv (git 2.43 setup.c) appends the relative content to the
 * git dir and real-paths the result, and reads only that one level, so a
 * linked worktree's own `commondir` ("../..") still lands on the canonical
 * `.git` (both measured on git 2.43.0 in a scratch repository). An EMPTY file
 * is fatal to every Git command there ("failed to read .../commondir"), which
 * is why the content is ".", never "".
 *
 * The host creates the sentinel and bind-mounts it read-only over its own
 * path (container-runner.ts:1542), so a container can neither rewrite nor
 * replace it.
 */
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { safeGitArgs, safeGitEnv } from './safe-git.js';

/** The exact bytes of the sentinel. Anything else in a canonical `commondir` is foreign. */
export const CANONICAL_COMMONDIR_SENTINEL = '.\n';

export type CanonicalCommondirState = 'absent' | 'sentinel' | 'foreign';

/** `<gitDir>/commondir`. */
export function canonicalCommondirPath(gitDir: string): string {
  return path.join(gitDir, 'commondir');
}

/**
 * What `<gitDir>/commondir` is: absent, exactly the sentinel, or anything else
 * (other content, a symlink, a directory, a FIFO) as `foreign`. Throws only on
 * an unexpected I/O fault, which every caller treats as a refusal.
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
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== expected.length) return 'foreign';
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
    if (!fs.fstatSync(fd).isFile()) return 'foreign';
    const buffer = Buffer.alloc(expected.length + 1);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return read === expected.length && buffer.subarray(0, read).equals(expected) ? 'sentinel' : 'foreign';
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Leave `<gitDir>/commondir` as exactly the sentinel, creating it when absent,
 * and return the state it ends in. Never overwrites: an existing file is
 * reported as it is, so a foreign one comes back `foreign` for the caller to
 * refuse.
 *
 * The create is atomic and no-replace. The content is written and fsynced in
 * a temporary file, then hard-linked into place: link(2) fails with EEXIST
 * where rename(2) would silently replace a file a container created in the
 * same moment, and a Git process never sees a partial or empty file, which it
 * treats as fatal.
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
    const dirFd = fs.openSync(gitDir, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Never created.
    }
  }
  return readCanonicalCommondir(gitDir);
}

/**
 * Does Git itself resolve `gitDir`'s common dir to `expectedCommonDir`?
 *
 * Asked with `--git-dir`, so no discovery walk is involved, and through
 * safeGitEnv, which builds the environment from scratch (safe-git.ts:29-43),
 * so an inherited GIT_DIR or GIT_COMMON_DIR cannot answer for the repository.
 * Both sides are real-pathed. Any failure answers false.
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
