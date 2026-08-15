import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertExactRepositoryNamespaces,
  assertNoResidualLegacyCheckoutTopology,
  assertRemainingAggregateCapacity,
  assertServiceInactive,
  captureProtectedArchives,
  classifySessionRepositoryCheckout,
  configuredOriginProvenance,
  loadMigrationDescriptor,
  normalizedObservedOrigin,
  verifyServerRollback,
  type ActiveServerMigration,
  type AggregateCapacityEvidence,
} from './migrate-repo-store.js';
import { discoverPhysicalGitCheckouts, SESSION_RUNTIME_REPOSITORY_EXCLUSIONS } from '../src/repository-discovery.js';
import { recoverySeedGitDirSha256 } from '../src/repository-migration-recovery.js';
import { repositoryMigrationPath, type RepositoryMigrationManifest } from '../src/repository-migration.js';
import { repositoriesRoot, repositoryStateRoot } from '../src/repository-workspaces.js';

let root: string;
let dataDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-repo-store-safety-'));
  dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function manifest(repo: string, archiveOnly = false): RepositoryMigrationManifest {
  return {
    version: 1,
    runId: 'run-safety',
    createdAt: '2026-08-14T00:00:00.000Z',
    dataDir,
    workgroupId: 'wg-a',
    repo,
    origin: archiveOnly ? null : 'https://github.com/example/repo',
    archiveOnly,
    repositoryId: archiveOnly ? `local-only:${repo}` : `github:example/${repo}`,
    objectStores: [],
    canonicalBase: {
      head: 'a'.repeat(40),
      branch: 'main',
      sourceRef: 'refs/heads/main',
      objectFormat: 'sha1',
    },
    captures: [],
    renamedObjectStores: {},
    capacity: {
      availableBytes: 1_000,
      requiredBytes: 80,
      uniqueGitBytes: 0,
      worktreeBytes: 0,
      canonicalWorktreeBytes: 0,
      worktreeAdminBytes: 0,
      rescueObjectBytes: 0,
      safetyBytes: 10,
    },
    manifestSha256: 'b'.repeat(64),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function descriptor(recoverySeeds: ActiveServerMigration['recoverySeeds'] = []): ActiveServerMigration {
  const base: Omit<ActiveServerMigration, 'descriptorSha256'> = {
    version: 2,
    runId: 'run-load',
    manifestPaths: [],
    manifestHashes: [],
    createdAt: '2026-08-14T00:00:00.000Z',
    recoverySeeds,
    aggregateCapacity: {
      migrationCoreBytes: 0,
      controlPlaneBackupBytes: 0,
      globalSafetyBytes: 1024 ** 3,
      requiredBytes: 1024 ** 3,
    },
  };
  return {
    ...base,
    descriptorSha256: createHash('sha256').update(canonicalJson(base)).digest('hex'),
  };
}

function writeDescriptor(value: ActiveServerMigration): string {
  const file = path.join(root, 'descriptor.json');
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function createActiveNamespaces(): RepositoryMigrationManifest[] {
  const active = manifest('active');
  const archived = manifest('archived', true);
  fs.mkdirSync(path.join(repositoriesRoot(dataDir), 'wg-a', 'active'), { recursive: true });
  fs.mkdirSync(path.join(repositoryStateRoot(dataDir), 'wg-a', 'active'), { recursive: true });
  fs.writeFileSync(path.join(repositoryStateRoot(dataDir), 'wg-a', 'active', 'origin.json'), '{}\n');
  fs.mkdirSync(path.join(repositoryStateRoot(dataDir), 'wg-a', 'archived'), { recursive: true });
  return [active, archived];
}

function normalCheckout(directory: string, origin?: string): void {
  const git = path.join(directory, '.git');
  fs.mkdirSync(path.join(git, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(git, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(
    path.join(git, 'config'),
    `[core]\n\trepositoryformatversion = 0\n${origin ? `[remote "origin"]\n\turl = ${origin}\n` : ''}`,
  );
}

describe('server repository migration safety helpers', () => {
  it('ignores group file symlinks while preserving archive-root symlink rejection', () => {
    const groupsDir = path.join(root, 'groups');
    const groupRoot = path.join(groupsDir, 'group-a');
    fs.mkdirSync(groupRoot, { recursive: true });
    fs.writeFileSync(path.join(groupRoot, 'CLAUDE.md'), '# group\n');
    fs.symlinkSync('CLAUDE.md', path.join(groupRoot, 'CLAUDE.local.md'));

    expect(
      captureProtectedArchives(
        [{ agent_group_id: 'ag-a', folder: 'group-a', workgroup_id: 'wg-a' }],
        new Set(['wg-a']),
        groupsDir,
      ),
    ).toEqual([]);

    const archive = path.join(groupRoot, 'archive');
    fs.mkdirSync(archive);
    fs.writeFileSync(path.join(archive, '.archive-sha'), 'a'.repeat(40));
    fs.symlinkSync('archive', path.join(groupRoot, 'archive-link'));
    expect(() =>
      captureProtectedArchives(
        [{ agent_group_id: 'ag-a', folder: 'group-a', workgroup_id: 'wg-a' }],
        new Set(['wg-a']),
        groupsDir,
      ),
    ).toThrow(/unsafe protected archive root/);
  });

  it('propagates ENOTDIR after a real protected archive marker is found', () => {
    const groupsDir = path.join(root, 'groups');
    const archive = path.join(groupsDir, 'group-a', 'archive');
    fs.mkdirSync(archive, { recursive: true });
    fs.writeFileSync(path.join(archive, '.archive-sha'), 'a'.repeat(40));
    const error = Object.assign(new Error('path topology changed'), { code: 'ENOTDIR' });
    vi.spyOn(fs, 'realpathSync').mockImplementationOnce(() => {
      throw error;
    });

    expect(() =>
      captureProtectedArchives(
        [{ agent_group_id: 'ag-a', folder: 'group-a', workgroup_id: 'wg-a' }],
        new Set(['wg-a']),
        groupsDir,
      ),
    ).toThrow(error);
  });

  it('residual topology audit catches group dist plus session and thread build repositories', () => {
    const groupRoot = path.join(root, 'group');
    const sessionRoot = path.join(root, 'session');
    const threadRoot = path.join(root, 'thread');
    normalCheckout(path.join(groupRoot, 'dist'));
    normalCheckout(path.join(sessionRoot, 'build'));
    normalCheckout(path.join(threadRoot, 'build'));
    const discovered = [
      ...discoverPhysicalGitCheckouts(groupRoot, [groupRoot]),
      ...discoverPhysicalGitCheckouts(sessionRoot, [sessionRoot], {
        skipRootEntries: SESSION_RUNTIME_REPOSITORY_EXCLUSIONS,
      }),
      ...discoverPhysicalGitCheckouts(threadRoot, [threadRoot]),
    ];
    const residual = new Map(
      discovered.map((checkoutPath, index) => [
        `wg-a\0${path.basename(checkoutPath)}-${index}`,
        [
          {
            workgroupId: 'wg-a',
            repo: path.basename(checkoutPath),
            checkoutPath,
            workUnit: { workgroupId: 'wg-a', kind: 'session' as const, key: `session:test:${index}`, id: `${index}` },
          },
        ],
      ]),
    );

    expect(discovered.map((entry) => path.basename(entry))).toEqual(['dist', 'build', 'build']);
    expect(() => assertNoResidualLegacyCheckoutTopology(residual, new Set(['wg-a']))).toThrow(
      /residual legacy checkout topology remains:.*build.*dist/,
    );
  });

  it('classifies only the exact session repository-staging tree as a synthetic non-live work unit', () => {
    const physicalSession = path.join(root, 'session');
    const retained = path.join(physicalSession, 'repository-staging', 'request-failed', 'customer-repo');
    const ordinary = path.join(physicalSession, 'worktrees', 'repository-staging');
    normalCheckout(
      retained,
      'https://github.com/example/customer-repo?access_token=do-not-print-this-token#credential-fragment',
    );
    normalCheckout(ordinary);
    const liveWorkUnit = {
      workgroupId: 'wg-a',
      kind: 'thread' as const,
      key: 'thread:slack:C1:123',
      id: 'live-topic',
    };

    const staged = classifySessionRepositoryCheckout({
      checkoutPath: retained,
      physicalSession,
      workgroupId: 'wg-a',
      liveWorkUnit,
    });
    expect(staged).toMatchObject({
      sourceRole: 'repository-staging',
      credentialBearingOrigin: true,
      workUnit: { kind: 'session' },
    });
    expect(staged.workUnit.key).toMatch(/^session:legacy:/);
    expect(staged.workUnit.key).not.toContain('do-not-print-this-token');
    expect(JSON.stringify(staged)).not.toContain('do-not-print-this-token');
    expect(
      classifySessionRepositoryCheckout({
        checkoutPath: ordinary,
        physicalSession,
        workgroupId: 'wg-a',
        liveWorkUnit,
      }),
    ).toEqual({ workUnit: liveWorkUnit });
  });

  it('marks every normal clone credential provenance and normalizes checkout and object-store observations', () => {
    const checkout = path.join(root, 'normal-query-origin');
    const querySecret = 'NORMAL_QUERY_SECRET';
    const fragmentSecret = 'OBJECT_STORE_FRAGMENT_SECRET';
    const queryOrigin = `https://github.com/Example/normal-query-origin.git?access_token=${querySecret}`;
    const fragmentOrigin = `https://github.com/Example/normal-query-origin.git#${fragmentSecret}`;
    normalCheckout(checkout, queryOrigin);

    const provenance = configuredOriginProvenance(checkout);
    expect(provenance).toEqual({ credentialBearingOrigin: true });
    expect(normalizedObservedOrigin(queryOrigin)).toBe('https://github.com/Example/normal-query-origin');
    expect(normalizedObservedOrigin(fragmentOrigin)).toBe('https://github.com/Example/normal-query-origin');
    for (const evidence of [
      provenance,
      normalizedObservedOrigin(queryOrigin),
      normalizedObservedOrigin(fragmentOrigin),
    ]) {
      expect(JSON.stringify(evidence)).not.toContain(querySecret);
      expect(JSON.stringify(evidence)).not.toContain(fragmentSecret);
    }
  });

  it('fails closed when systemd cannot be queried, including a DBus connection failure', () => {
    expect(() =>
      assertServiceInactive('nanoclaw.service', () => {
        throw new Error('Failed to connect to bus: No medium found');
      }),
    ).toThrow(/cannot prove service quiescence.*Failed to connect to bus/);
  });

  it('queries the system manager by default and the user manager only when explicitly requested', () => {
    const calls: string[][] = [];
    const query = (_command: string, args: string[]): string => {
      calls.push(args);
      return 'LoadState=loaded\nActiveState=inactive\n';
    };

    assertServiceInactive('nanoclaw-v2.service', query);
    assertServiceInactive('nanoclaw-v2.service', query, 'user');

    expect(calls).toEqual([
      ['show', 'nanoclaw-v2.service', '--property=LoadState', '--property=ActiveState'],
      ['--user', 'show', 'nanoclaw-v2.service', '--property=LoadState', '--property=ActiveState'],
    ]);
  });

  it('fails closed for an active or unavailable user-manager unit', () => {
    expect(() =>
      assertServiceInactive('nanoclaw-v2.service', () => 'LoadState=loaded\nActiveState=active\n', 'user'),
    ).toThrow(/fleet is not quiescent.*loaded\/active/);
    expect(() =>
      assertServiceInactive(
        'nanoclaw-v2.service',
        () => {
          throw new Error('Failed to connect to user bus');
        },
        'user',
      ),
    ).toThrow(/cannot prove service quiescence.*Failed to connect to user bus/);
  });

  it('accepts only explicit inactive service states and rejects failed or active states', () => {
    expect(() =>
      assertServiceInactive('nanoclaw.service', () => 'LoadState=loaded\nActiveState=inactive\n'),
    ).not.toThrow();
    expect(() =>
      assertServiceInactive('nanoclaw.service', () => 'LoadState=not-found\nActiveState=inactive\n'),
    ).not.toThrow();
    expect(() => assertServiceInactive('nanoclaw.service', () => 'LoadState=loaded\nActiveState=failed\n')).toThrow(
      /fleet is not quiescent.*loaded\/failed/,
    );
    expect(() => assertServiceInactive('nanoclaw.service', () => 'LoadState=loaded\nActiveState=active\n')).toThrow(
      /fleet is not quiescent.*loaded\/active/,
    );
    expect(() =>
      assertServiceInactive('nanoclaw.service', () => 'Failed to connect to bus: No medium found\n'),
    ).toThrow(/malformed systemd state/);
  });

  it('rejects remaining aggregate capacity drift before mutation', () => {
    const remaining = [manifest('one'), manifest('two')];
    const aggregate: AggregateCapacityEvidence = {
      migrationCoreBytes: 140,
      controlPlaneBackupBytes: 25,
      globalSafetyBytes: 30,
      requiredBytes: 195,
    };

    expect(() => assertRemainingAggregateCapacity(remaining, aggregate, 169)).toThrow(
      /remaining aggregate capacity gate rejected before mutation: 169 bytes available, 170 bytes required/,
    );
    expect(() => assertRemainingAggregateCapacity(remaining, aggregate, 170)).not.toThrow();
  });

  it('rejects descriptor drift before loading any manifest', () => {
    const value = descriptor();
    const file = writeDescriptor(value);
    value.createdAt = '2026-08-14T00:00:01.000Z';
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });

    expect(() => loadMigrationDescriptor(file, dataDir)).toThrow(/server migration descriptor hash mismatch/);
  });

  it('rejects recovery-seed drift while loading a hash-bound descriptor', () => {
    const seed = path.join(root, 'seed.git');
    fs.mkdirSync(path.join(seed, 'objects'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'HEAD'), 'ref: refs/heads/main\n');
    const file = writeDescriptor(descriptor([{ gitDir: seed, sha256: recoverySeedGitDirSha256(seed) }]));
    fs.writeFileSync(path.join(seed, 'objects', 'tampered'), 'changed after inventory\n');

    expect(() => loadMigrationDescriptor(file, dataDir)).toThrow(/recovery seed changed after reviewed inventory/);
  });

  it('rejects extra canonical repository namespace entries', () => {
    const manifests = createActiveNamespaces();
    fs.mkdirSync(path.join(repositoriesRoot(dataDir), 'wg-a', 'extra'), { recursive: true });

    expect(() => assertExactRepositoryNamespaces(manifests, dataDir)).toThrow(
      /canonical repository namespace.*extra=\[wg-a\/extra\]/,
    );
  });

  it('rejects extra repository coordination namespace entries', () => {
    const manifests = createActiveNamespaces();
    fs.mkdirSync(path.join(repositoryStateRoot(dataDir), 'wg-a', 'extra'), { recursive: true });

    expect(() => assertExactRepositoryNamespaces(manifests, dataDir)).toThrow(
      /repository coordination namespace.*extra=\[wg-a\/extra\]/,
    );
  });

  it('rejects an origin pin in the archive-only coordination namespace', () => {
    const manifests = createActiveNamespaces();
    fs.writeFileSync(path.join(repositoryStateRoot(dataDir), 'wg-a', 'archived', 'origin.json'), '{}\n');

    expect(() => assertExactRepositoryNamespaces(manifests, dataDir)).toThrow(
      /origin pin namespace.*extra=\[wg-a\/archived\]/,
    );
  });

  it('detects an archive-only preserved repository left behind by rollback', () => {
    const archived = manifest('archived', true);
    const residue = repositoryMigrationPath(archived);
    fs.mkdirSync(residue, { recursive: true });

    expect(() => verifyServerRollback([archived], [])).toThrow(
      /migration repository remains after rollback.*preserved-repository/,
    );
  });
});
