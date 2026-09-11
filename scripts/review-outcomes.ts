#!/usr/bin/env tsx
/**
 * Review-outcomes — the measurement query docs/specs/risk-based-review/plan.md's
 * "Measurement" section calls for: did low-risk PRs that merged without review draw
 * more follow-up fixes or reverts than low-risk PRs did while every PR was still
 * reviewed?
 *
 * Low-risk classification is a REPLAY, not a label read: it runs the same glob match
 * `.github/workflows/risk-label.yml` uses (actions/labeler v7) against every PR's
 * changed-file list, using the repo's CURRENT `.github/labeler.yml` `risk:high` globs
 * against every PR in the window — including ones merged before the labeler existed,
 * which carry no `risk:high` label at all (plan.md: "The audit could not compute this
 * retroactively"). actions/labeler v7 matches with `new Minimatch(glob, {dot})`
 * (`src/changedFiles.ts`, `checkIfAnyGlobMatchesAnyFile`), and its own `dot` input
 * defaults to `true` (`action.yml`) — `risk-label.yml` does not override it. This repo
 * has no `minimatch`/`picomatch`/`micromatch` as a DIRECT `package.json` dependency (a
 * `pnpm-lock.yaml` transitive hit isn't enough — the task authorizing this script
 * forbids adding one), so glob replay uses Node 22's built-in `path.matchesGlob`
 * (stable since v22.20.0, this repo requires >=22.13.0) instead. Verified equivalent
 * for every glob actually in `.github/labeler.yml` (globstar depth, case sensitivity,
 * literal leading dot in `.github/**`/`.husky/**`); the one known gap is that
 * `path.matchesGlob` does not extend `dot:true` to a wildcard segment matching a
 * dotfile deep inside a globstar (e.g. `src/.hidden/x.ts` against a `src` globstar
 * glob), which none of the current globs depend on since only literal-dot
 * directories appear.
 *
 * Follow-up and revert matching:
 * - `Fixes-PR:` link — same regex `codex-review.sh` uses at merge time
 *   (`FIXES_PR_LINE_RE`, `container/skills/pr-review-loop/scripts/codex-review.sh:486`),
 *   read case-insensitively, same as that script's `jq test($lineRe; "i")` call.
 * - fix-title overlap (`FIX_TITLE_RE`, same file:485) — the fallback ONLY when no PR
 *   links to the candidate, per plan.md's Measurement status: "same-subsystem
 *   follow-ups will be computed from git history instead, as a later `fix` PR ... that
 *   touches the same files" once the `Fixes-PR:` convention isn't consistently used.
 *   Generated files (the ratchet manifest, lockfiles) don't count as shared: see
 *   `GENERATED_FILES`. Overlap still over-counts in a busy repo, so read it as an upper
 *   bound; the link rate is the real signal once `Fixes-PR:` lines accumulate.
 * - revert — this repo's real revert PRs (e.g. #610, "revert(runner): back out ending
 *   a task stream after its result (#608)") do not follow GitHub's auto-revert
 *   template (`Revert "<title>"` / "This reverts pull request #N."); they use the same
 *   conventional-commit prefix as `FIX_TITLE_RE` does for fixes. So the title rule
 *   here is generalized from "starts with `Revert \"`" to "starts with the word
 *   revert" (covers both forms), and the body rule is one regex spanning both
 *   `Reverts #N` and `This reverts ... #N` (a bounded gap between the word and the
 *   number, verified against #610's actual body: "This reverts #608 (merge `...`)").
 *
 * Shadow-review counting — the direct measurement `docs/specs/risk-based-review/plan.md`'s
 * rollback section names as primary, over the file-overlap upper bound above:
 * `.github/workflows/shadow-review.yml` opens one issue per low-risk PR it finds a
 * problem in, titled `shadow review: #<n> <title>` and labeled `shadow-review`; a clean
 * PR gets a PR comment instead, no issue. So "was this skipped PR shadow-reviewed, and
 * did the review find a P1" is answerable from the issue list alone: match each issue's
 * title against `SHADOW_REVIEW_TITLE_RE` to recover the PR number, and its body against
 * `P1_RE` for whether any finding was severity P1 (the workflow's prompt has Claude label
 * every finding P1 or P2 inline, e.g. "- **P1** — file:line — ..."). This undercounts by
 * design: a low-risk PR with no shadow-review issue was either clean (a PR comment, not
 * an issue) or the workflow hasn't run yet — both read as "not shadow-reviewed", which is
 * the conservative direction for a metric whose job is to justify tightening the risk
 * list, not to over-claim coverage.
 *
 * Usage:
 *   pnpm exec tsx scripts/review-outcomes.ts [--repo owner/repo] [--switch <ISO>]
 *     [--days <n>] [--followup-days <n>] [--json]
 *
 * Defaults: --repo davekim917/nanoclaw, --switch 2026-09-10T00:00:00Z (when risk-scoped
 * review went live here), --days 30, --followup-days 14.
 */
