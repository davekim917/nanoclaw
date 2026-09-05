/**
 * The boot-quiescence predicates (seam 4 D1, plan §7.D).
 *
 * The whole scoping decision rests on one claim: a pure re-read of the same
 * `lstat` facts answers "would this reconcile mutate anything?" exactly as the
 * reconcile itself would. The case that carries D compares the predicate
 * against the OBSERVED outcome across a fixture matrix — for the memory side
 * against `report.changed`, for the shared-dirs side against a before/after
 * tree hash, because that migration reports no per-workgroup flag.
 *
 * The comparison runs the reconcile on a COPY of the tree, so one matrix row
 * cannot mutate the fixture the next assertion reads.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  memoryTreeSha256,
  reconcileWorkgroupMemory,
  reconcileWorkgroupSharedDirs,
  sharedDirsReconcileWouldChange,
  workgroupMemoryDir,
  workgroupMemoryReconcileWouldChange,
  WORKGROUP_MEMORY_CONTAINER_PATH,
} from './shared-dirs.js';

const MEMORY_TEMPLATES = path.resolve('container/agent-runner/src/memory/templates');

interface Fixture {
  db: Database.Database;
  root: string;
  groupsDir: string;
  dataDir: string;
}

const open: Fixture[] = [];

/** A fresh per-process fixture root; `members` are agent-group folders of `wgx`. */
function fixture(members: string[], workgroups: string[] = ['wgx']): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-wouldchange-'));
  const groupsDir = path.join(root, 'groups');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(groupsDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE workgroups (id TEXT PRIMARY KEY);
     CREATE TABLE agent_groups (id TEXT PRIMARY KEY, folder TEXT, workgroup_id TEXT);`,
  );
  for (const id of workgroups) db.prepare(`INSERT INTO workgroups (id) VALUES (?)`).run(id);
  for (const folder of members) {
    const workgroupId = workgroups.find((id) => folder === id || folder.startsWith(`${id}-`)) ?? workgroups[0];
    db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run(
      `ag-${folder}`,
      folder,
      workgroupId,
    );
    fs.mkdirSync(path.join(groupsDir, folder), { recursive: true });
  }

  const f = { db, root, groupsDir, dataDir };
  open.push(f);
  return f;
}

afterEach(() => {
  while (open.length > 0) {
    const f = open.pop()!;
    f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

/** Hash of both fixture roots. Dangling container-absolute links hash as links. */
function treeHash(f: Fixture): string {
  return `${memoryTreeSha256(f.groupsDir)}:${memoryTreeSha256(f.dataDir)}`;
}

/** A byte-faithful copy of a fixture's trees, sharing the same in-memory DB. */
function copyOf(f: Fixture): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-wouldchange-copy-'));
  const groupsDir = path.join(root, 'groups');
  const dataDir = path.join(root, 'data');
  fs.cpSync(f.groupsDir, groupsDir, { recursive: true, verbatimSymlinks: true });
  fs.cpSync(f.dataDir, dataDir, { recursive: true, verbatimSymlinks: true });
  const copy = { db: f.db, root, groupsDir, dataDir };
  // Pushed WITHOUT its db so afterEach does not close the shared handle twice.
  open.push({ ...copy, db: new Database(':memory:') });
  return copy;
}

function exactLink(f: Fixture, folder: string): void {
  fs.symlinkSync(WORKGROUP_MEMORY_CONTAINER_PATH, path.join(f.groupsDir, folder, 'memory'));
}

function canon(f: Fixture, opts: { preferences: boolean }): void {
  const canonical = workgroupMemoryDir('wgx', f.dataDir);
  fs.mkdirSync(canonical, { recursive: true });
  if (opts.preferences) fs.mkdirSync(path.join(canonical, 'preferences'));
}

/** Each row: a name and a builder that leaves the fixture in that state. */
const MEMORY_MATRIX: Array<{ name: string; build: () => Fixture }> = [
  {
    name: 'canon missing',
    build: () => fixture(['wgx', 'wgx-codex']),
  },
  {
    name: 'canon present and a member holding the exact shipped scaffold',
    build: () => {
      const f = fixture(['wgx', 'wgx-codex']);
      canon(f, { preferences: true });
      exactLink(f, 'wgx');
      fs.cpSync(MEMORY_TEMPLATES, path.join(f.groupsDir, 'wgx-codex', 'memory'), { recursive: true });
      return f;
    },
  },
  {
    name: 'every member already holding the exact link',
    build: () => {
      const f = fixture(['wgx', 'wgx-codex']);
      canon(f, { preferences: true });
      exactLink(f, 'wgx');
      exactLink(f, 'wgx-codex');
      return f;
    },
  },
  {
    name: 'preferences/ missing under a settled canon',
    build: () => {
      const f = fixture(['wgx', 'wgx-codex']);
      canon(f, { preferences: false });
      exactLink(f, 'wgx');
      exactLink(f, 'wgx-codex');
      return f;
    },
  },
  {
    name: 'migration-required',
    build: () => {
      const f = fixture(['wgx', 'wgx-codex']);
      const legacy = path.join(f.groupsDir, 'wgx-codex', 'memory');
      fs.mkdirSync(path.join(legacy, 'memories'), { recursive: true });
      fs.writeFileSync(path.join(legacy, 'memories', 'fact.md'), 'provider-local bytes\n');
      return f;
    },
  },
  {
    name: 'exact-empty with zero members',
    build: () => fixture([]),
  },
];

/**
 * What each row is expected to answer. Pinned rather than derived, so a
 * fixture that quietly stops reaching its state (an exact-link row that no
 * longer links, say) fails here instead of agreeing with the predicate about
 * a case neither one is exercising.
 */
const MEMORY_EXPECTED = [
  'canon missing=true',
  'canon present and a member holding the exact shipped scaffold=true',
  'every member already holding the exact link=false',
  'preferences/ missing under a settled canon=true',
  'migration-required=false',
  'exact-empty with zero members=true',
];

describe('workgroupMemoryReconcileWouldChange', () => {
  it('the predicate matches the observed changed flag across the fixture matrix', () => {
    const predictions: string[] = [];
    const observations: string[] = [];
    for (const row of MEMORY_MATRIX) {
      const f = row.build();
      const predicted = workgroupMemoryReconcileWouldChange(f.db, 'wgx', {
        groupsDir: f.groupsDir,
        dataDir: f.dataDir,
      });
      predictions.push(`${row.name}=${predicted}`);

      const mirror = copyOf(f);
      const [report] = reconcileWorkgroupMemory(f.db, { groupsDir: mirror.groupsDir, dataDir: mirror.dataDir });
      observations.push(`${row.name}=${report.changed}`);
    }

    expect(predictions).toEqual(observations);
    expect(observations).toEqual(MEMORY_EXPECTED);
  });

  it('the predicate mutates nothing', () => {
    for (const row of MEMORY_MATRIX) {
      const f = row.build();
      const before = treeHash(f);
      workgroupMemoryReconcileWouldChange(f.db, 'wgx', { groupsDir: f.groupsDir, dataDir: f.dataDir });
      expect(`${row.name}: ${treeHash(f)}`).toBe(`${row.name}: ${before}`);
    }
  });

  it('a migration-required workgroup reports no change', () => {
    const f = fixture(['wgx', 'wgx-codex']);
    const legacy = path.join(f.groupsDir, 'wgx-codex', 'memory');
    fs.mkdirSync(path.join(legacy, 'memories'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'memories', 'fact.md'), 'provider-local bytes\n');

    // The reconcile skips these workgroups untouched, so nothing has to be
    // stopped for them — under-reporting here is the SAFE direction.
    expect(workgroupMemoryReconcileWouldChange(f.db, 'wgx', { groupsDir: f.groupsDir, dataDir: f.dataDir })).toBe(
      false,
    );
  });

  it('the selector confines the reconcile to the named workgroups', () => {
    const f = fixture(['wgx', 'wgy'], ['wgx', 'wgy']);
    const untouchedBefore = memoryTreeSha256(path.join(f.groupsDir, 'wgy'));

    reconcileWorkgroupMemory(f.db, { groupsDir: f.groupsDir, dataDir: f.dataDir, workgroupIds: ['wgx'] });

    expect(fs.lstatSync(path.join(f.groupsDir, 'wgx', 'memory')).isSymbolicLink()).toBe(true);
    expect(memoryTreeSha256(path.join(f.groupsDir, 'wgy'))).toBe(untouchedBefore);
    expect(fs.existsSync(workgroupMemoryDir('wgy', f.dataDir))).toBe(false);
  });
});

/** Seed a workgroup folder with the shapes `migrateWorkgroup` consolidates. */
function seedSharedDirs(f: Fixture, workgroupId = 'wgx'): void {
  const seed = path.join(f.groupsDir, workgroupId);
  fs.mkdirSync(path.join(seed, 'dbt', '.git'), { recursive: true }); // git repo → shared
  fs.mkdirSync(path.join(seed, 'sources', 'inbox'), { recursive: true }); // → shared
  fs.writeFileSync(path.join(seed, 'sources', 'inbox', 'f.json'), '{}');
  fs.mkdirSync(path.join(seed, 'operator_ops'), { recursive: true }); // plain dir → candidate
}

const SHARED_MATRIX: Array<{ name: string; build: () => Fixture }> = [
  {
    name: 'an unmigrated seed with shared dirs',
    build: () => {
      const f = fixture(['wgx', 'wgx-codex']);
      seedSharedDirs(f);
      return f;
    },
  },
  {
    name: 'a sibling symlink still pointing at the old relative path',
    build: () => {
      const f = fixture(['wgx', 'wgx-codex']);
      seedSharedDirs(f);
      fs.symlinkSync('../wgx/sources', path.join(f.groupsDir, 'wgx-codex', 'sources'));
      return f;
    },
  },
  {
    name: 'a settled workgroup, already consolidated',
    build: () => {
      const f = fixture(['wgx', 'wgx-codex']);
      seedSharedDirs(f);
      reconcileWorkgroupSharedDirs(f.db, { groupsDir: f.groupsDir, dataDir: f.dataDir });
      return f;
    },
  },
  {
    name: 'a seed folder holding only candidates',
    build: () => {
      const f = fixture(['wgx', 'wgx-codex']);
      fs.mkdirSync(path.join(f.groupsDir, 'wgx', 'operator_ops'), { recursive: true });
      return f;
    },
  },
  {
    name: 'no seed folder at all',
    build: () => fixture(['wgx-codex']),
  },
];

const SHARED_EXPECTED = [
  'an unmigrated seed with shared dirs=true',
  'a sibling symlink still pointing at the old relative path=true',
  'a settled workgroup, already consolidated=false',
  'a seed folder holding only candidates=false',
  'no seed folder at all=false',
];

describe('sharedDirsReconcileWouldChange', () => {
  it('the shared-dirs predicate matches its reconcile', () => {
    const predictions: string[] = [];
    const observations: string[] = [];
    for (const row of SHARED_MATRIX) {
      const f = row.build();
      predictions.push(
        `${row.name}=${sharedDirsReconcileWouldChange(f.db, 'wgx', { groupsDir: f.groupsDir, dataDir: f.dataDir })}`,
      );

      // `reconcileWorkgroupSharedDirs` returns void, so the observed answer is
      // whether the trees moved at all — a stricter comparison than a flag.
      const mirror = copyOf(f);
      const before = treeHash(mirror);
      reconcileWorkgroupSharedDirs(f.db, { groupsDir: mirror.groupsDir, dataDir: mirror.dataDir });
      observations.push(`${row.name}=${treeHash(mirror) !== before}`);
    }

    expect(predictions).toEqual(observations);
    expect(observations).toEqual(SHARED_EXPECTED);
  });

  it('the predicate mutates nothing', () => {
    for (const row of SHARED_MATRIX) {
      const f = row.build();
      const before = treeHash(f);
      sharedDirsReconcileWouldChange(f.db, 'wgx', { groupsDir: f.groupsDir, dataDir: f.dataDir });
      expect(`${row.name}: ${treeHash(f)}`).toBe(`${row.name}: ${before}`);
    }
  });

  it('the selector confines the reconcile to the named workgroups', () => {
    const f = fixture(['wgx', 'wgy'], ['wgx', 'wgy']);
    seedSharedDirs(f, 'wgx');
    seedSharedDirs(f, 'wgy');
    const untouchedBefore = memoryTreeSha256(path.join(f.groupsDir, 'wgy'));

    reconcileWorkgroupSharedDirs(f.db, { groupsDir: f.groupsDir, dataDir: f.dataDir, workgroupIds: ['wgx'] });

    expect(fs.existsSync(path.join(f.dataDir, 'workgroups', 'wgx', 'dbt', '.git'))).toBe(true);
    expect(memoryTreeSha256(path.join(f.groupsDir, 'wgy'))).toBe(untouchedBefore);
    expect(fs.existsSync(path.join(f.dataDir, 'workgroups', 'wgy'))).toBe(false);
  });
});
