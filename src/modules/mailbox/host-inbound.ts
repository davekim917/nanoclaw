/**
 * Where the host keeps a session's `inbound.db`, and how a session gets moved
 * there.
 *
 * THE DEFECT THIS CLOSES (the same class as the archive projection's writable sidecar).
 * `inbound.db` is host-authoritative and container-read-only: the host writes
 * the `delivered` rows that gate admin approvals, the email gate and the
 * send_file ack, and `messages_in` drives due-message wake, recurrence and
 * agent-to-agent routing. The container was blocked from forging those rows by
 * a FILE-level read-only overlay (`src/container-runner.ts`). That overlay
 * covers the file and nothing else, while the session directory around it is
 * bind-mounted READ-WRITE at `/workspace` — so a container could create
 * `/workspace/inbound.db-journal` beside it. A SQLite rollback journal carries
 * no binding to the identity of the database it belongs to (its per-page
 * checksums are seeded by a nonce in the journal's OWN header), so a journal
 * hand-built by a container is replayed verbatim as a HOT journal by the
 * host's next read-write open, writing attacker-chosen pages into the
 * host-owned database. A forged `delivered` row was landed this way in a
 * proof of concept.
 *
 * WHY THE ARCHIVE PROJECTION'S FIX CANNOT BE COPIED. The projection is derived state
 * with a freshness stamp, so it can simply DELETE any sidecar before every
 * read-write open and rebuild from source. `inbound.db` is authoritative and
 * has no rebuild path: a genuine journal left by a host crash mid-write MUST
 * still be replayed, or the file is left torn. "Delete every journal" and
 * "replay every journal" are both wrong here.
 *
 * THE FIX IS STRUCTURAL, NOT A GUARD. SQLite only ever creates a sidecar
 * (`-journal`, `-wal`, `-shm`) in the database's OWN directory. So the host
 * keeps `inbound.db` in a directory the container cannot write —
 * `<session>/.host/` — which is bind-mounted into the container READ-ONLY AS A
 * DIRECTORY. There is then no sibling path left outside the protection, which
 * is the categorical difference from the file-level overlay that failed: the
 * host's journal is created inside the read-only mount, where the container
 * cannot create, modify or delete it. Nothing is left to remember at the open
 * sites — every host opener simply resolves through here.
 *
 * WHY THE LEGACY NAME SURVIVES. `<session>/inbound.db` is kept as a HARD LINK
 * to the same inode, for two reasons, and it costs nothing:
 *
 *  - Rollback. Sessions are live during a deploy. A revert to a binary that
 *    looks for `<session>/inbound.db` finds its file, with its data, rather
 *    than concluding the session was never provisioned and creating an empty
 *    one over it (which would lose messages and re-deliver).
 *  - The container's read path is unchanged. The runner still opens
 *    `/workspace/inbound.db` (`container/agent-runner/src/mailbox/sqlite/connection.ts`)
 *    through the existing read-only file overlay, so this needs no runner
 *    change, no image rebuild, and no restart of running containers. A hard
 *    link is the SAME inode, so the container sees every host write, and
 *    SQLite's locking — which is per-inode, not per-path — still serializes
 *    host writer against container reader exactly as before.
 *
 * A write THROUGH the legacy name is still refused by the read-only file
 * overlay that has always covered it; that control is unchanged and still
 * load-bearing. What this module adds is that the JOURNAL path the host
 * actually resolves is no longer reachable from the container at all.
 *
 * KNOWN RESIDUE, stated rather than papered over: because the host's journal
 * now lives in `.host/` and the container reads the legacy name, the container
 * can no longer SEE a genuine host-crash journal, where before it would have
 * failed its read loudly. The window is "the host died mid-write and has not
 * yet restarted"; SQLite's per-inode locking still prevents a torn read while
 * the host is alive, the pages at risk belong to a transaction that never
 * committed, and the first host read-write open after restart replays the
 * journal through this module. Closing even that would mean pointing the
 * runner at `.host/inbound.db`, which is a container-side change this
 * deliberately does not make.
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
 * The host-owned directory inside a session directory.
 *
 * Dot-prefixed so it reads as infrastructure next to the agent's own files,
 * and short because it appears in the container as `/workspace/.host`.
 *
 * Safe against every directory walker in the tree, which is why the host-owned
 * directory is INSIDE the session directory rather than a sibling of it: the
 * reclaim's regenerable sweep only ever takes the four names in
 * `REGENERABLE_SWEEP_DIR_NAMES` (`src/storage-manager.ts`), the session
 * reclaim requires a `sess-` prefix, and a
 * session directory's contents are already arbitrary. A sibling directory at
 * the agent-group level would instead have been enumerated as a SESSION by
 * `resourceRoots` (`src/storage-activity.ts`), which has no dot-prefix
 * skip, and would have had to be taught to five separate walkers.
 */
