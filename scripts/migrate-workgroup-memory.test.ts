import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyMigrationReport,
  inventoryMigration,
  readMigrationReport,
  rollbackMigrationReport,
  runCli,
} from './migrate-workgroup-memory.js';
import { inspectWorkgroupMemoryState } from '../src/modules/workgroup/shared-dirs.js';

function sha(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function claudeNativeMemory(dataDir: string, agentGroupId: string, projectHash: string): string {
  return path.join(dataDir, 'v2-sessions', agentGroupId, '.claude-shared', 'projects', projectHash, 'memory');
}

describe('migrate-workgroup-memory', () => {
  let tmp: string;
  let groupsDir: string;
  let dataDir: string;
  let dbPath: string;
  let reportPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-migration-'));
    groupsDir = path.join(tmp, 'groups');
    dataDir = path.join(tmp, 'data');
    dbPath = path.join(dataDir, 'v2.db');
    reportPath = path.join(tmp, 'report.json');
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE workgroups (id TEXT PRIMARY KEY);
      CREATE TABLE agent_groups (
        id TEXT PRIMARY KEY,
        folder TEXT NOT NULL,
        workgroup_id TEXT NOT NULL
      );
    `);
    db.prepare(`INSERT INTO workgroups (id) VALUES (?)`).run('alpha');
    db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run('ag-alpha', 'alpha', 'alpha');
    db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run(
      'ag-codex',
      'alpha-codex',
      'alpha',
    );
    fs.mkdirSync(path.join(groupsDir, 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(groupsDir, 'alpha-codex'), { recursive: true });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function inventory(): void {
    inventoryMigration({
      db,
      dbPath,
      groupsDir,
      dataDir,
      workgroupIds: ['alpha'],
      reportPath,
    });
  }

  const quiescent = {
    proveQuiescence: () => [] as string[],
    trustedPaths: () => ({ dbPath, groupsDir, dataDir }),
  };

  it('test_apply_preserves_distinct_colliding_bytes_and_exact_origins', () => {
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    const codex = path.join(groupsDir, 'alpha-codex', 'memory');
    fs.mkdirSync(alpha);
    fs.mkdirSync(codex);
    fs.writeFileSync(path.join(alpha, 'profile.md'), 'base\n');
    fs.writeFileSync(path.join(codex, 'profile.md'), 'codex\n');
    fs.writeFileSync(path.join(alpha, 'same.md'), 'identical\n');
    fs.writeFileSync(path.join(codex, 'same.md'), 'identical\n');
    fs.mkdirSync(path.join(codex, 'empty-only'));

    inventory();
    const beforeInventory = readMigrationReport(reportPath);
    expect(fs.lstatSync(alpha).isDirectory()).toBe(true);
    expect(beforeInventory.workgroups[0].status).toBe('inventoried');

    applyMigrationReport(reportPath, quiescent);

    const canonical = path.join(dataDir, 'workgroups', 'alpha', 'memory');
    expect(fs.readFileSync(path.join(canonical, 'profile.md'), 'utf8')).toBe('base\n');
    expect(fs.readFileSync(path.join(canonical, 'imports', 'alpha-codex', 'profile.md'), 'utf8')).toBe('codex\n');
    expect(fs.lstatSync(path.join(canonical, 'imports', 'alpha-codex', 'empty-only')).isDirectory()).toBe(true);
    const applied = readMigrationReport(reportPath).workgroups[0];
    const exactOrigins = applied.outcomes!.filter((outcome) => outcome.relativePath === 'same.md');
    expect(exactOrigins).toHaveLength(2);
    expect(new Set(exactOrigins.map((outcome) => outcome.canonicalRelativePath))).toEqual(
      new Set(['same.md', path.join('imports', 'alpha-codex', 'same.md')]),
    );
    expect(fs.existsSync(applied.snapshotDir!)).toBe(true);
    expect(path.relative(path.join(dataDir, 'workgroups', 'alpha'), applied.snapshotDir!).startsWith('..')).toBe(true);
  });

  it('preserves a collision when the deterministic import path is already customized', () => {
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    const codex = path.join(groupsDir, 'alpha-codex', 'memory');
    fs.mkdirSync(path.join(alpha, 'imports', 'alpha-codex'), { recursive: true });
    fs.mkdirSync(codex);
    fs.writeFileSync(path.join(alpha, 'profile.md'), 'base\n');
    fs.writeFileSync(path.join(alpha, 'imports', 'alpha-codex', 'profile.md'), 'existing custom import\n');
    fs.writeFileSync(path.join(codex, 'profile.md'), 'new collision\n');

    inventory();
    applyMigrationReport(reportPath, quiescent);

    const canonical = path.join(dataDir, 'workgroups', 'alpha', 'memory');
    expect(fs.readFileSync(path.join(canonical, 'profile.md'), 'utf8')).toBe('base\n');
    expect(fs.readFileSync(path.join(canonical, 'imports', 'alpha-codex', 'profile.md'), 'utf8')).toBe(
      'existing custom import\n',
    );
    const outcome = readMigrationReport(reportPath).workgroups[0].outcomes!.find(
      (candidate) => candidate.sourcePath === codex && candidate.relativePath === 'profile.md',
    )!;
    expect(outcome.canonicalRelativePath).toMatch(
      /^imports\/alpha-codex\/__collisions\/tree-[a-f0-9]{64}\/profile\.md$/,
    );
    expect(fs.readFileSync(path.join(canonical, outcome.canonicalRelativePath), 'utf8')).toBe('new collision\n');
  });

  it('reuses an exact deterministic import tree even when the direct path is absent', () => {
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    const codex = path.join(groupsDir, 'alpha-codex', 'memory');
    fs.mkdirSync(path.join(alpha, 'imports', 'alpha-codex'), { recursive: true });
    fs.mkdirSync(codex);
    fs.writeFileSync(path.join(alpha, 'imports', 'alpha-codex', 'profile.md'), 'prior lineage\n');
    fs.writeFileSync(path.join(codex, 'profile.md'), 'prior lineage\n');

    inventory();
    applyMigrationReport(reportPath, quiescent);

    const applied = readMigrationReport(reportPath).workgroups[0]!;
    const outcome = applied.outcomes!.find(
      (candidate) => candidate.sourcePath === codex && candidate.relativePath === 'profile.md',
    );
    expect(outcome).toMatchObject({
      canonicalRelativePath: path.join('imports', 'alpha-codex', 'profile.md'),
      exactDuplicate: true,
    });
    expect(fs.existsSync(path.join(applied.canonicalPath, 'profile.md'))).toBe(false);
  });

  it('rejects a symlinked group-folder ancestor before inventory can follow it', () => {
    const external = path.join(tmp, 'external-group');
    fs.mkdirSync(path.join(external, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(external, 'memory', 'outside.md'), 'must remain outside\n');
    fs.rmSync(path.join(groupsDir, 'alpha-codex'), { recursive: true });
    fs.symlinkSync(external, path.join(groupsDir, 'alpha-codex'));

    expect(() => inventory()).toThrow(/symlinked ancestor/i);
    expect(fs.readFileSync(path.join(external, 'memory', 'outside.md'), 'utf8')).toBe('must remain outside\n');
    expect(fs.existsSync(reportPath)).toBe(false);
  });

  it('deduplicates identical same-path imported collisions while retaining every origin', () => {
    db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run(
      'ag-opencode',
      'alpha-opencode',
      'alpha',
    );
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    const codex = path.join(groupsDir, 'alpha-codex', 'memory');
    const opencode = path.join(groupsDir, 'alpha-opencode', 'memory');
    fs.mkdirSync(alpha);
    fs.mkdirSync(codex);
    fs.mkdirSync(opencode, { recursive: true });
    fs.writeFileSync(path.join(alpha, 'profile.md'), 'base\n');
    fs.writeFileSync(path.join(codex, 'profile.md'), 'shared collider\n');
    fs.writeFileSync(path.join(opencode, 'profile.md'), 'shared collider\n');
    const alphaHash = sha(path.join(alpha, 'profile.md'));
    const codexHash = sha(path.join(codex, 'profile.md'));
    const opencodeHash = sha(path.join(opencode, 'profile.md'));

    inventory();
    applyMigrationReport(reportPath, quiescent);

    const canonical = path.join(dataDir, 'workgroups', 'alpha', 'memory');
    const selectedCollision = path.join(canonical, 'imports', 'alpha-codex', 'profile.md');
    expect(fs.readFileSync(path.join(canonical, 'profile.md'), 'utf8')).toBe('base\n');
    expect(fs.readFileSync(selectedCollision, 'utf8')).toBe('shared collider\n');
    expect(fs.existsSync(path.join(canonical, 'imports', 'alpha-opencode', 'profile.md'))).toBe(false);
    const applied = readMigrationReport(reportPath).workgroups[0];
    const profileOrigins = applied.outcomes!.filter((outcome) => outcome.relativePath === 'profile.md');
    expect(profileOrigins).toHaveLength(3);
    expect(new Set(profileOrigins.map((outcome) => outcome.canonicalRelativePath))).toEqual(
      new Set(['profile.md', path.join('imports', 'alpha-codex', 'profile.md')]),
    );
    const collisionOrigins = profileOrigins.filter(
      (outcome) => outcome.relativePath === 'profile.md' && outcome.sourcePath !== alpha,
    );
    expect(collisionOrigins).toEqual([
      expect.objectContaining({
        sourcePath: codex,
        canonicalRelativePath: path.join('imports', 'alpha-codex', 'profile.md'),
        exactDuplicate: false,
      }),
      expect.objectContaining({
        sourcePath: opencode,
        canonicalRelativePath: path.join('imports', 'alpha-codex', 'profile.md'),
        exactDuplicate: true,
      }),
    ]);

    rollbackMigrationReport(reportPath, quiescent);

    expect(fs.lstatSync(alpha).isDirectory()).toBe(true);
    expect(sha(path.join(alpha, 'profile.md'))).toBe(alphaHash);
    expect(fs.lstatSync(codex).isDirectory()).toBe(true);
    expect(sha(path.join(codex, 'profile.md'))).toBe(codexHash);
    expect(fs.lstatSync(opencode).isDirectory()).toBe(true);
    expect(sha(path.join(opencode, 'profile.md'))).toBe(opencodeHash);
    expect(readMigrationReport(reportPath).workgroups[0].status).toBe('rolled-back');
  });

  it('preserves identical bytes at distinct relative paths and their path-dependent references', () => {
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    const codex = path.join(groupsDir, 'alpha-codex', 'memory');
    fs.mkdirSync(path.join(alpha, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(codex, 'contacts'), { recursive: true });
    fs.writeFileSync(path.join(alpha, 'notes', 'customer.md'), 'same customer bytes\n');
    fs.writeFileSync(path.join(codex, 'contacts', 'customer.md'), 'same customer bytes\n');
    fs.writeFileSync(path.join(codex, 'index.md'), '[Customer](contacts/customer.md)\n');
    const alphaHash = sha(path.join(alpha, 'notes', 'customer.md'));
    const codexHash = sha(path.join(codex, 'contacts', 'customer.md'));

    inventory();
    applyMigrationReport(reportPath, quiescent);

    const canonical = path.join(dataDir, 'workgroups', 'alpha', 'memory');
    expect(fs.readFileSync(path.join(canonical, 'notes', 'customer.md'), 'utf8')).toBe('same customer bytes\n');
    expect(fs.readFileSync(path.join(canonical, 'contacts', 'customer.md'), 'utf8')).toBe('same customer bytes\n');
    expect(fs.readFileSync(path.join(canonical, 'index.md'), 'utf8')).toBe('[Customer](contacts/customer.md)\n');
    const applied = readMigrationReport(reportPath).workgroups[0];
    const customerOutcomes = applied.outcomes!.filter((outcome) => outcome.relativePath.endsWith('customer.md'));
    expect(customerOutcomes).toEqual([
      expect.objectContaining({
        sourcePath: alpha,
        relativePath: path.join('notes', 'customer.md'),
        canonicalRelativePath: path.join('notes', 'customer.md'),
        exactDuplicate: false,
      }),
      expect.objectContaining({
        sourcePath: codex,
        relativePath: path.join('contacts', 'customer.md'),
        canonicalRelativePath: path.join('contacts', 'customer.md'),
        exactDuplicate: false,
      }),
    ]);

    rollbackMigrationReport(reportPath, quiescent);

    expect(fs.lstatSync(alpha).isDirectory()).toBe(true);
    expect(sha(path.join(alpha, 'notes', 'customer.md'))).toBe(alphaHash);
    expect(fs.lstatSync(codex).isDirectory()).toBe(true);
    expect(sha(path.join(codex, 'contacts', 'customer.md'))).toBe(codexHash);
    expect(fs.readFileSync(path.join(codex, 'index.md'), 'utf8')).toBe('[Customer](contacts/customer.md)\n');
  });

  it('reuses an exact pre-existing import destination without breaking its relative links', () => {
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    const codex = path.join(groupsDir, 'alpha-codex', 'memory');
    const imported = path.join(alpha, 'imports', 'alpha-codex');
    fs.mkdirSync(path.join(imported, 'system'), { recursive: true });
    fs.mkdirSync(path.join(alpha, 'system'), { recursive: true });
    fs.mkdirSync(path.join(codex, 'system'), { recursive: true });
    fs.writeFileSync(path.join(alpha, 'index.md'), 'base index\n');
    fs.writeFileSync(path.join(alpha, 'system', 'definition.md'), 'base definition\n');
    fs.writeFileSync(path.join(imported, 'index.md'), '[Definition](system/definition.md)\n');
    fs.writeFileSync(path.join(imported, 'system', 'definition.md'), 'shared definition\n');
    fs.writeFileSync(path.join(codex, 'index.md'), '[Definition](system/definition.md)\n');
    fs.writeFileSync(path.join(codex, 'system', 'definition.md'), 'shared definition\n');

    inventory();
    applyMigrationReport(reportPath, quiescent);

    const canonical = path.join(dataDir, 'workgroups', 'alpha', 'memory');
    expect(fs.readFileSync(path.join(canonical, 'imports', 'alpha-codex', 'index.md'), 'utf8')).toBe(
      '[Definition](system/definition.md)\n',
    );
    expect(fs.readFileSync(path.join(canonical, 'imports', 'alpha-codex', 'system', 'definition.md'), 'utf8')).toBe(
      'shared definition\n',
    );
    expect(fs.existsSync(path.join(canonical, 'imports', 'alpha-codex', '__collisions'))).toBe(false);
    const applied = readMigrationReport(reportPath).workgroups[0];
    const codexOutcomes = applied.outcomes!.filter((outcome) => outcome.sourcePath === codex);
    expect(codexOutcomes).toEqual([
      expect.objectContaining({
        relativePath: 'index.md',
        canonicalRelativePath: path.join('imports', 'alpha-codex', 'index.md'),
        exactDuplicate: true,
      }),
      expect.objectContaining({
        relativePath: path.join('system', 'definition.md'),
        canonicalRelativePath: path.join('imports', 'alpha-codex', 'system', 'definition.md'),
        exactDuplicate: true,
      }),
    ]);
  });

  it('inventories all Claude project hashes and preserves collisions, outcomes, snapshots, and rollback', () => {
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    const nativeA = claudeNativeMemory(dataDir, 'ag-alpha', 'legacy-project-a');
    const nativeB = claudeNativeMemory(dataDir, 'ag-alpha', 'legacy-project-b');
    fs.mkdirSync(alpha);
    fs.mkdirSync(nativeA, { recursive: true });
    fs.mkdirSync(nativeB, { recursive: true });
    fs.writeFileSync(path.join(alpha, 'profile.md'), 'group base\n');
    fs.writeFileSync(path.join(alpha, 'same.md'), 'same bytes\n');
    fs.writeFileSync(path.join(nativeA, 'profile.md'), 'native a\n');
    fs.writeFileSync(path.join(nativeA, 'same.md'), 'same bytes\n');
    fs.writeFileSync(path.join(nativeB, 'profile.md'), 'native b\n');
    fs.writeFileSync(path.join(nativeB, 'same.md'), 'same bytes\n');
    const nativeAHash = sha(path.join(nativeA, 'profile.md'));
    const nativeBHash = sha(path.join(nativeB, 'profile.md'));

    inventory();
    const inventoried = readMigrationReport(reportPath).workgroups[0];
    const nativeSources = inventoried.sources.filter((source) => source.kind === 'provider-native');
    expect(nativeSources).toHaveLength(2);
    expect(nativeSources.map((source) => source.rootPath)).toEqual([nativeA, nativeB]);
    expect(nativeSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'claude',
          nativeProjectHash: 'legacy-project-a',
          rootType: 'directory',
          rootSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          provider: 'claude',
          nativeProjectHash: 'legacy-project-b',
          rootType: 'directory',
          rootSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    );

    applyMigrationReport(reportPath, quiescent);

    const canonical = path.join(dataDir, 'workgroups', 'alpha', 'memory');
    expect(fs.readFileSync(path.join(canonical, 'profile.md'), 'utf8')).toBe('group base\n');
    expect(
      fs.readFileSync(path.join(canonical, 'imports', 'alpha-claude-legacy-project-a', 'profile.md'), 'utf8'),
    ).toBe('native a\n');
    expect(
      fs.readFileSync(path.join(canonical, 'imports', 'alpha-claude-legacy-project-b', 'profile.md'), 'utf8'),
    ).toBe('native b\n');
    const applied = readMigrationReport(reportPath).workgroups[0];
    expect(applied.snapshotEntries?.map((entry) => entry.sourcePath)).toEqual(
      expect.arrayContaining([nativeA, nativeB]),
    );
    expect(applied.outcomes?.filter((outcome) => outcome.relativePath === 'same.md')).toHaveLength(3);
    expect(applied.outcomes?.filter((outcome) => outcome.sourcePath === nativeA)).toHaveLength(2);
    expect(applied.outcomes?.filter((outcome) => outcome.sourcePath === nativeB)).toHaveLength(2);
    for (const native of [nativeA, nativeB]) {
      expect(fs.lstatSync(native).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(native)).toBe(canonical);
    }

    rollbackMigrationReport(reportPath, quiescent);

    expect(fs.lstatSync(nativeA).isDirectory()).toBe(true);
    expect(sha(path.join(nativeA, 'profile.md'))).toBe(nativeAHash);
    expect(fs.lstatSync(nativeB).isDirectory()).toBe(true);
    expect(sha(path.join(nativeB, 'profile.md'))).toBe(nativeBHash);
    expect(readMigrationReport(reportPath).workgroups[0].status).toBe('rolled-back');
  });

  it('snapshots and blocks an opaque Claude-native memory link without activating it', () => {
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    const native = claudeNativeMemory(dataDir, 'ag-alpha', 'opaque-project');
    const outside = path.join(tmp, 'opaque-native-store');
    fs.mkdirSync(alpha);
    fs.writeFileSync(path.join(alpha, 'fact.md'), 'group bytes\n');
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, native);
    inventory();

    applyMigrationReport(reportPath, quiescent);

    const result = readMigrationReport(reportPath).workgroups[0];
    const nativeSource = result.sources.find((source) => source.rootPath === native);
    expect(nativeSource).toEqual(
      expect.objectContaining({
        kind: 'provider-native',
        provider: 'claude',
        nativeProjectHash: 'opaque-project',
        rootType: 'symlink',
      }),
    );
    expect(result.status).toBe('blocked');
    expect(result.error).toMatch(/opaque.*symlink|symlink.*opaque/i);
    expect(fs.existsSync(result.snapshotDir!)).toBe(true);
    expect(fs.lstatSync(native).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(native)).toBe(outside);
    expect(fs.lstatSync(alpha).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'workgroups', 'alpha', 'memory'))).toBe(false);
  });

  it('test_apply_aborts_on_post_snapshot_change', () => {
    const source = path.join(groupsDir, 'alpha', 'memory');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'fact.md'), 'before\n');
    inventory();

    applyMigrationReport(reportPath, {
      ...quiescent,
      afterSnapshot: () => {
        fs.writeFileSync(path.join(source, 'fact.md'), 'after\n');
      },
    });

    const result = readMigrationReport(reportPath).workgroups[0];
    expect(result.status).toBe('blocked');
    expect(result.error).toMatch(/changed after snapshot/i);
    expect(fs.lstatSync(source).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(source, 'fact.md'), 'utf8')).toBe('after\n');
    expect(fs.existsSync(path.join(dataDir, 'workgroups', 'alpha', 'memory'))).toBe(false);
  });

  it('persists permanent snapshot metadata before any cutover mutation', () => {
    const source = path.join(groupsDir, 'alpha', 'memory');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'fact.md'), 'snapshotted\n');
    inventory();
    let observedPersistedSnapshot = false;

    applyMigrationReport(reportPath, {
      ...quiescent,
      afterSnapshot: (migration) => {
        const persisted = readMigrationReport(reportPath).workgroups[0];
        observedPersistedSnapshot =
          persisted.snapshotDir === migration.snapshotDir &&
          persisted.snapshotEntries?.length === migration.snapshotEntries?.length;
        throw new Error('stop after persisted snapshot');
      },
    });

    expect(observedPersistedSnapshot).toBe(true);
    const result = readMigrationReport(reportPath).workgroups[0];
    expect(result.status).toBe('blocked');
    expect(fs.existsSync(result.snapshotDir!)).toBe(true);
    expect(fs.lstatSync(source).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'workgroups', 'alpha', 'memory'))).toBe(false);
  });

  it('blocks before cutover when the immediate quiescence reproof fails', () => {
    const source = path.join(groupsDir, 'alpha', 'memory');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'fact.md'), 'unchanged\n');
    inventory();
    let proofs = 0;

    applyMigrationReport(reportPath, {
      ...quiescent,
      proveQuiescence: () => {
        proofs += 1;
        if (proofs === 2) throw new Error('container respawned before cutover');
        return [];
      },
    });

    const result = readMigrationReport(reportPath).workgroups[0];
    const canonical = path.join(dataDir, 'workgroups', 'alpha', 'memory');
    const canonicalParent = path.dirname(canonical);
    expect(proofs).toBe(2);
    expect(result.status).toBe('blocked');
    expect(result.error).toMatch(/container respawned before cutover/);
    expect(fs.existsSync(result.snapshotDir!)).toBe(true);
    expect(fs.lstatSync(source).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(source, 'fact.md'), 'utf8')).toBe('unchanged\n');
    expect(fs.existsSync(canonical)).toBe(false);
    expect(
      fs.existsSync(canonicalParent)
        ? fs.readdirSync(canonicalParent).filter((entry) => entry.startsWith('memory.staging-'))
        : [],
    ).toEqual([]);
  });

  it('blocks at the final persisted-phase proof without mutating canonical or source paths', () => {
    const canonical = path.join(dataDir, 'workgroups', 'alpha', 'memory');
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    const codex = path.join(groupsDir, 'alpha-codex', 'memory');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(alpha);
    fs.mkdirSync(codex);
    fs.writeFileSync(path.join(canonical, 'canon.md'), 'canonical original\n');
    fs.writeFileSync(path.join(alpha, 'alpha.md'), 'alpha original\n');
    fs.writeFileSync(path.join(codex, 'codex.md'), 'codex original\n');
    const canonicalHash = sha(path.join(canonical, 'canon.md'));
    const alphaHash = sha(path.join(alpha, 'alpha.md'));
    const codexHash = sha(path.join(codex, 'codex.md'));
    inventory();
    let proofs = 0;
    let sourceMutationObserved: boolean;
    const renameSpy = vi.spyOn(fs, 'renameSync');
    const symlinkSpy = vi.spyOn(fs, 'symlinkSync');
    const removeSpy = vi.spyOn(fs, 'rmSync');

    try {
      applyMigrationReport(reportPath, {
        ...quiescent,
        proveQuiescence: () => {
          proofs += 1;
          if (proofs === 3) throw new Error('container respawned after cutover phase persistence');
          return [];
        },
      });
    } finally {
      const protectedPaths = new Set([canonical, alpha, codex]);
      sourceMutationObserved =
        renameSpy.mock.calls.some(([, destination]) => String(destination) === canonical) ||
        symlinkSpy.mock.calls.some(([, destination]) => protectedPaths.has(String(destination))) ||
        removeSpy.mock.calls.some(([target]) => protectedPaths.has(String(target)));
      renameSpy.mockRestore();
      symlinkSpy.mockRestore();
      removeSpy.mockRestore();
    }

    const result = readMigrationReport(reportPath).workgroups[0];
    const staging = `${canonical}.staging-${path.basename(result.snapshotDir!)}`;
    expect(proofs).toBe(3);
    expect(result.status).toBe('blocked');
    expect(result.error).toMatch(/container respawned after cutover phase persistence/);
    expect(fs.existsSync(result.snapshotDir!)).toBe(true);
    expect(fs.existsSync(staging)).toBe(false);
    expect(sourceMutationObserved).toBe(false);
    expect(fs.lstatSync(canonical).isDirectory()).toBe(true);
    expect(fs.readdirSync(canonical)).toEqual(['canon.md']);
    expect(sha(path.join(canonical, 'canon.md'))).toBe(canonicalHash);
    expect(fs.lstatSync(alpha).isDirectory()).toBe(true);
    expect(fs.readdirSync(alpha)).toEqual(['alpha.md']);
    expect(sha(path.join(alpha, 'alpha.md'))).toBe(alphaHash);
    expect(fs.lstatSync(codex).isDirectory()).toBe(true);
    expect(fs.readdirSync(codex)).toEqual(['codex.md']);
    expect(sha(path.join(codex, 'codex.md'))).toBe(codexHash);
  });

  it('rehashes sources after staging and blocks an external pre-cutover source change', () => {
    const canonical = path.join(dataDir, 'workgroups', 'alpha', 'memory');
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(alpha);
    fs.writeFileSync(path.join(canonical, 'canon.md'), 'canonical original\n');
    fs.writeFileSync(path.join(alpha, 'fact.md'), 'source original\n');
    const canonicalHash = sha(path.join(canonical, 'canon.md'));
    inventory();

    applyMigrationReport(reportPath, {
      ...quiescent,
      afterStagingBuilt: () => {
        fs.writeFileSync(path.join(alpha, 'fact.md'), 'external source change\n');
      },
    });

    const result = readMigrationReport(reportPath).workgroups[0];
    const staging = `${canonical}.staging-${path.basename(result.snapshotDir!)}`;
    const alphaSnapshot = result.snapshotEntries!.find((entry) => entry.sourcePath === alpha)!;
    expect(result.status).toBe('blocked');
    expect(result.error).toMatch(/sources changed during final cutover verification/i);
    expect(fs.existsSync(result.snapshotDir!)).toBe(true);
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.lstatSync(alpha).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(alpha, 'fact.md'), 'utf8')).toBe('external source change\n');
    expect(fs.readFileSync(path.join(alphaSnapshot.snapshotPath!, 'fact.md'), 'utf8')).toBe('source original\n');
    expect(fs.lstatSync(canonical).isDirectory()).toBe(true);
    expect(fs.readdirSync(canonical)).toEqual(['canon.md']);
    expect(sha(path.join(canonical, 'canon.md'))).toBe(canonicalHash);
  });

  it('verifies every staging outcome and blocks a corrupt canonical copy before cutover', () => {
    const canonical = path.join(dataDir, 'workgroups', 'alpha', 'memory');
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(alpha);
    fs.writeFileSync(path.join(canonical, 'canon.md'), 'canonical original\n');
    fs.writeFileSync(path.join(alpha, 'fact.md'), 'source original\n');
    const canonicalHash = sha(path.join(canonical, 'canon.md'));
    const alphaHash = sha(path.join(alpha, 'fact.md'));
    inventory();

    applyMigrationReport(reportPath, {
      ...quiescent,
      afterStagingBuilt: (_migration, staging) => {
        fs.writeFileSync(path.join(staging, 'fact.md'), 'corrupt staging bytes\n');
      },
    });

    const result = readMigrationReport(reportPath).workgroups[0];
    const staging = `${canonical}.staging-${path.basename(result.snapshotDir!)}`;
    expect(result.status).toBe('blocked');
    expect(result.error).toMatch(/staging outcome mismatch.*fact\.md/i);
    expect(fs.existsSync(result.snapshotDir!)).toBe(true);
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.lstatSync(alpha).isDirectory()).toBe(true);
    expect(fs.readdirSync(alpha)).toEqual(['fact.md']);
    expect(sha(path.join(alpha, 'fact.md'))).toBe(alphaHash);
    expect(fs.lstatSync(canonical).isDirectory()).toBe(true);
    expect(fs.readdirSync(canonical)).toEqual(['canon.md']);
    expect(sha(path.join(canonical, 'canon.md'))).toBe(canonicalHash);
  });

  it('reproves quiescence before each workgroup and blocks only the later respawned workgroup', () => {
    db.prepare(`INSERT INTO workgroups (id) VALUES (?)`).run('beta');
    db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run('ag-beta', 'beta', 'beta');
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    const beta = path.join(groupsDir, 'beta', 'memory');
    fs.mkdirSync(alpha);
    fs.mkdirSync(beta, { recursive: true });
    fs.writeFileSync(path.join(alpha, 'fact.md'), 'alpha\n');
    fs.writeFileSync(path.join(beta, 'fact.md'), 'beta\n');
    const allReport = path.join(tmp, 'per-workgroup-quiescence.json');
    inventoryMigration({ db, dbPath, groupsDir, dataDir, reportPath: allReport });
    let proofs = 0;

    applyMigrationReport(allReport, {
      ...quiescent,
      proveQuiescence: () => {
        proofs += 1;
        if (proofs === 5) throw new Error('container respawned before beta cutover');
        return [];
      },
    });

    const report = readMigrationReport(allReport);
    const alphaResult = report.workgroups.find((workgroup) => workgroup.workgroupId === 'alpha')!;
    const betaResult = report.workgroups.find((workgroup) => workgroup.workgroupId === 'beta')!;
    expect(proofs).toBe(5);
    expect(alphaResult.status).toBe('applied');
    expect(fs.existsSync(path.join(dataDir, 'workgroups', 'alpha', 'memory', 'fact.md'))).toBe(true);
    expect(fs.lstatSync(alpha).isSymbolicLink()).toBe(true);
    expect(betaResult.status).toBe('blocked');
    expect(betaResult.error).toMatch(/container respawned before beta cutover/);
    expect(fs.existsSync(betaResult.snapshotDir!)).toBe(true);
    expect(fs.lstatSync(beta).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'workgroups', 'beta', 'memory'))).toBe(false);
  });

  it('returns CLI failure after reporting a blocked workgroup', () => {
    const source = path.join(groupsDir, 'alpha', 'memory');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'fact.md'), 'before\n');
    inventory();

    expect(() =>
      runCli(['apply', '--report', reportPath], {
        ...quiescent,
        afterSnapshot: () => {
          fs.writeFileSync(path.join(source, 'fact.md'), 'after\n');
        },
      }),
    ).toThrow(/apply blocked for workgroup\(s\): alpha/);

    const result = readMigrationReport(reportPath).workgroups[0];
    expect(result.status).toBe('blocked');
    expect(result.error).toMatch(/changed after snapshot/i);
  });

  it('returns CLI failure when rollback is blocked and retains the report', () => {
    inventory();
    const report = readMigrationReport(reportPath);
    report.workgroups[0].status = 'applied';
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    expect(() => runCli(['rollback', '--report', reportPath], quiescent)).toThrow(
      /rollback blocked for workgroup\(s\): alpha/,
    );

    const result = readMigrationReport(reportPath).workgroups[0];
    expect(result.status).toBe('blocked');
    expect(result.error).toMatch(/Permanent snapshot missing/);
  });

  it('rejects a malformed report before apply can prove quiescence or mutate sources', () => {
    const source = path.join(groupsDir, 'alpha', 'memory');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'fact.md'), 'original\n');
    inventory();
    const malformed = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
      workgroups: Array<{ sources: Array<{ rootSha256?: string }> }>;
    };
    delete malformed.workgroups[0]!.sources[0]!.rootSha256;
    fs.writeFileSync(reportPath, `${JSON.stringify(malformed, null, 2)}\n`);
    let proofs = 0;

    expect(() =>
      applyMigrationReport(reportPath, {
        ...quiescent,
        proveQuiescence: () => {
          proofs += 1;
          return [];
        },
      }),
    ).toThrow(/rootSha256/);
    expect(proofs).toBe(0);
    expect(fs.readFileSync(path.join(source, 'fact.md'), 'utf8')).toBe('original\n');
  });

  it('rejects report-controlled runtime and canonical paths before any mutation', () => {
    const source = path.join(groupsDir, 'alpha', 'memory');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'fact.md'), 'original\n');
    inventory();
    const original = readMigrationReport(reportPath);
    const outside = path.join(tmp, 'must-not-replace');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'untouched\n');

    const edits: Array<(report: typeof original) => void> = [
      (report) => {
        report.dbPath = path.join(tmp, 'other.db');
      },
      (report) => {
        report.groupsDir = path.join(tmp, 'other-groups');
      },
      (report) => {
        report.dataDir = path.join(tmp, 'other-data');
      },
      (report) => {
        report.workgroups[0]!.canonicalPath = outside;
      },
    ];

    for (const edit of edits) {
      const report = structuredClone(original);
      edit(report);
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      let proofs = 0;
      expect(() =>
        applyMigrationReport(reportPath, {
          ...quiescent,
          proveQuiescence: () => {
            proofs += 1;
            return [];
          },
        }),
      ).toThrow(/trusted runtime path|canonicalPath/);
      expect(proofs).toBe(0);
      expect(fs.readFileSync(path.join(source, 'fact.md'), 'utf8')).toBe('original\n');
      expect(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('untouched\n');
    }
  });

  it('rejects corrupted snapshot bytes before rollback touches live canonical or compatibility links', () => {
    const source = path.join(groupsDir, 'alpha', 'memory');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'fact.md'), 'original\n');
    inventory();
    applyMigrationReport(reportPath, quiescent);
    const applied = readMigrationReport(reportPath).workgroups[0]!;
    const canonical = applied.canonicalPath;
    const sourceSnapshot = applied.snapshotEntries!.find((entry) => entry.sourcePath === source)!;
    fs.writeFileSync(path.join(sourceSnapshot.snapshotPath!, 'fact.md'), 'corrupted\n');
    let proofs = 0;

    rollbackMigrationReport(reportPath, {
      ...quiescent,
      proveQuiescence: () => {
        proofs += 1;
        return [];
      },
    });

    const result = readMigrationReport(reportPath).workgroups[0]!;
    expect(result.status).toBe('blocked');
    expect(result.error).toMatch(/Snapshot checksum mismatch/);
    expect(proofs).toBe(0);
    expect(fs.readFileSync(path.join(canonical, 'fact.md'), 'utf8')).toBe('original\n');
    expect(fs.lstatSync(source).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(source)).toBe('/workspace/workgroup/memory');
  });

  it('rejects a rollback report and snapshot manifest that omit a current provider-native source', () => {
    const source = path.join(groupsDir, 'alpha', 'memory');
    const nativeA = claudeNativeMemory(dataDir, 'ag-alpha', 'legacy-project-a');
    const nativeB = claudeNativeMemory(dataDir, 'ag-alpha', 'legacy-project-b');
    fs.mkdirSync(source);
    fs.mkdirSync(nativeA, { recursive: true });
    fs.mkdirSync(nativeB, { recursive: true });
    fs.writeFileSync(path.join(source, 'fact.md'), 'group original\n');
    fs.writeFileSync(path.join(nativeA, 'fact.md'), 'native a\n');
    fs.writeFileSync(path.join(nativeB, 'fact.md'), 'native b\n');
    inventory();
    applyMigrationReport(reportPath, quiescent);

    const report = readMigrationReport(reportPath);
    const migration = report.workgroups[0]!;
    const omitted = migration.sources.find((candidate) => candidate.rootPath === nativeB)!;
    migration.sources = migration.sources.filter((candidate) => candidate !== omitted);
    migration.snapshotEntries = migration.snapshotEntries!.filter((entry) => entry.sourcePath !== nativeB);
    migration.outcomes = migration.outcomes!.filter((outcome) => outcome.sourcePath !== nativeB);
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const manifestPath = path.join(migration.snapshotDir!, 'snapshot.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      sources: typeof migration.sources;
      entries: NonNullable<typeof migration.snapshotEntries>;
    };
    manifest.sources = migration.sources;
    manifest.entries = migration.snapshotEntries;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    let proofs = 0;

    expect(() =>
      rollbackMigrationReport(reportPath, {
        ...quiescent,
        proveQuiescence: () => {
          proofs += 1;
          return [];
        },
      }),
    ).toThrow(/source roster does not match current runtime sources/);
    expect(proofs).toBe(0);
    expect(fs.lstatSync(source).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(nativeA).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(nativeB).isSymbolicLink()).toBe(true);
  });

  it('rejects redirected rollback source and snapshot paths before touching live memory', () => {
    const source = path.join(groupsDir, 'alpha', 'memory');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'fact.md'), 'original\n');
    inventory();
    applyMigrationReport(reportPath, quiescent);
    const applied = readMigrationReport(reportPath);
    const canonical = applied.workgroups[0]!.canonicalPath;
    const target = applied.workgroups[0]!.snapshotEntries!.find((entry) => entry.sourcePath === source)!;
    const outside = path.join(tmp, 'redirected');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'untouched\n');

    target.sourcePath = outside;
    target.snapshotPath = outside;
    fs.writeFileSync(reportPath, `${JSON.stringify(applied, null, 2)}\n`);
    let proofs = 0;
    expect(() =>
      rollbackMigrationReport(reportPath, {
        ...quiescent,
        proveQuiescence: () => {
          proofs += 1;
          return [];
        },
      }),
    ).toThrow(/snapshot source/);
    expect(proofs).toBe(0);
    expect(fs.readFileSync(path.join(canonical, 'fact.md'), 'utf8')).toBe('original\n');
    expect(fs.lstatSync(source).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('untouched\n');
  });

  it('treats an applied manifest as verified only while the canonical checksum still matches', () => {
    const source = path.join(groupsDir, 'alpha', 'memory');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'fact.md'), 'snapshotted\n');
    inventory();
    applyMigrationReport(reportPath, quiescent);

    expect(inspectWorkgroupMemoryState(db, 'alpha', { groupsDir, dataDir })).toEqual({
      status: 'canonical',
      basis: 'verified-manifest',
    });
    fs.appendFileSync(path.join(dataDir, 'workgroups', 'alpha', 'memory', 'fact.md'), 'later\n');
    expect(inspectWorkgroupMemoryState(db, 'alpha', { groupsDir, dataDir })).toEqual({
      status: 'canonical',
      basis: 'exact-links-and-canon',
    });
  });

  it('test_rollback_restores_original_path_types_and_checksums', () => {
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    fs.mkdirSync(path.join(alpha, 'memories'), { recursive: true });
    fs.writeFileSync(path.join(alpha, 'memories', 'fact.md'), 'original\n');
    const originalHash = sha(path.join(alpha, 'memories', 'fact.md'));
    const codex = path.join(groupsDir, 'alpha-codex', 'memory');
    fs.symlinkSync('/workspace/workgroup/memory', codex);
    const originalCodexLink = fs.readlinkSync(codex);
    inventory();
    applyMigrationReport(reportPath, quiescent);

    rollbackMigrationReport(reportPath, quiescent);

    expect(fs.lstatSync(alpha).isDirectory()).toBe(true);
    expect(sha(path.join(alpha, 'memories', 'fact.md'))).toBe(originalHash);
    expect(fs.lstatSync(codex).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(codex)).toBe(originalCodexLink);
    expect(readMigrationReport(reportPath).workgroups[0].status).toBe('rolled-back');
    // Rollback is forensic, not cleanup: the unreferenced canon may remain.
    expect(fs.existsSync(path.join(dataDir, 'workgroups', 'alpha', 'memory'))).toBe(true);
  });

  it('restores a pre-existing canonical source exactly during explicit rollback', () => {
    const canonical = path.join(dataDir, 'workgroups', 'alpha', 'memory');
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(canonical, 'canon.md'), 'canonical before\n');
    const canonicalHash = sha(path.join(canonical, 'canon.md'));
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    fs.mkdirSync(alpha);
    fs.writeFileSync(path.join(alpha, 'local.md'), 'local before\n');
    inventory();

    applyMigrationReport(reportPath, quiescent);
    expect(fs.existsSync(path.join(canonical, 'local.md'))).toBe(true);
    rollbackMigrationReport(reportPath, quiescent);

    expect(fs.lstatSync(canonical).isDirectory()).toBe(true);
    expect(sha(path.join(canonical, 'canon.md'))).toBe(canonicalHash);
    expect(fs.existsSync(path.join(canonical, 'local.md'))).toBe(false);
    expect(fs.lstatSync(alpha).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(alpha, 'local.md'), 'utf8')).toBe('local before\n');
    expect(readMigrationReport(reportPath).workgroups[0].status).toBe('rolled-back');
  });

  it('refuses reapply and rolls back a persisted interrupted cutover exactly', () => {
    const canonical = path.join(dataDir, 'workgroups', 'alpha', 'memory');
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    const codex = path.join(groupsDir, 'alpha-codex', 'memory');
    fs.mkdirSync(alpha);
    fs.mkdirSync(codex);
    fs.writeFileSync(path.join(alpha, 'alpha.md'), 'alpha original\n');
    fs.writeFileSync(path.join(codex, 'codex.md'), 'codex original\n');
    const alphaHash = sha(path.join(alpha, 'alpha.md'));
    const codexHash = sha(path.join(codex, 'codex.md'));
    inventory();
    applyMigrationReport(reportPath, quiescent);

    const interrupted = readMigrationReport(reportPath);
    const migration = interrupted.workgroups[0];
    const alphaSnapshot = migration.snapshotEntries!.find((entry) => entry.sourcePath === alpha)!;
    fs.unlinkSync(alpha);
    fs.cpSync(alphaSnapshot.snapshotPath!, alpha, { recursive: true, dereference: false });
    fs.writeFileSync(path.join(canonical, 'partial.md'), 'partial cutover\n');
    (migration as unknown as { status: string }).status = 'cutover-started';
    fs.writeFileSync(reportPath, `${JSON.stringify(interrupted, null, 2)}\n`);

    let reapplyProofs = 0;
    expect(() =>
      applyMigrationReport(reportPath, {
        ...quiescent,
        proveQuiescence: () => {
          reapplyProofs += 1;
          return [];
        },
      }),
    ).toThrow(/interrupted cutover.*rollback/i);
    expect(reapplyProofs).toBe(0);

    rollbackMigrationReport(reportPath, quiescent);

    expect(fs.existsSync(canonical)).toBe(false);
    expect(fs.lstatSync(alpha).isDirectory()).toBe(true);
    expect(sha(path.join(alpha, 'alpha.md'))).toBe(alphaHash);
    expect(fs.lstatSync(codex).isDirectory()).toBe(true);
    expect(sha(path.join(codex, 'codex.md'))).toBe(codexHash);
    expect(readMigrationReport(reportPath).workgroups[0].status).toBe('rolled-back');
  });

  it('test_base_selection_uses_documented_precedence', () => {
    db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run('ag-aaa', 'aaa', 'alpha');
    fs.mkdirSync(path.join(groupsDir, 'aaa', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(groupsDir, 'aaa', 'memory', 'base.md'), 'lexical\n');
    fs.mkdirSync(path.join(groupsDir, 'alpha', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(groupsDir, 'alpha', 'memory', 'base.md'), 'slug\n');
    inventory();

    applyMigrationReport(reportPath, quiescent);

    const applied = readMigrationReport(reportPath).workgroups[0];
    expect(applied.baseSource?.kind).toBe('group');
    expect(applied.baseSource?.folder).toBe('alpha');
    expect(fs.readFileSync(path.join(dataDir, 'workgroups', 'alpha', 'memory', 'base.md'), 'utf8')).toBe('slug\n');
  });

  it('uses codepoint order for the fallback base when no canonical or slug-matching group exists', () => {
    db.prepare('DELETE FROM agent_groups').run();
    fs.rmSync(path.join(groupsDir, 'alpha'), { recursive: true, force: true });
    fs.rmSync(path.join(groupsDir, 'alpha-codex'), { recursive: true, force: true });
    for (const [id, folder, content] of [
      ['ag-digit', 'project_xzo216', 'codepoint-first\n'],
      ['ag-underscore', 'project_xzo_195', 'locale-first\n'],
    ]) {
      db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run(id, folder, 'alpha');
      const memory = path.join(groupsDir, folder, 'memory');
      fs.mkdirSync(memory, { recursive: true });
      fs.writeFileSync(path.join(memory, 'base.md'), content);
    }

    inventory();
    applyMigrationReport(reportPath, quiescent);

    const applied = readMigrationReport(reportPath).workgroups[0];
    expect(applied.baseSource?.folder).toBe('project_xzo216');
    expect(fs.readFileSync(path.join(dataDir, 'workgroups', 'alpha', 'memory', 'base.md'), 'utf8')).toBe(
      'codepoint-first\n',
    );
  });

  it('test_future_sibling_substantive_seed_uses_snapshotted_collision_import', () => {
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    fs.mkdirSync(alpha);
    fs.writeFileSync(path.join(alpha, 'profile.md'), 'canonical generation one\n');
    inventory();
    applyMigrationReport(reportPath, quiescent);

    db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run(
      'ag-opencode',
      'alpha-opencode',
      'alpha',
    );
    const future = path.join(groupsDir, 'alpha-opencode', 'memory');
    fs.mkdirSync(future, { recursive: true });
    fs.writeFileSync(path.join(future, 'profile.md'), 'future sibling\n');
    const secondReport = path.join(tmp, 'future.json');
    inventoryMigration({
      db,
      dbPath,
      groupsDir,
      dataDir,
      workgroupIds: ['alpha'],
      reportPath: secondReport,
    });

    applyMigrationReport(secondReport, quiescent);

    const second = readMigrationReport(secondReport).workgroups[0];
    expect(second.baseSource?.kind).toBe('canonical');
    expect(fs.readFileSync(path.join(dataDir, 'workgroups', 'alpha', 'memory', 'profile.md'), 'utf8')).toBe(
      'canonical generation one\n',
    );
    expect(
      fs.readFileSync(
        path.join(dataDir, 'workgroups', 'alpha', 'memory', 'imports', 'alpha-opencode', 'profile.md'),
        'utf8',
      ),
    ).toBe('future sibling\n');
    expect(fs.existsSync(second.snapshotDir!)).toBe(true);
  });

  it('blocks an opaque symlink source without blocking another workgroup', () => {
    db.prepare(`INSERT INTO workgroups (id) VALUES (?)`).run('beta');
    db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run('ag-beta', 'beta', 'beta');
    fs.mkdirSync(path.join(groupsDir, 'beta', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(groupsDir, 'beta', 'memory', 'fact.md'), 'beta\n');
    fs.symlinkSync('../opaque-provider-store', path.join(groupsDir, 'alpha', 'memory'));
    const allReport = path.join(tmp, 'all.json');

    const inventoried = inventoryMigration({
      db,
      dbPath,
      groupsDir,
      dataDir,
      reportPath: allReport,
    });
    const symlink = inventoried.workgroups
      .find((workgroup) => workgroup.workgroupId === 'alpha')!
      .sources.find((source) => source.folder === 'alpha')!;
    expect(symlink.rootType).toBe('symlink');
    expect(symlink.rootSize).toBeGreaterThan(0);
    expect(symlink.rootSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readlinkSync(path.join(groupsDir, 'alpha', 'memory'))).toBe('../opaque-provider-store');

    applyMigrationReport(allReport, quiescent);

    const applied = readMigrationReport(allReport);
    expect(applied.workgroups.find((workgroup) => workgroup.workgroupId === 'alpha')?.status).toBe('blocked');
    expect(applied.workgroups.find((workgroup) => workgroup.workgroupId === 'beta')?.status).toBe('applied');
    expect(fs.readFileSync(path.join(dataDir, 'workgroups', 'beta', 'memory', 'fact.md'), 'utf8')).toBe('beta\n');
  });

  it('snapshots and blocks a nested symlink without cutting over that workgroup', () => {
    db.prepare(`INSERT INTO workgroups (id) VALUES (?)`).run('beta');
    db.prepare(`INSERT INTO agent_groups (id, folder, workgroup_id) VALUES (?,?,?)`).run('ag-beta', 'beta', 'beta');
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    fs.mkdirSync(alpha);
    fs.writeFileSync(path.join(tmp, 'outside.md'), 'outside\n');
    fs.symlinkSync(path.join(tmp, 'outside.md'), path.join(alpha, 'nested-link.md'));
    fs.mkdirSync(path.join(groupsDir, 'beta', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(groupsDir, 'beta', 'memory', 'fact.md'), 'beta\n');
    const allReport = path.join(tmp, 'nested-link.json');

    const inventoried = inventoryMigration({
      db,
      dbPath,
      groupsDir,
      dataDir,
      reportPath: allReport,
    });
    const alphaMigration = inventoried.workgroups.find((workgroup) => workgroup.workgroupId === 'alpha')!;
    expect(alphaMigration.sources.find((source) => source.folder === 'alpha')?.entries).toContainEqual(
      expect.objectContaining({
        relativePath: 'nested-link.md',
        type: 'symlink',
        linkTarget: path.join(tmp, 'outside.md'),
      }),
    );

    applyMigrationReport(allReport, quiescent);

    const applied = readMigrationReport(allReport);
    const blocked = applied.workgroups.find((workgroup) => workgroup.workgroupId === 'alpha')!;
    expect(blocked.status).toBe('blocked');
    expect(blocked.error).toMatch(/symlink/i);
    expect(fs.existsSync(blocked.snapshotDir!)).toBe(true);
    expect(fs.lstatSync(alpha).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(alpha, 'nested-link.md')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(alpha, 'nested-link.md'))).toBe(path.join(tmp, 'outside.md'));
    expect(fs.existsSync(path.join(dataDir, 'workgroups', 'alpha', 'memory'))).toBe(false);
    expect(applied.workgroups.find((workgroup) => workgroup.workgroupId === 'beta')?.status).toBe('applied');
  });

  it('restores the affected workgroup from snapshot when compatibility-link creation fails', () => {
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    const codex = path.join(groupsDir, 'alpha-codex', 'memory');
    fs.mkdirSync(alpha);
    fs.mkdirSync(codex);
    fs.writeFileSync(path.join(alpha, 'fact.md'), 'alpha original\n');
    fs.writeFileSync(path.join(codex, 'fact.md'), 'codex original\n');
    const alphaHash = sha(path.join(alpha, 'fact.md'));
    const codexHash = sha(path.join(codex, 'fact.md'));
    inventory();

    const realSymlink = fs.symlinkSync.bind(fs);
    const symlinkSpy = vi.spyOn(fs, 'symlinkSync').mockImplementation(((
      target: fs.PathLike,
      destination: fs.PathLike,
    ) => {
      if (String(destination) === codex) throw new Error('simulated link failure');
      return realSymlink(target, destination);
    }) as typeof fs.symlinkSync);
    try {
      applyMigrationReport(reportPath, quiescent);
    } finally {
      symlinkSpy.mockRestore();
    }

    const result = readMigrationReport(reportPath).workgroups[0];
    expect(result.status).toBe('blocked');
    expect(result.error).toMatch(/simulated link failure/);
    expect(fs.lstatSync(alpha).isDirectory()).toBe(true);
    expect(fs.lstatSync(codex).isDirectory()).toBe(true);
    expect(sha(path.join(alpha, 'fact.md'))).toBe(alphaHash);
    expect(sha(path.join(codex, 'fact.md'))).toBe(codexHash);
  });

  it('restores a pre-existing canonical source after compatibility-link creation fails', () => {
    const canonical = path.join(dataDir, 'workgroups', 'alpha', 'memory');
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(canonical, 'canon.md'), 'canonical original\n');
    const canonicalHash = sha(path.join(canonical, 'canon.md'));
    const alpha = path.join(groupsDir, 'alpha', 'memory');
    const codex = path.join(groupsDir, 'alpha-codex', 'memory');
    fs.mkdirSync(alpha);
    fs.mkdirSync(codex);
    fs.writeFileSync(path.join(alpha, 'local.md'), 'alpha original\n');
    fs.writeFileSync(path.join(codex, 'local.md'), 'codex original\n');
    inventory();

    const realSymlink = fs.symlinkSync.bind(fs);
    const symlinkSpy = vi.spyOn(fs, 'symlinkSync').mockImplementation(((
      target: fs.PathLike,
      destination: fs.PathLike,
    ) => {
      if (String(destination) === codex) throw new Error('simulated link failure with canon');
      return realSymlink(target, destination);
    }) as typeof fs.symlinkSync);
    try {
      applyMigrationReport(reportPath, quiescent);
    } finally {
      symlinkSpy.mockRestore();
    }

    const result = readMigrationReport(reportPath).workgroups[0];
    expect(result.status).toBe('blocked');
    expect(result.error).toMatch(/simulated link failure with canon/);
    expect(fs.existsSync(result.snapshotDir!)).toBe(true);
    expect(fs.lstatSync(canonical).isDirectory()).toBe(true);
    expect(sha(path.join(canonical, 'canon.md'))).toBe(canonicalHash);
    expect(fs.existsSync(path.join(canonical, 'local.md'))).toBe(false);
    expect(fs.lstatSync(alpha).isDirectory()).toBe(true);
    expect(fs.lstatSync(codex).isDirectory()).toBe(true);
  });
});
