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

  it('claims a directory name before moving it, rather than checking it is free', () => {
    // Directories cannot be hard-linked, so a directory is published by claim
    // then rename. The observable difference from a check-based implementation
    // is that the destination ALREADY EXISTS when the rename runs.
    markMigrated();
    run();
    fs.unlinkSync(linkAt('wgx-codex'));
    const own = linkAt('wgx-codex');
    fs.mkdirSync(own);
    fs.mkdirSync(path.join(own, 'nested'));

    const dstExistedAtMove: boolean[] = [];
    const realRename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      dstExistedAtMove.push(fs.existsSync(to as string));
      return realRename(from, to);
    });
    try {
      run();
    } finally {
      spy.mockRestore();
    }

    expect(dstExistedAtMove).toEqual([true]);
    expect(fs.statSync(path.join(sharedWorkDir(), 'nested')).isDirectory()).toBe(true);
  });

  it("never loses a sibling's write into the file's destination name", () => {
    // #958. rename(2) replaces a file silently, so any implementation that
    // renames onto the name — even over a zero-byte reservation it made itself
    // — loses whatever a sibling wrote there in between. The sibling's write
    // is injected at the last moment before the publishing syscall, whichever
    // one the implementation uses.
    markMigrated();
    run();
    fs.unlinkSync(linkAt('wgx-codex'));
    const own = linkAt('wgx-codex');
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, 'report.md'), 'MEMBER BYTES');
    const dst = path.join(sharedWorkDir(), 'report.md');

    let injected = false;
    const siblingWrites = (to: fs.PathLike) => {
      if (!injected && to === dst) {
        injected = true;
        fs.writeFileSync(dst, 'SIBLING BYTES'); // a normal truncating write
      }
    };
    const realRename = fs.renameSync;
    const realLink = fs.linkSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      siblingWrites(to);
      return realRename(from, to);
    });
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      siblingWrites(to);
      return realLink(from, to);
    });
    try {
      run();
    } finally {
      renameSpy.mockRestore();
      linkSpy.mockRestore();
    }

    expect(injected).toBe(true);
    expect(fs.readFileSync(dst, 'utf8')).toBe('SIBLING BYTES');
    expect(fs.readFileSync(path.join(sharedWorkDir(), 'report.md.from-wgx-codex'), 'utf8')).toBe('MEMBER BYTES');
  });

  it("never loses the member's own save during the publish", () => {
    // #967 review. The member's container is live at boot, and publishing by
    // `link(src, dst)` then `unlink(src)` removes whatever is at that PATH,
    // not the inode just linked. An agent saving the file the ordinary atomic
    // way (write a temp, rename it over the name) inside that window had its
    // new version deleted while the shared tree kept the old one. Taking the
    // name by rename first makes the member's save a separate entry instead.
    markMigrated();
    run();
    fs.unlinkSync(linkAt('wgx-codex'));
    const own = linkAt('wgx-codex');
    fs.mkdirSync(own);
    const realName = path.join(own, 'report.md');
    fs.writeFileSync(realName, 'OLD');

    // The member saves a new version as soon as its bytes have been linked in.
    let saved = false;
    const realLink = fs.linkSync;
    const spy = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      const r = realLink(from, to);
      if (!saved) {
        saved = true;
        const tmp = path.join(own, '.report.md.swp');
        fs.writeFileSync(tmp, 'MEMBER NEW EDIT');
        fs.renameSync(tmp, realName); // an ordinary atomic save
      }
      return r;
    });
    try {
      run();
    } finally {
      spy.mockRestore();
    }

    expect(saved).toBe(true);
    const published = fs.readFileSync(path.join(sharedWorkDir(), 'report.md'), 'utf8');
    expect(published).toBe('OLD');
    // The new version still exists somewhere — in the member, or published
    // beside the old one. What it must never be is gone.
    const survivors = [
      fs.existsSync(realName) ? fs.readFileSync(realName, 'utf8') : null,
      fs.existsSync(path.join(sharedWorkDir(), 'report.md.from-wgx-codex'))
        ? fs.readFileSync(path.join(sharedWorkDir(), 'report.md.from-wgx-codex'), 'utf8')
        : null,
    ];
    expect(survivors).toContain('MEMBER NEW EDIT');
  });

  it('giving back a hold never replaces a file the member wrote meanwhile', () => {
    // The publish fails, so the hold wants its real name back — but the live
    // member has already written a new file there. The hold keeps its hidden
    // name and is resumed next boot; the member's file is never replaced.
    markMigrated();
    run();
    fs.unlinkSync(linkAt('wgx-codex'));
    const own = linkAt('wgx-codex');
    fs.mkdirSync(own);
    const realName = path.join(own, 'report.md');
    fs.writeFileSync(realName, 'HELD BYTES');

    const spy = vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      fs.writeFileSync(realName, 'MEMBER WROTE A NEW ONE'); // the name is free again, and taken
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });
    try {
      run();
    } finally {
      spy.mockRestore();
    }

    expect(fs.readFileSync(realName, 'utf8')).toBe('MEMBER WROTE A NEW ONE');
    expect(fs.readFileSync(path.join(own, '.report.md.publishing'), 'utf8')).toBe('HELD BYTES');

    run(); // next boot: both reach the shared tree, neither overwrites the other

    const shared = fs.readdirSync(sharedWorkDir()).sort();
    expect(shared).toContain('report.md');
    expect(shared).toContain('report.md.from-wgx-codex');
    const contents = shared
      .filter((n) => n.startsWith('report.md'))
      .map((n) => fs.readFileSync(path.join(sharedWorkDir(), n), 'utf8'))
      .sort();
    expect(contents).toEqual(['HELD BYTES', 'MEMBER WROTE A NEW ONE']);
  });

  it('resumes a publish a previous boot died in the middle of', () => {
    // The hold is named so the next boot can find it: bytes already taken off
    // their real name must not sit in the member folder forever.
    markMigrated();
    run();
    fs.unlinkSync(linkAt('wgx-codex'));
    const own = linkAt('wgx-codex');
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, '.report.md.publishing'), 'HELD BYTES');

    run();

    expect(fs.readFileSync(path.join(sharedWorkDir(), 'report.md'), 'utf8')).toBe('HELD BYTES');
    expect(fs.existsSync(path.join(sharedWorkDir(), '.report.md.publishing'))).toBe(false);
    expect(fs.readlinkSync(own)).toBe(LINK_TARGET);
  });

  it('a new file at a held name never overwrites the held bytes', () => {
    // Both exist at once: `.report.md.publishing` (bytes taken off the name by
    // an interrupted boot) and a fresh `report.md` the member wrote since. If
    // the fresh one is processed first, taking its name with `rename` would
    // land straight on the hold — and `rename(2)` replaces a file silently.
    // readdir order is not defined, so it is pinned here.
    markMigrated();
    run();
    fs.unlinkSync(linkAt('wgx-codex'));
    const own = linkAt('wgx-codex');
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, '.report.md.publishing'), 'HELD BYTES');
    fs.writeFileSync(path.join(own, 'report.md'), 'THE NEW ONE');

    const realReaddir = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, ...rest: unknown[]) => {
      const out = (realReaddir as (d: fs.PathLike, ...r: unknown[]) => unknown)(dir, ...rest);
      if (String(dir) === own && Array.isArray(out)) {
        return [...(out as string[])].sort().reverse(); // 'report.md' before the hold
      }
      return out;
    }) as typeof fs.readdirSync);
    try {
      run();
    } finally {
      spy.mockRestore();
    }

    const surviving = fs
      .readdirSync(sharedWorkDir())
      .filter((n) => n.startsWith('report.md'))
      .map((n) => fs.readFileSync(path.join(sharedWorkDir(), n), 'utf8'));
    const inMember = fs
      .readdirSync(own)
      .filter((n) => n.includes('report.md'))
      .map((n) => fs.readFileSync(path.join(own, n), 'utf8'));
    const everywhere = [...surviving, ...inMember];
    expect(everywhere).toContain('HELD BYTES');
    expect(everywhere).toContain('THE NEW ONE');
  });

  it('a failed file move leaves the real name free for the next boot', () => {
    // With no claim there is nothing to give back: a failed link must leave
    // no zero-byte file at the real name for an agent to read as the artifact.
    markMigrated();
    run();
    fs.unlinkSync(linkAt('wgx-codex'));
    const own = linkAt('wgx-codex');
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, 'report.md'), 'THE ONLY COPY');

    const spy = vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });
    try {
      run(); // boot 1: the move fails
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(path.join(sharedWorkDir(), 'report.md'))).toBe(false);
    expect(fs.readFileSync(path.join(own, 'report.md'), 'utf8')).toBe('THE ONLY COPY');

    run(); // boot 2: retries, and gets the real name

    expect(fs.readFileSync(path.join(sharedWorkDir(), 'report.md'), 'utf8')).toBe('THE ONLY COPY');
    expect(fs.existsSync(path.join(sharedWorkDir(), 'report.md.from-wgx-codex'))).toBe(false);
  });

  it('finishes a file a previous boot linked but never unlinked, without duplicating it', () => {
    // A hard death between link and unlink leaves one inode under two names.
    // The next boot must recognise its own link, not move it aside as a
    // collision.
    markMigrated();
    run();
    fs.unlinkSync(linkAt('wgx-codex'));
    const own = linkAt('wgx-codex');
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, 'report.md'), 'MEMBER BYTES');
    fs.linkSync(path.join(own, 'report.md'), path.join(sharedWorkDir(), 'report.md'));

    run();

    expect(fs.readFileSync(path.join(sharedWorkDir(), 'report.md'), 'utf8')).toBe('MEMBER BYTES');
    expect(fs.existsSync(path.join(sharedWorkDir(), 'report.md.from-wgx-codex'))).toBe(false);
    expect(fs.readlinkSync(own)).toBe(LINK_TARGET);
  });

  it('releasing a directory claim never takes content a sibling put inside it', () => {
    markMigrated();
    run();
    fs.unlinkSync(linkAt('wgx-codex'));
    const own = linkAt('wgx-codex');
    fs.mkdirSync(own);
    fs.mkdirSync(path.join(own, 'proj'));
    fs.writeFileSync(path.join(own, 'proj', 'mine.md'), 'the members');

    // The sibling writes into the directory claim, then the move fails: the
    // release must be an rmdir that refuses, not a recursive delete.
    const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(((_from: fs.PathLike, to: fs.PathLike) => {
      fs.writeFileSync(path.join(to as string, 'sibling.md'), 'written mid-boot');
      throw new Error('EIO');
    }) as typeof fs.renameSync);
    try {
      run();
    } finally {
      spy.mockRestore();
    }

    expect(fs.readFileSync(path.join(sharedWorkDir(), 'proj', 'sibling.md'), 'utf8')).toBe('written mid-boot');
    expect(fs.readFileSync(path.join(own, 'proj', 'mine.md'), 'utf8')).toBe('the members');
  });

  it('leaves the member alone when the move strategy cannot be proven', () => {
    // sameFilesystem answers "different" when stat fails, which sends its
    // caller down the copy path. Copy is the branch with the unguarded window,
    // so an unprovable device must decline instead of choosing it.
    markMigrated();
    run();
    fs.unlinkSync(linkAt('wgx-codex'));
    const own = linkAt('wgx-codex');
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, 'work.md'), 'kept');
    const realStat = fs.statSync;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === own) throw new Error('EIO');
      return (realStat as (...a: unknown[]) => fs.Stats)(p, ...rest);
    }) as typeof fs.statSync);
    try {
      run();
    } finally {
      spy.mockRestore();
    }

    expect(fs.readFileSync(path.join(own, 'work.md'), 'utf8')).toBe('kept');
    expect(fs.existsSync(path.join(sharedWorkDir(), 'work.md'))).toBe(false);
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

  it('a partly-consolidated member survives the migrator with its unmoved work', () => {
    // The state this consolidation newly makes routine: an entry that could not
    // move leaves a REAL artifacts/ in the member folder — the #952 F1 shape,
    // where the reservation is the only thing standing between that directory
    // and the migrator's interrupted-move arm. Without it the ONLY copy is
    // destroyed: never moved to the shared tree, then rmSync'd as the source.
    markMigrated();
    run();
    fs.writeFileSync(path.join(sharedWorkDir(), 'report.md'), 'shared');
    fs.writeFileSync(path.join(sharedWorkDir(), 'report.md.from-wgx'), 'an earlier consolidation');
    fs.unlinkSync(linkAt('wgx'));
    const seedWork = linkAt('wgx');
    fs.mkdirSync(seedWork);
    fs.writeFileSync(path.join(seedWork, 'report.md'), 'THE ONLY COPY');
    fs.mkdirSync(path.join(groupsDir, 'wgx', 'sources'), { recursive: true });

    run();
    reconcileWorkgroupSharedDirs(db, { groupsDir, dataDir });

    expect(fs.readFileSync(path.join(seedWork, 'report.md'), 'utf8')).toBe('THE ONLY COPY');
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