export const HOST_INBOUND_DIR_NAME = '.host';

const SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm'] as const;

/** The host-owned directory for one session's inbound database. */
export function hostInboundDirFor(sessionPath: string): string {
  return path.join(sessionPath, HOST_INBOUND_DIR_NAME);
}

/** Where the host keeps this session's `inbound.db`. */
export function hostInboundDbPathFor(sessionPath: string): string {
  return path.join(hostInboundDirFor(sessionPath), 'inbound.db');
}

/** The legacy location, kept as a hard link to the same inode. */
export function legacyInboundDbPathFor(sessionPath: string): string {
  return path.join(sessionPath, 'inbound.db');
}

/**
 * The SESSION directory an inbound database path belongs to.
 *
 * The inverse of `hostInboundDbPathFor`, and it has to exist: the
 * storage-activity marker that keeps a reclaim off a session being written is
 * planted on the session ROOT (`openInboundDb`),
 * and `path.dirname` of a host-owned inbound path is now `.host`, not the
 * session. Planting there would put the marker somewhere the reclaim never
 * looks — `resourceRoots` enumerates `v2-sessions/<group>/<session>` and
 * nothing below it — so the guard would
 * still appear to work while protecting nothing.
 *
 * A path that is not host-owned answers with its own directory, so a caller
 * holding a legacy or a test-fixture path is unaffected.
 */
export function sessionDirForInboundDbPath(dbPath: string): string {
  const parent = path.dirname(dbPath);
  return path.basename(parent) === HOST_INBOUND_DIR_NAME ? path.dirname(parent) : parent;
}

/**
 * Sidecars sitting at the LEGACY path, which are foreign by construction.
 *
 * Once a session is migrated the host never journals beside the legacy name
 * again, so anything found there was created by a container. This is the archive
 * projection's delete-before-open rule applied at the one place it is provably safe — and
 * deleting matters beyond tidiness: a planted `inbound.db-journal` makes every
 * READ-ONLY open of the legacy name fail (a read-only handle cannot perform
 * the rollback a hot journal owes), which is `dbHasRows`
 * reporting a session unreadable and the
 * reclaim then failing closed on it forever.
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
 * The two read-only mounts that expose a session's inbound database to its
 * container.
 *
 * Built here, beside the layout they depend on, so the protection and the
 * thing it protects cannot drift apart in separate files — and so the spawn
 * path's guarantee is unit-testable without standing up a whole spawn.
 *
 *  - `/workspace/.host` READ-ONLY, as a DIRECTORY. This is the fix: SQLite
 *    only ever creates `-journal`/`-wal`/`-shm` in the database's own
 *    directory, so overlaying the directory leaves no sibling path outside the
 *    protection. The container cannot create, modify or delete the host's
 *    journal, which a writable journal would turn into forged `delivered` rows.
 *  - `/workspace/inbound.db` READ-ONLY, the legacy hard link, so the runner's
 *    unchanged read path (`container/agent-runner/src/mailbox/sqlite/connection.ts`)
 *    still resolves. This is the control that has always refused a direct
 *    write through that name, and it is unchanged.
 *
 * Both are unconditional: the caller migrates first and refuses to spawn if
 * the database is not host-owned, so there is no "file missing" case left to
 * guard — the conditional mount this replaced was how a session could come up
 * with no overlay at all.
 */
export function hostInboundMounts(
  sessionPath: string,
): Array<{ hostPath: string; containerPath: string; readonly: boolean }> {
  return [
    { hostPath: hostInboundDirFor(sessionPath), containerPath: '/workspace/.host', readonly: true },
    { hostPath: legacyInboundDbPathFor(sessionPath), containerPath: '/workspace/inbound.db', readonly: true },
  ];
}

/**
 * Remove the host-owned directory outright, for a session being destroyed.
 *
 * Upstream's `destroy` only knows the legacy name and its sidecars
 * (`src/mailbox/sqlite/index.ts`); the host-owned copy and its journal
 * sit one level down and would otherwise outlive the session that owned them.
 * Lives here rather than at the caller so the layout has one definition.
 */
export function removeHostInboundDir(sessionPath: string): void {
  fs.rmSync(hostInboundDirFor(sessionPath), { recursive: true, force: true });
}

/**
 * Refuse to start a container for a session whose database is not host-owned.
 *
 * This is where the transitional legacy-path fallback in `resolveInboundDbPath`
 * has to stop. The fallback exists so a host that has not migrated a session
 * yet still reads the right file; a CONTAINER is the only thing that can plant
 * a journal, so the one moment the fallback must never be the running state is
 * the moment a container is about to be handed the session. Fail closed — the
 * spawn retries, rather than coming up with the database sitting in a
 * directory the container can write.
 */
