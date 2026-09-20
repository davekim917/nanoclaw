/**
 * The prune under `NANOCLAW_WORKGROUP_SHARED_FS=1` — the live install's
 * setting, and the only configuration in which the fail-open shape exists.
 *
 * `WORKGROUP_SHARED_FS` is a module constant read at import, so making it true
 * needs its own file with `../../config.js` mocked; the sibling suite covers
 * the flag-off default.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  pruneDanglingWorkgroupCompatLinks,
  SHARED_WORK_DIR_NAME,
  WORKGROUP_CONTAINER_PATH,
  workgroupSharedDir,
} from './shared-dirs.js';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  WORKGROUP_SHARED_FS: true,
}));

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE workgroups (id TEXT PRIMARY KEY);
     CREATE TABLE agent_groups (id TEXT PRIMARY KEY, folder TEXT, workgroup_id TEXT);`,
  );
  db.prepare(`INSERT INTO workgroups (id) VALUES (?)`).run('wgx');
  db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run('ag-seed', 'wgx', 'wgx');
  db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run('ag-codex', 'wgx-codex', 'wgx');
  return db;
}

describe('pruneDanglingWorkgroupCompatLinks with the shared-fs flag ON', () => {
  let tmp: string;
  let groupsDir: string;
  let dataDir: string;
  let db: Database.Database;

  const run = (): void => pruneDanglingWorkgroupCompatLinks(db, { groupsDir, dataDir });
  const memberLink = (folder: string, name: string): string => path.join(groupsDir, folder, name);
  const exists = (p: string): boolean => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpruneflag-'));
    groupsDir = path.join(tmp, 'groups');
    dataDir = path.join(tmp, 'data');
    for (const folder of ['wgx', 'wgx-codex']) fs.mkdirSync(path.join(groupsDir, folder), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    db = setupDb();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // The fail-open shape. The shared tree is lost (unmounted volume, partial
  // restore, an agent's `rm -rf`), so the `.migrated` marker goes with it —
  // then step 2 recreates the directory holding only `artifacts`
  // (ensureWorkgroupWorkDirs, shared-dirs.ts:861) BEFORE this runs. The
  // listing therefore SUCCEEDS and reads every real name as gone, so the
  // readdir-throws bail cannot help. Only requiring the marker does.
  it('prunes nothing when the shared tree was recreated without its marker', () => {
    const wgDir = workgroupSharedDir('wgx', dataDir);
    fs.mkdirSync(path.join(wgDir, SHARED_WORK_DIR_NAME), { recursive: true }); // what step 2 leaves behind
    expect(fs.existsSync(path.join(wgDir, '.migrated'))).toBe(false);
    for (const folder of ['wgx', 'wgx-codex']) {
      for (const name of ['dbt', 'mr', 'sources']) {
        fs.symlinkSync(`${WORKGROUP_CONTAINER_PATH}/${name}`, memberLink(folder, name));
      }
    }

    run();

    for (const folder of ['wgx', 'wgx-codex']) {
      for (const name of ['dbt', 'mr', 'sources']) {
        expect(exists(memberLink(folder, name))).toBe(true);
      }
    }
  });

  it('still prunes normally once the marker is present', () => {
    const wgDir = workgroupSharedDir('wgx', dataDir);
    fs.mkdirSync(path.join(wgDir, SHARED_WORK_DIR_NAME), { recursive: true });
    fs.writeFileSync(path.join(wgDir, '.migrated'), '{}');
    fs.symlinkSync(`${WORKGROUP_CONTAINER_PATH}/dbt`, memberLink('wgx', 'dbt'));

    run();

    expect(exists(memberLink('wgx', 'dbt'))).toBe(false);
  });
});
