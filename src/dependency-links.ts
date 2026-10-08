import fs from 'node:fs';
import path from 'node:path';

import { isWithinResolvedRoot, resolveRealPath } from './plugin-skill-discovery.js';

export interface BrokenDependencyLink {
  /** Absolute path of the symlink. */
  link: string;
  /** The link's raw target, as `readlink` reports it. */
  target: string;
  /** `escapes`: the link resolves outside `<root>/node_modules`. `dangling`: it resolves to nothing. */
  reason: 'escapes' | 'dangling';
}

/**
 * Package links under `<root>/node_modules` (top level and one scope level) that resolve outside that directory
 * or to nothing, plus a `node_modules` that is itself a link. pnpm writes every package link relative to the
 * virtual store it resolved at install time, so a link that leaves the tree makes this checkout depend on
 * another one's install; a dangling link is what remains once that other install is deleted. Links are
 * resolved physically, since a `.pnpm` entry can itself be a link out of the tree. Neither breaks a process
 * that already has its modules loaded, so the failure surfaces only at the next start.
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
    return [{ link: modulesDir, target, reason: resolveRealPath(modulesDir) === null ? 'dangling' : 'escapes' }];
  }

  const resolvedModules = fs.realpathSync(modulesDir);
  const broken: BrokenDependencyLink[] = [];
  const inspect = (link: string): void => {
    const target = fs.readlinkSync(link);
    const resolved = resolveRealPath(link);
    if (resolved === null) broken.push({ link, target, reason: 'dangling' });
    else if (!isWithinResolvedRoot(resolved, resolvedModules)) broken.push({ link, target, reason: 'escapes' });
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
