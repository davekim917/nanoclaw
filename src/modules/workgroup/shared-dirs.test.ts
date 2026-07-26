import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  inspectWorkgroupMemoryState,
  prepareWorkgroupMemoryMember,
  reconcileWorkgroupMemory,
  reconcileWorkgroupSharedDirs,
  workgroupMemoryDir,
} from './shared-dirs.js';

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

describe('reconcileWorkgroupSharedDirs', () => {
  let tmp: string;
  let groupsDir: string;
  let dataDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wgfs-'));
    groupsDir = path.join(tmp, 'groups');
    dataDir = path.join(tmp, 'data');
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    // Seed sibling (folder === workgroup_id).
    const seed = path.join(groupsDir, 'wgx');
    fs.mkdirSync(path.join(seed, 'dbt', '.git'), { recursive: true }); // git repo → shared
    fs.mkdirSync(path.join(seed, 'sources', 'inbox'), { recursive: true }); // → shared
    fs.mkdirSync(path.join(seed, 'conversations'), { recursive: true }); // → shared
    fs.mkdirSync(path.join(seed, 'dave_ops'), { recursive: true }); // plain dir → candidate
    fs.writeFileSync(path.join(seed, 'sources', 'inbox', 'f.json'), '{}');
    fs.writeFileSync(path.join(seed, 'scratch.json'), '{}'); // loose file → stays in bedroom

    // Sibling with relative symlinks into the seed (the pre-migration sharing).
    const codex = path.join(groupsDir, 'wgx-codex');
    fs.mkdirSync(codex, { recursive: true });
    fs.symlinkSync('../wgx/sources', path.join(codex, 'sources'));
    fs.symlinkSync('../wgx/dbt', path.join(codex, 'dbt'));

    db = setupDb();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('moves shared dirs to data/workgroups/<id>, compat-symlinks the seed, repoints siblings', () => {
    reconcileWorkgroupSharedDirs(db, { groupsDir, dataDir });
    const wgDir = path.join(dataDir, 'workgroups', 'wgx');

    // Shared dirs moved into the house, contents intact.
    expect(fs.existsSync(path.join(wgDir, 'sources', 'inbox', 'f.json'))).toBe(true);
    expect(fs.existsSync(path.join(wgDir, 'dbt', '.git'))).toBe(true);
    expect(fs.existsSync(path.join(wgDir, 'conversations'))).toBe(true);

    // Seed's old paths are now container-absolute compat symlinks.
    const seedSources = path.join(groupsDir, 'wgx', 'sources');
    expect(fs.lstatSync(seedSources).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(seedSources)).toBe('/workspace/workgroup/sources');

    // Sibling's relative symlinks repointed to the mount.
    expect(fs.readlinkSync(path.join(groupsDir, 'wgx-codex', 'sources'))).toBe('/workspace/workgroup/sources');
    expect(fs.readlinkSync(path.join(groupsDir, 'wgx-codex', 'dbt'))).toBe('/workspace/workgroup/dbt');

    // Ambiguous dir + loose file stay in the bedroom (never mis-moved).
    expect(fs.lstatSync(path.join(groupsDir, 'wgx', 'dave_ops')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(groupsDir, 'wgx', 'scratch.json'))).toBe(true);

    // Reversible report.
    const marker = JSON.parse(fs.readFileSync(path.join(wgDir, '.migrated'), 'utf-8'));
    expect(marker.moved.sort()).toEqual(['conversations', 'dbt', 'sources']);
    expect(marker.candidates).toContain('dave_ops');
  });

  it('is idempotent — a second run is a no-op', () => {
    reconcileWorkgroupSharedDirs(db, { groupsDir, dataDir });
    const markerPath = path.join(dataDir, 'workgroups', 'wgx', '.migrated');
    const first = fs.readFileSync(markerPath, 'utf-8');
    reconcileWorkgroupSharedDirs(db, { groupsDir, dataDir });
    expect(fs.readFileSync(markerPath, 'utf-8')).toBe(first);
  });

  it('never clobbers a sibling that owns a real directory at a shared name', () => {
    // Replace the sibling's dbt symlink with its OWN real directory.
    fs.unlinkSync(path.join(groupsDir, 'wgx-codex', 'dbt'));
    fs.mkdirSync(path.join(groupsDir, 'wgx-codex', 'dbt'));
    fs.writeFileSync(path.join(groupsDir, 'wgx-codex', 'dbt', 'own.txt'), 'mine');

    reconcileWorkgroupSharedDirs(db, { groupsDir, dataDir });

    const sibDbt = path.join(groupsDir, 'wgx-codex', 'dbt');
    expect(fs.lstatSync(sibDbt).isSymbolicLink()).toBe(false); // still a real dir
    expect(fs.readFileSync(path.join(sibDbt, 'own.txt'), 'utf-8')).toBe('mine'); // untouched
  });

  it('never moves or repoints memory because the dedicated memory migrator owns it', () => {
    const seedMemory = path.join(groupsDir, 'wgx', 'memory');
    const siblingMemory = path.join(groupsDir, 'wgx-codex', 'memory');
    fs.mkdirSync(path.join(seedMemory, 'memories'), { recursive: true });
    fs.writeFileSync(path.join(seedMemory, 'memories', 'fact.md'), 'legacy memory\n');
    fs.symlinkSync('../wgx/memory', siblingMemory);

    reconcileWorkgroupSharedDirs(db, { groupsDir, dataDir });

    expect(fs.lstatSync(seedMemory).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(seedMemory, 'memories', 'fact.md'), 'utf8')).toBe('legacy memory\n');
    expect(fs.readlinkSync(siblingMemory)).toBe('../wgx/memory');
    expect(fs.existsSync(path.join(dataDir, 'workgroups', 'wgx', 'memory'))).toBe(false);

    const marker = JSON.parse(fs.readFileSync(path.join(dataDir, 'workgroups', 'wgx', '.migrated'), 'utf8')) as {
      moved: string[];
      candidates: string[];
    };
    expect(marker.moved).not.toContain('memory');
    expect(marker.candidates).not.toContain('memory');
  });

  it('never adopts canonical memory through generic crash recovery', () => {
    const seedMemory = path.join(groupsDir, 'wgx', 'memory');
    const canonicalMemory = path.join(dataDir, 'workgroups', 'wgx', 'memory');
    const siblingMemory = path.join(groupsDir, 'wgx-codex', 'memory');
    fs.mkdirSync(path.join(seedMemory, 'memories'), { recursive: true });
    fs.mkdirSync(path.join(canonicalMemory, 'memories'), { recursive: true });
    fs.writeFileSync(path.join(seedMemory, 'memories', 'legacy.md'), 'legacy bytes\n');
    fs.writeFileSync(path.join(canonicalMemory, 'memories', 'canon.md'), 'canonical bytes\n');
    fs.symlinkSync('../wgx/memory', siblingMemory);

    reconcileWorkgroupSharedDirs(db, { groupsDir, dataDir });

    expect(fs.lstatSync(seedMemory).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(seedMemory, 'memories', 'legacy.md'), 'utf8')).toBe('legacy bytes\n');
    expect(fs.readFileSync(path.join(canonicalMemory, 'memories', 'canon.md'), 'utf8')).toBe('canonical bytes\n');
    expect(fs.readlinkSync(siblingMemory)).toBe('../wgx/memory');

    const marker = JSON.parse(fs.readFileSync(path.join(dataDir, 'workgroups', 'wgx', '.migrated'), 'utf8')) as {
      moved: string[];
      candidates: string[];
    };
    expect(marker.moved).not.toContain('memory');
    expect(marker.candidates).not.toContain('memory');
  });

  it('cross-filesystem move uses copy+staging and leaves no partial dir', () => {
    // Force sameFilesystem(groupsDir, dataDir) -> false so the copy path runs.
    // sameFilesystem is the only fs.statSync(JS) caller in the migration; cpSync/
    // rename/rm/existsSync/lstatSync are native and unaffected by this spy.
    vi.spyOn(fs, 'statSync').mockImplementation(
      ((p: fs.PathLike) => (p === dataDir ? { dev: 2 } : { dev: 1 }) as fs.Stats) as typeof fs.statSync,
    );
    try {
      reconcileWorkgroupSharedDirs(db, { groupsDir, dataDir });
    } finally {
      vi.restoreAllMocks();
    }
    const wgDir = path.join(dataDir, 'workgroups', 'wgx');
    expect(JSON.parse(fs.readFileSync(path.join(wgDir, '.migrated'), 'utf-8')).strategy).toBe('copy');
    // Contents copied, source removed, no leftover staging dir.
    expect(fs.existsSync(path.join(wgDir, 'sources', 'inbox', 'f.json'))).toBe(true);
    expect(fs.existsSync(path.join(wgDir, 'dbt', '.git'))).toBe(true);
    expect(fs.existsSync(path.join(wgDir, '.sources.partial'))).toBe(false);
    expect(fs.lstatSync(path.join(groupsDir, 'wgx', 'sources')).isSymbolicLink()).toBe(true);
  });

  it('finishes cleanup when a crash left dst complete but the source not yet removed', () => {
    const wgDir = path.join(dataDir, 'workgroups', 'wgx');
    // Simulate a crash after the atomic move created a complete dst but before
    // the source was removed: dst exists complete, seed src is still a real dir.
    fs.mkdirSync(path.join(wgDir, 'sources', 'inbox'), { recursive: true });
    fs.writeFileSync(path.join(wgDir, 'sources', 'inbox', 'f.json'), '{}');
    expect(fs.lstatSync(path.join(groupsDir, 'wgx', 'sources')).isDirectory()).toBe(true);

    reconcileWorkgroupSharedDirs(db, { groupsDir, dataDir });

    // The leftover real source is removed and replaced with the compat symlink;
    // dst is preserved (not clobbered or re-copied).
    const seedSources = path.join(groupsDir, 'wgx', 'sources');
    expect(fs.lstatSync(seedSources).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(seedSources)).toBe('/workspace/workgroup/sources');
    expect(fs.existsSync(path.join(wgDir, 'sources', 'inbox', 'f.json'))).toBe(true);
  });

  it('recovers a moved dir whose name ends in .partial (no staging-namespace collision)', () => {
    const wgDir = path.join(dataDir, 'workgroups', 'wgx');
    // A legitimately shared git repo whose real name ends in `.partial`.
    fs.mkdirSync(path.join(groupsDir, 'wgx', 'repo.partial', '.git'), { recursive: true });
    // Simulate a crash AFTER the move (dst complete, src already removed) but
    // BEFORE the compat symlink — the exact window the wgDir re-scan recovers.
    // The old `.endsWith('.partial')` skip would orphan this dir.
    fs.mkdirSync(path.join(wgDir, 'repo.partial', '.git'), { recursive: true });
    fs.rmSync(path.join(groupsDir, 'wgx', 'repo.partial'), { recursive: true, force: true });

    reconcileWorkgroupSharedDirs(db, { groupsDir, dataDir });

    // Recovery re-added it: seed path is the compat symlink, data intact.
    const seedRepo = path.join(groupsDir, 'wgx', 'repo.partial');
    expect(fs.lstatSync(seedRepo).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(seedRepo)).toBe('/workspace/workgroup/repo.partial');
    expect(fs.existsSync(path.join(wgDir, 'repo.partial', '.git'))).toBe(true);
    // And it's recorded as moved (recovery completed the cutover).
    const marker = JSON.parse(fs.readFileSync(path.join(wgDir, '.migrated'), 'utf-8'));
    expect(marker.moved).toContain('repo.partial');
  });
});

