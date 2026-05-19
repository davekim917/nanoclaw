/**
 * Tests for reconcileWorkgroupFsState — startup FS reconciler.
 *
 * Uses an in-memory better-sqlite3 DB. Mocks readContainerConfig and
 * writeContainerConfig to avoid real FS group dirs. Uses a temp dir for
 * the logs/ output.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- module mocks -------------------------------------------------------
// Must be declared before the import of the module under test so vitest
// applies them via its static mock hoisting.

vi.mock('../../container-config.js', () => ({
  readContainerConfig: vi.fn(),
  writeContainerConfig: vi.fn(),
}));

// We need log to not throw so silence it.
vi.mock('../../log.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { readContainerConfig, writeContainerConfig } from '../../container-config.js';
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

/** Seed workgroups + agent_groups rows for the paired/standalone scenario. */
function seedGroupRows(db: Database.Database): void {
  const now = new Date().toISOString();

  // workgroup for illysium pair
  db.prepare(`INSERT INTO workgroups (id, onecli_secrets, created_at) VALUES (?, '[]', ?)`).run('illysium', now);
  // standalone workgroup
  db.prepare(`INSERT INTO workgroups (id, onecli_secrets, created_at) VALUES (?, '[]', ?)`).run('standalone-x', now);

  // illie — parent/standalone (workgroup_id === folder)
  db.prepare(`INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    'ag-illie',
    'illie',
    'illysium',
    'illysium',
    now,
  );

  // illie-codex — paired sibling (workgroup_id !== folder)
  db.prepare(`INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    'ag-illie-codex',
    'illie-codex',
    'illysium-codex',
    'illysium',
    now,
  );

  // standalone-x — standalone (workgroup_id === folder)
  db.prepare(`INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    'ag-standalone',
    'standalone-x',
    'standalone-x',
    'standalone-x',
    now,
  );
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

  // Reset mocks between tests
  vi.mocked(readContainerConfig).mockReset();
  vi.mocked(writeContainerConfig).mockReset();
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
    const report = { pairings: [{ child: 'foo-codex', parent: 'foo' }], standalone: ['bar'], suffix_strip_unmatched: [] };
    seedMigrationReport(db, report);

    // No agent_groups rows — avoids needing readContainerConfig mocked
    // readContainerConfig won't be called when there are no rows.

    await reconcileWorkgroupFsState(db);

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

  // ── T2: writes recall_scope only for paired siblings ───────────────
  it('test_writes_recall_scope_for_paired_groups_only', async () => {
    const db = makeDb();
    seedGroupRows(db);

    // illie (standalone parent) — has memory.enabled but NOT recall_scope
    vi.mocked(readContainerConfig).mockImplementation((folder: string) => {
      if (folder === 'illysium') {
        return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all', tools: [], memory: { enabled: true } };
      }
      if (folder === 'illysium-codex') {
        return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all', tools: [], memory: { enabled: true } };
      }
      if (folder === 'standalone-x') {
        return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all', tools: [], memory: { enabled: true } };
      }
      throw new Error(`Unexpected folder: ${folder}`);
    });

    await reconcileWorkgroupFsState(db);

    // writeContainerConfig called exactly once — for illie-codex (the paired sibling)
    expect(vi.mocked(writeContainerConfig)).toHaveBeenCalledTimes(1);
    const [calledFolder, calledCfg] = vi.mocked(writeContainerConfig).mock.calls[0] as [string, { memory?: { recall_scope?: string } }];
    expect(calledFolder).toBe('illysium-codex');
    expect(calledCfg.memory?.recall_scope).toBe('workgroup');

    // illie and standalone-x must NOT have been written
    const writtenFolders = vi.mocked(writeContainerConfig).mock.calls.map(([f]) => f);
    expect(writtenFolders).not.toContain('illysium');
    expect(writtenFolders).not.toContain('standalone-x');
  });

  // ── T3: idempotency ─────────────────────────────────────────────────
  it('test_idempotent', async () => {
    const db = makeDb();
    seedGroupRows(db);

    // First call — illie-codex not yet set
    vi.mocked(readContainerConfig).mockImplementation((folder: string) => {
      if (folder === 'illysium-codex') {
        return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all', tools: [], memory: { enabled: true } };
      }
      return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all', tools: [], memory: { enabled: true } };
    });

    await reconcileWorkgroupFsState(db);
    const firstCallCount = vi.mocked(writeContainerConfig).mock.calls.length;
    expect(firstCallCount).toBe(1); // illie-codex written once

    // Second call — illie-codex already has recall_scope: 'workgroup'
    vi.mocked(readContainerConfig).mockImplementation((folder: string) => {
      if (folder === 'illysium-codex') {
        return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all', tools: [], memory: { enabled: true, recall_scope: 'workgroup' } };
      }
      return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all', tools: [], memory: { enabled: true } };
    });

    await reconcileWorkgroupFsState(db);
    // writeContainerConfig should NOT have been called again for illie-codex
    const totalCallCount = vi.mocked(writeContainerConfig).mock.calls.length;
    expect(totalCallCount, 'second run must not write again').toBe(1);
  });

  // ── T4: throws on FS failure ─────────────────────────────────────────
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
    // Read src/index.ts and assert structural properties about call order.
    const indexPath = path.join(
      // Walk up from __dirname (dist/modules/workgroup or src/modules/workgroup)
      // to the src/ root, then index.ts
      path.dirname(path.dirname(path.dirname(__dirname ?? ''))),
      'index.ts',
    );

    // Resolve from repo root (worktree) using the known absolute path pattern.
    // __dirname is not available in ESM, so we use import.meta.url.
    // The test runner sets cwd to the worktree root so we can use a relative path.
    const repoRoot = origCwd; // preserved before chdir
    const srcIndexPath = path.join(repoRoot, 'src', 'index.ts');

    const content = fs.readFileSync(srcIndexPath, 'utf8');

    // 1. reconcileWorkgroupFsState must be imported
    expect(content).toMatch(/reconcileWorkgroupFsState/);

    // 2. The import must come from the workgroup fs-reconcile module
    expect(content).toMatch(/from\s+['"].*workgroup\/fs-reconcile\.js['"]/);

    // 3. reconcileWorkgroupFsState must appear AFTER runMigrations in the file
    const migrationsIdx = content.indexOf('runMigrations(db)');
    const reconcilerIdx = content.indexOf('reconcileWorkgroupFsState(db)');
    expect(migrationsIdx, 'runMigrations(db) must exist in src/index.ts').toBeGreaterThan(-1);
    expect(reconcilerIdx, 'reconcileWorkgroupFsState(db) must exist in src/index.ts').toBeGreaterThan(-1);
    expect(reconcilerIdx, 'reconcileWorkgroupFsState must appear after runMigrations').toBeGreaterThan(migrationsIdx);

    // 4. process.exit(1) must follow the reconcileWorkgroupFsState call
    //    (the try/catch wrapping it must contain process.exit(1))
    const afterReconciler = content.slice(reconcilerIdx);
    expect(afterReconciler).toMatch(/process\.exit\(1\)/);
  });
});
