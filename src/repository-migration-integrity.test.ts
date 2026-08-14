import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditRepositoryMigration,
  createRepositoryMigrationManifest,
  executeRepositoryMigration,
  manifestPath,
  repositoryMigrationPath,
  readLegacyCheckoutOrigin,
  rollbackRepositoryMigration,
  verifyRepositoryMigrationManifest,
  type LegacyCheckoutCandidate,
  type RepositoryMigrationManifest,
} from './repository-migration.js';
import {
  canonicalRepoDir,
  readOriginPin,
  resolveRepositoryWorkUnit,
  topicWorktreesDir,
} from './repository-workspaces.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

let root: string;
let dataDir: string;

function fixture(repo: string, options: { rescuePath?: boolean } = {}) {
  const seed = path.join(root, 'seed', repo);
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(seed, 'base.txt'), 'base\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'base']);

  const remote = path.join(root, 'remotes', `${repo}.git`);
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', seed, remote]);

  const legacy = options.rescuePath ? path.join(root, '.rescues', repo) : path.join(root, 'legacy', repo);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  execFileSync('git', ['clone', '-q', remote, legacy]);
  if (!options.rescuePath) git(legacy, ['switch', '-q', '-c', 'feature/integrity']);
  return { repo, remote, legacy };
}

function workUnit() {
  return resolveRepositoryWorkUnit({
    workgroupId: 'wg-a',
    sessionId: 'session-a',
    platformId: 'slack:C1',
    messagingGroupId: 'mg-1',
    threadId: 'thread-a',
  });
}

function candidate(checkoutPath: string, repo: string): LegacyCheckoutCandidate {
  return { workgroupId: 'wg-a', repo, checkoutPath, workUnit: workUnit() };
}

