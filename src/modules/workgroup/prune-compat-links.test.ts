import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { log } from '../../log.js';

import {
  pruneDanglingWorkgroupCompatLinks,
  SHARED_WORK_DIR_NAME,
  WORKGROUP_CONTAINER_PATH,
  workgroupSharedDir,
} from './shared-dirs.js';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
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

describe('pruneDanglingWorkgroupCompatLinks', () => {
  let tmp: string;
  let groupsDir: string;
  let dataDir: string;
  let db: Database.Database;

  const run = (): void => pruneDanglingWorkgroupCompatLinks(db, { groupsDir, dataDir });
  const memberLink = (folder: string, name: string): string => path.join(groupsDir, folder, name);
  const compatTarget = (name: string): string => `${WORKGROUP_CONTAINER_PATH}/${name}`;

  /** The live install's shape: a compat link in every member for a shared name. */
  const linkInto = (folder: string, name: string, target = compatTarget(name)): void => {
    fs.symlinkSync(target, memberLink(folder, name));
  };
  const sharedEntry = (name: string): void => {
    fs.mkdirSync(path.join(workgroupSharedDir('wgx', dataDir), name), { recursive: true });
  };
  const markMigrated = (): void => {
    const wgDir = workgroupSharedDir('wgx', dataDir);
    fs.mkdirSync(wgDir, { recursive: true });
    fs.writeFileSync(path.join(wgDir, '.migrated'), '{}');
  };
  const exists = (p: string): boolean => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.info).mockClear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wgprune-'));
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

  it('removes a compat link whose shared target is gone, in every member', () => {
    markMigrated();
    linkInto('wgx', 'wt-dead');
    linkInto('wgx-codex', 'wt-dead');

    run();

    expect(exists(memberLink('wgx', 'wt-dead'))).toBe(false);
    expect(exists(memberLink('wgx-codex', 'wt-dead'))).toBe(false);
  });

  it('keeps a compat link whose shared target still exists', () => {
    markMigrated();
    sharedEntry('wt-live');
    linkInto('wgx', 'wt-live');

    run();

    expect(exists(memberLink('wgx', 'wt-live'))).toBe(true);
  });

  // The mass-deletion guard. An unreadable or absent shared tree answers
  // "gone" for every name; a per-link existsSync would delete the fleet's
  // compat links on a transient mount failure.
  it('prunes NOTHING when the shared tree cannot be listed', () => {
    markMigrated();
    linkInto('wgx', 'wt-dead');
    const wgDir = workgroupSharedDir('wgx', dataDir);
    // Capture the REAL implementation before spying. Calling `fs.readdirSync`
    // from inside the mock re-enters the mock: the member scan below then dies
    // of recursion, gets swallowed by its own try/catch, and the test passes
    // because nothing was scanned rather than because nothing was pruned.
    const realReaddir = fs.readdirSync;
    const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === wgDir) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return (realReaddir as unknown as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readdirSync);

    run();

    // Before mockRestore, which discards the call record.
    expect(readdir).toHaveBeenCalledWith(wgDir);
    readdir.mockRestore();
    expect(exists(memberLink('wgx', 'wt-dead'))).toBe(true);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'pruneDanglingWorkgroupCompatLinks: shared tree unreadable, pruned nothing',
      expect.anything(),
    );
  });

  it('leaves a link this mechanism did not write (name != target basename)', () => {
    markMigrated();
    linkInto('wgx', 'alias', compatTarget('something-else'));

    run();

    expect(exists(memberLink('wgx', 'alias'))).toBe(true);
  });

  it('leaves a clone-as-codex relative sibling link', () => {
    markMigrated();
    fs.mkdirSync(path.join(groupsDir, 'wgx', 'sources'), { recursive: true });
    linkInto('wgx-codex', 'sources', '../wgx/sources');

    run();

    expect(exists(memberLink('wgx-codex', 'sources'))).toBe(true);
  });

  it('leaves a real directory alone even when the shared tree lacks the name', () => {
    markMigrated();
    fs.mkdirSync(path.join(groupsDir, 'wgx', 'wt-real'), { recursive: true });
    fs.writeFileSync(path.join(groupsDir, 'wgx', 'wt-real', 'keep.txt'), 'keep');

    run();

    expect(fs.readFileSync(path.join(groupsDir, 'wgx', 'wt-real', 'keep.txt'), 'utf8')).toBe('keep');
  });

  // Dedicated reconcilers own these names and repair them; a prune that
  // deletes `artifacts` or `memory` fights the function that just created it.
  it('never prunes a reserved name', () => {
    markMigrated();
    linkInto('wgx', SHARED_WORK_DIR_NAME);
    linkInto('wgx', 'memory');

    run();

    expect(exists(memberLink('wgx', SHARED_WORK_DIR_NAME))).toBe(true);
    expect(exists(memberLink('wgx', 'memory'))).toBe(true);
  });

  // The mount predicate: with no mount, `/workspace/workgroup/<name>` is not
  // this mechanism's to judge.
  it('prunes nothing in a workgroup with no shared-fs mount', () => {
    // no markMigrated() and WORKGROUP_SHARED_FS is off under test
    fs.mkdirSync(workgroupSharedDir('wgx', dataDir), { recursive: true });
    linkInto('wgx', 'wt-dead');

    run();

    expect(exists(memberLink('wgx', 'wt-dead'))).toBe(true);
  });

  it('survives a member folder that does not exist yet', () => {
    markMigrated();
    db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run('ag-new', 'wgx-new', 'wgx');
    linkInto('wgx', 'wt-dead');

    expect(() => run()).not.toThrow();
    expect(exists(memberLink('wgx', 'wt-dead'))).toBe(false);
    // Without this the test passes either way: `wgx` is scanned first, so
    // `wt-dead` is already gone before the missing folder throws, and the
    // outer per-workgroup catch swallows the throw so `not.toThrow()` holds.
    // What the guard actually buys is that the workgroup is not abandoned.
    expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(
      'pruneDanglingWorkgroupCompatLinks: skipped workgroup',
      expect.anything(),
    );
  });

  // Regression guard only: `sharedNames.has` short-circuits before the
  // re-confirm, so this shape kills no mutation on its own — the raced test
  // below is what covers `lstat` vs `existsSync`. Kept because it pins the
  // listing's name semantics against a future resolve-based rewrite.
  it('keeps a link whose shared entry is itself a dangling symlink', () => {
    markMigrated();
    fs.symlinkSync('/nonexistent-target', path.join(workgroupSharedDir('wgx', dataDir), 'wt-indirect'));
    linkInto('wgx', 'wt-indirect');

    run();

    expect(exists(memberLink('wgx', 'wt-indirect'))).toBe(true);
  });

  // The window the re-confirm closes: the shared listing is taken before this
  // member is scanned, so a live container can create the target in between.
  // Hiding the name from the listing while it is real on disk is that race,
  // made deterministic. A dangling symlink is the payload because it separates
  // `lstat` (the name is taken) from `existsSync` (it does not resolve) — the
  // difference between keeping the link and pruning it.
  it('keeps a link whose target appeared after the shared listing was taken', () => {
    markMigrated();
    const wgDir = workgroupSharedDir('wgx', dataDir);
    fs.symlinkSync('/nonexistent-target', path.join(wgDir, 'wt-raced'));
    linkInto('wgx', 'wt-raced');
    const realReaddir = fs.readdirSync;
    const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const out = (realReaddir as unknown as (...a: unknown[]) => unknown)(p, ...rest);
      // Only the shared-tree listing is doctored; the member scan is real.
      if (String(p) === wgDir) return (out as string[]).filter((n) => n !== 'wt-raced');
      return out;
    }) as typeof fs.readdirSync);

    run();

    readdir.mockRestore();
    expect(exists(memberLink('wgx', 'wt-raced'))).toBe(true);
  });

  // The clause the source calls the one that matters. The `lstat` re-confirm
  // masks it in every other fixture, so this is the only shape that kills it:
  // the shared tree disappears AFTER its listing succeeded, so every re-confirm
  // answers "gone" and only the listing stands between a transient mount fault
  // and deleting the workgroup's entire compat layer.
  it('keeps links when the shared tree vanishes after its listing succeeded', () => {
    markMigrated();
    const wgDir = workgroupSharedDir('wgx', dataDir);
    sharedEntry('wt-live');
    linkInto('wgx', 'wt-live');
    const realReaddir = fs.readdirSync;
    const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const out = (realReaddir as unknown as (...a: unknown[]) => unknown)(p, ...rest);
      if (String(p) === wgDir) fs.rmSync(wgDir, { recursive: true, force: true });
      return out;
    }) as typeof fs.readdirSync);

    run();

    readdir.mockRestore();
    expect(exists(memberLink('wgx', 'wt-live'))).toBe(true);
  });

  // reconcileWorkgroupSharedDirs re-derives the established shared set from
  // these links later in the same boot: a sibling link whose name the seed
  // still holds as a real dir is unioned back in. Pruning it first un-shares
  // that directory silently.
  it('keeps a sibling link whose name the seed still holds as a real dir', () => {
    markMigrated();
    fs.mkdirSync(path.join(groupsDir, 'wgx', 'dbt-scratch'), { recursive: true });
    linkInto('wgx-codex', 'dbt-scratch');

    run();

    expect(exists(memberLink('wgx-codex', 'dbt-scratch'))).toBe(true);
  });

  it('reports what it removed', () => {
    markMigrated();
    linkInto('wgx', 'wt-a');
    linkInto('wgx', 'wt-b');

    run();

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      'pruneDanglingWorkgroupCompatLinks: removed dangling compat links',
      expect.objectContaining({ member: 'wgx', count: 2, names: ['wt-a', 'wt-b'] }),
    );
  });

  it('one unusable workgroup row does not stop the others', () => {
    markMigrated();
    db.prepare(`INSERT INTO workgroups (id) VALUES (?)`).run('../escape');
    linkInto('wgx', 'wt-dead');

    expect(() => run()).not.toThrow();
    expect(exists(memberLink('wgx', 'wt-dead'))).toBe(false);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      'pruneDanglingWorkgroupCompatLinks: skipped workgroup',
      expect.objectContaining({ workgroupId: '../escape' }),
    );
  });
});
