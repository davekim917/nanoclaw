/**
 * The central migration ledger, as a contract rather than a file listing.
 *
 * `schema_version` is keyed on `name` (UNIQUE index in `runMigrations`); the
 * stored `version` is an applied-order counter assigned at INSERT time, and the
 * `NNN-` prefix on a file is cosmetic. Seam 3 PR 2 uses that to adopt upstream's
 * 019/020/023 under upstream's file names while every live install keeps the
 * ledger rows it already has — the rows match by `name`, so the adopted files
 * are skipped rather than re-run.
 *
 * Two failure modes make that reconciliation worth pinning:
 *
 *   1. Two array entries sharing a `name`. `pending` is computed ONCE before the
 *      loop, so on a FRESH database both entries are pending, both run, and the
 *      second one dies on the UNIQUE index — after its DDL already committed.
 *      A live install would never notice, because the first row makes the second
 *      entry non-pending; the break only shows up on a new install.
 *   2. A live install and a fresh install ending up with different schemas.
 *      Adopting a file under a name that already ran means the SQL in the new
 *      file is never executed on the live DB — so it has to be the SQL that
 *      already ran there, and the only honest check of that is to build both
 *      databases and diff them.
 *
 * See docs/specs/upstream-async-central-db-seam/plan.md §4.3 and §8.2.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { preSeam3Migrations } from './__fixtures__/pre-seam3/registry.js';
import { migrations, runMigrations } from './index.js';

interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

function appliedNames(db: Database.Database): string[] {
  return (db.prepare('SELECT name FROM schema_version ORDER BY version').all() as { name: string }[]).map(
    (r) => r.name,
  );
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(table) !== undefined;
}

/**
 * Every schema object with its DDL whitespace-normalized. SQLite stores the
 * CREATE statement verbatim and APPENDS the column clause on an ALTER, so this
 * text is sensitive to the ORDER migrations ran in, which is exactly the
 * property the convergence case is about. Whitespace is collapsed because the
 * two databases must agree on the schema, not on indentation.
 */
function schemaObjects(db: Database.Database): SchemaObject[] {
  return (
    db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`).all() as SchemaObject[]
  ).map((o) => ({ ...o, sql: o.sql === null ? null : o.sql.replace(/\s+/g, ' ').trim() }));
}

/** `PRAGMA table_info` for every table, keyed by table name. */
function tableInfo(db: Database.Database): Record<string, unknown[]> {
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[]
  ).map((t) => t.name);
  const info: Record<string, unknown[]> = {};
  for (const table of tables) info[table] = db.prepare(`PRAGMA table_info('${table}')`).all();
  return info;
}

describe('central migration registry', () => {
  it('no two migrations share a name', () => {
    const names = migrations.map((m) => m.name);
    const seen = new Set<string>();
    const duplicates = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    expect(duplicates, 'schema_version is UNIQUE on name; a duplicate entry breaks FRESH installs only').toEqual([]);
  });

  it('a fresh database applies the reconciled ledger', () => {
    const db = freshDb();

    runMigrations(db);

    expect(appliedNames(db)).toEqual(migrations.map((m) => m.name));
    // Fork 045 is a strict superset of upstream 021 (it also adds the column on
    // pending_questions), which is why upstream 021 is deliberately NOT imported.
    expect(columnsOf(db, 'pending_questions')).toContain('question');
    // Upstream 022, adopted as fork file 070.
    expect(columnsOf(db, 'messaging_groups')).toContain('detached_at');
    // Upstream 024, adopted as fork file 071 — shadow schema, zero writers.
    for (const table of ['host_instances', 'session_claims', 'delivery_attempts', 'wake_signals']) {
      expect(tableExists(db, table), `${table} is missing`).toBe(true);
    }
  });

  it('a live upgrade converges on the fresh-install schema', () => {
    // A = an install that already ran the pre-reconciliation ledger, then this
    // build's registry on top of it.
    const live = freshDb();
    runMigrations(live, preSeam3Migrations);
    const beforeUpgrade = new Set(appliedNames(live));
    runMigrations(live);
    const newlyApplied = appliedNames(live).filter((n) => !beforeUpgrade.has(n));

    // B = a fresh install on this build's registry.
    const fresh = freshDb();
    runMigrations(fresh);

    expect(
      newlyApplied,
      'the adopted files (019/020/023) must match live rows by name and be skipped; only the net-new ones run',
    ).toEqual([
      'messaging-group-detached-at',
      'host-coordination',
      'observatory-signal',
      'observatory-signal-workgroup-cascade',
      'pending-channel-approvals-cascade',
      'task-run-outcomes',
      'turn-usage-effort',
      'choice-receipts',
      'choice-request-reservation',
      'host-inbound-provenance',
      'choice-receipt-release-scope',
      'thread-key-anchors',
      'mcp-oauth-integrations',
      'work-outcome-receipts',
    ]);
    const liveSchema = schemaObjects(live);
    // Canary: two empty snapshots compare equal, so assert the query actually
    // saw the schema before trusting the comparison below.
    expect(liveSchema.length, 'schema snapshot is empty — the sqlite_master query is broken').toBeGreaterThan(50);
    expect(liveSchema).toEqual(schemaObjects(fresh));
    expect(tableInfo(live)).toEqual(tableInfo(fresh));
  });
});
