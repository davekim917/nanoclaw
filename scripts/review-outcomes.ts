#!/usr/bin/env tsx
/**
 * Review-outcomes: did low-risk PRs merged without review draw more follow-up fixes or reverts
 * than low-risk PRs did while every PR was still reviewed (docs/specs/risk-based-review/plan.md)?
 *
 * Low-risk is a REPLAY of the CURRENT `.github/labeler.yml` `risk:high` globs against every PR,
 * including ones merged before the labeler existed. `path.matchesGlob` does not match a dotfile
 * segment deep inside a globstar (`src/.hidden/x.ts` against a `src` globstar glob).
 *
 * Usage:
 *   pnpm exec tsx scripts/review-outcomes.ts [--repo owner/repo] [--switch <ISO>]
 *     [--days <n>] [--followup-days <n>] [--json]
 */
import { execFileSync } from 'node:child_process';
import nodePath from 'node:path';

import { parse } from 'yaml';
import { walkArgs } from './lib/cli-args.js';

export interface PullRequestData {
  number: number;
  title: string;
  body: string;
  mergedAt: string; // ISO-8601 UTC
  files: string[];
  labels: string[]; // CURRENT labels, not a merge-time snapshot
  baseRefName: string; // e.g. "main" — shadow-review.yml only selects PRs merged INTO main
  changedLines: number; // additions + deletions, EXCLUDING GENERATED_FILES — the weekly report's kLOC denominator
  changedFiles: number; // GitHub's own file count for this PR — the completeness check `resolveAtMergeContexts` needs
  mergeCommitOid: string | null; // the merge commit's oid (gh pr list's own `mergeCommit` field), or null if unmerged/unknown
  headRefOid: string; // the PR's head commit oid — resolveAtMergeBaseSha's "is this a normal 2-parent merge" check needs it
  /** `undefined`: never attempted (pre-gate). `null`: attempted but unresolved, counted as `postGateUnresolved`. */
  atMergeContext?: AtMergeContext | null;
  /** Post-gate by date, but `.github/labeler.yml` did not exist yet at its own base commit: treated as pre-gate. */
  preGateOverride?: boolean;
  /** Set instead of `atMergeContext` when the merge diff reached the gate's 300-file cap, where the gate always answers `review`. */
  atMergeForcedVerdict?: 'review';
}

/**
 * What the merge gate saw for one PR when it merged, replayed from the merge commit's first parent
 * and label event history: replaying CURRENT globs and labels would silently rewrite history.
 */
export interface AtMergeContext {
  /** Merge diff filenames plus renamed files' previous names: moving a file off a risky path still changes that path. */
  files: string[];
  labels: string[];
  riskHighGlobs: string[];
}

export interface Options {
  repo: string;
  switchIso: string;
  days: number;
  followupDays: number;
  json: boolean;
  weekly?: boolean;
  weeklyDays?: number;
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
  shadowReviewFailed: number;
  shadowReviewFailedRate: number;
  shadowReviewFailedPRs: number[];
  caveat: string | null;
}

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
  shadowCoverage: ShadowCoverageResult;
}

const MIN_SAMPLE_FOR_SIGNAL = 30;

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

export function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  return globs.some((glob) => nodePath.matchesGlob(filePath, glob));
}

export function isLowRisk(files: string[], riskHighGlobs: string[]): boolean {
  return !files.some((file) => matchesAnyGlob(file, riskHighGlobs));
}

// Same regexes codex-review.sh's merge-check reads at merge time.
const FIX_TITLE_RE = /^\s*fix(\([^)]*\))?!?:/i;

/**
 * Must strip exactly what codex-review.sh's `fix_link_state` strips: a `Fixes-PR:` line inside a
 * fence or HTML comment is a quoted example. An unclosed fence runs to the end of the body.
 */
export function stripFencedAndCommented(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;
  const openRe = /^ {0,3}(`{3,}|~{3,})/;
  for (const line of lines) {
    const openMatch = openRe.exec(line);
    if (fenceChar === null) {
      if (openMatch) {
        fenceChar = openMatch[1][0] as '`' | '~';
        fenceLen = openMatch[1].length;
      } else {
        out.push(line);
      }
    } else if (
      openMatch &&
      openMatch[1][0] === fenceChar &&
      openMatch[1].length >= fenceLen &&
      /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.test(line)
    ) {
      fenceChar = null;
      fenceLen = 0;
    }
  }
  return out.join('\n').replace(/<!--[\s\S]*?(-->|$)/g, '');
}

export function isFixTitle(title: string): boolean {
  return FIX_TITLE_RE.test(title);
}

const FIXES_PR_LINE_VALUE_RE = /^[ \t]*Fixes-PR:[ \t]*(.*)$/gim;
// Cross-repo `owner/repo#N` and "(upstream ...)" remarks are not this repo's PR numbers.
const CROSS_REPO_OR_UPSTREAM_RE = /\([^)]*\bupstream\b[^)]*\)|[\w.-]+\/[\w.-]+#\d+/gi;
const NONE_TOKEN_RE = /\bnone\b/i;

/** `none` alongside a number anywhere credits NOTHING: a contradictory declaration can't be trusted. */
export function extractFixesPrNumbers(body: string): number[] {
  const cleaned = stripFencedAndCommented(body);
  FIXES_PR_LINE_VALUE_RE.lastIndex = 0;
  const numbers = new Set<number>();
  let sawNone = false;
  let sawNumber = false;
  let match: RegExpExecArray | null;
  while ((match = FIXES_PR_LINE_VALUE_RE.exec(cleaned)) !== null) {
    const value = match[1].replace(CROSS_REPO_OR_UPSTREAM_RE, ' ');
    const lineNumbers = [...value.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1]));
    const lineHasNone = NONE_TOKEN_RE.test(value);
    if (lineHasNone && lineNumbers.length > 0) return []; // contradictory on ONE line
    if (lineHasNone) sawNone = true;
    for (const n of lineNumbers) {
      numbers.add(n);
      sawNumber = true;
    }
  }
  if (sawNone && sawNumber) return []; // contradictory ACROSS separate lines
  return [...numbers];
}

export function extractFixesPrNumber(body: string): number | null {
  const numbers = extractFixesPrNumbers(body);
  return numbers.length > 0 ? numbers[0] : null;
}

/**
 * `none` counts: it is evidence the convention was in use, which `findConventionStartIso` dates. A
 * contradictory declaration also counts here, though `extractFixesPrNumbers` credits it nothing.
 */
export function hasFixesPrLine(body: string): boolean {
  return /^[ \t]*Fixes-PR:[ \t]*(?:#\d+|none)\b/im.test(stripFencedAndCommented(body));
}

export function findConventionStartIso(prs: readonly PullRequestData[]): string | null {
  let earliest: string | null = null;
  for (const pr of prs) {
    if (!hasFixesPrLine(pr.body)) continue;
    if (earliest === null || new Date(pr.mergedAt).getTime() < new Date(earliest).getTime()) {
      earliest = pr.mergedAt;
    }
  }
  return earliest;
}

const GENERATED_FILES = new Set(['src/upstream-ratchet.json', 'pnpm-lock.yaml', 'container/agent-runner/bun.lock']);

export function filesOverlap(a: string[], b: string[]): boolean {
  const bSet = new Set(b.filter((f) => !GENERATED_FILES.has(f)));
  return a.some((f) => bSet.has(f));
}

const REVERT_TITLE_RE = /^\s*revert\b/i;

/** Anchored to a line's start: a body that merely discusses a revert must not name a revert target. */
const REVERT_BODY_LINE_RE = /^[ \t]*(?:this\s+)?reverts?\b[^\n#]{0,60}?#(?<num>\d+)\b/gim;

function titleNamesTarget(title: string, target: PullRequestData): boolean {
  return title.includes(`#${target.number}`) || title.includes(target.title);
}

function bodyNamesNumber(body: string, number: number): boolean {
  REVERT_BODY_LINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REVERT_BODY_LINE_RE.exec(body)) !== null) {
    if (Number(match.groups?.num) === number) return true;
  }
  return false;
}

export function isRevertOf(candidate: PullRequestData, target: PullRequestData): boolean {
  const titleMatch = REVERT_TITLE_RE.test(candidate.title) && titleNamesTarget(candidate.title, target);
  return titleMatch || bodyNamesNumber(candidate.body, target.number);
}

export function isRevertPR(pr: PullRequestData): boolean {
  if (REVERT_TITLE_RE.test(pr.title)) return true;
  REVERT_BODY_LINE_RE.lastIndex = 0;
  return REVERT_BODY_LINE_RE.test(pr.body);
}

export interface FollowUpResult {
  kind: 'link' | 'overlap' | 'none';
  prNumber: number | null;
}

