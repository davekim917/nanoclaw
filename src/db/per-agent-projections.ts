/**
 * Per-agent projections of `archive.db` and `central.db` (`v2.db`).
 *
 * SECURITY: the container has shell + raw SQLite access at /workspace.
 * Mounting the global archive/central files cross-exposes every tenant's
 * chat history and topology — the container's MCP query filters are
 * advisory, not enforced. Each container instead gets a tightly-scoped
 * projection containing ONLY rows for its own agent_group_id, regenerated
 * on every spawn.
 *
 * Trade-off: the projection is a snapshot at spawn time; messages or
 * backlog rows added on the host mid-session are not visible until next
 * wake. Acceptable because (a) the container `--rm`s on every wake under
 * normal operation, (b) read-only chat history is naturally append-only
 * old-data, and (c) the previous global-mount design was a hard-fail
 * isolation hole.
 *
 * The on-disk projection files live alongside the session DBs at
 * `data/v2-sessions/<ag>/<sess>/archive.db` and `central.db`.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';

/**
 * Build a per-agent projection of `archive.db` containing all rows for
 * agents that share the same workgroup_id. Rows are deduplicated across
 * siblings by grouping on (messaging_group_id, thread_id, role, sender_id,
 * sent_at, text) — identical user messages written to multiple siblings
 * collapse to a single row (MIN id for determinism). Assistant rows from
 * different agents survive because their sender_id differs.
 *
 * Fail-closed (W3): if the calling agent has NULL workgroup_id in
 * agent_groups, the function throws — this prevents silent scope collapse
 * from producing an empty or wrong projection.
 *
 * The schema is declared fresh (matching the host `archive.ts` schema) —
 * copying via sqlite_master would also pull FTS5 shadow tables
 * (`*_fts_data`, `*_fts_idx`, `*_fts_docsize`, `*_fts_config`) which
 * conflict with the auto-creation that happens when we declare the virtual
 * table. INSERTing into messages_archive triggers FTS population via the
 * AFTER INSERT trigger declared below.
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
 * Build a per-agent projection of `archive.db` containing rows for the spawning agent's
 * workgroup (or just the agent itself if `workgroupMemberIds` is omitted — legacy mode).
 *
 * The caller (container-runner spawn path) is responsible for resolving the workgroup
 * member set from the central DB and passing it as `workgroupMemberIds`. The archive.db
 * source doesn't carry the agent_groups/workgroups schema; cross-DB joins would require
 * ATTACH and add complexity. Passing the set as a parameter keeps `archive.db` write-side
 * simple and the projection's hot path index-friendly.
 *
 * Empty array → projection contains zero rows (W3 fail-closed: caller checks workgroup_id
 * BEFORE calling and passes empty if invalid, or throws upstream).
 * Undefined → legacy single-agent filter (`WHERE agent_group_id = ?`). Used by tests and
 * any future caller that doesn't have central-DB access at the projection time.
 */
