/**
 * Acceptance cases for the boot-quiescence scope predicates (convergence
 * seam 4, PR D1 — docs/specs/upstream-restart-survival-seam/plan.md §7.D).
 *
 * These carry property 2 of §7.D: THE PREDICATE NEVER UNDER-REPORTS. Each
 * fixture is built twice — the predicate runs on one copy, the real reconcile
 * on the other — and a disagreement fails the build. Under-reporting is the
 * dangerous direction: it would let D2 leave a container running while its
 * mount targets are rewritten underneath it.
 *
 * Hermeticity (brief-common.md HARD RULE): every tree lives under a
 * per-process `uniqueTmpRoot`, the databases are `:memory:`, and the
 * `child_process` tripwire below records and throws on any real spawn. Nothing
 * here reaches git, the network, `~/plugins`, `data/` or a host working tree.
 * The only repo path read is the shipped memory scaffold, read-only, the same
 * one src/modules/workgroup/shared-dirs.test.ts reads.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawns = vi.hoisted(() => [] as string[]);

/** A tripwire, not a functional mock: it records the call and then throws. */
function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(
        `shared-dirs.wouldchange.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`,
      );
    };
  return {
    exec: spawnAttempted('exec'),
    execFile: spawnAttempted('execFile'),
    spawn: spawnAttempted('spawn'),
    execSync: spawnAttempted('execSync'),
    execFileSync: spawnAttempted('execFileSync'),
    spawnSync: spawnAttempted('spawnSync'),
    fork: spawnAttempted('fork'),
  };
}

vi.mock('child_process', () => childProcessTripwire(spawns));
vi.mock('node:child_process', () => childProcessTripwire(spawns));

import {
  reconcileWorkgroupMemory,
  reconcileWorkgroupSharedDirs,
  sharedDirsReconcileWouldChange,
  workgroupMemoryReconcileWouldChange,
  workgroupMemoryDir,
  WORKGROUP_CONTAINER_PATH,
  WORKGROUP_MEMORY_CONTAINER_PATH,
} from './shared-dirs.js';

const MEMORY_TEMPLATES = path.resolve('container/agent-runner/src/memory/templates');

let root: string;

beforeEach(() => {
  spawns.length = 0;
  root = uniqueTmpRoot('shared-dirs-wouldchange');
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  expect(spawns).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});

interface Member {
  id: string;
  folder: string;
}

