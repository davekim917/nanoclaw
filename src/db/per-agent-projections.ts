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

export function buildArchiveProjection(srcPath: string, dstPath: string, agentGroupId: string): void {
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
      // ── W3 fail-closed: verify agent has a non-null workgroup_id ──────────
      // If agent_groups doesn't exist in this archive src (older installs), fall
      // through gracefully. If it does exist, NULL workgroup_id is a hard error.
      const agentGroupsExists = src
        .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_groups'`)
        .get() as { 1: number } | undefined;

      if (agentGroupsExists) {
        const agRow = src
          .prepare(`SELECT workgroup_id FROM agent_groups WHERE id = ? LIMIT 1`)
          .get(agentGroupId) as { workgroup_id: string | null } | undefined;

        if (agRow !== undefined && agRow.workgroup_id === null) {
          throw new Error(
            `Workgroup-scoped projection: invalid workgroup for agent ${agentGroupId} — workgroup_id is NULL`,
          );
        }

        if (agRow !== undefined && agRow.workgroup_id !== null) {
          // ── Workgroup-widened SELECT with dedup ─────────────────────────
          // GROUP BY the content columns; identical user messages from sibling
          // agents collapse to 1 row (MIN id). Assistant rows differ by
          // sender_id so they get their own bucket → survive dedup.
          const rows = src
            .prepare(
              `SELECT
                 MIN(id)               AS id,
                 MIN(agent_group_id)   AS agent_group_id,
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
               WHERE agent_group_id IN (
                 SELECT id FROM agent_groups WHERE workgroup_id = (
                   SELECT workgroup_id FROM agent_groups WHERE id = ?
                 )
               )
               GROUP BY messaging_group_id, thread_id, role, sender_id, sent_at, text`,
            )
            .all(agentGroupId) as Array<Record<string, unknown>>;

          const colList = ARCHIVE_COLS.join(', ');
          const placeholders = ARCHIVE_COLS.map(() => '?').join(', ');
          const insertStmt = dst.prepare(`INSERT INTO messages_archive (${colList}) VALUES (${placeholders})`);
          const insertMany = dst.transaction((batch: Array<Record<string, unknown>>) => {
            for (const row of batch) {
              insertStmt.run(...ARCHIVE_COLS.map((c) => row[c]));
            }
          });
          insertMany(rows);
          return;
        }
      }

      // ── Legacy / no workgroup: fall back to single-agent filter ──────────
      const colList = ARCHIVE_COLS.join(', ');
      const placeholders = ARCHIVE_COLS.map(() => '?').join(', ');
      const rows = src
        .prepare(`SELECT ${colList} FROM messages_archive WHERE agent_group_id = ?`)
        .all(agentGroupId) as Array<Record<string, unknown>>;
      const insertStmt = dst.prepare(`INSERT INTO messages_archive (${colList}) VALUES (${placeholders})`);
      const insertMany = dst.transaction((batch: Array<Record<string, unknown>>) => {
        for (const row of batch) {
          insertStmt.run(...ARCHIVE_COLS.map((c) => row[c]));
        }
      });
      insertMany(rows);
    } finally {
      src.close();
    }
  } catch (err) {
    log.error('buildArchiveProjection failed', { err, agentGroupId, dstPath });
    // Re-throw if this is the W3 fail-closed error so callers (container-runner spawn)
    // see the error and abort the spawn rather than silently producing a wrong projection.
    if (err instanceof Error && err.message.includes('workgroup_id is NULL')) {
      throw err;
    }
  } finally {
    dst.close();
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
      const allowed = new Set(['backlog_items', 'ship_log', 'tasks', 'agent_group_capabilities']);
      // Tables that don't use agent_group_id as their filter column.
      const filterColumnByTable: Record<string, string> = {
        backlog_items: 'agent_group_id',
        ship_log: 'agent_group_id',
        agent_group_capabilities: 'agent_group_id',
        tasks: 'parent_agent_group_id',
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
          const rows = src.prepare(`SELECT ${colList} FROM ${table} WHERE ${filterCol} = ?`).all(agentGroupId) as Array<
            Record<string, unknown>
          >;
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
