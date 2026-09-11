/**
 * A workgroup's domain wiki, offered read-only to every agent in the workgroup.
 *
 * The host keeps a checkout at `data/wikis/<workgroup-id>/`. How it stays
 * current is install config (for example an hourly `git pull`); trunk never
 * clones or refreshes it. When the directory exists, every sibling in the
 * workgroup, whatever its provider, gets it mounted read-only at
 * `/workspace/wiki`, and the composed CLAUDE.md / AGENTS.md gets a short
 * section saying when to consult it. No directory, no mount, no section.
 *
 * The path segment is the spawn-resolved workgroup id, never agent input, and
 * it must be a workgroup slug. A symlink or non-directory at that path is
 * refused rather than followed, the same rule cross-workgroup read access
 * applies to its source roots (`src/workgroup-read-access.ts`).
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';
import type { VolumeMount } from './providers/provider-container-registry.js';

export const WORKGROUP_WIKI_CONTAINER_PATH = '/workspace/wiki';

// Same slug rule as src/workgroup-read-access.ts WORKGROUP_ID_RE: letters,
// digits and hyphens only, so no id can climb out of data/wikis/.
const WORKGROUP_ID_RE = /^[a-z][a-z0-9-]*$/;

export interface WorkgroupWiki {
  mount: VolumeMount;
  /** Whether the wiki has a top-level index.md to start from. */
  hasIndex: boolean;
}

export function workgroupWikiHostPath(workgroupId: string): string {
  return path.join(DATA_DIR, 'wikis', workgroupId);
}

/**
 * `workspaceHostRoot` is the host directory mounted at `/workspace` (the
 * agent-writable session dir). When given, the wiki is skipped if something
 * other than a directory already sits at its `wiki` mountpoint.
 */
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
 * An agent in a session that predates the wiki can leave a file or symlink at
 * `/workspace/wiki`. The mountpoint-stub loop keeps whatever already exists
 * there (`if (fs.existsSync(stubPath)) continue`, src/container-runner.ts:6654),
 * and Docker then fails a directory bind onto a file on every spawn of that
 * session. Skipping the optional wiki keeps the spawn alive.
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

/** The composed-doc section for a mounted wiki; null when there is none. */
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
