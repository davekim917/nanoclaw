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
