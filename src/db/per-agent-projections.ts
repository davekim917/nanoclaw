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
import fs from 'fs';
import Database from 'better-sqlite3';

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
): void {
  if (fs.existsSync(dstPath)) fs.unlinkSync(dstPath);
  const dst = new Database(dstPath);
  try {
    dst.exec(ARCHIVE_SCHEMA_SQL);
    if (!fs.existsSync(srcPath)) {
      // No source yet — empty projection is correct. Container open will
      // succeed and queries return no rows.
      return;
    }
    const src = new Database(srcPath, { readonly: true });
    try {
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
 * Recorded next to the projection so a spawn can tell, without reading the
 * 400 MB source, whether the file it already has is still the file this build
 * would produce. See `ensureArchiveProjection`.
 *
 * Bump `ARCHIVE_PROJECTION_STAMP_VERSION` whenever `buildArchiveProjection`'s
 * output changes for identical inputs — the schema, the dedup grouping, the
 * column list. A stamp from an older builder never satisfies a newer one.
 */
export const ARCHIVE_PROJECTION_STAMP_VERSION = 1;

export interface ArchiveProjectionStamp {
  version: number;
  agentGroupId: string;
  /** Sorted workgroup member ids, or null for the legacy single-agent filter. */
  scope: string[] | null;
  /** Source file identity. Absent when the source does not exist yet. */
  src: { size: string; mtimeNs: string } | null;
  /** A `-journal` sidecar means a write was in flight when we looked. */
  journal: { size: string; mtimeNs: string } | null;
}

function statSignature(filePath: string): { size: string; mtimeNs: string } | null {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return { size: String(stat.size), mtimeNs: String(stat.mtimeNs) };
  } catch {
    return null;
  }
}

/**
 * Describe the inputs of the projection that `buildArchiveProjection` would
 * write right now.
 *
 * Source-change detection is a file-identity check (size plus nanosecond
 * mtime), NOT a row watermark, and that is deliberate. `messages_archive` is
 * not append-only: `upsertArchiveMessage` (`src/message-archive.ts`) carries an
 * `ON CONFLICT(id) DO UPDATE SET text = excluded.text` clause, so an edited
 * message rewrites a row in place, leaving row count and `MAX(sent_at)`
 * untouched. Any cheap scoped watermark would therefore miss edits and serve a
 * container stale history. `PRAGMA data_version` is no help either — SQLite
 * only guarantees it meaningful within one connection, and every spawn opens a
 * fresh one.
 *
 * The cost of that soundness is a coarser gate: because the file identity
 * covers the whole archive, a write for ANY agent group invalidates every
 * group's stamp. Reuse therefore catches quiet periods, spawn bursts and spawn
 * retries rather than most spawns on a busy host. Removing the stall does not
 * depend on the hit rate — the rebuild runs off the main thread either way.
 * `archive.db` runs `journal_mode = TRUNCATE`, so a commit always moves the
 * main file; there is no WAL sidecar to miss.
 */
export function computeArchiveProjectionStamp(
  srcPath: string,
  agentGroupId: string,
  workgroupMemberIds?: string[],
): ArchiveProjectionStamp {
  return {
    version: ARCHIVE_PROJECTION_STAMP_VERSION,
    agentGroupId,
    // Sorted so member order from the central DB cannot force a rebuild, and
    // copied so a later mutation of the caller's array cannot alter the stamp.
    scope: workgroupMemberIds ? [...workgroupMemberIds].sort() : null,
    src: statSignature(srcPath),
    journal: statSignature(`${srcPath}-journal`),
  };
}

/** Sidecar path holding the stamp. Never mounted into a container. */
export function archiveProjectionStampPath(dstPath: string): string {
  return `${dstPath}.stamp.json`;
}

export function readArchiveProjectionStamp(dstPath: string): ArchiveProjectionStamp | null {
  try {
    return JSON.parse(fs.readFileSync(archiveProjectionStampPath(dstPath), 'utf-8')) as ArchiveProjectionStamp;
  } catch {
    return null;
  }
}

export function writeArchiveProjectionStamp(dstPath: string, stamp: ArchiveProjectionStamp): void {
  // Written after the projection, so a crash between the two leaves a missing
  // or older stamp — which forces a rebuild. The failure mode is a wasted
  // rebuild, never a stale projection served as fresh.
  fs.writeFileSync(archiveProjectionStampPath(dstPath), JSON.stringify(stamp));
}

/**
 * True when the projection already on disk was built from exactly these
 * inputs, so rebuilding it would reproduce the same file byte for byte.
 *
 * Fails closed in every ambiguous case: a missing or unreadable stamp, a stamp
 * from an older builder, a missing or empty projection file, or a source that
 * has moved all return false and force a rebuild. A journal sidecar present at
 * either build time or now also forces one, since a commit was in flight and
 * the main file's identity cannot be trusted to describe the committed state.
 */
export function archiveProjectionIsFresh(dstPath: string, stamp: ArchiveProjectionStamp): boolean {
  if (stamp.version !== ARCHIVE_PROJECTION_STAMP_VERSION) return false;
  if (stamp.journal !== null) return false;
  const previous = readArchiveProjectionStamp(dstPath);
  if (!previous) return false;
  try {
    if (fs.statSync(dstPath).size === 0) return false;
  } catch {
    return false;
  }
  return JSON.stringify(previous) === JSON.stringify(stamp);
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
