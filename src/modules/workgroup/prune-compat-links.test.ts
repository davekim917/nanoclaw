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
