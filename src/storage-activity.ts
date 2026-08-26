import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

const ACTIVE_DIR = '.nanoclaw-storage-active';
const CLEANUP_CLAIM = '.nanoclaw-storage-cleanup';
const CLAIM_WAIT_MS = 25;
// A stale claim is cleared only by the next host start, and inbound message
// writes wait on this loop. Waiting is right — it is what keeps the message —
// but a silent unbounded wait on the ingestion path is the failure mode this
// area was fixed for. Warn once, then keep waiting; give up at the cap, which
// is the tar timeout plus slack so a legitimately long archive still wins.
const CLAIM_WAIT_WARN_MS = 10_000;
const CLAIM_WAIT_MAX_MS = 65 * 60 * 1000;

export interface StorageActivityLease {
  release(): Promise<void>;
}

function markerName(holderId: string): string {
  return holderId.replace(/[^A-Za-z0-9._-]/g, '_');
}

function cleanupClaimPath(resourceRoot: string): string {
  return path.join(resourceRoot, CLEANUP_CLAIM);
}

function activeDirPath(resourceRoot: string): string {
  return path.join(resourceRoot, ACTIVE_DIR);
}

async function claimExists(resourceRoot: string): Promise<boolean> {
  try {
    await fs.promises.access(cleanupClaimPath(resourceRoot));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire a shared activity lease for a cache-bearing resource root.
 *
 * The worker's cleanup claim and the host's double-checked marker form a
 * small filesystem reader/writer lock:
 *   - cleanup creates the exclusive claim, then checks for active markers;
 *   - activity waits for no claim, creates its marker, then checks again.
 *
 * If the two race, either cleanup sees the marker and skips, or activity sees
 * the claim, removes its marker, and retries. The host only uses the resource
 * after this function returns, so recursive deletion can never overlap a live
 * or spawning container.
 */
export async function acquireStorageActivityLease(
  resourceRoot: string,
  holderId: string,
): Promise<StorageActivityLease> {
  await fs.promises.mkdir(resourceRoot, { recursive: true });
  const activeDir = activeDirPath(resourceRoot);
  // A holder label is diagnostic, not an identity. Two overlapping leases
  // for the same session must remain independent or the first release could
  // remove the only marker protecting the second.
  const marker = path.join(activeDir, markerName(`${holderId}-${process.pid}-${randomUUID()}`));
  const startedAt = Date.now();
  let warned = false;
  const waited = (): number => Date.now() - startedAt;
  const noteWait = (): void => {
    if (waited() >= CLAIM_WAIT_MAX_MS) {
      throw new Error(
        `gave up waiting for a storage cleanup claim after ${Math.round(waited() / 1000)}s: ${resourceRoot}`,
      );
    }
    if (warned || waited() < CLAIM_WAIT_WARN_MS) return;
    warned = true;
    log.warn('storage-activity: still waiting on a cleanup claim', { resourceRoot, holderId, waitedMs: waited() });
  };

  for (;;) {
    if (await claimExists(resourceRoot)) {
      await delay(CLAIM_WAIT_MS);
      noteWait();
      continue;
    }

    await fs.promises.mkdir(activeDir, { recursive: true });
    try {
      await fs.promises.writeFile(marker, `${process.pid}\n`, { flag: 'w' });
    } catch (err) {
      await fs.promises.rm(marker, { force: true }).catch(() => undefined);
      await fs.promises.rmdir(activeDir).catch(() => undefined);
      throw err;
    }

    if (await claimExists(resourceRoot)) {
      await fs.promises.rm(marker, { force: true });
      await delay(CLAIM_WAIT_MS);
      noteWait();
      continue;
    }

    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        await fs.promises.rm(marker, { force: true });
        try {
          await fs.promises.rmdir(activeDir);
        } catch {
          // Other live holders (or a concurrent acquisition) still own it.
        }
      },
    };
  }
}

/**
 * Synchronous reader side of the same lock, for the many writers that cannot
 * await — `openInboundDb` is called from sync code all over the host.
 *
 * Identical protocol to {@link acquireStorageActivityLease}: plant the marker,
 * THEN re-check the claim. Either cleanup sees this marker and skips, or we see
 * its claim. The only difference is what happens when the claim is there —
 * waiting needs async, so this throws instead. That trade is deliberate: an
 * operator or scheduler write that fails loudly and can be retried beats one
 * that lands in an inode the reclaim is about to unlink.
 *
 * Returns the release, which is idempotent.
 */
