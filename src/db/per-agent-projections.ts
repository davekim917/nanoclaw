/**
 * Per-agent projections of `archive.db` and `central.db` (`v2.db`).
 * SECURITY: the container has shell and raw SQLite access at /workspace, so mounting the global files would expose
 * every tenant's chat history and topology (the MCP query filters are advisory). Each container gets a projection
 * holding ONLY its own scope's rows, regenerated at spawn; host writes mid-session appear at the next wake. Files
 * live at `data/v2-sessions/<ag>/<sess>/archive.db` and `central.db`.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';

/**
 * Archive projection schema. Rows for workgroup siblings are deduplicated on (messaging_group_id, thread_id, role,
 * sender_id, sent_at, text), MIN id for determinism; assistant rows survive because their sender_id differs. Fails
 * closed when the caller's workgroup_id is NULL.
 * Declared fresh rather than copied from sqlite_master: that would also copy FTS5 shadow tables, which conflict with
 * the virtual table's auto-creation. The AFTER INSERT trigger populates FTS.
 */
const ARCHIVE_SCHEMA_SQL = `
  CREATE TABLE messages_archive (
    id                  TEXT PRIMARY KEY,
    agent_group_id      TEXT NOT NULL,
    messaging_group_id  TEXT,
    channel_type        TEXT NOT NULL,
    platform_id         TEXT,
    thread_id           TEXT,
    role                TEXT NOT NULL,
    sender_id           TEXT,
    sender_name         TEXT,
    text                TEXT NOT NULL,
    sent_at             TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    channel_name        TEXT
  );
  CREATE INDEX idx_archive_ag_sent ON messages_archive(agent_group_id, sent_at);
  CREATE INDEX idx_archive_thread ON messages_archive(agent_group_id, thread_id, sent_at);
  CREATE INDEX idx_archive_channel ON messages_archive(channel_type, platform_id, thread_id);
  CREATE VIRTUAL TABLE messages_archive_fts USING fts5(
    text, sender_name, content='messages_archive', content_rowid='rowid'
  );
  CREATE TRIGGER messages_archive_ai AFTER INSERT ON messages_archive BEGIN
    INSERT INTO messages_archive_fts(rowid, text, sender_name)
    VALUES (new.rowid, new.text, new.sender_name);
  END;
  CREATE TRIGGER messages_archive_ad AFTER DELETE ON messages_archive BEGIN
    INSERT INTO messages_archive_fts(messages_archive_fts, rowid, text, sender_name)
    VALUES ('delete', old.rowid, old.text, old.sender_name);
  END;
  CREATE TRIGGER messages_archive_au AFTER UPDATE ON messages_archive BEGIN
    INSERT INTO messages_archive_fts(messages_archive_fts, rowid, text, sender_name)
    VALUES ('delete', old.rowid, old.text, old.sender_name);
    INSERT INTO messages_archive_fts(rowid, text, sender_name)
    VALUES (new.rowid, new.text, new.sender_name);
  END;
`;

/**
 * Removes rollback-journal/WAL sidecars beside a projection before the host opens it read-write; returns the suffixes
 * deleted.
 * The session directory is mounted READ-WRITE at `/workspace` (only `archive.db` itself is re-overlaid read-only), so
 * a container can plant `archive.db-journal`. SQLite replays a well-formed journal beside a non-empty database as a
 * HOT journal on the next read-write open, writing attacker-chosen pages into the host-owned projection (the journal
 * is not bound to the database's identity; verified against better-sqlite3 11.10.0), and seeding would copy the
 * poison into other sessions.
 * Deleting is safe: the host is the sole legitimate writer, never opens one file twice concurrently, and every close
 * under `journal_mode = DELETE` removes its journal. A host crash mid-append leaves no freshness stamp, so the next
 * spawn rebuilds rather than replaying. Called at BOTH write opens, so safety does not rest on SQLite treating a
 * journal beside a zero-page file as stale.
 */
