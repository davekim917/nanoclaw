import { execFileSync } from 'node:child_process';
import * as nodeChildProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  allowSubprocess,
  clearHermeticityAttempts,
  enforceHermeticity,
  hermeticityAttempts,
} from '../src/test-hermeticity.js';

import {
  buildShadowReviewIndex,
  classifyAtMergeVerdict,
  combineMergedPrSlices,
  computeFetchSinceIso,
  computeMergedSearchSlices,
  computeReport,
  computeShadowCoverage,
  computeWeeklyFetchSinceIso,
  computeWeeklyReport,
  extractFixesPrNumber,
  extractFixesPrNumbers,
  extractShadowReviewPrNumber,
  fetchAtMergeLabelEventsBatch,
  fileDiffAtMergeLocal,
  filesOverlap,
  findConventionStartIso,
  findFollowUp,
  findRevert,
  FIXES_PR_CONVENTION_START_ISO,
  formatWindowAgeNote,
  formatWeeklyWindowLine,
  GATE_GO_LIVE_ISO,
  generatedFileChangedLines,
  globsForRiskHigh,
  hasFixesPrLine,
  isEligibleForShadowReview,
  isFixTitle,
  isLowRisk,
  isoWeekDateRange,
  isoWeekKey,
  isSkipVerdict,
  issueHasP1,
  isRevertOf,
  isRevertPR,
  matchesAnyGlob,
  mergeCommitParentsLocal,
  parseGitNameStatus,
  printWeeklyReport,
  readRiskHighGlobsAtShaLocal,
  replayLabelsAtMerge,
  renderWeeklyMarkdown,
  resolveAtMergeBaseSha,
  resolveAtMergeFileContextLocal,
  resolveMainTipUntilIso,
  SHADOW_REVIEW_GO_LIVE_ISO,
  WINDOW_AGE_NOTE_THRESHOLD_MS,
  stripFencedAndCommented,
  UNTIL_ISO_SEARCH_INDEX_LAG_MARGIN_MS,
  verifyMergedPrTotalCount,
  type MainTipInfo,
  type Options,
  type PullRequestData,
  type ShadowReviewIssueData,
  type WeeklyWindowInfo,
  weeklyRevertRate,
} from './review-outcomes.js';

// This suite never touches the network — every case here exercises pure functions, or
// (the "at-merge replay from local git" describe block near the end) a real `git`
// against a throwaway fixture repo under the OS temp dir. `git` is the only subprocess
// allowed; `gh` stays blocked, which the GraphQL-failure test below relies on directly.
enforceHermeticity();
allowSubprocess(['git']);

function testMainTip(overrides: Partial<MainTipInfo> = {}): MainTipInfo {
  return { shortSha: 'abc1234', tipIso: '2026-09-12T00:00:00Z', ...overrides };
}

function testWindow(overrides: Partial<WeeklyWindowInfo> = {}): WeeklyWindowInfo {
  return {
    sinceIso: '2026-08-01T00:00:00Z',
    untilIso: '2026-09-12T00:00:00Z',
    tip: testMainTip(),
    ...overrides,
  };
}

function pr(overrides: Partial<PullRequestData> & { number: number }): PullRequestData {
  return {
    title: `pr #${overrides.number}`,
    body: '',
    mergedAt: '2026-09-01T00:00:00Z',
    files: [],
    labels: [],
    baseRefName: 'main',
    changedLines: 0,
    changedFiles: overrides.files?.length ?? 0,
    mergeCommitOid: null,
    headRefOid: 'deadbeef',
    ...overrides,
  };
}

describe('globsForRiskHigh', () => {
  const rule = (globs: unknown) => [{ 'changed-files': [{ 'any-glob-to-any-file': globs }] }];

  it('reads a glob list under risk:high', () => {
    expect(globsForRiskHigh({ 'risk:high': rule(['src/guard/**', 'src/router.ts']) })).toEqual([
      'src/guard/**',
      'src/router.ts',
    ]);
  });

  it('reads a bare string as one glob', () => {
    expect(globsForRiskHigh({ 'risk:high': rule('docs/**') })).toEqual(['docs/**']);
  });

  it('throws on a missing risk:high key', () => {
    expect(() => globsForRiskHigh({})).toThrow(/must be exactly/);
  });

  it('throws on a shape the labeler ANDs across two rules', () => {
    expect(() => globsForRiskHigh({ 'risk:high': [...rule(['a']), ...rule(['b'])] })).toThrow(/must be exactly/);
  });
});

describe('matchesAnyGlob / isLowRisk', () => {
  const RISK_GLOBS = ['src/guard/**', 'src/router.ts', '.github/**', 'src/**/*guard*.ts', 'src/db/migrations/**'];

  it('matches a file under a directory glob', () => {
    expect(matchesAnyGlob('src/guard/index.ts', RISK_GLOBS)).toBe(true);
  });

  it('matches an exact-path glob', () => {
    expect(matchesAnyGlob('src/router.ts', RISK_GLOBS)).toBe(true);
  });

  it('matches a dotdir glob literally, not via wildcard dot handling', () => {
    expect(matchesAnyGlob('.github/workflows/ci.yml', RISK_GLOBS)).toBe(true);
  });

  it('matches a *guard* filename at depth', () => {
    expect(matchesAnyGlob('src/modules/self-mod/guard.ts', RISK_GLOBS)).toBe(true);
  });

  it('does not match an unrelated file', () => {
    expect(matchesAnyGlob('docs/readme.md', RISK_GLOBS)).toBe(false);
  });

  it('isLowRisk is true only when no file matches', () => {
    expect(isLowRisk(['docs/readme.md', 'scripts/foo.ts'], RISK_GLOBS)).toBe(true);
    expect(isLowRisk(['docs/readme.md', 'src/router.ts'], RISK_GLOBS)).toBe(false);
  });

  it('isLowRisk is vacuously true for a PR touching no files', () => {
    expect(isLowRisk([], RISK_GLOBS)).toBe(true);
  });
});

describe('isFixTitle / extractFixesPrNumber', () => {
  it('matches conventional fix titles, case-insensitively', () => {
    expect(isFixTitle('fix(runner): foo')).toBe(true);
    expect(isFixTitle('Fix: bar')).toBe(true);
    expect(isFixTitle('fix!: breaking')).toBe(true);
    expect(isFixTitle('feat(x): not a fix')).toBe(false);
  });

  it('extracts the number from a Fixes-PR line', () => {
    expect(extractFixesPrNumber('body text\nFixes-PR: #605\nmore text')).toBe(605);
  });

  it('is case-insensitive on the line and the value', () => {
    expect(extractFixesPrNumber('fixes-pr: #12')).toBe(12);
  });

  it('returns null for Fixes-PR: none', () => {
    expect(extractFixesPrNumber('Fixes-PR: none')).toBeNull();
  });

  it('returns null when the line is absent', () => {
    expect(extractFixesPrNumber('nothing here')).toBeNull();
  });

  // Real body from davekim917/nanoclaw #642.
  it('matches a real Fixes-PR trailer', () => {
    const body = 'some text\n\nFixes-PR: #605\n\nhttps://claude.ai/code/session_x\n';
    expect(extractFixesPrNumber(body)).toBe(605);
  });
});

describe('filesOverlap', () => {
  it('is true when any file is shared', () => {
    expect(filesOverlap(['a.ts', 'b.ts'], ['b.ts', 'c.ts'])).toBe(true);
  });

  it('is false with no shared files', () => {
    expect(filesOverlap(['a.ts'], ['b.ts'])).toBe(false);
  });

  it.each(['src/upstream-ratchet.json', 'pnpm-lock.yaml', 'container/agent-runner/bun.lock'])(
    'ignores %s, which tools regenerate as a side effect',
    (generated) => {
      expect(filesOverlap(['a.ts', generated], ['b.ts', generated])).toBe(false);
      expect(filesOverlap(['a.ts', generated], ['a.ts', generated])).toBe(true);
    },
  );

  it('is false when either side is empty', () => {
    expect(filesOverlap([], ['a.ts'])).toBe(false);
    expect(filesOverlap(['a.ts'], [])).toBe(false);
  });
});

describe('isRevertOf / isRevertPR', () => {
  const target = pr({ number: 608, title: 'runner: end a task stream after its result' });

  it('matches a GitHub-template revert title', () => {
    const candidate = pr({ number: 610, title: 'Revert "runner: end a task stream after its result"' });
    expect(isRevertOf(candidate, target)).toBe(true);
  });

  // Real case: davekim917/nanoclaw #610 reverting #608 — title is the repo's own
  // conventional-commit form, not GitHub's `Revert "..."` template.
  it("matches this repo's real revert-title convention", () => {
    const candidate = pr({
      number: 610,
      title: 'revert(runner): back out ending a task stream after its result (#608)',
    });
    expect(isRevertOf(candidate, target)).toBe(true);
  });

  it('matches via a body line naming the PR, without a matching title', () => {
    const candidate = pr({ number: 611, title: 'chore: cleanup', body: 'Reverts #608 because it broke prod.' });
    expect(isRevertOf(candidate, target)).toBe(true);
  });

  // Real body text from #610: "This reverts #608 (merge `6b56f8a26`) ..."
  it('matches "This reverts #N" with text after the number reference', () => {
    const candidate = pr({
      number: 610,
      title: 'chore: rollback',
      body: 'This reverts #608 (merge `6b56f8a26`), which was never deployed.',
    });
    expect(isRevertOf(candidate, target)).toBe(true);
  });

  it('matches GitHub\'s default "This reverts pull request #N." body', () => {
    const candidate = pr({ number: 610, title: 'Revert "something else"', body: 'This reverts pull request #608.' });
    expect(isRevertOf(candidate, target)).toBe(true);
  });

  it('does not match a revert of a different PR number', () => {
    const candidate = pr({ number: 611, title: 'revert(x): back out #999', body: 'Reverts #999' });
    expect(isRevertOf(candidate, target)).toBe(false);
  });

  it('does not match an unrelated PR', () => {
    const candidate = pr({ number: 611, title: 'feat: add a thing', body: 'no relation' });
    expect(isRevertOf(candidate, target)).toBe(false);
  });

  it('isRevertPR is true for any revert-shaped PR, with no target', () => {
    expect(isRevertPR(pr({ number: 610, title: 'revert(runner): back out #608' }))).toBe(true);
    expect(isRevertPR(pr({ number: 611, title: 'chore: cleanup', body: 'This reverts pull request #608.' }))).toBe(
      true,
    );
    expect(isRevertPR(pr({ number: 612, title: 'feat: add a thing' }))).toBe(false);
  });
});

describe('findFollowUp', () => {
  const candidate = pr({ number: 500, files: ['src/a.ts', 'src/b.ts'] });

  it('prefers a Fixes-PR link over an overlapping fix title', () => {
    const linked = pr({ number: 501, body: 'Fixes-PR: #500', files: [] });
    const overlap = pr({ number: 502, title: 'fix: patch a', files: ['src/a.ts'] });
    expect(findFollowUp(candidate, [overlap, linked])).toEqual({ kind: 'link', prNumber: 501 });
  });

  it('falls back to file overlap when no link exists', () => {
    const overlap = pr({ number: 502, title: 'fix: patch a', files: ['src/a.ts', 'src/z.ts'] });
    expect(findFollowUp(candidate, [overlap])).toEqual({ kind: 'overlap', prNumber: 502 });
  });

  it('requires a fix title for the overlap fallback, not just shared files', () => {
    const notAFix = pr({ number: 502, title: 'feat: extend a', files: ['src/a.ts'] });
    expect(findFollowUp(candidate, [notAFix])).toEqual({ kind: 'none', prNumber: null });
  });

  it('requires shared files for the overlap fallback, not just a fix title', () => {
    const unrelatedFix = pr({ number: 502, title: 'fix: patch something else', files: ['src/z.ts'] });
    expect(findFollowUp(candidate, [unrelatedFix])).toEqual({ kind: 'none', prNumber: null });
  });

  it('returns none when nothing matches', () => {
    expect(findFollowUp(candidate, [])).toEqual({ kind: 'none', prNumber: null });
  });
});

describe('findRevert', () => {
  it('finds a revert PR among later PRs', () => {
    const target = pr({ number: 608 });
    const later = [pr({ number: 609, title: 'feat: unrelated' }), pr({ number: 610, title: 'revert: back out #608' })];
    expect(findRevert(target, later)).toBe(610);
  });

  it('returns null when nothing reverts it', () => {
    const target = pr({ number: 608 });
    expect(findRevert(target, [pr({ number: 609, title: 'feat: unrelated' })])).toBeNull();
  });
});

function shadowReviewIssue(overrides: Partial<ShadowReviewIssueData> & { number: number }): ShadowReviewIssueData {
  return { title: `shadow review: #${overrides.number} some title`, body: '', ...overrides };
}

describe('extractShadowReviewPrNumber', () => {
  it('reads the PR number from the workflow-authored title', () => {
    expect(extractShadowReviewPrNumber('shadow review: #643 fix(x): y')).toBe(643);
  });

  it('is case-insensitive on the prefix', () => {
    expect(extractShadowReviewPrNumber('Shadow Review: #12 z')).toBe(12);
  });

  it('returns null for a title that is not a shadow-review issue', () => {
    expect(extractShadowReviewPrNumber('some other issue')).toBeNull();
  });
});

