import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

/**
 * GitHub credential delivery BY REFERENCE.
 *
 * The container spec used to carry the token as a value (`-e GITHUB_TOKEN=ghs_…`),
 * which puts a live credential in `docker inspect`, in every process listing that
 * shows the spawn argv, and in any log line that echoes the args. It also freezes
 * the credential at spawn: a GitHub App installation token lives ~1h, and a
 * container that works past that hour watches its token die with no way to hear
 * about the host's re-mint (see github-app-token.ts).
 *
 * Both problems have the same fix: write the token to a per-group file, mount the
 * directory read-only, and pass the container the PATH. The spec then carries no
 * secret value, and because the host rewrites the file IN PLACE the container sees
 * the new token on its next `git`/`gh` invocation — no respawn needed.
 *
 * IN PLACE is load-bearing, not a style choice. Write-temp-then-rename installs a
 * NEW inode; any container that bind-mounts the file itself keeps reading the old
 * one forever. We mount the DIRECTORY here (so rename would in fact propagate),
 * but the file must stay safe to mount directly, and a future caller must not have
 * to know the difference. Truncate + write, always.
 *
 * Torn reads: O_TRUNC leaves a microsecond window where the file is empty or holds
 * a prefix of the new token. The written form is `<token>\n`, so a reader can
 * detect the window precisely — a value not terminated by a newline is torn. The
 * container-side readers (container/entrypoint.sh) use `read -r`, which reports
 * failure when it hits EOF without a delimiter, and retry.
 */

/** Read-only mount point for the group's token directory inside the container. */
export const GH_TOKEN_CONTAINER_DIR = '/run/nanoclaw/gh-token';
/** Value of `GITHUB_TOKEN_FILE` in the container — a path, never a credential. */
export const GH_TOKEN_CONTAINER_PATH = `${GH_TOKEN_CONTAINER_DIR}/token`;

/**
 * Compatibility escape hatch for one release. `GITHUB_TOKEN_IN_ENV=1` restores
 * the pre-2026-09 behavior exactly: `GH_TOKEN`/`GITHUB_TOKEN` forwarded as
 * values, no file written, no mount, `GITHUB_TOKEN_FILE` unset. Nothing is
 * "also" done in that mode, so a rollback exercises the old path and only the
 * old path.
 */
export function githubTokenInEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.GITHUB_TOKEN_IN_ENV;
  return v === '1' || v === 'true';
}

/**
 * Does the container run as the HOST user?
 *
 * `buildContainerArgs` passes `--user <hostUid>:<hostGid>` for every uid except
 * 0 and 1000, so for those two the container runs as the image's own `node`
 * user instead — uid 1001 by the Dockerfile default, which `container/build.sh`
 * does not override. A host-owned `0600` file inside a `0700` directory is then
 * unreadable inside the container, and every `git` and `gh` call would fail
 * with a credential that looks configured.
 *
 * This is the single definition of that condition: `buildContainerArgs` calls
 * it for the `--user` decision and `planGitHubTokenSpawn` calls it to decide
 * whether the file lane is usable at all, so the two cannot drift apart.
 */
export function containerRunsAsHostUser(uid: number | undefined = process.getuid?.()): boolean {
  return uid != null && uid !== 0 && uid !== 1000;
}

export function groupTokenDir(agentGroupId: string, dataDir: string = DATA_DIR): string {
  // The id becomes a path segment. Ids are host-generated (`ag-<ms>-<rand>`),
  // but a traversal here would let one group's spawn write over another's token
  // file, so refuse anything that is not a single plain segment.
  if (!/^[A-Za-z0-9._-]+$/.test(agentGroupId) || agentGroupId === '.' || agentGroupId === '..') {
    throw new Error(`Refusing to use agent group id as a path segment: ${JSON.stringify(agentGroupId)}`);
  }
  return path.join(dataDir, 'gh-token', agentGroupId);
}

export function groupTokenPath(agentGroupId: string, dataDir: string = DATA_DIR): string {
  return path.join(groupTokenDir(agentGroupId, dataDir), 'token');
}

/**
 * Write (or rewrite) a group's token file. Returns the host path.
 *
 * `0600` on the file and `0700` on the directory are set explicitly rather than
 * left to the open/mkdir mode argument: both are masked by the process umask,
 * and the host's umask is not ours to assume.
 */
