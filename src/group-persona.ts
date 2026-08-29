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
 *
 * `allowedRoots` must be the group's own directory plus its WORKGROUP siblings
 * — never the whole groups tree. A workgroup is the data-pool boundary and a
 * container mounts only its own group directory, so a sibling in a *different*
 * workgroup is not already-reachable content: following a link there would
 * inject another tenant's `CLAUDE.local.md` or memory into this prompt. The
 * default is own-directory-only so a caller that forgets the set fails closed.
 * Anything resolving outside is refused and the persona omitted.
 */
export function readGroupPersona(groupDir: string, allowedRoots?: string[]): string | null {
  const file = path.join(groupDir, PERSONA_PREPEND_FILE);
  const roots = (allowedRoots?.length ? allowedRoots : [groupDir]).map((dir) => path.resolve(dir));
  let fd: number | undefined;
  try {
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (err) {
      // ELOOP is the only signal that the path IS a symlink. Resolve it and
      // require containment before reading; a target outside the allowed set
      // is treated as absent, not an error worth failing the spawn over.
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
      // O_NOFOLLOW again: `target` is a realpath so it is not itself a link,
      // and re-asserting that closes the window between resolve and open.
      fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    }
    if (!fs.fstatSync(fd).isFile()) return null;
    const content = fs.readFileSync(fd, 'utf-8').trim();
    // Instruction-surface budget (warn-only). Every byte here is re-read on
    // every wake of every session in the group; policy that can be a tool, a
    // check, or a script-emitted field should not live in the always-on
    // prompt. Over budget = convert a sentence, not grow the prompt. Stays a
    // log line until the fleet is under; a write refusal can ratchet later.
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