export function buildArchiveProjection(
  srcPath: string,
  dstPath: string,
  agentGroupId: string,
  workgroupMemberIds?: string[],
): number {
  if (fs.existsSync(dstPath)) fs.unlinkSync(dstPath);
  const dst = new Database(dstPath);
  try {
    dst.exec(ARCHIVE_SCHEMA_SQL);
    if (!fs.existsSync(srcPath)) {
      // No source yet — empty projection is correct. Container open will
      // succeed and queries return no rows.
      return 0;
    }
    const src = new Database(srcPath, { readonly: true });
    try {
      // Materialized with `.all()`, deliberately, NOT streamed with
      // `.iterate()`.
      //
      // Streaming looks better: `.all()` builds one JS array holding every
      // matching row, `text` included, measured at 2.26 s and a 237 MB heap
      // peak for the largest workgroup. But `archive.db` runs
      // `journal_mode = TRUNCATE`, where a reader blocks a writer, and an open
      // iterator would hold a shared lock on the canonical archive for the
      // whole insert phase as well as the read. The host's `archiveMessage`
      // writer is synchronous and on the main thread, so it would stall behind
      // that lock or fail `SQLITE_BUSY` and drop the archive row — trading the
      // stall this file is fixing for a different one. WAL would remove the
      // conflict but is ruled out upstream: containers read `archive.db`
      // through a read-only mount with no `-wal`/`-shm` sidecars, so WAL
      // writes would be invisible to them (see `src/message-archive.ts`).
      //
      // `.all()` therefore holds the read lock only while reading, and the
      // insert phase runs with the source released. The 2.26 s and the heap
      // peak now land on the projection worker thread rather than the host's,
      // which is what made them affordable.
      let rows: Array<Record<string, unknown>>;
      if (workgroupMemberIds && workgroupMemberIds.length > 0) {
        // ── Workgroup-widened SELECT with dedup ─────────────────────────
        // Intentional sibling sharing within a workgroup (the workgroup is
        // the data-pool boundary; the W3 NULL-fail-closed guard in
        // container-runner.ts enforces the cross-workgroup boundary upstream,
        // so this widening is safe). GROUP BY the content columns collapses
        // identical user messages from sibling agents to 1 row (MIN id).
        // Assistant rows differ by sender_id so they survive dedup.
        //
        // agent_group_id is set to the spawning agent (NOT MIN(agent_group_id)
        // from the dedup bucket): after dedup a row no longer belongs to a
        // single source agent, so MIN would be arbitrary attribution. The
        // row belongs to "whoever is querying this projection" — the
        // spawning agent — which is accurate attribution for the projection's
        // purpose (the container reads rows scoped to itself).
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
        // ── Legacy single-agent filter (test fixtures, fresh installs pre-migration) ─
        rows = src
          .prepare(`SELECT ${ARCHIVE_COLS.join(', ')} FROM messages_archive WHERE agent_group_id = ?`)
          .all(agentGroupId) as Array<Record<string, unknown>>;
      }

      const colList = ARCHIVE_COLS.join(', ');
      const placeholders = ARCHIVE_COLS.map(() => '?').join(', ');
      const insertStmt = dst.prepare(`INSERT INTO messages_archive (${colList}) VALUES (${placeholders})`);
      // Already one transaction around one prepared statement — the shape a
      // row-at-a-time loop needs. Unchanged by this PR.
      const insertMany = dst.transaction((batch: Array<Record<string, unknown>>) => {
        for (const row of batch) {
          // Stamp the spawning agent's id onto every deduped row (see
          // workgroup-widened SELECT comment above). Keeps the NOT NULL
          // schema and gives the projection honest attribution: this file
          // is served to the spawning agent's container.
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
    // CD-3: re-throw fail-closed. The caller (container-runner spawn) sees the failure
    // and aborts the spawn rather than silently mounting an empty projection that
    // looks-valid but yields zero rows on every read.
    throw err;
  } finally {
    dst.close();
  }
}

/**
 * Everything the archive projection's contents depend on.
 *
 * Recorded next to the projection so a spawn can tell, from two index-only
 * counts rather than a read of the 400 MB source, whether the file it already
 * has is still current — and, when it is not, whether the difference is rows
 * that merely arrived. See `materializeArchiveProjection`.
 *
 * Bump `ARCHIVE_PROJECTION_STAMP_VERSION` whenever `buildArchiveProjection`'s
 * output changes for identical inputs — the schema, the dedup grouping, the
 * column list. A stamp from an older builder never satisfies a newer one.
 * Version 2 replaced v1's stat signature over the whole archive file with this
 * scope-keyed watermark (#360).
 */
export const ARCHIVE_PROJECTION_STAMP_VERSION = 2;

export interface ArchiveProjectionStamp {
  version: number;
  agentGroupId: string;
  /** Sorted workgroup member ids, or null for the legacy single-agent filter. */
  scope: string[] | null;
  /** Watermark over THIS scope's rows, not over the whole archive file. */
  rows: { count: number; maxRowid: number };
  /**
   * Non-append changes to this scope's rows (`archive_row_marks`), or null when
   * the source could not report them — an archive written by a host that
   * predates the marks table. Null on either side of a comparison forces a
   * rebuild.
   */
  mutations: number | null;
}

/**
 * The SQL scope filter, matching `buildArchiveProjection`'s two branches
 * exactly — including that an EMPTY member array falls through to the legacy
 * single-agent filter rather than matching nothing.
 */
function archiveScopeFilter(
  agentGroupId: string,
  workgroupMemberIds?: string[],
): { sql: string; params: string[] } {
  if (workgroupMemberIds && workgroupMemberIds.length > 0) {
    return {
      sql: `agent_group_id IN (${workgroupMemberIds.map(() => '?').join(', ')})`,
      params: [...workgroupMemberIds],
    };
  }
  return { sql: 'agent_group_id = ?', params: [agentGroupId] };
}

/**
 * Count this scope's rows and its non-append changes, cheaply.
 *
 * `COUNT(*)` and `MAX(rowid)` over `agent_group_id IN (...)` are served by
 * `idx_archive_ag_sent(agent_group_id, sent_at)` — every SQLite index carries
 * the rowid, so neither touches the table or the 135 MB `text` column.
 * `archive_row_marks` holds one row per agent group.
 *
 * A missing source reads as an empty, unedited scope, so a fresh install with
 * no `archive.db` yet reuses its empty projection instead of rewriting it on
 * every spawn.
 */
export function readArchiveScopeSignature(
  srcPath: string,
  agentGroupId: string,
  workgroupMemberIds?: string[],
): { count: number; maxRowid: number; mutations: number | null } {
  if (!fs.existsSync(srcPath)) return { count: 0, maxRowid: 0, mutations: 0 };
  const src = new Database(srcPath, { readonly: true });
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
      // No `archive_row_marks` table: an archive last opened by a host that
      // predates it. Fail closed — null never compares equal, so every spawn
      // rebuilds until the host restarts and `initSchema` creates the table.
      mutations = null;
    }
    return { count: rows.count, maxRowid: rows.maxRowid, mutations };
  } finally {
    src.close();
  }
}

/**
 * Describe the inputs of the projection that `buildArchiveProjection` would
 * write right now.
 *
 * Keyed on the SCOPE's own rows, not on the whole archive file. The v1 stamp
 * was a stat signature over `data/archive.db`, so a message archived for any
 * agent group anywhere invalidated every session's projection: on the live host
 * that was 435 full rebuilds against 65 reuses in one day, median 19 s each,
 * against projections of 230-240 MB (#360).
 *
 * `messages_archive` is NOT append-only, which is why the v1 stamp took the
 * coarse route: `ARCHIVE_UPSERT_SQL` in `src/message-archive.ts` carries
 * `ON CONFLICT(id) DO UPDATE SET text = excluded.text`, so re-archiving a
 * message id rewrites the row in place and moves neither `COUNT(*)` nor
 * `MAX(rowid)`.
 *
 * Why the two fields TOGETHER are sound where a stat signature was needed
 * before. That single upsert is the whole write side — held by
 * `src/archive-write-path.test.ts` — so the archive can only ever gain a row,
 * have a row rewritten, or (through nothing in the tree today) lose one.
 * `count`/`maxRowid` see the first. `mutations` — a per-agent-group counter the
 * `archive_row_marks` triggers increment on any content-changing UPDATE and on
 * any DELETE — sees the other two. Between them they see everything that write
 * path can do, which is what lets the stamp stop watching the file itself and
 * start watching only this scope's rows.
 *
 * Only a pure append reuses the projection incrementally; anything the marks
 * counter reports forces a full rebuild, because the dedup identity includes
 * `text` and an edited row cannot be located in the projection to replace.
 *
 * `PRAGMA data_version` is no help here: SQLite only guarantees it meaningful
 * within one connection, and every spawn opens a fresh one.
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
    // Sorted so member order from the central DB cannot force a rebuild, and
    // copied so a later mutation of the caller's array cannot alter the stamp.
    scope: workgroupMemberIds ? [...workgroupMemberIds].sort() : null,
    rows: { count: signature.count, maxRowid: signature.maxRowid },
    mutations: signature.mutations,
  };
}

/**
 * Where the stamp lives: a host-only tree under `DATA_DIR`, never a sidecar
 * beside the projection.
 *
 * The projection sits in the session directory, and `buildMounts` bind-mounts
 * that entire directory read-write at `/workspace`. A sidecar there would be
 * container-writable, so a compromised container could replace it with a
 * relative symlink and the host's next stamp write would follow it and
 * truncate the target — the central database, say — as the host user. The
 * projection file itself is safe from that because it is re-mounted read-only
 * over its own path; a new sidecar had no such cover. Keeping stamps out of
 * every mounted tree removes the class rather than guarding one instance of
 * it. `writeArchiveProjectionStamp` still refuses to follow a symlink.
 *
 * Named by digest because the projection's absolute path is too long and too
 * punctuated to be a filename. The path it describes is stored inside the
 * stamp, so an operator can still tell which session a file belongs to.
 */
export function archiveProjectionStampPath(dstPath: string): string {
  const digest = createHash('sha256').update(path.resolve(dstPath)).digest('hex').slice(0, 32);
  return path.join(DATA_DIR, 'projection-stamps', `${digest}.json`);
}

export function readArchiveProjectionStamp(dstPath: string): ArchiveProjectionStamp | null {
  const stampPath = archiveProjectionStampPath(dstPath);
  let handle: number | undefined;
  try {
    // O_NOFOLLOW: a stamp that has become a symlink is not a stamp. Reading it
    // would be harmless on its own, but refusing keeps read and write agreeing
    // on what counts as a valid stamp file.
    handle = fs.openSync(stampPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    return JSON.parse(fs.readFileSync(handle, 'utf-8')) as ArchiveProjectionStamp;
  } catch {
    return null;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

export function writeArchiveProjectionStamp(dstPath: string, stamp: ArchiveProjectionStamp): void {
  // Written only after the projection succeeds. `ensureArchiveProjection`
  // removes any earlier stamp BEFORE dispatching a build, so a crash between
  // the two leaves no stamp at all and the next spawn rebuilds. The failure
  // mode is a wasted rebuild, never a partial projection served as fresh.
  const stampPath = archiveProjectionStampPath(dstPath);
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  // Unlink first, then create exclusively: O_CREAT|O_EXCL never follows a
  // symlink, and `rm` removes a symlink itself rather than its target. Belt
  // and braces — this tree is not mounted anywhere.
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
 * Drop the stamp, so nothing on disk claims the projection is current.
 *
 * Called before every rebuild. Without it, a rebuild that leaves a non-empty
 * partial file behind — the schema is written before any row — would sit next
 * to a still-matching earlier stamp, and the next spawn would mount that
 * partial projection as fresh.
 */
export function removeArchiveProjectionStamp(dstPath: string): void {
  fs.rmSync(archiveProjectionStampPath(dstPath), { force: true });
}

export type ArchiveProjectionMode = 'reused' | 'appended' | 'rebuilt';

export interface ArchiveProjectionResult {
  mode: ArchiveProjectionMode;
  /** Rows written. 0 for a reuse; for an append, only the ones that survived dedup. */
  rows: number;
  bytes: number;
  ms: number;
  /** The rowid the append started after. Null for the other two modes. */
  sinceRowid: number | null;
}

/**
 * Which of the three paths makes the projection current.
 *
 * Fails closed in every ambiguous case — a missing or unreadable stamp, a stamp
 * from an older builder, a different agent or scope, a missing or empty
 * projection file, a scope whose row count went DOWN, a `maxRowid` that moved
 * without the count moving, or either side unable to count mutations — all land
 * on a full rebuild.
 *
 * Append requires BOTH counters to have grown. Growth in one alone means rows
 * left as well as arrived, and the identity of what left is not recoverable
 * from a watermark.
 */
export function decideArchiveProjectionMode(
  dstPath: string,
  previous: ArchiveProjectionStamp | null,
  current: ArchiveProjectionStamp,
): { mode: ArchiveProjectionMode; sinceRowid: number | null } {
  const rebuild = { mode: 'rebuilt' as const, sinceRowid: null };
  if (!previous) return rebuild;
  if (previous.version !== ARCHIVE_PROJECTION_STAMP_VERSION) return rebuild;
  if (current.version !== ARCHIVE_PROJECTION_STAMP_VERSION) return rebuild;
  if (previous.agentGroupId !== current.agentGroupId) return rebuild;
  if (JSON.stringify(previous.scope ?? null) !== JSON.stringify(current.scope ?? null)) return rebuild;
  try {
    if (fs.statSync(dstPath).size === 0) return rebuild;
  } catch {
    return rebuild;
  }
  // An unknown mutation count on either side means an in-place edit may have
  // happened unseen, and an append would carry it past the container forever.
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

/**
 * True when the projection already on disk was built from exactly these
 * inputs, so nothing needs writing.
 */
export function archiveProjectionIsFresh(dstPath: string, stamp: ArchiveProjectionStamp): boolean {
  return decideArchiveProjectionMode(dstPath, readArchiveProjectionStamp(dstPath), stamp).mode === 'reused';
}

/**
 * Copy the scope's rows above `sinceRowid` into an existing projection.
 *
 * The SELECT is the full build's, verbatim, restricted to the new rowids — same
 * workgroup widening, same dedup `GROUP BY`, so a batch that arrives together
 * collapses exactly as a full build would collapse it. What a full build can do
 * and this cannot is see ACROSS batches, hence the `NOT EXISTS` guard: a
 * sibling's copy of a user message already projected in an earlier batch must
 * not be inserted a second time. Its column order is chosen so
 * `idx_archive_thread(agent_group_id, thread_id, sent_at)` serves the lookup
 * rather than scanning a 240 MB projection per candidate row; `agent_group_id`
 * is constant across the projection and is in the predicate only to open that
 * index.
 *
 * DELIBERATE DEVIATION from the full build: on a cross-batch duplicate the full
 * build keeps `MIN(id)` over every copy, while this keeps the id of whichever
 * copy was projected FIRST. Both are arbitrary tie-breaks over rows with
 * identical content — the container reads content, not archive ids — and
 * choosing the already-written one is what makes the append idempotent. Every
 * other column, and the row set itself, is identical.
 *
 * Legacy single-agent mode has no dedup in the full build either, so it guards
 * on the primary key instead. Guarding on content there would wrongly drop a
 * genuinely distinct row that happened to repeat a message verbatim.
 *
 * The source read is materialized and the source closed BEFORE the projection
 * is opened for writing, for the same reason the full build does it: under
 * `journal_mode = TRUNCATE` a reader blocks the host's synchronous archive
 * writer.
 */
export function appendArchiveProjection(
  srcPath: string,
  dstPath: string,
  agentGroupId: string,
  sinceRowid: number,
  workgroupMemberIds?: string[],
): number {
  const widened = Boolean(workgroupMemberIds && workgroupMemberIds.length > 0);
  const src = new Database(srcPath, { readonly: true });
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
        .prepare(
          `SELECT ${ARCHIVE_COLS.join(', ')} FROM messages_archive WHERE agent_group_id = ? AND rowid > ?`,
        )
        .all(agentGroupId, sinceRowid) as Array<Record<string, unknown>>;
    }
  } finally {
    src.close();
  }

  const dst = new Database(dstPath);
  try {
    const colList = ARCHIVE_COLS.join(', ');
    const valueList = ARCHIVE_COLS.map((c) => `@${c}`).join(', ');
    const guard = widened
      ? `NOT EXISTS (
           SELECT 1 FROM messages_archive
            WHERE agent_group_id     =  @agent_group_id
              AND thread_id          IS @thread_id
              AND sent_at            =  @sent_at
              AND messaging_group_id IS @messaging_group_id
              AND role               =  @role
              AND sender_id          IS @sender_id
              AND text               =  @text
         )`
      : `NOT EXISTS (SELECT 1 FROM messages_archive WHERE id = @id)`;
    // INSERT ... SELECT ... WHERE, not VALUES: the guard has to be evaluated
    // per row inside SQLite. The AFTER INSERT trigger in ARCHIVE_SCHEMA_SQL
    // populates `messages_archive_fts` for whatever actually lands, exactly as
    // it does for a full build.
    const insertStmt = dst.prepare(`INSERT INTO messages_archive (${colList}) SELECT ${valueList} WHERE ${guard}`);
    const insertMany = dst.transaction((batch: Array<Record<string, unknown>>) => {
      let written = 0;
      for (const row of batch) {
        const params: Record<string, unknown> = {};
        // Stamp the spawning agent's id onto every row, as the full build does.
        for (const col of ARCHIVE_COLS) params[col] = col === 'agent_group_id' ? agentGroupId : (row[col] ?? null);
        written += insertStmt.run(params).changes;
      }
      return written;
    });
    return insertMany(rows);
  } finally {
    dst.close();
  }
}

/**
 * Make the session's archive projection current, and say how.
 *
 * The single implementation of the reuse/append/rebuild decision. It runs on
 * the projection worker thread in the normal case and in process when the
 * worker is unavailable; both call THIS, so the two paths cannot drift.
 *
 * It belongs on whichever thread reads the source, never on the host's: the
 * decision needs `COUNT(*)`/`MAX(rowid)` over the source, and a boot with ~800
 * sessions would run that query 800 times on the main thread.
 *
 * Stamp discipline is unchanged from #315 — the stamp is removed BEFORE any
 * write and rewritten only after the write succeeds, so a crash in between
 * leaves no stamp and the next spawn rebuilds. The stamp is read from the
 * source before the rows are, which can only make it describe LESS than the
 * projection actually holds; the next spawn then re-offers rows the dedup guard
 * already covers. Over-copying is safe, under-copying would not be.
 */
export function materializeArchiveProjection(
  srcPath: string,
  dstPath: string,
  agentGroupId: string,
  workgroupMemberIds?: string[],
): ArchiveProjectionResult {
  const startedAt = Date.now();
  const stamp = computeArchiveProjectionStamp(srcPath, agentGroupId, workgroupMemberIds);
  const decision = decideArchiveProjectionMode(dstPath, readArchiveProjectionStamp(dstPath), stamp);

  if (decision.mode === 'reused') {
    return { mode: 'reused', rows: 0, bytes: projectionBytes(dstPath), ms: Date.now() - startedAt, sinceRowid: null };
  }

  if (decision.mode === 'appended' && decision.sinceRowid !== null) {
    removeArchiveProjectionStamp(dstPath);
    try {
      const rows = appendArchiveProjection(srcPath, dstPath, agentGroupId, decision.sinceRowid, workgroupMemberIds);
      writeArchiveProjectionStamp(dstPath, stamp);
      return {
        mode: 'appended',
        rows,
        bytes: projectionBytes(dstPath),
        ms: Date.now() - startedAt,
        sinceRowid: decision.sinceRowid,
      };
    } catch (err) {
      // A corrupt projection, a read-only file, a schema that is not what we
      // expect. The full build below replaces the file outright and is the
      // recovery path for all of them.
      log.warn('Archive projection append failed — falling back to a full rebuild', {
        err,
        agentGroupId,
        dstPath,
        sinceRowid: decision.sinceRowid,
      });
    }
  }

  removeArchiveProjectionStamp(dstPath);
  const rows = buildArchiveProjection(srcPath, dstPath, agentGroupId, workgroupMemberIds);
  writeArchiveProjectionStamp(dstPath, stamp);
  return { mode: 'rebuilt', rows, bytes: projectionBytes(dstPath), ms: Date.now() - startedAt, sinceRowid: null };
}

function projectionBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Build a per-agent projection of `central.db` containing ONLY the tables
 * the container reads (backlog_items, ship_log, tasks, agent_group_capabilities)
 * filtered to this agent's rows. Other central tables (pending_approvals,
 * user_roles, sessions, etc.) are deliberately omitted — the container has
 * no need to see them.
 *
 * Per-table pooling strategy (workgroup-scoped data layer, cycle-3 design):
 * - messages_archive: WORKGROUP-widened (via buildArchiveProjection, separate function)
 * - backlog_items: AGENT-scoped (each agent has own todo list)
 * - ship_log: AGENT-scoped (each agent's commits are own activity)
 * - tasks: AGENT-scoped via parent_agent_group_id (dispatch ownership)
 * - agent_group_capabilities: AGENT-scoped (orchestrator role per-agent)
 * See docs/specs/workgroup-scoped-data-layer/design.md § "Per-table pooling strategy (M5)"
 */
export function buildCentralProjection(srcPath: string, dstPath: string, agentGroupId: string): void {
  if (!fs.existsSync(srcPath)) {
    writeEmptyCentral(dstPath);
    return;
  }
  if (fs.existsSync(dstPath)) fs.unlinkSync(dstPath);
  const dst = new Database(dstPath);
  // FK targets (agent_groups, users) are intentionally absent from the partial projection.
  // Disable enforcement so INSERTs into agent_group_capabilities don't fail on missing referent rows.
  dst.pragma('foreign_keys = OFF');
  try {
    const src = new Database(srcPath, { readonly: true });
    try {
      // Copy ONLY the schemas the container actually reads.
      const allowed = new Set([
        'backlog_items',
        'ship_log',
        'tasks',
        'agent_group_capabilities',
        // container_configs: per-agent row carrying provider/model/effort/etc.
        // Container's list_models MCP tool reads it to annotate "current model"
        // in the response. Filtered to the agent's own row only.
        'container_configs',
        // denied_models: operator-curated blocklist of (provider, slug) pairs.
        // Container's list_models filters its `opencode models` output through
        // this. Operator policy, not tenant data — projected wholesale.
        'denied_models',
      ]);
      // Tables that don't use agent_group_id as their filter column.
      // '*' means "no filter, copy all rows" (used for global operator policy).
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
      // Filter: keep tables in allow-list, plus indexes that reference allowed tables.
      const filtered = schemaRows.filter((r) => {
        if (r.type === 'table') return allowed.has(r.name);
        // index: keep if its sql references an allowed table
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
          if (!filterCol) continue; // defensive: unknown table, skip
          const cols = src.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
          if (cols.length === 0) continue; // table doesn't exist in src
          const colList = cols.map((c) => c.name).join(', ');
          const placeholders = cols.map(() => '?').join(', ');
          // '*' = global table, copy all rows (e.g. operator-policy tables like denied_models).
          // Anything else = per-agent filter on that column.
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
          // Suppress only the expected case where the table doesn't exist in this source DB yet
          // (older installs that predate the migration). Any other error is a bug — log it.
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
    // Minimal schemas matching what the container's backlog.ts queries expect.
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
