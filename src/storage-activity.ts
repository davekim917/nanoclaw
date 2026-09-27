import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

const ACTIVE_DIR = '.nanoclaw-storage-active';
const CLEANUP_CLAIM = '.nanoclaw-storage-cleanup';

/**
 * Entry names this module creates/removes inside a resource root. Creating or removing them bumps the root's
 * mtime, so any idle signal that ages a root must exclude exactly these (see `sweepEligibility`).
 */
export const STORAGE_INTERNAL_ENTRY_NAMES: readonly string[] = [ACTIVE_DIR, CLEANUP_CLAIM];

const CLAIM_WAIT_MS = 25;
// Waiting on a claim is NEVER abandoned: throwing discards an accepted inbound message, and no time bound safely
// exceeds archival's two 60-minute phases. The bound is on SILENCE: warn early, then escalate on an interval.
const CLAIM_WAIT_WARN_MS = 10_000;
const CLAIM_WAIT_ESCALATE_MS = 5 * 60 * 1000;

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

/**
 * Refcounted roots this process holds an async lease on (overlapping leases on one root are supported). Only the
 * main thread acquires leases, so in-process state suffices.
 */
const heldLeases = new Map<string, number>();

function leaseKey(resourceRoot: string): string {
  return path.resolve(resourceRoot);
}

function holdLease(key: string): void {
  heldLeases.set(key, (heldLeases.get(key) ?? 0) + 1);
}

function dropLease(key: string): void {
  const next = (heldLeases.get(key) ?? 1) - 1;
  if (next > 0) heldLeases.set(key, next);
  else heldLeases.delete(key);
}

/**
 * Roots with a marker plant IN PROGRESS (mkdir issued, marker not yet on disk). Separate from `heldLeases`, which
 * lets a sync writer skip its own plant: a plant in flight has no marker protecting anyone yet. This answers only
 * "would removing the active dir now pull it out from under somebody".
 */
const plantsInFlight = new Map<string, number>();

function beginPlant(key: string): void {
  plantsInFlight.set(key, (plantsInFlight.get(key) ?? 0) + 1);
}

function endPlant(key: string): void {
  const next = (plantsInFlight.get(key) ?? 1) - 1;
  if (next > 0) plantsInFlight.set(key, next);
  else plantsInFlight.delete(key);
}

function activeDirInUse(key: string): boolean {
  return heldLeases.has(key) || plantsInFlight.has(key);
}

/**
 * Remove the active dir only when nothing in this process needs it. ONLY A RELEASE CALLS THIS: a planter's
 * discard cannot discount its own registration without also discounting a concurrent planter's. Removal is never
 * needed for correctness (reclaim gates on marker COUNT and tolerates ENOENT), so "in use" and "not sure" win.
 */
async function removeActiveDirIfUnused(key: string, activeDir: string): Promise<void> {
  if (activeDirInUse(key)) return;
  await fs.promises.rmdir(activeDir).catch(() => undefined);
}

function removeActiveDirIfUnusedSync(key: string, activeDir: string): void {
  if (activeDirInUse(key)) return;
  try {
    fs.rmdirSync(activeDir);
  } catch {
    // Another live holder, or a concurrent acquisition that already re-planted.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ENOENT retries for planting a marker. Both `mkdir(recursive)` (not atomic) and the `writeFile` can lose a race
 * with a releasing holder's rmdir; an escaped ENOENT aborted inbound routes before the row was written. Only a
 * lost race with an already-issued rmdir is retried; exhausting the bound rethrows.
 */
const PLANT_MAX_ATTEMPTS = 3;
const PLANT_RETRY_BACKOFF_MS = 5;

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** `discard` undoes a partial plant before each retry and the final rethrow: never unprotected, never stranded. */
async function plantWithEnoentRetry(plant: () => Promise<void>, discard: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await plant();
      return;
    } catch (err) {
      await discard();
      if (attempt >= PLANT_MAX_ATTEMPTS || !isEnoent(err)) throw err;
      await delay(PLANT_RETRY_BACKOFF_MS * attempt);
    }
  }
}

/** No backoff on purpose: a sync sleep would block the event loop, and the raced rmdir is already issued. */
function plantWithEnoentRetrySync(plant: () => void, discard: () => void): void {
  for (let attempt = 1; ; attempt++) {
    try {
      plant();
      return;
    } catch (err) {
      discard();
      if (attempt >= PLANT_MAX_ATTEMPTS || !isEnoent(err)) throw err;
    }
  }
}

/**
 * Shared activity lease on a cache-bearing resource root. With the worker's cleanup claim this forms a filesystem
 * reader/writer lock: cleanup creates its claim then checks markers; activity waits for no claim, plants its
 * marker, then re-checks. Either cleanup sees the marker and skips, or activity sees the claim and retries.
 */