export function removeStaleProjectionSidecars(dstPath: string): string[] {
  const removed: string[] = [];
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecar = `${dstPath}${suffix}`;
    try {
      // Unlink the entry itself: existsSync follows symlinks and misses dangling ones.
      fs.unlinkSync(sidecar);
      removed.push(suffix);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return removed;
}

const ARCHIVE_COLS = [
  'id',
  'agent_group_id',
  'messaging_group_id',
  'channel_type',
  'platform_id',
  'thread_id',
  'role',
  'sender_id',
  'sender_name',
  'text',
  'sent_at',
  'created_at',
  'channel_name',
];

/**
 * `workgroupMemberIds` is resolved by the caller from the central DB (archive.db has no agent_groups schema). An
 * empty array yields zero rows (the caller's fail-closed case); undefined means the legacy single-agent filter.
 */
export function buildArchiveProjection(
  srcPath: string,
  dstPath: string,
  agentGroupId: string,
  workgroupMemberIds?: string[],
): number {
  removeStaleProjectionSidecars(dstPath);
  if (fs.existsSync(dstPath)) fs.unlinkSync(dstPath);
  const dst = new Database(dstPath);
  try {
    dst.exec(ARCHIVE_SCHEMA_SQL);
    if (!fs.existsSync(srcPath)) {
      // No source yet: an empty projection is correct.
      return 0;
    }
    const src = openArchiveSourceForRead(srcPath);
    try {
      // `.all()`, deliberately NOT `.iterate()`: `archive.db` runs `journal_mode = TRUNCATE`, where a reader blocks a
      // writer, and an open iterator would hold the read lock through the whole insert phase, stalling or failing the
      // host's synchronous `archiveMessage` writer. WAL is ruled out because containers read archive.db through a
      // read-only mount with no sidecars. The memory cost lands on the projection worker thread.
      let rows: Array<Record<string, unknown>>;
      if (workgroupMemberIds && workgroupMemberIds.length > 0) {
        // Workgroup widening is intentional (the workgroup is the data-pool boundary; container-runner's
        // NULL-workgroup guard enforces it). agent_group_id is set to the spawning agent, not MIN() of the bucket:
        // after dedup a row has no single source agent.
        const placeholders = workgroupMemberIds.map(() => '?').join(', ');
        rows = src
          .prepare(
            `SELECT
               MIN(id)               AS id,
               messaging_group_id,
               MAX(channel_type)     AS channel_type,
               MAX(channel_name)     AS channel_name,
               MAX(platform_id)      AS platform_id,
               thread_id,
               role,
               sender_id,
               MAX(sender_name)      AS sender_name,
               text,
               sent_at,
               MIN(created_at)       AS created_at
             FROM messages_archive
             WHERE agent_group_id IN (${placeholders})
             GROUP BY messaging_group_id, thread_id, role, sender_id, sent_at, text`,
          )
          .all(...workgroupMemberIds) as Array<Record<string, unknown>>;
      } else {
        // Legacy single-agent filter.
        rows = src
          .prepare(`SELECT ${ARCHIVE_COLS.join(', ')} FROM messages_archive WHERE agent_group_id = ?`)
          .all(agentGroupId) as Array<Record<string, unknown>>;
      }

      const colList = ARCHIVE_COLS.join(', ');
      const placeholders = ARCHIVE_COLS.map(() => '?').join(', ');
      const insertStmt = dst.prepare(`INSERT INTO messages_archive (${colList}) VALUES (${placeholders})`);
      const insertMany = dst.transaction((batch: Array<Record<string, unknown>>) => {
        for (const row of batch) {
          // Every row is attributed to the spawning agent; see the widened SELECT.
          insertStmt.run(...ARCHIVE_COLS.map((c) => (c === 'agent_group_id' ? agentGroupId : row[c])));
        }
      });
      insertMany(rows);
      return rows.length;
    } finally {
      src.close();
    }
  } catch (err) {
    log.error('buildArchiveProjection failed', { err, agentGroupId, dstPath });
    // Rethrow: the spawn must abort rather than mount an empty projection that looks valid.
    throw err;
  } finally {
    dst.close();
  }
}

/**
 * Everything the projection's contents depend on, recorded so a spawn can tell from two index-only counts (no read of
 * the large source) whether its file is current, and whether the difference is only appended rows.
 * Bump `ARCHIVE_PROJECTION_STAMP_VERSION` whenever `buildArchiveProjection`'s output changes for identical inputs
 * (schema, dedup grouping, columns).
 */
export const ARCHIVE_PROJECTION_STAMP_VERSION = 2;

export interface ArchiveProjectionStamp {
  version: number;
  agentGroupId: string;
  /** Sorted member ids, or null for the legacy single-agent filter. */
  scope: string[] | null;
  /** Watermark over THIS scope's rows, not the whole archive file. */
  rows: { count: number; maxRowid: number };
  /**
   * Non-append changes to this scope's rows (`archive_row_marks`), or null when the source predates the marks table.
   * Null on either side forces a rebuild.
   */
  mutations: number | null;
}

type ArchiveProjectionIdentity = Pick<ArchiveProjectionStamp, 'version' | 'agentGroupId' | 'scope'>;

/**
 * The ONE identity check (same builder version, agent and scope), shared by local reuse and sibling seeding so they
 * cannot drift.
 */
function sameProjectionIdentity(a: ArchiveProjectionIdentity, b: ArchiveProjectionIdentity): boolean {
  return (
    a.version === ARCHIVE_PROJECTION_STAMP_VERSION &&
    b.version === ARCHIVE_PROJECTION_STAMP_VERSION &&
    a.agentGroupId === b.agentGroupId &&
    JSON.stringify(a.scope ?? null) === JSON.stringify(b.scope ?? null)
  );
}

/**
 * Must match `buildArchiveProjection`'s branches exactly, including that an EMPTY member array falls through to the
 * single-agent filter.
 */
function archiveScopeFilter(agentGroupId: string, workgroupMemberIds?: string[]): { sql: string; params: string[] } {
  if (workgroupMemberIds && workgroupMemberIds.length > 0) {
    return {
      sql: `agent_group_id IN (${workgroupMemberIds.map(() => '?').join(', ')})`,
      params: [...workgroupMemberIds],
    };
  }
  return { sql: 'agent_group_id = ?', params: [agentGroupId] };
}

/**
 * `COUNT(*)` and `MAX(rowid)` are served by `idx_archive_ag_sent` alone (every index carries the rowid), never
 * touching the `text` column. A missing source reads as an empty, unedited scope.
 */
export function readArchiveScopeSignature(
  srcPath: string,
  agentGroupId: string,
  workgroupMemberIds?: string[],
): { count: number; maxRowid: number; mutations: number | null } {
  if (!fs.existsSync(srcPath)) return { count: 0, maxRowid: 0, mutations: 0 };
  try {
    return readArchiveScopeSignatureOnce(srcPath, agentGroupId, workgroupMemberIds);
  } catch (err) {
    // This read runs on every spawn, so a lock held by the host's synchronous archive writer is on the hot path:
    // retry once after a short pause, then throw (the spawn aborts and the sweep retries).
    if (!isSqliteBusy(err)) throw err;
    log.warn('Archive scope signature read was busy — retrying once', { srcPath, agentGroupId });
    sleepSync(ARCHIVE_BUSY_RETRY_DELAY_MS);
    return readArchiveScopeSignatureOnce(srcPath, agentGroupId, workgroupMemberIds);
  }
}

/** Pinned explicitly so a change to better-sqlite3's default cannot silently shorten the wait on the spawn path. */
export const ARCHIVE_READ_BUSY_TIMEOUT_MS = 5000;

const ARCHIVE_BUSY_RETRY_DELAY_MS = 250;

function openArchiveSourceForRead(srcPath: string): Database.Database {
  return new Database(srcPath, { readonly: true, timeout: ARCHIVE_READ_BUSY_TIMEOUT_MS });
}

function isSqliteBusy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_'));
}

