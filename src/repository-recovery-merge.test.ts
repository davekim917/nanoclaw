import type {
  LoadedReviewedRecoveryDecisions,
  ReviewedCheckoutRecoveryDecision,
  ReviewedOriginSelection,
} from './repository-migration-recovery.js';
import { describe, expect, it } from 'vitest';

import { mergeReviewedRecoveryDecisions } from './repository-recovery-merge.js';

function checkout(
  checkoutPath: string,
  action: 'restore-visible-state' | 'archive-visible-state',
): ReviewedCheckoutRecoveryDecision {
  return {
    checkoutPath,
    workgroupId: 'wg',
    repo: 'repo',
    action,
    selection: 'exact-git-admin',
    selectedGitDir: `${checkoutPath}/.git`,
    selectedCommonGitDir: `${checkoutPath}/.git`,
    selectedHead: null,
    selectedBranch: null,
    selectedIndexSha256: null,
    visibleStateSha256: 'a'.repeat(64),
  };
}

function origin(repo: string, selectedOrigin: string | null): ReviewedOriginSelection {
  return {
    workgroupId: 'wg',
    repo,
    observedOriginsSha256: 'b'.repeat(64),
    selectedOrigin,
  };
}

function source(
  name: string,
  checkouts: ReviewedCheckoutRecoveryDecision[],
  origins: ReviewedOriginSelection[] = [],
): LoadedReviewedRecoveryDecisions {
  return {
    sourcePath: `/tmp/${name}.json`,
    sha256: 'c'.repeat(64),
    checkouts,
    origins,
    repositoryAliases: [],
  };
}

describe('reviewed repository recovery decision merging', () => {
  it('requires an explicit override for conflicting base decisions', () => {
    expect(() =>
      mergeReviewedRecoveryDecisions({
        bases: [
          source('one', [checkout('/tmp/repo', 'restore-visible-state')]),
          source('two', [checkout('/tmp/repo', 'archive-visible-state')]),
        ],
        overrides: [],
      }),
    ).toThrow(/conflicting base recovery decisions/);
  });

  it('uses a single explicit override for a checkout and origin', () => {
    const replacement = checkout('/tmp/repo', 'archive-visible-state');
    const result = mergeReviewedRecoveryDecisions({
      bases: [source('base', [checkout('/tmp/repo', 'restore-visible-state')], [origin('repo', null)])],
      overrides: [source('override', [replacement], [origin('repo', 'https://github.com/example/repo')])],
    });
    expect(result.checkouts).toEqual([replacement]);
    expect(result.origins).toEqual([origin('repo', 'https://github.com/example/repo')]);
  });

  it('rejects duplicate overrides even when their values match', () => {
    const replacement = checkout('/tmp/repo', 'archive-visible-state');
    expect(() =>
      mergeReviewedRecoveryDecisions({
        bases: [],
        overrides: [source('one', [replacement]), source('two', [replacement])],
      }),
    ).toThrow(/duplicate checkout override/);
  });

  it('preserves reviewed repository aliases in merged ledgers', () => {
    const alias = { workgroupId: 'wg', sourceRepo: 'legacy-backend', destinationRepo: 'repo' };
    const base = source('base', []);
    base.repositoryAliases = [alias];
    expect(mergeReviewedRecoveryDecisions({ bases: [base], overrides: [] }).repositoryAliases).toEqual([alias]);
  });
});
