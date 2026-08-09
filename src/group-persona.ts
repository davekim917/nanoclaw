import fs from 'fs';
import path from 'path';

import { log } from './log.js';

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === code;
}

/** Per-group standing instructions prepended to every provider's project document. */
export const PERSONA_PREPEND_FILE = 'instructions.prepend.md';

/**
 * Create a group's standing instructions without following or replacing an
 * existing path. Returns false when the content is empty or the path exists.
 */
export function stageGroupPersona(groupDir: string, instructions: string): boolean {
  const content = instructions.trimEnd();
  if (!content.trim()) return false;

  fs.mkdirSync(groupDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), `${content}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Read a group's standing instructions. Symlinks are followed ONLY when they
 * resolve inside the groups tree.
 *
 * Sibling agents that build together share one instruction set — the same
 * shape `CLAUDE.local.md` already uses, where the sibling's path is a symlink
 * to the source group's file. Sharing the file makes drift impossible rather
 * than merely detectable: a trio of siblings had silently diverged — two
 * running a stale revision of a rule, one missing five whole sections
 * including its QA-closure rules — because every edit landed on one copy.
 *
 * The containment check is the point. This file is inside the group directory,
 * which is mounted read-write into the container — an agent can create paths
 * here. An unrestricted symlink would therefore be a way to point its own
 * always-on prompt at content outside its trust boundary, which is source-level
 * self-modification without the approval flow that tier is supposed to have.
 * In-tree targets are already agent-reachable content, so following them grants
 * nothing new; anything resolving outside is refused and the persona omitted.
 */
export function readGroupPersona(groupDir: string, groupsRoot?: string): string | null {
  const file = path.join(groupDir, PERSONA_PREPEND_FILE);
  const root = path.resolve(groupsRoot ?? path.dirname(path.resolve(groupDir)));
  let fd: number | undefined;
  try {
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (err) {
      // ELOOP is the only signal that the path IS a symlink. Resolve it and
      // require containment before reading; a target outside the tree is
      // treated as absent, not as an error worth failing the spawn over.
      if (!isErrno(err, 'ELOOP')) throw err;
      const target = fs.realpathSync(file);
      const contained = target === root || target.startsWith(root + path.sep);
      if (!contained) {
        log.warn('Group standing instructions symlink escapes the groups tree; omitting persona', {
          file,
          target,
          root,
        });
        return null;
      }
      fd = fs.openSync(target, fs.constants.O_RDONLY);
    }
    if (!fs.fstatSync(fd).isFile()) return null;
    const content = fs.readFileSync(fd, 'utf-8').trim();
    return content || null;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return null;
    log.warn('Could not read group standing instructions; omitting persona', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
