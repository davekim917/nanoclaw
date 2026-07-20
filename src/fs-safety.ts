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
