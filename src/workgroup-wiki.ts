/**
 * A workgroup's domain wiki at `data/wikis/<workgroup-id>/` (kept current by install config; trunk never clones or
 * refreshes it), mounted read-only at `/workspace/wiki` for every sibling whatever its provider, plus a composed-doc
 * section. No directory, no mount, no section. A symlink or non-directory at that path is refused, not followed.
 * The workgroup id must be the spawn-resolved one, never agent input: the resolver checks slug syntax, not
 * authorization, so another workgroup's valid slug would pass.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';
import type { VolumeMount } from './providers/provider-container-registry.js';

export const WORKGROUP_WIKI_CONTAINER_PATH = '/workspace/wiki';

// Letters, digits and hyphens only, so no id can climb out of data/wikis/.
const WORKGROUP_ID_RE = /^[a-z][a-z0-9-]*$/;

export interface WorkgroupWiki {
  mount: VolumeMount;
  hasIndex: boolean;
}

export function workgroupWikiHostPath(workgroupId: string): string {
  return path.join(DATA_DIR, 'wikis', workgroupId);
}

/** With `workspaceHostRoot`, the wiki is skipped if a non-directory already sits at its `wiki` mountpoint. */
export function resolveWorkgroupWiki(
  workgroupId: string | null | undefined,
  workspaceHostRoot?: string,
): WorkgroupWiki | null {
  if (!workgroupId || !WORKGROUP_ID_RE.test(workgroupId)) return null;
  const hostPath = workgroupWikiHostPath(workgroupId);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(hostPath);
    // eslint-disable-next-line no-catch-all/no-catch-all -- an optional read-only mount must never block a spawn; not mounting is the fail-closed outcome.
  } catch (err) {
    // ENOENT is the common case: this workgroup keeps no wiki.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Workgroup wiki path is unreadable; not mounting it', { workgroupId, hostPath, err: String(err) });
    }
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    log.warn('Workgroup wiki path is not a plain directory; not mounting it', { workgroupId, hostPath });
    return null;
  }
  if (workspaceHostRoot && mountpointBlocked(path.join(workspaceHostRoot, 'wiki'))) {
    log.warn('Something other than a directory sits at the /workspace/wiki mountpoint; not mounting the wiki', {
      workgroupId,
      mountpoint: path.join(workspaceHostRoot, 'wiki'),
    });
    return null;
  }
  return {
    mount: { hostPath, containerPath: WORKGROUP_WIKI_CONTAINER_PATH, readonly: true },
    hasIndex: fs.existsSync(path.join(hostPath, 'index.md')),
  };
}

/**
 * A pre-wiki session can leave a file or symlink at `/workspace/wiki`; the mountpoint-stub loop keeps it, and Docker
 * then fails a directory bind onto it on every spawn. Skipping the optional wiki keeps the spawn alive.
 */
function mountpointBlocked(mountpoint: string): boolean {
  try {
    const stat = fs.lstatSync(mountpoint);
    return stat.isSymbolicLink() || !stat.isDirectory();
    // eslint-disable-next-line no-catch-all/no-catch-all -- absent is the normal case (the stub loop creates it); any other failure means the mountpoint can't be vouched for, so the optional mount is skipped.
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export function workgroupWikiInstructions(wiki: WorkgroupWiki | null): string | null {
  if (!wiki) return null;
  const lookup = wiki.hasIndex
    ? `read \`${WORKGROUP_WIKI_CONTAINER_PATH}/index.md\` and grep the pages it points to`
    : `grep \`${WORKGROUP_WIKI_CONTAINER_PATH}\``;
  return [
    '## Workgroup wiki',
    '',
    `This workgroup's domain wiki is mounted read-only at \`${WORKGROUP_WIKI_CONTAINER_PATH}\`.`,
    '',
    `- Before asking a human a domain or product question, ${lookup}.`,
    '- When a wiki page decides something you build or say, name the page.',
    '- If the wiki has no answer or looks wrong, say so when you ask.',
  ].join('\n');
}
