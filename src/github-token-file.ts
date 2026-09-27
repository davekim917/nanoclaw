import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

/**
 * GitHub credential delivery by reference: a per-group token file, directory mounted read-only, so the spec
 * carries no secret and a rewrite reaches running containers on their next git/gh call.
 *
 * Rewrite IN PLACE (truncate + write), never temp-then-rename: a new inode is invisible to a container that
 * bind-mounts the file itself. The written form is `<token>\n`, so a value without the newline is a torn read.
 */

export const GH_TOKEN_CONTAINER_DIR = '/run/nanoclaw/gh-token';
export const GH_TOKEN_CONTAINER_PATH = `${GH_TOKEN_CONTAINER_DIR}/token`;

/** Rollback flag: token forwarded as env values only, with no file written and no mount. */
export function githubTokenInEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.GITHUB_TOKEN_IN_ENV;
  return v === '1' || v === 'true';
}

/**
 * For host uids 0 and 1000 the container runs as the image's own user, which can't read a host-owned 0600 file.
 * Shared by the `--user` decision and the token-file decision so the two can't drift.
 */
export function containerRunsAsHostUser(uid: number | undefined = process.getuid?.()): boolean {
  return uid != null && uid !== 0 && uid !== 1000;
}

/** Shared by the spawn plan and the capabilities snapshot, so the snapshot can't misdescribe the agent's env. */
export function githubTokenDeliveredAsEnv(env: NodeJS.ProcessEnv = process.env, uid?: number): boolean {
  return githubTokenInEnv(env) || !containerRunsAsHostUser(uid);
}

function groupTokenDir(agentGroupId: string, dataDir: string = DATA_DIR): string {
  // A traversal here would let one group's spawn overwrite another's token file.
  if (!/^[A-Za-z0-9._-]+$/.test(agentGroupId) || agentGroupId === '.' || agentGroupId === '..') {
    throw new Error(`Refusing to use agent group id as a path segment: ${JSON.stringify(agentGroupId)}`);
  }
  return path.join(dataDir, 'gh-token', agentGroupId);
}

export function groupTokenPath(agentGroupId: string, dataDir: string = DATA_DIR): string {
  return path.join(groupTokenDir(agentGroupId, dataDir), 'token');
}

/** Modes are chmod'ed explicitly because the open/mkdir mode arguments are masked by the umask. */
export function writeGroupGitHubTokenFile(agentGroupId: string, token: string, dataDir: string = DATA_DIR): string {
  const dir = groupTokenDir(agentGroupId, dataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(path.dirname(dir), 0o700);
  fs.chmodSync(dir, 0o700);
  const file = groupTokenPath(agentGroupId, dataDir);
  // 'w' is O_WRONLY|O_CREAT|O_TRUNC: same inode when the file already exists.
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeSync(fd, `${token}\n`);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
  return file;
}

/** Undefined when absent, torn or empty. */
export function readGroupGitHubTokenFile(agentGroupId: string, dataDir: string = DATA_DIR): string | undefined {
  try {
    const raw = fs.readFileSync(groupTokenPath(agentGroupId, dataDir), 'utf-8');
    if (!raw.endsWith('\n')) return undefined;
    const token = raw.slice(0, -1);
    return token || undefined;
  } catch {
    return undefined;
  }
}

export interface GitHubTokenSpawnPlan {
  /** Absent in env mode. */
  mount?: { hostPath: string; containerPath: string; readonly: true };
  envArgs: string[];
}

export function planGitHubTokenSpawn(opts: {
  agentGroupId: string;
  token: string;
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  hostUid?: number;
}): GitHubTokenSpawnPlan {
  const { agentGroupId, token } = opts;
  const env = opts.env ?? process.env;
  const dataDir = opts.dataDir ?? DATA_DIR;
  if (githubTokenDeliveredAsEnv(env, opts.hostUid)) {
    if (!githubTokenInEnv(env)) {
      log.warn(
        'Container will not run as the host user — forwarding the GitHub token as env instead of a mounted file',
        { hostUid: opts.hostUid ?? process.getuid?.(), agentGroupId },
      );
    }
    return { envArgs: ['-e', `GH_TOKEN=${token}`, '-e', `GITHUB_TOKEN=${token}`] };
  }
  const file = writeGroupGitHubTokenFile(agentGroupId, token, dataDir);
  return {
    mount: { hostPath: path.dirname(file), containerPath: GH_TOKEN_CONTAINER_DIR, readonly: true },
    envArgs: ['-e', `GITHUB_TOKEN_FILE=${GH_TOKEN_CONTAINER_PATH}`],
  };
}

const refreshers = new Map<string, () => Promise<string | undefined>>();

export function registerGroupTokenRefresher(agentGroupId: string, resolve: () => Promise<string | undefined>): void {
  refreshers.set(agentGroupId, resolve);
}

export function clearGroupTokenRefreshers(): void {
  refreshers.clear();
}

async function groupStillExists(agentGroupId: string): Promise<boolean> {
  const { getAgentGroup } = await import('./db/agent-groups.js');
  return getAgentGroup(agentGroupId) !== undefined;
}

/**
 * `ncl groups delete` leaves running containers alive, and a file the host keeps rewriting never expires, so
 * deleting the file is the revocation. Scans the directory, not the registry, to catch groups deleted while down.
 */
async function revokeDeletedGroupTokens(
  dataDir: string,
  groupExists: (id: string) => boolean | Promise<boolean>,
): Promise<number> {
  const root = path.join(dataDir, 'gh-token');
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return 0;
  }
  let revoked = 0;
  for (const agentGroupId of entries) {
    try {
      if (await groupExists(agentGroupId)) continue;
      refreshers.delete(agentGroupId);
      fs.rmSync(path.join(root, agentGroupId), { recursive: true, force: true });
      revoked += 1;
      log.warn('Agent group no longer exists — revoked its mounted GitHub token', { agentGroupId });
    } catch (err) {
      log.warn('Could not revoke the mounted GitHub token of a deleted group', { agentGroupId, err });
    }
  }
  return revoked;
}

/** Refreshes, never creates: env mode promises no credential on disk. Returns the count rewritten. */
export async function refreshGroupGitHubTokenFiles(
  dataDir: string = DATA_DIR,
  groupExists: (id: string) => boolean | Promise<boolean> = groupStillExists,
): Promise<number> {
  if (githubTokenInEnv()) return 0;
  await revokeDeletedGroupTokens(dataDir, groupExists);
  // Concurrent, not serial: mint dedup collapses the groups into one mint, so an outage costs one timeout, not N.
  const results = await Promise.all(
    [...refreshers].map(async ([agentGroupId, resolve]) => {
      try {
        if (!fs.existsSync(groupTokenPath(agentGroupId, dataDir))) return 0;
        const token = await resolve();
        if (!token) return 0;
        if (readGroupGitHubTokenFile(agentGroupId, dataDir) === token) return 0;
        writeGroupGitHubTokenFile(agentGroupId, token, dataDir);
        log.info('Rewrote mounted GitHub token file — running containers pick it up on next git/gh call', {
          agentGroupId,
        });
        return 1;
      } catch (err) {
        log.warn('GitHub token file refresh failed for group', { agentGroupId, err });
        return 0;
      }
    }),
  );
  return results.reduce<number>((a, b) => a + b, 0);
}
