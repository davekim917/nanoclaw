import fs from 'node:fs';
import path from 'node:path';

export interface BrokenDependencyLink {
  /** Absolute path of the symlink. */
  link: string;
  /** The link's raw target, as `readlink` reports it. */
  target: string;
  /** `escapes`: the target lies outside `<root>/node_modules`. `dangling`: the target does not exist. */
  reason: 'escapes' | 'dangling';
}

function inside(modulesDir: string, resolved: string): boolean {
  return resolved === modulesDir || resolved.startsWith(modulesDir + path.sep);
}

/**
 * Package links under `<root>/node_modules` (top level and one scope level) that leave that directory or point
 * at nothing, plus a `node_modules` that is itself a link. pnpm writes every package link relative to the
 * virtual store it resolved at install time, so a link that leaves the tree makes this checkout depend on
 * another one's install; a dangling link is what remains once that other install is deleted. Neither breaks a
 * process that already has its modules loaded, so the failure surfaces only at the next start.
 */
export function brokenDependencyLinks(root: string): BrokenDependencyLink[] {
  const modulesDir = path.join(root, 'node_modules');
  let top: fs.Stats;
  try {
    top = fs.lstatSync(modulesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (top.isSymbolicLink()) {
    const target = fs.readlinkSync(modulesDir);
    return [{ link: modulesDir, target, reason: fs.existsSync(modulesDir) ? 'escapes' : 'dangling' }];
  }

  const broken: BrokenDependencyLink[] = [];
  const inspect = (link: string): void => {
    const target = fs.readlinkSync(link);
    const resolved = path.resolve(path.dirname(link), target);
    if (!inside(modulesDir, resolved)) broken.push({ link, target, reason: 'escapes' });
    else if (!fs.existsSync(link)) broken.push({ link, target, reason: 'dangling' });
  };
  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    const entryPath = path.join(modulesDir, entry.name);
    if (entry.isSymbolicLink()) {
      inspect(entryPath);
    } else if (entry.isDirectory() && entry.name.startsWith('@')) {
      for (const scoped of fs.readdirSync(entryPath, { withFileTypes: true })) {
        if (scoped.isSymbolicLink()) inspect(path.join(entryPath, scoped.name));
      }
    }
  }
  return broken;
}

export function describeBrokenDependencyLink(root: string, broken: BrokenDependencyLink): string {
  return `${path.relative(root, broken.link)} -> ${broken.target} (${broken.reason})`;
}
