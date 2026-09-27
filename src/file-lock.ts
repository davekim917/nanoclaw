/**
 * Cross-process exclusive file locking via `flock(2)`, never an O_EXCL lock file: the kernel releases an flock on
 * any exit (including `kill -9`), while an O_EXCL file leaks, and its PID staleness check is unsound under PID
 * recycling. Costs one `flock` child per acquisition; `flock` is already a host prerequisite.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/** Refuses a symlink and non-regular files: a redirectable lock is no lock, and locking a FIFO blocks forever. */
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
      // Read-only reopen: flock needs an fd, not write access. A lock created by another user (e.g. root) is still
      // unreadable under mode 0600; this only turns that into the message below instead of a bare EACCES.
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
    // Only on create, and via the fd: a path-based chmod after the O_NOFOLLOW fd closes could be redirected by a
    // swapped-in symlink.
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
 * Run `fn` holding an exclusive kernel lock on `lockFile`, which must be a SIDECAR, never the mutated file: a writer
 * that replaces the data file by rename would leave holders locking an unlinked inode. The dev/ino re-check after
 * acquisition makes a lock file unlinked and recreated mid-acquire fail loudly instead of admitting two mutators.
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
  // `read _` parks the holder on stdin: closing stdin in the `finally` releases the lock.
  const holder = spawn('flock', ['-x', '-w', String(waitSec), lockFile, 'sh', '-c', 'printf ready; read _'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Writing to a dead holder's stdin raises an async EPIPE that would be uncaught in the host; the lock is already
  // released.
  holder.stdin.on('error', () => {
    /* holder gone; lock already released */
  });

  await new Promise<void>((resolve, reject) => {
    let output = '';
    let stderr = '';
    // `flock`'s `sh` child inherits the locked fd, so killing the parent alone can leave it holding the lock (acquired
    // but `ready` not yet read); ending stdin lets it exit.
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
      // A signal-killed holder already closed; waiting for another 'close' would hang forever.
      if (holder.exitCode !== null || holder.signalCode !== null) return resolve();
      holder.once('close', () => resolve());
    });
  }
}