export async function acquireStorageActivityLease(
  resourceRoot: string,
  holderId: string,
): Promise<StorageActivityLease> {
  await fs.promises.mkdir(resourceRoot, { recursive: true });
  const activeDir = activeDirPath(resourceRoot);
  // Unique per lease: two overlapping leases for one session must stay independent.
  const marker = path.join(activeDir, markerName(`${holderId}-${process.pid}-${randomUUID()}`));
  const key = leaseKey(resourceRoot);
  const startedAt = Date.now();
  let nextReportAt = CLAIM_WAIT_WARN_MS;
  const waited = (): number => Date.now() - startedAt;
  const noteWait = (): void => {
    if (waited() < nextReportAt) return;
    nextReportAt = waited() + CLAIM_WAIT_ESCALATE_MS;
    log.warn('storage-activity: still waiting on a cleanup claim', { resourceRoot, holderId, waitedMs: waited() });
  };

  for (;;) {
    if (await claimExists(resourceRoot)) {
      await delay(CLAIM_WAIT_MS);
      noteWait();
      continue;
    }

    // Announced before the first syscall and until holdLease takes over or we withdraw, so no in-process releaser
    // removes the dir mid-plant.
    beginPlant(key);
    try {
      await plantWithEnoentRetry(
        async () => {
          await fs.promises.mkdir(activeDir, { recursive: true });
          await fs.promises.writeFile(marker, `${process.pid}\n`, { flag: 'w' });
        },
        // Discard removes OUR MARKER only (see removeActiveDirIfUnused).
        async () => {
          await fs.promises.rm(marker, { force: true }).catch(() => undefined);
        },
      );

      if (await claimExists(resourceRoot)) {
        await fs.promises.rm(marker, { force: true });
        await delay(CLAIM_WAIT_MS);
        noteWait();
        continue;
      }

      holdLease(key);
    } finally {
      endPlant(key);
    }
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        dropLease(key);
        await fs.promises.rm(marker, { force: true });
        // Only the last in-process user removes the dir: ENOTEMPTY does not protect a user between its rm and
        // rmdir or mid-plant. Cross-process rmdirs are covered by the ENOENT retry.
        await removeActiveDirIfUnused(key, activeDir);
      },
    };
  }
}

/**
 * Synchronous reader side of the same lock, for sync writers like `openInboundDb`. Same protocol, but a claim
 * found on re-check THROWS instead of waiting: a loud, retryable failure beats writing into an inode about to be
 * unlinked. The returned release is idempotent.
 */
export function plantStorageActivityMarker(resourceRoot: string, holderId: string): () => void {
  // Skip when THIS process holds a lease: the reclaim is already bound to back off, and the claim re-check would
  // throw in the window before the reclaim reads the markers, losing an accepted message. Skipping on ANY marker
  // is unsafe: a third party can release between our check and the reclaim's read.
  if (heldLeases.has(leaseKey(resourceRoot))) return () => {};

  const activeDir = activeDirPath(resourceRoot);
  const marker = path.join(activeDir, markerName(`${holderId}-${process.pid}-${randomUUID()}`));
  const key = leaseKey(resourceRoot);
  // Withdraws this marker only; we are still registered as planting (see removeActiveDirIfUnused).
  const discard = (): void => {
    fs.rmSync(marker, { force: true });
  };
  // A genuine last-user check: by now this planter is registered nowhere.
  const releaseMarker = (): void => {
    discard();
    removeActiveDirIfUnusedSync(key, activeDir);
  };
  // Plant under the bounded ENOENT retry, announced as in flight so a release on another event-loop turn cannot
  // rmdir between mkdir and writeFile. Any other failure discards and rethrows.
  beginPlant(key);
  try {
    plantWithEnoentRetrySync(() => {
      fs.mkdirSync(activeDir, { recursive: true });
      fs.writeFileSync(marker, `${process.pid}\n`, { flag: 'w' });
    }, discard);
  } finally {
    endPlant(key);
  }
  if (fs.existsSync(cleanupClaimPath(resourceRoot))) {
    discard();
    throw new Error(`session storage is being reclaimed, retry: ${resourceRoot}`);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseMarker();
  };
}

/** Run one destructive action under an exclusive cleanup claim; false when another claim or any marker exists. */
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
      // A marker that never clears means a leaked DB handle; say so rather than skip silently every pass.
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

/** Per-directory catch: one unreadable or vanished entry must not abandon the rest (and keep their stale claims). */
function subdirectories(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink());
  } catch (err) {
    // ENOENT is ordinary; anything else leaves stale claims that block writers, so it is logged.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('storage-activity: unreadable while sweeping stale claims', { directory: dir, err });
    }
    return [];
  }
}

/** Every lease-bearing root. A missed one keeps its stale markers and claims forever after an ungraceful stop. */
function resourceRoots(dataDir: string = DATA_DIR): string[] {
  const roots = new Set<string>();
  const sessionsRoot = path.join(dataDir, 'v2-sessions');
  // Lockstep with sessionDir() in session-manager.ts (exactly two levels): a missed session never clears its stale
  // claim and its inbound messages never land.
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

  // Topic worktrees: exactly the path container-runner.ts leases via topicWorktreesDir().
  const topicsRoot = path.join(dataDir, 'v2-topics');
  for (const workgroup of subdirectories(topicsRoot)) {
    const workgroupPath = path.join(topicsRoot, workgroup.name);
    for (const topic of subdirectories(workgroupPath)) {
      const worktrees = path.join(workgroupPath, topic.name, 'worktrees');
      if (realDirectory(worktrees)) roots.add(worktrees);
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

/** Startup-only, after orphan containers are stopped: every marker and claim is then stale. */
export function resetStorageActivityState(dataDir: string = DATA_DIR): void {
  for (const resourceRoot of resourceRoots(dataDir)) {
    fs.rmSync(cleanupClaimPath(resourceRoot), { force: true });
    fs.rmSync(activeDirPath(resourceRoot), { recursive: true, force: true });
  }
}