/** `Fixes-PR: none` (or a contradictory body) must not stand in as file-overlap evidence; no trailer still falls through. */
function declaresFixesPrNone(body: string): boolean {
  return hasFixesPrLine(body) && extractFixesPrNumbers(body).length === 0;
}

/** `laterPRs` must already be filtered to merged after `candidate` and within `followupDays`. */
export function findFollowUp(candidate: PullRequestData, laterPRs: PullRequestData[]): FollowUpResult {
  for (const later of laterPRs) {
    if (extractFixesPrNumbers(later.body).includes(candidate.number)) {
      return { kind: 'link', prNumber: later.number };
    }
  }
  for (const later of laterPRs) {
    if (isFixTitle(later.title) && !declaresFixesPrNone(later.body) && filesOverlap(later.files, candidate.files)) {
      return { kind: 'overlap', prNumber: later.number };
    }
  }
  return { kind: 'none', prNumber: null };
}

export function findRevert(candidate: PullRequestData, laterPRs: PullRequestData[]): number | null {
  for (const later of laterPRs) {
    if (isRevertOf(later, candidate)) return later.number;
  }
  return null;
}

// Must match the issue title `.github/workflows/shadow-review.yml` writes.
const SHADOW_REVIEW_TITLE_RE = /^shadow review:\s*#(\d+)\b/i;

// Anchored to the bullet's start so a P2 finding that mentions "P1" isn't counted.
const P1_LINE_RE = /^- \*\*P1\*\*/im;

export function extractShadowReviewPrNumber(title: string): number | null {
  const match = SHADOW_REVIEW_TITLE_RE.exec(title);
  return match ? Number(match[1]) : null;
}

export function issueHasP1(body: string): boolean {
  return P1_LINE_RE.test(body);
}

/** A PR absent from the map had no shadow-review issue: clean (a PR comment, not an issue) or not yet run. */
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

export interface ShadowReviewClassification {
  reviewedPRs: number[];
  p1PRs: number[];
  failedPRs: number[];
}

/** A real review is never erased by a stale or concurrent failure label: failed excludes reviewed. */
export function classifyShadowReview(
  prNumbers: number[],
  shadowReviewIndex: Map<number, { hasP1: boolean }>,
  reviewedLabelPrNumbers: ReadonlySet<number>,
  failedLabelPrNumbers: ReadonlySet<number>,
): ShadowReviewClassification {
  const reviewedPRs = prNumbers.filter((n) => shadowReviewIndex.has(n) || reviewedLabelPrNumbers.has(n));
  const reviewedSet = new Set(reviewedPRs);
  // P1 is issue-derived only: the label alone carries no severity information.
  const p1PRs = reviewedPRs.filter((n) => shadowReviewIndex.get(n)?.hasP1 === true);
  const failedPRs = prNumbers.filter((n) => failedLabelPrNumbers.has(n) && !reviewedSet.has(n));
  return { reviewedPRs, p1PRs, failedPRs };
}

const RISK_HIGH_LABEL = 'risk:high';
const REVIEW_REQUESTED_LABEL = 'review:requested';

export function isEligibleForShadowReview(labels: string[]): boolean {
  return !labels.includes(RISK_HIGH_LABEL) && !labels.includes(REVIEW_REQUESTED_LABEL);
}

/** CURRENT-state verdict, not a historical replay: an old PR can flip under today's globs. */
export function isSkipVerdict(pr: PullRequestData, riskHighGlobs: string[]): boolean {
  return isLowRisk(pr.files, riskHighGlobs) && isEligibleForShadowReview(pr.labels);
}

export function classifyAtMergeVerdict(ctx: AtMergeContext | null | undefined): 'skip' | 'review' {
  if (ctx == null) return 'review';
  return isLowRisk(ctx.files, ctx.riskHighGlobs) && isEligibleForShadowReview(ctx.labels) ? 'skip' : 'review';
}

const SHADOW_REVIEW_BASE_REF = 'main';

/** STRICT `>`: the PR that ships `.github/labeler.yml` was not yet governed by it. */
export const GATE_GO_LIVE_ISO = '2026-09-10T16:43:32Z';

/** Pinned, NOT recomputed per run: a short fetch window would compute a later date. */
export const FIXES_PR_CONVENTION_START_ISO = '2026-09-11T12:44:10Z';

export interface RawLabelEvent {
  type: 'labeled' | 'unlabeled';
  name: string;
  createdAt: string; // ISO-8601 UTC
}

/** Labels as of `mergedAtIso`, mirroring `codex-review.sh audit`'s reduce over label events. */
export function replayLabelsAtMerge(events: readonly RawLabelEvent[], mergedAtIso: string): string[] {
  const mergedMs = new Date(mergedAtIso).getTime();
  const relevant = events
    .filter((e) => new Date(e.createdAt).getTime() <= mergedMs)
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const labels = new Set<string>();
  for (const e of relevant) {
    if (e.type === 'labeled') labels.add(e.name);
    else labels.delete(e.name);
  }
  return [...labels];
}

export interface MergeCommitShape {
  headRefOid: string;
  mergeCommitOid: string | null;
  parentOids: string[];
}

/**
 * Anything but a 2-parent merge onto the PR head or a squash is `null`, so the caller fails closed
 * to `review`. Unlike `audit`, no GitHub-signature check: this is measurement, not enforcement.
 */
export function resolveAtMergeBaseSha(shape: MergeCommitShape): string | null {
  if (shape.mergeCommitOid === null) return null;
  if (shape.parentOids.length === 2 && shape.parentOids[1] === shape.headRefOid) return shape.parentOids[0];
  if (shape.parentOids.length === 1) return shape.parentOids[0];
  return null;
}

/** PRs merged before shadow review went live were never candidates, so `computeShadowCoverage` excludes them. */
export const SHADOW_REVIEW_GO_LIVE_ISO = '2026-09-11T15:59:15Z';

export interface ShadowCoverageResult {
  sinceIso: string;
  eligible: number;
  reviewed: number;
  reviewedRate: number;
  reviewedPRs: number[];
  failed: number;
  failedRate: number;
  failedPRs: number[];
  notYetRun: number;
  notYetRunRate: number;
  notYetRunPRs: number[];
  caveat: string;
}

export const LABEL_DRIFT_CAVEAT =
  'eligibility is judged against CURRENT labels, not labels at merge time — a PR relabeled ' +
  'risk:high or review:requested after merging drops out of (or into) this denominator even ' +
  'though the workflow selected (or skipped) it based on labels as they stood at merge time. ' +
  '(base ref is not subject to this drift — a PR merges into one branch permanently.)';

