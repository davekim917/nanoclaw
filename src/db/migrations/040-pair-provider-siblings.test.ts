import { describe, it, expect, beforeEach } from 'vitest';
import BetterSQLite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { migration036 } from './036-workgroup-id.js';
import { migration040 } from './040-pair-provider-siblings.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new BetterSQLite3(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

function seedBaseSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_groups (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      folder         TEXT NOT NULL UNIQUE,
      agent_provider TEXT,
      created_at     TEXT NOT NULL
    );
  `);
}

function insertGroup(db: Database.Database, id: string, folder: string) {
  db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)`).run(
    id,
    folder,
    folder,
    new Date().toISOString(),
  );
}

const wgOf = (db: Database.Database, id: string) =>
  (
    db.prepare(`SELECT workgroup_id FROM agent_groups WHERE id = ?`).get(id) as
      | { workgroup_id: string | null }
      | undefined
  )?.workgroup_id;

const wgRow = (db: Database.Database, id: string) =>
  db.prepare(`SELECT id, mnemon_store_id, onecli_secrets FROM workgroups WHERE id = ?`).get(id) as
    | { id: string; mnemon_store_id: string | null; onecli_secrets: string }
    | undefined;

// ── tests ────────────────────────────────────────────────────────────────────

describe('migration040 — pair-provider-siblings', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedBaseSchema(db);
  });

  it('re-homes an isolated -opencode sibling into the parent workgroup and drops the orphan', () => {
    insertGroup(db, 'ag-parent', 'parent');
    insertGroup(db, 'parent-codex', 'parent-codex');
    insertGroup(db, 'parent-opencode', 'parent-opencode');

    // 036 establishes schema + pairs codex, but ISOLATES opencode (the bug).
    migration036.up(db);
    expect(wgOf(db, 'parent-opencode')).toBe('parent-opencode'); // isolated
    expect(wgRow(db, 'parent-opencode')).toBeDefined(); // workgroup-of-one exists
    expect(wgOf(db, 'parent-codex')).toBe('parent'); // codex correctly paired by 036

    // 040 repairs.
    migration040.up(db);

    expect(wgOf(db, 'parent-opencode')).toBe('parent'); // re-homed
    expect(wgRow(db, 'parent-opencode')).toBeUndefined(); // orphan workgroup dropped
    expect(wgRow(db, 'parent')!.mnemon_store_id).toBe('ag-parent'); // shared store preserved
    expect(wgOf(db, 'parent-codex')).toBe('parent'); // codex untouched

    // No FK violations.
    expect(db.prepare(`PRAGMA foreign_key_check(agent_groups)`).all()).toHaveLength(0);

    const report = JSON.parse(
      (db.prepare(`SELECT report FROM _migration040_report`).get() as { report: string }).report,
    ) as { repaired: Array<{ child: string; parent: string }> };
    expect(report.repaired).toContainEqual({ child: 'parent-opencode', parent: 'parent' });
  });

  it('is a no-op on re-run (idempotent)', () => {
    insertGroup(db, 'ag-parent', 'parent');
    insertGroup(db, 'parent-opencode', 'parent-opencode');
    migration036.up(db);
    migration040.up(db);

    const wgCount1 = (db.prepare(`SELECT COUNT(*) AS c FROM workgroups`).get() as { c: number }).c;
    expect(() => migration040.up(db)).not.toThrow();
    const wgCount2 = (db.prepare(`SELECT COUNT(*) AS c FROM workgroups`).get() as { c: number }).c;

    expect(wgCount2).toBe(wgCount1);
    expect(wgOf(db, 'parent-opencode')).toBe('parent');
  });

  it('leaves an orphan -opencode sibling (no matching parent) standalone', () => {
    insertGroup(db, 'lonely-opencode', 'lonely-opencode'); // no "lonely" parent
    migration036.up(db);
    migration040.up(db);

    // Stays its own workgroup — not mis-paired to a non-existent parent.
    expect(wgOf(db, 'lonely-opencode')).toBe('lonely-opencode');
    expect(db.prepare(`PRAGMA foreign_key_check(agent_groups)`).all()).toHaveLength(0);
  });

  it('does not clobber an operator-set onecli_secrets or mnemon_store_id on the parent workgroup', () => {
    insertGroup(db, 'ag-parent', 'parent');
    insertGroup(db, 'parent-opencode', 'parent-opencode');
    migration036.up(db);

    // Operator customizes the parent workgroup after 036.
    db.prepare(`UPDATE workgroups SET onecli_secrets = ?, mnemon_store_id = ? WHERE id = 'parent'`).run(
      '["Slack-User-Token-Parent"]',
      'ag-parent',
    );

    migration040.up(db);

    const parentWg = wgRow(db, 'parent')!;
    expect(parentWg.onecli_secrets).toBe('["Slack-User-Token-Parent"]'); // preserved
    expect(parentWg.mnemon_store_id).toBe('ag-parent'); // preserved
    expect(wgOf(db, 'parent-opencode')).toBe('parent');
  });

  it('skips an already-paired codex sibling (no double-processing)', () => {
    insertGroup(db, 'ag-parent', 'parent');
    insertGroup(db, 'parent-codex', 'parent-codex');
    migration036.up(db); // pairs codex → 'parent'

    migration040.up(db);

    expect(wgOf(db, 'parent-codex')).toBe('parent');
    const report = JSON.parse(
      (db.prepare(`SELECT report FROM _migration040_report`).get() as { report: string }).report,
    ) as { repaired: Array<{ child: string; parent: string }> };
    expect(report.repaired).toHaveLength(0); // nothing to repair
  });
});