import { execFileSync } from 'node:child_process';
import nodePath from 'node:path';

import { parse } from 'yaml';

// ─────────────────────────── types ─────────────────────────────────────────

export interface PullRequestData {
  number: number;
  title: string;
  body: string;
  mergedAt: string; // ISO-8601 UTC
  files: string[];
}

export interface Options {
  repo: string;
  switchIso: string;
  days: number;
  followupDays: number;
  json: boolean;
}

export interface BucketResult {
  label: 'before' | 'after';
  totalMerged: number;
  lowRiskMerged: number;
  followedUpByLink: number;
  followedUpByLinkRate: number;
  followedUpByOverlap: number;
  followedUpByOverlapRate: number;
  reverted: number;
  revertedRate: number;
  followedUpByLinkPRs: number[];
  followedUpByOverlapPRs: number[];
  revertedPRs: number[];
  shadowReviewed: number;
  shadowReviewedRate: number;
  shadowReviewedPRs: number[];
  shadowReviewP1: number;
  shadowReviewP1Rate: number;
  shadowReviewP1PRs: number[];
  caveat: string | null;
}

/** One issue `.github/workflows/shadow-review.yml` opened or could have opened. */
export interface ShadowReviewIssueData {
  number: number;
  title: string;
  body: string;
}

export interface WeeklyRevertRow {
  isoWeek: string;
  merged: number;
  reverts: number;
  rate: number;
}

export interface ReportResult {
  repo: string;
  switchIso: string;
  days: number;
  followupDays: number;
  before: BucketResult;
  after: BucketResult;
  weeklyRevertRate: WeeklyRevertRow[];
}

const MIN_SAMPLE_FOR_SIGNAL = 30;

// ─────────────────────────── pure logic (exported for tests) ──────────────

/**
 * The globs of `label` in a parsed `.github/labeler.yml`, in the one shape this repo's
 * `risk:high` uses: a single rule holding a single `any-glob-to-any-file` entry.
 * Mirrors `globsFor` in `scripts/labeler-config.test.ts` (not imported from there — that
 * file is a test file, and this one has to run against ANY `--repo`'s labeler.yml, not
 * just this fork's checked-out copy).
 */
export function globsForRiskHigh(config: Record<string, unknown>): string[] {
  const rules = config['risk:high'];
  const rule = Array.isArray(rules) && rules.length === 1 ? rules[0] : undefined;
  const entries = isSingleKey(rule, 'changed-files') ? rule['changed-files'] : undefined;
  const entry = Array.isArray(entries) && entries.length === 1 ? entries[0] : undefined;
  const globs = isSingleKey(entry, 'any-glob-to-any-file') ? entry['any-glob-to-any-file'] : undefined;
  if (typeof globs === 'string') return [globs];
  if (Array.isArray(globs) && globs.every((glob) => typeof glob === 'string')) return globs;
  throw new Error('labeler.yml "risk:high" must be exactly: - changed-files: - any-glob-to-any-file: [globs]');
}

function isSingleKey(value: unknown, key: string): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.keys(value).join() === key;
}

/**
 * True when `filePath` matches at least one of `globs`, replaying actions/labeler v7's
 * match (`node:path`'s `matchesGlob` — see file header for the `dot:true` caveat).
 */
