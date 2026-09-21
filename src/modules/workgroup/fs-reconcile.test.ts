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

// Steps 2 and 3 of the reconciler (`ensureWorkgroupWorkDirs`,
// `pruneDanglingWorkgroupCompatLinks`) take no directory arguments from this
// caller, so without this they resolve the LIVE `GROUPS_DIR` / `DATA_DIR` —
// this install's real `groups/` and `data/workgroups/`. Today nothing happens
// there only because the fixture DB's `workgroups` table is empty and both
// steps iterate it; the first case that seeds a workgroup row would run the
// real consolidation and the real prune against the install, moving files and
// deleting compat links. That is safety by emptiness, so pin it structurally.
// `vi.hoisted` runs before this file's own imports, so nothing here may use
// `fs`/`os`/`path` — but `globalThis.uniqueTmpRoot` (src/test-setup.ts:39) is
// available, because setupFiles run before the test module is evaluated. It
// also registers the root for `afterAll` cleanup, so a crashed run does not
// leak it. The directories themselves are created in `beforeEach`.
const { TEST_DIRS } = vi.hoisted(() => {
  const base = globalThis.uniqueTmpRoot('fs-reconcile');
  return { TEST_DIRS: { groups: `${base}/groups`, data: `${base}/data`, base } };
});

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: TEST_DIRS.groups,
  DATA_DIR: TEST_DIRS.data,
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
  fs.mkdirSync(TEST_DIRS.groups, { recursive: true });
  fs.mkdirSync(TEST_DIRS.data, { recursive: true });
  origCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(TEST_DIRS.base, { recursive: true, force: true });
});

// -----------------------------------------------------------------------
// Test cases
// -----------------------------------------------------------------------

describe('reconcileWorkgroupFsState', () => {
  // ── T0: the reconciler's own filesystem reach is scoped ─────────────
  it('does its filesystem work under the configured dirs, never the live install', () => {
    // Steps 2 and 3 take no directory arguments from this caller. With a
    // workgroup row present they create the shared work dir, link every
    // member, and prune compat links — real, destructive filesystem work.
    // Before this file mocked `../../config.js`, the only thing keeping that
    // off this install's `groups/` and `data/workgroups/` was that no case
    // here seeded such a row.
    const db = makeDb();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workgroups (id, display_name, created_at) VALUES (?, ?, ?)`).run('wgt', 'WGT', now);
    db.prepare(`INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      'ag-1',
      'WGT seed',
      'wgt',
      'wgt',
      now,
    );
    const memberDir = path.join(TEST_DIRS.groups, 'wgt');
    fs.mkdirSync(memberDir, { recursive: true });
    // The mount predicate this step shares with container-runner.
    fs.mkdirSync(path.join(TEST_DIRS.data, 'workgroups', 'wgt'), { recursive: true });
    fs.writeFileSync(path.join(TEST_DIRS.data, 'workgroups', 'wgt', '.migrated'), '{}');

    reconcileWorkgroupFsState(db);

    // It landed in the configured tree...
    expect(fs.existsSync(path.join(TEST_DIRS.data, 'workgroups', 'wgt', 'artifacts'))).toBe(true);
    expect(fs.readlinkSync(path.join(memberDir, 'artifacts'))).toBe('/workspace/workgroup/artifacts');
    // ...and nowhere near this repo, whose `data/` and `groups/` are the live
    // install's. `wgt` is not a real workgroup, so its presence there would
    // mean the reconciler had written outside the configured dirs.
    expect(fs.existsSync(path.join(origCwd, 'data', 'workgroups', 'wgt'))).toBe(false);
    expect(fs.existsSync(path.join(origCwd, 'groups', 'wgt'))).toBe(false);
  });

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
