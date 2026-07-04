/**
 * Tests for scripts/enable-profound-access.ts.
 *
 * Uses an isolated SQLite file and mocks OneCLI's secrets list call, so tests
 * validate DB behavior without touching the real vault.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BetterSQLite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import { enableProfoundAccess } from './enable-profound-access.js';
import { __resetCachesForTest } from '../src/onecli-secrets.js';

const mockedExec = vi.mocked(execFileSync);

const SECRET_FIXTURE = {
  data: [
    { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Anthropic' },
    { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'Profound' },
    { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', name: 'Profound-Log-Ingestion' },
  ],
};

function setupOnecliMock(secrets = SECRET_FIXTURE): void {
  mockedExec.mockImplementation((bin: unknown, rawArgs: unknown) => {
    const argv = (rawArgs ?? []) as string[];
    if (bin === 'curl' && argv.some((a) => String(a).includes('/api/secrets'))) {
      return JSON.stringify(secrets);
    }
    return '';
  });
}

function makeTestDb(): { db: Database.Database; dbPath: string; tempDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-profound-'));
  const dbPath = path.join(tempDir, 'test.db');
  const db = new BetterSQLite3(dbPath);
  db.exec(`
    CREATE TABLE workgroups (
      id              TEXT PRIMARY KEY,
      display_name    TEXT,
      onecli_secrets  TEXT NOT NULL DEFAULT '[]',
      mnemon_store_id TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT
    );
  `);
  return { db, dbPath, tempDir };
}

function insertWorkgroup(db: Database.Database, id: string, onecliSecrets = '[]'): void {
  db.prepare(
    `INSERT INTO workgroups (id, display_name, onecli_secrets, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
  ).run(id, id, onecliSecrets);
}

function getWorkgroupSecrets(db: Database.Database, id: string): string[] {
  const row = db.prepare('SELECT onecli_secrets FROM workgroups WHERE id = ?').get(id) as
    | { onecli_secrets: string }
    | undefined;
  if (!row) throw new Error(`missing workgroup ${id}`);
  return JSON.parse(row.onecli_secrets) as string[];
}

describe('enable-profound-access CLI core', () => {
  let db: Database.Database;
  let dbPath: string;
  let tempDir: string;

  beforeEach(() => {
    __resetCachesForTest();
    mockedExec.mockReset();
    const result = makeTestDb();
    db = result.db;
    dbPath = result.dbPath;
    tempDir = result.tempDir;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('adds Profound to Madison Reed without removing existing secrets', () => {
    setupOnecliMock();
    insertWorkgroup(db, 'illysium', JSON.stringify(['Anthropic']));
    insertWorkgroup(db, 'madison-reed', JSON.stringify(['Slack-User-Token-Madison-Reed']));

    const code = enableProfoundAccess({ dbPath });

    expect(code).toBe(0);
    expect(getWorkgroupSecrets(db, 'illysium')).toEqual(['Anthropic']);
    expect(getWorkgroupSecrets(db, 'madison-reed')).toEqual(['Slack-User-Token-Madison-Reed', 'Profound']);
  });

  it('allows explicitly naming Madison Reed', () => {
    setupOnecliMock();
    insertWorkgroup(db, 'madison-reed', JSON.stringify(['Anthropic']));
    insertWorkgroup(db, 'main', JSON.stringify(['Anthropic']));

    const code = enableProfoundAccess({ workgroupId: 'madison-reed', dbPath });

    expect(code).toBe(0);
    expect(getWorkgroupSecrets(db, 'madison-reed')).toEqual(['Anthropic', 'Profound']);
    expect(getWorkgroupSecrets(db, 'main')).toEqual(['Anthropic']);
  });

  it('is idempotent when Profound is already present', () => {
    setupOnecliMock();
    insertWorkgroup(db, 'madison-reed', JSON.stringify(['Anthropic', 'Profound']));

    const code = enableProfoundAccess({ dbPath });

    expect(code).toBe(0);
    expect(getWorkgroupSecrets(db, 'madison-reed')).toEqual(['Anthropic', 'Profound']);
  });

  it('can include the separate log ingestion secret', () => {
    setupOnecliMock();
    insertWorkgroup(db, 'madison-reed', JSON.stringify(['Anthropic']));

    const code = enableProfoundAccess({
      includeLogIngestion: true,
      dbPath,
    });

    expect(code).toBe(0);
    expect(getWorkgroupSecrets(db, 'madison-reed')).toEqual(['Anthropic', 'Profound', 'Profound-Log-Ingestion']);
  });

  it('does not write when the Profound secret is missing from OneCLI', () => {
    setupOnecliMock({
      data: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Anthropic' }],
    });
    insertWorkgroup(db, 'madison-reed', JSON.stringify(['Anthropic']));

    const code = enableProfoundAccess({ dbPath });

    expect(code).toBe(1);
    expect(getWorkgroupSecrets(db, 'madison-reed')).toEqual(['Anthropic']);
  });

  it('rejects non-Madison-Reed workgroups', () => {
    setupOnecliMock();
    insertWorkgroup(db, 'illysium', JSON.stringify(['Anthropic']));
    insertWorkgroup(db, 'madison-reed', JSON.stringify(['Anthropic']));

    const code = enableProfoundAccess({ workgroupId: 'illysium', dbPath });

    expect(code).toBe(1);
    expect(getWorkgroupSecrets(db, 'illysium')).toEqual(['Anthropic']);
    expect(getWorkgroupSecrets(db, 'madison-reed')).toEqual(['Anthropic']);
  });

  it('does not write when Madison Reed workgroup is missing', () => {
    setupOnecliMock();
    insertWorkgroup(db, 'illysium', JSON.stringify(['Anthropic']));

    const code = enableProfoundAccess({ dbPath });

    expect(code).toBe(1);
    expect(getWorkgroupSecrets(db, 'illysium')).toEqual(['Anthropic']);
  });
});
