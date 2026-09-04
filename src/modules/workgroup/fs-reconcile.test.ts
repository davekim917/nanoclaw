/**
 * Tests for reconcileWorkgroupFsState — startup FS reconciler.
 *
 * Uses an in-memory better-sqlite3 DB and a temp dir for logs/ output.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- module mocks -------------------------------------------------------
// Must be declared before the import of the module under test so vitest
// applies them via its static mock hoisting.

// We need log to not throw so silence it.
// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope — importOriginal() would
// install those in this test file's worker. Kept as a complete stub instead.
// (davekim917/nanoclaw#355 review thread)
vi.mock('../../log.js', () => ({
  setLogScrubber: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
  isSurvivableIoError: vi.fn(() => false),
}));

import { reconcileWorkgroupFsState } from './fs-reconcile.js';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/** Create an in-memory DB with just the tables the reconciler needs. */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE workgroups (
      id              TEXT PRIMARY KEY,
      display_name    TEXT,
      onecli_secrets  TEXT NOT NULL DEFAULT '[]',
      mnemon_store_id TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT
    );

    CREATE TABLE agent_groups (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      folder       TEXT NOT NULL UNIQUE,
      workgroup_id TEXT REFERENCES workgroups(id),
      created_at   TEXT NOT NULL
    );
  `);

  return db;
}

/** Seed the _migration036_report temp table. */
function seedMigrationReport(db: Database.Database, report: object): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migration036_report (report TEXT)`);
  db.prepare(`DELETE FROM _migration036_report`).run();
  db.prepare(`INSERT INTO _migration036_report (report) VALUES (?)`).run(JSON.stringify(report));
}

// -----------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------

let origCwd: string;
let tmpDir: string;

beforeEach(() => {
  // Redirect process.cwd() so logs/ go to a temp dir, not the repo root.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-reconcile-'));
  origCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------
// Test cases
// -----------------------------------------------------------------------

describe('reconcileWorkgroupFsState', () => {
  // ── T1: drain migration report ──────────────────────────────────────
  it('test_writes_logs_when_migration_report_present', async () => {
    const db = makeDb();
    const report = {
      pairings: [{ child: 'foo-codex', parent: 'foo' }],
      standalone: ['bar'],
      suffix_strip_unmatched: [],
    };
    seedMigrationReport(db, report);

    reconcileWorkgroupFsState(db);

    // logs/ dir should now exist in tmpDir
    const logPath = path.join(tmpDir, 'logs', 'migration-036.log');
    const secretsPath = path.join(tmpDir, 'logs', 'migration-036-secrets.log');

    expect(fs.existsSync(logPath), 'migration-036.log created').toBe(true);
    expect(fs.existsSync(secretsPath), 'migration-036-secrets.log created').toBe(true);

    const logContent = fs.readFileSync(logPath, 'utf8');
    expect(logContent).toContain('foo-codex');
    expect(logContent).toContain('bar');

    // temp table dropped
    const tableRow = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_migration036_report'`)
      .get();
    expect(tableRow, '_migration036_report dropped').toBeUndefined();
  });

  // ── T2: throws on FS failure ─────────────────────────────────────────
  it('test_throws_on_fs_failure', () => {
    const db = makeDb();
    const report = { pairings: [], standalone: ['foo'], suffix_strip_unmatched: [] };
    seedMigrationReport(db, report);

    // Spy on fs.writeFileSync to throw on logs write
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('DISK FULL');
    });

    try {
      expect(() => reconcileWorkgroupFsState(db)).toThrow('DISK FULL');

      // DB state: _migration036_report must still exist (reconciler threw before DROP)
      const tableRow = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_migration036_report'`)
        .get();
      expect(tableRow, '_migration036_report still exists after throw').toBeDefined();
    } finally {
      writeSpy.mockRestore();
    }
  });

  // ── T5: index.ts structural check ────────────────────────────────────
  it('test_index_ts_calls_reconciler_after_migrations', () => {
    // Resolve from repo root (worktree) using the known absolute path pattern.
    // The test runner sets cwd to the worktree root so we can use a relative path.
    const repoRoot = origCwd; // preserved before chdir
    const srcIndexPath = path.join(repoRoot, 'src', 'main.ts');

    const content = fs.readFileSync(srcIndexPath, 'utf8');

    // 1. reconcileWorkgroupFsState must be imported
    expect(content).toMatch(/reconcileWorkgroupFsState/);

    // 2. The import must come from the workgroup fs-reconcile module
    expect(content).toMatch(/from\s+['"].*workgroup\/fs-reconcile\.js['"]/);

    // 3. reconcileWorkgroupFsState must appear AFTER runMigrations in the file
    const migrationsIdx = content.indexOf('runMigrations(db)');
    const reconcilerIdx = content.indexOf('reconcileWorkgroupFsState(db)');
    expect(migrationsIdx, 'runMigrations(db) must exist in src/main.ts').toBeGreaterThan(-1);
    expect(reconcilerIdx, 'reconcileWorkgroupFsState(db) must exist in src/main.ts').toBeGreaterThan(-1);
    expect(reconcilerIdx, 'reconcileWorkgroupFsState must appear after runMigrations').toBeGreaterThan(migrationsIdx);

    // 4. process.exit(1) must follow the reconcileWorkgroupFsState call
    //    (the try/catch wrapping it must contain process.exit(1))
    const afterReconciler = content.slice(reconcilerIdx);
    expect(afterReconciler).toMatch(/process\.exit\(1\)/);
  });
});