function makeDb(workgroupIds: string[], members: Array<Member & { workgroupId: string }>): Database.Database {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE workgroups (id TEXT PRIMARY KEY);
     CREATE TABLE agent_groups (id TEXT PRIMARY KEY, folder TEXT, workgroup_id TEXT);`,
  );
  for (const id of workgroupIds) db.prepare(`INSERT INTO workgroups (id) VALUES (?)`).run(id);
  for (const m of members) {
    db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run(m.id, m.folder, m.workgroupId);
  }
  return db;
}

/** A fixture tree: `<case>/groups` + `<case>/data`, built by `build`. */
function makeTree(name: string, build: (dirs: { groupsDir: string; dataDir: string }) => void): string {
  const base = path.join(root, name);
  const groupsDir = path.join(base, 'groups');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(groupsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  build({ groupsDir, dataDir });
  return base;
}

/** Byte-exact copy, symlinks preserved as symlinks (targets are container paths). */
function copyTree(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

/**
 * Content hash of a whole fixture tree — file bytes, symlink targets, and the
 * directory shape. Used for "mutates nothing" and for the shared-dirs side,
 * whose reconcile returns no report of its own.
 */
function hashTree(rootDir: string): string {
  const lines: string[] = [];
  const visit = (absolute: string, relative: string): void => {
    const st = fs.lstatSync(absolute);
    if (st.isSymbolicLink()) {
      lines.push(`symlink\0${relative}\0${fs.readlinkSync(absolute)}`);
      return;
    }
    if (st.isFile()) {
      lines.push(`file\0${relative}\0${fs.readFileSync(absolute).toString('base64')}`);
      return;
    }
    if (!st.isDirectory()) {
      lines.push(`other\0${relative}\0${st.mode}`);
      return;
    }
    lines.push(`dir\0${relative}`);
    for (const child of fs.readdirSync(absolute).sort()) {
      visit(path.join(absolute, child), relative ? path.join(relative, child) : child);
    }
  };
  visit(rootDir, '');
  return lines.join('\n');
}

function writeExactScaffold(target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(MEMORY_TEMPLATES, target, { recursive: true });
}

// ── the memory matrix ────────────────────────────────────────────────────────

interface MemoryCase {
  name: string;
  members: Array<Member>;
  build: (dirs: { groupsDir: string; dataDir: string }) => void;
}

const MEMORY_MATRIX: MemoryCase[] = [
  {
    name: 'canon-missing',
    members: [{ id: 'ag-seed', folder: 'wgx' }],
    build: ({ groupsDir }) => {
      fs.mkdirSync(path.join(groupsDir, 'wgx'), { recursive: true });
    },
  },
  {
    name: 'canon-present-member-holds-exact-scaffold',
    members: [{ id: 'ag-seed', folder: 'wgx' }],
    build: ({ groupsDir, dataDir }) => {
      fs.mkdirSync(path.join(workgroupMemoryDir('wgx', dataDir), 'preferences'), { recursive: true });
      writeExactScaffold(path.join(groupsDir, 'wgx', 'memory'));
    },
  },
  {
    name: 'member-already-holds-the-exact-link',
    members: [{ id: 'ag-seed', folder: 'wgx' }],
    build: ({ groupsDir, dataDir }) => {
      fs.mkdirSync(path.join(workgroupMemoryDir('wgx', dataDir), 'preferences'), { recursive: true });
      fs.mkdirSync(path.join(groupsDir, 'wgx'), { recursive: true });
      fs.symlinkSync(WORKGROUP_MEMORY_CONTAINER_PATH, path.join(groupsDir, 'wgx', 'memory'));
    },
  },
  {
    name: 'preferences-missing',
    members: [{ id: 'ag-seed', folder: 'wgx' }],
    build: ({ groupsDir, dataDir }) => {
      fs.mkdirSync(workgroupMemoryDir('wgx', dataDir), { recursive: true });
      fs.mkdirSync(path.join(groupsDir, 'wgx'), { recursive: true });
      fs.symlinkSync(WORKGROUP_MEMORY_CONTAINER_PATH, path.join(groupsDir, 'wgx', 'memory'));
    },
  },
  {
    name: 'migration-required',
    members: [{ id: 'ag-seed', folder: 'wgx' }],
    build: ({ groupsDir }) => {
      const legacy = path.join(groupsDir, 'wgx', 'memory', 'memories');
      fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(path.join(legacy, 'fact.md'), 'provider-local bytes\n');
    },
  },
  {
    name: 'exact-empty-with-zero-members',
    members: [],
    build: () => {
      /* no members, no canon — the reconcile materializes the canon */
    },
  },
];

describe('workgroupMemoryReconcileWouldChange', () => {
  it('the predicate matches the observed changed flag across the fixture matrix', () => {
    const observed: Record<string, { predicted: boolean; actual: boolean }> = {};

    for (const testCase of MEMORY_MATRIX) {
      const base = makeTree(testCase.name, testCase.build);
      const db = makeDb(
        ['wgx'],
        testCase.members.map((m) => ({ ...m, workgroupId: 'wgx' })),
      );

      const predicted = workgroupMemoryReconcileWouldChange(db, 'wgx', {
        groupsDir: path.join(base, 'groups'),
        dataDir: path.join(base, 'data'),
      });

      // The reconcile runs on an independent copy, so the predicate can never
      // be measured against a tree it has already influenced.
      const mirror = path.join(root, `${testCase.name}-mirror`);
      copyTree(base, mirror);
      const [report] = reconcileWorkgroupMemory(db, {
        groupsDir: path.join(mirror, 'groups'),
        dataDir: path.join(mirror, 'data'),
        workgroupIds: ['wgx'],
      });

      observed[testCase.name] = { predicted, actual: report.changed };
      db.close();
    }

    expect(observed).toEqual({
      'canon-missing': { predicted: true, actual: true },
      'canon-present-member-holds-exact-scaffold': { predicted: true, actual: true },
      'member-already-holds-the-exact-link': { predicted: false, actual: false },
      'preferences-missing': { predicted: true, actual: true },
      'migration-required': { predicted: false, actual: false },
      'exact-empty-with-zero-members': { predicted: true, actual: true },
    });
  });

  it('the predicate mutates nothing', () => {
    for (const testCase of MEMORY_MATRIX) {
      const base = makeTree(`nomutate-${testCase.name}`, testCase.build);
      const db = makeDb(
        ['wgx'],
        testCase.members.map((m) => ({ ...m, workgroupId: 'wgx' })),
      );

      const before = hashTree(base);
      workgroupMemoryReconcileWouldChange(db, 'wgx', {
        groupsDir: path.join(base, 'groups'),
        dataDir: path.join(base, 'data'),
      });
      expect(hashTree(base)).toBe(before);
      db.close();
    }
  });

  it('an empty mutate set still reports every workgroup and mutates nothing', () => {
    // `mutateWorkgroupIds` scopes the WRITES, not the report set. src/main.ts
    // derives the pending-pre-turn-context targets and the migration-required
    // operator warnings from these reports, and an ordinary boot has an empty
    // changed set — scoping the reports too would skip both on almost every
    // start.
    const base = makeTree('empty-mutate-set', ({ groupsDir, dataDir }) => {
      for (const wg of ['wga', 'wgb']) {
        fs.mkdirSync(path.join(workgroupMemoryDir(wg, dataDir), 'preferences'), { recursive: true });
        fs.mkdirSync(path.join(groupsDir, wg), { recursive: true });
        fs.symlinkSync(WORKGROUP_MEMORY_CONTAINER_PATH, path.join(groupsDir, wg, 'memory'));
      }
    });
    const dirs = { groupsDir: path.join(base, 'groups'), dataDir: path.join(base, 'data') };
    const db = makeDb(
      ['wga', 'wgb'],
      [
        { id: 'ag-a', folder: 'wga', workgroupId: 'wga' },
        { id: 'ag-b', folder: 'wgb', workgroupId: 'wgb' },
      ],
    );
    const before = hashTree(base);

    const reports = reconcileWorkgroupMemory(db, { ...dirs, mutateWorkgroupIds: [] });

    expect(reports.map((report) => report.workgroupId)).toEqual(['wga', 'wgb']);
    expect(reports.every((report) => report.changed === false)).toBe(true);
    expect(reports.every((report) => report.state.status === 'canonical')).toBe(true);
    expect(hashTree(base)).toBe(before);
    db.close();
  });

  it('a mutate set writes only its own workgroup while still reporting both', () => {
    const base = makeTree('partial-mutate-set', ({ groupsDir }) => {
      for (const wg of ['wga', 'wgb']) fs.mkdirSync(path.join(groupsDir, wg), { recursive: true });
    });
    const groupsDir = path.join(base, 'groups');
    const dataDir = path.join(base, 'data');
    const db = makeDb(
      ['wga', 'wgb'],
      [
        { id: 'ag-a', folder: 'wga', workgroupId: 'wga' },
        { id: 'ag-b', folder: 'wgb', workgroupId: 'wgb' },
      ],
    );
    const untouchedBefore = hashTree(path.join(groupsDir, 'wgb'));

    const reports = reconcileWorkgroupMemory(db, { groupsDir, dataDir, mutateWorkgroupIds: ['wga'] });

    expect(reports.map((report) => report.workgroupId)).toEqual(['wga', 'wgb']);
    expect(reports.find((report) => report.workgroupId === 'wga')!.changed).toBe(true);
    expect(reports.find((report) => report.workgroupId === 'wgb')!.changed).toBe(false);
    expect(fs.readlinkSync(path.join(groupsDir, 'wga', 'memory'))).toBe(WORKGROUP_MEMORY_CONTAINER_PATH);
    expect(hashTree(path.join(groupsDir, 'wgb'))).toBe(untouchedBefore);
    expect(fs.existsSync(workgroupMemoryDir('wgb', dataDir))).toBe(false);
    db.close();
  });

  it('a migration-required workgroup reports no change', () => {
    const base = makeTree('migration-required-alone', ({ groupsDir }) => {
      const legacy = path.join(groupsDir, 'wgx', 'memory', 'memories');
      fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(path.join(legacy, 'fact.md'), 'provider-local bytes\n');
    });
    const db = makeDb(['wgx'], [{ id: 'ag-seed', folder: 'wgx', workgroupId: 'wgx' }]);
    const dirs = { groupsDir: path.join(base, 'groups'), dataDir: path.join(base, 'data') };

    // The reconcile skips these workgroups entirely, so nothing has to be
    // stopped for them — reporting a change would stop containers for a
    // cutover that never happens.
    expect(workgroupMemoryReconcileWouldChange(db, 'wgx', dirs)).toBe(false);
    const [report] = reconcileWorkgroupMemory(db, { ...dirs, workgroupIds: ['wgx'] });
    expect(report.state.status).toBe('migration-required');
    expect(report.changed).toBe(false);
    db.close();
  });
});

// ── the shared-dirs matrix ───────────────────────────────────────────────────

interface SharedCase {
  name: string;
  build: (dirs: { groupsDir: string; dataDir: string }) => void;
}

/** A workgroup whose consolidation is already settled: nothing left to do. */
function buildSettled({ groupsDir, dataDir }: { groupsDir: string; dataDir: string }): void {
  const wgDir = path.join(dataDir, 'workgroups', 'wgx');
  fs.mkdirSync(path.join(wgDir, 'dbt', '.git'), { recursive: true });
  fs.mkdirSync(path.join(groupsDir, 'wgx'), { recursive: true });
  fs.symlinkSync(`${WORKGROUP_CONTAINER_PATH}/dbt`, path.join(groupsDir, 'wgx', 'dbt'));
  fs.mkdirSync(path.join(groupsDir, 'wgx-codex'), { recursive: true });
  fs.symlinkSync(`${WORKGROUP_CONTAINER_PATH}/dbt`, path.join(groupsDir, 'wgx-codex', 'dbt'));
}

const SHARED_MATRIX: SharedCase[] = [
  {
    name: 'no-seed-folder',
    build: ({ groupsDir }) => {
      fs.mkdirSync(path.join(groupsDir, 'wgx-codex'), { recursive: true });
    },
  },
  {
    name: 'unmoved-git-repo',
    build: ({ groupsDir }) => {
      fs.mkdirSync(path.join(groupsDir, 'wgx', 'dbt', '.git'), { recursive: true });
      fs.mkdirSync(path.join(groupsDir, 'wgx-codex'), { recursive: true });
    },
  },
  {
    name: 'nothing-shareable',
    build: ({ groupsDir }) => {
      fs.mkdirSync(path.join(groupsDir, 'wgx', 'operator_ops'), { recursive: true });
      fs.mkdirSync(path.join(groupsDir, 'wgx-codex'), { recursive: true });
    },
  },
  {
    name: 'settled',
    build: buildSettled,
  },
  {
    name: 'sibling-repoint-outstanding',
    build: ({ groupsDir, dataDir }) => {
      buildSettled({ groupsDir, dataDir });
      fs.unlinkSync(path.join(groupsDir, 'wgx-codex', 'dbt'));
    },
  },
];

describe('sharedDirsReconcileWouldChange', () => {
  it('the shared-dirs predicate matches its reconcile', () => {
    const observed: Record<string, { predicted: boolean; actual: boolean }> = {};

    for (const testCase of SHARED_MATRIX) {
      const base = makeTree(`shared-${testCase.name}`, testCase.build);
      const db = makeDb(
        ['wgx'],
        [
          { id: 'ag-seed', folder: 'wgx', workgroupId: 'wgx' },
          { id: 'ag-codex', folder: 'wgx-codex', workgroupId: 'wgx' },
        ],
      );
      const dirs = { groupsDir: path.join(base, 'groups'), dataDir: path.join(base, 'data') };

      const predicted = sharedDirsReconcileWouldChange(db, 'wgx', dirs);

      // reconcileWorkgroupSharedDirs returns no report, so the observation is
      // the tree itself: a boot at which it moves is exactly a boot at which a
      // live container's mount targets are rewritten.
      const mirror = path.join(root, `shared-${testCase.name}-mirror`);
      copyTree(base, mirror);
      const before = hashTree(mirror);
      reconcileWorkgroupSharedDirs(db, {
        groupsDir: path.join(mirror, 'groups'),
        dataDir: path.join(mirror, 'data'),
        workgroupIds: ['wgx'],
      });
      const actual = hashTree(mirror) !== before;

      observed[testCase.name] = { predicted, actual };
      db.close();
    }

    expect(observed).toEqual({
      'no-seed-folder': { predicted: false, actual: false },
      'unmoved-git-repo': { predicted: true, actual: true },
      'nothing-shareable': { predicted: false, actual: false },
      settled: { predicted: false, actual: false },
      'sibling-repoint-outstanding': { predicted: true, actual: true },
    });
  });

  it('the selector confines the reconcile to the named workgroups', () => {
    const base = makeTree('selector', ({ groupsDir }) => {
      for (const wg of ['wga', 'wgb']) {
        fs.mkdirSync(path.join(groupsDir, wg, 'dbt', '.git'), { recursive: true });
        fs.writeFileSync(path.join(groupsDir, wg, 'dbt', 'model.sql'), `select 1 -- ${wg}\n`);
        fs.mkdirSync(path.join(groupsDir, `${wg}-codex`), { recursive: true });
      }
    });
    const groupsDir = path.join(base, 'groups');
    const dataDir = path.join(base, 'data');
    const db = makeDb(
      ['wga', 'wgb'],
      [
        { id: 'ag-a', folder: 'wga', workgroupId: 'wga' },
        { id: 'ag-a-codex', folder: 'wga-codex', workgroupId: 'wga' },
        { id: 'ag-b', folder: 'wgb', workgroupId: 'wgb' },
        { id: 'ag-b-codex', folder: 'wgb-codex', workgroupId: 'wgb' },
      ],
    );

    const untouchedBefore = hashTree(path.join(groupsDir, 'wgb'));

    reconcileWorkgroupSharedDirs(db, { groupsDir, dataDir, workgroupIds: ['wga'] });
    reconcileWorkgroupMemory(db, { groupsDir, dataDir, workgroupIds: ['wga'] });

    // The selected workgroup moved…
    expect(fs.existsSync(path.join(dataDir, 'workgroups', 'wga', 'dbt'))).toBe(true);
    expect(fs.readlinkSync(path.join(groupsDir, 'wga', 'memory'))).toBe(WORKGROUP_MEMORY_CONTAINER_PATH);
    // …and the other one is byte-identical.
    expect(hashTree(path.join(groupsDir, 'wgb'))).toBe(untouchedBefore);
    expect(fs.existsSync(path.join(dataDir, 'workgroups', 'wgb'))).toBe(false);
    db.close();
  });
});