describe('issueHasP1', () => {
  it('matches a P1-labeled finding line', () => {
    expect(issueHasP1('- **P1** — src/guard/x.ts:12 — auth bypass')).toBe(true);
  });

  it('matches a P1 line that is not the first line of the body', () => {
    const body = 'Post-merge advisory review.\n\n- **P2** — a.ts:1 — cosmetic\n- **P1** — b.ts:2 — auth bypass';
    expect(issueHasP1(body)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(issueHasP1('- **p1** — src/x.ts:1 — foo')).toBe(true);
  });

  it('is false when only P2 findings are present', () => {
    expect(issueHasP1('- **P2** — src/x.ts:1 — cosmetic')).toBe(false);
  });

  // The regex is anchored to the bullet's start ("- **P1**"), not a bare "P1" anywhere
  // in the text, precisely so a P2 finding that merely mentions "P1" in its free-text
  // description isn't miscounted as a P1.
  it('does not count a P2 finding whose description mentions "P1"', () => {
    const body = '- **P2** — src/x.ts:1 — cosmetic, similar to the P1 finding fixed in #642';
    expect(issueHasP1(body)).toBe(false);
  });

  it('does not match a look-alike severity like "P10"', () => {
    expect(issueHasP1('- **P10** — src/x.ts:1 — not a real severity')).toBe(false);
  });

  it('is false on an empty body', () => {
    expect(issueHasP1('')).toBe(false);
  });
});

describe('buildShadowReviewIndex', () => {
  it('maps a PR number to hasP1 from its issue', () => {
    const index = buildShadowReviewIndex([
      shadowReviewIssue({ number: 643, body: '- **P1** — a.ts:1 — bad' }),
      shadowReviewIssue({ number: 653, body: '- **P2** — b.ts:1 — minor' }),
    ]);
    expect(index.get(643)).toEqual({ hasP1: true });
    expect(index.get(653)).toEqual({ hasP1: false });
    expect(index.has(652)).toBe(false);
  });

  it('ignores issues whose title is not a shadow-review title', () => {
    const index = buildShadowReviewIndex([shadowReviewIssue({ number: 1, title: 'unrelated issue' })]);
    expect(index.size).toBe(0);
  });

  it('ORs hasP1 across duplicate issues for the same PR', () => {
    const index = buildShadowReviewIndex([
      shadowReviewIssue({ number: 1, body: '- **P2** — a.ts:1 — minor' }),
      shadowReviewIssue({ number: 1, body: '- **P1** — b.ts:2 — bad' }),
    ]);
    expect(index.get(1)).toEqual({ hasP1: true });
  });
});

describe('isoWeekKey', () => {
  it('computes the ISO week for a known date', () => {
    expect(isoWeekKey('2026-09-10T12:00:00Z')).toBe('2026-W37');
  });

  it('handles a year boundary (ISO week can belong to the adjacent year)', () => {
    // 2025-01-01 falls in ISO week 1 of 2025, not week 53 of 2024, per the
    // calendar-year-of-the-fixed-anchor-weekday rule isoWeekKey implements.
    expect(isoWeekKey('2025-01-01T00:00:00Z')).toBe('2025-W01');
  });
});

describe('weeklyRevertRate', () => {
  it('buckets by ISO week and computes reverts / merged', () => {
    const prs = [
      pr({ number: 1, title: 'feat: a', mergedAt: '2026-09-07T00:00:00Z' }), // W37
      pr({ number: 2, title: 'revert: back out #1', mergedAt: '2026-09-08T00:00:00Z' }), // W37
      pr({ number: 3, title: 'feat: b', mergedAt: '2026-09-14T00:00:00Z' }), // W38
    ];
    const rows = weeklyRevertRate(prs);
    expect(rows).toEqual([
      { isoWeek: '2026-W37', merged: 2, reverts: 1, rate: 0.5 },
      { isoWeek: '2026-W38', merged: 1, reverts: 0, rate: 0 },
    ]);
  });

  it('returns an empty array for no PRs', () => {
    expect(weeklyRevertRate([])).toEqual([]);
  });
});

describe('computeReport', () => {
  const SWITCH = '2026-09-10T00:00:00Z';
  const RISK_GLOBS = ['src/guard/**'];
  const options: Options = { repo: 'x/y', switchIso: SWITCH, days: 5, followupDays: 14, json: false };

  it('splits PRs into before/after buckets and classifies low-risk correctly', () => {
    const prs = [
      pr({ number: 1, title: 'feat: a', mergedAt: '2026-09-06T00:00:00Z', files: ['docs/a.md'] }), // before, low-risk
      pr({ number: 2, title: 'fix(guard): b', mergedAt: '2026-09-07T00:00:00Z', files: ['src/guard/x.ts'] }), // before, high-risk
      pr({ number: 3, title: 'feat: c', mergedAt: '2026-09-11T00:00:00Z', files: ['docs/c.md'] }), // after, low-risk
    ];
    const report = computeReport(prs, RISK_GLOBS, options);
    expect(report.before.totalMerged).toBe(2);
    expect(report.before.lowRiskMerged).toBe(1);
    expect(report.after.totalMerged).toBe(1);
    expect(report.after.lowRiskMerged).toBe(1);
  });

  it('counts a follow-up by link within the followup window, and flags the small-sample caveat', () => {
    const prs = [
      pr({ number: 1, title: 'feat: a', mergedAt: '2026-09-06T00:00:00Z', files: ['docs/a.md'] }),
      // High-risk itself (touches src/guard/**), so it doesn't inflate the low-risk
      // denominator this assertion is checking against.
      pr({
        number: 2,
        title: 'fix: patch a',
        mergedAt: '2026-09-07T00:00:00Z',
        body: 'Fixes-PR: #1',
        files: ['src/guard/y.ts'],
      }),
    ];
    const report = computeReport(prs, RISK_GLOBS, options);
    expect(report.before.followedUpByLink).toBe(1);
    expect(report.before.followedUpByLinkPRs).toEqual([1]);
    expect(report.before.followedUpByLinkRate).toBe(1);
    expect(report.before.caveat).toMatch(/only 1 low-risk PR/);
  });

  it('does not count a follow-up merged after the followup window', () => {
    const tight: Options = { ...options, followupDays: 1 };
    const prs = [
      pr({ number: 1, title: 'feat: a', mergedAt: '2026-09-06T00:00:00Z', files: ['docs/a.md'] }),
      pr({ number: 2, title: 'fix: patch a', mergedAt: '2026-09-09T00:00:00Z', body: 'Fixes-PR: #1', files: [] }),
    ];
    const report = computeReport(prs, RISK_GLOBS, tight);
    expect(report.before.followedUpByLink).toBe(0);
  });

  it('counts a revert with no day bound', () => {
    const prs = [
      pr({ number: 1, title: 'feat: a', mergedAt: '2026-09-06T00:00:00Z', files: ['docs/a.md'] }),
      pr({ number: 2, title: 'revert: back out #1', mergedAt: '2026-09-09T00:00:00Z', files: [] }),
    ];
    const report = computeReport(prs, RISK_GLOBS, options);
    expect(report.before.reverted).toBe(1);
    expect(report.before.revertedPRs).toEqual([1]);
  });

  it('has no caveat once a bucket reaches 30 low-risk PRs', () => {
    const prs = Array.from({ length: 30 }, (_, i) =>
      pr({ number: i + 1, title: `feat: ${i}`, mergedAt: '2026-09-06T00:00:00Z', files: [`docs/${i}.md`] }),
    );
    const report = computeReport(prs, RISK_GLOBS, options);
    expect(report.before.lowRiskMerged).toBe(30);
    expect(report.before.caveat).toBeNull();
  });

  it('produces a weekly revert rate spanning the whole window', () => {
    const prs = [
      pr({ number: 1, title: 'feat: a', mergedAt: '2026-09-06T00:00:00Z', files: [] }),
      pr({ number: 2, title: 'feat: b', mergedAt: '2026-09-11T00:00:00Z', files: [] }),
    ];
    const report = computeReport(prs, RISK_GLOBS, options);
    expect(report.weeklyRevertRate.length).toBeGreaterThan(0);
  });

  it('counts shadow-reviewed low-risk PRs and P1s among them, per bucket', () => {
    const prs = [
      // low-risk, after the switch, shadow-reviewed with a P1
      pr({ number: 3, title: 'feat: c', mergedAt: '2026-09-11T00:00:00Z', files: ['docs/c.md'] }),
      // low-risk, after the switch, shadow-reviewed clean (P2 only)
      pr({ number: 4, title: 'feat: d', mergedAt: '2026-09-12T00:00:00Z', files: ['docs/d.md'] }),
      // low-risk, after the switch, never shadow-reviewed (no issue)
      pr({ number: 5, title: 'feat: e', mergedAt: '2026-09-13T00:00:00Z', files: ['docs/e.md'] }),
      // high-risk, so it never lands in the low-risk denominator even with a matching issue
      pr({ number: 6, title: 'fix(guard): f', mergedAt: '2026-09-14T00:00:00Z', files: ['src/guard/x.ts'] }),
    ];
    const issues: ShadowReviewIssueData[] = [
      shadowReviewIssue({ number: 3, body: '- **P1** — a.ts:1 — auth bypass' }),
      shadowReviewIssue({ number: 4, body: '- **P2** — b.ts:1 — cosmetic' }),
      shadowReviewIssue({ number: 6, body: '- **P1** — should not count, #6 is high-risk' }),
    ];
    const report = computeReport(prs, RISK_GLOBS, options, issues);
    expect(report.after.lowRiskMerged).toBe(3);
    expect(report.after.shadowReviewed).toBe(2);
    expect(report.after.shadowReviewedPRs).toEqual([3, 4]);
    expect(report.after.shadowReviewP1).toBe(1);
    expect(report.after.shadowReviewP1PRs).toEqual([3]);
    expect(report.after.shadowReviewedRate).toBeCloseTo(2 / 3);
  });

  it('defaults shadow-review counts to zero when no issues are supplied', () => {
    const prs = [pr({ number: 1, title: 'feat: a', mergedAt: '2026-09-11T00:00:00Z', files: ['docs/a.md'] })];
    const report = computeReport(prs, RISK_GLOBS, options);
    expect(report.after.shadowReviewed).toBe(0);
    expect(report.after.shadowReviewP1).toBe(0);
    expect(report.after.shadowReviewFailed).toBe(0);
  });

  it('counts shadow-review-failed low-risk PRs separately, not as reviewed', () => {
    const prs = [
      // low-risk, after the switch, shadow-reviewed with a P1
      pr({ number: 3, title: 'feat: c', mergedAt: '2026-09-11T00:00:00Z', files: ['docs/c.md'] }),
      // low-risk, after the switch, analyze failed (no issue exists for it)
      pr({ number: 7, title: 'feat: g', mergedAt: '2026-09-12T00:00:00Z', files: ['docs/g.md'] }),
      // high-risk, so a matching shadow-review-failed label still never lands in the
      // low-risk denominator (mirrors the high-risk exclusion test above)
      pr({ number: 8, title: 'fix(guard): h', mergedAt: '2026-09-13T00:00:00Z', files: ['src/guard/x.ts'] }),
    ];
    const issues: ShadowReviewIssueData[] = [shadowReviewIssue({ number: 3, body: '- **P1** — a.ts:1 — bad' })];
    const report = computeReport(prs, RISK_GLOBS, options, issues, [7, 8]);
    expect(report.after.lowRiskMerged).toBe(2);
    expect(report.after.shadowReviewFailed).toBe(1);
    expect(report.after.shadowReviewFailedPRs).toEqual([7]);
    expect(report.after.shadowReviewFailedRate).toBeCloseTo(1 / 2);
    // #7 failed, not reviewed — must not also count as shadow-reviewed.
    expect(report.after.shadowReviewed).toBe(1);
    expect(report.after.shadowReviewedPRs).toEqual([3]);
  });

  it('defaults shadow-review-failed counts to zero when no PR numbers are supplied', () => {
    const prs = [pr({ number: 1, title: 'feat: a', mergedAt: '2026-09-11T00:00:00Z', files: ['docs/a.md'] })];
    const report = computeReport(prs, RISK_GLOBS, options, []);
    expect(report.after.shadowReviewFailed).toBe(0);
    expect(report.after.shadowReviewFailedPRs).toEqual([]);
  });

  it('counts a clean re-run (shadow-reviewed label, no issue) as reviewed and not failed', () => {
    const prs = [pr({ number: 9, title: 'feat: i', mergedAt: '2026-09-11T00:00:00Z', files: ['docs/i.md'] })];
    // No issue — a clean review posts a PR comment, not an issue — and the PR is no
    // longer in the shadow-review-failed list (report's success path removes it).
    const report = computeReport(prs, RISK_GLOBS, options, [], [], [9]);
    expect(report.after.shadowReviewed).toBe(1);
    expect(report.after.shadowReviewedPRs).toEqual([9]);
    expect(report.after.shadowReviewP1).toBe(0);
    expect(report.after.shadowReviewFailed).toBe(0);
  });

  it('counts a P1 re-run (shadow-reviewed label AND an issue) as reviewed, P1, and not failed', () => {
    const prs = [pr({ number: 10, title: 'feat: j', mergedAt: '2026-09-11T00:00:00Z', files: ['docs/j.md'] })];
    const issues: ShadowReviewIssueData[] = [shadowReviewIssue({ number: 10, body: '- **P1** — a.ts:1 — bad' })];
    const report = computeReport(prs, RISK_GLOBS, options, issues, [], [10]);
    expect(report.after.shadowReviewed).toBe(1);
    expect(report.after.shadowReviewedPRs).toEqual([10]);
    expect(report.after.shadowReviewP1).toBe(1);
    expect(report.after.shadowReviewP1PRs).toEqual([10]);
    expect(report.after.shadowReviewFailed).toBe(0);
  });

  it('still counts a PR reviewed via issue alone as reviewed, with no shadow-reviewed label (pre-label history)', () => {
    const prs = [pr({ number: 11, title: 'feat: k', mergedAt: '2026-09-11T00:00:00Z', files: ['docs/k.md'] })];
    const issues: ShadowReviewIssueData[] = [shadowReviewIssue({ number: 11, body: '- **P2** — a.ts:1 — minor' })];
    // No shadow-reviewed label numbers passed at all — this PR predates the label.
    const report = computeReport(prs, RISK_GLOBS, options, issues);
    expect(report.after.shadowReviewed).toBe(1);
    expect(report.after.shadowReviewedPRs).toEqual([11]);
  });

  it('counts a PR carrying both shadow-reviewed and shadow-review-failed labels as reviewed, not failed (precedence)', () => {
    const prs = [pr({ number: 12, title: 'feat: l', mergedAt: '2026-09-11T00:00:00Z', files: ['docs/l.md'] })];
    // Both label lists name #12: e.g. a failed re-run against a PR reviewed cleanly
    // earlier only ADDS shadow-review-failed — it never removes shadow-reviewed (see the
    // file header's "Precedence" note). A real review is never erased by a stale or
    // concurrent failure label, so #12 must count as reviewed and NOT as failed.
    const report = computeReport(prs, RISK_GLOBS, options, [], [12], [12]);
    expect(report.after.shadowReviewed).toBe(1);
    expect(report.after.shadowReviewedPRs).toEqual([12]);
    expect(report.after.shadowReviewFailed).toBe(0);
    expect(report.after.shadowReviewFailedPRs).toEqual([]);
  });
});

describe('isEligibleForShadowReview', () => {
  it('is eligible with no risk:high or review:requested label', () => {
    expect(isEligibleForShadowReview([])).toBe(true);
    expect(isEligibleForShadowReview(['bug', 'docs'])).toBe(true);
  });

  it('is ineligible with risk:high', () => {
    expect(isEligibleForShadowReview(['risk:high'])).toBe(false);
  });

  it('is ineligible with review:requested', () => {
    expect(isEligibleForShadowReview(['review:requested'])).toBe(false);
  });

  it('is ineligible with both', () => {
    expect(isEligibleForShadowReview(['risk:high', 'review:requested'])).toBe(false);
  });
});

describe('computeShadowCoverage', () => {
  const sinceIso = '2026-09-11T15:59:15Z';

  it('excludes a PR merged before go-live from the denominator', () => {
    const prs = [
      pr({ number: 1, mergedAt: '2026-09-11T15:59:14Z', labels: [] }),
      pr({ number: 2, mergedAt: '2026-09-11T15:59:15Z', labels: [] }),
    ];
    const coverage = computeShadowCoverage(prs, [], [], [], sinceIso);
    expect(coverage.eligible).toBe(1);
    expect(coverage.notYetRunPRs).toEqual([2]);
  });

  it('excludes a low-risk-by-files PR labeled review:requested from the denominator', () => {
    // Low-risk by the file-glob rule (no src/guard/** touch), but labeled
    // review:requested — the workflow's own selection rule (isEligibleForShadowReview)
    // skips it, so the coverage denominator must skip it too, unlike the file-based
    // before/after bucket which only looks at files.
    const prs = [
      pr({ number: 3, mergedAt: '2026-09-12T00:00:00Z', files: ['docs/a.md'], labels: ['review:requested'] }),
      pr({ number: 4, mergedAt: '2026-09-12T00:00:00Z', files: ['docs/b.md'], labels: [] }),
    ];
    const coverage = computeShadowCoverage(prs, [], [], [], sinceIso);
    expect(coverage.eligible).toBe(1);
    expect(coverage.notYetRunPRs).toEqual([4]);
  });

  it('excludes a PR merged into a branch other than main from the denominator', () => {
    // shadow-review.yml's report job only ever runs for github.event.pull_request.base.ref
    // == 'main' (shadow-review.yml:149) — a PR merged into some other branch (a long-lived
    // feature branch, say) was never a candidate, so it must not inflate the denominator.
    const prs = [
      pr({ number: 5, mergedAt: '2026-09-12T00:00:00Z', labels: [], baseRefName: 'release' }),
      pr({ number: 6, mergedAt: '2026-09-12T00:00:00Z', labels: [], baseRefName: 'main' }),
    ];
    const coverage = computeShadowCoverage(prs, [], [], [], sinceIso);
    expect(coverage.eligible).toBe(1);
    expect(coverage.notYetRunPRs).toEqual([6]);
  });

  it('partitions eligible PRs into reviewed, failed, and not-yet-run', () => {
    const prs = [
      pr({ number: 5, mergedAt: '2026-09-12T00:00:00Z', labels: [] }), // reviewed via label
      pr({ number: 6, mergedAt: '2026-09-12T00:00:00Z', labels: [] }), // failed
      pr({ number: 7, mergedAt: '2026-09-12T00:00:00Z', labels: [] }), // not yet run
      pr({ number: 8, mergedAt: '2026-09-12T00:00:00Z', labels: [] }), // reviewed + failed → reviewed wins
    ];
    const coverage = computeShadowCoverage(prs, [], [5, 8], [6, 8], sinceIso);
    expect(coverage.eligible).toBe(4);
    expect(coverage.reviewed).toBe(2);
    expect(coverage.reviewedPRs).toEqual([5, 8]);
    expect(coverage.failed).toBe(1);
    expect(coverage.failedPRs).toEqual([6]);
    expect(coverage.notYetRun).toBe(1);
    expect(coverage.notYetRunPRs).toEqual([7]);
    expect(coverage.caveat).toMatch(/CURRENT labels/);
  });

  it('defaults sinceIso to SHADOW_REVIEW_GO_LIVE_ISO', () => {
    const prs = [pr({ number: 9, mergedAt: '2026-09-01T00:00:00Z', labels: [] })];
    const coverage = computeShadowCoverage(prs, [], [], []);
    expect(coverage.sinceIso).toBe(SHADOW_REVIEW_GO_LIVE_ISO);
    expect(coverage.eligible).toBe(0); // #9 merged before go-live
  });
});

describe('computeFetchSinceIso', () => {
  const goLive = '2026-09-11T15:59:15Z';

  it('uses switch - days when that is earlier than go-live', () => {
    // switch - days = 2026-08-27, well before go-live — the before/after bucket's own
    // window should win here, since it's the one actually asking for more history.
    const since = computeFetchSinceIso('2026-09-10T00:00:00Z', 14, goLive);
    expect(since).toBe(new Date('2026-08-27T00:00:00Z').toISOString());
  });

  it('uses go-live when switch - days would be later than go-live', () => {
    // --switch 2026-10-01 --days 7 -> switch - days = 2026-09-24, AFTER go-live. Fetching
    // from there alone would silently drop every PR merged 09-11..09-24 from allPRs,
    // undercounting computeShadowCoverage even though its own "since" label still reads
    // "since go-live" — see the file header / computeFetchSinceIso's own doc comment.
    const since = computeFetchSinceIso('2026-10-01T00:00:00Z', 7, goLive);
    expect(since).toBe(new Date(goLive).toISOString());
  });

  it('is inclusive at the boundary: switch - days exactly equal to go-live', () => {
    const since = computeFetchSinceIso('2026-09-11T15:59:15Z', 0, goLive);
    expect(since).toBe(new Date(goLive).toISOString());
  });

  it('compares timestamps, not ISO strings (go-live has no milliseconds)', () => {
    // A naive string comparison of a bare-seconds ISO string ('...15Z') against a
    // .toISOString() result ('...15.000Z') sorts '.' before 'Z', so the millisecond
    // form would read as "earlier" even when the instants are equal or later — this
    // case pins the correct (numeric) comparison at exactly that boundary.
    const since = computeFetchSinceIso('2026-09-11T15:59:16Z', 0, goLive);
    expect(since).toBe(new Date(goLive).toISOString());
  });

  it('defaults goLiveIso to SHADOW_REVIEW_GO_LIVE_ISO', () => {
    // switch - days = 2026-10-01, well after go-live — only the default takes effect here.
    const since = computeFetchSinceIso('2026-10-01T00:00:00Z', 0);
    expect(since).toBe(new Date(SHADOW_REVIEW_GO_LIVE_ISO).toISOString());
  });
});

describe('hasFixesPrLine', () => {
  it('is true for a linked Fixes-PR line', () => {
    expect(hasFixesPrLine('body\nFixes-PR: #10\nmore')).toBe(true);
  });

  it('is true for Fixes-PR: none — the convention was followed, even though there is no link', () => {
    expect(hasFixesPrLine('Fixes-PR: none')).toBe(true);
  });

  it('is false when the trailer is absent entirely', () => {
    expect(hasFixesPrLine('nothing here')).toBe(false);
  });
});

describe('findConventionStartIso', () => {
  it('returns the mergedAt of the earliest PR carrying a Fixes-PR line, by merge time not array order', () => {
    const prs = [
      pr({ number: 1, mergedAt: '2026-09-05T00:00:00Z', body: '' }), // no line, later merge — irrelevant
      pr({ number: 2, mergedAt: '2026-09-03T00:00:00Z', body: 'Fixes-PR: none' }), // earliest WITH a line
      pr({ number: 3, mergedAt: '2026-09-04T00:00:00Z', body: 'Fixes-PR: #1' }),
    ];
    expect(findConventionStartIso(prs)).toBe('2026-09-03T00:00:00Z');
  });

  it('counts a Fixes-PR: none line as evidence the convention started, not just a link', () => {
    expect(findConventionStartIso([pr({ number: 1, mergedAt: '2026-09-03T00:00:00Z', body: 'Fixes-PR: none' })])).toBe(
      '2026-09-03T00:00:00Z',
    );
  });

  it('returns null when no PR carries the line', () => {
    expect(findConventionStartIso([pr({ number: 1, body: '' }), pr({ number: 2, body: 'unrelated' })])).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(findConventionStartIso([])).toBeNull();
  });
});

describe('isSkipVerdict', () => {
  const RISK_GLOBS = ['src/guard/**'];

  it('is true (skip) for a low-risk PR with no risk:high/review:requested label — codex-review.sh:765-767', () => {
    expect(isSkipVerdict(pr({ number: 1, files: ['docs/a.md'], labels: [] }), RISK_GLOBS)).toBe(true);
  });

  it('is false (review) when the diff matches a risk:high glob, replaying the file half of the rule', () => {
    expect(isSkipVerdict(pr({ number: 1, files: ['src/guard/x.ts'], labels: [] }), RISK_GLOBS)).toBe(false);
  });

  it('is false (review) when the PR carries review:requested despite low-risk files', () => {
    expect(isSkipVerdict(pr({ number: 1, files: ['docs/a.md'], labels: ['review:requested'] }), RISK_GLOBS)).toBe(
      false,
    );
  });

  it('is false (review) when the PR carries risk:high despite low-risk files', () => {
    expect(isSkipVerdict(pr({ number: 1, files: ['docs/a.md'], labels: ['risk:high'] }), RISK_GLOBS)).toBe(false);
  });
});

describe('isoWeekDateRange', () => {
  it('round-trips with isoWeekKey for a known week', () => {
    const { startIso, endIso } = isoWeekDateRange('2026-W37');
    expect(startIso).toBe('2026-09-07T00:00:00.000Z');
    expect(endIso).toBe('2026-09-13T23:59:59.999Z');
    expect(isoWeekKey(startIso)).toBe('2026-W37');
    expect(isoWeekKey(endIso)).toBe('2026-W37');
  });

  it('round-trips across a year boundary (week 1 starts in the prior calendar year)', () => {
    const { startIso, endIso } = isoWeekDateRange('2025-W01');
    expect(startIso).toBe('2024-12-30T00:00:00.000Z');
    expect(endIso).toBe('2025-01-05T23:59:59.999Z');
    expect(isoWeekKey(startIso)).toBe('2025-W01');
    expect(isoWeekKey(endIso)).toBe('2025-W01');
  });

  it('throws on an invalid week key', () => {
    expect(() => isoWeekDateRange('garbage')).toThrow(/invalid ISO week key/);
  });
});

describe('computeMergedSearchSlices — P2, per-ISO-week GitHub search slicing', () => {
  it('covers the window exactly: no gap, no overlap, and the partial first and last weeks are truncated to the bounds', () => {
    // Spans a partial W37, a whole W38, and a partial W39 (W37: Sep 7-13, W38: Sep
    // 14-20, W39: Sep 21-27 — from the isoWeekDateRange tests above).
    const sinceIso = '2026-09-08T12:00:00.000Z';
    const untilIso = '2026-09-22T06:00:00.000Z';
    const slices = computeMergedSearchSlices(sinceIso, untilIso);
    expect(slices).toEqual([
      { startIso: '2026-09-08T12:00:00.000Z', endIso: '2026-09-13T23:59:59.999Z' },
      { startIso: '2026-09-14T00:00:00.000Z', endIso: '2026-09-20T23:59:59.999Z' },
      { startIso: '2026-09-21T00:00:00.000Z', endIso: '2026-09-22T06:00:00.000Z' },
    ]);
    // No gap, no overlap: each slice after the first starts exactly 1ms after the
    // previous one ends.
    for (let i = 1; i < slices.length; i += 1) {
      const previousEndMs = new Date(slices[i - 1]!.endIso).getTime();
      const thisStartMs = new Date(slices[i]!.startIso).getTime();
      expect(thisStartMs).toBe(previousEndMs + 1);
    }
    expect(slices[0]!.startIso).toBe(sinceIso); // partial first week, truncated to the request
    expect(slices[slices.length - 1]!.endIso).toBe(untilIso); // partial last week, truncated to the request
  });

  it('returns exactly one slice when since and until fall in the same ISO week', () => {
    const slices = computeMergedSearchSlices('2026-09-09T00:00:00.000Z', '2026-09-11T00:00:00.000Z');
    expect(slices).toEqual([{ startIso: '2026-09-09T00:00:00.000Z', endIso: '2026-09-11T00:00:00.000Z' }]);
  });

  it('returns no slices when until precedes since', () => {
    expect(computeMergedSearchSlices('2026-09-11T00:00:00.000Z', '2026-09-09T00:00:00.000Z')).toEqual([]);
  });
});

describe('combineMergedPrSlices — P2, de-dup and fail-on-cap', () => {
  it('de-duplicates a PR that appears in two slices (a mergedAt exactly on a boundary), counting it once', () => {
    const boundaryPr = pr({ number: 42, mergedAt: '2026-09-13T23:59:59.000Z' });
    const result = combineMergedPrSlices([
      { slice: { startIso: '2026-09-07T00:00:00.000Z', endIso: '2026-09-13T23:59:59.999Z' }, prs: [boundaryPr] },
      { slice: { startIso: '2026-09-14T00:00:00.000Z', endIso: '2026-09-20T23:59:59.999Z' }, prs: [boundaryPr] },
    ]);
    expect(result.filter((p) => p.number === 42)).toHaveLength(1);
  });

  it('merges distinct PRs across slices with no loss', () => {
    const result = combineMergedPrSlices([
      { slice: { startIso: 'a', endIso: 'b' }, prs: [pr({ number: 1 }), pr({ number: 2 })] },
      { slice: { startIso: 'c', endIso: 'd' }, prs: [pr({ number: 3 })] },
    ]);
    expect(result.map((p) => p.number).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('fails loudly — throws, never truncates silently — when a single slice returns >=1,000 rows', () => {
    const capped = Array.from({ length: 1000 }, (_, i) => pr({ number: i + 1 }));
    expect(() =>
      combineMergedPrSlices([
        { slice: { startIso: '2026-09-07T00:00:00.000Z', endIso: '2026-09-13T23:59:59.999Z' }, prs: capped },
      ]),
    ).toThrow(/1,000|1000/);
  });

  it('does not throw for a slice just under the cap (999 rows)', () => {
    const almostCapped = Array.from({ length: 999 }, (_, i) => pr({ number: i + 1 }));
    expect(() =>
      combineMergedPrSlices([
        { slice: { startIso: '2026-09-07T00:00:00.000Z', endIso: '2026-09-13T23:59:59.999Z' }, prs: almostCapped },
      ]),
    ).not.toThrow();
  });
});

describe('verifyMergedPrTotalCount — P3 #2 (#706 round 4), search total_count cross-check', () => {
  // A malformed or unparsed `merged:` search bound doesn't error — it silently returns a
  // valid-looking but wrong result set, no slice ever near combineMergedPrSlices' >=1000
  // cap. `fetchTotal`/`wait` are stubbed here exactly so these cases never shell out to
  // `gh` or actually pause wall-clock time (see the function's own doc comment).
  const window = { repo: 'owner/repo', sinceIso: '2026-09-07T00:00:00.000Z', untilIso: '2026-09-13T23:59:59.999Z' };

  it('passes when the first read already matches the combined count — no wait, no retry', () => {
    let calls = 0;
    const fetchTotal = (): number => {
      calls += 1;
      return 45;
    };
    const wait = vi.fn();
    expect(() => verifyMergedPrTotalCount(45, window, fetchTotal, wait)).not.toThrow();
    expect(calls).toBe(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('retries once after a mismatch, and passes when the retry clears it (search-index lag on a just-completed merge)', () => {
    const totals = [44, 45]; // first read misses the just-merged PR; retry catches up
    let calls = 0;
    const fetchTotal = (): number => totals[calls++]!;
    const wait = vi.fn();
    expect(() => verifyMergedPrTotalCount(45, window, fetchTotal, wait)).not.toThrow();
    expect(calls).toBe(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(expect.any(Number));
  });

  it('throws, naming both the combined count and the search total, when the mismatch persists past the retry', () => {
    const fetchTotal = (): number => 47; // never agrees with the combined count below
    const wait = vi.fn();
    expect(() => verifyMergedPrTotalCount(45, window, fetchTotal, wait)).toThrow(
      /45 unique pull request.*47|47.*45 unique pull request/s,
    );
    expect(wait).toHaveBeenCalledTimes(1); // one retry attempted before giving up, never more
  });
});

describe('computeWeeklyFetchSinceIso', () => {
  it('subtracts weeklyDays from nowIso', () => {
    expect(computeWeeklyFetchSinceIso('2026-09-12T00:00:00Z', 90)).toBe(new Date('2026-06-14T00:00:00Z').toISOString());
  });
});

describe('computeWeeklyReport', () => {
  const RISK_GLOBS = ['src/guard/**'];

  it('buckets PRs into one row per ISO week, ascending, across a year boundary', () => {
    const prs = [
      pr({ number: 1, mergedAt: '2024-12-31T00:00:00Z' }), // 2025-W01
      pr({ number: 2, mergedAt: '2025-01-06T00:00:00Z' }), // 2025-W02
    ];
    const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-01-01T00:00:00Z');
    expect(weekly.rows.map((r) => r.isoWeek)).toEqual(['2025-W01', '2025-W02']);
    expect(weekly.rows[0]!.merged).toBe(1);
    expect(weekly.rows[1]!.merged).toBe(1);
  });

  it('excludes a PR merged into a branch other than main', () => {
    const prs = [
      pr({ number: 1, mergedAt: '2026-09-11T00:00:00Z', baseRefName: 'release' }),
      pr({ number: 2, mergedAt: '2026-09-11T00:00:00Z', baseRefName: 'main' }),
    ];
    const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
    expect(weekly.rows).toHaveLength(1);
    expect(weekly.rows[0]!.merged).toBe(1);
  });

  it('always reports the pinned FIXES_PR_CONVENTION_START_ISO, never a recomputed value', () => {
    // Every PR here carries a Fixes-PR line dated LATER than the pinned constant — if
    // conventionStartIso were still recomputed via findConventionStartIso over this
    // fetch window, it would read as this PR's own (later) mergedAt instead.
    const prs = [pr({ number: 1, mergedAt: '2026-09-20T00:00:00Z', body: 'Fixes-PR: none' })];
    const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-25T00:00:00Z');
    expect(weekly.conventionStartIso).toBe(FIXES_PR_CONVENTION_START_ISO);
  });

  describe('pre-gate vs. post-gate — P2 #1', () => {
    it('never counts a pre-gate PR as reviewed or skipped, only as a descriptive file class', () => {
      // Merged before GATE_GO_LIVE_ISO — the gate did not exist yet, so there was no
      // skip verdict to have merged on.
      const prs = [pr({ number: 601, mergedAt: '2026-09-10T10:00:00Z', files: ['docs/pre.md'] })];
      const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
      const row = weekly.rows[0]!;
      expect(row.preGateMerged).toBe(1);
      expect(row.preGateLowRisk).toBe(1);
      expect(row.preGateHighRisk).toBe(0);
      expect(row.postGateMerged).toBe(0);
      expect(row.reviewed).toBe(0);
      expect(row.skipped).toBe(0);
      expect(row.isMixedGateWeek).toBe(false);
    });

    it('classifies a pre-gate PR high-risk when its files match the (current) risk:high globs', () => {
      const prs = [pr({ number: 601, mergedAt: '2026-09-10T10:00:00Z', files: ['src/guard/x.ts'] })];
      const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
      const row = weekly.rows[0]!;
      expect(row.preGateLowRisk).toBe(0);
      expect(row.preGateHighRisk).toBe(1);
    });

    it('flags isMixedGateWeek when a week straddles go-live, and scopes reviewed/skipped to the post-gate subset', () => {
      const prs = [
        pr({ number: 601, mergedAt: '2026-09-10T10:00:00Z', files: ['docs/pre.md'] }), // pre-gate
        pr({
          number: 602,
          mergedAt: '2026-09-10T18:00:00Z', // post-gate, same week (2026-W37)
          files: ['docs/post.md'],
          atMergeContext: { files: ['docs/post.md'], labels: [], riskHighGlobs: RISK_GLOBS },
        }),
      ];
      const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
      const row = weekly.rows[0]!;
      expect(row.isMixedGateWeek).toBe(true);
      expect(row.merged).toBe(2);
      expect(row.preGateMerged).toBe(1);
      expect(row.postGateMerged).toBe(1);
      expect(row.skipped).toBe(1);
      expect(row.skippedRate).toBe(1); // over postGateMerged (1), not merged (2)
    });

    it('counts a post-gate PR with an unresolvable at-merge context as unresolved, not reviewed or skipped', () => {
      const prs = [pr({ number: 604, mergedAt: '2026-09-11T00:00:00Z', atMergeContext: null })];
      const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
      const row = weekly.rows[0]!;
      expect(row.postGateMerged).toBe(1);
      expect(row.reviewed).toBe(0);
      expect(row.skipped).toBe(0);
      expect(row.postGateUnresolved).toBe(1);
    });

    it('counts a post-gate PR with a forced review verdict (>=300 changed files) as reviewed, not unresolved — codex-review.sh:764', () => {
      const prs = [
        pr({
          number: 700,
          mergedAt: '2026-09-11T00:00:00Z',
          atMergeContext: undefined,
          atMergeForcedVerdict: 'review',
        }),
      ];
      const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
      const row = weekly.rows[0]!;
      expect(row.postGateMerged).toBe(1);
      expect(row.reviewed).toBe(1);
      expect(row.skipped).toBe(0);
      expect(row.postGateUnresolved).toBe(0);
    });

    it('is pre-gate at EXACTLY GATE_GO_LIVE_ISO, strictly: #609 itself is the commit that ships the file', () => {
      const prs = [pr({ number: 609, mergedAt: GATE_GO_LIVE_ISO, files: ['docs/pre.md'] })];
      const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
      const row = weekly.rows[0]!;
      expect(row.preGateMerged).toBe(1);
      expect(row.postGateMerged).toBe(0);
    });

    it('is post-gate one millisecond after GATE_GO_LIVE_ISO', () => {
      const afterGoLive = new Date(new Date(GATE_GO_LIVE_ISO).getTime() + 1).toISOString();
      const prs = [
        pr({
          number: 610,
          mergedAt: afterGoLive,
          files: ['docs/post.md'],
          atMergeContext: { files: ['docs/post.md'], labels: [], riskHighGlobs: RISK_GLOBS },
        }),
      ];
      const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
      const row = weekly.rows[0]!;
      expect(row.postGateMerged).toBe(1);
      expect(row.preGateMerged).toBe(0);
    });

    it('reclassifies a post-gate-by-date PR as pre-gate when preGateOverride is set (labeler.yml missing at its own base — #605-style)', () => {
      const prs = [
        pr({
          number: 605,
          mergedAt: '2026-09-11T00:00:00Z', // strictly after GATE_GO_LIVE_ISO by date
          files: ['container/skills/pr-review-loop/scripts/codex-review.sh'],
          preGateOverride: true, // resolveAtMergeContexts sets this when labeler.yml didn't exist yet at the base
          atMergeContext: undefined,
        }),
      ];
      const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
      const row = weekly.rows[0]!;
      expect(row.preGateMerged).toBe(1);
      expect(row.postGateMerged).toBe(0);
      expect(row.postGateUnresolved).toBe(0); // reclassified, not left dangling as unresolved
    });
  });

  describe('post-gate lane classification replays the AT-MERGE state, never current state — P2 #2', () => {
    // The concrete case the review round named: PR #620 was correctly SKIPPED under the
    // 22 risk:high globs live at its own merge, but flips to "reviewed" under a naive
    // CURRENT-state replay once the glob list grows to include its path — hiding the
    // real miss (#620 is itself a linked bug-introducer) instead of exposing it.
    const CURRENT_RISK_GLOBS = ['src/guard/**', 'src/new-risky/**']; // grew AFTER this PR merged
    const prAtMergeGlobsOnly = ['src/guard/**']; // what .github/labeler.yml actually held at its merge

    it('stays skipped under the historical glob list even though the CURRENT list would flip it to reviewed', () => {
      const prs = [
        pr({
          number: 620,
          title: 'feat: z',
          mergedAt: '2026-09-11T10:00:00Z',
          files: ['src/new-risky/z.ts'], // matches CURRENT_RISK_GLOBS, not prAtMergeGlobsOnly
          atMergeContext: { files: ['src/new-risky/z.ts'], labels: [], riskHighGlobs: prAtMergeGlobsOnly },
        }),
      ];
      const weekly = computeWeeklyReport(prs, CURRENT_RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
      const row = weekly.rows[0]!;
      expect(row.skipped).toBe(1);
      expect(row.reviewed).toBe(0);
    });

    it('sanity check: the SAME PR classifies reviewed if its at-merge context had actually carried the current globs', () => {
      // Confirms the fixture above is a real divergence, not a tautology: swapping
      // riskHighGlobs to CURRENT_RISK_GLOBS on the same files DOES flip the verdict.
      const prs = [
        pr({
          number: 620,
          mergedAt: '2026-09-11T10:00:00Z',
          files: ['src/new-risky/z.ts'],
          atMergeContext: { files: ['src/new-risky/z.ts'], labels: [], riskHighGlobs: CURRENT_RISK_GLOBS },
        }),
      ];
      const weekly = computeWeeklyReport(prs, CURRENT_RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
      expect(weekly.rows[0]!.reviewed).toBe(1);
      expect(weekly.rows[0]!.skipped).toBe(0);
    });
  });

  it('counts a revert found within the follow-up window as bug-introducing, same as a Fixes-PR link — P2 #5', () => {
    // #608-style: reverted by a later PR, but never itself named via Fixes-PR:.
    const prs = [
      pr({ number: 608, title: 'feat: risky change', mergedAt: '2026-09-11T00:00:00Z' }),
      pr({ number: 610, title: 'revert(x): back out #608', mergedAt: '2026-09-12T00:00:00Z' }),
    ];
    const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
    const row = weekly.rows[0]!;
    expect(row.overall.linked).toBe(1);
    expect(row.overall.overlapHeuristic).toBe(0);
  });

  it('counts link-matched and overlap-heuristic follow-ups separately, per lane, in a mixed week', () => {
    const prs = [
      pr({
        number: 1,
        title: 'fix(guard): a',
        mergedAt: '2026-09-11T00:00:00Z',
        files: ['src/guard/x.ts'],
        changedLines: 500,
        atMergeContext: { files: ['src/guard/x.ts'], labels: [], riskHighGlobs: RISK_GLOBS },
      }), // reviewed — high-risk at merge
      pr({
        number: 3,
        title: 'feat: c',
        mergedAt: '2026-09-12T00:00:00Z',
        files: ['docs/c.md'],
        changedLines: 1200,
        atMergeContext: { files: ['docs/c.md'], labels: [], riskHighGlobs: RISK_GLOBS },
      }), // skipped
      pr({ number: 4, title: 'fix: patch a', mergedAt: '2026-09-15T00:00:00Z', body: 'Fixes-PR: #1', files: [] }),
      pr({ number: 5, title: 'fix: patch c', mergedAt: '2026-09-16T00:00:00Z', files: ['docs/c.md'] }),
    ];
    const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
    const row = weekly.rows[0]!;
    expect(row.reviewed).toBe(1);
    expect(row.skipped).toBe(1);
    expect(row.overall.linked).toBe(1);
    expect(row.overall.overlapHeuristic).toBe(1);
    expect(row.reviewedLane.linked).toBe(1);
    expect(row.reviewedLane.overlapHeuristic).toBe(0);
    expect(row.skippedLane.linked).toBe(0);
    expect(row.skippedLane.overlapHeuristic).toBe(1);
    // changedLines = 500 + 1200 = 1700; overall.linked = 1 -> 1 / (1700/1000).
    expect(row.linkedPerKLoc).toBeCloseTo(1 / 1.7);
  });

  it('computes the weekly revert rate at the row level (PRs that ARE themselves reverts)', () => {
    const prs = [
      pr({ number: 1, title: 'feat: a', mergedAt: '2026-09-11T00:00:00Z' }),
      pr({ number: 2, title: 'revert: back out #1', mergedAt: '2026-09-12T00:00:00Z' }),
    ];
    const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
    expect(weekly.rows[0]!.reverted).toBe(1);
    expect(weekly.rows[0]!.revertRate).toBe(0.5);
  });

  it('handles changedLines of 0 without dividing by zero', () => {
    const prs = [pr({ number: 1, mergedAt: '2026-09-11T00:00:00Z', changedLines: 0 })];
    const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
    expect(weekly.rows[0]!.linkedPerKLoc).toBe(0);
  });

  describe('linkComplete / preConventionMerged (partial weeks) — P2 #4', () => {
    it('is link-complete when the week START is at/after the convention start (2026-W38 is the first full week)', () => {
      const prs = [pr({ number: 1, mergedAt: '2026-09-15T00:00:00Z' })];
      const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
      const row = weekly.rows[0]!;
      expect(row.isoWeek).toBe('2026-W38');
      expect(row.linkComplete).toBe(true);
      expect(row.preConventionMerged).toBe(0);
    });

    it('is partial when the week START precedes the convention start, with a pre-convention count', () => {
      // 2026-W37 (Sep 7–13) starts before FIXES_PR_CONVENTION_START_ISO (Sep 11
      // 12:44:10Z), even though PR #2 in it merged after that instant.
      const prs = [
        pr({ number: 1, mergedAt: '2026-09-10T00:00:00Z' }), // before the convention
        pr({ number: 2, mergedAt: '2026-09-12T00:00:00Z' }), // after the convention, same week
      ];
      const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-20T00:00:00Z');
      const row = weekly.rows[0]!;
      expect(row.isoWeek).toBe('2026-W37');
      expect(row.linkComplete).toBe(false);
      expect(row.preConventionMerged).toBe(1);
    });
  });

  describe('the immature flag', () => {
    // 2026-W37 ends 2026-09-13T23:59:59.999Z; +14 days = 2026-09-27T23:59:59.999Z.
    const prs = [pr({ number: 1, mergedAt: '2026-09-11T00:00:00Z' })];

    it('is true one millisecond before followupDays have passed since the week ended', () => {
      const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-27T23:59:59.998Z');
      expect(weekly.rows[0]!.immature).toBe(true);
    });

    it('is false exactly when followupDays have passed since the week ended', () => {
      const weekly = computeWeeklyReport(prs, RISK_GLOBS, 14, '2026-09-27T23:59:59.999Z');
      expect(weekly.rows[0]!.immature).toBe(false);
    });
  });
});

describe('classifyAtMergeVerdict', () => {
  const ctx = { files: ['docs/a.md'], labels: [], riskHighGlobs: ['src/guard/**'] };

  it('is skip for a low-risk, label-eligible context', () => {
    expect(classifyAtMergeVerdict(ctx)).toBe('skip');
  });

  it('is review when the files match the AT-MERGE globs', () => {
    expect(classifyAtMergeVerdict({ ...ctx, files: ['src/guard/x.ts'] })).toBe('review');
  });

  it('is review when the AT-MERGE labels carry risk:high or review:requested', () => {
    expect(classifyAtMergeVerdict({ ...ctx, labels: ['review:requested'] })).toBe('review');
  });

  it('fails closed to review for null or undefined — never skip on missing data', () => {
    expect(classifyAtMergeVerdict(null)).toBe('review');
    expect(classifyAtMergeVerdict(undefined)).toBe('review');
  });
});

describe('replayLabelsAtMerge', () => {
  it('adds a label at its LabeledEvent and keeps it if merged after', () => {
    const events = [{ type: 'labeled' as const, name: 'risk:high', createdAt: '2026-09-10T00:00:00Z' }];
    expect(replayLabelsAtMerge(events, '2026-09-11T00:00:00Z')).toEqual(['risk:high']);
  });

  it('removes a label at its UnlabeledEvent, applied in time order', () => {
    const events = [
      { type: 'labeled' as const, name: 'risk:high', createdAt: '2026-09-10T00:00:00Z' },
      { type: 'unlabeled' as const, name: 'risk:high', createdAt: '2026-09-10T12:00:00Z' },
    ];
    expect(replayLabelsAtMerge(events, '2026-09-11T00:00:00Z')).toEqual([]);
  });

  it('ignores an event created AFTER mergedAt — a label added post-merge was not there at merge', () => {
    const events = [{ type: 'labeled' as const, name: 'risk:high', createdAt: '2026-09-12T00:00:00Z' }];
    expect(replayLabelsAtMerge(events, '2026-09-11T00:00:00Z')).toEqual([]);
  });

  it('includes an event at exactly mergedAt', () => {
    const events = [{ type: 'labeled' as const, name: 'risk:high', createdAt: '2026-09-11T00:00:00Z' }];
    expect(replayLabelsAtMerge(events, '2026-09-11T00:00:00Z')).toEqual(['risk:high']);
  });
});

describe('resolveAtMergeBaseSha', () => {
  it('names the first parent of a normal 2-parent merge whose second parent is the head', () => {
    expect(
      resolveAtMergeBaseSha({ headRefOid: 'head1', mergeCommitOid: 'merge1', parentOids: ['base1', 'head1'] }),
    ).toBe('base1');
  });

  it('names the single parent of a 1-parent (squash) commit', () => {
    expect(resolveAtMergeBaseSha({ headRefOid: 'head1', mergeCommitOid: 'sq1', parentOids: ['base1'] })).toBe('base1');
  });

  it("is null when the 2-parent commit's second parent is NOT this PR's head (an octopus/manual merge)", () => {
    expect(
      resolveAtMergeBaseSha({
        headRefOid: 'head1',
        mergeCommitOid: 'merge1',
        parentOids: ['base1', 'someone-elses-head'],
      }),
    ).toBeNull();
  });

  it('is null for 0 or 3+ parents', () => {
    expect(resolveAtMergeBaseSha({ headRefOid: 'head1', mergeCommitOid: 'm', parentOids: [] })).toBeNull();
    expect(resolveAtMergeBaseSha({ headRefOid: 'head1', mergeCommitOid: 'm', parentOids: ['a', 'b', 'c'] })).toBeNull();
  });

  it('is null when there is no merge commit at all', () => {
    expect(resolveAtMergeBaseSha({ headRefOid: 'head1', mergeCommitOid: null, parentOids: [] })).toBeNull();
  });
});

describe('generatedFileChangedLines — P3', () => {
  it('sums additions+deletions only for GENERATED_FILES entries', () => {
    const entries = [
      { path: 'src/a.ts', additions: 10, deletions: 5 },
      { path: 'src/upstream-ratchet.json', additions: 1000, deletions: 900 },
      { path: 'pnpm-lock.yaml', additions: 50, deletions: 20 },
    ];
    expect(generatedFileChangedLines(entries)).toBe(1000 + 900 + 50 + 20);
  });

  it('is 0 when no file is generated', () => {
    expect(generatedFileChangedLines([{ path: 'src/a.ts', additions: 10, deletions: 5 }])).toBe(0);
  });

  it('is 0 for an empty file list', () => {
    expect(generatedFileChangedLines([])).toBe(0);
  });
});

describe('stripFencedAndCommented', () => {
  it('leaves plain text untouched', () => {
    expect(stripFencedAndCommented('plain\nFixes-PR: #605\nmore')).toBe('plain\nFixes-PR: #605\nmore');
  });

  it('drops a fenced code block entirely, including any Fixes-PR line inside it', () => {
    const out = stripFencedAndCommented('before\n```\nFixes-PR: #605\n```\nafter');
    expect(out).not.toContain('Fixes-PR');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('drops an HTML comment entirely', () => {
    const out = stripFencedAndCommented('before\n<!-- Fixes-PR: #605 -->\nafter');
    expect(out).not.toContain('Fixes-PR');
  });

  it('runs an unclosed fence to the end of the body', () => {
    const out = stripFencedAndCommented('kept\n```\nFixes-PR: #605\nstill inside, never closed');
    expect(out).not.toContain('Fixes-PR');
    expect(out).toContain('kept');
  });
});

describe('extractFixesPrNumbers — P3', () => {
  it('extracts multiple numbers from one line', () => {
    expect(extractFixesPrNumbers('Fixes-PR: #605, #620')).toEqual([605, 620]);
  });

  it('extracts numbers from separate Fixes-PR lines', () => {
    expect(extractFixesPrNumbers('Fixes-PR: #605\nsome text\nFixes-PR: #620')).toEqual([605, 620]);
  });

  it('ignores a cross-repo owner/repo#N reference', () => {
    expect(extractFixesPrNumbers('Fixes-PR: nanocoai/nanoclaw#605')).toEqual([]);
  });

  it('ignores an "(upstream ...)" parenthetical', () => {
    expect(extractFixesPrNumbers('Fixes-PR: none (upstream #605 already covers this)')).toEqual([]);
  });

  it('credits nothing when none and a number both appear on the same line', () => {
    expect(extractFixesPrNumbers('Fixes-PR: none #2')).toEqual([]);
  });

  it('credits nothing when none and a number appear on separate lines', () => {
    expect(extractFixesPrNumbers('Fixes-PR: none\nFixes-PR: #2')).toEqual([]);
  });

  it('strips a Fixes-PR line inside a fenced code block before reading the rest', () => {
    expect(extractFixesPrNumbers('before\n```\nFixes-PR: #605\n```\nFixes-PR: #620')).toEqual([620]);
  });

  it('strips a Fixes-PR line inside an HTML comment before reading the rest', () => {
    expect(extractFixesPrNumbers('<!-- Fixes-PR: #605 -->\nFixes-PR: #620')).toEqual([620]);
  });

  it('extractFixesPrNumber (singular) returns the first credited number, or null', () => {
    expect(extractFixesPrNumber('Fixes-PR: #605, #620')).toBe(605);
    expect(extractFixesPrNumber('Fixes-PR: none #2')).toBeNull();
  });
});

// #653 is the PR that originally shipped this file — its own body quotes another PR's
// revert-shaped title and refers to a real revert in prose, mid-sentence. These are its
// EXACT lines (gh pr view 653 --json body), never a paraphrase — the false positive
// depends on precisely where each line starts.
describe('isRevertOf / isRevertPR — #653 false-positive regression (P2 #3)', () => {
  it('does not read a quoted revert title or descriptive prose as a revert declaration', () => {
    const target = pr({ number: 608, title: 'runner: end a task stream after its result' });
    const candidate = pr({
      number: 653,
      title: 'feat(scripts): review-outcomes, the risk-based review measurement query',
      body: [
        "- **Revert matching** — I had to generalize this beyond the literal brief. This repo's real",
        '  revert PRs don\'t follow GitHub\'s auto-revert template (`Revert "..."` title, "This',
        '  reverts pull request #N." body); e.g. #610 reverting #608 is titled',
        '  `revert(runner): back out ending a task stream after its result (#608)` — the same',
        '  conventional-commit prefix `FIX_TITLE_RE` uses for fixes. So the title rule is',
        '',
        '  extraction, fix-title/overlap matching, revert matching including the real #610 shape,',
        '',
        'class is consistent with the one real revert in the window (#610 reverting #608) — #608',
      ].join('\n'),
    });
    expect(isRevertOf(candidate, target)).toBe(false);
    expect(isRevertPR(candidate)).toBe(false);
  });
});

describe('renderWeeklyMarkdown', () => {
  it('shows only the most recent weeksToShow rows out of a longer history, plainly stating n', () => {
    const prs = Array.from({ length: 10 }, (_, i) =>
      pr({ number: i + 1, mergedAt: new Date(Date.UTC(2026, 0, 1) + i * 7 * 24 * 60 * 60 * 1000).toISOString() }),
    );
    const weekly = computeWeeklyReport(prs, [], 14, '2027-01-01T00:00:00Z');
    const options: Options = {
      repo: 'x/y',
      switchIso: '2026-02-01T00:00:00Z',
      days: 30,
      followupDays: 14,
      json: false,
    };
    const cumulative = computeReport(prs, [], options);
    const markdown = renderWeeklyMarkdown(weekly, cumulative, testWindow(), 8);
    expect(weekly.rows).toHaveLength(10);
    expect(markdown).toContain('Last 8 week(s) of 10 total');
    // The two oldest weeks are sliced off; only the eight most recent isoWeek keys appear.
    expect(markdown).not.toContain(weekly.rows[0]!.isoWeek);
    expect(markdown).not.toContain(weekly.rows[1]!.isoWeek);
    expect(markdown).toContain(weekly.rows[9]!.isoWeek);
  });

  it('includes the cumulative before/after comparison', () => {
    const prs = [pr({ number: 1, mergedAt: '2026-09-08T00:00:00Z' })];
    const weekly = computeWeeklyReport(prs, [], 14, '2026-09-12T00:00:00Z');
    const options: Options = { repo: 'x/y', switchIso: '2026-09-10T00:00:00Z', days: 5, followupDays: 14, json: false };
    const cumulative = computeReport(prs, [], options);
    const markdown = renderWeeklyMarkdown(weekly, cumulative, testWindow(), 8);
    expect(markdown).toContain('Cumulative');
    expect(markdown).toContain(cumulative.switchIso);
  });

  it('#717 review round 2 (P3): includes the window line naming since/until and the origin/main commit untilIso came from', () => {
    const prs = [pr({ number: 1, mergedAt: '2026-09-08T00:00:00Z' })];
    const weekly = computeWeeklyReport(prs, [], 14, '2026-09-12T00:00:00Z');
    const options: Options = { repo: 'x/y', switchIso: '2026-09-10T00:00:00Z', days: 5, followupDays: 14, json: false };
    const cumulative = computeReport(prs, [], options);
    const window = testWindow({
      sinceIso: '2026-08-01T00:00:00.000Z',
      untilIso: '2026-09-12T00:00:00.000Z',
      tip: testMainTip({ shortSha: 'deadbee', tipIso: '2026-09-12T00:02:00.000Z' }),
    });
    // Close to the window's own `untilIso`, so the window-age note does not muddy this
    // assertion — that path is covered by the dedicated window-age tests below.
    const markdown = renderWeeklyMarkdown(weekly, cumulative, window, 8, '2026-09-12T00:05:00.000Z');
    expect(markdown).toContain(formatWeeklyWindowLine(window));
    expect(markdown).toContain(
      'window: 2026-08-01T00:00:00.000Z..2026-09-12T00:00:00.000Z (origin/main deadbee @ 2026-09-12T00:02:00.000Z)',
    );
  });

  it('adds a neutral window-age note past the threshold without calling a quiet checkout stale', () => {
    const prs = [pr({ number: 1, mergedAt: '2026-09-08T00:00:00Z' })];
    const weekly = computeWeeklyReport(prs, [], 14, '2026-09-12T00:00:00Z');
    const options: Options = { repo: 'x/y', switchIso: '2026-09-10T00:00:00Z', days: 5, followupDays: 14, json: false };
    const cumulative = computeReport(prs, [], options);
    const untilIso = '2026-09-12T00:00:00.000Z';
    const window = testWindow({ untilIso });

    // Exactly at the threshold: no note.
    const atThresholdNowIso = new Date(new Date(untilIso).getTime() + WINDOW_AGE_NOTE_THRESHOLD_MS).toISOString();
    const noNoteMarkdown = renderWeeklyMarkdown(weekly, cumulative, window, 8, atThresholdNowIso);
    expect(noNoteMarkdown).not.toContain('report window ends');

    // One millisecond past the threshold: neutral context appears, with no stale/fetch claim.
    const pastThresholdNowIso = new Date(new Date(untilIso).getTime() + WINDOW_AGE_NOTE_THRESHOLD_MS + 1).toISOString();
    const agedMarkdown = renderWeeklyMarkdown(weekly, cumulative, window, 8, pastThresholdNowIso);
    expect(agedMarkdown).toContain('report window ends 1.0h before this run');
    expect(agedMarkdown).toContain('commit age does not establish checkout freshness');
    expect(agedMarkdown).not.toMatch(/looks stale|fetch/i);
  });
});

describe('printWeeklyReport', () => {
  it('prints the window line and neutral window-age note only past the threshold', () => {
    const prs = [pr({ number: 1, mergedAt: '2026-09-08T00:00:00Z' })];
    const weekly = computeWeeklyReport(prs, [], 14, '2026-09-12T00:00:00Z');
    const untilIso = '2026-09-12T00:00:00.000Z';
    const window = testWindow({ untilIso });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printWeeklyReport(weekly, window, untilIso); // fresh — nowIso == untilIso
      const freshOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(freshOutput).toContain(formatWeeklyWindowLine(window));
      expect(freshOutput).not.toContain('report window ends');

      logSpy.mockClear();
      const agedNowIso = new Date(new Date(untilIso).getTime() + WINDOW_AGE_NOTE_THRESHOLD_MS + 1).toISOString();
      printWeeklyReport(weekly, window, agedNowIso);
      const agedOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(agedOutput).toContain(formatWeeklyWindowLine(window));
      expect(agedOutput).toContain('report window ends 1.0h before this run');
      expect(agedOutput).toContain('commit age does not establish checkout freshness');
      expect(agedOutput).not.toMatch(/looks stale|fetch/i);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('formatWindowAgeNote — mutation coverage for the window-age comparison', () => {
  it('is null at and below the threshold, non-null just past it', () => {
    const untilIso = '2026-09-12T00:00:00.000Z';
    const atThreshold = new Date(new Date(untilIso).getTime() + WINDOW_AGE_NOTE_THRESHOLD_MS).toISOString();
    const justPast = new Date(new Date(untilIso).getTime() + WINDOW_AGE_NOTE_THRESHOLD_MS + 1).toISOString();
    const wellBelow = new Date(new Date(untilIso).getTime() + 1000).toISOString();

    expect(formatWindowAgeNote(untilIso, wellBelow)).toBeNull();
    expect(formatWindowAgeNote(untilIso, atThreshold)).toBeNull();
    expect(formatWindowAgeNote(untilIso, justPast)).toContain('report window ends 1.0h before this run');
  });

  it('does not render NaN for invalid timestamps', () => {
    expect(formatWindowAgeNote('invalid', '2026-09-12T02:00:00.000Z')).toBeNull();
    expect(formatWindowAgeNote('2026-09-12T00:00:00.000Z', 'invalid')).toBeNull();
  });
});

describe('parseGitNameStatus — NUL-separated (`-z`) fields', () => {
  it('parses an ordinary modify/add/delete field-run as {status, path}', () => {
    expect(parseGitNameStatus('M\0src/a.ts\0')).toEqual([{ status: 'M', path: 'src/a.ts' }]);
    expect(parseGitNameStatus('A\0src/new.ts\0')).toEqual([{ status: 'A', path: 'src/new.ts' }]);
    expect(parseGitNameStatus('D\0src/gone.ts\0')).toEqual([{ status: 'D', path: 'src/gone.ts' }]);
  });

  it('parses a rename/copy field-run as {status, previousPath, path}', () => {
    expect(parseGitNameStatus('R100\0old.ts\0new.ts\0')).toEqual([
      { status: 'R100', previousPath: 'old.ts', path: 'new.ts' },
    ]);
    expect(parseGitNameStatus('C75\0src/a.ts\0src/b.ts\0')).toEqual([
      { status: 'C75', previousPath: 'src/a.ts', path: 'src/b.ts' },
    ]);
  });

  it('parses multiple entries in one NUL-separated run', () => {
    expect(parseGitNameStatus('M\0a.ts\0R100\0b.ts\0c.ts\0')).toEqual([
      { status: 'M', path: 'a.ts' },
      { status: 'R100', previousPath: 'b.ts', path: 'c.ts' },
    ]);
  });

  it('is empty for empty input', () => {
    expect(parseGitNameStatus('')).toEqual([]);
  });

  it('handles a non-ASCII path — the whole point of `-z`: no quoting to strip, unlike the tab/newline format', () => {
    expect(parseGitNameStatus('M\0src/café.ts\0')).toEqual([{ status: 'M', path: 'src/café.ts' }]);
  });

  it('handles a renamed non-ASCII path (both old and new) with `-z`', () => {
    expect(parseGitNameStatus('R100\0src/café-old.ts\0src/café-new.ts\0')).toEqual([
      { status: 'R100', previousPath: 'src/café-old.ts', path: 'src/café-new.ts' },
    ]);
  });
});

describe('fetchAtMergeLabelEventsBatch — GraphQL failure does not kill the run', () => {
  it('returns an empty map instead of throwing when `gh` itself is blocked/unavailable', () => {
    // `gh` is never allowlisted in this file (only `git` is, for the fixture-repo block
    // below) — enforceHermeticity() makes any `execFileSync('gh', ...)` throw before it
    // reaches a real binary, which stands in exactly for a real GraphQL/network
    // failure. The function must catch that, log once, and hand back an empty map so
    // the caller marks those PRs unresolved and moves on to the next batch. The blocked
    // call is a DELIBERATE hermeticity trip, asserted on below and cleared, not an
    // accidental escape.
    expect(() => fetchAtMergeLabelEventsBatch('owner/repo', [1, 2, 3])).not.toThrow();
    const result = fetchAtMergeLabelEventsBatch('owner/repo', [1, 2, 3]);
    expect(result.size).toBe(0);
    expect(hermeticityAttempts().length).toBeGreaterThan(0);
    expect(hermeticityAttempts()[0]).toMatchObject({ kind: 'subprocess', api: 'execFileSync', target: 'gh' });
    clearHermeticityAttempts();
  });
});

describe('at-merge replay from local git (fixture repo, no network) — P2', () => {
  let repoDir: string;
  let baseCommit: string;
  let mergeCommit: string; // squash-shaped (1 parent): grows the glob list AND renames a file
  let originalCwd: string;

  function fixtureGit(args: string[]): string {
    return execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...args], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
  }

  beforeAll(() => {
    originalCwd = process.cwd();
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revmetrics-at-merge-fixture-'));
    fixtureGit(['init', '-q', '-b', 'main']);
    fs.mkdirSync(path.join(repoDir, '.github'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, '.github', 'labeler.yml'),
      "risk:high:\n- changed-files:\n  - any-glob-to-any-file:\n    - 'src/guard/**'\n",
    );
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src', 'old-name.ts'), 'old content\n');
    fixtureGit(['add', '-A']);
    fixtureGit(['commit', '-q', '-m', 'base: add labeler.yml and old-name.ts']);
    baseCommit = fixtureGit(['rev-parse', 'HEAD']);

    // Grow the glob list AND rename a file (pure rename, unchanged content — `-M`'s
    // default 50% similarity threshold trivially detects it as R100).
    fs.writeFileSync(
      path.join(repoDir, '.github', 'labeler.yml'),
      "risk:high:\n- changed-files:\n  - any-glob-to-any-file:\n    - 'src/guard/**'\n    - 'src/new-risky/**'\n",
    );
    fs.mkdirSync(path.join(repoDir, 'src', 'new-risky'), { recursive: true });
    fixtureGit(['mv', 'src/old-name.ts', 'src/new-risky/renamed.ts']);
    fixtureGit(['add', '-A']);
    fixtureGit(['commit', '-q', '-m', 'grow labeler.yml globs and rename a file']);
    mergeCommit = fixtureGit(['rev-parse', 'HEAD']);

    // review-outcomes.ts's internal `git()` helper inherits process.cwd() (see the
    // file header: "the script must run the same way against the checkout") — point it
    // at the fixture for the rest of this describe block.
    process.chdir(repoDir);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('mergeCommitParentsLocal reads the real parent from local git', () => {
    expect(mergeCommitParentsLocal(mergeCommit)).toEqual([baseCommit]);
  });

  it('mergeCommitParentsLocal reads BOTH parents, in order, for a genuine 2-parent merge commit', () => {
    // A separate throwaway repo: base branch + a feature branch merged with --no-ff,
    // so this is a REAL 2-parent GitHub-shaped merge commit, not a squash.
    const twoParentRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'revmetrics-2parent-fixture-'));
    function g(args: string[]): string {
      return execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...args], {
        cwd: twoParentRepo,
        encoding: 'utf8',
      }).trim();
    }
    g(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(twoParentRepo, 'a.txt'), 'a\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base']);
    const mainTip = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(twoParentRepo, 'b.txt'), 'b\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'feature work']);
    const featureHead = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', 'main']);
    g(['merge', '--no-ff', '-q', '-m', 'Merge feature', 'feature']);
    const twoParentMerge = g(['rev-parse', 'HEAD']);
    process.chdir(twoParentRepo);
    try {
      expect(mergeCommitParentsLocal(twoParentMerge)).toEqual([mainTip, featureHead]);
    } finally {
      process.chdir(repoDir);
      fs.rmSync(twoParentRepo, { recursive: true, force: true });
    }
  });

  it('mergeCommitParentsLocal is null for a commit not resolvable locally (shallow clone / force-pushed-away base)', () => {
    expect(mergeCommitParentsLocal('0000000000000000000000000000000000000000')).toBeNull();
  });

  it('mergeCommitParentsLocal no longer fetches a commit that merged AFTER the local checkout was taken — it stays null, same as any other local miss', () => {
    // #717 review round 2 (#706 round-1 P2): round 1 covered this exact race — a PR
    // merging into `main` in the gap between `review-metrics.yml`'s `actions/checkout`
    // and this script's live `gh pr list --search` call minutes later — with a
    // `git fetch --no-tags origin <sha>` retry on a local miss. That retry cannot
    // authenticate in Actions: the repo is private, and the workflow checks out with
    // `persist-credentials: false` (confirmed against workflow run 34675405074's log,
    // which shows checkout removing its auth header), so it only ever worked on a host
    // with its own git credential helper — never in CI, where the fallback was added to
    // fix exactly this. The real fix caps the search window's end at `origin/main`'s own
    // tip (`resolveMainTipUntilIso`), so a PR like commit B below is excluded from the
    // window entirely (see the `resolveMainTipUntilIso` describe block below) and this
    // function is never even called with its sha in a real run. `commitExistsLocally`
    // therefore no longer attempts any fetch at all — this test pins that removal: a
    // commit merged after the checkout stays an ordinary, un-fetched local miss.
    //
    // `origin` here is a second real repo on local disk, standing in for GitHub: no
    // network needed for this test — `git fetch` treats a filesystem path exactly like
    // any other remote.
    const upstreamRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'revmetrics-fetch-origin-upstream-'));
    function u(args: string[]): string {
      return execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...args], {
        cwd: upstreamRepo,
        encoding: 'utf8',
      }).trim();
    }
    u(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(upstreamRepo, 'a.txt'), 'a\n');
    u(['add', '-A']);
    u(['commit', '-q', '-m', 'commit A — present in the checkout']);

    // Cloned BEFORE commit B exists upstream, so this clone (standing in for the CI
    // job's `actions/checkout`) genuinely never saw it — not merely reset away from it.
    const localRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'revmetrics-fetch-origin-local-'));
    execFileSync('git', ['clone', '-q', upstreamRepo, localRepo], { encoding: 'utf8' });

    // NOW a PR "merges" into upstream main — after the local clone was taken, exactly
    // the mid-run race #706 round 1 tried (and failed, in CI) to paper over.
    fs.writeFileSync(path.join(upstreamRepo, 'b.txt'), 'b\n');
    u(['add', '-A']);
    u(['commit', '-q', '-m', 'commit B — merges into main mid-run, after the checkout']);
    const commitB = u(['rev-parse', 'HEAD']);

    process.chdir(localRepo);
    try {
      // Sanity check first: the local clone genuinely does not have commit B yet — if
      // this stops holding, the fixture no longer reproduces the race.
      expect(() => execFileSync('git', ['cat-file', '-e', `${commitB}^{commit}`])).toThrow();
      // No fetch fallback any more: this stays null, exactly like the zero-SHA case
      // above, never a network round trip.
      expect(mergeCommitParentsLocal(commitB)).toBeNull();
    } finally {
      process.chdir(repoDir);
      fs.rmSync(localRepo, { recursive: true, force: true });
      fs.rmSync(upstreamRepo, { recursive: true, force: true });
    }
  });

  it('readRiskHighGlobsAtShaLocal reads risk:high globs AT the base commit, not the merge commit', () => {
    expect(readRiskHighGlobsAtShaLocal(baseCommit)).toEqual({ kind: 'found', globs: ['src/guard/**'] });
  });

  it('readRiskHighGlobsAtShaLocal is "missing" (not "error") when the commit exists but predates labeler.yml', () => {
    const preLabelerRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'revmetrics-pre-labeler-fixture-'));
    function g(args: string[]): string {
      return execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...args], {
        cwd: preLabelerRepo,
        encoding: 'utf8',
      }).trim();
    }
    g(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(preLabelerRepo, 'README.md'), 'no labeler yet\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'pre-labeler commit']);
    const preLabelerCommit = g(['rev-parse', 'HEAD']);
    process.chdir(preLabelerRepo);
    try {
      expect(readRiskHighGlobsAtShaLocal(preLabelerCommit)).toEqual({ kind: 'missing' });
    } finally {
      process.chdir(repoDir);
      fs.rmSync(preLabelerRepo, { recursive: true, force: true });
    }
  });

  it('readRiskHighGlobsAtShaLocal is "error" for a commit that is not resolvable at all', () => {
    expect(readRiskHighGlobsAtShaLocal('0000000000000000000000000000000000000000')).toEqual({ kind: 'error' });
  });

  it('readRiskHighGlobsAtShaLocal is "error" (NOT "missing") when the path exists but its content cannot be read', () => {
    // Simulates a partial/lazy checkout that has the tree entry (so `git cat-file -e
    // <sha>:.github/labeler.yml` succeeds — the file genuinely exists here) but not the
    // blob's content (so `git show` fails) — the exact gap `readRiskHighGlobsAtShaLocal`'s
    // own doc comment describes. Before this fix, every `git show` failure — this one
    // included — was read as "missing", which `resolveAtMergeContexts` reclassifies as
    // pre-gate; that would be wrong here, since the file DOES exist at this commit.
    const original = nodeChildProcess.execFileSync;
    const labelerShowArgs = ['show', `${baseCommit}:.github/labeler.yml`];
    const spy = vi
      .spyOn(nodeChildProcess, 'execFileSync')
      .mockImplementation((...callArgs: Parameters<typeof nodeChildProcess.execFileSync>) => {
        const [command, cmdArgs] = callArgs;
        if (command === 'git' && Array.isArray(cmdArgs) && cmdArgs[0] === 'show' && cmdArgs[1] === labelerShowArgs[1]) {
          throw new Error('simulated: blob content unavailable even though the tree entry exists');
        }
        return (original as (...a: unknown[]) => unknown)(...callArgs) as ReturnType<
          typeof nodeChildProcess.execFileSync
        >;
      });
    try {
      // Sanity check first: the path DOES resolve via cat-file -e (unmocked) at this sha —
      // otherwise this test would trivially pass for the wrong reason ("missing" either way).
      expect(() => execFileSync('git', ['cat-file', '-e', `${baseCommit}:.github/labeler.yml`])).not.toThrow();
      expect(readRiskHighGlobsAtShaLocal(baseCommit)).toEqual({ kind: 'error' });
    } finally {
      spy.mockRestore();
    }
  });

  it('readRiskHighGlobsAtShaLocal is "error" (NOT "missing") when the tree entry is intact but the loose blob object is gone — the real partial-clone bug, not a mocked `git show` failure', () => {
    // Round 4's P3 #1 on #706: `labelerPathExistsAtSha` used to be `git cat-file -e
    // <sha>:.github/labeler.yml`, which resolves the tree walk AND THEN verifies the
    // blob object it names exists in the local object database. A partial/lazy clone
    // (`--filter=blob:none`) can have the tree entry — the path genuinely exists at this
    // commit — while missing that one blob. This fixture reproduces exactly that: a
    // real repo, a real commit, then the loose blob object for `.github/labeler.yml`
    // deleted straight out of `.git/objects` while its tree entry is left untouched.
    const partialCloneRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'revmetrics-partial-clone-fixture-'));
    function g(args: string[]): string {
      return execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...args], {
        cwd: partialCloneRepo,
        encoding: 'utf8',
      }).trim();
    }
    g(['init', '-q', '-b', 'main']);
    fs.mkdirSync(path.join(partialCloneRepo, '.github'), { recursive: true });
    fs.writeFileSync(
      path.join(partialCloneRepo, '.github', 'labeler.yml'),
      "risk:high:\n- changed-files:\n  - any-glob-to-any-file:\n    - 'src/guard/**'\n",
    );
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base with labeler.yml']);
    const partialCloneCommit = g(['rev-parse', 'HEAD']);
    const blobSha = g(['rev-parse', `${partialCloneCommit}:.github/labeler.yml`]);

    // Delete the loose blob object directly. The tree entry (the parent tree object's
    // own recorded `<mode> <name>\0<oid>` listing) is never touched by this — only the
    // blob object itself, the thing `cat-file -e` additionally checks and `rev-parse
    // --verify` does not.
    const objectPath = path.join(partialCloneRepo, '.git', 'objects', blobSha.slice(0, 2), blobSha.slice(2));
    expect(fs.existsSync(objectPath)).toBe(true);
    fs.chmodSync(objectPath, 0o644);
    fs.unlinkSync(objectPath);
    expect(fs.existsSync(objectPath)).toBe(false);

    process.chdir(partialCloneRepo);
    try {
      // Sanity checks first, both unmocked — if either stops holding, this fixture no
      // longer reproduces the bug it exists to catch.
      // (1) the OLD implementation's check fails here even though the path exists at
      // this commit — reproducing the exact misclassification round 4 flagged.
      expect(() => execFileSync('git', ['cat-file', '-e', `${partialCloneCommit}:.github/labeler.yml`])).toThrow();
      // (2) the FIX's tree-only check still resolves the entry without touching the
      // missing blob.
      expect(() =>
        execFileSync('git', ['rev-parse', '--verify', '-q', `${partialCloneCommit}:.github/labeler.yml`]),
      ).not.toThrow();
      expect(readRiskHighGlobsAtShaLocal(partialCloneCommit)).toEqual({ kind: 'error' });
    } finally {
      process.chdir(repoDir);
      fs.rmSync(partialCloneRepo, { recursive: true, force: true });
    }
  });

  it('fileDiffAtMergeLocal includes BOTH the old and new path of a rename', () => {
    const files = fileDiffAtMergeLocal(baseCommit, mergeCommit, 2);
    expect(files).not.toBeNull();
    expect(files).not.toBe('over-cap');
    expect(files).toContain('src/old-name.ts');
    expect(files).toContain('src/new-risky/renamed.ts');
    expect(files).toContain('.github/labeler.yml');
  });

  it("fileDiffAtMergeLocal is null (fail closed) when the changedFiles count does not match — mirrors the gate's completeness rule", () => {
    expect(fileDiffAtMergeLocal(baseCommit, mergeCommit, 99)).toBeNull();
  });

  it('fileDiffAtMergeLocal returns "over-cap" — never null/unresolved — at >=300 changed files, matching codex-review.sh:764 exactly', () => {
    const bigRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revmetrics-over-cap-fixture-'));
    function g(args: string[]): string {
      return execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...args], {
        cwd: bigRepoDir,
        encoding: 'utf8',
      }).trim();
    }
    g(['init', '-q', '-b', 'main']);
    // A labeler.yml at the base is required so `readRiskHighGlobsAtShaLocal` reaches
    // 'found' (not 'missing') — otherwise `resolveAtMergeFileContextLocal` short-circuits
    // to 'pre-gate' before it ever reaches the file-diff/over-cap check this test targets.
    fs.mkdirSync(path.join(bigRepoDir, '.github'), { recursive: true });
    fs.writeFileSync(
      path.join(bigRepoDir, '.github', 'labeler.yml'),
      "risk:high:\n- changed-files:\n  - any-glob-to-any-file:\n    - 'src/guard/**'\n",
    );
    fs.writeFileSync(path.join(bigRepoDir, 'README.md'), 'base\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base']);
    const base = g(['rev-parse', 'HEAD']);
    // 300 new files in one commit — GitHub's own `compare` endpoint truncates its file
    // listing at exactly this count (docs.github.com/en/rest/commits/commits#compare-two-commits),
    // which is why codex-review.sh:764's `$listed >= 300` check always trips for a real
    // >=300-file PR and answers `review` deterministically.
    for (let i = 0; i < 300; i += 1) {
      fs.writeFileSync(path.join(bigRepoDir, `file-${i}.txt`), `${i}\n`);
    }
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'add 300 files']);
    const big = g(['rev-parse', 'HEAD']);
    process.chdir(bigRepoDir);
    try {
      expect(fileDiffAtMergeLocal(base, big, 300)).toBe('over-cap');
      const ctx = resolveAtMergeFileContextLocal({ mergeCommitOid: big, headRefOid: big, changedFiles: 300 });
      expect(ctx).toEqual({ kind: 'review' });
    } finally {
      process.chdir(repoDir);
      fs.rmSync(bigRepoDir, { recursive: true, force: true });
    }
  });

  it('fileDiffAtMergeLocal returns the exact non-ASCII path, unquoted — the `-z` fix (P3)', () => {
    const utfRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revmetrics-nonascii-fixture-'));
    function g(args: string[]): string {
      return execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...args], {
        cwd: utfRepoDir,
        encoding: 'utf8',
      }).trim();
    }
    g(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(utfRepoDir, 'README.md'), 'base\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base']);
    const base = g(['rev-parse', 'HEAD']);
    // A non-ASCII byte (0xC3 0xA9, UTF-8 for "é") in the path is exactly what
    // `core.quotePath` (on by default) wraps in C-style double-quoted/octal-escaped form
    // WITHOUT `-z` — see `GitDiffEntry`'s own doc comment.
    fs.mkdirSync(path.join(utfRepoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(utfRepoDir, 'src', 'café.ts'), 'content\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'add a non-ASCII path']);
    const withNonAscii = g(['rev-parse', 'HEAD']);
    // Sanity check: WITHOUT -z, git really does quote this path — proves the bug this
    // fix addresses is real, not merely hypothetical.
    const quotedRaw = g(['diff', '--name-status', '-M', base, withNonAscii]);
    expect(quotedRaw).toContain('"'); // core.quotePath's C-style quoting kicks in
    expect(quotedRaw).not.toContain('café.ts'); // the raw UTF-8 name is NOT what appears
    process.chdir(utfRepoDir);
    try {
      const files = fileDiffAtMergeLocal(base, withNonAscii, 1);
      expect(files).toEqual(['src/café.ts']);
    } finally {
      process.chdir(repoDir);
      fs.rmSync(utfRepoDir, { recursive: true, force: true });
    }
  });

  it('fileDiffAtMergeLocal returns a renamed non-ASCII path, unquoted, both old and new sides — the `-z` fix (P3)', () => {
    const utfRenameRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revmetrics-nonascii-rename-fixture-'));
    function g(args: string[]): string {
      return execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...args], {
        cwd: utfRenameRepoDir,
        encoding: 'utf8',
      }).trim();
    }
    g(['init', '-q', '-b', 'main']);
    fs.mkdirSync(path.join(utfRenameRepoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(utfRenameRepoDir, 'src', 'café-old.ts'), 'content\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base with a non-ASCII path']);
    const base = g(['rev-parse', 'HEAD']);
    g(['mv', 'src/café-old.ts', 'src/café-new.ts']);
    g(['commit', '-q', '-m', 'rename a non-ASCII path to another non-ASCII path']);
    const renamed = g(['rev-parse', 'HEAD']);
    process.chdir(utfRenameRepoDir);
    try {
      const files = fileDiffAtMergeLocal(base, renamed, 1);
      expect(files).not.toBeNull();
      expect(files).not.toBe('over-cap');
      expect(files).toContain('src/café-old.ts');
      expect(files).toContain('src/café-new.ts');
    } finally {
      process.chdir(repoDir);
      fs.rmSync(utfRenameRepoDir, { recursive: true, force: true });
    }
  });

  it('resolveAtMergeFileContextLocal resolves the full file+glob context in one call', () => {
    const ctx = resolveAtMergeFileContextLocal({
      mergeCommitOid: mergeCommit,
      headRefOid: mergeCommit,
      changedFiles: 2,
    });
    expect(ctx.kind).toBe('resolved');
    if (ctx.kind === 'resolved') {
      expect(ctx.riskHighGlobs).toEqual(['src/guard/**']); // the AT-MERGE (base) list, not the grown one
      expect(ctx.files).toContain('src/new-risky/renamed.ts');
    }
  });

  it('resolveAtMergeFileContextLocal is "pre-gate" when the base predates labeler.yml', () => {
    const preLabelerRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'revmetrics-pre-labeler-ctx-'));
    function g(args: string[]): string {
      return execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...args], {
        cwd: preLabelerRepo,
        encoding: 'utf8',
      }).trim();
    }
    g(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(preLabelerRepo, 'README.md'), 'no labeler yet\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'pre-labeler']);
    fs.writeFileSync(path.join(preLabelerRepo, 'README.md'), 'still no labeler\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'a one-parent "merge" onto the pre-labeler base']);
    const squashCommit = g(['rev-parse', 'HEAD']);
    process.chdir(preLabelerRepo);
    try {
      const ctx = resolveAtMergeFileContextLocal({
        mergeCommitOid: squashCommit,
        headRefOid: squashCommit,
        changedFiles: 1,
      });
      expect(ctx).toEqual({ kind: 'pre-gate' });
    } finally {
      process.chdir(repoDir);
      fs.rmSync(preLabelerRepo, { recursive: true, force: true });
    }
  });

  it('resolveAtMergeFileContextLocal is "unresolved" for a merge commit oid that is not resolvable locally', () => {
    const ctx = resolveAtMergeFileContextLocal({
      mergeCommitOid: '0000000000000000000000000000000000000000',
      headRefOid: '0000000000000000000000000000000000000000',
      changedFiles: 1,
    });
    expect(ctx).toEqual({ kind: 'unresolved' });
  });

  describe('the #620-style regression, replayed against a real fixture repo', () => {
    const CURRENT_RISK_GLOBS = ['src/guard/**', 'src/new-risky/**']; // grown AFTER this "merge"

    it('classifies skip under the AT-MERGE glob list even though the CURRENT (grown) list would flip it to review', () => {
      const ctx = resolveAtMergeFileContextLocal({
        mergeCommitOid: mergeCommit,
        headRefOid: mergeCommit,
        changedFiles: 2,
      });
      expect(ctx.kind).toBe('resolved');
      if (ctx.kind !== 'resolved') return;
      expect(classifyAtMergeVerdict({ files: ctx.files, labels: [], riskHighGlobs: ctx.riskHighGlobs })).toBe('skip');
    });

    it('sanity check: the SAME files classify review under the CURRENT (grown) glob list — confirms a real divergence', () => {
      const ctx = resolveAtMergeFileContextLocal({
        mergeCommitOid: mergeCommit,
        headRefOid: mergeCommit,
        changedFiles: 2,
      });
      expect(ctx.kind).toBe('resolved');
      if (ctx.kind !== 'resolved') return;
      expect(classifyAtMergeVerdict({ files: ctx.files, labels: [], riskHighGlobs: CURRENT_RISK_GLOBS })).toBe(
        'review',
      );
    });
  });
});