describe('canonical workgroup memory', () => {
  let tmp: string;
  let groupsDir: string;
  let dataDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-memory-'));
    groupsDir = path.join(tmp, 'groups');
    dataDir = path.join(tmp, 'data');
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    db = setupDb();
    db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run(
      'ag-opencode',
      'wgx-opencode',
      'wgx',
    );
    for (const folder of ['wgx', 'wgx-codex', 'wgx-opencode']) {
      fs.mkdirSync(path.join(groupsDir, folder), { recursive: true });
    }
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('test_reconcile_links_all_provider_siblings_to_one_canon', () => {
    const canon = workgroupMemoryDir('wgx', dataDir);
    fs.mkdirSync(path.join(canon, 'memories'), { recursive: true });
    fs.writeFileSync(path.join(canon, 'memories', 'shared.md'), 'one authority\n');

    const reports = reconcileWorkgroupMemory(db, { groupsDir, dataDir });

    expect(reports).toEqual([
      expect.objectContaining({
        workgroupId: 'wgx',
        state: { status: 'canonical', basis: 'exact-links-and-canon' },
      }),
    ]);
    for (const folder of ['wgx', 'wgx-codex', 'wgx-opencode']) {
      const local = path.join(groupsDir, folder, 'memory');
      expect(fs.lstatSync(local).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(local)).toBe('/workspace/workgroup/memory');
    }
    expect(fs.readFileSync(path.join(canon, 'memories', 'shared.md'), 'utf8')).toBe('one authority\n');
  });

  it('uses one shared per-member primitive for canonical creation and compatibility linking', () => {
    const result = prepareWorkgroupMemoryMember({ id: 'ag-codex', folder: 'wgx-codex' }, 'wgx', { groupsDir, dataDir });

    expect(result).toEqual({
      canonicalPath: workgroupMemoryDir('wgx', dataDir),
      changed: true,
    });
    expect(fs.lstatSync(result.canonicalPath).isDirectory()).toBe(true);
    const local = path.join(groupsDir, 'wgx-codex', 'memory');
    expect(fs.lstatSync(local).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(local)).toBe('/workspace/workgroup/memory');
  });

  it('test_reconcile_blocks_substantive_legacy_tree_without_mutation', () => {
    const legacy = path.join(groupsDir, 'wgx-codex', 'memory');
    fs.mkdirSync(path.join(legacy, 'memories'), { recursive: true });
    const payload = Buffer.from('provider-local bytes\n');
    fs.writeFileSync(path.join(legacy, 'memories', 'fact.md'), payload);
    const beforeType = fs.lstatSync(legacy).isDirectory();
    const beforeHash = fs.readFileSync(path.join(legacy, 'memories', 'fact.md'));

    const reports = reconcileWorkgroupMemory(db, { groupsDir, dataDir });

    expect(reports[0].state.status).toBe('migration-required');
    expect(fs.lstatSync(legacy).isDirectory()).toBe(beforeType);
    expect(fs.readFileSync(path.join(legacy, 'memories', 'fact.md'))).toEqual(beforeHash);
    expect(fs.existsSync(workgroupMemoryDir('wgx', dataDir))).toBe(false);
    expect(fs.existsSync(path.join(groupsDir, 'wgx', 'memory'))).toBe(false);
    expect(fs.existsSync(path.join(groupsDir, 'wgx-opencode', 'memory'))).toBe(false);
  });

  it('test_reconcile_allows_only_canonical_or_exact_empty_group', () => {
    const templateRoot = path.resolve('container/agent-runner/src/memory/templates');
    const exactEmpty = path.join(groupsDir, 'wgx', 'memory');
    fs.cpSync(templateRoot, exactEmpty, { recursive: true });

    expect(inspectWorkgroupMemoryState(db, 'wgx', { groupsDir, dataDir })).toEqual({ status: 'exact-empty' });

    fs.appendFileSync(path.join(exactEmpty, 'index.md'), 'x');
    const before = fs.readFileSync(path.join(exactEmpty, 'index.md'));
    expect(inspectWorkgroupMemoryState(db, 'wgx', { groupsDir, dataDir }).status).toBe('migration-required');
    reconcileWorkgroupMemory(db, { groupsDir, dataDir });
    expect(fs.lstatSync(exactEmpty).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(exactEmpty, 'index.md'))).toEqual(before);
    expect(fs.existsSync(workgroupMemoryDir('wgx', dataDir))).toBe(false);
  });
});
