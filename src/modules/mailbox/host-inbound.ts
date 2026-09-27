/**
 * Where the host keeps a session's `inbound.db`, and how a session is moved there.
 *
 * SECURITY: `inbound.db` is host-authoritative (its `delivered` rows gate
 * approvals, the email gate and send_file acks). A file-level read-only overlay
 * inside a READ-WRITE `/workspace` still let a container plant
 * `inbound.db-journal` beside it, and SQLite replays a hot journal verbatim
 * (nothing binds a journal to its database), forging rows. Deleting every
 * journal is also wrong: a genuine host-crash journal MUST be replayed.
 *
 * The fix is structural: SQLite creates sidecars only in the database's own
 * directory, so the host keeps it in `<session>/.host/`, mounted READ-ONLY AS
 * A DIRECTORY. `<session>/inbound.db` stays as a HARD LINK to the same inode:
 * a rollback binary still finds its data, and the runner's unchanged read path
 * sees every write under the same per-inode locking. Writes through the legacy
 * name are still refused by its read-only file overlay.
 *
 * Known residue: the container can no longer see a genuine host-crash journal;
 * the first host read-write open after restart replays it.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import {
  fileIdentityOf,
  readHostInboundProvenance,
  recordHostInboundProvenance,
} from '../../db/host-inbound-provenance.js';
import { HostInboundProvenanceError, SessionDbMissingError } from './errors.js';

/**
 * Inside the session directory, not a sibling: sibling dirs at the agent-group
 * level would be enumerated as sessions by `resourceRoots` and other walkers.
 * Appears in the container as `/workspace/.host`.
 */
export const HOST_INBOUND_DIR_NAME = '.host';

const SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm'] as const;

export function hostInboundDirFor(sessionPath: string): string {
  return path.join(sessionPath, HOST_INBOUND_DIR_NAME);
}

export function hostInboundDbPathFor(sessionPath: string): string {
  return path.join(hostInboundDirFor(sessionPath), 'inbound.db');
}

export function legacyInboundDbPathFor(sessionPath: string): string {
  return path.join(sessionPath, 'inbound.db');
}

/**
 * Inverse of `hostInboundDbPathFor`: the storage-activity marker must go on the
 * session ROOT (dirname of a host path is `.host`, where the reclaim never
 * looks). A non-host-owned path answers with its own directory.
 */
export function sessionDirForInboundDbPath(dbPath: string): string {
  const parent = path.dirname(dbPath);
  return path.basename(parent) === HOST_INBOUND_DIR_NAME ? path.dirname(parent) : parent;
}

/**
 * Sidecars at the LEGACY path are foreign once migrated (the host never
 * journals there again). Deleting matters: a planted journal makes every
 * read-only open of the legacy name fail, and the reclaim then fails closed forever.
 */
export function removeForeignInboundSidecars(sessionPath: string): string[] {
  const removed: string[] = [];
  const legacy = legacyInboundDbPathFor(sessionPath);
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecar = `${legacy}${suffix}`;
    if (fs.existsSync(sidecar)) {
      fs.rmSync(sidecar, { force: true });
      removed.push(suffix);
    }
  }
  return removed;
}

/**
 * The two read-only mounts, built beside the layout so they can't drift:
 * `/workspace/.host` as a DIRECTORY (no sibling path outside the protection for
 * a journal) and the legacy `/workspace/inbound.db` hard link for the runner's
 * read path. Both unconditional: the caller migrates first and refuses to
 * spawn a non-host-owned session.
 */
export function hostInboundMounts(
  sessionPath: string,
): Array<{ hostPath: string; containerPath: string; readonly: boolean }> {
  return [
    { hostPath: hostInboundDirFor(sessionPath), containerPath: '/workspace/.host', readonly: true },
    { hostPath: legacyInboundDbPathFor(sessionPath), containerPath: '/workspace/inbound.db', readonly: true },
  ];
}

/** Upstream's `destroy` knows only the legacy name; the host-owned copy would outlive the session. */
export function removeHostInboundDir(sessionPath: string): void {
  fs.rmSync(hostInboundDirFor(sessionPath), { recursive: true, force: true });
}

/**
 * The legacy-path fallback in `resolveInboundDbPath` must never be the state a
 * container is handed (only a container can plant a journal). Fail closed; the
 * spawn retries.
 */
export function assertHostOwnedInboundDb(sessionPath: string, sessionId: string): void {
  if (inboundDbIsHostOwned(sessionPath)) return;
  throw new Error(`Session ${sessionId} has no host-owned inbound.db; refusing to spawn. Spawn will retry.`);
}

export function inboundDbIsHostOwned(sessionPath: string): boolean {
  return fs.existsSync(hostInboundDbPathFor(sessionPath));
}

/**
 * Host-owned when present, else legacy (unmigrated sessions and test fixtures),
 * else host-owned for a fresh session. The legacy fallback is transitional: the
 * spawn path refuses a non-host-owned session.
 */
export function resolveInboundDbPath(sessionPath: string): string {
  const hostOwned = hostInboundDbPathFor(sessionPath);
  if (fs.existsSync(hostOwned)) return hostOwned;
  return fs.existsSync(legacyInboundDbPathFor(sessionPath)) ? legacyInboundDbPathFor(sessionPath) : hostOwned;
}

/**
 * Passed explicitly, never parsed from `sessionPath`: provenance is keyed by
 * (agent group, session), and a layout change would otherwise read as "no
 * record" (a refusal) for every session.
 */
export interface HostInboundSessionKey {
  agentGroupId: string;
  sessionId: string;
}

type InboundMigrationOutcome =
  | 'no-session'
  /** Neither path holds a database yet; the caller provisions at the host path. */
  | 'absent'
  | 'already-host-owned'
  | 'migrated'
  /** Host-owned, and the legacy hard link was re-pointed at the live inode. */
  | 'relinked';