export function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  return globs.some((glob) => nodePath.matchesGlob(filePath, glob));
}

export function isLowRisk(files: string[], riskHighGlobs: string[]): boolean {
  return !files.some((file) => matchesAnyGlob(file, riskHighGlobs));
}

// Same regexes codex-review.sh's merge-check reads at merge time.
const FIX_TITLE_RE = /^\s*fix(\([^)]*\))?!?:/i;
const FIXES_PR_LINE_RE = /(^|\n)Fixes-PR:[ \t]*(#([0-9]+)|none)\b/i;

export function isFixTitle(title: string): boolean {
  return FIX_TITLE_RE.test(title);
}

/** The PR number a `Fixes-PR:` line names, or null if absent or `Fixes-PR: none`. */
export function extractFixesPrNumber(body: string): number | null {
  const match = FIXES_PR_LINE_RE.exec(body);
  if (!match) return null;
  return match[3] ? Number(match[3]) : null;
}

/**
 * Files a tool rewrites as a side effect of unrelated edits. They say nothing about
 * whether two PRs touched the same code: `src/upstream-ratchet.json` alone produced 32 of
 * 93 overlap matches in the 30 days before the switch, because every upstream-owned edit
 * regenerates it.
 */
const GENERATED_FILES = new Set(['src/upstream-ratchet.json', 'pnpm-lock.yaml', 'container/agent-runner/bun.lock']);

export function filesOverlap(a: string[], b: string[]): boolean {
  const bSet = new Set(b.filter((f) => !GENERATED_FILES.has(f)));
  return a.some((f) => bSet.has(f));
}

/**
 * `Revert "..."` (GitHub's auto-revert template) generalized to "starts with the word
 * revert" so it also matches this repo's real convention, `revert(scope): ...` (#610) —
 * see file header.
 */
const REVERT_TITLE_RE = /^\s*revert\b/i;

/** `reverts #N` / `This reverts ... #N`, one regex, N captured. Gap capped at 60 chars, same line. */
const REVERT_BODY_RE = /reverts?\b[^\n#]{0,60}?#(\d+)\b/gi;

function titleNamesTarget(title: string, target: PullRequestData): boolean {
  return title.includes(`#${target.number}`) || title.includes(target.title);
}

function bodyNamesNumber(body: string, number: number): boolean {
  REVERT_BODY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REVERT_BODY_RE.exec(body)) !== null) {
    if (Number(match[1]) === number) return true;
  }
  return false;
}

/** Whether `candidate` is a revert of `target`, per the title and body rules above. */
export function isRevertOf(candidate: PullRequestData, target: PullRequestData): boolean {
  const titleMatch = REVERT_TITLE_RE.test(candidate.title) && titleNamesTarget(candidate.title, target);
  return titleMatch || bodyNamesNumber(candidate.body, target.number);
}

/** Whether `pr` is a revert of ANYTHING (no target linkage needed) — for the weekly rate. */
export function isRevertPR(pr: PullRequestData): boolean {
  if (REVERT_TITLE_RE.test(pr.title)) return true;
  REVERT_BODY_RE.lastIndex = 0;
  return REVERT_BODY_RE.test(pr.body);
}

export interface FollowUpResult {
  kind: 'link' | 'overlap' | 'none';
  prNumber: number | null;
}

/**
 * Follow-up status of `candidate` against `laterPRs` (already filtered to merged after
 * `candidate` and within `followupDays`). Link takes priority; overlap is the fallback
 * ONLY when no PR links to `candidate` — plan.md's Measurement status entry: "same-
 * subsystem follow-ups will be computed from git history instead" once linking is
 * unreliable, i.e. overlap stands in for a missing link, not alongside one.
 */
export function findFollowUp(candidate: PullRequestData, laterPRs: PullRequestData[]): FollowUpResult {
  for (const later of laterPRs) {
    if (extractFixesPrNumber(later.body) === candidate.number) {
      return { kind: 'link', prNumber: later.number };
    }
  }
  for (const later of laterPRs) {
    if (isFixTitle(later.title) && filesOverlap(later.files, candidate.files)) {
      return { kind: 'overlap', prNumber: later.number };
    }
  }
  return { kind: 'none', prNumber: null };
}

