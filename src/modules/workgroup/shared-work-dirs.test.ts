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

  it('does not let the shared-dir migrator destroy a seed folder holding a real artifacts/', () => {
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

    // Consolidated into the house, not destroyed. Creating the shared dir
    // empty and ahead of the migrator used to make its `existsSync(dst)` arm
    // read "interrupted move" and rmSync the source with nothing moved.
    expect(fs.readFileSync(path.join(sharedWorkDir(), 'q3-report.md'), 'utf8')).toBe('a week of work');
    expect(fs.readlinkSync(seedWork)).toBe(LINK_TARGET);
  });

  it('never lets the migrator claim the reserved name as something it moved', () => {
    // Same shape as the regression above, asserting the OTHER consequence: the
    // marker is the reversal record, so a name listed there is one the migrator
    // believes it owns and will keep repointing.
    const seedWork = path.join(groupsDir, 'wgx', SHARED_WORK_DIR_NAME);
    fs.mkdirSync(seedWork, { recursive: true });
    fs.writeFileSync(path.join(seedWork, 'q3-report.md'), 'a week of work');
    fs.mkdirSync(path.join(groupsDir, 'wgx', 'sources'), { recursive: true });
    markMigrated();

    run();
    reconcileWorkgroupSharedDirs(db, { groupsDir, dataDir });

    const report = fs.readFileSync(path.join(workgroupSharedDir('wgx', dataDir), '.migrated'), 'utf8');
    expect(report).toContain('sources');
    expect(report).not.toContain(SHARED_WORK_DIR_NAME);
  });

  // ── Boot survivability ─────────────────────────────────────────────────────
  // This runs before runBootMountQuiescence proves container absence, so every
  // check-then-act below races a live container. An uncaught throw here is
  // process.exit(1) in reconcileWorkgroupFsState's caller — a host that will
  // not boot because one member lost one race.

  it('does not throw a whole boot away over one unusable workgroup row', () => {
    db.prepare(`INSERT INTO workgroups (id) VALUES (?)`).run('../escape');
    markMigrated();

    expect(() => run()).not.toThrow();

    // The healthy workgroup is still served.
    expect(fs.readlinkSync(linkAt('wgx'))).toBe(LINK_TARGET);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'ensureWorkgroupWorkDirs: skipped workgroup',
      expect.objectContaining({ workgroupId: '../escape' }),
    );
  });

  it('links the rest of the workgroup when one member folder is unwritable', () => {
    markMigrated();
    // The FIRST member by rowid, so the failure lands mid-loop: symlinkSync's
    // own catch is what lets the loop continue. With only the outer
    // per-workgroup catch the remaining members are skipped.
    const memberDir = path.join(groupsDir, 'wgx');
    fs.chmodSync(memberDir, 0o500); // no write: symlinkSync throws EACCES
    try {
      expect(() => run()).not.toThrow();
      expect(fs.readlinkSync(linkAt('wgx-codex'))).toBe(LINK_TARGET);
    } finally {
      fs.chmodSync(memberDir, 0o700);
    }
  });

  // ── Never clobber ──────────────────────────────────────────────────────────

  // ── Consolidation ──────────────────────────────────────────────────────────
  // A member holding its own real artifacts/ IS the divergence this mechanism
  // exists to end: its agent reads an instruction naming the shared tree while
  // writing where no sibling can read.

  it("moves a member's own real directory into the shared tree and links it", () => {
    markMigrated();
    const own = linkAt('wgx-codex');
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, 'roadmap.html'), 'a week of work');
    fs.mkdirSync(path.join(own, 'nested'));
    fs.writeFileSync(path.join(own, 'nested', 'data.json'), '{}');

    run();

    // The member is now a link to the house, and the work is IN the house.
    expect(fs.readlinkSync(own)).toBe(LINK_TARGET);
    expect(fs.readFileSync(path.join(sharedWorkDir(), 'roadmap.html'), 'utf8')).toBe('a week of work');
    expect(fs.readFileSync(path.join(sharedWorkDir(), 'nested', 'data.json'), 'utf8')).toBe('{}');
    // Which means the sibling reaches it: wgx resolves the same shared tree.
    expect(fs.readlinkSync(linkAt('wgx'))).toBe(LINK_TARGET);
  });

  it('never overwrites: a colliding name is moved aside, not merged or dropped', () => {
    markMigrated();
    run(); // creates the shared tree and links wgx
    fs.writeFileSync(path.join(sharedWorkDir(), 'report.md'), 'the shared one');
    // wgx-codex was linked by that first run; give it its own dir again, as a
    // group that wrote before it was ever linked would have.
    fs.unlinkSync(linkAt('wgx-codex'));
    fs.mkdirSync(linkAt('wgx-codex'));
    fs.writeFileSync(path.join(linkAt('wgx-codex'), 'report.md'), 'the private one');

    run();

    expect(fs.readFileSync(path.join(sharedWorkDir(), 'report.md'), 'utf8')).toBe('the shared one');
    expect(fs.readFileSync(path.join(sharedWorkDir(), 'report.md.from-wgx-codex'), 'utf8')).toBe('the private one');
    expect(fs.readlinkSync(linkAt('wgx-codex'))).toBe(LINK_TARGET);
  });

  it('keeps the directory, and everything in it, when an entry cannot be moved', () => {
    markMigrated();
    run();
    fs.writeFileSync(path.join(sharedWorkDir(), 'report.md'), 'shared');
    fs.writeFileSync(path.join(sharedWorkDir(), 'report.md.from-wgx-codex'), 'an earlier consolidation');
    fs.unlinkSync(linkAt('wgx-codex'));
    const own = linkAt('wgx-codex');
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, 'report.md'), 'cannot land anywhere');
    fs.writeFileSync(path.join(own, 'movable.md'), 'this one can');

    run();

    // Both destination names are taken, so this entry stays put — and because
    // it does, the directory is not empty and is NOT removed.
    expect(fs.lstatSync(own).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(own, 'report.md'), 'utf8')).toBe('cannot land anywhere');
    // The entry that could move still did.
    expect(fs.readFileSync(path.join(sharedWorkDir(), 'movable.md'), 'utf8')).toBe('this one can');
    expect(fs.existsSync(path.join(own, 'movable.md'))).toBe(false);
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });

  it('consolidates an empty directory by simply linking it', () => {
    markMigrated();
    fs.mkdirSync(linkAt('wgx-codex'));

    run();

    expect(fs.readlinkSync(linkAt('wgx-codex'))).toBe(LINK_TARGET);
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

  it('creates nothing outside the workgroups root for an unsafe id', () => {
    db.prepare(`INSERT INTO workgroups (id) VALUES (?)`).run('../escape');
    markMigrated();
    // Where `../escape` resolves to, marked so the mount gate PASSES — without
    // this the row returns at the gate and the traversal oracle never bites.
    const escaped = path.resolve(dataDir, 'workgroups', '../escape');
    fs.mkdirSync(escaped, { recursive: true });
    fs.writeFileSync(path.join(escaped, '.migrated'), '{}');

    run();

    expect(fs.existsSync(path.join(escaped, SHARED_WORK_DIR_NAME))).toBe(false);
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