export interface InboundMigrationResult {
  outcome: InboundMigrationOutcome;
  removedSidecars: string[];
  /** A genuine crash journal was carried across and replayed. */
  replayedCrashJournal: boolean;
}

/**
 * Maps ENOENT/ENOTDIR from work that trusted an `existsSync` to
 * `SessionDbMissingError`: the reclaim deletes sessions concurrently, and
 * callers skip a vanished session only on that class (a raw errno fails the
 * whole tick). Other errnos pass through.
 */
function asVanished<T>(dbPath: string, work: () => T): T {
  try {
    return work();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new SessionDbMissingError(dbPath);
    throw err;
  }
}

/**
 * Idempotent. The migration is a `link()`, so the database resolves by SOME
 * name at every instant; `container-restart` would skip a session that
 * looked vanished instead of fencing it.
 */
export async function migrateInboundDbToHostDir(
  sessionPath: string,
  key: HostInboundSessionKey,
): Promise<InboundMigrationResult> {
  const result: InboundMigrationResult = { outcome: 'absent', removedSidecars: [], replayedCrashJournal: false };
  if (!fs.existsSync(sessionPath)) return { ...result, outcome: 'no-session' };

  const hostDir = hostInboundDirFor(sessionPath);
  const hostPath = hostInboundDbPathFor(sessionPath);
  const legacyPath = legacyInboundDbPathFor(sessionPath);
  fs.mkdirSync(hostDir, { recursive: true });

  const hostExists = fs.existsSync(hostPath);
  const legacyExists = fs.existsSync(legacyPath);
  if (!hostExists && !legacyExists) return result;

  if (hostExists) {
    // PROVENANCE FIRST: a container can create `.host/inbound.db` itself (under
    // an older mount set), and the re-link below would adopt it wholesale. No
    // filesystem signal separates the two, so the central DB (never mounted)
    // answers. A file that can't be identified at all is a vanished session,
    // not a provenance failure.
    const present = fileIdentityOf(hostPath);
    if (!present) throw new SessionDbMissingError(hostPath);
    const recorded = await readHostInboundProvenance(key.agentGroupId, key.sessionId);
    if (!recorded || recorded.device !== present.device || recorded.inode !== present.inode) {
      throw new HostInboundProvenanceError(key.sessionId, hostPath);
    }
    // Past the gate the file is this host's. If the legacy name no longer points
    // at the live inode, the container would read a different database: re-link.
    return asVanished(hostPath, () => {
      // Re-verify the recorded identity against a FRESH stat inside the
      // synchronous act, since the gate awaited. Nothing should substitute the
      // file in that window; this makes it a checked invariant.
      const stillRecorded = fileIdentityOf(hostPath);
      if (!stillRecorded) throw new SessionDbMissingError(hostPath);
      if (stillRecorded.device !== recorded.device || stillRecorded.inode !== recorded.inode) {
        throw new HostInboundProvenanceError(key.sessionId, hostPath);
      }
      const sameInode = legacyExists && fs.statSync(hostPath).ino === fs.statSync(legacyPath).ino;
      if (!sameInode) {
        if (legacyExists) fs.rmSync(legacyPath, { force: true });
        fs.linkSync(hostPath, legacyPath);
        return { ...result, outcome: 'relinked' as const, removedSidecars: removeForeignInboundSidecars(sessionPath) };
      }
      return {
        ...result,
        outcome: 'already-host-owned' as const,
        removedSidecars: removeForeignInboundSidecars(sessionPath),
      };
    });
  }

  // One hard link: no bytes move, and no reader ever finds nothing.
  asVanished(legacyPath, () => fs.linkSync(legacyPath, hostPath));

  // Record provenance immediately; this runs BEFORE the spawn builds mounts
  // and admits the container, or it would not be a gate.
  const created = fileIdentityOf(hostPath);
  if (!created) throw new SessionDbMissingError(hostPath);
  await recordHostInboundProvenance(key.agentGroupId, key.sessionId, created);

  // A legacy journal is either a genuine crash journal or a forgery, and nothing
  // in it tells them apart. The database does: replay only if it is torn
  // without it. The container can't write `inbound.db`, so a forgery meets a
  // healthy database and is discarded. (`quick_check` catches structural
  // tearing, the strongest signal available.)
  const legacyJournal = `${legacyPath}-journal`;
  if (fs.existsSync(legacyJournal)) {
    if (databaseIsIntact(hostPath)) {
      return { ...result, outcome: 'migrated', removedSidecars: removeForeignInboundSidecars(sessionPath) };
    }
    fs.renameSync(legacyJournal, `${hostPath}-journal`);
    replayHotJournal(hostPath);
    return {
      outcome: 'migrated',
      removedSidecars: removeForeignInboundSidecars(sessionPath),
      replayedCrashJournal: true,
    };
  }

  return { ...result, outcome: 'migrated', removedSidecars: removeForeignInboundSidecars(sessionPath) };
}

/**
 * READ-ONLY, so it answers without performing the rollback. Unreadable counts
 * as NOT intact, so an unanswerable database takes the replay path.
 */
function databaseIsIntact(dbPath: string): boolean {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    const rows = db.pragma('quick_check') as Array<{ quick_check?: string }>;
    return rows.length === 1 && rows[0]?.quick_check === 'ok';
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** Same as `recoverHotJournal`, inlined because importing openers.ts here would be a static cycle. */
function replayHotJournal(dbPath: string): void {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    db.pragma('busy_timeout = 5000');
    // Touching the database forces the rollback.
    db.prepare('SELECT 1').get();
  } finally {
    db?.close();
  }
}