/** `allPRs` must already include every PR merged at or after `sinceIso`; earlier PRs are filtered out here. */
export function computeShadowCoverage(
  allPRs: PullRequestData[],
  shadowReviewIssues: ShadowReviewIssueData[],
  reviewedLabelPrNumbers: number[],
  failedLabelPrNumbers: number[],
  sinceIso: string = SHADOW_REVIEW_GO_LIVE_ISO,
): ShadowCoverageResult {
  const sinceMs = new Date(sinceIso).getTime();
  const eligiblePRs = allPRs.filter(
    (pr) =>
      pr.baseRefName === SHADOW_REVIEW_BASE_REF &&
      new Date(pr.mergedAt).getTime() >= sinceMs &&
      isEligibleForShadowReview(pr.labels),
  );
  const shadowReviewIndex = buildShadowReviewIndex(shadowReviewIssues);
  const { reviewedPRs, failedPRs } = classifyShadowReview(
    eligiblePRs.map((pr) => pr.number),
    shadowReviewIndex,
    new Set(reviewedLabelPrNumbers),
    new Set(failedLabelPrNumbers),
  );
  const reviewedSet = new Set(reviewedPRs);
  const failedSet = new Set(failedPRs);
  const notYetRunPRs = eligiblePRs
    .filter((pr) => !reviewedSet.has(pr.number) && !failedSet.has(pr.number))
    .map((pr) => pr.number);

  const n = eligiblePRs.length;
  return {
    sinceIso,
    eligible: n,
    reviewed: reviewedPRs.length,
    reviewedRate: n === 0 ? 0 : reviewedPRs.length / n,
    reviewedPRs,
    failed: failedPRs.length,
    failedRate: n === 0 ? 0 : failedPRs.length / n,
    failedPRs,
    notYetRun: notYetRunPRs.length,
    notYetRunRate: n === 0 ? 0 : notYetRunPRs.length / n,
    notYetRunPRs,
    caveat: LABEL_DRIFT_CAVEAT,
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

function buildBucket(
  label: 'before' | 'after',
  windowPRs: PullRequestData[],
  allPRsSortedByMergedAt: PullRequestData[],
  riskHighGlobs: string[],
  followupDays: number,
  shadowReviewIndex: Map<number, { hasP1: boolean }>,
  shadowReviewFailedPrNumbers: ReadonlySet<number>,
  shadowReviewedLabelPrNumbers: ReadonlySet<number>,
): BucketResult {
  const lowRiskPRs = windowPRs.filter((pr) => isLowRisk(pr.files, riskHighGlobs));

  let followedUpByLink = 0;
  let followedUpByOverlap = 0;
  let reverted = 0;
  const followedUpByLinkPRs: number[] = [];
  const followedUpByOverlapPRs: number[] = [];
  const revertedPRs: number[] = [];

  const {
    reviewedPRs: shadowReviewedPRs,
    p1PRs: shadowReviewP1PRs,
    failedPRs: shadowReviewFailedPRs,
  } = classifyShadowReview(
    lowRiskPRs.map((pr) => pr.number),
    shadowReviewIndex,
    shadowReviewedLabelPrNumbers,
    shadowReviewFailedPrNumbers,
  );

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
    shadowReviewFailed: shadowReviewFailedPRs.length,
    shadowReviewFailedRate: n === 0 ? 0 : shadowReviewFailedPRs.length / n,
    shadowReviewFailedPRs,
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
  shadowReviewFailedPrNumbers: number[] = [],
  shadowReviewedLabelPrNumbers: number[] = [],
): ReportResult {
  const switchMs = new Date(options.switchIso).getTime();
  const beforeStart = switchMs - options.days * MS_PER_DAY;
  const afterEnd = switchMs + options.days * MS_PER_DAY;

  const sorted = [...allPRs].sort((a, b) => new Date(a.mergedAt).getTime() - new Date(b.mergedAt).getTime());
  const shadowReviewIndex = buildShadowReviewIndex(shadowReviewIssues);
  const failedPrNumberSet = new Set(shadowReviewFailedPrNumbers);
  const reviewedLabelPrNumberSet = new Set(shadowReviewedLabelPrNumbers);

  const beforePRs = sorted.filter((pr) => {
    const t = new Date(pr.mergedAt).getTime();
    return t >= beforeStart && t < switchMs;
  });
  const afterPRs = sorted.filter((pr) => {
    const t = new Date(pr.mergedAt).getTime();
    return t >= switchMs && t < afterEnd;
  });

  const before = buildBucket(
    'before',
    beforePRs,
    sorted,
    riskHighGlobs,
    options.followupDays,
    shadowReviewIndex,
    failedPrNumberSet,
    reviewedLabelPrNumberSet,
  );
  const after = buildBucket(
    'after',
    afterPRs,
    sorted,
    riskHighGlobs,
    options.followupDays,
    shadowReviewIndex,
    failedPrNumberSet,
    reviewedLabelPrNumberSet,
  );

  const wholeWindowPRs = sorted.filter((pr) => {
    const t = new Date(pr.mergedAt).getTime();
    return t >= beforeStart && t < afterEnd;
  });

  const shadowCoverage = computeShadowCoverage(
    allPRs,
    shadowReviewIssues,
    shadowReviewedLabelPrNumbers,
    shadowReviewFailedPrNumbers,
  );

  return {
    repo: options.repo,
    switchIso: options.switchIso,
    days: options.days,
    followupDays: options.followupDays,
    before,
    after,
    weeklyRevertRate: weeklyRevertRate(wholeWindowPRs),
    shadowCoverage,
  };
}

/** `linked` is ground truth; `overlapHeuristic` is an upper bound, never folded into `linked`. */
export interface WeeklyLaneStats {
  merged: number;
  linked: number;
  linkedRate: number;
  overlapHeuristic: number;
  overlapHeuristicRate: number;
}

export interface WeeklyReviewRow {
  isoWeek: string;
  weekStartIso: string;
  weekEndIso: string; // inclusive — the last millisecond of that ISO week, UTC
  merged: number;
  /** Straddles `GATE_GO_LIVE_ISO`: the reason `reviewed + skipped` can be less than `merged`. */
  isMixedGateWeek: boolean;
  preGateMerged: number;
  preGateLowRisk: number;
  preGateHighRisk: number;
  postGateMerged: number;
  /** Rate is over `postGateMerged`, NOT `merged`. */
  reviewed: number;
  reviewedRate: number;
  skipped: number;
  skippedRate: number;
  postGateUnresolved: number;
  /** PRs merged this week that are themselves reverts — not low-risk PRs later reverted (`BucketResult.reverted`). */
  reverted: number;
  revertRate: number;
  changedLines: number;
  overall: WeeklyLaneStats; // over ALL PRs this week, pre- and post-gate alike
  reviewedLane: WeeklyLaneStats; // over POST-GATE reviewed PRs only
  skippedLane: WeeklyLaneStats; // over POST-GATE skipped PRs only
  /** Per 1,000 non-generated changed lines; 0 when `changedLines` is 0. */
  linkedPerKLoc: number;
  /** `--followup-days` have not yet passed since `weekEndIso`: follow-up counts can still change. */
  immature: boolean;
  /** `false`: some PRs predate the `Fixes-PR:` convention, so `linked` is an undercount, not a true zero. */
  linkComplete: boolean;
  preConventionMerged: number;
}

export interface WeeklyReport {
  rows: WeeklyReviewRow[];
  conventionStartIso: string; // always FIXES_PR_CONVENTION_START_ISO — pinned, not recomputed (see that constant)
}

export function isoWeekDateRange(isoWeek: string): { startIso: string; endIso: string } {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match) throw new Error(`invalid ISO week key: ${isoWeek}`);
  const isoYear = Number(match[1]);
  const weekNum = Number(match[2]);
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const week1Anchor = new Date(jan4);
  week1Anchor.setUTCDate(jan4.getUTCDate() - jan4DayNum);
  const start = new Date(week1Anchor);
  start.setUTCDate(week1Anchor.getUTCDate() + (weekNum - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function weeklyLaneStats(
  lanePRs: readonly PullRequestData[],
  sortedAll: readonly PullRequestData[],
  followupDays: number,
): WeeklyLaneStats {
  let linked = 0;
  let overlapHeuristic = 0;
  for (const candidate of lanePRs) {
    const mergedMs = new Date(candidate.mergedAt).getTime();
    const cutoffMs = mergedMs + followupDays * MS_PER_DAY;
    const laterPRs = sortedAll.filter((other) => {
      const t = new Date(other.mergedAt).getTime();
      return other.number !== candidate.number && t > mergedMs && t <= cutoffMs;
    });
    const followUp = findFollowUp(candidate, laterPRs);
    const revertedWithinWindow = findRevert(candidate, laterPRs) !== null;
    if (followUp.kind === 'link' || revertedWithinWindow) linked += 1;
    else if (followUp.kind === 'overlap') overlapHeuristic += 1;
  }
  const n = lanePRs.length;
  return {
    merged: n,
    linked,
    linkedRate: n === 0 ? 0 : linked / n,
    overlapHeuristic,
    overlapHeuristicRate: n === 0 ? 0 : overlapHeuristic / n,
  };
}

function buildWeeklyRow(
  isoWeek: string,
  weekPRs: readonly PullRequestData[],
  sortedAll: readonly PullRequestData[],
  riskHighGlobs: string[],
  followupDays: number,
  nowMs: number,
): WeeklyReviewRow {
  const { startIso, endIso } = isoWeekDateRange(isoWeek);
  const goLiveMs = new Date(GATE_GO_LIVE_ISO).getTime();
  const conventionStartMs = new Date(FIXES_PR_CONVENTION_START_ISO).getTime();

  const preGatePRs = weekPRs.filter((pr) => new Date(pr.mergedAt).getTime() <= goLiveMs || pr.preGateOverride === true);
  const postGatePRs = weekPRs.filter((pr) => new Date(pr.mergedAt).getTime() > goLiveMs && pr.preGateOverride !== true);
  // Resolution is checked FIRST: `classifyAtMergeVerdict` fails closed to `'review'` for a
  // nullish context, which would fold every unresolved PR into `reviewed`.
  const isResolved = (pr: PullRequestData): boolean => pr.atMergeContext != null || pr.atMergeForcedVerdict != null;
  const verdictOf = (pr: PullRequestData): 'skip' | 'review' =>
    pr.atMergeForcedVerdict ?? classifyAtMergeVerdict(pr.atMergeContext);
  const reviewedPRs = postGatePRs.filter((pr) => isResolved(pr) && verdictOf(pr) === 'review');
  const skippedPRs = postGatePRs.filter((pr) => isResolved(pr) && verdictOf(pr) === 'skip');
  const postGateUnresolved = postGatePRs.filter((pr) => !isResolved(pr)).length;

  const preGateLowRisk = preGatePRs.filter((pr) => isLowRisk(pr.files, riskHighGlobs)).length;

  const reverted = weekPRs.filter(isRevertPR).length;
  const changedLines = weekPRs.reduce((sum, pr) => sum + pr.changedLines, 0);

  const overall = weeklyLaneStats(weekPRs, sortedAll, followupDays);
  const reviewedLane = weeklyLaneStats(reviewedPRs, sortedAll, followupDays);
  const skippedLane = weeklyLaneStats(skippedPRs, sortedAll, followupDays);

  const n = weekPRs.length;
  const postGateMerged = postGatePRs.length;
  const weekEndMs = new Date(endIso).getTime();
  const weekStartMs = new Date(startIso).getTime();
  const linkComplete = weekStartMs >= conventionStartMs;
  const preConventionMerged = linkComplete
    ? 0
    : weekPRs.filter((pr) => new Date(pr.mergedAt).getTime() < conventionStartMs).length;

  return {
    isoWeek,
    weekStartIso: startIso,
    weekEndIso: endIso,
    merged: n,
    isMixedGateWeek: preGatePRs.length > 0 && postGatePRs.length > 0,
    preGateMerged: preGatePRs.length,
    preGateLowRisk,
    preGateHighRisk: preGatePRs.length - preGateLowRisk,
    postGateMerged,
    reviewed: reviewedPRs.length,
    reviewedRate: postGateMerged === 0 ? 0 : reviewedPRs.length / postGateMerged,
    skipped: skippedPRs.length,
    skippedRate: postGateMerged === 0 ? 0 : skippedPRs.length / postGateMerged,
    postGateUnresolved,
    reverted,
    revertRate: n === 0 ? 0 : reverted / n,
    changedLines,
    overall,
    reviewedLane,
    skippedLane,
    linkedPerKLoc: changedLines === 0 ? 0 : overall.linked / (changedLines / 1000),
    immature: nowMs < weekEndMs + followupDays * MS_PER_DAY,
    linkComplete,
    preConventionMerged,
  };
}

/** Does no I/O: `resolveAtMergeContexts` must already have set each PR's `atMergeContext`. */
export function computeWeeklyReport(
  allPRs: readonly PullRequestData[],
  riskHighGlobs: string[],
  followupDays: number,
  nowIso: string = new Date().toISOString(),
): WeeklyReport {
  const mainPRs = allPRs.filter((pr) => pr.baseRefName === SHADOW_REVIEW_BASE_REF);
  const sorted = [...mainPRs].sort((a, b) => new Date(a.mergedAt).getTime() - new Date(b.mergedAt).getTime());
  const nowMs = new Date(nowIso).getTime();

  const buckets = new Map<string, PullRequestData[]>();
  for (const pr of sorted) {
    const week = isoWeekKey(pr.mergedAt);
    const bucket = buckets.get(week);
    if (bucket) bucket.push(pr);
    else buckets.set(week, [pr]);
  }

  const rows = [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([isoWeek, weekPRs]) => buildWeeklyRow(isoWeek, weekPRs, sorted, riskHighGlobs, followupDays, nowMs));

  return { rows, conventionStartIso: FIXES_PR_CONVENTION_START_ISO };
}

function pctStr(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function renderWeeklyMarkdown(
  weekly: WeeklyReport,
  cumulative: ReportResult,
  window: WeeklyWindowInfo,
  weeksToShow = 8,
  nowIso: string = new Date().toISOString(),
): string {
  const lines: string[] = [];
  lines.push('## Review metrics (weekly)');
  lines.push('');
  lines.push(formatWeeklyWindowLine(window));
  const windowAgeNote = formatWindowAgeNote(window.untilIso, nowIso);
  if (windowAgeNote) lines.push(windowAgeNote);
  lines.push('');
  lines.push(
    "These are this file's own definitions, not a reproduction of Augment's Cosmos post — " +
      'that post names neither its output unit nor its matching method, so a number below is ' +
      "comparable only to an earlier run of this same query, not to Cosmos's figures.",
  );
  lines.push('');
  lines.push(
    `The merge gate went live ${GATE_GO_LIVE_ISO} (PR #605): a week entirely before it has no ` +
      '`reviewed`/`skipped` verdict at all (there was no gate to merge on), so it reports a ' +
      'plain low-risk/high-risk **file class** instead, under separate `pre-gate` columns. A ' +
      '`mixed` week straddles that instant — its `reviewed`/`skipped` counts and rates are OVER ' +
      "POST-GATE PRs ONLY, not over the whole week's `n`.",
  );
  lines.push('');
  lines.push(
    `The \`Fixes-PR:\` convention started ${weekly.conventionStartIso} (PR #642): a week whose ` +
      'own start precedes that instant is `partial`, not `link-complete` — some or all of its ' +
      "PRs' `linked` contribution is an undercount, not a true zero, because the convention " +
      "that makes a follow-up discoverable by link wasn't in force yet for them. Only the " +
      'overlap heuristic (an upper bound, never ground truth) says anything about those PRs.',
  );
  lines.push('');
  const shown = weekly.rows.slice(-weeksToShow);
  lines.push(`### Last ${shown.length} week(s) of ${weekly.rows.length} total`);
  lines.push('');
  lines.push(
    '| Week | Range (UTC) | n | Pre-gate: low/high-risk | Reviewed (of post-gate) | Skipped (of post-gate) | ' +
      'Unresolved | This-week reverts | Bug-introducing: linked (ground truth) | ' +
      'Bug-introducing: linked+overlap (upper bound) | Per 1k LOC | Status |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of shown) {
    const range = `${row.weekStartIso.slice(0, 10)} – ${row.weekEndIso.slice(0, 10)}`;
    const gate = row.isMixedGateWeek ? 'mixed' : row.preGateMerged > 0 ? 'pre-gate' : 'post-gate';
    const status = [
      row.immature ? 'immature' : null,
      row.linkComplete ? null : `partial (${row.preConventionMerged} pre-convention)`,
    ]
      .filter((s): s is string => s !== null)
      .join(', ');
    const upperBound = row.overall.linked + row.overall.overlapHeuristic;
    const upperBoundRate = row.overall.merged === 0 ? 0 : upperBound / row.overall.merged;
    lines.push(
      `| ${row.isoWeek} | ${range} | ${row.merged} (${gate}) | ${row.preGateLowRisk}/${row.preGateHighRisk} | ` +
        `${row.reviewed} (${pctStr(row.reviewedRate)}) | ${row.skipped} (${pctStr(row.skippedRate)}) | ` +
        `${row.postGateUnresolved} | ${row.reverted} (${pctStr(row.revertRate)}) | ` +
        `${row.overall.linked}/${row.overall.merged} (${pctStr(row.overall.linkedRate)}) | ` +
        `${upperBound}/${row.overall.merged} (${pctStr(upperBoundRate)}) | ` +
        `${row.linkedPerKLoc.toFixed(3)} | ${status || 'final'} |`,
    );
  }
  lines.push('');
  lines.push(
    'Per lane (reviewed vs skipped, POST-GATE PRs only), bug-introducing rate by link ' +
      '(ground truth) and the linked+overlap upper bound:',
  );
  lines.push('');
  lines.push('| Week | Reviewed: linked | Reviewed: upper bound | Skipped: linked | Skipped: upper bound |');
  lines.push('|---|---|---|---|---|');
  for (const row of shown) {
    const reviewedBound = row.reviewedLane.linked + row.reviewedLane.overlapHeuristic;
    const reviewedBoundRate = row.reviewedLane.merged === 0 ? 0 : reviewedBound / row.reviewedLane.merged;
    const skippedBound = row.skippedLane.linked + row.skippedLane.overlapHeuristic;
    const skippedBoundRate = row.skippedLane.merged === 0 ? 0 : skippedBound / row.skippedLane.merged;
    lines.push(
      `| ${row.isoWeek} | ${row.reviewedLane.linked}/${row.reviewedLane.merged} (${pctStr(row.reviewedLane.linkedRate)}) | ` +
        `${reviewedBound}/${row.reviewedLane.merged} (${pctStr(reviewedBoundRate)}) | ` +
        `${row.skippedLane.linked}/${row.skippedLane.merged} (${pctStr(row.skippedLane.linkedRate)}) | ` +
        `${skippedBound}/${row.skippedLane.merged} (${pctStr(skippedBoundRate)}) |`,
    );
  }
  lines.push('');
  lines.push(`### Cumulative, ±${cumulative.days}d around the switch (${cumulative.switchIso})`);
  lines.push('');
  lines.push(
    '_"Reverted" here is a DIFFERENT definition from the weekly table above: this is low-risk ' +
      'PRs LATER reverted (within the before/after window), not PRs that are themselves reverts._',
  );
  lines.push('');
  lines.push('| | Before | After |');
  lines.push('|---|---|---|');
  lines.push(`| Merged (all risk levels) | ${cumulative.before.totalMerged} | ${cumulative.after.totalMerged} |`);
  lines.push(`| Merged (low-risk) | ${cumulative.before.lowRiskMerged} | ${cumulative.after.lowRiskMerged} |`);
  lines.push(
    `| Followed up — link | ${cumulative.before.followedUpByLink} (${pctStr(cumulative.before.followedUpByLinkRate)}) | ` +
      `${cumulative.after.followedUpByLink} (${pctStr(cumulative.after.followedUpByLinkRate)}) |`,
  );
  lines.push(
    `| Followed up — overlap | ${cumulative.before.followedUpByOverlap} (${pctStr(cumulative.before.followedUpByOverlapRate)}) | ` +
      `${cumulative.after.followedUpByOverlap} (${pctStr(cumulative.after.followedUpByOverlapRate)}) |`,
  );
  lines.push(
    `| Low-risk PRs later reverted | ${cumulative.before.reverted} (${pctStr(cumulative.before.revertedRate)}) | ` +
      `${cumulative.after.reverted} (${pctStr(cumulative.after.revertedRate)}) |`,
  );
  lines.push(
    `| Shadow-reviewed | ${cumulative.before.shadowReviewed} (${pctStr(cumulative.before.shadowReviewedRate)}) | ` +
      `${cumulative.after.shadowReviewed} (${pctStr(cumulative.after.shadowReviewedRate)}) |`,
  );
  lines.push(
    `| Shadow-review P1 | ${cumulative.before.shadowReviewP1} (${pctStr(cumulative.before.shadowReviewP1Rate)}) | ` +
      `${cumulative.after.shadowReviewP1} (${pctStr(cumulative.after.shadowReviewP1Rate)}) |`,
  );
  if (cumulative.before.caveat) lines.push(`\n_before caveat: ${cumulative.before.caveat}_`);
  if (cumulative.after.caveat) lines.push(`\n_after caveat: ${cumulative.after.caveat}_`);
  return lines.join('\n');
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function fetchLabelerYaml(repo: string): string {
  return gh(['api', `repos/${repo}/contents/.github/labeler.yml`, '-H', 'Accept: application/vnd.github.raw']);
}

interface RawPrFile {
  path?: string;
  filename?: string;
  additions?: number;
  deletions?: number;
}

interface RawPrLabel {
  name: string;
}

interface RawPr {
  number: number;
  title: string;
  body: string | null;
  mergedAt: string;
  changedFiles: number;
  files: RawPrFile[];
  labels?: RawPrLabel[];
  baseRefName: string;
  additions: number;
  deletions: number;
  headRefOid: string;
  mergeCommit?: { oid: string } | null;
}

interface ResolvedFileEntry {
  path: string;
  additions: number;
  deletions: number;
}

function fetchAllFileEntriesViaRest(repo: string, prNumber: number): ResolvedFileEntry[] {
  const raw = gh(['api', `repos/${repo}/pulls/${prNumber}/files`, '--paginate', '--slurp']);
  const pages = JSON.parse(raw) as RawPrFile[][];
  return pages
    .flat()
    .map((f) => ({ path: f.filename ?? f.path ?? '', additions: f.additions ?? 0, deletions: f.deletions ?? 0 }));
}

function resolveFileEntries(repo: string, pr: RawPr): ResolvedFileEntry[] {
  if (pr.files.length < pr.changedFiles) {
    // gh pr list's `files` field truncates on large PRs; changedFiles is the true total.
    return fetchAllFileEntriesViaRest(repo, pr.number);
  }
  return pr.files.map((f) => ({
    path: f.path ?? f.filename ?? '',
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
  }));
}

/** Excluded from the kLOC denominator: an auto-regenerated diff would dilute the rate. */
export function generatedFileChangedLines(entries: readonly ResolvedFileEntry[]): number {
  return entries.filter((e) => GENERATED_FILES.has(e.path)).reduce((sum, e) => sum + e.additions + e.deletions, 0);
}

function toPullRequestData(repo: string, pr: RawPr): PullRequestData {
  const fileEntries = resolveFileEntries(repo, pr);
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    mergedAt: pr.mergedAt,
    files: fileEntries.map((f) => f.path),
    labels: (pr.labels ?? []).map((label) => label.name),
    baseRefName: pr.baseRefName,
    changedLines: Math.max(0, pr.additions + pr.deletions - generatedFileChangedLines(fileEntries)),
    changedFiles: pr.changedFiles,
    mergeCommitOid: pr.mergeCommit?.oid ?? null,
    headRefOid: pr.headRefOid,
  };
}

export interface MergedPrSearchSlice {
  startIso: string;
  endIso: string;
}

export function computeMergedSearchSlices(sinceIso: string, untilIso: string): MergedPrSearchSlice[] {
  const untilMs = new Date(untilIso).getTime();
  let cursorMs = new Date(sinceIso).getTime();
  const slices: MergedPrSearchSlice[] = [];
  while (cursorMs <= untilMs) {
    const { endIso: weekEndIso } = isoWeekDateRange(isoWeekKey(new Date(cursorMs).toISOString()));
    const weekEndMs = new Date(weekEndIso).getTime();
    const sliceEndMs = Math.min(weekEndMs, untilMs);
    slices.push({ startIso: new Date(cursorMs).toISOString(), endIso: new Date(sliceEndMs).toISOString() });
    cursorMs = sliceEndMs + 1;
  }
  return slices;
}

/** Throws at the 1,000-result search cap: past it, search returns exactly 1,000 rows and no error. */
export function combineMergedPrSlices(
  sliceResults: readonly { slice: MergedPrSearchSlice; prs: readonly PullRequestData[] }[],
): PullRequestData[] {
  const byNumber = new Map<number, PullRequestData>();
  for (const { slice, prs } of sliceResults) {
    if (prs.length >= 1000) {
      throw new Error(
        `review-outcomes: fetchMergedPRs: search slice merged:${slice.startIso}..${slice.endIso} returned ` +
          `${prs.length} pull requests — GitHub's search API caps results at 1,000 per query and returns no error ` +
          `past that point, so this slice is likely truncated and silently wrong. Raising --limit cannot fix this; ` +
          `the window needs finer slicing than one ISO week for this period.`,
      );
    }
    for (const pr of prs) byNumber.set(pr.number, pr);
  }
  return [...byNumber.values()];
}

function fetchMergedPrsForSlice(repo: string, slice: MergedPrSearchSlice): PullRequestData[] {
  const raw = gh([
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'merged',
    '--search',
    `merged:${slice.startIso}..${slice.endIso}`,
    '--json',
    'number,title,body,mergedAt,changedFiles,files,labels,baseRefName,additions,deletions,headRefOid,mergeCommit',
    '--limit',
    '1000',
  ]);
  const prs = JSON.parse(raw) as RawPr[];
  return prs.map((pr) => toPullRequestData(repo, pr));
}

// GitHub's search index can lag a just-completed merge.
const SEARCH_TOTAL_COUNT_RETRY_WAIT_MS = 3000;

function sleepMsSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Must send exactly the search qualifiers `fetchMergedPrsForSlice` uses. */
function fetchMergedPrTotalCount(repo: string, sinceIso: string, untilIso: string): number {
  const raw = gh([
    'api',
    '-X',
    'GET',
    'search/issues',
    '-f',
    `q=repo:${repo} is:pr is:merged merged:${sinceIso}..${untilIso}`,
    '--jq',
    '.total_count',
  ]);
  const count = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(count)) {
    throw new Error(
      `review-outcomes: fetchMergedPrTotalCount: unparseable total_count from gh: ${JSON.stringify(raw)}`,
    );
  }
  return count;
}

/** A malformed `merged:` bound returns an empty or partial result with no error. Search allows 30 requests/minute. */
export function verifyMergedPrTotalCount(
  combinedCount: number,
  window: { repo: string; sinceIso: string; untilIso: string },
  fetchTotal: (repo: string, sinceIso: string, untilIso: string) => number = fetchMergedPrTotalCount,
  wait: (ms: number) => void = sleepMsSync,
): void {
  const first = fetchTotal(window.repo, window.sinceIso, window.untilIso);
  if (first === combinedCount) return;
  wait(SEARCH_TOTAL_COUNT_RETRY_WAIT_MS);
  const second = fetchTotal(window.repo, window.sinceIso, window.untilIso);
  if (second === combinedCount) return;
  throw new Error(
    `review-outcomes: fetchMergedPRs: combined per-week slices for merged:${window.sinceIso}..${window.untilIso} ` +
      `produced ${combinedCount} unique pull request(s), but GitHub search's total_count for the identical window ` +
      `and qualifiers is ${second} (first read: ${first}) after one retry for search-index lag. A malformed or ` +
      `unparsed search bound can return 0 rows (or a partial count) with no error at all — never proceeding on a ` +
      `mismatched count.`,
  );
}

export const UNTIL_ISO_SEARCH_INDEX_LAG_MARGIN_MS = 2 * 60 * 1000;

/**
 * `origin/main`'s tip, never `HEAD` or wall-clock: every PR the window returns is then an ancestor
 * of the checkout, so a local miss in `commitExistsLocally` is a genuine gap.
 */
export function resolveMainTipUntilIso(marginMs: number = UNTIL_ISO_SEARCH_INDEX_LAG_MARGIN_MS): string {
  let raw: string;
  try {
    raw = execFileSync('git', ['log', '-1', '--format=%cI', 'origin/main'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (err) {
    throw new Error(
      `review-outcomes: resolveMainTipUntilIso: could not resolve origin/main's tip commit (\`git log -1 ` +
        `--format=%cI origin/main\` failed) — the search window's end must come from the checked-out ` +
        `origin/main, never a wall-clock fallback. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const tipMs = new Date(raw).getTime();
  if (!Number.isFinite(tipMs)) {
    throw new Error(
      `review-outcomes: resolveMainTipUntilIso: unparseable committer date from \`git log -1 --format=%cI ` +
        `origin/main\`: ${JSON.stringify(raw)}`,
    );
  }
  return new Date(tipMs - marginMs).toISOString();
}

export interface MainTipInfo {
  shortSha: string;
  tipIso: string;
}

export function resolveMainTipInfo(): MainTipInfo {
  let raw: string;
  try {
    raw = execFileSync('git', ['log', '-1', '--format=%h%x1f%cI', 'origin/main'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (err) {
    throw new Error(
      `review-outcomes: resolveMainTipInfo: could not resolve origin/main's tip commit (\`git log -1 ` +
        `--format=%h%x1f%cI origin/main\` failed) — the weekly window line must name the checked-out ` +
        `origin/main's own tip, never a wall-clock fallback. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const sepIdx = raw.indexOf('\x1f');
  const shortSha = sepIdx === -1 ? '' : raw.slice(0, sepIdx);
  const tipIso = sepIdx === -1 ? '' : raw.slice(sepIdx + 1);
  if (!shortSha || !tipIso || !Number.isFinite(new Date(tipIso).getTime())) {
    throw new Error(
      `review-outcomes: resolveMainTipInfo: unparseable output from \`git log -1 --format=%h%x1f%cI ` +
        `origin/main\`: ${JSON.stringify(raw)}`,
    );
  }
  return { shortSha, tipIso };
}

export interface WeeklyWindowInfo {
  sinceIso: string;
  untilIso: string;
  tip: MainTipInfo;
}

export function formatWeeklyWindowLine(window: WeeklyWindowInfo): string {
  return `window: ${window.sinceIso}..${window.untilIso} (origin/main ${window.tip.shortSha} @ ${window.tip.tipIso})`;
}

// Must stay well above UNTIL_ISO_SEARCH_INDEX_LAG_MARGIN_MS, or the deliberate search-lag margin alone trips the note.
export const WINDOW_AGE_NOTE_THRESHOLD_MS = 60 * 60 * 1000;

export function formatWindowAgeNote(
  untilIso: string,
  nowIso: string = new Date().toISOString(),
  thresholdMs: number = WINDOW_AGE_NOTE_THRESHOLD_MS,
): string | null {
  const untilMs = new Date(untilIso).getTime();
  const nowMs = new Date(nowIso).getTime();
  if (!Number.isFinite(untilMs) || !Number.isFinite(nowMs)) return null;
  const ageMs = nowMs - untilMs;
  if (ageMs <= thresholdMs) return null;
  const ageHours = (ageMs / (60 * 60 * 1000)).toFixed(1);
  return `NOTE: report window ends ${ageHours}h before this run; commit age does not establish checkout freshness.`;
}

export function fetchMergedPRs(repo: string, sinceIso: string, untilIso: string): PullRequestData[] {
  const slices = computeMergedSearchSlices(sinceIso, untilIso);
  const sliceResults = slices.map((slice) => ({ slice, prs: fetchMergedPrsForSlice(repo, slice) }));
  const combined = combineMergedPrSlices(sliceResults);
  // One `untilIso` bounds both, so a PR merging mid-run can't manufacture a mismatch.
  verifyMergedPrTotalCount(combined.length, { repo, sinceIso, untilIso });
  return combined;
}

/** Runs in `process.cwd()`: the caller must be inside the checkout being replayed. */
function git(args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** No fetch fallback: the window ends at `origin/main`'s tip, so a miss is a genuine gap. */
function commitExistsLocally(sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return false;
  }
}

export function mergeCommitParentsLocal(mergeCommitOid: string): string[] | null {
  if (!commitExistsLocally(mergeCommitOid)) return null;
  let raw: string;
  try {
    raw = git(['log', '-1', '--format=%P', mergeCommitOid]);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}

export type LabelerReadResult =
  | { kind: 'found'; globs: string[] }
  | { kind: 'missing' } // the commit resolves locally, but the path doesn't exist in its tree
  | { kind: 'error' }; // the commit doesn't resolve locally, or the file exists but is unparseable/wrong-shaped

/** Not `cat-file -e`: that needs the blob, so a partial clone would misread a present file as missing. */
function labelerPathExistsAtSha(sha: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '-q', `${sha}:.github/labeler.yml`], { stdio: 'ignore' });
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return false;
  }
}

export function readRiskHighGlobsAtShaLocal(sha: string): LabelerReadResult {
  if (!commitExistsLocally(sha)) return { kind: 'error' };
  if (!labelerPathExistsAtSha(sha)) return { kind: 'missing' };
  let raw: string;
  try {
    raw = git(['show', `${sha}:.github/labeler.yml`]);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return { kind: 'error' };
  }
  try {
    return { kind: 'found', globs: globsForRiskHigh(parse(raw) as Record<string, unknown>) };
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return { kind: 'error' };
  }
}

/** `-z` is load-bearing: without it `core.quotePath` quotes non-ASCII paths and a risk:high
 *  glob match silently misses. A rename/copy is three NUL fields, anything else two. */
export interface GitDiffEntry {
  status: string;
  path: string;
  previousPath?: string;
}

export function parseGitNameStatus(raw: string): GitDiffEntry[] {
  const fields = raw.split('\0');
  if (fields.length > 0 && fields[fields.length - 1] === '') fields.pop(); // trailing NUL terminator
  const entries: GitDiffEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i] ?? '';
    i += 1;
    if (status.startsWith('R') || status.startsWith('C')) {
      entries.push({ status, previousPath: fields[i] ?? '', path: fields[i + 1] ?? '' });
      i += 2;
    } else {
      entries.push({ status, path: fields[i] ?? '' });
      i += 1;
    }
  }
  return entries;
}

/**
 * `null` when the listing doesn't match GitHub's `changedFiles` (fail closed). `'over-cap'` at 300+
 * files, where the gate's `compare` read truncates and it answers `review`.
 */
export function fileDiffAtMergeLocal(
  baseSha: string,
  mergeCommitOid: string,
  changedFiles: number,
): string[] | 'over-cap' | null {
  let raw: string;
  try {
    raw = git(['diff', '--name-status', '-M', '-z', baseSha, mergeCommitOid]);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return null;
  }
  const entries = parseGitNameStatus(raw);
  if (entries.length >= 300) return 'over-cap'; // codex-review.sh — the gate's own fail-closed-to-`review` cap
  if (entries.length !== changedFiles) return null; // count mismatch — incomplete or wrong listing
  const names = new Set<string>();
  for (const e of entries) {
    names.add(e.path);
    if (e.previousPath) names.add(e.previousPath);
  }
  return [...names];
}

export type LocalAtMergeFileContext =
  | { kind: 'resolved'; files: string[]; riskHighGlobs: string[] }
  | { kind: 'pre-gate' }
  | { kind: 'review' }
  | { kind: 'unresolved' };

export function resolveAtMergeFileContextLocal(input: {
  mergeCommitOid: string;
  headRefOid: string;
  changedFiles: number;
}): LocalAtMergeFileContext {
  const parentOids = mergeCommitParentsLocal(input.mergeCommitOid);
  if (parentOids === null) return { kind: 'unresolved' };
  const baseSha = resolveAtMergeBaseSha({
    headRefOid: input.headRefOid,
    mergeCommitOid: input.mergeCommitOid,
    parentOids,
  });
  if (baseSha === null) return { kind: 'unresolved' };
  const labelerResult = readRiskHighGlobsAtShaLocal(baseSha);
  if (labelerResult.kind === 'missing') return { kind: 'pre-gate' };
  if (labelerResult.kind === 'error') return { kind: 'unresolved' };
  const files = fileDiffAtMergeLocal(baseSha, input.mergeCommitOid, input.changedFiles);
  if (files === 'over-cap') return { kind: 'review' };
  if (files === null) return { kind: 'unresolved' };
  return { kind: 'resolved', files, riskHighGlobs: labelerResult.globs };
}

interface RawAtMergeLabelEventNode {
  __typename: 'LabeledEvent' | 'UnlabeledEvent';
  createdAt: string;
  label: { name: string } | null;
}

interface RawAtMergeLabelsPrNode {
  labelEvents: { pageInfo: { hasNextPage: boolean }; nodes: RawAtMergeLabelEventNode[] };
}

const AT_MERGE_GRAPHQL_BATCH_SIZE = 30;

let atMergeGraphQlFailureLogged = false;

/** PR numbers are our own integers, never PR-authored text, so inlining them is safe. Never throws. */
export function fetchAtMergeLabelEventsBatch(
  repo: string,
  prNumbers: readonly number[],
): Map<number, RawAtMergeLabelEventNode[]> {
  const result = new Map<number, RawAtMergeLabelEventNode[]>();
  const [owner, name] = repo.split('/');
  const fields = prNumbers
    .map(
      (n, i) => `pr${i}: pullRequest(number: ${n}) {
        labelEvents: timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT], first: 100) {
          pageInfo { hasNextPage }
          nodes {
            __typename
            ... on LabeledEvent { createdAt label { name } }
            ... on UnlabeledEvent { createdAt label { name } }
          }
        }
      }`,
    )
    .join('\n');
  const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {\n${fields}\n} }`;
  let parsed: { data: { repository: Record<string, RawAtMergeLabelsPrNode | null> } };
  try {
    const raw = gh(['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`]);
    parsed = JSON.parse(raw) as { data: { repository: Record<string, RawAtMergeLabelsPrNode | null> } };
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    if (!atMergeGraphQlFailureLogged) {
      atMergeGraphQlFailureLogged = true;
      console.error(
        `review-outcomes: at-merge label-event fetch failed for a batch of ${prNumbers.length} PR(s) — ` +
          `those PRs will be reported unresolved (further failures this run are not logged again): ${String(err)}`,
      );
    }
    return result; // empty — every PR in this batch is absent, which the caller reads as unresolved
  }
  prNumbers.forEach((n, i) => {
    const node = parsed.data.repository[`pr${i}`];
    if (node && !node.labelEvents.pageInfo.hasNextPage) result.set(n, node.labelEvents.nodes);
  });
  return result;
}

/** PRs merged at or before `GATE_GO_LIVE_ISO` are absent from the result: never attempted. */
export function resolveAtMergeContexts(
  repo: string,
  prs: readonly {
    number: number;
    mergedAt: string;
    changedFiles: number;
    mergeCommitOid: string | null;
    headRefOid: string;
  }[],
): Map<number, { atMergeContext: AtMergeContext | null; preGateOverride: boolean; atMergeForcedVerdict?: 'review' }> {
  const result = new Map<
    number,
    { atMergeContext: AtMergeContext | null; preGateOverride: boolean; atMergeForcedVerdict?: 'review' }
  >();
  const goLiveMs = new Date(GATE_GO_LIVE_ISO).getTime();
  const postGate = prs.filter((pr) => new Date(pr.mergedAt).getTime() > goLiveMs);
  for (let i = 0; i < postGate.length; i += AT_MERGE_GRAPHQL_BATCH_SIZE) {
    const batch = postGate.slice(i, i + AT_MERGE_GRAPHQL_BATCH_SIZE);
    const labelEventsByPr = fetchAtMergeLabelEventsBatch(
      repo,
      batch.map((pr) => pr.number),
    );
    for (const pr of batch) {
      if (pr.mergeCommitOid === null) {
        result.set(pr.number, { atMergeContext: null, preGateOverride: false });
        continue;
      }
      const fileContext = resolveAtMergeFileContextLocal({
        mergeCommitOid: pr.mergeCommitOid,
        headRefOid: pr.headRefOid,
        changedFiles: pr.changedFiles,
      });
      if (fileContext.kind === 'pre-gate') {
        result.set(pr.number, { atMergeContext: null, preGateOverride: true });
        continue;
      }
      if (fileContext.kind === 'review') {
        result.set(pr.number, { atMergeContext: null, preGateOverride: false, atMergeForcedVerdict: 'review' });
        continue;
      }
      if (fileContext.kind === 'unresolved') {
        result.set(pr.number, { atMergeContext: null, preGateOverride: false });
        continue;
      }
      const labelEvents = labelEventsByPr.get(pr.number);
      if (!labelEvents) {
        result.set(pr.number, { atMergeContext: null, preGateOverride: false });
        continue;
      }
      const events: RawLabelEvent[] = labelEvents
        .filter((n): n is RawAtMergeLabelEventNode & { label: { name: string } } => n.label !== null)
        .map((n) => ({
          type: n.__typename === 'LabeledEvent' ? 'labeled' : 'unlabeled',
          name: n.label.name,
          createdAt: n.createdAt,
        }));
      const labels = replayLabelsAtMerge(events, pr.mergedAt);
      result.set(pr.number, {
        atMergeContext: { files: fileContext.files, labels, riskHighGlobs: fileContext.riskHighGlobs },
        preGateOverride: false,
      });
    }
  }
  return result;
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
}

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

interface RawLabeledPr {
  number: number;
}

function fetchPRsByLabel(repo: string, label: string): number[] {
  const raw = gh([
    'pr',
    'list',
    '--repo',
    repo,
    '--label',
    label,
    '--state',
    'all',
    '--json',
    'number',
    '--limit',
    '1000',
  ]);
  const prs = JSON.parse(raw) as RawLabeledPr[];
  return prs.map((pr) => pr.number);
}

export function fetchShadowReviewFailedPRs(repo: string): number[] {
  return fetchPRsByLabel(repo, 'shadow-review-failed');
}

export function fetchShadowReviewedPRs(repo: string): number[] {
  return fetchPRsByLabel(repo, 'shadow-reviewed');
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    repo: 'davekim917/nanoclaw',
    // The gate's actual go-live instant: a rounded midnight would misclassify PRs merged before it.
    switchIso: GATE_GO_LIVE_ISO,
    days: 30,
    followupDays: 14,
    json: false,
  };
  walkArgs(argv, fail, (name, arg, value) => {
    if (name === '--repo') options.repo = value();
    else if (name === '--switch') options.switchIso = value();
    else if (name === '--days') options.days = Number(value());
    else if (name === '--followup-days') options.followupDays = Number(value());
    else if (name === '--json') options.json = true;
    else if (name === '--weekly') options.weekly = true;
    else if (name === '--weekly-days') options.weeklyDays = Number(value());
    else if (name === '--help' || name === '-h') usage();
    else if (arg !== '--') fail(`unknown argument: ${arg}`);
  });
  if (!Number.isFinite(options.days) || options.days <= 0) fail('--days must be a positive number');
  if (!Number.isFinite(options.followupDays) || options.followupDays <= 0)
    fail('--followup-days must be a positive number');
  if (Number.isNaN(new Date(options.switchIso).getTime()))
    fail(`--switch is not a valid ISO date: ${options.switchIso}`);
  if (options.weeklyDays !== undefined && (!Number.isFinite(options.weeklyDays) || options.weeklyDays <= 0))
    fail('--weekly-days must be a positive number');
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
      '         [--weekly [--weekly-days <n>]]',
      '',
      'Measures whether low-risk PRs merged without review (after --switch) drew more',
      'follow-up fixes or reverts than low-risk PRs did while every PR was reviewed',
      '(before --switch). See docs/specs/risk-based-review/plan.md, "Measurement".',
      '',
      '--weekly reports one row per ISO week of PRs merged into main instead: merged',
      "PRs split into reviewed/skipped lanes (replaying the merge gate's own skip-verdict",
      'rule), the revert rate, and the bug-introducing rate (Fixes-PR link, ground truth,',
      'and file-overlap heuristic, kept separate) overall and per lane, plus the linked',
      'rate per 1,000 changed lines. --weekly-days (default 90) bounds how far back of',
      '"now" it fetches; --json emits { weekly, cumulative, markdown } in one call, where',
      '`cumulative` is the same before/after report --switch/--days already compute and',
      '`markdown` is the ready-to-post tracking-issue comment body (last 8 weeks plus the',
      'cumulative comparison).',
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
  console.log(
    `    shadow-review FAILED:      ${bucket.shadowReviewFailed} (${pct(bucket.shadowReviewFailedRate)})` +
      (bucket.shadowReviewFailedPRs.length ? ` [${bucket.shadowReviewFailedPRs.map((n) => `#${n}`).join(', ')}]` : ''),
  );
  if (bucket.caveat) console.log(`    caveat: ${bucket.caveat}`);
}

function printShadowCoverage(coverage: ShadowCoverageResult): void {
  console.log(`Shadow coverage since go-live (${coverage.sinceIso}), by CURRENT label eligibility:`);
  console.log(`  eligible:     ${coverage.eligible}`);
  console.log(
    `  reviewed:     ${coverage.reviewed} (${pct(coverage.reviewedRate)})` +
      (coverage.reviewedPRs.length ? ` [${coverage.reviewedPRs.map((n) => `#${n}`).join(', ')}]` : ''),
  );
  console.log(
    `  FAILED:       ${coverage.failed} (${pct(coverage.failedRate)})` +
      (coverage.failedPRs.length ? ` [${coverage.failedPRs.map((n) => `#${n}`).join(', ')}]` : ''),
  );
  console.log(
    `  not yet run:  ${coverage.notYetRun} (${pct(coverage.notYetRunRate)})` +
      (coverage.notYetRunPRs.length ? ` [${coverage.notYetRunPRs.map((n) => `#${n}`).join(', ')}]` : ''),
  );
  console.log(`  caveat: ${coverage.caveat}`);
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
  console.log('');
  printShadowCoverage(report.shadowCoverage);
}

/** `switch - days` alone would undercount shadow coverage. Compared as timestamps: `...Z` and `.sssZ` don't sort lexically. */
export function computeFetchSinceIso(
  switchIso: string,
  days: number,
  goLiveIso: string = SHADOW_REVIEW_GO_LIVE_ISO,
): string {
  const switchBasedMs = new Date(switchIso).getTime() - days * MS_PER_DAY;
  const goLiveMs = new Date(goLiveIso).getTime();
  return new Date(Math.min(switchBasedMs, goLiveMs)).toISOString();
}

export function computeWeeklyFetchSinceIso(untilIso: string, weeklyDays: number): string {
  return new Date(new Date(untilIso).getTime() - weeklyDays * MS_PER_DAY).toISOString();
}

export function printWeeklyReport(
  weekly: WeeklyReport,
  window: WeeklyWindowInfo,
  nowIso: string = new Date().toISOString(),
): void {
  console.log(
    `review-outcomes --weekly: gate go-live = ${GATE_GO_LIVE_ISO}, Fixes-PR convention start = ${weekly.conventionStartIso}`,
  );
  console.log("(these are this file's own definitions — not directly comparable to Augment Cosmos's figures)");
  console.log(formatWeeklyWindowLine(window));
  const windowAgeNote = formatWindowAgeNote(window.untilIso, nowIso);
  if (windowAgeNote) console.log(windowAgeNote);
  console.log('');
  for (const row of weekly.rows) {
    const gate = row.isMixedGateWeek ? 'mixed' : row.preGateMerged > 0 ? 'pre-gate' : 'post-gate';
    console.log(`${row.isoWeek} (${row.weekStartIso.slice(0, 10)} – ${row.weekEndIso.slice(0, 10)}) [${gate}]:`);
    console.log(`  merged: ${row.merged}`);
    if (row.preGateMerged > 0) {
      console.log(
        `  pre-gate (descriptive, NOT a review verdict): ${row.preGateMerged} — low-risk ${row.preGateLowRisk}, high-risk ${row.preGateHighRisk}`,
      );
    }
    if (row.postGateMerged > 0) {
      console.log(
        `  post-gate: ${row.postGateMerged} — reviewed ${row.reviewed} (${pct(row.reviewedRate)}), skipped ${row.skipped} (${pct(row.skippedRate)})` +
          (row.postGateUnresolved > 0 ? `, unresolved ${row.postGateUnresolved}` : ''),
      );
    }
    console.log(`  this-week reverts: ${row.reverted} (${pct(row.revertRate)})`);
    const overallBound = row.overall.linked + row.overall.overlapHeuristic;
    console.log(
      `  bug-introducing — overall: linked (ground truth) ${row.overall.linked}/${row.overall.merged} (${pct(row.overall.linkedRate)}), ` +
        `linked+overlap (upper bound) ${overallBound}/${row.overall.merged}`,
    );
    console.log(
      `  bug-introducing — reviewed lane: linked ${row.reviewedLane.linked}/${row.reviewedLane.merged} (${pct(row.reviewedLane.linkedRate)})`,
    );
    console.log(
      `  bug-introducing — skipped lane:  linked ${row.skippedLane.linked}/${row.skippedLane.merged} (${pct(row.skippedLane.linkedRate)})`,
    );
    console.log(
      `  linked per 1,000 changed lines (generated files excluded): ${row.linkedPerKLoc.toFixed(3)} (changed lines: ${row.changedLines})`,
    );
    const flags = [
      row.immature ? 'immature' : null,
      row.linkComplete ? null : `partial (${row.preConventionMerged} pre-convention)`,
    ].filter((f): f is string => f !== null);
    if (flags.length) console.log(`  flags: ${flags.join(', ')}`);
    console.log('');
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  const labelerYaml = fetchLabelerYaml(options.repo);
  const labelerConfig = parse(labelerYaml) as Record<string, unknown>;
  const riskHighGlobs = globsForRiskHigh(labelerConfig);

  // From `origin/main`'s tip, never wall-clock `now`: one commit grounds the whole run's window.
  const untilIso = resolveMainTipUntilIso();

  const beforeAfterSinceIso = computeFetchSinceIso(options.switchIso, options.days);

  if (options.weekly) {
    const weeklySinceIso = computeWeeklyFetchSinceIso(untilIso, options.weeklyDays ?? 90);
    const sinceIso =
      new Date(weeklySinceIso).getTime() < new Date(beforeAfterSinceIso).getTime()
        ? weeklySinceIso
        : beforeAfterSinceIso;
    const windowInfo: WeeklyWindowInfo = { sinceIso, untilIso, tip: resolveMainTipInfo() };
    const fetchedPRs = fetchMergedPRs(options.repo, sinceIso, untilIso);
    const shadowReviewIssues = fetchShadowReviewIssues(options.repo);
    const shadowReviewFailedPrNumbers = fetchShadowReviewFailedPRs(options.repo);
    const shadowReviewedLabelPrNumbers = fetchShadowReviewedPRs(options.repo);

    const atMergeContexts = resolveAtMergeContexts(options.repo, fetchedPRs);
    const allPRs = fetchedPRs.map((pr) => {
      const resolved = atMergeContexts.get(pr.number);
      // NOT `?? undefined`: `null` (attempted, unresolved) must stay distinct from `undefined`
      // (never attempted) for `postGateUnresolved`.
      return {
        ...pr,
        atMergeContext: resolved ? resolved.atMergeContext : undefined,
        preGateOverride: resolved ? resolved.preGateOverride : false,
        atMergeForcedVerdict: resolved?.atMergeForcedVerdict,
      };
    });

    const cumulative = computeReport(
      allPRs,
      riskHighGlobs,
      options,
      shadowReviewIssues,
      shadowReviewFailedPrNumbers,
      shadowReviewedLabelPrNumbers,
    );
    const weekly = computeWeeklyReport(allPRs, riskHighGlobs, options.followupDays);

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            repo: options.repo,
            followupDays: options.followupDays,
            weeklyDays: options.weeklyDays ?? 90,
            since: sinceIso,
            until: untilIso,
            weekly,
            cumulative,
            markdown: renderWeeklyMarkdown(weekly, cumulative, windowInfo),
          },
          null,
          2,
        ),
      );
    } else {
      printWeeklyReport(weekly, windowInfo);
      console.log('');
      printReport(cumulative);
    }
    return;
  }

  const allPRs = fetchMergedPRs(options.repo, beforeAfterSinceIso, untilIso);
  const shadowReviewIssues = fetchShadowReviewIssues(options.repo);
  const shadowReviewFailedPrNumbers = fetchShadowReviewFailedPRs(options.repo);
  const shadowReviewedLabelPrNumbers = fetchShadowReviewedPRs(options.repo);

  const report = computeReport(
    allPRs,
    riskHighGlobs,
    options,
    shadowReviewIssues,
    shadowReviewFailedPrNumbers,
    shadowReviewedLabelPrNumbers,
  );

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}

if (process.argv[1] && new URL(process.argv[1], 'file:').href === import.meta.url) {
  main();
}