/** First PR in `laterPRs` (any distance in time) that reverts `candidate`, or null. */
export function findRevert(candidate: PullRequestData, laterPRs: PullRequestData[]): number | null {
  for (const later of laterPRs) {
    if (isRevertOf(later, candidate)) return later.number;
  }
  return null;
}

// `.github/workflows/shadow-review.yml` titles every issue it opens exactly
// `shadow review: #<n> <title>` (see that workflow), read case-insensitively same as
// the other title/body regexes above.
const SHADOW_REVIEW_TITLE_RE = /^shadow review:\s*#(\d+)\b/i;

// The workflow's prompt has Claude mark every finding's severity inline as "P1" or
// "P2" (see shadow-review.yml's prompt). Word-bounded so "P10" or "GP1" don't match;
// case-insensitive so a casing drift in the model's output doesn't silently undercount.
const P1_RE = /\bP1\b/i;

/** The PR number a shadow-review issue's title names, or null if the title doesn't match. */
export function extractShadowReviewPrNumber(title: string): number | null {
  const match = SHADOW_REVIEW_TITLE_RE.exec(title);
  return match ? Number(match[1]) : null;
}

/** Whether a shadow-review issue body names at least one P1 (destructive/fail-open) finding. */
export function issueHasP1(body: string): boolean {
  return P1_RE.test(body);
}

/**
 * PR number -> whether its shadow-review issue (if any) named a P1. A PR absent from
 * the map was never shadow-reviewed-with-findings: either it was clean (a PR comment,
 * not an issue — see file header) or the workflow hasn't run on it yet.
 */