describe('resolveMainTipUntilIso — #717 review round 2 (#706 round-1 P2 fix): deterministic search window end', () => {
  const originalCwd = process.cwd();

  function fixtureGit(dir: string, args: string[], extraEnv?: Record<string, string>): string {
    return execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    }).trim();
  }

  function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revmetrics-untiliso-'));
    fixtureGit(dir, ['init', '-q', '-b', 'main']);
    return dir;
  }

  /** Commits `file` with an EXPLICIT author/committer date, so ordering between commits
   *  is deterministic and never depends on real wall-clock timing between two `git
   *  commit` calls in the same test. */
  function commitAt(dir: string, file: string, contents: string, isoDate: string): string {
    fs.writeFileSync(path.join(dir, file), contents);
    fixtureGit(dir, ['add', '-A']);
    fixtureGit(dir, ['commit', '-q', '-m', `commit at ${isoDate}`], {
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
    });
    return fixtureGit(dir, ['rev-parse', 'HEAD']);
  }

  it('equals the tip commit committer time minus the margin, read from origin/main (not HEAD)', () => {
    const upstreamRepo = makeRepo();
    const tipIso = '2026-08-01T12:00:00+00:00';
    commitAt(upstreamRepo, 'a.txt', 'a\n', tipIso);

    const localRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'revmetrics-untiliso-local-'));
    execFileSync('git', ['clone', '-q', upstreamRepo, localRepo], { encoding: 'utf8' });
    // A local run may have some other branch checked out — `resolveMainTipUntilIso` must
    // read `origin/main`, not whatever `HEAD` happens to be, so check out a decoy branch
    // here to prove that.
    fixtureGit(localRepo, ['checkout', '-q', '-b', 'some-other-branch']);

    process.chdir(localRepo);
    try {
      const untilIso = resolveMainTipUntilIso();
      expect(untilIso).toBe(new Date(new Date(tipIso).getTime() - UNTIL_ISO_SEARCH_INDEX_LAG_MARGIN_MS).toISOString());
      // marginMs is overridable — a zero margin is the tip's committer time exactly.
      expect(resolveMainTipUntilIso(0)).toBe(new Date(tipIso).toISOString());
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(localRepo, { recursive: true, force: true });
      fs.rmSync(upstreamRepo, { recursive: true, force: true });
    }
  });

  it('a PR merging into main AFTER origin/main tip was read here falls after untilIso — excluded from the search window by construction, never reported unresolved', () => {
    // This is the property the #706 round-1 P2 fix depends on: with the search window's
    // `until` bound capped at `origin/main`'s own tip, a PR that merges into `main` in
    // the gap between `review-metrics.yml`'s `actions/checkout` and this script's live
    // `gh pr list --search` call minutes later can never fall INSIDE
    // `merged:<since>..<untilIso>` — GitHub's search qualifier would simply never return
    // it. That is a structurally different outcome from the #706 round-1 fix (a `git
    // fetch --no-tags origin <sha>` retry in `commitExistsLocally`, removed by this
    // change): such a PR is not "fetched and found missing", it is outside this run's
    // window entirely and is picked up whole, as an ordinary ancestor, by the next
    // scheduled run.
    const upstreamRepo = makeRepo();
    const tipIso = '2026-08-01T12:00:00+00:00';
    commitAt(upstreamRepo, 'a.txt', 'a\n', tipIso);

    const localRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'revmetrics-untiliso-local-'));
    execFileSync('git', ['clone', '-q', upstreamRepo, localRepo], { encoding: 'utf8' });

    let untilIso: string;
    process.chdir(localRepo);
    try {
      untilIso = resolveMainTipUntilIso();
    } finally {
      process.chdir(originalCwd);
    }

    // NOW a PR "merges" into upstream main — after `origin/main`'s tip was already read
    // above, exactly the mid-run race #706 round 1's fetch fallback tried (and failed,
    // in CI) to paper over. 5 minutes later, past even the margin.
    const midRunIso = '2026-08-01T12:05:00+00:00';
    commitAt(upstreamRepo, 'b.txt', 'b\n', midRunIso);

    expect(new Date(midRunIso).getTime()).toBeGreaterThan(new Date(untilIso).getTime());

    fs.rmSync(localRepo, { recursive: true, force: true });
    fs.rmSync(upstreamRepo, { recursive: true, force: true });
  });

  it('throws — never falls back to wall-clock time — when origin/main cannot be resolved at all', () => {
    const soloRepo = makeRepo();
    commitAt(soloRepo, 'a.txt', 'a\n', '2026-08-01T12:00:00+00:00');

    process.chdir(soloRepo);
    try {
      expect(() => resolveMainTipUntilIso()).toThrow(/resolveMainTipUntilIso.*origin\/main/);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(soloRepo, { recursive: true, force: true });
    }
  });
});
