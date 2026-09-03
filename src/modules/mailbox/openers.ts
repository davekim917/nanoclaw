/**
 * Session-DB open funnels for the fork's mailbox implementation.
 *
 * Internal to `src/modules/mailbox/` — the module is the only code that opens
 * a session DB. `src/db/session-db.ts` re-exports these while the caller
 * migration (docs/specs/upstream-mailbox-seam/plan.md PRs 3-6) is in flight;
 * PR 7 deletes that façade.
 *
 * These are NOT the central app DB — they're the cross-mount SQLite files
 * shared between host and container. See session-manager.ts header for the
 * cross-mount visibility invariants.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { openOutboundDb as upstreamOpenOutboundDb } from '../../mailbox/sqlite/session-db.js';
import { plantStorageActivityMarker } from '../../storage-activity.js';

/**
 * A host open found no database file where a provisioned session must have one.
 *
 * Every host-side open funnel refuses to create the file, so callers get this
 * instead of an empty stub. `ensureSchema` is the only host-side creator; a
 * caller that legitimately provisions a session goes through
 * `initSessionFolder`/`initStubSessionFolder`, never through an open.
 */
export class SessionDbMissingError extends Error {
  constructor(readonly dbPath: string) {
    super(`session database does not exist: ${dbPath}`);
    this.name = 'SessionDbMissingError';
  }
}

/**
 * Is this path genuinely gone, as opposed to unanswerable?
 *
 * `fs.existsSync` cannot tell those apart: it returns false for ANY stat
 * failure, including EACCES when a parent directory has lost search permission.
 * A session whose directory the host merely cannot traverse is present, and
 * calling it vanished is the same mistake as trusting `SQLITE_CANTOPEN` — one
 * level further down. Only ENOENT (no such entry) and ENOTDIR (a path component
 * is not a directory) mean gone; every other errno means the filesystem
 * declined to answer, and no session may be declared vanished on a question
 * that was never answered.
 */
