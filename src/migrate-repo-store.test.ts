import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditRepositoryMigration,
  captureCheckout,
  createReviewedMissingAdminRecoveryProposal,
  createReviewedExactGitAdminRecoveryProposal,
  createLegacyGitResolutionContext,
  createRepositoryMigrationManifest,
  executeRepositoryMigration,
  mergeLegacyCheckoutProvenance,
  manifestPath,
  missingAdminVisibleStateSha256,
  readLegacyCheckoutOrigin,
  rollbackRepositoryMigration,
  type LegacyCheckoutCandidate,
  type MigrationPhase,
} from './repository-migration.js';
import { recoverySeedGitDirSha256, type ReviewedCheckoutRecoveryDecision } from './repository-migration-recovery.js';
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

function workUnit(threadId: string) {
  return resolveRepositoryWorkUnit({
    workgroupId: 'wg-a',
    sessionId: `session-${threadId}`,
    platformId: 'slack:C1',
    messagingGroupId: 'mg-1',
    threadId,
  });
}

function fixture(options: { dirty?: boolean; detached?: boolean; repo?: string } = {}) {
  const repo = options.repo ?? 'project';
  const seed = path.join(root, 'seed', repo);
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(seed, 'base.txt'), 'base\n');
  fs.writeFileSync(path.join(seed, 'unstaged.txt'), 'original\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'base']);
  const remote = path.join(root, 'remotes', `${repo}.git`);
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', seed, remote]);
  const legacy = path.join(root, 'legacy', repo);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  execFileSync('git', ['clone', '-q', remote, legacy]);
  git(legacy, ['switch', '-q', '-c', 'shared-feature']);
  fs.writeFileSync(path.join(legacy, 'unpushed.txt'), 'commit retained\n');
  git(legacy, ['add', '-A']);
  git(legacy, ['commit', '-q', '-m', 'unpushed']);
  if (options.detached) git(legacy, ['checkout', '-q', '--detach']);
  if (options.dirty) {
    fs.chmodSync(path.join(legacy, 'base.txt'), 0o600);
    fs.writeFileSync(path.join(legacy, 'staged.txt'), 'staged\n');
    git(legacy, ['add', 'staged.txt']);
    fs.writeFileSync(path.join(legacy, 'unstaged.txt'), 'working edit\n');
    fs.writeFileSync(path.join(legacy, 'untracked.txt'), 'untracked\n');
    fs.chmodSync(path.join(legacy, 'untracked.txt'), 0o640);
    fs.writeFileSync(path.join(legacy, 'executable.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.symlinkSync('base.txt', path.join(legacy, 'base-link'));
  }
  return { repo, seed, remote, legacy };
}

function candidate(checkoutPath: string, repo = 'project', threadId = 'thread-1'): LegacyCheckoutCandidate {
  return { workgroupId: 'wg-a', repo, checkoutPath, workUnit: workUnit(threadId) };
}

function repositoryStagingCandidate(
  checkoutPath: string,
  repo = 'project',
  options: { credentialBearingOrigin?: boolean } = {},
): LegacyCheckoutCandidate {
  return {
    workgroupId: 'wg-a',
    repo,
    checkoutPath,
    workUnit: {
      workgroupId: 'wg-a',
      kind: 'session',
      key: `session:legacy:repository-staging-${repo}`,
      id: `repository-staging-${repo}`,
    },
    sourceRole: 'repository-staging',
    ...(options.credentialBearingOrigin ? { credentialBearingOrigin: true } : {}),
  };
}

function manifestFor(
  candidates: LegacyCheckoutCandidate[],
  remote: string,
  repo = 'project',
  runId?: string,
  recoveryDecisions?: ReviewedCheckoutRecoveryDecision[],
) {
  return createRepositoryMigrationManifest({
    dataDir,
    workgroupId: 'wg-a',
    repo,
    origin: remote,
    repositoryId: `local:${repo}`,
    candidates,
    availableBytes: 10 * 1024 * 1024 * 1024,
    runId,
    recoveryDecisions,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-migration-'));
  dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN = '1';
});

afterEach(() => {
  delete process.env.NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN;
  delete process.env.NANOCLAW_MIGRATION_FAIL_AFTER;
  delete process.env.NANOCLAW_MIGRATION_CRASH_AFTER;
  delete process.env.NANOCLAW_REPOSITORY_RECOVERY_SEED_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('lossless server-wide repository migration', () => {
  it('upgrades duplicate alias discovery only when the direct root proves legacy canonical provenance', () => {
    const base = candidate('/tmp/alias/project', 'project');
    expect(mergeLegacyCheckoutProvenance(base, base).sourceRole).toBeUndefined();
    expect(mergeLegacyCheckoutProvenance(base, { ...base, sourceRole: 'legacy-canonical' }).sourceRole).toBe(
      'legacy-canonical',
    );
    expect(mergeLegacyCheckoutProvenance({ ...base, sourceRole: 'legacy-canonical' }, base).sourceRole).toBe(
      'legacy-canonical',
    );
  });

  it('prefers origin HEAD over a newer local feature HEAD for the clean canonical base', () => {
    const f = fixture({ repo: 'remote-default-base' });
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--amend', '--no-edit', '-q'],
      {
        cwd: f.legacy,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2040-01-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2040-01-01T00:00:00Z',
        },
      },
    );
    const remoteDefault = git(f.legacy, ['rev-parse', '--verify', 'refs/remotes/origin/HEAD^{commit}']);
    const localFeature = git(f.legacy, ['rev-parse', '--verify', 'HEAD^{commit}']);
    expect(localFeature).not.toBe(remoteDefault);

    const manifest = manifestFor([candidate(f.legacy, f.repo)], f.remote, f.repo);
    expect(manifest.canonicalBase.head).toBe(remoteDefault);
    expect(manifest.canonicalBase.branch).toBe('main');
    expect(manifest.canonicalBase.sourceRef).toBe('refs/remotes/origin/main');
  });

  it('caches only fallback common-origin reads and still blocks originless broken pointers', () => {
    const f = fixture({ repo: 'cached-origin-recovery' });
    const linked = path.join(root, 'legacy', 'linked-origin');
    git(f.legacy, ['worktree', 'add', '-q', '-b', 'linked-origin', linked]);
    const marker = fs.readFileSync(path.join(linked, '.git'), 'utf8');
    const admin = /^gitdir:\s*(.+)\s*$/i.exec(marker)?.[1];
    expect(admin).toBeTruthy();
    const linkedCandidate = {
      ...candidate(linked, f.repo),
      candidateCommonGitDirs: [path.join(f.legacy, '.git')],
    };
    const exactContext = createLegacyGitResolutionContext(linkedCandidate.candidateCommonGitDirs);
    expect(captureCheckout(linkedCandidate, exactContext)).toEqual(captureCheckout(linkedCandidate));

    fs.renameSync(admin!, path.join(root, 'detached-admin'));
    const context = createLegacyGitResolutionContext(linkedCandidate.candidateCommonGitDirs);
    expect(readLegacyCheckoutOrigin(linkedCandidate, context)).toBe(f.remote);
    expect(readLegacyCheckoutOrigin(linkedCandidate, context)).toBe(f.remote);
    expect(context.commonOriginCache.size).toBe(1);

    const originless = path.join(root, 'legacy', 'originless');
    fs.mkdirSync(originless, { recursive: true });
    git(originless, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(originless, 'base.txt'), 'originless\n');
    git(originless, ['add', '-A']);
    git(originless, ['commit', '-q', '-m', 'originless']);
    const broken = path.join(root, 'legacy', 'originless-broken');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, '.git'), 'gitdir: /missing/originless/admin\n');
    const originlessCandidate = {
      ...candidate(broken, 'originless'),
      candidateCommonGitDirs: [path.join(originless, '.git')],
    };
    const originlessContext = createLegacyGitResolutionContext(originlessCandidate.candidateCommonGitDirs);
    expect(() => readLegacyCheckoutOrigin(originlessCandidate, originlessContext)).toThrow(/no usable Git admin/);
    expect(originlessContext.commonOriginCache.get(fs.realpathSync(path.join(originless, '.git')))).toBeNull();
  });
  it('preserves an originless repository as a local-only canonical and linked topic worktree', async () => {
    const local = path.join(root, 'legacy', 'scratch');
    fs.mkdirSync(local, { recursive: true });
    git(local, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(local, 'tracked.txt'), 'committed\n');
    git(local, ['add', '-A']);
    git(local, ['commit', '-q', '-m', 'local only']);
    fs.writeFileSync(path.join(local, 'ongoing.txt'), 'untracked work\n');
    const before = captureCheckout(candidate(local, 'scratch'));
    const manifest = createRepositoryMigrationManifest({
      dataDir,
      workgroupId: 'wg-a',
      repo: 'scratch',
      origin: null,
      repositoryId: 'local-only:scratch',
      candidates: [candidate(local, 'scratch')],
      availableBytes: 10 * 1024 * 1024 * 1024,
    });

    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);

    const canonical = canonicalRepoDir('wg-a', 'scratch', dataDir);
    expect(() => git(canonical, ['config', '--get', 'remote.origin.url'])).toThrow();
    expect(readOriginPin('wg-a', 'scratch', dataDir)).toEqual({
      kind: 'local-only',
      origin: null,
      repositoryId: 'local-only:scratch',
    });
    expect(manifest.captures[0].statusZBase64).toBe(before.statusZBase64);
    expect(fs.readFileSync(path.join(manifest.captures[0].destinationPath!, 'ongoing.txt'), 'utf8')).toBe(
      'untracked work\n',
    );
  });

  it('archives an unmapped clean remote-contained legacy checkout without creating an unreachable topic', async () => {
    const f = fixture({ repo: 'archived-clean' });
    git(f.legacy, ['switch', '-q', 'main']);
    const fallback = {
      workgroupId: 'wg-a',
      kind: 'session' as const,
      key: 'session:legacy:archived-clean',
      id: '11111111111111111111111111111111',
    };
    const legacyCandidate = { ...candidate(f.legacy, f.repo), workUnit: fallback };
    const before = captureCheckout(legacyCandidate);
    const manifest = manifestFor([legacyCandidate], f.remote, f.repo);
    expect(manifest.captures[0].archivedLegacy).toEqual({ reason: 'clean-remote-contained' });

    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);

    expect(manifest.captures[0].destinationPath).toBeUndefined();
    expect(fs.existsSync(manifest.captures[0].renamedOldPath!)).toBe(true);
    expect(manifest.captures[0].files).toEqual(before.files);
  });

  it('classifies and archives a clean remote-contained retained repository staging clone', () => {
    const f = fixture({ repo: 'retained-stage-clean' });
    git(f.legacy, ['switch', '-q', 'main']);

    const manifest = manifestFor([repositoryStagingCandidate(f.legacy, f.repo)], f.remote, f.repo);

    expect(manifest.captures[0]).toMatchObject({
      sourceRole: 'repository-staging',
      archivedLegacy: { reason: 'clean-remote-contained' },
    });
    expect(manifest.captures[0].destinationPath).toBeUndefined();
  });

  it('requires explicit reviewed preservation for dirty, unpushed, or detached repository staging state', () => {
    const dirty = fixture({ dirty: true, repo: 'retained-stage-dirty' });
    expect(() => manifestFor([repositoryStagingCandidate(dirty.legacy, dirty.repo)], dirty.remote, dirty.repo)).toThrow(
      /repository-staging.*explicitly archive.*reviewed/s,
    );

    const detached = fixture({ repo: 'retained-stage-detached' });
    git(detached.legacy, ['switch', '-q', 'main']);
    git(detached.legacy, ['checkout', '-q', '--detach']);
    expect(() =>
      manifestFor([repositoryStagingCandidate(detached.legacy, detached.repo)], detached.remote, detached.repo),
    ).toThrow(/repository-staging.*explicitly archive.*reviewed/s);
  });

  it('requires hash-bound review for a credential-bearing repository staging clone without echoing credentials', () => {
    const f = fixture({ repo: 'retained-stage-credentialed' });
    git(f.legacy, ['switch', '-q', 'main']);
    const secret = 'do-not-print-this-token';
    const staged = repositoryStagingCandidate(f.legacy, f.repo, { credentialBearingOrigin: true });

    let message = '';
    try {
      manifestFor([staged], f.remote, f.repo);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/credential-bearing repository-staging.*reviewed preservation/);
    expect(message).not.toContain(secret);

    const decision = createReviewedExactGitAdminRecoveryProposal({
      candidate: staged,
      selectedGitDir: path.join(f.legacy, '.git'),
      action: 'archive-visible-state',
    });
    expect(() => manifestFor([staged], f.remote, f.repo, undefined, [decision])).toThrow(
      /repository-staging-only.*archive-only.*cannot publish an active canonical/,
    );

    const archived = createRepositoryMigrationManifest({
      dataDir,
      workgroupId: 'wg-a',
      repo: f.repo,
      origin: null,
      archiveOnly: true,
      repositoryId: `local-only:${f.repo}`,
      candidates: [staged],
      recoveryDecisions: [decision],
      availableBytes: 10 * 1024 * 1024 * 1024,
    });
    expect(archived.archiveOnly).toBe(true);
    expect(archived.captures[0].archivedLegacy).toEqual({ reason: 'operator-reviewed-checkout' });
    expect(JSON.stringify(archived)).not.toContain(secret);
  });

  it('blocks unmapped dirty or unpushed state instead of silently archiving ongoing work', () => {
    const f = fixture({ dirty: true, repo: 'unmapped-dirty' });
    const fallback = {
      workgroupId: 'wg-a',
      kind: 'session' as const,
      key: 'session:legacy:unmapped-dirty',
      id: '22222222222222222222222222222222',
    };
    expect(() => manifestFor([{ ...candidate(f.legacy, f.repo), workUnit: fallback }], f.remote, f.repo)).toThrow(
      /dirty, unborn, local-only, or unpushed state.*reviewed mappings/s,
    );
    expect(fs.readFileSync(path.join(f.legacy, 'untracked.txt'), 'utf8')).toBe('untracked\n');
  });

  it('restores a dirty legacy canonical as a host-only linked rescue worktree', async () => {
    const f = fixture({ dirty: true, repo: 'shared-dirty' });
    const shared = {
      ...candidate(f.legacy, f.repo),
      sourceRole: 'legacy-canonical' as const,
      workUnit: {
        workgroupId: 'wg-a',
        kind: 'session' as const,
        key: 'session:legacy:shared-dirty',
        id: '33333333333333333333333333333333',
      },
    };
    const before = captureCheckout(shared);
    const manifest = manifestFor([shared], f.remote, f.repo);
    expect(manifest.captures[0].preservedLegacy).toEqual({ reason: 'legacy-canonical-unique-state' });

    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);

    expect(manifest.captures[0].destinationPath).toContain(path.join(dataDir, 'repository-rescues', 'wg-a', f.repo));
    expect(manifest.captures[0].branch).toBe(before.branch);
    expect(manifest.captures[0].assignedBranch).toMatch(/^rescue\/migrated-/);
    expect(fs.existsSync(f.legacy)).toBe(false);
    expect(fs.lstatSync(path.join(manifest.captures[0].destinationPath!, '.git')).isFile()).toBe(true);
    expect(manifest.captures[0].statusZBase64).toBe(before.statusZBase64);
    expect(fs.readFileSync(path.join(manifest.captures[0].destinationPath!, 'untracked.txt'), 'utf8')).toBe(
      'untracked\n',
    );
    expect(fs.existsSync(manifest.captures[0].renamedOldPath!)).toBe(true);
  });

  it('imports SHA-256 loose objects into a matching local-only canonical', async () => {
    const local = path.join(root, 'legacy', 'sha256-local');
    fs.mkdirSync(local, { recursive: true });
    git(local, ['init', '-q', '--object-format=sha256', '-b', 'main']);
    fs.writeFileSync(path.join(local, 'sha256.txt'), 'sha256 object\n');
    git(local, ['add', '-A']);
    git(local, ['commit', '-q', '-m', 'sha256']);
    const manifest = createRepositoryMigrationManifest({
      dataDir,
      workgroupId: 'wg-a',
      repo: 'sha256-local',
      origin: null,
      repositoryId: 'local-only:sha256-local',
      candidates: [candidate(local, 'sha256-local')],
      availableBytes: 10 * 1024 * 1024 * 1024,
    });
    expect(manifest.canonicalBase.objectFormat).toBe('sha256');
    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);
    expect(git(canonicalRepoDir('wg-a', 'sha256-local', dataDir), ['rev-parse', '--show-object-format'])).toBe(
      'sha256',
    );
  });

  it('migration-preserves-dirty-staged-unstaged-untracked-detached-and-unpushed-state', async () => {
    const f = fixture({ dirty: true, detached: true });
    const before = captureCheckout(candidate(f.legacy));
    const manifest = manifestFor([candidate(f.legacy)], f.remote);
    let quiescenceChecks = 0;
    await executeRepositoryMigration(manifest, {
      assertQuiescent: () => {
        quiescenceChecks += 1;
      },
    });

    expect(quiescenceChecks).toBe(2);
    auditRepositoryMigration(manifest);
    const migrated = manifest.captures[0];
    expect(migrated.head).toBe(before.head);
    expect(migrated.statusZBase64).toBe(before.statusZBase64);
    expect(git(migrated.destinationPath!, ['branch', '--show-current'])).toBe('');
    expect(migrated.files).toEqual(before.files);
    expect(fs.existsSync(migrated.renamedOldPath!)).toBe(true);
    expect(fs.lstatSync(path.join(migrated.destinationPath!, '.git')).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(migrated.destinationPath!, 'base-link')).isSymbolicLink()).toBe(true);
    for (const name of ['base.txt', 'untracked.txt', 'executable.sh']) {
      const expectedMode = before.files.find((entry) => entry.path === name)!.mode;
      expect(fs.statSync(path.join(migrated.destinationPath!, name)).mode & 0o7777).toBe(expectedMode);
    }
    expect(captureCheckout(candidate(migrated.destinationPath!)).indexSha256).toBe(before.indexSha256);
    expect(fs.lstatSync(path.join(canonicalRepoDir('wg-a', f.repo, dataDir), '.git')).isDirectory()).toBe(true);
    expect(
      fs.statSync(
        path.join(dataDir, 'repository-migrations', manifest.runId, 'wg-a', f.repo, `${f.repo}.rescue.bundle`),
      ).size,
    ).toBeGreaterThan(0);
  });

  it('preserves a uniquely claimed existing PR branch name while the canonical stays detached', async () => {
    const f = fixture({ repo: 'unique-pr' });
    git(f.legacy, ['branch', '-m', 'feature/existing-pr']);
    const expectedHead = git(f.legacy, ['rev-parse', 'HEAD']);
    const manifest = manifestFor([candidate(f.legacy, f.repo)], f.remote, f.repo);

    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);

    const migrated = manifest.captures[0];
    const canonical = canonicalRepoDir('wg-a', f.repo, dataDir);
    expect(migrated.assignedBranch).toBe('feature/existing-pr');
    expect(git(migrated.destinationPath!, ['branch', '--show-current'])).toBe('feature/existing-pr');
    expect(git(migrated.destinationPath!, ['rev-parse', 'HEAD'])).toBe(expectedHead);
    expect(git(canonical, ['branch', '--show-current'])).toBe('');
  });

  it('preserves split-index bytes auxiliary files intent-to-add and index flags exactly', async () => {
    const f = fixture({ dirty: true, repo: 'split-index' });
    fs.writeFileSync(path.join(f.legacy, 'intent.txt'), 'intent to add\n');
    git(f.legacy, ['add', '-N', 'intent.txt']);
    git(f.legacy, ['update-index', '--assume-unchanged', 'base.txt']);
    git(f.legacy, ['update-index', '--split-index']);
    const beforeIntentEntry = git(f.legacy, ['ls-files', '--stage', 'intent.txt']);
    const before = captureCheckout(candidate(f.legacy, f.repo));
    expect(before.indexAuxiliaryFiles.length).toBeGreaterThan(0);

    const manifest = manifestFor([candidate(f.legacy, f.repo)], f.remote, f.repo);
    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);

    const migrated = captureCheckout(candidate(manifest.captures[0].destinationPath!, f.repo));
    expect(migrated.indexBytesBase64).toBe(before.indexBytesBase64);
    expect(migrated.indexAuxiliaryFiles).toEqual(before.indexAuxiliaryFiles);
    expect(git(manifest.captures[0].destinationPath!, ['ls-files', '-v', 'base.txt']).startsWith('h ')).toBe(true);
    expect(git(manifest.captures[0].destinationPath!, ['ls-files', '--stage', 'intent.txt'])).toBe(beforeIntentEntry);
  });

  it('preserves an unmerged conflict index and keeps every staged blob reachable', async () => {
    const f = fixture({ repo: 'conflicted' });
    git(f.legacy, ['switch', '-q', '-c', 'conflict-theirs']);
    fs.writeFileSync(path.join(f.legacy, 'base.txt'), 'theirs\n');
    git(f.legacy, ['add', 'base.txt']);
    git(f.legacy, ['commit', '-q', '-m', 'theirs']);
    git(f.legacy, ['switch', '-q', 'shared-feature']);
    fs.writeFileSync(path.join(f.legacy, 'base.txt'), 'ours\n');
    git(f.legacy, ['add', 'base.txt']);
    git(f.legacy, ['commit', '-q', '-m', 'ours']);
    expect(() => git(f.legacy, ['merge', 'conflict-theirs'])).toThrow();
    const before = captureCheckout(candidate(f.legacy, f.repo));
    expect(Buffer.from(before.indexEntriesZBase64, 'base64').toString('utf8')).toContain(' 2\tbase.txt');

    const manifest = manifestFor([candidate(f.legacy, f.repo)], f.remote, f.repo);
    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);
    const after = captureCheckout(candidate(manifest.captures[0].destinationPath!, f.repo));
    expect(after.indexBytesBase64).toBe(before.indexBytesBase64);
    expect(after.indexEntriesZBase64).toBe(before.indexEntriesZBase64);
    expect(after.statusZBase64).toBe(before.statusZBase64);
  });

  it('neutralizes included dotted-name filter drivers before legacy Git status runs', () => {
    const f = fixture({ repo: 'filtered' });
    const marker = path.join(root, 'host-filter-executed');
    const included = path.join(root, 'legacy-filter.config');
    fs.writeFileSync(
      included,
      `[filter "evil.dot"]\n\tclean = sh -c 'touch ${marker}; cat'\n\tsmudge = cat\n\trequired = true\n`,
    );
    fs.appendFileSync(path.join(f.legacy, '.git', 'config'), `\n[include]\n\tpath = ${included}\n`);
    fs.writeFileSync(path.join(f.legacy, '.gitattributes'), '*.txt filter=evil.dot\n');
    fs.writeFileSync(path.join(f.legacy, 'base.txt'), 'filter candidate\n');

    const captured = captureCheckout(candidate(f.legacy, f.repo));
    expect(captured.files.some((entry) => entry.path === 'base.txt')).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('blocks initialized submodule state before mutation instead of flattening or dropping it', () => {
    const f = fixture({ repo: 'parent' });
    const child = path.join(root, 'child');
    fs.mkdirSync(child);
    git(child, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(child, 'child.txt'), 'child\n');
    git(child, ['add', '-A']);
    git(child, ['commit', '-q', '-m', 'child']);
    git(f.legacy, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'nested-child']);
    git(f.legacy, ['commit', '-q', '-am', 'add submodule']);
    fs.writeFileSync(path.join(f.legacy, 'nested-child', 'child.txt'), 'dirty nested work\n');

    expect(() => manifestFor([candidate(f.legacy, f.repo)], f.remote, f.repo)).toThrow(
      /initialized submodule requires an explicit nested-state migration decision/,
    );
    expect(fs.readFileSync(path.join(f.legacy, 'nested-child', 'child.txt'), 'utf8')).toBe('dirty nested work\n');
  });

  it('blocks same-topic physical checkouts whose exact raw states differ until reviewed remapping', () => {
    const f = fixture();
    const duplicate = path.join(root, 'legacy', 'duplicate');
    execFileSync('git', ['clone', '-q', f.legacy, duplicate]);
    git(duplicate, ['checkout', '-q', f.legacy.endsWith('never') ? 'main' : 'shared-feature']);
    const candidates = [candidate(f.legacy), candidate(duplicate)];
    expect(() => manifestFor(candidates, f.remote)).toThrow(
      /divergent physical checkout state.*reviewed archive decision/,
    );
    expect(fs.existsSync(f.legacy)).toBe(true);
    expect(fs.existsSync(duplicate)).toBe(true);
  });

  it('proposes hash-bound archives for every divergent same-topic state when no active primary is unambiguous', async () => {
    const f = fixture({ repo: 'XZO-ANALYTICS' });
    const names = ['ANALYTICS-79', 'ANALYTICS-97', 'XZO-ANALYTICS-54'];
    const candidates = names.map((name, index) => {
      const checkout = path.join(root, 'legacy', name);
      execFileSync('git', ['clone', '-q', f.legacy, checkout]);
      const marker = `ongoing-${index}.txt`;
      fs.writeFileSync(path.join(checkout, marker), `preserve exact state ${index}\n`, {
        mode: index === 1 ? 0o755 : 0o640,
      });
      if (index === 2) git(checkout, ['add', marker]);
      return candidate(checkout, f.repo, 'one-real-slack-thread');
    });

    let message = '';
    try {
      manifestFor(candidates, f.remote, f.repo);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/no unambiguous active primary.*every divergent state.*reviewed archive/s);
    const proposals = message
      .split('\n')
      .filter((line) => line.startsWith('reviewed recovery proposal'))
      .map((line) => JSON.parse(line.slice(line.indexOf('{'))) as ReviewedCheckoutRecoveryDecision);
    expect(proposals).toHaveLength(candidates.length);
    expect(new Set(proposals.map((proposal) => proposal.checkoutPath))).toEqual(
      new Set(candidates.map((entry) => fs.realpathSync(entry.checkoutPath))),
    );
    for (const proposal of proposals) {
      expect(proposal).toMatchObject({
        action: 'archive-visible-state',
        selection: 'exact-git-admin',
        workgroupId: 'wg-a',
        repo: f.repo,
      });
      expect(proposal.visibleStateSha256).toMatch(/^[a-f0-9]{64}$/);
    }

    const manifest = manifestFor(candidates, f.remote, f.repo, undefined, proposals);
    expect(manifest.captures).toHaveLength(candidates.length);
    expect(manifest.captures.every((capture) => capture.archivedLegacy?.reason === 'operator-reviewed-checkout')).toBe(
      true,
    );
    expect(manifest.captures.every((capture) => capture.destinationPath === undefined)).toBe(true);

    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);
    expect(fs.existsSync(canonicalRepoDir('wg-a', f.repo, dataDir))).toBe(true);
    expect(fs.existsSync(path.join(topicWorktreesDir(candidates[0].workUnit, dataDir), f.repo))).toBe(false);
    for (const capture of manifest.captures) {
      const originalIndex = names.indexOf(path.basename(capture.checkoutPath));
      expect(originalIndex).toBeGreaterThanOrEqual(0);
      expect(fs.readFileSync(path.join(capture.renamedOldPath!, `ongoing-${originalIndex}.txt`), 'utf8')).toBe(
        `preserve exact state ${originalIndex}\n`,
      );
      expect(proposals.find((proposal) => proposal.checkoutPath === capture.checkoutPath)?.visibleStateSha256).toBe(
        capture.reviewedRecovery?.visibleStateSha256,
      );
    }
  }, 30_000);

  it('keeps one same-topic state active when a divergent alternate is explicitly archived', async () => {
    const f = fixture({ repo: 'topic-with-alternate' });
    const alternate = path.join(root, 'legacy', 'topic-alternate');
    execFileSync('git', ['clone', '-q', f.legacy, alternate]);
    git(alternate, ['checkout', '-q', 'shared-feature']);
    fs.writeFileSync(path.join(alternate, 'alternate-only.txt'), 'preserve outside active topic\n');
    const alternateCandidate = candidate(alternate, f.repo);
    const archiveDecision = createReviewedExactGitAdminRecoveryProposal({
      candidate: alternateCandidate,
      selectedGitDir: path.join(alternate, '.git'),
      action: 'archive-visible-state',
    });
    const manifest = manifestFor([candidate(f.legacy, f.repo), alternateCandidate], f.remote, f.repo, undefined, [
      archiveDecision,
    ]);
    expect(manifest.captures.filter((capture) => !capture.archivedLegacy)).toHaveLength(1);

    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);

    const active = manifest.captures.find((capture) => !capture.archivedLegacy)!;
    const archived = manifest.captures.find((capture) => capture.archivedLegacy)!;
    expect(active.destinationPath).toBeDefined();
    expect(archived.destinationPath).toBeUndefined();
    expect(fs.readFileSync(path.join(archived.renamedOldPath!, 'alternate-only.txt'), 'utf8')).toBe(
      'preserve outside active topic\n',
    );
  });

  it('assigns distinct paths branches indexes and admin directories when topics claimed one branch', async () => {
    const f = fixture();
    const second = path.join(root, 'legacy', 'second');
    execFileSync('git', ['clone', '-q', f.legacy, second]);
    git(second, ['checkout', '-q', 'shared-feature']);
    fs.writeFileSync(path.join(second, 'second-only.txt'), 'second\n');
    git(second, ['add', '-A']);
    const manifest = manifestFor(
      [candidate(f.legacy, f.repo, 'thread-1'), candidate(second, f.repo, 'thread-2')],
      f.remote,
    );
    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    const [a, b] = manifest.captures;
    expect(a.destinationPath).not.toBe(b.destinationPath);
    expect(a.assignedBranch).not.toBe(b.assignedBranch);
    const adminA = git(a.destinationPath!, ['rev-parse', '--path-format=absolute', '--git-dir']);
    const adminB = git(b.destinationPath!, ['rev-parse', '--path-format=absolute', '--git-dir']);
    expect(adminA).not.toBe(adminB);
    expect(path.join(adminA, 'index')).not.toBe(path.join(adminB, 'index'));
  });

  it('migration-recovers-the-live-Madison-shared-admin-collision', async () => {
    // Regression fixture for the live Madison shape: four physical topic
    // checkouts all point at one surviving linked-worktree admin directory.
    const f = fixture({ repo: 'dbt' });
    const linkedA = path.join(root, 'legacy', 'linked-a');
    const linkedB = path.join(root, 'legacy', 'linked-b');
    const linkedC = path.join(root, 'legacy', 'linked-c');
    const linkedD = path.join(root, 'legacy', 'linked-d');
    git(f.legacy, ['worktree', 'add', '-q', '-b', 'collision-a', linkedA, 'HEAD']);
    git(f.legacy, ['worktree', 'add', '-q', '-b', 'collision-b', linkedB, 'HEAD']);
    git(f.legacy, ['worktree', 'add', '-q', '-b', 'collision-c', linkedC, 'HEAD']);
    git(f.legacy, ['worktree', 'add', '-q', '-b', 'collision-d', linkedD, 'HEAD']);
    const pointerA = fs.readFileSync(path.join(linkedA, '.git'), 'utf8');
    fs.writeFileSync(path.join(linkedB, '.git'), pointerA);
    fs.writeFileSync(path.join(linkedC, '.git'), pointerA);
    fs.writeFileSync(path.join(linkedD, '.git'), pointerA);
    fs.writeFileSync(path.join(linkedA, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(linkedB, 'b.txt'), 'b\n');
    fs.writeFileSync(path.join(linkedC, 'c.txt'), 'c\n');
    fs.writeFileSync(path.join(linkedD, 'd.txt'), 'd\n');
    const common = path.join(f.legacy, '.git');
    const candidates = [
      { ...candidate(linkedA, f.repo, 'thread-a'), candidateCommonGitDirs: [common] },
      { ...candidate(linkedB, f.repo, 'thread-b'), candidateCommonGitDirs: [common] },
      { ...candidate(linkedC, f.repo, 'thread-c'), candidateCommonGitDirs: [common] },
      { ...candidate(linkedD, f.repo, 'thread-d'), candidateCommonGitDirs: [common] },
    ];
    const manifest = manifestFor(candidates, f.remote, f.repo);
    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);
    expect(fs.readFileSync(path.join(manifest.captures[0].destinationPath!, 'a.txt'), 'utf8')).toBe('a\n');
    expect(fs.readFileSync(path.join(manifest.captures[1].destinationPath!, 'b.txt'), 'utf8')).toBe('b\n');
    expect(fs.readFileSync(path.join(manifest.captures[2].destinationPath!, 'c.txt'), 'utf8')).toBe('c\n');
    expect(fs.readFileSync(path.join(manifest.captures[3].destinationPath!, 'd.txt'), 'utf8')).toBe('d\n');
  }, 20_000);

  it('blocks a dirty checkout whose pruned admin makes the original raw index unknowable', () => {
    const f = fixture();
    const orphan = path.join(root, 'legacy', 'project-pdt');
    git(f.legacy, ['worktree', 'add', '-q', '-b', 'feat/pdt-fix', orphan, 'HEAD']);
    fs.writeFileSync(path.join(orphan, 'unstaged.txt'), 'orphan edit\n');
    fs.writeFileSync(path.join(orphan, 'orphan-only.txt'), 'ongoing work\n');
    const admin = git(orphan, ['rev-parse', '--path-format=absolute', '--git-dir']);
    fs.rmSync(admin, { recursive: true, force: true });
    fs.writeFileSync(path.join(orphan, '.git'), 'gitdir: /workspace/workgroup/project/.git/worktrees/project-pdt\n');
    const orphanCandidate = {
      ...candidate(orphan, f.repo, 'thread-orphan'),
      candidateCommonGitDirs: [path.join(f.legacy, '.git')],
    };
    const recovered = captureCheckout(orphanCandidate);
    expect(recovered.recoveredMissingAdmin).toMatchObject({
      method: 'unique-pointer-token-branch',
      indexClassificationSynthesized: true,
    });
    expect(() => manifestFor([orphanCandidate], f.remote)).toThrow(
      /cannot prove the original raw index.*explicit operator recovery decision/s,
    );
  });

  it('blocks a clean missing-admin checkout because raw index flags and bytes are still unknowable', () => {
    const f = fixture({ repo: 'clean-missing-admin' });
    const orphan = path.join(root, 'legacy', 'clean-orphan');
    git(f.legacy, ['worktree', 'add', '-q', '-b', 'feat/clean-orphan', orphan, 'HEAD']);
    const admin = git(orphan, ['rev-parse', '--path-format=absolute', '--git-dir']);
    fs.rmSync(admin, { recursive: true, force: true });
    fs.writeFileSync(
      path.join(orphan, '.git'),
      'gitdir: /workspace/workgroup/clean-missing-admin/.git/worktrees/clean-orphan\n',
    );
    const orphanCandidate = {
      ...candidate(orphan, f.repo, 'thread-clean-orphan'),
      candidateCommonGitDirs: [path.join(f.legacy, '.git')],
    };
    const diagnostic = captureCheckout(orphanCandidate);
    expect(diagnostic.recoveredMissingAdmin).toMatchObject({
      method: 'unique-clean-local-branch',
    });
    expect(diagnostic.recoveredMissingAdmin?.indexClassificationSynthesized).toBeUndefined();
    expect(() => manifestFor([orphanCandidate], f.remote)).toThrow(
      /cannot prove the original raw index.*explicit operator recovery decision/s,
    );
  });

  it('does not exhaustively guess branches when proposal metadata is ambiguous', () => {
    const f = fixture({ repo: 'ambiguous-proposal' });
    const orphan = path.join(root, 'legacy', 'ambiguous-orphan');
    git(f.legacy, ['worktree', 'add', '-q', '-b', 'feature/unrelated-name', orphan, 'HEAD']);
    const admin = git(orphan, ['rev-parse', '--path-format=absolute', '--git-dir']);
    fs.rmSync(admin, { recursive: true, force: true });
    fs.writeFileSync(
      path.join(orphan, '.git'),
      'gitdir: /workspace/workgroup/ambiguous-proposal/.git/worktrees/no-branch-token\n',
    );
    const orphanCandidate = {
      ...candidate(orphan, f.repo, 'thread-ambiguous'),
      candidateCommonGitDirs: [path.join(f.legacy, '.git')],
    };
    const context = createLegacyGitResolutionContext(orphanCandidate.candidateCommonGitDirs);
    expect(() => captureCheckout(orphanCandidate, context, { preferMetadataSelection: true })).toThrow(
      /reviewed visible-state archive is required instead of exhaustive branch guessing/,
    );
    expect(context.branchStatesByCommonSet.size).toBe(1);
  });

  it('restores a hash-bound reviewed visible state while retaining the already-broken pointer exactly', async () => {
    const f = fixture({ repo: 'reviewed-missing-admin' });
    const orphan = path.join(root, 'legacy', 'reviewed-orphan');
    git(f.legacy, ['worktree', 'add', '-q', '-b', 'feat/reviewed-orphan', orphan, 'HEAD']);
    fs.writeFileSync(path.join(orphan, 'unstaged.txt'), 'reviewed ongoing edit\n');
    fs.writeFileSync(path.join(orphan, 'untracked-recovery.txt'), 'must survive\n');
    const admin = git(orphan, ['rev-parse', '--path-format=absolute', '--git-dir']);
    fs.rmSync(admin, { recursive: true, force: true });
    const pointer = 'gitdir: /workspace/workgroup/reviewed-missing-admin/.git/worktrees/reviewed-orphan\n';
    fs.writeFileSync(path.join(orphan, '.git'), pointer);
    fs.chmodSync(path.join(orphan, '.git'), 0o640);
    const orphanCandidate = {
      ...candidate(orphan, f.repo, 'thread-reviewed-orphan'),
      candidateCommonGitDirs: [path.join(f.legacy, '.git')],
    };
    const diagnostic = captureCheckout(orphanCandidate);
    expect(diagnostic.head).not.toBeNull();
    expect(diagnostic.branch).toBe('feat/reviewed-orphan');
    expect(diagnostic.gitPointer).toBeDefined();
    const decision: ReviewedCheckoutRecoveryDecision = {
      checkoutPath: orphan,
      workgroupId: 'wg-a',
      repo: f.repo,
      action: 'restore-visible-state',
      selection: 'synthesized-visible-state',
      selectedCommonGitDir: diagnostic.commonGitDir,
      selectedHead: diagnostic.head!,
      selectedBranch: diagnostic.branch!,
      gitPointerSha256: diagnostic.gitPointer!.sha256,
      visibleStateSha256: missingAdminVisibleStateSha256(diagnostic),
    };
    expect(
      createReviewedMissingAdminRecoveryProposal({
        candidate: orphanCandidate,
        selectedCommonGitDir: diagnostic.commonGitDir,
        selectedHead: diagnostic.head!,
        selectedBranch: diagnostic.branch!,
        action: 'restore-visible-state',
      }),
    ).toEqual(decision);
    expect(() =>
      manifestFor([candidate(f.legacy, f.repo), orphanCandidate], f.remote, f.repo, undefined, [
        { ...decision, visibleStateSha256: '0'.repeat(64) },
      ]),
    ).toThrow(/visible state is stale/);

    const manifest = manifestFor([candidate(f.legacy, f.repo), orphanCandidate], f.remote, f.repo, undefined, [
      decision,
    ]);
    const recovered = manifest.captures.find((capture) => capture.checkoutPath === orphan)!;
    expect(recovered.reviewedRecovery).toMatchObject({
      action: 'restore-visible-state',
      selection: 'synthesized-visible-state',
    });
    expect(recovered.indexBytesBase64).not.toBeNull();
    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);
    expect(fs.readFileSync(path.join(recovered.destinationPath!, 'unstaged.txt'), 'utf8')).toBe(
      'reviewed ongoing edit\n',
    );
    expect(fs.readFileSync(path.join(recovered.destinationPath!, 'untracked-recovery.txt'), 'utf8')).toBe(
      'must survive\n',
    );
    expect(fs.readFileSync(path.join(recovered.renamedOldPath!, '.git'), 'utf8')).toBe(pointer);
    expect(fs.lstatSync(path.join(recovered.renamedOldPath!, '.git')).mode & 0o7777).toBe(0o640);
  });

  it('selects one exact surviving Git admin and raw index when collided metadata is ambiguous', async () => {
    const f = fixture({ repo: 'reviewed-ambiguous-admin' });
    const collided = path.join(root, 'legacy', 'ambiguous-checkout');
    git(f.legacy, ['worktree', 'add', '-q', '-b', 'feat/exact-admin', collided, 'HEAD']);
    fs.writeFileSync(path.join(collided, 'exact-admin.txt'), 'ongoing exact index state\n');
    git(collided, ['add', 'exact-admin.txt']);
    const selectedGitDir = git(collided, ['rev-parse', '--path-format=absolute', '--git-dir']);
    const commonGitDir = git(collided, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const duplicateAdmin = path.join(commonGitDir, 'worktrees', 'ambiguous-duplicate');
    fs.cpSync(selectedGitDir, duplicateAdmin, { recursive: true, dereference: false });
    fs.writeFileSync(path.join(duplicateAdmin, 'gitdir'), `${path.join(collided, '.git')}\n`);
    const collidedCandidate: LegacyCheckoutCandidate = {
      ...candidate(collided, f.repo, 'thread-exact-admin'),
      candidateCommonGitDirs: [commonGitDir],
    };
    expect(() => captureCheckout(collidedCandidate)).toThrow(/ambiguous Git admin directories/);
    const decision = createReviewedExactGitAdminRecoveryProposal({
      candidate: collidedCandidate,
      selectedGitDir,
      action: 'restore-visible-state',
    });
    expect(decision).toMatchObject({
      selection: 'exact-git-admin',
      selectedGitDir,
      selectedCommonGitDir: commonGitDir,
      selectedBranch: 'feat/exact-admin',
      action: 'restore-visible-state',
    });
    expect(decision.selectedIndexSha256).toMatch(/^[a-f0-9]{64}$/);
    const manifest = manifestFor([candidate(f.legacy, f.repo), collidedCandidate], f.remote, f.repo, undefined, [
      decision,
    ]);
    const captured = manifest.captures.find((entry) => entry.checkoutPath === collided)!;
    expect(captured.gitDir).toBe(selectedGitDir);
    expect(captured.indexSha256).toBe(decision.selectedIndexSha256);
    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);
    expect(fs.readFileSync(path.join(captured.destinationPath!, 'exact-admin.txt'), 'utf8')).toBe(
      'ongoing exact index state\n',
    );
  });

  it('archives an unborn standalone checkout only through an exact hash-bound Git-admin decision', async () => {
    const f = fixture({ repo: 'reviewed-unborn-archive' });
    const unborn = path.join(root, 'legacy', 'reviewed-unborn');
    fs.mkdirSync(unborn, { recursive: true });
    git(unborn, ['init', '-q', '-b', 'draft-unborn']);
    fs.writeFileSync(path.join(unborn, 'ongoing.sql'), 'select 1;\n');
    const unmapped: LegacyCheckoutCandidate = {
      ...candidate(unborn, f.repo),
      workUnit: {
        workgroupId: 'wg-a',
        kind: 'session',
        key: 'session:legacy:unmapped',
        id: 'legacy-unmapped',
      },
    };
    const decision = createReviewedExactGitAdminRecoveryProposal({
      candidate: unmapped,
      selectedGitDir: path.join(unborn, '.git'),
      action: 'archive-visible-state',
    });
    const supplementalSeedGitDir = path.join(f.legacy, '.git');
    process.env.NANOCLAW_REPOSITORY_RECOVERY_SEED_ROOT = root;
    const supplementedDecision: ReviewedCheckoutRecoveryDecision = {
      ...decision,
      supplementalSeedGitDir,
      supplementalSeedGitDirSha256: recoverySeedGitDirSha256(supplementalSeedGitDir),
    };
    expect(decision).toMatchObject({
      selection: 'exact-git-admin',
      selectedHead: null,
      selectedBranch: 'draft-unborn',
      selectedIndexSha256: null,
      action: 'archive-visible-state',
    });
    expect(() =>
      manifestFor([unmapped], f.remote, f.repo, undefined, [
        { ...supplementedDecision, visibleStateSha256: '0'.repeat(64) },
      ]),
    ).toThrow(/visible state is stale/);
    const manifest = manifestFor([unmapped], f.remote, f.repo, undefined, [supplementedDecision]);
    expect(manifest.captures[0].archivedLegacy).toEqual({ reason: 'operator-reviewed-checkout' });
    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);
    expect(manifest.captures[0].destinationPath).toBeUndefined();
    expect(fs.readFileSync(path.join(manifest.captures[0].renamedOldPath!, 'ongoing.sql'), 'utf8')).toBe('select 1;\n');
  });

  it('preserves a retired repository without publishing an active canonical, pin, or worktree', async () => {
    const repo = 'retired-backend';
    const legacy = path.join(root, 'legacy', repo);
    fs.mkdirSync(legacy, { recursive: true });
    git(legacy, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(legacy, 'ongoing.sql'), 'select current_work;\n');
    git(legacy, ['add', '-A']);
    git(legacy, ['commit', '-q', '-m', 'preserved historical state']);
    fs.writeFileSync(path.join(legacy, 'untracked.md'), 'historical untracked work\n');
    const retiredCandidate: LegacyCheckoutCandidate = {
      ...candidate(legacy, repo),
      workUnit: {
        workgroupId: 'wg-a',
        kind: 'session',
        key: 'session:legacy:retired-backend',
        id: 'legacy-retired-backend',
      },
    };
    const decision = createReviewedExactGitAdminRecoveryProposal({
      candidate: retiredCandidate,
      selectedGitDir: path.join(legacy, '.git'),
      action: 'archive-visible-state',
    });
    const manifest = createRepositoryMigrationManifest({
      dataDir,
      workgroupId: 'wg-a',
      repo,
      origin: null,
      archiveOnly: true,
      repositoryId: `local-only:${repo}`,
      candidates: [retiredCandidate],
      recoveryDecisions: [decision],
      availableBytes: 10 * 1024 * 1024 * 1024,
    });
    expect(manifest.archiveOnly).toBe(true);

    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);

    const activeCanonical = canonicalRepoDir('wg-a', repo, dataDir);
    const preservedRepository = path.join(
      dataDir,
      'repository-migrations',
      manifest.runId,
      'wg-a',
      repo,
      'preserved-repository',
    );
    expect(fs.existsSync(activeCanonical)).toBe(false);
    expect(readOriginPin('wg-a', repo, dataDir)).toBeNull();
    expect(fs.lstatSync(path.join(preservedRepository, '.git')).isDirectory()).toBe(true);
    expect(manifest.captures[0].destinationPath).toBeUndefined();
    expect(fs.readFileSync(path.join(manifest.captures[0].renamedOldPath!, 'untracked.md'), 'utf8')).toBe(
      'historical untracked work\n',
    );

    await rollbackRepositoryMigration(manifest);
    expect(fs.existsSync(activeCanonical)).toBe(false);
    expect(fs.existsSync(preservedRepository)).toBe(false);
    expect(fs.readFileSync(path.join(legacy, 'untracked.md'), 'utf8')).toBe('historical untracked work\n');
  });

  it('preserves an unborn branch with an empty index and untracked files', async () => {
    const f = fixture();
    const unborn = path.join(root, 'legacy', 'unborn');
    fs.mkdirSync(unborn, { recursive: true });
    git(unborn, ['init', '-q', '-b', 'unborn-work']);
    git(unborn, ['remote', 'add', 'origin', f.remote]);
    fs.writeFileSync(path.join(unborn, 'untracked-only.txt'), 'must survive\n');
    const unbornCandidate = candidate(unborn, f.repo, 'thread-unborn');
    const before = captureCheckout(unbornCandidate);
    expect(before.head).toBeNull();
    expect(Buffer.from(before.statusZBase64, 'base64').length).toBeGreaterThan(0);
    const manifest = manifestFor([candidate(f.legacy), unbornCandidate], f.remote);
    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);
    const migrated = manifest.captures.find((capture) => capture.workUnit.key.includes('thread-unborn'))!;
    expect(migrated.head).toBeNull();
    expect(fs.readFileSync(path.join(migrated.destinationPath!, 'untracked-only.txt'), 'utf8')).toBe('must survive\n');
  });

  it('imports mirror-only refs and retires the bare mirror without deleting it', async () => {
    const f = fixture();
    const mirror = path.join(root, 'legacy', '.repos', `${f.repo}.git`);
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    execFileSync('git', ['clone', '-q', '--bare', f.seed, mirror]);
    fs.writeFileSync(path.join(f.seed, 'mirror-only.txt'), 'only in mirror\n');
    git(f.seed, ['add', '-A']);
    git(f.seed, ['commit', '-q', '-m', 'mirror only']);
    const mirrorOnly = git(f.seed, ['rev-parse', 'HEAD']);
    git(f.seed, ['push', '-q', mirror, 'HEAD:refs/heads/mirror-only']);
    const manifest = createRepositoryMigrationManifest({
      dataDir,
      workgroupId: 'wg-a',
      repo: f.repo,
      origin: f.remote,
      repositoryId: 'local:project',
      candidates: [candidate(f.legacy)],
      objectStores: [mirror],
      availableBytes: 10 * 1024 * 1024 * 1024,
    });
    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    const canonical = canonicalRepoDir('wg-a', f.repo, dataDir);
    expect(
      git(canonical, ['for-each-ref', '--format=%(refname)', '--contains', mirrorOnly, 'refs/nanoclaw-legacy']),
    ).not.toBe('');
    expect(fs.existsSync(mirror)).toBe(false);
    expect(fs.existsSync(manifest.renamedObjectStores![mirror])).toBe(true);
  });

  it('publishes a canonical from a bare-only legacy repository with no checkout', async () => {
    const f = fixture({ repo: 'bare-only' });
    const mirror = path.join(root, 'legacy', '.repos', `${f.repo}.git`);
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    execFileSync('git', ['clone', '-q', '--bare', f.seed, mirror]);
    const manifest = createRepositoryMigrationManifest({
      dataDir,
      workgroupId: 'wg-a',
      repo: f.repo,
      origin: f.remote,
      repositoryId: 'local:bare-only',
      candidates: [],
      objectStores: [mirror],
      availableBytes: 10 * 1024 * 1024 * 1024,
    });
    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    auditRepositoryMigration(manifest);
    expect(fs.lstatSync(path.join(canonicalRepoDir('wg-a', f.repo, dataDir), '.git')).isDirectory()).toBe(true);
    expect(fs.existsSync(mirror)).toBe(false);
    expect(fs.existsSync(manifest.renamedObjectStores![mirror])).toBe(true);
  });

  it('capacity-gate-rejects-before-mutation', () => {
    const f = fixture({ dirty: true });
    expect(() =>
      createRepositoryMigrationManifest({
        dataDir,
        workgroupId: 'wg-a',
        repo: f.repo,
        origin: f.remote,
        repositoryId: 'local:project',
        candidates: [candidate(f.legacy)],
        availableBytes: 0,
      }),
    ).toThrow('capacity gate rejected before mutation');
    expect(git(f.legacy, ['for-each-ref', '--format=%(refname)', 'refs/nanoclaw-rescue'])).toBe('');
    expect(fs.existsSync(path.join(dataDir, 'repository-migrations'))).toBe(false);
  });

  it('never removes a pre-existing canonical when migration preflight rejects the destination', async () => {
    const f = fixture({ repo: 'preexisting' });
    const canonical = canonicalRepoDir('wg-a', f.repo, dataDir);
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    execFileSync('git', ['clone', '-q', f.remote, canonical]);
    const beforeHead = git(canonical, ['rev-parse', 'HEAD']);
    const manifest = manifestFor([candidate(f.legacy, f.repo)], f.remote, f.repo);

    await expect(executeRepositoryMigration(manifest, { assertQuiescent: () => undefined })).rejects.toThrow(
      /canonical destination already exists/,
    );

    expect(fs.existsSync(canonical)).toBe(true);
    expect(git(canonical, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(git(canonical, ['status', '--porcelain'])).toBe('');
  });

  it('migration-resumes-or-rolls-back-at-every-durable-boundary', async () => {
    const phases: MigrationPhase[] = [
      'manifested',
      'rescued',
      'canonical-target-clear',
      'canonical-published',
      'bundle-written',
      'old-renamed',
      'worktrees-restored',
      'audited',
    ];
    for (const phase of phases) {
      const f = fixture({ dirty: true, repo: `repo-${phase}` });
      const manifest = manifestFor([candidate(f.legacy, f.repo)], f.remote, f.repo, `run-${phase}`);
      process.env.NANOCLAW_MIGRATION_FAIL_AFTER = phase;
      await expect(executeRepositoryMigration(manifest, { assertQuiescent: () => undefined })).rejects.toThrow(
        `injected failure after ${phase}`,
      );
      expect(fs.existsSync(f.legacy)).toBe(true);
      expect(fs.existsSync(canonicalRepoDir('wg-a', f.repo, dataDir))).toBe(false);

      delete process.env.NANOCLAW_MIGRATION_FAIL_AFTER;
      const resumed = JSON.parse(fs.readFileSync(manifestPath(manifest), 'utf8')) as typeof manifest;
      await executeRepositoryMigration(resumed, { assertQuiescent: () => undefined });
      auditRepositoryMigration(resumed);
    }
  }, 180_000);

  it.each<MigrationPhase>([
    'manifested',
    'rescued',
    'canonical-target-clear',
    'canonical-published',
    'bundle-written',
    'old-renamed',
    'worktrees-restored',
    'audited',
  ])(
    'resumes after true process death at durable boundary %s',
    async (phase) => {
      const f = fixture({ dirty: true, repo: `crash-${phase}` });
      const manifest = manifestFor([candidate(f.legacy, f.repo)], f.remote, f.repo, `crash-run-${phase}`);
      const input = path.join(root, `crash-input-${phase}.json`);
      fs.writeFileSync(input, JSON.stringify(manifest));
      const child = [
        "import fs from 'fs';",
        "import { executeRepositoryMigration } from './src/repository-migration.ts';",
        '(async () => {',
        "  const manifest = JSON.parse(fs.readFileSync(process.env.MIGRATION_INPUT!, 'utf8'));",
        '  await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });',
        '})().catch((error) => { console.error(error); process.exit(1); });',
      ].join('\n');
      let status: number | undefined;
      try {
        execFileSync('pnpm', ['exec', 'tsx', '-e', child], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            MIGRATION_INPUT: input,
            NANOCLAW_REPOSITORY_ALLOW_LOCAL_ORIGIN: '1',
            NANOCLAW_MIGRATION_CRASH_AFTER: phase,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 120_000,
        });
      } catch (error) {
        status = (error as NodeJS.ErrnoException & { status?: number }).status;
      }
      expect(status).toBe(86);

      const resumed = JSON.parse(fs.readFileSync(manifestPath(manifest), 'utf8')) as typeof manifest;
      await executeRepositoryMigration(resumed, { assertQuiescent: () => undefined });
      auditRepositoryMigration(resumed);
    },
    180_000,
  );

  it('restores the original topology on explicit rollback after a successful audit', async () => {
    const f = fixture({ dirty: true });
    const manifest = manifestFor([candidate(f.legacy)], f.remote);
    const before = manifest.captures[0];
    await executeRepositoryMigration(manifest, { assertQuiescent: () => undefined });
    await rollbackRepositoryMigration(manifest);
    expect(fs.existsSync(f.legacy)).toBe(true);
    expect(captureCheckout(candidate(f.legacy))).toMatchObject({
      head: before.head,
      statusZBase64: before.statusZBase64,
      files: before.files,
    });
    expect(fs.existsSync(canonicalRepoDir('wg-a', f.repo, dataDir))).toBe(false);
  });
});
