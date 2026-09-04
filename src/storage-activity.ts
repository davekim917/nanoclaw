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
// area was fixed for.
//
// Waiting is NEVER abandoned. Routing has no recovery between the awaited
// write and the archive, so throwing here discards an accepted message, which
// is the same loss the lease exists to prevent. A time bound would also have
// to exceed a legitimate worst case, and archival has TWO independently
// bounded 60-minute phases (storage-manager.ts create + validate), so any
// number that looks generous is still guessable-wrong. The bound is on
// SILENCE, not on waiting: warn once early, then escalate on a slow interval
// so a genuinely stuck claim is impossible to miss and impossible to sleep
// through.
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
 * Roots this PROCESS currently holds an async lease on, refcounted because two
 * overlapping leases on one root are supported by design (see the marker-name
 * comment below). Only the main thread acquires leases — the reclaim runs in a
 * worker thread and never does — so in-process state is sufficient here where
 * a cross-thread question would need the filesystem.
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
 * Roots with a marker plant IN PROGRESS — mkdir issued, marker not yet on
 * disk. Deliberately NOT folded into `heldLeases`: that map answers "this
 * process already has a marker protecting this root", which is what lets
 * plantStorageActivityMarker skip its own plant and its claim re-check. A
 * plant in flight has no marker yet, so answering that question "yes" would
 * let a sync writer proceed with nothing on disk protecting it.
 *
 * This map answers the narrower question the releasers need: "would removing
 * the active directory right now pull it out from under somebody". Without
 * it, a release whose refcount just hit zero rmdir'd the directory a
 * concurrent acquisition was in the middle of creating — measured at ~2 lost
 * acquisitions per 4 000 under 8-way contention even with the ENOENT retry.
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

/**
 * True when some holder or in-flight plant in this process still needs the
 * directory. `ownPlants` discounts the caller's OWN registration: a planter's
 * discard runs while it is still registered, and it must still be able to
 * clean up after itself when nobody else is around.
 */
function activeDirInUse(key: string, ownPlants = 0): boolean {
  return heldLeases.has(key) || (plantsInFlight.get(key) ?? 0) > ownPlants;
}

/**
 * Tidy the active directory away, but only when nothing in this process still
 * needs it. Removing it is never REQUIRED for correctness — a reclaim gates on
 * marker count, not on the directory existing (see tryRunWithStorageCleanupClaim)
 * — while removing it at the wrong moment is exactly what breaks a concurrent
 * plant. So "in use" always wins.
 */
async function removeActiveDirIfUnused(key: string, activeDir: string, ownPlants = 0): Promise<void> {
  if (activeDirInUse(key, ownPlants)) return;
  await fs.promises.rmdir(activeDir).catch(() => undefined);
}