/**
 * A real sleep is fine: everything here is already synchronous work on a worker thread (or an accepted blocking
 * fallback).
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readArchiveScopeSignatureOnce(
  srcPath: string,
  agentGroupId: string,
  workgroupMemberIds?: string[],
): { count: number; maxRowid: number; mutations: number | null } {
  const src = openArchiveSourceForRead(srcPath);
  try {
    const scope = archiveScopeFilter(agentGroupId, workgroupMemberIds);
    const rows = src
      .prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(rowid), 0) AS maxRowid FROM messages_archive WHERE ${scope.sql}`)
      .get(...scope.params) as { count: number; maxRowid: number };
    let mutations: number | null = null;
    try {
      const marks = src
        .prepare(`SELECT COALESCE(SUM(mutations), 0) AS mutations FROM archive_row_marks WHERE ${scope.sql}`)
        .get(...scope.params) as { mutations: number };
      mutations = marks.mutations;
    } catch {
      // No `archive_row_marks` table: fail closed; null never compares equal, so every spawn rebuilds until
      // `initSchema` creates it.
      mutations = null;
    }
    return { count: rows.count, maxRowid: rows.maxRowid, mutations };
  } finally {
    src.close();
  }
}

/**
 * Keyed on the SCOPE's own rows, not the archive file, so another agent's traffic does not invalidate every
 * projection.
 * `messages_archive` is NOT append-only: `ARCHIVE_UPSERT_SQL` rewrites a re-archived id in place, moving neither
 * `COUNT(*)` nor `MAX(rowid)`. That upsert is the whole write side (held by `src/archive-write-path.test.ts`);
 * count/maxRowid see appends and `mutations` (trigger-maintained per group) sees updates and deletes. Only a pure
 * append reuses incrementally: an edited row cannot be located in the projection because the dedup identity includes
 * `text`. `PRAGMA data_version` is only meaningful within one connection.
 */
