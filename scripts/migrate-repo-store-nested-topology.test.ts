import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  aggregateCapacityEvidence,
  loadMigrationDescriptor,
  orderRepositoryMigrationManifests,
  verifyServerRollback,
  type ActiveServerMigration,
} from './migrate-repo-store.js';
import {
  createRepositoryMigrationManifest,
  executeRepositoryMigration,
  manifestPath,
  rollbackRepositoryMigration,
  type LegacyCheckoutCandidate,
  type RepositoryMigrationManifest,
} from '../src/repository-migration.js';
import { canonicalRepoDir, resolveRepositoryWorkUnit } from '../src/repository-workspaces.js';

/**
 * This integration case clones repositories, retries an interrupted migration,
 * and rolls both back. #420 measured a 5 s timeout under host contention, so
 * this case has a 30 s budget.
 */
const GIT_HEAVY_TEST_TIMEOUT_MS = 30_000;

let root: string;
let dataDir: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRemote(name: string, ignoredNestedPath: string): string {
  const seed = path.join(root, 'seeds', name);
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(seed, '.gitignore'), `${ignoredNestedPath}/\n`);
  fs.writeFileSync(path.join(seed, 'base.txt'), `${name}\n`);
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'base']);
  const remote = path.join(root, 'remotes', `${name}.git`);
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', seed, remote]);
  return remote;
}

function cloneDirty(remote: string, checkout: string, branch: string): void {
  fs.mkdirSync(path.dirname(checkout), { recursive: true });
  execFileSync('git', ['clone', '-q', remote, checkout]);
  git(checkout, ['switch', '-q', '-c', branch]);
  fs.writeFileSync(path.join(checkout, `${branch}.txt`), `${checkout}\n`);
}

function candidate(repo: string, checkoutPath: string, threadId: string): LegacyCheckoutCandidate {
  return {
    workgroupId: 'wg-a',
    repo,
    checkoutPath,
    workUnit: resolveRepositoryWorkUnit({
      workgroupId: 'wg-a',
      sessionId: `session-${threadId}`,
      platformId: 'slack:C1',
      messagingGroupId: 'mg-a',
      threadId,
    }),
  };
}