export function plantStorageActivityMarker(resourceRoot: string, holderId: string): () => void {
  const activeDir = activeDirPath(resourceRoot);
  const marker = path.join(activeDir, markerName(`${holderId}-${process.pid}-${randomUUID()}`));
  fs.mkdirSync(activeDir, { recursive: true });
  fs.writeFileSync(marker, `${process.pid}\n`, { flag: 'w' });
  if (fs.existsSync(cleanupClaimPath(resourceRoot))) {
    fs.rmSync(marker, { force: true });
    try {
      fs.rmdirSync(activeDir);
    } catch {
      // Another live holder still owns it.
    }
    throw new Error(`session storage is being reclaimed, retry: ${resourceRoot}`);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.rmSync(marker, { force: true });
    try {
      fs.rmdirSync(activeDir);
    } catch {
      // Another live holder still owns it — including an outer async lease.
    }
  };
}

/**
 * Run one destructive cache action under an exclusive cleanup claim.
 * Returns false when another cleanup owns the claim or any activity marker is
 * present; callers report that action as skipped rather than deleting.
 */
export function tryRunWithStorageCleanupClaim(resourceRoot: string, action: () => void): boolean {
  const claim = cleanupClaimPath(resourceRoot);
  let fd: number;
  try {
    fd = fs.openSync(claim, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }

  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    let active: string[] = [];
    try {
      active = fs.readdirSync(activeDirPath(resourceRoot));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (active.length > 0) {
      // A marker released on handle close, so a marker that never clears means
      // a leaked DB handle and this resource is skipped every pass until the
      // next host start. Silent would make that C1 inverted; say it.
      log.warn('storage-activity: cleanup skipped, resource is in use', { resourceRoot, holders: active.length });
      return false;
    }
    action();
    return true;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(claim, { force: true });
  }
}

function realDirectory(dirPath: string): boolean {
  try {
    const stat = fs.lstatSync(dirPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Enumerate every resource that can carry a storage-activity lease.
 *
 * Thread worktrees exist in both layouts:
 *   flat:   v2-threads/<thread>/worktrees
 *   nested: v2-threads/wg-<workgroup>/<thread>/worktrees
 *
 * Startup cleanup must cover both. Missing the nested layout leaves markers
 * behind after a forced host stop, which then makes every future cache action
 * for that thread safely skip forever.
 */
/**
 * Subdirectories of `dir`, or an empty list when it cannot be read.
 *
 * Per-directory rather than one try around the whole sweep: a single
 * unreadable or concurrently-removed entry must cost that entry only. Sharing
 * one catch meant an ENOENT from a group directory deleted mid-walk abandoned
 * every group after it, and an abandoned root keeps its stale claim.
 */
function subdirectories(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink());
  } catch (err) {
    // ENOENT is the ordinary "nothing here yet" (fresh install, no threads).
    // Anything else means this subtree keeps its stale claims — and a stale
    // claim now blocks writers, so it does not get to be silent.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('storage-activity: unreadable while sweeping stale claims', { directory: dir, err });
    }
    return [];
  }
}

function resourceRoots(dataDir: string = DATA_DIR): string[] {
  const roots = new Set<string>();
  const sessionsRoot = path.join(dataDir, 'v2-sessions');
  // Must stay in lockstep with sessionDir() in session-manager.ts:
  // v2-sessions/<agent_group_id>/<session_id>, exactly two levels. Inbound
  // message writes take their lease on that path and wait, unbounded, for any
  // claim there — so a root this misses is a session whose stale claim is
  // never cleared and whose messages never land.
  for (const group of subdirectories(sessionsRoot)) {
    const groupPath = path.join(sessionsRoot, group.name);
    for (const session of subdirectories(groupPath)) roots.add(path.join(groupPath, session.name));
  }

  const threadsRoot = path.join(dataDir, 'v2-threads');
  for (const topLevel of subdirectories(threadsRoot)) {
    const topLevelPath = path.join(threadsRoot, topLevel.name);
    const flatWorktrees = path.join(topLevelPath, 'worktrees');
    if (realDirectory(flatWorktrees)) {
      roots.add(flatWorktrees);
      continue;
    }

    for (const thread of subdirectories(topLevelPath)) {
      const nestedWorktrees = path.join(topLevelPath, thread.name, 'worktrees');
      if (realDirectory(nestedWorktrees)) roots.add(nestedWorktrees);
    }
  }
  return [...roots];
}

/** Remove claims left by a terminated worker without disturbing live leases. */
export function clearStorageCleanupClaims(dataDir: string = DATA_DIR): void {
  for (const resourceRoot of resourceRoots(dataDir)) {
    fs.rmSync(cleanupClaimPath(resourceRoot), { force: true });
  }
}

/**
 * Startup-only reset, called after orphan containers have been stopped. At
 * that point every marker and cleanup claim left by the previous host is stale.
 */
export function resetStorageActivityState(dataDir: string = DATA_DIR): void {
  for (const resourceRoot of resourceRoots(dataDir)) {
    fs.rmSync(cleanupClaimPath(resourceRoot), { force: true });
    fs.rmSync(activeDirPath(resourceRoot), { recursive: true, force: true });
  }
}