export function computeArchiveProjectionStamp(
  srcPath: string,
  agentGroupId: string,
  workgroupMemberIds?: string[],
): ArchiveProjectionStamp {
  const signature = readArchiveScopeSignature(srcPath, agentGroupId, workgroupMemberIds);
  return {
    version: ARCHIVE_PROJECTION_STAMP_VERSION,
    agentGroupId,
    // Sorted so member order cannot force a rebuild; copied so the caller cannot mutate the stamp.
    scope: workgroupMemberIds ? [...workgroupMemberIds].sort() : null,
    rows: { count: signature.count, maxRowid: signature.maxRowid },
    mutations: signature.mutations,
  };
}

/**
 * Stamps live in a host-only tree under `DATA_DIR`, never beside the projection: the session directory is mounted
 * read-write, so a container could replace a sidecar stamp with a symlink and the host's next write would truncate
 * its target. Named by digest; the described path is stored inside.
 */
const PROJECTION_STAMPS_DIR = path.join(DATA_DIR, 'projection-stamps');

export function archiveProjectionStampPath(dstPath: string): string {
  const digest = createHash('sha256').update(path.resolve(dstPath)).digest('hex').slice(0, 32);
  return path.join(PROJECTION_STAMPS_DIR, `${digest}.json`);
}

export function readArchiveProjectionStamp(dstPath: string): ArchiveProjectionStamp | null {
  const stampPath = archiveProjectionStampPath(dstPath);
  let handle: number | undefined;
  try {
    // O_NOFOLLOW: a symlinked stamp is not a stamp, so read and write agree on validity.
    handle = fs.openSync(stampPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    return JSON.parse(fs.readFileSync(handle, 'utf-8')) as ArchiveProjectionStamp;
  } catch {
    return null;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

interface ArchiveSeedCandidate {
  dstPath: string;
  stamp: ArchiveProjectionStamp;
}

/**
 * An existing projection from THIS SAME agent group and scope that a new session can be seeded from instead of a full
 * rebuild.
 * Same-agent only, via `sameProjectionIdentity`: a full build labels every row with the caller's id, so such a
 * candidate's bytes are exactly what a build would write, with no relabel (relabeling a sibling's copy re-triggers
 * FTS indexing on every row). A widened scope matches only the same sorted member set. Any mismatch returns no
 * candidate, which means a full rebuild, never a wrong seed. `seedArchiveProjectionFrom` re-verifies the agent half
 * against the copied bytes; the member-set half rests on the stamp, which is host-only.
 * Only reached when this session has no local projection file.
 */
function findArchiveSeedCandidate(stamp: ArchiveProjectionStamp, excludeDstPath: string): ArchiveSeedCandidate | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(PROJECTION_STAMPS_DIR);
  } catch {
    return null;
  }
  const excludeResolved = path.resolve(excludeDstPath);
  let best: ArchiveSeedCandidate | null = null;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let parsed: (ArchiveProjectionStamp & { dstPath?: unknown }) | null;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(PROJECTION_STAMPS_DIR, entry), 'utf-8'));
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (typeof parsed.dstPath !== 'string' || parsed.dstPath === excludeResolved) continue;
    if (!sameProjectionIdentity(parsed, stamp)) continue;

    try {
      // `lstat`, not `stat`: this is the ONLY barrier against a symlinked candidate (a stamp may describe a file
      // later replaced by a link to a wider-scope projection). `size === 0` is just a short-circuit; the seed's own
      // fail-closed catch covers missing and empty files, and a build that died mid-write has no stamp.
      const st = fs.lstatSync(parsed.dstPath);
      if (!st.isFile() || st.size === 0) continue;
    } catch {
      continue; // The stamp outlived its projection.
    }

    // Prefer the most complete candidate so the append has the least to do.
    if (!best || parsed.rows.maxRowid > best.stamp.rows.maxRowid) {
      best = { dstPath: parsed.dstPath, stamp: parsed as ArchiveProjectionStamp };
    }
  }
  return best;
}

/**
 * Copies a same-agent candidate's projection verbatim. The MIN/MAX check re-verifies fail-closed that every row is
 * labeled with the caller; it cannot see the member set, which is trusted from the host-only stamp (no mount covers
 * `DATA_DIR/v2-sessions/` for writing archive.db or `DATA_DIR/projection-stamps/`). A foreign label means the file
 * disagrees with its stamp.
 * MIN and MAX are two queries: a combined `SELECT MIN(x), MAX(x)` scans the covering index, while each alone is an
 * index lookup.
 * `COPYFILE_EXCL` refuses to copy through anything at `dstPath`, dangling symlink included (existsSync reads false
 * for one); the caller removes it and falls back to a full build. `fsync` because this copy becomes the durable
 * baseline for later appends.
 */