export function assertHostOwnedInboundDb(sessionPath: string, sessionId: string): void {
  if (inboundDbIsHostOwned(sessionPath)) return;
  throw new Error(`Session ${sessionId} has no host-owned inbound.db; refusing to spawn. Spawn will retry.`);
}

/** Is this session's inbound database already host-owned? */
export function inboundDbIsHostOwned(sessionPath: string): boolean {
  return fs.existsSync(hostInboundDbPathFor(sessionPath));
}

/**
 * Where a host opener should open this session's `inbound.db`.
 *
 * Host-owned when it is there, the legacy path when only that is (a session
 * this host has not migrated yet, and every hand-built test fixture), and the
 * host-owned path when neither exists so a fresh session is provisioned in the
 * right place. The legacy fallback is a TRANSITION, not a resting state: the
 * spawn path refuses to start a container for a session that is not host-owned
 * (`src/container-runner.ts`), and a container is the only thing that can
 * plant a journal — so the fallback can never be the state an attacker is
 * running against.
 */
export function resolveInboundDbPath(sessionPath: string): string {
  const hostOwned = hostInboundDbPathFor(sessionPath);
  if (fs.existsSync(hostOwned)) return hostOwned;
  return fs.existsSync(legacyInboundDbPathFor(sessionPath)) ? legacyInboundDbPathFor(sessionPath) : hostOwned;
}

/**
 * Which session a migration is for.
 *
 * Passed explicitly rather than parsed back out of `sessionPath`: the
 * provenance record this migration writes and checks is keyed by the same
 * (agent group, session) pair the rest of the central DB uses, and deriving
 * that from a filesystem path would make the gate depend on the data directory
 * layout — a path that moves would silently read as "no record", which is a
 * refusal, for every session at once.
 */
export interface HostInboundSessionKey {
  agentGroupId: string;
  sessionId: string;
}

type InboundMigrationOutcome =
  /** No session directory — nothing to do. */
  | 'no-session'
  /** Neither path holds a database yet; the caller provisions at the host path. */
  | 'absent'
  /** Already host-owned, with the legacy hard link intact. */
  | 'already-host-owned'
  /** Moved to the host-owned path by this call. */
  | 'migrated'
  /** Host-owned, and the legacy hard link was re-pointed at the live inode. */
  | 'relinked';

export interface InboundMigrationResult {
  outcome: InboundMigrationOutcome;
  /** Legacy sidecar suffixes discarded as foreign. */
  removedSidecars: string[];
  /** True when a genuine crash journal was carried across and replayed. */
  replayedCrashJournal: boolean;
}

/**
 * Make this session's `inbound.db` host-owned, idempotently.
 *
 * Ordering is chosen so the database is reachable by SOME name at every
 * instant — the migration is a `link()`, never a window in which neither path
 * resolves. A host opener racing this therefore cannot see a vanished session,
 * which matters because `container-restart` treats a vanished session as one
 * to skip rather than fence.
 */
