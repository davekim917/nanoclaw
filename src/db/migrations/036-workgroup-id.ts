import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 036 — workgroup-id
 *
 * Introduces the `workgroups` table and backfills `agent_groups.workgroup_id`.
 *
 * A workgroup groups a primary agent-group with its optional Codex twin:
 *   - `<x>` + `<x>-codex` → workgroup id = `<x>` (paired)
 *   - `<x>-codex` with no matching parent → workgroup id = `<x>-codex` (orphan, suffix_strip_unmatched)
 *   - Anything else → workgroup id = own folder (standalone)
 *
 * workgroups.mnemon_store_id is set to the parent agent_groups.id so that
 * recall history is preserved across workgroup members.
 *
 * A temp table `_migration036_report` is written for the FS reconciler
 * (consumed by a sibling builder group).
 */
export const migration036: Migration = {
  version: 36,
  name: 'workgroup-id',
  up(db: Database.Database) {
    // ── 1. Schema DDL ──────────────────────────────────────────────────────

    // IF NOT EXISTS guards make this safe to re-run (idempotency).
    db.exec(`
      CREATE TABLE IF NOT EXISTS workgroups (
        id              TEXT PRIMARY KEY CHECK (id GLOB '[a-z]*' AND id NOT LIKE 'ag-%'),
        display_name    TEXT,
        onecli_secrets  TEXT NOT NULL DEFAULT '[]',
        mnemon_store_id TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT
      );
    `);

    // ALTER TABLE is not idempotent in SQLite.  Guard with a column-existence
    // check so a re-run after a partial failure doesn't error on "duplicate column".
    const agCols = (db.prepare(`PRAGMA table_info(agent_groups)`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!agCols.includes('workgroup_id')) {
      db.exec(`ALTER TABLE agent_groups ADD COLUMN workgroup_id TEXT REFERENCES workgroups(id);`);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_groups_workgroup_id ON agent_groups(workgroup_id);
    `);

    // ── 2. Backfill ────────────────────────────────────────────────────────

    const rows = db.prepare(`SELECT id, folder FROM agent_groups`).all() as Array<{
      id: string;
      folder: string;
    }>;

    if (rows.length === 0) {
      // Nothing to backfill; write empty report and return.
      db.prepare(`CREATE TABLE IF NOT EXISTS _migration036_report (report TEXT)`).run();
      db.prepare(`DELETE FROM _migration036_report`).run();
      db.prepare(`INSERT INTO _migration036_report (report) VALUES (?)`).run(
        JSON.stringify({ pairings: [], standalone: [], suffix_strip_unmatched: [] }),
      );
      return;
    }

    const folderSet = new Set(rows.map((r) => r.folder));

    const pairings: Array<{ child: string; parent: string }> = [];
    const standalone: string[] = [];
    const suffix_strip_unmatched: string[] = [];

    const workgroupForRow = new Map<string, string>(); // agent_groups.id → workgroup id

    for (const row of rows) {
      let wg: string;
      if (row.folder.endsWith('-codex')) {
        const parent = row.folder.slice(0, -'-codex'.length);
        if (folderSet.has(parent)) {
          wg = parent;
          pairings.push({ child: row.folder, parent });
        } else {
          wg = row.folder;
          suffix_strip_unmatched.push(row.folder);
        }
      } else {
        wg = row.folder;
        standalone.push(row.folder);
      }
      workgroupForRow.set(row.id, wg);
    }

    // Collect all distinct workgroup ids
    const distinctWorkgroups = new Set(workgroupForRow.values());

    const insertWorkgroup = db.prepare(`
      INSERT OR IGNORE INTO workgroups (id, onecli_secrets, created_at)
      VALUES (?, '[]', ?)
    `);

    const setStoreId = db.prepare(`
      UPDATE workgroups SET mnemon_store_id = ? WHERE id = ?
    `);

    const now = new Date().toISOString();

    for (const wg of distinctWorkgroups) {
      insertWorkgroup.run(wg, now);

      // mnemon_store_id → the parent agent_groups.id for this workgroup.
      // The parent is the row whose folder equals the workgroup id.
      const parentRow = db.prepare(`SELECT id FROM agent_groups WHERE folder = ? LIMIT 1`).get(wg) as
        | { id: string }
        | undefined;
      if (!parentRow) {
        throw new Error(`Migration 036: workgroup ${wg} has no parent agent_groups row`);
      }
      setStoreId.run(parentRow.id, wg);
    }

    // Apply workgroup_id to every agent_groups row
    const updateWorkgroupId = db.prepare(`UPDATE agent_groups SET workgroup_id = ? WHERE id = ?`);
    for (const [agId, wgId] of workgroupForRow) {
      updateWorkgroupId.run(wgId, agId);
    }

    // ── 3. Validation ──────────────────────────────────────────────────────

    // W1 + W2: every row must have a non-null workgroup_id that exists in workgroups
    const nullOrOrphanRows = db
      .prepare(
        `SELECT id FROM agent_groups WHERE workgroup_id IS NULL OR workgroup_id NOT IN (SELECT id FROM workgroups)`,
      )
      .all() as Array<{ id: string }>;
    if (nullOrOrphanRows.length > 0) {
      throw new Error(
        `Migration 036: validation W1/W2 failed — ${nullOrOrphanRows.length} agent_groups rows have null or invalid workgroup_id: ${nullOrOrphanRows.map((r) => r.id).join(', ')}`,
      );
    }

    // FK check
    const fkViolations = db.prepare(`PRAGMA foreign_key_check(agent_groups)`).all();
    if (fkViolations.length > 0) {
      throw new Error(`Migration 036: PRAGMA foreign_key_check found violations: ${JSON.stringify(fkViolations)}`);
    }

    // ── 4. Temp report table for FS reconciler ─────────────────────────────

    db.prepare(`CREATE TABLE IF NOT EXISTS _migration036_report (report TEXT)`).run();
    db.prepare(`DELETE FROM _migration036_report`).run();
    db.prepare(`INSERT INTO _migration036_report (report) VALUES (?)`).run(
      JSON.stringify({ pairings, standalone, suffix_strip_unmatched }),
    );
  },
};
