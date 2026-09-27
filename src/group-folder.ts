import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  // Exact segment, not a prefix test: `..legacy` never leaves baseDir, and groupFolderExistsOnDisk must see it.
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

/**
 * True when `groups/<folder>` is present on disk in any form — directory,
 * file, or symlink, empty or not.
 *
 * Confinement-only on purpose: this deliberately does NOT go through
 * assertValidGroupFolder/isValidGroupFolder. Occupancy must be probed for
 * names the current grammar refuses too — a legacy folder minted before the
 * grammar tightened still occupies its name, and refusing to look would let
 * a create mint a new identity over its data.
 */
export function groupFolderExistsOnDisk(folder: string): boolean {
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  // A base-directory alias (`.`, `x/..`) resolves to GROUPS_DIR itself, which is not residue.
  if (path.relative(GROUPS_DIR, groupPath) === '') {
    throw new Error(`Invalid group folder "${folder}": names the groups directory itself`);
  }
  // lstat, not existsSync: existsSync follows symlinks, so a dangling symlink
  // at groups/<folder> would read as absent even though it occupies the name
  // (mkdir would fail on it). lstat probes the entry itself.
  try {
    fs.lstatSync(groupPath);
    return true;
  } catch (err) {
    // Only ENOENT means absent; any other failure (ENOTDIR included) means the probe failed, so fail closed.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
