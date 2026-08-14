import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditRepositoryMigration,
  createRepositoryMigrationManifest,
  createReviewedExactGitAdminRecoveryProposal,
  executeRepositoryMigration,
  type LegacyCheckoutCandidate,
} from '../src/repository-migration.js';
import { observedOriginsSha256, type LoadedReviewedRecoveryDecisions } from '../src/repository-migration-recovery.js';
import { canonicalRepoDir, resolveRepositoryWorkUnit } from '../src/repository-workspaces.js';
import { coalesceRepositoryIdentityAliases, prepareReviewedRepositoryAliases } from './migrate-repo-store.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

let root: string;
let dataDir: string;

function workUnit(threadId: string) {
  return resolveRepositoryWorkUnit({
    workgroupId: 'wg-a',
    sessionId: `session-${threadId}`,
    platformId: 'slack:C1',
    messagingGroupId: 'mg-1',
    threadId,
  });
}

function fixture(repo: string) {
  const seed = path.join(root, 'seed', repo);
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(seed, 'base.txt'), `${repo}\n`);
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'base']);
  const remote = path.join(root, 'remotes', `${repo}.git`);
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', seed, remote]);
  const legacy = path.join(root, 'legacy', repo);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  execFileSync('git', ['clone', '-q', remote, legacy]);
  git(legacy, ['switch', '-q', '-c', `work/${repo}`]);
  fs.writeFileSync(path.join(legacy, 'retained.txt'), `${repo} retained\n`);
  git(legacy, ['add', '-A']);
  git(legacy, ['commit', '-q', '-m', 'retained']);
  return { repo, remote, legacy };
}

function candidate(checkoutPath: string, repo: string, threadId: string): LegacyCheckoutCandidate {
  return { workgroupId: 'wg-a', repo, checkoutPath, workUnit: workUnit(threadId) };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-alias-migration-'));
  dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN = '1';
});

afterEach(() => {
  delete process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('reviewed retired repository aliases', () => {
  it('creates one active monorepo while retaining every archived backend state and rescue ref', async () => {
    const monorepo = fixture('XZO');
    const retired = fixture('XZO-BACKEND');
    const active = candidate(monorepo.legacy, monorepo.repo, 'thread-active');
    const archived = candidate(retired.legacy, retired.repo, 'thread-retired');
    const archiveDecision = createReviewedExactGitAdminRecoveryProposal({
      candidate: archived,
      selectedGitDir: path.join(retired.legacy, '.git'),
      action: 'archive-visible-state',
    });
    const reviewedRecovery: LoadedReviewedRecoveryDecisions = {
      sourcePath: path.join(root, 'reviewed.json'),
      sha256: 'a'.repeat(64),
      checkouts: [archiveDecision],
      origins: [
        {
          workgroupId: 'wg-a',
          repo: retired.repo,
          observedOriginsSha256: observedOriginsSha256([null]),
          selectedOrigin: null,
          archiveOnly: true,
        },
      ],
      repositoryAliases: [{ workgroupId: 'wg-a', sourceRepo: retired.repo, destinationRepo: monorepo.repo }],
    };
    const grouped = new Map<string, LegacyCheckoutCandidate[]>([
      [`wg-a\0${monorepo.repo}`, [active]],
      [`wg-a\0${retired.repo}`, [archived]],
    ]);
    const bareStores = new Map<string, string[]>();
    const prepared = prepareReviewedRepositoryAliases(grouped, bareStores, reviewedRecovery);
    expect(prepared.consumedOriginKeys).toEqual(new Set([`wg-a\0${retired.repo}`]));
    expect(prepared.aliasedCheckoutPaths).toEqual(new Set([path.resolve(retired.legacy)]));
    expect(prepared.reviewedRecovery?.checkouts[0].repo).toBe(monorepo.repo);

    coalesceRepositoryIdentityAliases(grouped, bareStores, reviewedRecovery.repositoryAliases);
    expect([...grouped.keys()]).toEqual([`wg-a\0${monorepo.repo}`]);
    expect(grouped.get(`wg-a\0${monorepo.repo}`)).toHaveLength(2);

    const manifest = createRepositoryMigrationManifest({
      dataDir,
      workgroupId: 'wg-a',
      repo: monorepo.repo,
      origin: monorepo.remote,
      repositoryId: 'local:XZO',
      candidates: grouped.get(`wg-a\0${monorepo.repo}`)!,
      recoveryDecisions: prepared.reviewedRecovery!.checkouts,
      availableBytes: 10 * 1024 * 1024 * 1024,
    });
    const archivedCapture = manifest.captures.find(
      (capture) => capture.checkoutPath === fs.realpathSync(retired.legacy),
    );
    expect(archivedCapture?.archivedLegacy).toEqual({ reason: 'operator-reviewed-checkout' });
    expect(archivedCapture?.destinationPath).toBeUndefined();
    expect(manifest.captures.filter((capture) => capture.destinationPath !== undefined)).toHaveLength(1);

    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);
    const canonical = canonicalRepoDir('wg-a', monorepo.repo, dataDir);
    expect(fs.existsSync(canonical)).toBe(true);
    expect(fs.existsSync(canonicalRepoDir('wg-a', retired.repo, dataDir))).toBe(false);
    expect(fs.existsSync(archivedCapture!.renamedOldPath!)).toBe(true);
    for (const [kind, rescueRef] of Object.entries(archivedCapture!.rescue!)) {
      if (rescueRef === null) continue;
      const importedRef = `refs/nanoclaw-import/${archivedCapture!.id}/${kind.replace(/Ref$/, '')}`;
      expect(git(canonical, ['rev-parse', '--verify', importedRef])).toMatch(/^[a-f0-9]{40}$/);
    }
  });

  it('rejects a source checkout without an archive decision before mutation', () => {
    const monorepo = fixture('XZO');
    const retired = fixture('XZO-BACKEND');
    const grouped = new Map<string, LegacyCheckoutCandidate[]>([
      [`wg-a\0${monorepo.repo}`, [candidate(monorepo.legacy, monorepo.repo, 'thread-active')]],
      [`wg-a\0${retired.repo}`, [candidate(retired.legacy, retired.repo, 'thread-retired')]],
    ]);
    const reviewedRecovery: LoadedReviewedRecoveryDecisions = {
      sourcePath: path.join(root, 'reviewed.json'),
      sha256: 'a'.repeat(64),
      checkouts: [],
      origins: [
        {
          workgroupId: 'wg-a',
          repo: retired.repo,
          observedOriginsSha256: observedOriginsSha256([null]),
          selectedOrigin: null,
          archiveOnly: true,
        },
      ],
      repositoryAliases: [{ workgroupId: 'wg-a', sourceRepo: retired.repo, destinationRepo: monorepo.repo }],
    };
    expect(() => prepareReviewedRepositoryAliases(grouped, new Map(), reviewedRecovery)).toThrow(
      /requires an exact archive-visible-state decision/,
    );
    expect(fs.existsSync(monorepo.legacy)).toBe(true);
    expect(fs.existsSync(retired.legacy)).toBe(true);
  });
});