function createManifest(
  repo: string,
  remote: string,
  candidates: LegacyCheckoutCandidate[],
  runId: string,
): RepositoryMigrationManifest {
  return createRepositoryMigrationManifest({
    dataDir,
    workgroupId: 'wg-a',
    repo,
    origin: remote,
    repositoryId: `local:${repo}`,
    candidates,
    runId,
    availableBytes: 10 * 1024 ** 3,
  });
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

function writeDescriptor(manifests: RepositoryMigrationManifest[], file: string): void {
  for (const manifest of manifests) {
    fs.mkdirSync(path.dirname(manifestPath(manifest)), { recursive: true });
    fs.writeFileSync(manifestPath(manifest), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const base: Omit<ActiveServerMigration, 'descriptorSha256'> = {
    version: 2,
    runId: manifests[0].runId,
    manifestPaths: manifests.map(manifestPath),
    manifestHashes: manifests.map((manifest) => manifest.manifestSha256),
    createdAt: '2026-08-14T00:00:00.000Z',
    recoverySeeds: [],
    aggregateCapacity: aggregateCapacityEvidence(manifests),
  };
  const descriptor: ActiveServerMigration = {
    ...base,
    descriptorSha256: createHash('sha256').update(canonicalJson(base)).digest('hex'),
  };
  fs.writeFileSync(file, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-nested-topology-'));
  dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN = '1';
});

afterEach(() => {
  delete process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('nested repository migration topology', () => {
  it('hash-binds same-origin captures deepest-first and restores them parent-first on rollback', async () => {
    const remote = createRemote('shared', 'nested');
    const outer = path.join(root, 'legacy', 'shared');
    const nested = path.join(outer, 'nested');
    cloneDirty(remote, outer, 'outer-change');
    cloneDirty(remote, nested, 'nested-change');
    const outerHead = git(outer, ['rev-parse', 'HEAD']);
    const nestedHead = git(nested, ['rev-parse', 'HEAD']);

    const manifest = createManifest(
      'shared',
      remote,
      [candidate('shared', outer, 'outer'), candidate('shared', nested, 'nested')],
      'run-same-origin-nested',
    );

    expect(manifest.captures.map((capture) => capture.checkoutPath)).toEqual([
      fs.realpathSync(nested),
      fs.realpathSync(outer),
    ]);
    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    expect(manifest.captures.every((capture) => fs.existsSync(capture.renamedOldPath!))).toBe(true);

    await rollbackRepositoryMigration(manifest);
    expect(git(outer, ['rev-parse', 'HEAD'])).toBe(outerHead);
    expect(git(nested, ['rev-parse', 'HEAD'])).toBe(nestedHead);
    expect(git(outer, ['status', '--porcelain=v1', '--untracked-files=all'])).toContain('outer-change.txt');
    expect(git(nested, ['status', '--porcelain=v1', '--untracked-files=all'])).toContain('nested-change.txt');
  });

  it('orders a differently-originated nested clone before its alphabetical ancestor and safely resumes and rolls back', async () => {
    const parentRemote = createRemote('parent', 'modules');
    const childRemote = createRemote('child', 'unused-nested');
    const parentCheckout = path.join(root, 'legacy', 'aaa-parent');
    const childCheckout = path.join(parentCheckout, 'modules', 'zzz-child');
    cloneDirty(parentRemote, parentCheckout, 'parent-change');
    cloneDirty(childRemote, childCheckout, 'child-change');
    const parentHead = git(parentCheckout, ['rev-parse', 'HEAD']);
    const childHead = git(childCheckout, ['rev-parse', 'HEAD']);
    const runId = 'run-cross-origin-nested';
    const parent = createManifest(
      'aaa-parent',
      parentRemote,
      [candidate('aaa-parent', parentCheckout, 'parent')],
      runId,
    );
    const child = createManifest('zzz-child', childRemote, [candidate('zzz-child', childCheckout, 'child')], runId);
    const ordered = orderRepositoryMigrationManifests([parent, child]);

    expect(ordered.map((manifest) => manifest.repo)).toEqual(['zzz-child', 'aaa-parent']);
    const wrongDescriptor = path.join(root, 'wrong-order.json');
    writeDescriptor([parent, child], wrongDescriptor);
    expect(() => loadMigrationDescriptor(wrongDescriptor, dataDir)).toThrow(
      /not in deterministic physical-containment order/,
    );
    const correctDescriptor = path.join(root, 'correct-order.json');
    writeDescriptor(ordered, correctDescriptor);
    expect(loadMigrationDescriptor(correctDescriptor, dataDir).manifests.map((manifest) => manifest.repo)).toEqual([
      'zzz-child',
      'aaa-parent',
    ]);

    await executeRepositoryMigration(child, { assertQuiescent: () => undefined });
    const parentCanonical = canonicalRepoDir('wg-a', parent.repo, dataDir);
    fs.mkdirSync(parentCanonical, { recursive: true });
    fs.writeFileSync(path.join(parentCanonical, 'collision'), 'not migration-owned\n');
    await expect(executeRepositoryMigration(parent, { assertQuiescent: () => undefined })).rejects.toThrow(
      /canonical destination already exists/,
    );
    expect(fs.existsSync(parentCheckout)).toBe(true);
    expect(fs.existsSync(childCheckout)).toBe(false);
    fs.rmSync(parentCanonical, { recursive: true, force: true });

    await executeRepositoryMigration(child, { assertQuiescent: () => undefined });
    await executeRepositoryMigration(parent, { assertQuiescent: () => undefined });
    for (const manifest of [...ordered].reverse()) await rollbackRepositoryMigration(manifest);
    verifyServerRollback(ordered, []);

    expect(git(parentCheckout, ['rev-parse', 'HEAD'])).toBe(parentHead);
    expect(git(childCheckout, ['rev-parse', 'HEAD'])).toBe(childHead);
    expect(git(parentCheckout, ['status', '--porcelain=v1', '--untracked-files=all'])).toContain('parent-change.txt');
    expect(git(childCheckout, ['status', '--porcelain=v1', '--untracked-files=all'])).toContain('child-change.txt');
  }, GIT_HEAVY_TEST_TIMEOUT_MS);
});