function removeActiveDirIfUnusedSync(key: string, activeDir: string, ownPlants = 0): void {
  if (activeDirInUse(key, ownPlants)) return;
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
 * How many times planting an activity marker may be retried after an ENOENT.
 *
 * Planting is two syscalls against a directory other holders are concurrently
 * creating and removing — `mkdir(activeDir, { recursive: true })` then
 * `writeFile(marker)` — and BOTH can lose that race with ENOENT:
 *
 *   - the writeFile, when a releasing holder's rmdir lands between the two;
 *   - the mkdir ITSELF, because a recursive mkdir is not one atomic syscall.
 *     Node walks the path, and a concurrent rmdir of the leaf between its
 *     internal steps surfaces as ENOENT out of the mkdir call. Measured on
 *     Node 22: ~4 mkdir ENOENTs and ~70 writeFile ENOENTs per 20k contended
 *     plant/release pairs.
 *
 * The mkdir used to sit outside the retry, so its ENOENT escaped to the
 * caller. On the inbound path that caller is `writeSessionMessage`, and the
 * throw aborted the route BEFORE the row was written — an accepted platform
 * message dropped on the floor. This is what stranded
 * sess-1788440696563-ae2rvy on 2026-09-04.
 *
 * A retry is only ever losing a race with a rmdir that has already been
 * issued, so a small bound is enough; three attempts covers a burst of
 * overlapping releases without turning a genuine failure (ENOSPC, EACCES)
 * into a spin. Exhausting the bound rethrows, exactly as before.
 */
const PLANT_MAX_ATTEMPTS = 3;
const PLANT_RETRY_BACKOFF_MS = 5;

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Run `plant` under the bounded ENOENT retry above. `discard` undoes a partial
 * plant before each retry (and before the final rethrow) so a failed attempt
 * neither proceeds unprotected nor strands a marker that would block this
 * root's reclaim forever.
 */
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

/**
 * Synchronous twin of {@link plantWithEnoentRetry}. No backoff between
 * attempts on purpose: the only sleep available here would block the event
 * loop, and the rmdir this is racing has already been issued — retrying
 * immediately is what clears it.
 */
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

    // Announce the plant BEFORE the first syscall and keep it announced until
    // either holdLease takes over or we have withdrawn — the directory is
    // then continuously spoken for, so no in-process releaser can remove it
    // mid-plant.
    beginPlant(key);
    try {
      // Plant, retrying on ENOENT — see plantStorageActivityMarker below,
      // which this mirrors. The mkdir is INSIDE the try on purpose: a
      // recursive mkdir is not atomic, so a rmdir of this same directory can
      // make the mkdir itself fail ENOENT, not just the writeFile after it.
      await plantWithEnoentRetry(
        async () => {
          await fs.promises.mkdir(activeDir, { recursive: true });
          await fs.promises.writeFile(marker, `${process.pid}\n`, { flag: 'w' });
        },
        async () => {
          await fs.promises.rm(marker, { force: true }).catch(() => undefined);
          await removeActiveDirIfUnused(key, activeDir, 1);
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
        // Only the last in-process user removes the directory. Relying on
        // ENOTEMPTY to make this a no-op does not work: it succeeds whenever
        // the other users happen to be between their own rm and rmdir, or are
        // mid-plant with no marker on disk yet, and their plant then loses its
        // mkdir or its writeFile. Same-process overlap is what the incident
        // was — two concurrent deliverToAgent calls on one session — so this
        // removes the dominant window. Cross-process rmdirs remain, and the
        // bounded ENOENT retry above still covers those.
        await removeActiveDirIfUnused(key, activeDir);
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
  // This process already holds a lease on the root, so the reclaim is already
  // guaranteed to back off and a second marker adds nothing. Skipping is not
  // just an optimisation — the claim re-check below would THROW inside the
  // window where tryRunWithStorageCleanupClaim has created its claim but has
  // not yet read the markers that will make it abandon, losing an accepted
  // message to a reclaim that never runs.
  //
  // The condition has to be "we hold a lease", not "a marker exists":
  //   - planting with no re-check at all is unsafe — the reclaim may already
  //     have read the marker directory and be committed to deleting;
  //   - skipping on OUR OWN lease is safe — that marker predates this call and
  //     persists past it, so the reclaim's read cannot have already passed;
  //   - skipping on ANY marker is unsafe — a third party can release theirs
  //     between our check and the reclaim's read.
  if (heldLeases.has(leaseKey(resourceRoot))) return () => {};

  const activeDir = activeDirPath(resourceRoot);
  const marker = path.join(activeDir, markerName(`${holderId}-${process.pid}-${randomUUID()}`));
  const key = leaseKey(resourceRoot);
  const discard = (): void => {
    fs.rmSync(marker, { force: true });
    // An async lease or plant started on this root AFTER the early return
    // above must not lose its directory here — same rule as release().
    removeActiveDirIfUnusedSync(key, activeDir, plantsInFlight.has(key) ? 1 : 0);
  };
  // Plant under the bounded ENOENT retry. A releasing holder's
  // `fs.promises.rmdir` runs its syscall on the libuv threadpool, so it can
  // land between these two synchronous calls and take the directory we just
  // made — an ordinary race with no bearing on whether we may proceed. The
  // mkdir is INSIDE the retry with the writeFile, not before it: a recursive
  // mkdir is not atomic, so that same rmdir can also make the MKDIR fail
  // ENOENT (see PLANT_MAX_ATTEMPTS). Any other failure (ENOSPC leaving a
  // partial marker) is real: discard so we neither proceed unprotected nor
  // strand a file that blocks this root's reclaim forever, and let the caller
  // see it. acquireStorageActivityLease above mirrors this same handling.
  //
  // Announced as in-flight for the same reason the async path announces it:
  // a release on another turn of the event loop must not rmdir the directory
  // between this mkdir and this writeFile.
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
    discard();
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
