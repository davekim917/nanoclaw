import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadReviewedRecoveryDecisions,
  observedOriginsSha256,
  selectReviewedOrigin,
} from './repository-migration-recovery.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-recovery-'));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeRecovery(value: unknown): string {
  const file = path.join(root, 'recovery.json');
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return file;
}

describe('reviewed repository recovery decisions', () => {
  it('loads strict hash-bound decisions and rejects writable decision files', () => {
    const checkoutPath = path.join(root, 'checkout');
    const common = path.join(root, 'repo', '.git');
    const file = writeRecovery({
      version: 2,
      checkouts: [
        {
          checkoutPath,
          workgroupId: 'wg-a',
          repo: 'dbt',
          action: 'restore-visible-state',
          selection: 'synthesized-visible-state',
          selectedCommonGitDir: common,
          selectedHead: 'a'.repeat(40),
          selectedBranch: 'feature/recovery',
          gitPointerSha256: 'b'.repeat(64),
          visibleStateSha256: 'c'.repeat(64),
        },
      ],
      origins: [
        {
          workgroupId: 'wg-a',
          repo: 'dbt',
          observedOriginsSha256: 'd'.repeat(64),
          selectedOrigin: 'https://github.com/example/dbt',
        },
      ],
    });
    expect(loadReviewedRecoveryDecisions(file)).toMatchObject({
      sourcePath: file,
      checkouts: [{ checkoutPath, action: 'restore-visible-state' }],
      origins: [{ selectedOrigin: 'https://github.com/example/dbt' }],
    });
    fs.chmodSync(file, 0o622);
    expect(() => loadReviewedRecoveryDecisions(file)).toThrow(/group\/world writable/);
  });

  it('loads an exact Git-admin decision bound to a host-only external seed', () => {
    const checkoutPath = path.join(root, 'checkout');
    const common = path.join(root, 'recovery-seeds', 'repo.git');
    const selectedGitDir = path.join(common, 'worktrees', 'checkout');
    const externalSeedGitDirSha256 = 'd'.repeat(64);
    const file = writeRecovery({
      version: 2,
      checkouts: [
        {
          checkoutPath,
          workgroupId: 'wg-a',
          repo: 'xzo',
          action: 'restore-visible-state',
          selection: 'exact-git-admin',
          selectedGitDir,
          selectedCommonGitDir: common,
          selectedHead: 'a'.repeat(40),
          selectedBranch: 'feature/recovery',
          selectedIndexSha256: 'b'.repeat(64),
          gitPointerSha256: 'c'.repeat(64),
          externalSeedGitDirSha256,
          visibleStateSha256: 'e'.repeat(64),
        },
      ],
      origins: [],
    });

    expect(loadReviewedRecoveryDecisions(file)?.checkouts[0]).toMatchObject({
      checkoutPath,
      selection: 'exact-git-admin',
      selectedGitDir,
      selectedCommonGitDir: common,
      externalSeedGitDirSha256,
    });
  });

  it('selects a credential-free reviewed origin only for the exact observed origin set', () => {
    const observed = ['https://github.com/old/repo', 'https://github.com/new/repo'];
    const decision = {
      workgroupId: 'wg-a',
      repo: 'repo',
      observedOriginsSha256: observedOriginsSha256(observed),
      selectedOrigin: 'https://github.com/new/repo',
    };
    expect(selectReviewedOrigin({ workgroupId: 'wg-a', repo: 'repo', observedOrigins: observed, decision })).toBe(
      'https://github.com/new/repo',
    );
    expect(() =>
      selectReviewedOrigin({
        workgroupId: 'wg-a',
        repo: 'repo',
        observedOrigins: [...observed, 'https://github.com/third/repo'],
        decision,
      }),
    ).toThrow(/stale/);
    expect(() => selectReviewedOrigin({ workgroupId: 'wg-a', repo: 'repo', observedOrigins: observed })).toThrow(
      /observed set sha256/,
    );
  });

  it('never accepts a credential-bearing selected origin', () => {
    for (const origin of [
      'https://token@github.com/example/repo',
      'https://github.com/example/repo?access_token=QUERY_SYNTHETIC_SECRET',
      'https://github.com/example/repo#FRAGMENT_SYNTHETIC_SECRET',
    ]) {
      expect(() =>
        selectReviewedOrigin({
          workgroupId: 'wg-a',
          repo: 'repo',
          observedOrigins: [origin],
          decision: {
            workgroupId: 'wg-a',
            repo: 'repo',
            observedOriginsSha256: observedOriginsSha256([origin]),
            selectedOrigin: origin,
          },
        }),
      ).toThrow(/credential-free/);
    }
  });

  it('accepts archive-only only as an explicit originless repository decision', () => {
    const file = writeRecovery({
      version: 2,
      checkouts: [],
      origins: [
        {
          workgroupId: 'wg-a',
          repo: 'retired-backend',
          observedOriginsSha256: observedOriginsSha256([null]),
          selectedOrigin: null,
          archiveOnly: true,
        },
      ],
    });
    expect(loadReviewedRecoveryDecisions(file)?.origins[0]).toMatchObject({
      selectedOrigin: null,
      archiveOnly: true,
    });

    fs.writeFileSync(
      file,
      `${JSON.stringify({
        version: 2,
        checkouts: [],
        origins: [
          {
            workgroupId: 'wg-a',
            repo: 'retired-backend',
            observedOriginsSha256: observedOriginsSha256(['https://github.com/example/repo']),
            selectedOrigin: 'https://github.com/example/repo',
            archiveOnly: true,
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    expect(() => loadReviewedRecoveryDecisions(file)).toThrow(/archiveOnly requires selectedOrigin null/);
  });

  it('loads strict reviewed repository aliases and rejects unsafe or duplicate sources', () => {
    const file = writeRecovery({
      version: 2,
      checkouts: [],
      origins: [],
      repositoryAliases: [{ workgroupId: 'illysium', sourceRepo: 'XZO-BACKEND', destinationRepo: 'XZO' }],
    });
    expect(loadReviewedRecoveryDecisions(file)?.repositoryAliases).toEqual([
      { workgroupId: 'illysium', sourceRepo: 'XZO-BACKEND', destinationRepo: 'XZO' },
    ]);

    for (const repositoryAliases of [
      [{ workgroupId: 'illysium', sourceRepo: '../XZO-BACKEND', destinationRepo: 'XZO' }],
      [
        { workgroupId: 'illysium', sourceRepo: 'XZO-BACKEND', destinationRepo: 'XZO' },
        { workgroupId: 'illysium', sourceRepo: 'XZO-BACKEND', destinationRepo: 'OTHER' },
      ],
    ]) {
      fs.writeFileSync(file, `${JSON.stringify({ version: 2, checkouts: [], origins: [], repositoryAliases })}\n`, {
        mode: 0o600,
      });
      expect(() => loadReviewedRecoveryDecisions(file)).toThrow(/safe sourceRepo|duplicate reviewed repository alias/);
    }
  });
});
