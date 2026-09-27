import fs from 'fs';
import path from 'path';

/** Fails closed on any existing symlink or non-directory component below `parent`; missing descendants are fine. */
function isNonSymlinkDirectoryChain(parent: string, ...components: string[]): boolean {
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

/** Fails closed on a container-planted symlink where a previously container-writable directory was. */
export function assertRealDirectory(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe runtime directory (expected a real directory): ${dir}`);
  }
}

/**
 * Refuses any symlink in the chain. Callers must still revalidate the result immediately before Docker uses it
 * (the writable-tree TOCTOU window).
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

/** A symlink at the entry is unlinked, never traversed. */
export function removeUntrustedPathEntry(parent: string, entry: string): void {
  assertSinglePathEntry(entry);
  assertRealDirectory(parent);
  const target = path.join(parent, entry);
  if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

/** `wx`: a concurrent or unexpected replacement fails closed instead of being followed. */
export function replaceUntrustedFile(parent: string, entry: string, contents: string | Buffer): string {
  removeUntrustedPathEntry(parent, entry);
  const target = path.join(parent, entry);
  fs.writeFileSync(target, contents, { flag: 'wx' });
  return target;
}

export function replaceUntrustedDirectory(parent: string, entry: string): string {
  removeUntrustedPathEntry(parent, entry);
  const target = path.join(parent, entry);
  fs.mkdirSync(target);
  return target;
}
