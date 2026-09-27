/**
 * Session-DB open funnels; the mailbox module is the only code that opens a
 * session DB. These are the cross-mount host/container files, not the central DB.
 */
import Database from 'better-sqlite3';
import fs from 'fs';

import { openOutboundDb as upstreamOpenOutboundDb } from '../../mailbox/sqlite/session-db.js';
import { plantStorageActivityMarker } from '../../storage-activity.js';
import { SessionDbMissingError, SessionDbUnopenableError } from './errors.js';
import { sessionDirForInboundDbPath } from './host-inbound.js';

export { SessionDbMissingError, SessionDbUnopenableError } from './errors.js';

/**
 * Only ENOENT/ENOTDIR mean gone. Not `existsSync`, which reports any stat
 * failure (e.g. EACCES on an untraversable parent) as absence; a session must
 * never be declared vanished on a question the filesystem declined to answer.
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
 * SQLite opens lazily, so a corrupt file constructs fine and fails on the first
 * statement, deep in a caller's action; one header read classifies it here.
 * A statement, not a pragma: the cross-mount pragma sequence is pinned by test.
 */
export function assertQueryable(db: Database.Database, dbPath: string): void {
  try {
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
  } catch (err) {
    db.close();
    throw asMissingDbError(err, dbPath);
  }
}

/**
 * `SQLITE_CANTOPEN` is NOT "missing": SQLite reports a present-but-unopenable
 * file (EACCES, EMFILE, full or read-only fs) identically, and misreading it as
 * vanished would leave a present-but-unreadable ingress UNFENCED. So ask the
 * filesystem instead. A present file is wrapped as `SessionDbUnopenableError`
 * (original as `cause`) so the class survives a lazy accessor.
 */
export function asMissingDbError(err: unknown, dbPath: string): unknown {
  if (sessionDbPathIsGone(dbPath)) return new SessionDbMissingError(dbPath);
  return err instanceof SessionDbUnopenableError ? err : new SessionDbUnopenableError(dbPath, err);
}

/**
 * The single read-write inbound funnel, so it plants the storage-activity
 * marker: the reclaim worker is genuinely concurrent, and an opened-but-not-yet-
 * written handle is otherwise invisible to it. The marker lives as long as the
 * HANDLE (released on close()); a leaked handle makes the session unreclaimable,
 * which the reclaim logs. Not upstream's `openInboundDb`, which omits
 * `fileMustExist` and would create an empty stub.
 */
export function openInboundDb(dbPath: string): Database.Database {
  // Checked BEFORE the marker: planting it mkdirs the session root, which would
  // resurrect a just-reclaimed directory. Nothing here may create the file or
  // its parent.
  if (sessionDbPathIsGone(dbPath)) throw new SessionDbMissingError(dbPath);
  // The SESSION root, not dirname(dbPath) (`.host/`): the reclaim reads markers
  // only on the session root.
  const release = plantStorageActivityMarker(sessionDirForInboundDbPath(dbPath), 'inbound-open');
  let db: Database.Database | undefined;
  try {
    // `fileMustExist` closes the race after the check: better-sqlite3 would
    // otherwise create an empty, schemaless file.
    db = new Database(dbPath, { fileMustExist: true });
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    // Close before releasing, or the FD outlives the marker.
    db?.close();
    release();
    // Only a genuinely gone file becomes "missing"; a present-but-unreadable DB
    // keeps its real error.
    throw asMissingDbError(err, dbPath);
  }
  // Known ceiling: better-sqlite3 refuses close() while an iterator is open,
  // which would throw before the marker is released (no non-test caller
  // iterates an inbound handle). Installed BEFORE the readability probe so the
  // probe's close is this patched one and releases the marker.
  const close = db.close.bind(db);
  db.close = function releasingClose(this: Database.Database): Database.Database {
    try {
      return close();
    } finally {
      release();
    }
  };
  assertQueryable(db, dbPath);
  return db;
}

/**
 * Roll back a hot journal before a READ-ONLY open. A SIGKILLed container leaves
 * `<db>-journal`, and reading requires a rollback, which is a write the host's
 * read-only handle can't do: every read then fails, forever. A brief read-write
 * open performs the rollback; safe alongside a running container (DELETE
 * journal + busy_timeout on both sides). Best-effort: on failure the real open
 * surfaces the error.
 */
export function recoverHotJournal(dbPath: string): boolean {
  if (!fs.existsSync(`${dbPath}-journal`) || !fs.existsSync(dbPath)) return false;
  try {
    const db = new Database(dbPath);
    db.pragma('busy_timeout = 5000');
    // Touching the DB forces the rollback.
    db.prepare('SELECT 1').get();
    db.close();
    return !fs.existsSync(`${dbPath}-journal`);
  } catch {
    return false;
  }
}

/**
 * A readonly open never creates a file; missing is normalized only for a
 * uniform error. The open itself delegates to upstream's `openOutboundDb`.
 */
export function openOutboundDb(dbPath: string): Database.Database {
  recoverHotJournal(dbPath);
  let db: Database.Database;
  try {
    db = upstreamOpenOutboundDb(dbPath);
  } catch (err) {
    throw asMissingDbError(err, dbPath);
  }
  assertQueryable(db, dbPath);
  return db;
}

/**
 * Writable outbound, for the narrow pre-wake deny/flag-confirmation write and
 * post-kill orphan-claim cleanup. Not upstream's `openOutboundDbRw`, which
 * omits `fileMustExist`: the host must never provision outbound.db.
 */
export function openOutboundDbWritable(dbPath: string): Database.Database {
  // The container provisions outbound.db, so a missing file is a vanished
  // session; same two-part guard as the inbound funnel.
  if (sessionDbPathIsGone(dbPath)) throw new SessionDbMissingError(dbPath);
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { fileMustExist: true });
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    // A pragma failure is also "present but unopenable". Close before
    // rethrowing: leaving it to GC holds the descriptor and locks, and retries
    // amplify into descriptor exhaustion.
    db?.close();
    throw asMissingDbError(err, dbPath);
  }
  assertQueryable(db, dbPath);
  return db;
}