export function buildShadowReviewIndex(issues: ShadowReviewIssueData[]): Map<number, { hasP1: boolean }> {
  const index = new Map<number, { hasP1: boolean }>();
  for (const issue of issues) {
    const prNumber = extractShadowReviewPrNumber(issue.title);
    if (prNumber === null) continue;
    const hasP1 = issueHasP1(issue.body) || (index.get(prNumber)?.hasP1 ?? false);
    index.set(prNumber, { hasP1 });
  }
  return index;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * ISO-8601 week key ("2026-W37"). Standard algorithm: shift each date to the fixed
 * weekday (index 3, 0-based from the week's first day) of its own ISO week — that
 * weekday's calendar year is always the ISO week-year, even across a year boundary —
 * then count whole weeks from the week-1 anchor of that year, computed the same way
 * from January 4th (which the ISO calendar guarantees always falls in week 1).
 */
export function isoWeekKey(dateIso: string): string {
  const date = new Date(dateIso);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (utc.getUTCDay() + 6) % 7; // 0-based, week starting at the same fixed weekday every week
  utc.setUTCDate(utc.getUTCDate() - dayNum + 3);
  const isoYear = utc.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const week1Anchor = new Date(jan4);
  week1Anchor.setUTCDate(jan4.getUTCDate() - jan4DayNum);
  const weekNum = Math.round((utc.getTime() - week1Anchor.getTime()) / (7 * MS_PER_DAY)) + 1;
  return `${isoYear}-W${String(weekNum).padStart(2, '0')}`;
}

export function weeklyRevertRate(allPRs: PullRequestData[]): WeeklyRevertRow[] {
  const buckets = new Map<string, { merged: number; reverts: number }>();
  for (const pr of allPRs) {
    const week = isoWeekKey(pr.mergedAt);
    const bucket = buckets.get(week) ?? { merged: 0, reverts: 0 };
    bucket.merged += 1;
    if (isRevertPR(pr)) bucket.reverts += 1;
    buckets.set(week, bucket);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([isoWeek, { merged, reverts }]) => ({
      isoWeek,
      merged,
      reverts,
      rate: merged === 0 ? 0 : reverts / merged,
    }));
}

/** Builds one before/after bucket over `prs` already filtered to the window. */
function buildBucket(
  label: 'before' | 'after',
  windowPRs: PullRequestData[],
  allPRsSortedByMergedAt: PullRequestData[],
  riskHighGlobs: string[],
  followupDays: number,
  shadowReviewIndex: Map<number, { hasP1: boolean }>,
): BucketResult {
  const lowRiskPRs = windowPRs.filter((pr) => isLowRisk(pr.files, riskHighGlobs));

  let followedUpByLink = 0;
  let followedUpByOverlap = 0;
  let reverted = 0;
  const followedUpByLinkPRs: number[] = [];
  const followedUpByOverlapPRs: number[] = [];
  const revertedPRs: number[] = [];

  const shadowReviewedPRs = lowRiskPRs.filter((pr) => shadowReviewIndex.has(pr.number)).map((pr) => pr.number);
  const shadowReviewP1PRs = shadowReviewedPRs.filter((n) => shadowReviewIndex.get(n)?.hasP1 === true);

  for (const pr of lowRiskPRs) {
    const cutoff = new Date(pr.mergedAt).getTime() + followupDays * MS_PER_DAY;
    const laterPRs = allPRsSortedByMergedAt.filter((other) => {
      const t = new Date(other.mergedAt).getTime();
      return other.number !== pr.number && t > new Date(pr.mergedAt).getTime() && t <= cutoff;
    });
    const followUp = findFollowUp(pr, laterPRs);
    if (followUp.kind === 'link') {
      followedUpByLink += 1;
      followedUpByLinkPRs.push(pr.number);
    } else if (followUp.kind === 'overlap') {
      followedUpByOverlap += 1;
      followedUpByOverlapPRs.push(pr.number);
    }

    const laterPRsUnbounded = allPRsSortedByMergedAt.filter((other) => {
      const t = new Date(other.mergedAt).getTime();
      return other.number !== pr.number && t > new Date(pr.mergedAt).getTime();
    });
    const revertNumber = findRevert(pr, laterPRsUnbounded);
    if (revertNumber !== null) {
      reverted += 1;
      revertedPRs.push(pr.number);
    }
  }

  const n = lowRiskPRs.length;
  return {
    label,
    totalMerged: windowPRs.length,
    lowRiskMerged: n,
    followedUpByLink,
    followedUpByLinkRate: n === 0 ? 0 : followedUpByLink / n,
    followedUpByOverlap,
    followedUpByOverlapRate: n === 0 ? 0 : followedUpByOverlap / n,
    reverted,
    revertedRate: n === 0 ? 0 : reverted / n,
    followedUpByLinkPRs,
    followedUpByOverlapPRs,
    revertedPRs,
    shadowReviewed: shadowReviewedPRs.length,
    shadowReviewedRate: n === 0 ? 0 : shadowReviewedPRs.length / n,
    shadowReviewedPRs,
    shadowReviewP1: shadowReviewP1PRs.length,
    shadowReviewP1Rate: n === 0 ? 0 : shadowReviewP1PRs.length / n,
    shadowReviewP1PRs,
    caveat:
      n < MIN_SAMPLE_FOR_SIGNAL
        ? `only ${n} low-risk PR(s) merged ${label} the switch (<${MIN_SAMPLE_FOR_SIGNAL}) — only a large difference would show`
        : null,
  };
}

export function computeReport(
  allPRs: PullRequestData[],
  riskHighGlobs: string[],
  options: Options,
  shadowReviewIssues: ShadowReviewIssueData[] = [],
): ReportResult {
  const switchMs = new Date(options.switchIso).getTime();
  const beforeStart = switchMs - options.days * MS_PER_DAY;
  const afterEnd = switchMs + options.days * MS_PER_DAY;

  const sorted = [...allPRs].sort((a, b) => new Date(a.mergedAt).getTime() - new Date(b.mergedAt).getTime());
  const shadowReviewIndex = buildShadowReviewIndex(shadowReviewIssues);

  const beforePRs = sorted.filter((pr) => {
    const t = new Date(pr.mergedAt).getTime();
    return t >= beforeStart && t < switchMs;
  });
  const afterPRs = sorted.filter((pr) => {
    const t = new Date(pr.mergedAt).getTime();
    return t >= switchMs && t < afterEnd;
  });

  const before = buildBucket('before', beforePRs, sorted, riskHighGlobs, options.followupDays, shadowReviewIndex);
  const after = buildBucket('after', afterPRs, sorted, riskHighGlobs, options.followupDays, shadowReviewIndex);

  const wholeWindowPRs = sorted.filter((pr) => {
    const t = new Date(pr.mergedAt).getTime();
    return t >= beforeStart && t < afterEnd;
  });

  return {
    repo: options.repo,
    switchIso: options.switchIso,
    days: options.days,
    followupDays: options.followupDays,
    before,
    after,
    weeklyRevertRate: weeklyRevertRate(wholeWindowPRs),
  };
}

// ─────────────────────────── gh I/O ────────────────────────────────────────

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function fetchLabelerYaml(repo: string): string {
  return gh(['api', `repos/${repo}/contents/.github/labeler.yml`, '-H', 'Accept: application/vnd.github.raw']);
}

interface RawPrFile {
  path?: string;
  filename?: string;
}

interface RawPr {
  number: number;
  title: string;
  body: string | null;
  mergedAt: string;
  changedFiles: number;
  files: RawPrFile[];
}

function fetchAllFilesViaRest(repo: string, prNumber: number): string[] {
  const raw = gh(['api', `repos/${repo}/pulls/${prNumber}/files`, '--paginate', '--slurp']);
  const pages = JSON.parse(raw) as RawPrFile[][];
  return pages.flat().map((f) => f.filename ?? f.path ?? '');
}

function resolveFiles(repo: string, pr: RawPr): string[] {
  if (pr.files.length < pr.changedFiles) {
    // gh pr list's `files` field truncates on large PRs; changedFiles is the true total.
    return fetchAllFilesViaRest(repo, pr.number);
  }
  return pr.files.map((f) => f.path ?? f.filename ?? '');
}

export function fetchMergedPRs(repo: string, sinceIso: string): PullRequestData[] {
  const raw = gh([
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'merged',
    '--search',
    `merged:>=${sinceIso}`,
    '--json',
    'number,title,body,mergedAt,changedFiles,files',
    '--limit',
    '1000',
  ]);
  const prs = JSON.parse(raw) as RawPr[];
  return prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    mergedAt: pr.mergedAt,
    files: resolveFiles(repo, pr),
  }));
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
}

