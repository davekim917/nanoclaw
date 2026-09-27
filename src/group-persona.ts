import fs from 'fs';
import path from 'path';

import { log } from './log.js';

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === code;
}

/** Per-group standing instructions prepended to every provider's project document. */
export const STANDING_INSTRUCTIONS_FILE = 'standing-instructions.md';

/**
 * Create a group's standing instructions without following or replacing an
 * existing path. Returns false when the content is empty or the path exists.
 */
export function stageGroupPersona(groupDir: string, instructions: string): boolean {
  const content = instructions.trimEnd();
  if (!content.trim()) return false;

  fs.mkdirSync(groupDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(groupDir, STANDING_INSTRUCTIONS_FILE), `${content}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if (isErrno(err, 'EEXIST')) return false;
    throw err;
  }
}

/**
 * Read a group's standing instructions, following a symlink (siblings share one file) only when it resolves inside
 * `allowedRoots`: the group dir is agent-writable, so an unrestricted link would repoint its always-on prompt past
 * its trust boundary. Pass the group plus its WORKGROUP siblings, never the whole groups tree (another workgroup is
 * another tenant); the default is own-directory-only. Anything outside is treated as absent.
 */
export function readGroupPersona(groupDir: string, allowedRoots?: string[]): string | null {
  const file = path.join(groupDir, STANDING_INSTRUCTIONS_FILE);
  const roots = (allowedRoots?.length ? allowedRoots : [groupDir]).map((dir) => path.resolve(dir));
  let fd: number | undefined;
  try {
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (err) {
      // ELOOP is the only signal that the path is a symlink; an out-of-bounds target reads as absent, not an error.
      if (!isErrno(err, 'ELOOP')) throw err;
      const target = fs.realpathSync(file);
      const contained = roots.some((root) => target === root || target.startsWith(root + path.sep));
      if (!contained) {
        log.warn('Group standing instructions symlink escapes its workgroup; omitting persona', {
          file,
          target,
          roots,
        });
        return null;
      }
      // O_NOFOLLOW again closes the window between resolve and open.
      fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    }
    if (!fs.fstatSync(fd).isFile()) return null;
    const content = fs.readFileSync(fd, 'utf-8').trim();
    // Warn-only budget: every byte is re-read on every wake of every session in the group.
    const budget = Number(process.env.PERSONA_BUDGET_BYTES) || 24_000;
    if (content.length > budget) {
      log.warn('Group standing instructions exceed the persona byte budget', {
        file,
        bytes: content.length,
        budget,
        over: content.length - budget,
      });
    }
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
