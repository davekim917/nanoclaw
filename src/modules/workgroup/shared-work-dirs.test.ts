import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { log } from '../../log.js';

import {
  ensureWorkgroupWorkDirs,
  reconcileWorkgroupSharedDirs,
  SHARED_WORK_DIR_NAME,
  workgroupSharedDir,
} from './shared-dirs.js';

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
  const sharedWorkDir = (wg = 'wgx'): string => path.join(workgroupSharedDir(wg, dataDir), SHARED_WORK_DIR_NAME);
  /** The mount predicate's other half — the live install's shape for every workgroup. */
  const markMigrated = (wg = 'wgx'): void => {
    const wgDir = workgroupSharedDir(wg, dataDir);
    fs.mkdirSync(wgDir, { recursive: true });
    fs.writeFileSync(path.join(wgDir, '.migrated'), '{}');
  };

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
    markMigrated();

    run();

    expect(fs.statSync(sharedWorkDir()).isDirectory()).toBe(true);
    // The point of the change: both siblings reach the SAME tree, so a file one
    // writes is a file the other reads.
    for (const folder of ['wgx', 'wgx-codex']) {
      expect(fs.readlinkSync(linkAt(folder))).toBe(LINK_TARGET);
    }
  });

  it('is a no-op on re-run, preserving contents and link inode', () => {
    markMigrated();
    run();
    fs.writeFileSync(path.join(sharedWorkDir(), 'handover.md'), 'from the writer');
    const before = fs.lstatSync(linkAt('wgx-codex')).ino;

    run();

    expect(fs.readFileSync(path.join(sharedWorkDir(), 'handover.md'), 'utf8')).toBe('from the writer');
    expect(fs.lstatSync(linkAt('wgx-codex')).ino).toBe(before);
  });

  // ── The mount predicate ────────────────────────────────────────────────────
  // A link whose target is not mounted is worse than no link: /workspace/workgroup
  // is container-local without the mount, so work written there dies with --rm.

  it('does nothing for a workgroup with neither the flag nor the .migrated marker', () => {
    run();

    expect(fs.existsSync(sharedWorkDir())).toBe(false);
    expect(fs.existsSync(linkAt('wgx'))).toBe(false);
  });

  // ── F1 regression: the generic migrator must never touch this name ─────────

  it('does not let the shared-dir migrator delete a seed folder holding a real artifacts/', () => {
    // A group created between boots writes work products before anything links
    // it — exactly what container/CLAUDE.md now tells agents to do.
    const seedWork = path.join(groupsDir, 'wgx', SHARED_WORK_DIR_NAME);
    fs.mkdirSync(seedWork, { recursive: true });
    fs.writeFileSync(path.join(seedWork, 'q3-report.md'), 'a week of work');
    // Give the migrator something real to move, so it runs its whole loop.
    fs.mkdirSync(path.join(groupsDir, 'wgx', 'sources'), { recursive: true });
    markMigrated();

    // Boot order: reconcileWorkgroupFsState (this) runs BEFORE the boot
    // mount-change block calls the migrator (src/main.ts).
    run();
    reconcileWorkgroupSharedDirs(db, { groupsDir, dataDir });

    // Creating the shared dir empty and ahead of the migrator used to make its
    // `existsSync(dst)` arm read "interrupted move" and rmSync the source.
    expect(fs.readFileSync(path.join(seedWork, 'q3-report.md'), 'utf8')).toBe('a week of work');
  });

  it('keeps the name out of the migrator even when the shared dir already exists', () => {
    markMigrated();
    run();
    fs.writeFileSync(path.join(sharedWorkDir(), 'shared-note.md'), 'kept');

    reconcileWorkgroupSharedDirs(db, { groupsDir, dataDir });

    expect(fs.readFileSync(path.join(sharedWorkDir(), 'shared-note.md'), 'utf8')).toBe('kept');
    // And it is not claimed as something the migrator moved.
    const report = path.join(workgroupSharedDir('wgx', dataDir), '.migrated');
    expect(fs.readFileSync(report, 'utf8')).not.toContain(SHARED_WORK_DIR_NAME);
  });

  // ── Never clobber ──────────────────────────────────────────────────────────

  it('never clobbers a member that already holds a real directory at that name', () => {
    markMigrated();
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

  it('leaves a symlink that addresses somewhere else alone, with its content still reachable', () => {
    // The clone-as-codex shape: a relative link into another group's folder.
    // Nothing is moved here, so repointing it would strand what it addresses.
    markMigrated();
    const elsewhere = path.join(groupsDir, 'wgx', 'prior-work');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'kept.md'), 'still here');
    fs.symlinkSync('../wgx/prior-work', linkAt('wgx-codex'));

    run();

    expect(fs.readlinkSync(linkAt('wgx-codex'))).toBe('../wgx/prior-work');
    expect(fs.readFileSync(path.join(linkAt('wgx-codex'), 'kept.md'), 'utf8')).toBe('still here');
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });

  // ── Membership edges ───────────────────────────────────────────────────────

  it('skips a member whose group folder does not exist yet, and links it on a later run', () => {
    markMigrated();
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
    markMigrated('wgy');

    run();

    expect(fs.statSync(sharedWorkDir('wgy')).isDirectory()).toBe(true);
  });

  it('refuses a workgroup id that is not one safe path segment', () => {
    db.prepare(`INSERT INTO workgroups (id) VALUES (?)`).run('../escape');

    expect(() => run()).toThrow(/Invalid workgroup id/);
  });
});

describe('the shared work dir name is a published contract', () => {
  it('is the literal the agent instructions tell every agent to write to', () => {
    // Renaming the constant must not leave the tests green while
    // container/CLAUDE.md keeps sending work products to `artifacts/`.
    const claudeMd = fs.readFileSync(path.resolve(import.meta.dirname, '../../../container/CLAUDE.md'), 'utf8');
    expect(SHARED_WORK_DIR_NAME).toBe('artifacts');
    expect(claudeMd).toContain(`/workspace/workgroup/${SHARED_WORK_DIR_NAME}/`);
  });
});
