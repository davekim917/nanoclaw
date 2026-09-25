/**
 * Cross-process exclusive file locking, held by the kernel.
 *
 * Extracted from `withHostRepositoryLock` (repository-workspaces.ts), which was
 * the host's only cross-process mutual exclusion until `container.json` needed
 * one too. Two mechanisms for one job is how they drift, so there is one here
 * and both callers use it.
 *
 * WHY `flock(2)` AND NOT AN `O_EXCL` LOCK FILE. Node has no synchronous
 * `flock`, so an in-process lock file (`fs.openSync(p, 'wx')` plus a PID
 * staleness check, as `codex-sync-watcher.ts` does for its singleton guard)
 * is the tempting alternative and is wrong for data integrity:
 *
 *   - It LEAKS on `kill -9`. The kernel releases an flock when the holding fd
 *     closes, which includes every abnormal exit; an O_EXCL file survives, and
 *     the next writer is wedged until a person deletes it.
 *   - Its staleness check is unsound. "Is that PID alive" answers wrongly after
 *     PID recycling, and there is no way to tell a recycled PID from the
 *     original — so the repair for the leak above is itself a way to break the
 *     lock while a writer holds it.
 *
 * The cost is a `flock` child process per acquisition (~5ms). `flock` is
 * already a hard host prerequisite: `ncl`'s single-host ownership claim shells
 * out to it (`src/cli/socket-server.ts`, which fails setup with an install
 * hint when it is missing) and `container/build.sh` serializes rebuilds with
 * it. This adds no dependency.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Open `file` as a stable regular file, creating it if absent, and return the
 * fd. Refuses a symlink (`O_NOFOLLOW`) and anything that is not a regular file:
 * a lock whose path can be redirected is not a lock, and locking a FIFO blocks
 * forever rather than failing.
 */
function openStableRegularFile(file: string): { fd: number; created: boolean } {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd: number;
  let created = true;
  try {
    fd = fs.openSync(file, 'wx+', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    created = false;
    try {
      // READ-ONLY on the reopen. `flock(2)` needs an open fd, not write access,
      // so this is the weakest open that works and it removes one way to be
      // locked out of a lock another user created.
      //
      // HONEST LIMIT: it does not fix that case. The create mode is 0600
      // (above), so a lock created by root is unreadable to a non-root service
      // whatever open mode is used, and a root-created LOCK DIRECTORY (0700)
      // fails the `wx+` create for every group that has no lock yet. All this
      // branch buys is the message below instead of a bare EACCES. Nothing
      // documented tells an operator to `sudo` a host script, so the cure —
      // refusing to run as root, or relaxing the mode — is left until someone
      // actually hits it.
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (openError) {
      const code = (openError as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') {
        throw new Error(`Lock file must not be a symlink: ${file}`, { cause: openError });
      }
      if (code === 'EACCES' || code === 'EPERM') {
        throw new Error(
          `Lock file ${file} is not readable by this user — it was most likely created by another one ` +
            '(a `sudo` run of a host script). Remove it while nothing is writing, then retry.',
          { cause: openError },
        );
      }
      throw openError;
    }
  }
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    fs.closeSync(fd);
    throw new Error(`Lock path must be a regular file: ${file}`);
  }
  return { fd, created };
}

/** Create `file` if absent and return it, ready to be locked. */
export function ensureLockFile(file: string): string {
  const { fd, created } = openStableRegularFile(file);
  try {
    // Only on CREATE, and through the fd. A path-based `chmod` follows symlinks
    // and runs after the O_NOFOLLOW fd is closed, so it is a window in which
    // the path can be swapped for a symlink and this process talked into
    // chmodding another file it owns. On a file we did not create it also has
    // nothing to do but fail with EPERM against another user's lock.
    if (created) fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

export interface FileLockOptions {
  /** How long `flock` itself waits for the lock, in seconds. */
  waitSec?: number;
  /** Named in the timeout error, so a stuck lock says which one. */
  label?: string;
}

/**
 * Run `fn` holding an exclusive kernel lock on `lockFile`.
 *
 * The lock file is a SIDECAR, never the file being mutated. `flock` holds an
 * open file description, so any writer that ever replaces the data file by
 * rename would leave every holder locking an unlinked inode while the new one
 * goes unprotected — and locking the data file also means the lock's location
 * is dictated by the data's, which is wrong when the data lives somewhere a
 * container can reach (`containerConfigLockPath`, container-config.ts).
 *
 * The identity re-check after acquisition closes the same hole for the lock
 * file itself. Between `ensureLockFile` and the holder's own open, another
 * process can unlink and recreate the path; both would then "hold the lock" on
 * different inodes. Comparing dev/ino across the acquisition turns that into a
 * loud failure instead of two concurrent mutators.
 */
export async function withFileLock<T>(
  lockFile: string,
  fn: () => Promise<T> | T,
  options: FileLockOptions = {},
): Promise<T> {
  const waitSec = options.waitSec ?? 120;
  const label = options.label ?? lockFile;
  ensureLockFile(lockFile);
  const before = fs.lstatSync(lockFile);
  // `read _` parks the holder on stdin: the lock lives exactly as long as this
  // child, and closing its stdin in the `finally` below is what releases it.
  const holder = spawn('flock', ['-x', '-w', String(waitSec), lockFile, 'sh', '-c', 'printf ready; read _'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Every release path writes a newline to stdin. If the holder is already
  // gone (killed by a signal, or `flock` missing), that write surfaces as an
  // asynchronous EPIPE on the stream — with no listener it is an uncaught
  // exception in the HOST process, not a failed lock. Swallow it: a dead
  // holder has already released the lock, which is all the write was for.
  holder.stdin.on('error', () => {
    /* holder gone; lock already released */
  });

  await new Promise<void>((resolve, reject) => {
    let output = '';
    let stderr = '';
    // Give up on the holder COMPLETELY, not just on its parent. `flock` runs
    // `sh -c 'printf ready; read _'` as a child that inherits the locked fd, so
    // SIGTERM to the parent alone can leave that child parked on `read` holding
    // the lock for the life of this process — the exact case where the lock WAS
    // acquired inside the window but `ready` had not reached Node yet. Ending
    // stdin is what lets the child exit and the kernel drop the lock.
    const abandonHolder = (): void => {
      try {
        holder.stdin.end('\n');
      } catch {
        /* already closed */
      }
      holder.kill('SIGTERM');
    };
    const timeout = setTimeout(
      () => {
        abandonHolder();
        reject(new Error(`timed out acquiring lock for ${label}`));
      },
      (waitSec + 5) * 1000,
    );
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
      abandonHolder();
      reject(error);
    });
    holder.once('close', (code) => {
      if (!output.includes('ready')) {
        clearTimeout(timeout);
        reject(new Error(`failed to acquire lock for ${label} (${code}): ${stderr.trim()}`));
      }
    });
  });

  try {
    const after = fs.lstatSync(lockFile);
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error(`lock file identity changed for ${label}`);
    }
    return await fn();
  } finally {
    holder.stdin.end('\n');
    await new Promise<void>((resolve) => {
      // A holder killed by a signal has already closed with `exitCode === null`
      // and `signalCode` set; waiting for a second 'close' would never settle,
      // and on the spawn path that is a hung `ensureRuntimeFields`.
      if (holder.exitCode !== null || holder.signalCode !== null) return resolve();
      holder.once('close', () => resolve());
    });
  }
}
