import { describe, expect, it } from 'vitest';

import { enforceHermeticity } from '../src/test-hermeticity.js';

import {
  buildShadowReviewIndex,
  computeReport,
  extractFixesPrNumber,
  extractShadowReviewPrNumber,
  filesOverlap,
  findFollowUp,
  findRevert,
  globsForRiskHigh,
  isFixTitle,
  isLowRisk,
  isoWeekKey,
  issueHasP1,
  isRevertOf,
  isRevertPR,
  matchesAnyGlob,
  type Options,
  type PullRequestData,
  type ShadowReviewIssueData,
  weeklyRevertRate,
} from './review-outcomes.js';

// This suite never shells out or touches the network — every case here exercises the
// pure functions review-outcomes.ts factors out for exactly that reason.
enforceHermeticity();

function pr(overrides: Partial<PullRequestData> & { number: number }): PullRequestData {
  return {
    title: `pr #${overrides.number}`,
    body: '',
    mergedAt: '2026-09-01T00:00:00Z',
    files: [],
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
  });
});