/** Every issue ever labeled `shadow-review` — open or closed, the label is the filter. */
export function fetchShadowReviewIssues(repo: string): ShadowReviewIssueData[] {
  const raw = gh([
    'issue',
    'list',
    '--repo',
    repo,
    '--label',
    'shadow-review',
    '--state',
    'all',
    '--json',
    'number,title,body',
    '--limit',
    '1000',
  ]);
  const issues = JSON.parse(raw) as RawIssue[];
  return issues.map((issue) => ({ number: issue.number, title: issue.title, body: issue.body ?? '' }));
}

// ─────────────────────────── CLI ───────────────────────────────────────────

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    repo: 'davekim917/nanoclaw',
    switchIso: '2026-09-10T00:00:00Z',
    days: 30,
    followupDays: 14,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} needs a value`);
      i += 1;
      return value;
    };
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);

    if (name === '--repo') options.repo = inline ?? next();
    else if (name === '--switch') options.switchIso = inline ?? next();
    else if (name === '--days') options.days = Number(inline ?? next());
    else if (name === '--followup-days') options.followupDays = Number(inline ?? next());
    else if (name === '--json') options.json = true;
    else if (name === '--help' || name === '-h') usage();
    else if (arg !== '--') fail(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.days) || options.days <= 0) fail('--days must be a positive number');
  if (!Number.isFinite(options.followupDays) || options.followupDays <= 0)
    fail('--followup-days must be a positive number');
  if (Number.isNaN(new Date(options.switchIso).getTime()))
    fail(`--switch is not a valid ISO date: ${options.switchIso}`);
  return options;
}

function fail(message: string): never {
  console.error(`review-outcomes: ${message}`);
  process.exit(1);
}

function usage(): never {
  console.log(
    [
      'Usage: tsx scripts/review-outcomes.ts [--repo owner/repo] [--switch <ISO>]',
      '         [--days <n>] [--followup-days <n>] [--json]',
      '',
      'Measures whether low-risk PRs merged without review (after --switch) drew more',
      'follow-up fixes or reverts than low-risk PRs did while every PR was reviewed',
      '(before --switch). See docs/specs/risk-based-review/plan.md, "Measurement".',
    ].join('\n'),
  );
  process.exit(0);
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function printBucket(bucket: BucketResult): void {
  console.log(`  ${bucket.label} the switch:`);
  console.log(`    merged (all risk levels): ${bucket.totalMerged}`);
  console.log(`    merged (low-risk):        ${bucket.lowRiskMerged}`);
  console.log(
    `    followed up — by link:    ${bucket.followedUpByLink} (${pct(bucket.followedUpByLinkRate)})` +
      (bucket.followedUpByLinkPRs.length ? ` [${bucket.followedUpByLinkPRs.map((n) => `#${n}`).join(', ')}]` : ''),
  );
  console.log(
    `    followed up — by overlap: ${bucket.followedUpByOverlap} (${pct(bucket.followedUpByOverlapRate)})` +
      (bucket.followedUpByOverlapPRs.length
        ? ` [${bucket.followedUpByOverlapPRs.map((n) => `#${n}`).join(', ')}]`
        : ''),
  );
  console.log(
    `    reverted:                  ${bucket.reverted} (${pct(bucket.revertedRate)})` +
      (bucket.revertedPRs.length ? ` [${bucket.revertedPRs.map((n) => `#${n}`).join(', ')}]` : ''),
  );
  console.log(
    `    shadow-reviewed:           ${bucket.shadowReviewed} (${pct(bucket.shadowReviewedRate)})` +
      (bucket.shadowReviewedPRs.length ? ` [${bucket.shadowReviewedPRs.map((n) => `#${n}`).join(', ')}]` : ''),
  );
  console.log(
    `    shadow-review P1:          ${bucket.shadowReviewP1} (${pct(bucket.shadowReviewP1Rate)})` +
      (bucket.shadowReviewP1PRs.length ? ` [${bucket.shadowReviewP1PRs.map((n) => `#${n}`).join(', ')}]` : ''),
  );
  if (bucket.caveat) console.log(`    caveat: ${bucket.caveat}`);
}

function printReport(report: ReportResult): void {
  console.log(
    `review-outcomes: ${report.repo}, switch=${report.switchIso}, days=${report.days}, followup-days=${report.followupDays}`,
  );
  console.log('');
  console.log('Low-risk class, before vs after the switch:');
  printBucket(report.before);
  printBucket(report.after);
  console.log('');
  console.log('Weekly revert rate (reverts / merged, all risk levels, whole window):');
  for (const row of report.weeklyRevertRate) {
    console.log(`  ${row.isoWeek}: ${row.reverts}/${row.merged} (${pct(row.rate)})`);
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  const labelerYaml = fetchLabelerYaml(options.repo);
  const labelerConfig = parse(labelerYaml) as Record<string, unknown>;
  const riskHighGlobs = globsForRiskHigh(labelerConfig);

  const sinceIso = new Date(new Date(options.switchIso).getTime() - options.days * MS_PER_DAY).toISOString();
  const allPRs = fetchMergedPRs(options.repo, sinceIso);
  const shadowReviewIssues = fetchShadowReviewIssues(options.repo);

  const report = computeReport(allPRs, riskHighGlobs, options, shadowReviewIssues);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}

// ESM-safe "is this the entrypoint" check (mirrors scripts/upstream-ratchet-report.ts's
// `main()` being called unconditionally at module scope — this one guards it instead so
// `computeReport` etc. can be imported from the test file without side effects).
if (process.argv[1] && new URL(process.argv[1], 'file:').href === import.meta.url) {
  main();
}
