import fs from 'fs';
import path from 'path';

/**
 * Fail closed when any existing component below `parent` is a symlink or is
 * not a directory. Missing descendants are safe for a later mkdir operation.
 */
export function isNonSymlinkDirectoryChain(parent: string, ...components: string[]): boolean {
  let parentStat: fs.Stats;
  try {
    parentStat = fs.lstatSync(parent);
  } catch {
    return false;
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) return false;

  let current = parent;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    } catch {
      return true;
    }
  }
  return true;
}

function assertSinglePathEntry(entry: string): void {
  if (!entry || entry === '.' || entry === '..' || path.basename(entry) !== entry) {
    throw new Error(`Expected one path entry, got: ${entry}`);
  }
}

/**
 * Assert that a host directory which was previously writable by a container is
 * still a real directory. Host reconciliation must fail closed rather than
 * following a container-planted symlink on the next spawn.
 */
export function assertRealDirectory(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe runtime directory (expected a real directory): ${dir}`);
  }
}

/**
 * Resolve a host directory below an agent-writable root without accepting any
 * symlink in the relative chain. The returned canonical path is suitable for a
 * bind source; callers must still revalidate it immediately before Docker uses
 * the pathname to close the remaining writable-tree TOCTOU window.
 */
export function resolveContainedRealDirectory(parent: string, ...components: string[]): string {
  if (!isNonSymlinkDirectoryChain(parent, ...components)) {
    throw new Error(
      `Unsafe contained directory (expected a non-symlink directory chain): ${path.join(parent, ...components)}`,
    );
  }

  const parentReal = fs.realpathSync(parent);
  const candidate = path.join(parent, ...components);
  assertRealDirectory(candidate);
  const candidateReal = fs.realpathSync(candidate);
  const relative = path.relative(parentReal, candidateReal);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe contained directory (path escapes root): ${candidate}`);
  }
  return candidateReal;
}

/**
 * Remove exactly one entry from a real parent directory. A symlink at the
 * entry itself is unlinked; it is never traversed.
 */
export function removeUntrustedPathEntry(parent: string, entry: string): void {
  assertSinglePathEntry(entry);
  assertRealDirectory(parent);
  const target = path.join(parent, entry);
  if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Replace a container-writable entry with a fresh regular file. `wx` makes a
 * concurrent or unexpected replacement fail closed instead of following it.
 */
export function replaceUntrustedFile(parent: string, entry: string, contents: string | Buffer): string {
  removeUntrustedPathEntry(parent, entry);
  const target = path.join(parent, entry);
  fs.writeFileSync(target, contents, { flag: 'wx' });
  return target;
}

/** Replace a container-writable entry with a fresh real directory. */
export function replaceUntrustedDirectory(parent: string, entry: string): string {
  removeUntrustedPathEntry(parent, entry);
  const target = path.join(parent, entry);
  fs.mkdirSync(target);
  return target;
}