function activeManifest(repo = 'integrity', includeMirror = false): RepositoryMigrationManifest {
  const f = fixture(repo);
  const mirror = path.join(root, 'legacy', '.repos', `${repo}.git`);
  if (includeMirror) {
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    execFileSync('git', ['clone', '-q', '--bare', f.remote, mirror]);
  }
  return createRepositoryMigrationManifest({
    dataDir,
    workgroupId: 'wg-a',
    repo,
    origin: f.remote,
    repositoryId: `local:${repo}`,
    candidates: [candidate(f.legacy, repo)],
    ...(includeMirror ? { objectStores: [mirror] } : {}),
    runId: `run-${repo}`,
    availableBytes: 10 * 1024 * 1024 * 1024,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-migration-integrity-'));
  dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN = '1';
});

afterEach(() => {
  delete process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('repository migration cutover integrity', () => {
  it('redacts credential-bearing legacy origins from conflict diagnostics', () => {
    const checkout = path.join(root, 'broken-origin-checkout');
    fs.mkdirSync(checkout, { recursive: true });
    fs.writeFileSync(path.join(checkout, '.git'), 'gitdir: /missing/linked-admin\n');
    const stores = ['one', 'two'].map((name) => {
      const store = path.join(root, 'origin-stores', `${name}.git`);
      fs.mkdirSync(path.dirname(store), { recursive: true });
      execFileSync('git', ['init', '--bare', '-q', store]);
      return store;
    });
    const origins = [
      'https://legacy-token-one:legacy-password-one@github.com/Example/One.git',
      'https://legacy-token-two:legacy-password-two@github.com/Example/Two.git',
    ];
    for (const [index, store] of stores.entries()) {
      execFileSync('git', ['--git-dir', store, 'remote', 'add', 'origin', origins[index]]);
    }

    const readConflictingOrigin = () =>
      readLegacyCheckoutOrigin({ ...candidate(checkout, 'credential-conflict'), candidateCommonGitDirs: stores });
    expect(readConflictingOrigin).toThrow(/origin conflict.*2 distinct values.*observedOriginsSha256=[a-f0-9]{64}/);
    for (const secret of ['legacy-token-one', 'legacy-password-one', 'legacy-token-two', 'legacy-password-two']) {
      expect(readConflictingOrigin).not.toThrow(secret);
    }
    for (const origin of origins) expect(readConflictingOrigin).not.toThrow(origin);
  });

  it('derives only credential-free active migration state from a legacy query-token origin', async () => {
    const f = fixture('legacy-query-token');
    const secret = 'QUERY_SYNTHETIC_SECRET';
    const rawOrigin = `https://github.com/Example/legacy-query-token.git?access_token=${secret}`;
    git(f.legacy, ['remote', 'set-url', 'origin', rawOrigin]);
    const legacyCandidate = {
      ...candidate(f.legacy, f.repo),
      credentialBearingOrigin: true as const,
    };
    const manifest = createRepositoryMigrationManifest({
      dataDir,
      workgroupId: 'wg-a',
      repo: f.repo,
      origin: rawOrigin,
      repositoryId: 'migration:caller-controlled-identity',
      candidates: [legacyCandidate],
      runId: 'run-legacy-query-token',
      availableBytes: 10 * 1024 * 1024 * 1024,
    });

    expect(manifest.origin).toBe('https://github.com/Example/legacy-query-token');
    expect(manifest.repositoryId).toBe('github.com/example/legacy-query-token');
    expect(manifest.captures[0].credentialBearingOrigin).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain(secret);
    expect(JSON.stringify(manifest)).not.toContain(rawOrigin);

    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    const canonical = canonicalRepoDir('wg-a', f.repo, dataDir);
    expect(git(canonical, ['config', '--get', 'remote.origin.url'])).toBe(manifest.origin);
    expect(readOriginPin('wg-a', f.repo, dataDir)).toEqual({
      origin: manifest.origin,
      repositoryId: manifest.repositoryId,
    });
    const persistedManifest = fs.readFileSync(manifestPath(manifest), 'utf8');
    expect(persistedManifest).not.toContain(secret);
    expect(persistedManifest).not.toContain(rawOrigin);
  }, 30_000);

  it('hash-binds deterministic rollback fields before execution and uses them unchanged', async () => {
    const manifest = activeManifest('integrity', true);
    const capture = manifest.captures[0];
    const expectedRescuePrefix = `refs/nanoclaw-rescue/${manifest.runId}/${capture.id}`;

    expect(capture.rescue).toEqual({
      headRef: `${expectedRescuePrefix}/head`,
      indexRef: `${expectedRescuePrefix}/index`,
      worktreeRef: `${expectedRescuePrefix}/worktree`,
    });
    expect(capture.assignedBranch).toBe('feature/integrity');
    expect(capture.destinationPath).toBe(path.join(topicWorktreesDir(capture.workUnit, dataDir), manifest.repo));
    expect(capture.renamedOldPath).toBe(
      path.join(dataDir, 'repository-migrations', manifest.runId, 'wg-a', manifest.repo, 'renamed-old', capture.id),
    );
    const mirror = manifest.objectStores.find((store) => store.split(path.sep).includes('.repos'))!;
    expect(manifest.renamedObjectStores).toEqual({
      [mirror]: path.join(
        dataDir,
        'repository-migrations',
        manifest.runId,
        'wg-a',
        manifest.repo,
        'renamed-object-stores',
        Object.values(manifest.renamedObjectStores!)[0].split(path.sep).at(-1)!,
      ),
    });
    expect(() => verifyRepositoryMigrationManifest(manifest)).not.toThrow();
    const mutations: Array<(candidate: RepositoryMigrationManifest) => void> = [
      (candidate) => {
        candidate.captures[0].rescue!.indexRef += '-tampered';
      },
      (candidate) => {
        candidate.captures[0].assignedBranch = `${candidate.captures[0].assignedBranch!}-tampered`;
      },
      (candidate) => {
        candidate.captures[0].destinationPath = `${candidate.captures[0].destinationPath!}-tampered`;
      },
      (candidate) => {
        candidate.captures[0].renamedOldPath = `${candidate.captures[0].renamedOldPath!}-tampered`;
      },
      (candidate) => {
        candidate.renamedObjectStores![mirror] += '-tampered';
      },
    ];
    for (const mutate of mutations) {
      const candidate = JSON.parse(JSON.stringify(manifest)) as RepositoryMigrationManifest;
      mutate(candidate);
      expect(() => verifyRepositoryMigrationManifest(candidate)).toThrow(/manifest hash mismatch/);
    }

    const before = JSON.parse(
      JSON.stringify({
        rescue: capture.rescue,
        assignedBranch: capture.assignedBranch,
        destinationPath: capture.destinationPath,
        renamedOldPath: capture.renamedOldPath,
        renamedObjectStores: manifest.renamedObjectStores,
      }),
    );
    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    expect({
      rescue: capture.rescue,
      assignedBranch: capture.assignedBranch,
      destinationPath: capture.destinationPath,
      renamedOldPath: capture.renamedOldPath,
      renamedObjectStores: manifest.renamedObjectStores,
    }).toEqual(before);
  }, 30_000);

  it('rejects a tampered rollback path before removing a migrated worktree', async () => {
    const manifest = activeManifest('rollback-integrity');
    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    const destination = manifest.captures[0].destinationPath!;
    const canonical = canonicalRepoDir('wg-a', manifest.repo, dataDir);
    const tampered = JSON.parse(JSON.stringify(manifest)) as RepositoryMigrationManifest;
    tampered.captures[0].destinationPath = path.join(root, 'wrong-destination');

    await expect(rollbackRepositoryMigration(tampered)).rejects.toThrow(/manifest hash mismatch/);
    expect(fs.existsSync(destination)).toBe(true);
    expect(fs.existsSync(canonical)).toBe(true);
  }, 30_000);

  it('returns distinct safe repository paths for active and archive-only manifests', () => {
    const active = activeManifest('active-path');
    expect(repositoryMigrationPath(active)).toBe(canonicalRepoDir('wg-a', active.repo, dataDir));

    const archivedFixture = fixture('archived-path', { rescuePath: true });
    const archivedCandidate: LegacyCheckoutCandidate = {
      workgroupId: 'wg-a',
      repo: archivedFixture.repo,
      checkoutPath: archivedFixture.legacy,
      workUnit: {
        workgroupId: 'wg-a',
        kind: 'session',
        key: 'session:legacy:archived-path',
        id: 'a'.repeat(32),
      },
    };
    const archived = createRepositoryMigrationManifest({
      dataDir,
      workgroupId: 'wg-a',
      repo: archivedFixture.repo,
      origin: null,
      archiveOnly: true,
      repositoryId: `local-only:${archivedFixture.repo}`,
      candidates: [archivedCandidate],
      runId: 'run-archived-path',
      availableBytes: 10 * 1024 * 1024 * 1024,
    });
    expect(repositoryMigrationPath(archived)).toBe(
      path.join(dataDir, 'repository-migrations', archived.runId, 'wg-a', archived.repo, 'preserved-repository'),
    );
  });

  it('fails a canary audit when the canonical registers an unexpected linked worktree', async () => {
    const manifest = activeManifest('worktree-drift');
    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    const canonical = repositoryMigrationPath(manifest);
    const unexpected = path.join(root, 'unexpected-worktree');
    git(canonical, ['worktree', 'add', '-q', '--detach', unexpected]);

    expect(() => auditRepositoryMigration(manifest)).toThrow(/unexpected linked worktree/);
  }, 30_000);
});