export function writeGroupGitHubTokenFile(agentGroupId: string, token: string, dataDir: string = DATA_DIR): string {
  const dir = groupTokenDir(agentGroupId, dataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(path.dirname(dir), 0o700);
  fs.chmodSync(dir, 0o700);
  const file = groupTokenPath(agentGroupId, dataDir);
  // 'w' is O_WRONLY|O_CREAT|O_TRUNC — same inode when the file already exists.
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeSync(fd, `${token}\n`);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
  return file;
}

/** Current on-disk token for a group, or undefined when absent/torn/empty. */
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
  /** Read-only bind mount of the group's token directory. Absent in env mode. */
  mount?: { hostPath: string; containerPath: string; readonly: true };
  /** `docker run` env arguments — a PATH by default, values only under the flag. */
  envArgs: string[];
}

/**
 * Decide how this spawn delivers the GitHub credential. Pure apart from the
 * file write, and exported so the spawn contract is testable without executing
 * buildContainerArgs (which makes live `onecli` shell calls).
 */
export function planGitHubTokenSpawn(opts: {
  agentGroupId: string;
  token: string;
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  /** Host uid this spawn will run under. Defaults to the current process. */
  hostUid?: number;
}): GitHubTokenSpawnPlan {
  const { agentGroupId, token } = opts;
  const env = opts.env ?? process.env;
  const dataDir = opts.dataDir ?? DATA_DIR;
  if (githubTokenInEnv(env)) {
    return { envArgs: ['-e', `GH_TOKEN=${token}`, '-e', `GITHUB_TOKEN=${token}`] };
  }
  // Root and uid-1000 hosts run the container as the image's own user, which
  // cannot read a host-owned 0600 file. Fall back to the env lane rather than
  // mount a credential the container will only ever get EACCES on — an
  // unreadable token breaks git and gh completely, which is worse than the
  // exposure this change removes.
  if (!containerRunsAsHostUser(opts.hostUid)) {
    log.warn('Container will not run as the host user — forwarding the GitHub token as env instead of a mounted file', {
      hostUid: opts.hostUid ?? process.getuid?.(),
      agentGroupId,
    });
    return { envArgs: ['-e', `GH_TOKEN=${token}`, '-e', `GITHUB_TOKEN=${token}`] };
  }
  const file = writeGroupGitHubTokenFile(agentGroupId, token, dataDir);
  return {
    mount: { hostPath: path.dirname(file), containerPath: GH_TOKEN_CONTAINER_DIR, readonly: true },
    envArgs: ['-e', `GITHUB_TOKEN_FILE=${GH_TOKEN_CONTAINER_PATH}`],
  };
}

/**
 * Per-group re-resolvers, registered at spawn. The host sweep calls
 * `refreshGroupGitHubTokenFiles` so a group whose container is still alive an
 * hour later gets the freshly minted App token written under it. Re-resolution
 * is a cache read in the common case — `mintOrReuseGitHubAppToken` only touches
 * the network inside its refresh margin, and the sweep step that runs just
 * before this one has usually already re-minted.
 *
 * Bounded by the number of agent groups, and each spawn overwrites its own
 * entry, so this cannot grow over a multi-day host run.
 */
const refreshers = new Map<string, () => Promise<string | undefined>>();

export function registerGroupTokenRefresher(agentGroupId: string, resolve: () => Promise<string | undefined>): void {
  refreshers.set(agentGroupId, resolve);
}

/** Test hook — the registry is process-global and would leak across cases. */
export function clearGroupTokenRefreshers(): void {
  refreshers.clear();
}

/**
 * Rewrite every registered group's token file whose value has changed. Returns
 * the count rewritten.
 *
 * REFRESHES, NEVER CREATES. A group that spawned under the rollback flag has no
 * file, and this must not conjure one — the flag's whole promise is that env
 * mode writes no credential to disk. Absent file means nothing to refresh.
 */
export async function refreshGroupGitHubTokenFiles(dataDir: string = DATA_DIR): Promise<number> {
  if (githubTokenInEnv()) return 0;
  // CONCURRENT, not serial. Resolving an App-sentinel group can enter a mint
  // with a 10s timeout; awaiting the groups one at a time would make a GitHub
  // outage cost `group count x 10s` on a sweep that also owns due-message
  // wakes, recurrence and stale detection. Run together and
  // `mintOrReuseGitHubAppToken`'s per-installation in-flight dedup collapses
  // them into one network mint, capping the whole step at a single timeout no
  // matter how many groups are registered.
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
