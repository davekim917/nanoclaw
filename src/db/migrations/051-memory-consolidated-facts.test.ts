import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const { TEST_ROOT } = vi.hoisted(() => ({
  TEST_ROOT: `/tmp/nanoclaw-migration051-test-${process.pid}`,
}));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: TEST_ROOT,
}));

import { runMigrations, migrations } from './index.js';
import { migration051 } from './051-memory-consolidated-facts.js';

/** Workgroups the migration enqueued for maintenance, read straight from
 *  archive.db — the application-side reader went with the memory curator, but
 *  the migration is frozen logic and still writes these rows. */
function pendingMaintenanceWorkgroups(): string[] {
  const archivePath = path.join(TEST_ROOT, 'archive.db');
  // No enqueue means no archive.db at all — the migration only opens it when
  // it has a row to write. "File absent" is the same answer as "no rows".
  if (!fs.existsSync(archivePath)) return [];
  const archiveDb = new Database(archivePath);
  try {
    return (
      archiveDb.prepare('SELECT workgroup_id FROM memory_curation_state WHERE maintenance_pending = 1').all() as Array<{
        workgroup_id: string;
      }>
    ).map((row) => row.workgroup_id);
  } finally {
    archiveDb.close();
  }
}

function ledgerContent(): string {
  return [
    '# Generated workgroup memory',
    '',
    '- Fact. <!-- nanoclaw-memory:id=mem_aaaaaaaaaaaaaaaa;evidence=msg-1;captured=2026-08-01T00:00:00.000Z -->',
    '',
  ].join('\n');
}

function seedLedger(workgroupId: string, content: string): void {
  const dir = path.join(TEST_ROOT, 'workgroups', workgroupId, 'memory', 'generated');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.md'), content, 'utf8');
}

function makeMigratedDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertWorkgroup(db: Database.Database, id: string): void {
  db.prepare(`INSERT INTO workgroups (id, onecli_secrets, created_at) VALUES (?, '[]', ?)`).run(
    id,
    '2026-08-01T00:00:00.000Z',
  );
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('migration051', () => {
  it('creates memory_consolidated_facts with the spec columns', () => {
    const db = new Database(':memory:');
    runMigrations(
      db,
      migrations.filter((m) => m.name !== 'memory-consolidated-facts'),
    );
    migration051.up(db);
    const cols = new Set(
      (db.prepare('PRAGMA table_info(memory_consolidated_facts)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(cols.has('workgroup_id')).toBe(true);
    expect(cols.has('fact_id')).toBe(true);
    db.close();
  });

  // P2-AC14: the migration enqueues maintenance for every workgroup with a non-empty ledger.
  it('enqueues maintenance for every workgroup with a non-empty ledger', () => {
    // Seed a v2.db with workgroups the migration will read BEFORE the
    // memory_consolidated_facts migration runs, so seed via a manual chain:
    // run everything up to (not including) 051, insert workgroups, seed
    // ledger files, then run 051 alone.
    const db = new Database(':memory:');
    const before051 = migrations.filter((m) => m.name !== 'memory-consolidated-facts');
    runMigrations(db, before051);

    insertWorkgroup(db, 'wg-nonempty');
    insertWorkgroup(db, 'wg-empty');
    seedLedger('wg-nonempty', ledgerContent());
    // wg-empty has no ledger file at all — readGeneratedMemory degrades to ''.

    migration051.up(db);

    expect(pendingMaintenanceWorkgroups()).toEqual(['wg-nonempty']);
    db.close();
  });

  it('does not enqueue a workgroup whose ledger file exists but has no facts', () => {
    const db = new Database(':memory:');
    const before051 = migrations.filter((m) => m.name !== 'memory-consolidated-facts');
    runMigrations(db, before051);

    insertWorkgroup(db, 'wg-header-only');
    seedLedger('wg-header-only', '# Generated workgroup memory\n\n');

    migration051.up(db);

    expect(pendingMaintenanceWorkgroups()).toEqual([]);
    db.close();
  });

  it('is idempotent — re-running up() does not throw or double-enqueue', () => {
    const db = new Database(':memory:');
    const before051 = migrations.filter((m) => m.name !== 'memory-consolidated-facts');
    runMigrations(db, before051);
    insertWorkgroup(db, 'wg-a');
    seedLedger('wg-a', ledgerContent());

    migration051.up(db);
    expect(() => migration051.up(db)).not.toThrow();
    db.close();
  });

  it('is registered in the migrations array after the observatory-item-threads migration', () => {
    const db = makeMigratedDb();
    const names = (db.prepare('SELECT name FROM schema_version').all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('memory-consolidated-facts');
    expect(names).toContain('observatory-item-threads');
    db.close();
  });
});
