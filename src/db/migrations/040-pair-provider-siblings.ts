import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Re-homes provider siblings 036 could not pair (036 only strips `-codex`) into the parent's workgroup: a sibling
 * stranded in a workgroup-of-one loses the shared chat archive and inherited OneCLI secrets, both keyed on
 * `workgroup_id`. Only isolated siblings (NULL or own-folder workgroup) with an existing parent move; the parent's
 * store id and secrets are preserved and the emptied workgroup is dropped. Idempotent.
 */
const SIBLING_SUFFIXES = ['-codex', '-opencode'] as const;

export const migration040: Migration = {
  version: 40,
  name: 'pair-provider-siblings',
  up(db: Database.Database) {
    // Created by 036, which runs earlier.
    const rows = db.prepare(`SELECT id, folder, workgroup_id FROM agent_groups`).all() as Array<{
      id: string;
      folder: string;
      workgroup_id: string | null;
    }>;
    const folderToId = new Map(rows.map((r) => [r.folder, r.id]));
    const now = new Date().toISOString();

    const insertWorkgroup = db.prepare(
      `INSERT OR IGNORE INTO workgroups (id, onecli_secrets, created_at) VALUES (?, '[]', ?)`,
    );
    // Never clobber an operator-set value.
    const setStoreIdIfNull = db.prepare(
      `UPDATE workgroups SET mnemon_store_id = ? WHERE id = ? AND mnemon_store_id IS NULL`,
    );
    const rehome = db.prepare(`UPDATE agent_groups SET workgroup_id = ? WHERE id = ?`);
    const countMembers = db.prepare(`SELECT COUNT(*) AS n FROM agent_groups WHERE workgroup_id = ?`);
    const dropWorkgroup = db.prepare(`DELETE FROM workgroups WHERE id = ?`);

    const repaired: Array<{ child: string; parent: string }> = [];

    for (const row of rows) {
      const suffix = SIBLING_SUFFIXES.find((s) => row.folder.endsWith(s));
      if (!suffix) continue;
      const parent = row.folder.slice(0, -suffix.length);
      if (!parent) continue; // A folder that is exactly the suffix is not a sibling.
      const parentId = folderToId.get(parent);
      if (!parentId) continue; // Orphan sibling: stays standalone.

      // Already paired: a re-run is a no-op.
      const isIsolated = row.workgroup_id === null || row.workgroup_id === row.folder;
      if (!isIsolated) continue;

      insertWorkgroup.run(parent, now);
      setStoreIdIfNull.run(parentId, parent);

      rehome.run(parent, row.id);

      // Drop the sibling's own workgroup-of-one once empty.
      if (row.workgroup_id === row.folder && row.workgroup_id !== parent) {
        const members = countMembers.get(row.folder) as { n: number };
        if (members.n === 0) dropWorkgroup.run(row.folder);
      }

      repaired.push({ child: row.folder, parent });
    }

    const fkViolations = db.prepare(`PRAGMA foreign_key_check(agent_groups)`).all();
    if (fkViolations.length > 0) {
      throw new Error(`Migration 040: foreign_key_check violations after re-home: ${JSON.stringify(fkViolations)}`);
    }

    db.prepare(`CREATE TABLE IF NOT EXISTS _migration040_report (report TEXT)`).run();
    db.prepare(`DELETE FROM _migration040_report`).run();
    db.prepare(`INSERT INTO _migration040_report (report) VALUES (?)`).run(JSON.stringify({ repaired }));
  },
};
