import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 040 — pair-provider-siblings
 *
 * Repairs workgroup membership for provider-sibling agent groups that migration
 * 036 could not pair. 036 only strips the `-codex`
 * suffix, so a sibling created by `/clone-as-opencode` (or any future
 * `/clone-as-<provider>`) before the clone skill learned to set `workgroup_id`
 * at INSERT fell through `reconcileWorkgroupAtSpawn`'s last-resort default to a
 * workgroup-of-one (its own folder). That severs the whole point of a sibling:
 * shared chat-archive visibility and workgroup-level OneCLI-secret inheritance
 * (both keyed purely on `agent_groups.workgroup_id`).
 *
 * This generalizes 036's pairing to a known {@link SIBLING_SUFFIXES} set and
 * idempotently re-homes any *isolated* sibling (workgroup_id NULL or == own
 * folder) whose parent folder exists into the parent's workgroup, preserving
 * the parent's existing mnemon_store_id + onecli_secrets, then drops the
 * now-empty workgroup-of-one row.
 *
 * Idempotent + safe to re-run: a correctly-paired sibling (workgroup_id ==
 * parent) is skipped, so this is a no-op on installs already repaired by hand
 * or by the fixed clone skills. On a fresh install it runs against an empty
 * agent_groups table (no-op) — fresh siblings get the right workgroup_id from
 * the fixed `/clone-as-*` skills at creation time. `-codex` is included in the
 * suffix set purely as a defensive net; 036 already paired those, so they are
 * skipped here.
 */
const SIBLING_SUFFIXES = ['-codex', '-opencode'] as const;

export const migration040: Migration = {
  version: 40,
  name: 'pair-provider-siblings',
  up(db: Database.Database) {
    // workgroups table + agent_groups.workgroup_id are guaranteed to exist:
    // migration036 runs earlier in the barrel array (index.ts) and creates both.
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
    // Only seed mnemon_store_id when unset — never clobber an operator-set value.
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
      if (!parent) continue; // folder is exactly the suffix (e.g. "-codex") — not a sibling
      const parentId = folderToId.get(parent);
      if (!parentId) continue; // orphan sibling, no matching parent — leave standalone (036 semantics)

      // Skip rows that are already correctly paired — keeps this a true no-op on re-run.
      const isIsolated = row.workgroup_id === null || row.workgroup_id === row.folder;
      if (!isIsolated) continue;

      // Ensure the parent workgroup exists and points its store at the parent's ag-id.
      insertWorkgroup.run(parent, now);
      setStoreIdIfNull.run(parentId, parent);

      // Re-home the sibling into the parent workgroup.
      rehome.run(parent, row.id);

      // If the sibling had its own workgroup-of-one, drop it once empty.
      if (row.workgroup_id === row.folder && row.workgroup_id !== parent) {
        const members = countMembers.get(row.folder) as { n: number };
        if (members.n === 0) dropWorkgroup.run(row.folder);
      }

      repaired.push({ child: row.folder, parent });
    }

    // Integrity check: re-homing must not leave a dangling workgroup_id reference.
    const fkViolations = db.prepare(`PRAGMA foreign_key_check(agent_groups)`).all();
    if (fkViolations.length > 0) {
      throw new Error(`Migration 040: foreign_key_check violations after re-home: ${JSON.stringify(fkViolations)}`);
    }

    // Report table for observability / FS reconciler symmetry with 036.
    db.prepare(`CREATE TABLE IF NOT EXISTS _migration040_report (report TEXT)`).run();
    db.prepare(`DELETE FROM _migration040_report`).run();
    db.prepare(`INSERT INTO _migration040_report (report) VALUES (?)`).run(JSON.stringify({ repaired }));
  },
};