export function sessionDbPathIsGone(dbPath: string): boolean {
  try {
    fs.statSync(dbPath);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

/**
 * Translate an open failure to `SessionDbMissingError` ONLY when the path has
 * actually gone.
 *
 * `SQLITE_CANTOPEN` is not a synonym for "missing". SQLite raises the identical
 * code and message ("unable to open database file") for a file that is PRESENT
 * but unopenable — EACCES on a mode-000 file, EMFILE and other descriptor
 * exhaustion, a full or read-only filesystem. Sniffing the code would report
 * every one of those as a vanished session, and `container-restart`'s
 * skip-the-vanished branch would then silently leave a session whose ingress is
 * present but unreadable UNFENCED — the exact case that must fail closed.
 *
 * Asking the filesystem answers that and better-sqlite3's other shape (a plain
 * `TypeError` from its own pre-check when the parent DIRECTORY is missing) with
 * one question, and needs no list of SQLite error codes to stay current — but
 * it has to be a stat whose errno is read, not `existsSync`, which reports an
 * unreadable parent directory as absence.
 *
 * It settles a post-constructor failure too, without a second try block: a
 * pragma that throws while the file is still there rethrows untouched, and one
 * that throws on a file that vanished underneath the handle is a vanished
 * session by any honest reading.
 */
export function asMissingDbError(err: unknown, dbPath: string): unknown {
  return sessionDbPathIsGone(dbPath) ? new SessionDbMissingError(dbPath) : err;
}

/**
 * Open the inbound DB for a session (host reads/writes).
 *
 * This is the single funnel every read-write inbound open passes through, so
 * it is where the storage-activity marker goes. The session reclaim runs in a
 * worker thread and its archive-then-delete is genuinely concurrent with this
 * one; without a marker, a writer that has opened but not yet written is
 * invisible to it and the row lands in an inode the reclaim then unlinks.
 * Guarding the funnel rather than each writer is what keeps the next writer
 * from having to remember.
 *
 * The marker's lifetime is the HANDLE's, not this function's, so the release
 * hangs off close(). A caller that leaks the handle leaks the marker and its
 * session stops being reclaimable — `tryRunWithStorageCleanupClaim` logs every
 * such skip so that is loud rather than silent.
 *
 * Not a wrapper around upstream's `openInboundDb`: that one omits
 * `fileMustExist`, so it would create the empty stub this funnel exists to
 * prevent. The PRAGMA set and order are the same (H-3 pins them).
 */
export function openInboundDb(dbPath: string): Database.Database {
  // Checked BEFORE the marker, not after: plantStorageActivityMarker does a
  // recursive mkdir of the session root, so a reclaim that has just removed
  // the whole directory would see it resurrected by the very call meant to
  // protect a live session. On 2026-09-01 that recreated a reclaimed session
  // directory holding nothing but a 0-byte inbound.db, which then crash-looped
  // the host at startup. Nothing here may create either the file or its parent.
  // `sessionDbPathIsGone`, not existsSync: an unreadable parent directory is a
  // present session, and must reach the open and fail there on its real error.
  if (sessionDbPathIsGone(dbPath)) throw new SessionDbMissingError(dbPath);
  const release = plantStorageActivityMarker(path.dirname(dbPath), 'inbound-open');
  let db: Database.Database | undefined;
  try {
    // `fileMustExist` closes the residual window between the check above and
    // this open: better-sqlite3 otherwise CREATES an empty file, and an empty
    // file is a schemaless database every later caller throws on.
    db = new Database(dbPath, { fileMustExist: true });
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    // A pragma can throw after the handle exists, so close what was created
    // before releasing — otherwise the FD outlives the marker.
    db?.close();
    release();
    // One error type for "vanished", whichever side of the check lost the race.
    // Anything still on disk keeps its original error: a present-but-unreadable
    // DB is a real fault, and callers must not mistake it for a gone session.
    throw asMissingDbError(err, dbPath);
  }
  // ponytail: patching close() beats a wrapper type — every existing caller
  // already closes, and a new return type would touch all ~20 of them. Known
  // ceiling: better-sqlite3 refuses close() while an iterator is open, which
  // would throw before the marker is released. No non-test caller iterates an
  // inbound handle today; revisit with an explicit release if one appears.
  const close = db.close.bind(db);
  db.close = function releasingClose(this: Database.Database): Database.Database {
    try {
      return close();
    } finally {
      release();
    }
  };
  return db;
}

/**
 * Roll back a hot journal before a READ-ONLY open.
 *
 * When a container is SIGKILLed mid-transaction (exit 137 / OOM kill), SQLite
 * leaves a `<db>-journal` next to outbound.db. Any later connection must roll
 * that journal back BEFORE it can read — and a rollback is a WRITE. The host's
 * outbound handle is read-only by design (the container owns writes), so it
 * can't perform the rollback, and every read fails with "attempt to write a
 * readonly database" — including the plain SELECT at the top of
 * `syncProcessingAcks`.
 *
 * That state is permanent and self-sustaining: the sweep can never mark those
 * messages complete, so it retries the same session every 60s forever. Observed
 * in the wild across 42 sessions and ~4k log errors before this fix.
 *
 * A brief read-write open lets SQLite perform the rollback and delete the
 * journal, restoring a consistent DB; the normal read-only path then works.
 * Safe alongside a running container — both sides use DELETE journal +
 * busy_timeout, the same basis on which `writeOutboundDirect` already writes
 * here. Best-effort: if recovery fails we fall through and let the real open
 * surface the error rather than masking it.
 */
export function recoverHotJournal(dbPath: string): boolean {
  if (!fs.existsSync(`${dbPath}-journal`) || !fs.existsSync(dbPath)) return false;
  try {
    const db = new Database(dbPath);
    db.pragma('busy_timeout = 5000');
    // Touching the DB is what forces the rollback; the read itself is incidental.
    db.prepare('SELECT 1').get();
    db.close();
    return !fs.existsSync(`${dbPath}-journal`);
  } catch {
    return false;
  }
}

/**
 * Open the outbound DB for a session (host reads only).
 *
 * A readonly open never creates a file, so this funnel is already incapable of
 * leaving a stub behind; it is normalized to `SessionDbMissingError` only so
 * every host-side open reports a vanished session the same way.
 *
 * Delegates the open itself to upstream's `openOutboundDb` — the SQL/pragma
 * body is identical, so an upstream change to it lands here without a fork
 * edit. The hot-journal recovery and the error normalization are the fork's.
 */
export function openOutboundDb(dbPath: string): Database.Database {
  // Cheap existsSync guard — no cost on the normal path, where no journal exists.
  recoverHotJournal(dbPath);
  try {
    return upstreamOpenOutboundDb(dbPath);
  } catch (err) {
    throw asMissingDbError(err, dbPath);
  }
}

/**
 * Open the outbound DB writable. Normal host path is read-only (the container
 * owns writes); this exists for the narrow pre-wake case where the host emits
 * a deny/flag-confirmation directly to outbound, and for orphan-claim cleanup
 * after a container is killed.
 *
 * Not a wrapper around upstream's `openOutboundDbRw` for the same reason the
 * inbound funnel isn't: upstream omits `fileMustExist`, so it would create the
 * outbound file the host must never provision.
 */
export function openOutboundDbWritable(dbPath: string): Database.Database {
  // The host never provisions outbound.db — the container does — so a missing
  // file here is a vanished session, never something to create. Same two-part
  // guard as the inbound funnel: the check answers fast, `fileMustExist` closes
  // the race after it, and only a real ENOENT/ENOTDIR counts as gone.
  if (sessionDbPathIsGone(dbPath)) throw new SessionDbMissingError(dbPath);
  let db: Database.Database;
  try {
    db = new Database(dbPath, { fileMustExist: true });
  } catch (err) {
    throw asMissingDbError(err, dbPath);
  }
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  return db;
}

// Alias for the upstream name; both reach the same writable open path.
export const openOutboundDbRw = openOutboundDbWritable;
