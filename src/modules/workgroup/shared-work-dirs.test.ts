import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { log } from '../../log.js';

import { ensureWorkgroupWorkDirs, SHARED_WORK_DIR_NAME, workgroupSharedDir } from './shared-dirs.js';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const LINK_TARGET = `/workspace/workgroup/${SHARED_WORK_DIR_NAME}`;

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

describe('ensureWorkgroupWorkDirs', () => {
  let tmp: string;
  let groupsDir: string;
  let dataDir: string;
  let db: Database.Database;

  const run = (): void => ensureWorkgroupWorkDirs(db, { groupsDir, dataDir });
  const linkAt = (folder: string): string => path.join(groupsDir, folder, SHARED_WORK_DIR_NAME);
  const sharedWorkDir = (): string => path.join(workgroupSharedDir('wgx', dataDir), SHARED_WORK_DIR_NAME);

  beforeEach(() => {
    vi.mocked(log.warn).mockClear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wgwork-'));
    groupsDir = path.join(tmp, 'groups');
    dataDir = path.join(tmp, 'data');
    for (const folder of ['wgx', 'wgx-codex']) fs.mkdirSync(path.join(groupsDir, folder), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    db = setupDb();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the shared work dir once and links every member to that one directory', () => {
    run();

    expect(fs.statSync(sharedWorkDir()).isDirectory()).toBe(true);
    // The point of the change: both siblings reach the SAME tree, so a file one
    // writes is a file the other reads.
    for (const folder of ['wgx', 'wgx-codex']) {
      expect(fs.readlinkSync(linkAt(folder))).toBe(LINK_TARGET);
    }
  });

  it('is a no-op on re-run, preserving contents and link inode', () => {
    run();
    fs.writeFileSync(path.join(sharedWorkDir(), 'handover.md'), 'from the writer');
    const before = fs.lstatSync(linkAt('wgx-codex')).ino;

    run();

    expect(fs.readFileSync(path.join(sharedWorkDir(), 'handover.md'), 'utf8')).toBe('from the writer');
    expect(fs.lstatSync(linkAt('wgx-codex')).ino).toBe(before);
  });

  it('never clobbers a member that already holds a real directory at that name', () => {
    const own = linkAt('wgx-codex');
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, 'private.md'), 'mine');

    run();

    expect(fs.lstatSync(own).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(own, 'private.md'), 'utf8')).toBe('mine');
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
    // The sibling that had nothing is still linked, and the shared dir exists.
    expect(fs.readlinkSync(linkAt('wgx'))).toBe(LINK_TARGET);
  });

  it('repairs a symlink pointing somewhere else', () => {
    fs.symlinkSync('/workspace/agent/artifacts', linkAt('wgx'));

    run();

    expect(fs.readlinkSync(linkAt('wgx'))).toBe(LINK_TARGET);
  });

  it('skips a member whose group folder does not exist yet, and links it on a later run', () => {
    db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run('ag-late', 'wgx-late', 'wgx');

    expect(() => run()).not.toThrow();
    expect(fs.existsSync(path.join(groupsDir, 'wgx-late'))).toBe(false);

    // initGroupFilesystem creates the folder at the group's first spawn; the
    // next boot is what links it.
    fs.mkdirSync(path.join(groupsDir, 'wgx-late'));
    run();
    expect(fs.readlinkSync(linkAt('wgx-late'))).toBe(LINK_TARGET);
  });

  it('covers a workgroup that has no members yet', () => {
    db.prepare(`INSERT INTO workgroups (id) VALUES (?)`).run('wgy');

    run();

    expect(fs.statSync(path.join(workgroupSharedDir('wgy', dataDir), SHARED_WORK_DIR_NAME)).isDirectory()).toBe(true);
  });
});
