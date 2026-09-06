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
  // Exact-segment check, not a prefix test: `rel.startsWith('..')` would also
  // reject a same-level entry whose name merely starts with the two
  // characters "..", e.g. `baseDir/..legacy` (rel === '..legacy'). That is
  // not an escape — it never leaves baseDir — so only `rel === '..'` or
  // `rel` starting with `..` + the path separator (a real parent-then-descend)
  // counts. This function is private to this module; both callers below are
  // covered by the fix. resolveGroupFolderPath is unaffected in practice
  // (assertValidGroupFolder's charset excludes '.' entirely, so it can never
  // pass a name that would have hit the old bug), but groupFolderExistsOnDisk
  // deliberately probes names the grammar refuses too, so a legacy directory
  // like `..legacy` must read as present rather than throw.
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
  // A base-directory alias (`.`, `x/..`, `./`) resolves to GROUPS_DIR itself,
  // which always exists — reporting it as occupied residue would tell the
  // operator to move or remove every group's workspace (Codex on #486).
  if (path.relative(GROUPS_DIR, groupPath) === '') {
    throw new Error(`Invalid group folder "${folder}": names the groups directory itself`);
  }
  // lstat, not existsSync: existsSync follows symlinks, so a dangling
  // symlink at groups/<folder> would read as absent even though it occupies
  // the name (mkdir would fail on it with EEXIST). lstat probes the entry
  // itself, so a dangling symlink still counts as present.
  try {
    fs.lstatSync(groupPath);
    return true;
  } catch (err) {
    // ENOENT is a real "not there" answer. Anything else — EACCES, EIO, a
    // broken GROUPS_DIR — means the probe itself failed, not that the name
    // is free; reporting that as absent would let a caller allocate or
    // adopt a name it never actually verified. ENOTDIR is deliberately NOT
    // folded in here: it means a path component (potentially GROUPS_DIR
    // itself) isn't a directory, which is an environment fault, not
    // "folder absent" — fail closed on it too. Rethrow everything but ENOENT.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