/**
 * Run filesystem work that trusted an `existsSync`, reporting a session that
 * vanished underneath it as one.
 *
 * `existsSync` answered a moment ago, and the answer can be stale by the time
 * the `stat`/`link` runs: the session reclaim deletes whole session directories
 * from a worker thread, concurrently with host
 * work on the same session. That is the very race `openInboundDb` is built
 * around, and leaving it unguarded costs more than an
 * ugly stack — a raw `ENOENT … link` is not the class callers branch on.
 * `container-restart`, `delivery` and the sweep all key their
 * skip-the-vanished-session path on `SessionDbMissingError`, so an unmapped
 * errno fails a whole tick instead of skipping one dead session.
 *
 * Wraps the whole trust-then-act region rather than the link alone: the
 * already-migrated branch `stat`s BOTH names before it links, and a stat on a
 * reclaimed session throws the same raw errno one line earlier.
 *
 * Only ENOENT/ENOTDIR are mapped, matching `sessionDbPathIsGone`'s rule
 * in `openers.ts`: every other errno means the filesystem declined to
 * answer, and no session may be declared vanished on an unanswered question.
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
    // PROVENANCE FIRST, before anything below reads or adopts this file.
    //
    // A container can create `.host/inbound.db` itself. Under a mount set built
    // before the directory existed, `/workspace` is read-write and nothing is
    // overlaid over `.host`, so `mkdir` and a write both succeed and land
    // host-side — verified in Docker against the production image. Everything
    // below this line assumes the host-owned file IS the host's; the re-link
    // branch in particular deletes the legacy file and re-points the name at
    // whatever inode is here, which for a planted file means adopting the
    // attacker's database wholesale and orphaning the real one.
    //
    // No filesystem signal can separate the two — same uid, attacker-chosen
    // mode and timestamps, and inode identity only says "not produced by a
    // linkSync migration", which is also true of the legitimate rolled-back
    // host this branch exists to serve. So the question is answered from the
    // central DB, which no container can write. See migration 079.
    // Which failure is this? A host file that cannot be identified at all is a
    // VANISHED session, not a provenance failure — the reclaim deletes session
    // directories concurrently with this, and callers branch on
    // `SessionDbMissingError` to skip one rather than fail their whole tick.
    // Ask the filesystem before deciding what to raise, or a reclaimed session
    // would surface as a security refusal and send an operator hunting a
    // planted file that was never there.
    const present = fileIdentityOf(hostPath);
    if (!present) throw new SessionDbMissingError(hostPath);
    const recorded = await readHostInboundProvenance(key.agentGroupId, key.sessionId);
    if (!recorded || recorded.device !== present.device || recorded.inode !== present.inode) {
      throw new HostInboundProvenanceError(key.sessionId, hostPath);
    }
    // Past the gate the file is known to be this host's, so the inode
    // comparison below is what it was always honestly written as — a
    // consistency repair, not a security decision.
    // Already migrated. The only thing left to verify is that the legacy name
    // still points at the LIVE inode: if the two have diverged (a legacy stub
    // recreated by an older binary, or a rolled-back host that provisioned a
    // fresh file over the name) the container's read path would be serving a
    // different database than the host writes. Re-link rather than trust it.
    return asVanished(hostPath, () => {
      // Re-verify the identity the record named, against a FRESH stat, inside
      // the synchronous act. The gate above had to await the central DB, and an
      // `await` in a decide-then-act path is exactly where a check-then-use gap
      // appears. Analysis says nothing can substitute the file in that window —
      // no container for this session exists while the spawn runs (the previous
      // one is gone before the respawn, the next does not exist until the mount
      // set is built), and a second concurrent migration for one session is
      // impossible because `buildMounts` runs inside the `spawningSessions`
      // span and a second wake reuses the in-flight `wakePromises` entry
      // (`src/container-runner.ts`). This makes that an invariant the code
      // checks rather than one the reader has to take on trust; the reclaim can
      // still delete the file, which `asVanished` reports as a vanished
      // session.
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

  // The migration itself: one hard link, so both names resolve to the one
  // inode from here on. No bytes move, so this is atomic in the only sense
  // that matters — there is no moment at which a reader finds nothing.
  asVanished(legacyPath, () => fs.linkSync(legacyPath, hostPath));

  // Record that THIS HOST created it, immediately — and note where this runs:
  // inside the migration, which the spawn path calls BEFORE it builds the mount
  // set and admits the container (`src/container-runner.ts`). A record written
  // after admission would not be a gate. Every later spawn checks this row
  // before it will touch the file again.
  const created = fileIdentityOf(hostPath);
  if (!created) throw new SessionDbMissingError(hostPath);
  await recordHostInboundProvenance(key.agentGroupId, key.sessionId, created);

  // Now the journal question, and it is the delicate one. A journal sitting at
  // the legacy path is EITHER a genuine crash journal this host owes a replay
  // to, OR a container's forgery. Nothing in the file distinguishes them.
  //
  // What does distinguish them is the DATABASE: a rollback journal exists to
  // UNDO a transaction that never committed, so if the database is
  // self-consistent without it, replaying it would restore pages nobody is
  // missing, and discarding it loses nothing that was ever committed. Only a
  // database left structurally torn by an interrupted write actually needs the
  // replay. So: ask the database, and replay only when it says it is broken.
  //
  // The container cannot influence that answer — it cannot write `inbound.db`
  // itself, only the sidecar — so a forged journal meets a healthy database
  // and is discarded, while a real crash meets a torn one and is replayed.
  // (`quick_check` catches structural tearing, not every conceivable
  // semantically-partial write; it is the strongest signal available and
  // strictly better than the unconditional replay this replaces.)
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
 * Does this database stand on its own, with no journal beside it?
 *
 * Deliberately a READ-ONLY open: it must answer the question without
 * performing the very rollback the caller has not yet decided to allow.
 * Unreadable counts as NOT intact, so an unanswerable database takes the
 * replay path rather than silently discarding a journal it may have needed.
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

/**
 * Let SQLite roll a genuine crash journal back, by touching the database.
 *
 * The same mechanism as `recoverHotJournal` in `openers.ts`,
 * inlined rather than imported: `openers.ts` imports the session-directory
 * helper from this module for its activity marker, and a static cycle between
 * the two is exactly the shape the host's ESM rules warn about.
 */
function replayHotJournal(dbPath: string): void {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    db.pragma('busy_timeout = 5000');
    // Touching the database is what forces the rollback; the read is incidental.
    db.prepare('SELECT 1').get();
  } finally {
    db?.close();
  }
}