function seedArchiveProjectionFrom(candidate: ArchiveSeedCandidate, dstPath: string, agentGroupId: string): void {
  fs.copyFileSync(candidate.dstPath, dstPath, fs.constants.COPYFILE_EXCL);
  const fd = fs.openSync(dstPath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const dst = new Database(dstPath, { readonly: true });
  let lo: string | null;
  let hi: string | null;
  try {
    lo = (dst.prepare(`SELECT MIN(agent_group_id) AS v FROM messages_archive`).get() as { v: string | null }).v;
    hi = (dst.prepare(`SELECT MAX(agent_group_id) AS v FROM messages_archive`).get() as { v: string | null }).v;
  } finally {
    dst.close();
  }
  // An empty table passes: nothing foreign in it.
  const foreign = (lo !== null && lo !== agentGroupId) || (hi !== null && hi !== agentGroupId);
  if (foreign) {
    throw new Error(
      `Archive projection seed candidate ${candidate.dstPath} contains a foreign agent_group_id ` +
        `(expected only ${agentGroupId}, saw range [${lo}, ${hi}])`,
    );
  }
}

export function writeArchiveProjectionStamp(dstPath: string, stamp: ArchiveProjectionStamp): void {
  // Written only after the projection succeeds, and removed before any build starts, so a crash leaves no stamp and
  // the next spawn rebuilds.
  const stampPath = archiveProjectionStampPath(dstPath);
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  // Unlink, then create exclusively: O_CREAT|O_EXCL never follows a symlink.
  fs.rmSync(stampPath, { force: true });
  const handle = fs.openSync(
    stampPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(handle, JSON.stringify({ ...stamp, dstPath: path.resolve(dstPath) }));
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Called before every rebuild: the schema is written before any row, so a failed build could leave a partial file
 * beside a still-matching stamp.
 */
export function removeArchiveProjectionStamp(dstPath: string): void {
  fs.rmSync(archiveProjectionStampPath(dstPath), { force: true });
}

/**
 * 'seeded': a session with no local file was copied from a same-scope sibling (then reused or appended); distinct so
 * logs can tell a first-spawn seed from steady state.
 */
export type ArchiveProjectionMode = 'reused' | 'appended' | 'rebuilt' | 'seeded';

export interface ArchiveProjectionResult {
  mode: ArchiveProjectionMode;
  /** 0 for a reuse; for an append or seed, only rows that survived dedup. */
  rows: number;
  /** Append only: cross-batch duplicates folded into an existing row because they carried metadata it lacked. */
  merged: number;
  bytes: number;
  ms: number;
  /** Null for 'reused' and 'rebuilt'. */
  sinceRowid: number | null;
  seededFrom: string | null;
}

/**
 * Fails closed in every ambiguous case (missing, unreadable or old stamp; different agent or scope; missing or empty
 * file; count went DOWN; maxRowid moved without the count; unknown mutations): all rebuild. Append requires BOTH
 * counters to have grown; growth in one alone means rows also left.
 */
export function decideArchiveProjectionMode(
  dstPath: string,
  previous: ArchiveProjectionStamp | null,
  current: ArchiveProjectionStamp,
): { mode: ArchiveProjectionMode; sinceRowid: number | null } {
  const rebuild = { mode: 'rebuilt' as const, sinceRowid: null };
  if (!previous) return rebuild;
  if (!sameProjectionIdentity(previous, current)) return rebuild;
  try {
    if (fs.statSync(dstPath).size === 0) return rebuild;
  } catch {
    return rebuild;
  }
  // An unknown mutation count means an unseen in-place edit, which an append would carry past the container forever.
  if (previous.mutations === null || previous.mutations === undefined) return rebuild;
  if (current.mutations === null) return rebuild;
  if (previous.mutations !== current.mutations) return rebuild;

  const before = previous.rows;
  if (!before || typeof before.count !== 'number' || typeof before.maxRowid !== 'number') return rebuild;
  if (before.count === current.rows.count && before.maxRowid === current.rows.maxRowid) {
    return { mode: 'reused', sinceRowid: null };
  }
  if (before.count < current.rows.count && before.maxRowid < current.rows.maxRowid) {
    return { mode: 'appended', sinceRowid: before.maxRowid };
  }
  return rebuild;
}

export function archiveProjectionIsFresh(dstPath: string, stamp: ArchiveProjectionStamp): boolean {
  return decideArchiveProjectionMode(dstPath, readArchiveProjectionStamp(dstPath), stamp).mode === 'reused';
}

/**
 * Copies the scope's rows above `sinceRowid` with the full build's SELECT, so one batch collapses as a full build
 * would. The `NOT EXISTS` guard stops a sibling copy projected in an earlier batch from being inserted twice.
 * A dedup hit is a MERGE: the full build folds MIN(id), MIN(created_at) and MAX of the channel/sender metadata, and
 * dropping a late duplicate would freeze whichever metadata arrived first (`thread-search.ts` reads those columns).
 * MIN/MAX are associative, so merging partial aggregates reproduces the full build exactly. The merge must be
 * NULL-SAFE: scalar `min(a,b)`/`max(a,b)` return NULL if either side is NULL.
 * Legacy single-agent mode has no dedup, so it guards on the primary key and never merges. The source is read and
 * closed before the projection opens for writing (TRUNCATE-mode readers block the host writer).
 */
export function appendArchiveProjection(
  srcPath: string,
  dstPath: string,
  agentGroupId: string,
  sinceRowid: number,
  workgroupMemberIds?: string[],
): { written: number; merged: number } {
  const widened = Boolean(workgroupMemberIds && workgroupMemberIds.length > 0);
  const src = openArchiveSourceForRead(srcPath);
  let rows: Array<Record<string, unknown>>;
  try {
    if (widened) {
      const members = workgroupMemberIds as string[];
      const placeholders = members.map(() => '?').join(', ');
      rows = src
        .prepare(
          `SELECT
             MIN(id)               AS id,
             messaging_group_id,
             MAX(channel_type)     AS channel_type,
             MAX(channel_name)     AS channel_name,
             MAX(platform_id)      AS platform_id,
             thread_id,
             role,
             sender_id,
             MAX(sender_name)      AS sender_name,
             text,
             sent_at,
             MIN(created_at)       AS created_at
           FROM messages_archive
           WHERE agent_group_id IN (${placeholders}) AND rowid > ?
           GROUP BY messaging_group_id, thread_id, role, sender_id, sent_at, text`,
        )
        .all(...members, sinceRowid) as Array<Record<string, unknown>>;
    } else {
      rows = src
        .prepare(`SELECT ${ARCHIVE_COLS.join(', ')} FROM messages_archive WHERE agent_group_id = ? AND rowid > ?`)
        .all(agentGroupId, sinceRowid) as Array<Record<string, unknown>>;
    }
  } finally {
    src.close();
  }

  // Discard container-planted sidecars before the read-write open; see removeStaleProjectionSidecars.
  removeStaleProjectionSidecars(dstPath);
  const dst = new Database(dstPath);
  try {
    const colList = ARCHIVE_COLS.join(', ');
    const valueList = ARCHIVE_COLS.map((c) => `@${c}`).join(', ');
    const guard = widened
      ? `NOT EXISTS (${ARCHIVE_DEDUP_MATCH_SQL})`
      : `NOT EXISTS (SELECT 1 FROM messages_archive WHERE id = @id)`;
    // INSERT ... SELECT ... WHERE so the guard is evaluated per row; the AFTER INSERT trigger indexes whatever lands.
    const insertStmt = dst.prepare(`INSERT INTO messages_archive (${colList}) SELECT ${valueList} WHERE ${guard}`);
    const merges: Array<[string, 'MIN' | 'MAX']> = [
      ['id', 'MIN'],
      ['created_at', 'MIN'],
      ['channel_type', 'MAX'],
      ['channel_name', 'MAX'],
      ['platform_id', 'MAX'],
      ['sender_name', 'MAX'],
    ];
    const mergeStmt = widened
      ? dst.prepare(
          `UPDATE messages_archive
              SET ${merges.map(([col, fn]) => `${col} = ${nullSafeFold(fn, col)}`).join(',\n                  ')}
            WHERE ${ARCHIVE_DEDUP_KEY_SQL}
              -- Only when the fold would actually move something. Without this
              -- every late duplicate rewrites an identical row and fires the
              -- FTS update trigger for nothing, and the merged count would
              -- report no-ops. IS NOT is the NULL-safe inequality.
              AND (${merges.map(([col, fn]) => `${col} IS NOT ${nullSafeFold(fn, col)}`).join(' OR ')})`,
        )
      : null;
    const insertMany = dst.transaction((batch: Array<Record<string, unknown>>) => {
      let written = 0;
      let merged = 0;
      for (const row of batch) {
        const params: Record<string, unknown> = {};
        // Stamp the spawning agent's id, as the full build does.
        for (const col of ARCHIVE_COLS) params[col] = col === 'agent_group_id' ? agentGroupId : (row[col] ?? null);
        const inserted = insertStmt.run(params).changes;
        if (inserted > 0) {
          written += inserted;
        } else if (mergeStmt) {
          // A cross-batch duplicate: fold it in rather than lose its metadata.
          merged += mergeStmt.run(params).changes > 0 ? 1 : 0;
        }
      }
      return { written, merged };
    });
    return insertMany(rows);
  } finally {
    dst.close();
  }
}

/**
 * The dedup identity, shared by the append's guard and merge. Column order lets `idx_archive_thread(agent_group_id,
 * thread_id, sent_at)` serve it rather than a scan per row. Exported so the query-plan test checks THIS string, not a
 * retyped copy.
 */
export const ARCHIVE_DEDUP_KEY_SQL = `agent_group_id     =  @agent_group_id
              AND thread_id          IS @thread_id
              AND sent_at            =  @sent_at
              AND messaging_group_id IS @messaging_group_id
              AND role               =  @role
              AND sender_id          IS @sender_id
              AND text               =  @text`;

export const ARCHIVE_DEDUP_MATCH_SQL = `SELECT 1 FROM messages_archive
            WHERE ${ARCHIVE_DEDUP_KEY_SQL}`;

/**
 * NULL-skipping MIN/MAX, matching the full build's aggregates; scalar `min()`/`max()` return NULL if either argument
 * is NULL. In an UPDATE's SET, the bare column reads the row's ORIGINAL value.
 */
function nullSafeFold(fn: 'MIN' | 'MAX', column: string): string {
  return `CASE WHEN ${column} IS NULL THEN @${column} WHEN @${column} IS NULL THEN ${column} ELSE ${fn}(${column}, @${column}) END`;
}

/**
 * The single reuse/append/seed/rebuild implementation, run on the projection worker (or in process as a fallback),
 * never on the host's main thread: the decision queries the source per session.
 * The stamp is removed BEFORE any write and rewritten only after success. It is computed before the rows are read, so
 * it can only under-describe the projection; the next spawn re-offers rows the dedup guard already covers.
 */
export function materializeArchiveProjection(
  srcPath: string,
  dstPath: string,
  agentGroupId: string,
  workgroupMemberIds?: string[],
): ArchiveProjectionResult {
  const startedAt = Date.now();
  const stamp = computeArchiveProjectionStamp(srcPath, agentGroupId, workgroupMemberIds);
  let previous = readArchiveProjectionStamp(dstPath);
  let seededFrom: string | null = null;

  // Any session with no local file may seed, including one whose file the storage reclaimer deleted (it leaves an
  // orphan stamp). The file decides freshness here. Seed validity rests on `sameProjectionIdentity` against the
  // freshly computed stamp plus the post-copy label check, never on this local stamp.
  if (!fs.existsSync(dstPath)) {
    // Defensive: drop the orphan stamp so no later path reads a stamp describing a missing file.
    if (previous !== null) {
      removeArchiveProjectionStamp(dstPath);
      previous = null;
    }
    const candidate = findArchiveSeedCandidate(stamp, dstPath);
    if (candidate) {
      try {
        seedArchiveProjectionFrom(candidate, dstPath, agentGroupId);
        // The copy is byte-for-byte the candidate's file, so its watermark is the candidate's stamp, reconciled below
        // against the live one.
        previous = candidate.stamp;
        writeArchiveProjectionStamp(dstPath, previous);
        seededFrom = path.relative(DATA_DIR, candidate.dstPath);
      } catch (err) {
        log.warn('Archive projection seed copy failed — falling back to a full rebuild', {
          err,
          agentGroupId,
          dstPath,
          seedSource: candidate.dstPath,
        });
        try {
          fs.rmSync(dstPath, { force: true });
        } catch {
          /* ignore */
        }
        removeArchiveProjectionStamp(dstPath);
        previous = null;
      }
    }
  }

  const decision = decideArchiveProjectionMode(dstPath, previous, stamp);

  if (decision.mode === 'reused') {
    return {
      mode: seededFrom ? 'seeded' : 'reused',
      rows: 0,
      merged: 0,
      bytes: projectionBytes(dstPath),
      ms: Date.now() - startedAt,
      sinceRowid: null,
      seededFrom,
    };
  }

  if (decision.mode === 'appended' && decision.sinceRowid !== null) {
    removeArchiveProjectionStamp(dstPath);
    try {
      const { written, merged } = appendArchiveProjection(
        srcPath,
        dstPath,
        agentGroupId,
        decision.sinceRowid,
        workgroupMemberIds,
      );
      writeArchiveProjectionStamp(dstPath, stamp);
      return {
        mode: seededFrom ? 'seeded' : 'appended',
        rows: written,
        merged,
        bytes: projectionBytes(dstPath),
        ms: Date.now() - startedAt,
        sinceRowid: decision.sinceRowid,
        seededFrom,
      };
    } catch (err) {
      // The full build replaces the file outright and is the recovery path for any append failure, including a seed
      // that failed to append.
      log.warn('Archive projection append failed — falling back to a full rebuild', {
        err,
        agentGroupId,
        dstPath,
        sinceRowid: decision.sinceRowid,
        seededFrom,
      });
    }
  }

  removeArchiveProjectionStamp(dstPath);
  const rows = buildArchiveProjection(srcPath, dstPath, agentGroupId, workgroupMemberIds);
  writeArchiveProjectionStamp(dstPath, stamp);
  return {
    mode: 'rebuilt',
    rows,
    merged: 0,
    bytes: projectionBytes(dstPath),
    ms: Date.now() - startedAt,
    sinceRowid: null,
    seededFrom: null,
  };
}

function projectionBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Per-agent projection of `central.db` with ONLY the tables the container reads, filtered to this agent's rows;
 * everything else (pending_approvals, user_roles, sessions, …) is omitted. Archive rows are workgroup-widened
 * (separately); backlog_items, ship_log, tasks (via parent_agent_group_id) and agent_group_capabilities are
 * agent-scoped.
 */
export function buildCentralProjection(srcPath: string, dstPath: string, agentGroupId: string): void {
  if (!fs.existsSync(srcPath)) {
    writeEmptyCentral(dstPath);
    return;
  }
  // Same sidecar discipline as the archive projection.
  removeStaleProjectionSidecars(dstPath);
  if (fs.existsSync(dstPath)) fs.unlinkSync(dstPath);
  const dst = new Database(dstPath);
  // FK targets (agent_groups, users) are absent from the projection, so enforcement is off.
  dst.pragma('foreign_keys = OFF');
  try {
    const src = new Database(srcPath, { readonly: true });
    try {
      // ONLY the tables the container reads.
      const allowed = new Set([
        'backlog_items',
        'ship_log',
        'tasks',
        'agent_group_capabilities',
        // The agent's own row only; list_models reads it to mark the current model.
        'container_configs',
        // Operator blocklist, not tenant data: projected wholesale.
        'denied_models',
      ]);
      // '*' means no filter (global operator policy).
      const filterColumnByTable: Record<string, string> = {
        backlog_items: 'agent_group_id',
        ship_log: 'agent_group_id',
        agent_group_capabilities: 'agent_group_id',
        tasks: 'parent_agent_group_id',
        container_configs: 'agent_group_id',
        denied_models: '*',
      };
      const schemaRows = src
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index') AND name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ type: string; name: string; sql: string }>;
      const filtered = schemaRows.filter((r) => {
        if (r.type === 'table') return allowed.has(r.name);
        // Keep indexes that reference an allowed table.
        return Array.from(allowed).some((t) => r.sql.includes(` ON ${t}(`) || r.sql.includes(` ON "${t}"(`));
      });
      const order = ['table', 'index'];
      filtered.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
      dst.exec('BEGIN');
      for (const row of filtered) {
        dst.exec(row.sql);
      }
      for (const table of allowed) {
        try {
          const filterCol = filterColumnByTable[table];
          if (!filterCol) continue;
          const cols = src.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
          if (cols.length === 0) continue;
          const colList = cols.map((c) => c.name).join(', ');
          const placeholders = cols.map(() => '?').join(', ');
          const rows = (
            filterCol === '*'
              ? src.prepare(`SELECT ${colList} FROM ${table}`).all()
              : src.prepare(`SELECT ${colList} FROM ${table} WHERE ${filterCol} = ?`).all(agentGroupId)
          ) as Array<Record<string, unknown>>;
          const insertStmt = dst.prepare(`INSERT INTO ${table} (${colList}) VALUES (${placeholders})`);
          for (const row of rows) {
            insertStmt.run(...cols.map((c) => row[c.name]));
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Suppress only a table missing from an older source; anything else is logged.
          const tableMissing = new RegExp(`no such table: ${table}\\b`).test(msg);
          if (!tableMissing) {
            log.warn('buildCentralProjection: table copy failed (continuing)', { table, err });
          }
        }
      }
      dst.exec('COMMIT');
    } finally {
      src.close();
    }
  } catch (err) {
    log.error('buildCentralProjection failed', { err, agentGroupId, dstPath });
    try {
      dst.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    writeEmptyCentral(dstPath);
  } finally {
    dst.close();
  }
}

function writeEmptyCentral(dstPath: string): void {
  if (fs.existsSync(dstPath)) fs.unlinkSync(dstPath);
  const db = new Database(dstPath);
  try {
    // Minimal schemas matching the container's backlog.ts queries.
    db.exec(`
      CREATE TABLE backlog_items (
        id TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        priority TEXT,
        tags TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT,
        resolved_at TEXT,
        notes TEXT
      );
      CREATE TABLE ship_log (
        id TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        pr_url TEXT,
        branch TEXT,
        tags TEXT,
        shipped_at TEXT NOT NULL
      );
    `);
  } finally {
    db.close();
  }
}
