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
 * PR gets a PR comment instead, no issue. An issue alone therefore undercounts coverage
 * — a clean review leaves no issue to find — so `report`'s success path ALSO applies a
 * `shadow-reviewed` label to the PR itself, whether the review was clean or found
 * something ("File findings, or confirm none were found", both branches). "Was this
 * skipped PR shadow-reviewed" is `shadow-reviewed` label present OR a shadow-review issue
 * exists for it — the OR keeps counting PRs reviewed before the label existed, which have
 * an issue but no label, so that history isn't lost when this label shipped later than the
 * issue mechanism. "Did the review find a P1" stays issue-only, unaffected by the label:
 * match each issue's title against `SHADOW_REVIEW_TITLE_RE` to recover the PR number, and
 * its body against `P1_LINE_RE` for a finding line marked P1 (the workflow's report step
 * renders every finding as its own bullet, e.g. "- **P1** — file:line — class:
 * description"). The match is anchored to that bullet's start (`^- \*\*P1\*\*`, multiline),
 * not a bare `\bP1\b`, so a P2 finding whose free-text description merely *mentions* "P1"
 * (e.g. referencing another PR's finding) doesn't get counted as one.
 *
 * Shadow-review FAILURE counting is separate and deliberately not folded into "not
 * shadow-reviewed": when `analyze` errors before Claude produces a result (an expired
 * credential, an action-side crash), or when `report` itself fails to file the result
 * after a successful `analyze` (a scrub refusal, a `gh pr comment`/`gh issue create`
 * failure), `report` labels the PR `shadow-review-failed` instead of applying
 * `shadow-reviewed` (`.github/workflows/shadow-review.yml`, "Report that analyze failed"
 * and "Report a filing failure"). Counting a failed run the same as "clean, no issue"
 * would hide an outage inside a number that looks reassuring; `shadowReviewFailed`
 * reports it as its own count instead, scoped to the same low-risk population as
 * `shadowReviewed`.
 *
 * **Precedence: a real review is never erased.** The success path applies
 * `shadow-reviewed` and clears `shadow-review-failed` in ONE `gh pr edit --add-label
 * shadow-reviewed --remove-label shadow-review-failed` call, made only after the PR
 * comment or issue actually posts. The failure path — both "analyze failed/cancelled"
 * and "report failed to file after analyze succeeded" — ONLY ever ADDS
 * `shadow-review-failed`; it never removes `shadow-reviewed`. That asymmetry is
 * deliberate: a failed re-run (say, a transient `gh` outage on a PR reviewed cleanly
 * last week) must never erase evidence that the PR WAS reviewed. Counting mirrors this:
 * `classifyShadowReview` computes `reviewedPRs` first (issue OR `shadow-reviewed` label),
 * then computes `failedPRs` as "carries `shadow-review-failed`" MINUS `reviewedPRs` — a
 * PR carrying both labels (or an issue and the failed label, e.g. mid-transition or after
 * a failed re-run of an already-reviewed PR) counts as reviewed, never as failed.
 *
 * Usage:
 *   pnpm exec tsx scripts/review-outcomes.ts [--repo owner/repo] [--switch <ISO>]
 *     [--days <n>] [--followup-days <n>] [--json]
 *
 * Defaults: --repo davekim917/nanoclaw, --switch 2026-09-10T16:43:16Z (`GATE_GO_LIVE_ISO`
 * — PR #605's mergedAt, the exact instant the merge gate went live here, not a rounded
 * midnight), --days 30, --followup-days 14.
 *
 * **Shadow coverage** (separate from the before/after bucket above): the before/after
 * bucket's low-risk population is a REPLAY of `.github/labeler.yml`'s file globs, kept
 * that way so pre-labeler PRs (which carry no `risk:high` label at all) still get
 * classified — see "Low-risk classification" above. But that means its denominator can
 * disagree with what `shadow-review.yml` itself actually selected, which reads CURRENT
 * labels (`risk:high` / `review:requested`), not a glob replay. `computeShadowCoverage`
 * answers a narrower, more literal question — "of the PRs the workflow should be picking
 * up since it went live, how many did it actually review?" — using `report`'s own
 * selection rule (`shadow-review.yml:350-356`): base ref `main` (`baseRefName`,
 * `SHADOW_REVIEW_BASE_REF`) and CURRENT labels excluding `risk:high`/`review:requested`
 * (`isEligibleForShadowReview`), scoped to PRs merged at or after PR #660's merge time
 * (`SHADOW_REVIEW_GO_LIVE_ISO`, when shadow review went live). Its one caveat: label
 * eligibility is judged against a PR's CURRENT labels, which can drift from what
 * they were at merge time (a PR later relabeled `risk:high`, or `review:requested`
 * cleared after the fact) — see `LABEL_DRIFT_CAVEAT`.
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
  labels: string[]; // CURRENT labels, not a merge-time snapshot — see "Shadow coverage" below
  baseRefName: string; // e.g. "main" — shadow-review.yml only selects PRs merged INTO main
  changedLines: number; // additions + deletions, EXCLUDING GENERATED_FILES — the weekly report's kLOC denominator
  changedFiles: number; // GitHub's own file count for this PR — the completeness check `resolveAtMergeContexts` needs
  /**
   * Only ever populated for a PR merged at/after `GATE_GO_LIVE_ISO` (the review-metrics
   * fetch layer never attempts it for an earlier one — see "Pre-gate vs. post-gate"
   * below). `undefined`: not attempted at all (every pre-gate PR; every unit-test fixture
   * that isn't exercising post-gate lane classification). `null`: attempted but the PR's
   * at-merge context could not be reconstructed (a merge shape `resolveAtMergeBaseSha`
   * doesn't recognize, an incomplete file listing, a `.github/labeler.yml` read that
   * failed) — classified `review`, never `skip`, by `classifyAtMergeVerdict`, mirroring
   * codex-review.sh `scope_eval`'s own "any doubt is review" rule.
   */
  atMergeContext?: AtMergeContext | null;
}

/**
 * What the merge gate actually saw for one PR AT THE MOMENT it merged — the file-glob
 * and label half of codex-review.sh `audit`'s own reconstruction (`SCOPE_PIN_BASE`,
 * `GATE_LABELS`; codex-review.sh:663-701,1660-1695), replayed here from the same public
 * facts audit itself reads (the merge commit's first parent, the PR's labeled/unlabeled
 * event history, GitHub's compare API), not from whatever's true today. A `risk:high`
 * glob list grows over time — 22 at go-live to 62 as of this file's last edit — and a
 * label can be added or removed after merge; either drift silently rewrites history if
 * the replay uses CURRENT state instead of AT-MERGE state (see the file header's
 * "Pre-gate vs. post-gate" note for the concrete case, PR #620, this fixes).
 */
export interface AtMergeContext {
  /** The merge commit's diff against its base, filenames ∪ renamed files' PREVIOUS
   *  filenames (codex-review.sh:760) — moving a file OFF a risky path still changes
   *  that path. */
  files: string[];
  /** Labels as of `mergedAt`, replayed from the PR's LabeledEvent/UnlabeledEvent
   *  timeline (`replayLabelsAtMerge`) — never the PR's CURRENT labels. */
  labels: string[];
  /** `risk:high` from `.github/labeler.yml` AT the merge commit's first-parent base —
   *  never the CURRENT `.github/labeler.yml` on `main`'s tip. */
  riskHighGlobs: string[];
}

export interface Options {
  repo: string;
  switchIso: string;
  days: number;
  followupDays: number;
  json: boolean;
  // Weekly-mode-only fields. Optional so the before/after mode's existing Options
  // literals (this file's own tests included) need not name them.
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
  shadowCoverage: ShadowCoverageResult;
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

/**
 * Strips CommonMark fenced code blocks and HTML comments from `body`, mirroring
 * codex-review.sh's `fix_link_state`'s `unfenced` + `gsub("<!--...-->")` EXACTLY
 * (`codex-review.sh:520-545`): a `Fixes-PR:` line inside either is an example or a
 * template being quoted, not a real link, and must not be read as one — the same reason
 * `fix_link_state` strips both before testing `FIXES_PR_LINE_RE` at merge time. Fence
 * rule: up to 3 leading spaces, then 3+ backticks or 3+ tildes opens one; only a BARE
 * run of the same character, at least as long, on its own line closes it; an unclosed
 * fence runs to the end of the body, same as GitHub renders it.
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
    // else: still fenced (or a non-closing candidate line) — dropped, not emitted.
  }
  return out.join('\n').replace(/<!--[\s\S]*?(-->|$)/g, '');
}

export function isFixTitle(title: string): boolean {
  return FIX_TITLE_RE.test(title);
}

// A `Fixes-PR:` line's whole value (everything after the colon, same line) —
// extraction reads the value apart, rather than matching one fixed `#N`/`none` shape,
// so it can tell a real same-repo reference from a cross-repo one and from `none`.
const FIXES_PR_LINE_VALUE_RE = /^[ \t]*Fixes-PR:[ \t]*(.*)$/gim;
// `owner/repo#N` (GitHub's cross-repo shorthand — a different repository's numbering,
// e.g. `nanocoai/nanoclaw#605` is upstream's #605, never this repo's) and any
// parenthetical remark that names "upstream" at all (e.g. `(upstream already covers
// this)`) — both are stripped from a value before its `#N`s are read as OUR PR numbers.
const CROSS_REPO_OR_UPSTREAM_RE = /\([^)]*\bupstream\b[^)]*\)|[\w.-]+\/[\w.-]+#\d+/gi;
const NONE_TOKEN_RE = /\bnone\b/i;

/**
 * Every same-repo PR number a `Fixes-PR:` line names — link(s) only, `none` credits
 * nothing. Handles more than one `Fixes-PR:` line, and more than one `#N` on one line
 * (`Fixes-PR: #605, #620`). Fenced/commented occurrences are never read (see
 * `stripFencedAndCommented`); a cross-repo `owner/repo#N` or an "(upstream ...)"
 * parenthetical is stripped before numbers are read, so neither is credited as this
 * repo's own PR. **`none` anywhere alongside a real number anywhere else — same line or
 * a separate one — credits NOTHING at all**, per the coordinator's "`none` followed by
 * `#2` must credit nothing": an internally contradictory declaration cannot be trusted
 * for either signal, so the whole extraction returns `[]` rather than picking a side.
 */
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

/**
 * The FIRST same-repo PR number a `Fixes-PR:` line names, or `null` if there isn't
 * exactly one to credit — absent, `none`, or a contradictory body (see
 * `extractFixesPrNumbers`). Kept for callers that only ever expect a single reference;
 * `findFollowUp` uses the plural form directly since a fix can name more than one.
 */
export function extractFixesPrNumber(body: string): number | null {
  const numbers = extractFixesPrNumbers(body);
  return numbers.length > 0 ? numbers[0] : null;
}

/**
 * Whether `body` carries a well-formed `Fixes-PR:` line at all — `#<n>` OR the literal
 * `none` — OUTSIDE any fence or HTML comment (see `stripFencedAndCommented`). Distinct
 * from `extractFixesPrNumber`, which returns `null` for BOTH "no line" and "line says
 * none": the weekly report needs to tell those two apart to find when the convention
 * started (`findConventionStartIso`), which a PR merged with `Fixes-PR: none` still
 * counts as evidence of — the trailer existed and was filled in, deliberately, as "not a
 * fix". Unaffected by the none-vs-number contradiction rule above: that rule is about
 * what to CREDIT, not about whether the convention's syntax was used at all.
 */
export function hasFixesPrLine(body: string): boolean {
  return /^[ \t]*Fixes-PR:[ \t]*(?:#\d+|none)\b/im.test(stripFencedAndCommented(body));
}

/**
 * When the `Fixes-PR:` convention started: the `mergedAt` of the earliest-merged PR
 * (by merge time, not fetch order) whose body carries the line at all (link or `none`
 * — see `hasFixesPrLine`). `null` when no PR in `prs` carries it yet. The weekly report
 * flags every week that ends before this instant `heuristicOnly` (see
 * `computeWeeklyReport`): `Fixes-PR:` links are read as ground truth only once the
 * convention was actually in force, per plan.md's Measurement section ("Where a link is
 * missing, file overlap is the fallback").
 */
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

/**
 * `Reverts #N` / `This reverts ... #N`, ANCHORED TO A LINE'S START (`^`, multiline) —
 * not a bare search anywhere in the body. `#653`'s own body is the concrete case this
 * fixes: its prose explains this repo's revert convention by QUOTING #610's title —
 * `` `revert(runner): back out ending a task stream after its result (#608)` `` — and
 * separately says "revert matching including the real #610 shape" and "the one real
 * revert in the window (#610 reverting #608)". The unanchored version matched all three
 * as if #653 itself named a revert target; #653 never reverted anything, and its title
 * isn't revert-shaped either. Every one of those three matches sits mid-sentence (a
 * quoted title inside backticks, a `-`-bulleted list item's prose, an ordinary
 * sentence) — none starts its own line with `revert(s)`, so anchoring excludes all
 * three while keeping every real case this suite already covers: `Reverts #608 because
 * it broke prod.`, `This reverts #608 (merge ...)`, and GitHub's own `This reverts pull
 * request #608.` template — every one of those genuinely opens its line with the word.
 * Gap after the word capped at 60 chars, same line, same as before.
 */
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

/** Whether `candidate` is a revert of `target`, per the title and body rules above. */
export function isRevertOf(candidate: PullRequestData, target: PullRequestData): boolean {
  const titleMatch = REVERT_TITLE_RE.test(candidate.title) && titleNamesTarget(candidate.title, target);
  return titleMatch || bodyNamesNumber(candidate.body, target.number);
}

/** Whether `pr` is a revert of ANYTHING (no target linkage needed) — for the weekly rate. */
export function isRevertPR(pr: PullRequestData): boolean {
  if (REVERT_TITLE_RE.test(pr.title)) return true;
  REVERT_BODY_LINE_RE.lastIndex = 0;
  return REVERT_BODY_LINE_RE.test(pr.body);
}

export interface FollowUpResult {
  kind: 'link' | 'overlap' | 'none';
  prNumber: number | null;
}

/**
 * Whether `body`'s `Fixes-PR:` trailer, if it exists at all, names no specific PR —
 * an explicit `Fixes-PR: none`, or a body `extractFixesPrNumbers` reads as internally
 * contradictory (see that function). Either way, this fix PR itself says (or cannot be
 * trusted to say) it isn't tied to a particular prior PR, so it must not stand in as
 * file-overlap evidence that some OTHER candidate PR was bug-introducing — a preventive
 * or unrelated fix touching the same files is not evidence of anything. A PR that never
 * carries the trailer at all (pre-convention, or simply omitted) is NOT excluded here:
 * absence isn't a declaration either way, so it still falls through to the overlap
 * fallback, same as before this existed.
 */
function declaresFixesPrNone(body: string): boolean {
  return hasFixesPrLine(body) && extractFixesPrNumbers(body).length === 0;
}

/**
 * Follow-up status of `candidate` against `laterPRs` (already filtered to merged after
 * `candidate` and within `followupDays`). Link takes priority; overlap is the fallback
 * ONLY when no PR links to `candidate` — plan.md's Measurement status entry: "same-
 * subsystem follow-ups will be computed from git history instead" once linking is
 * unreliable, i.e. overlap stands in for a missing link, not alongside one. A later PR
 * that declares `Fixes-PR: none` (or an equivalent contradictory body) is skipped
 * entirely in the overlap pass — see `declaresFixesPrNone`.
 */
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

// The workflow's "File findings" step (shadow-review.yml) renders every finding as its
// own bullet starting "- **P1** — " or "- **P2** — ". Anchored to that bullet start
// (multiline `^`), not a bare `\bP1\b`, so a P2 finding whose free-text description
// happens to mention "P1" — e.g. "similar to the P1 in #642" — isn't counted as one.
// Case-insensitive so a casing drift in the rendering doesn't silently undercount.
const P1_LINE_RE = /^- \*\*P1\*\*/im;

/** The PR number a shadow-review issue's title names, or null if the title doesn't match. */
export function extractShadowReviewPrNumber(title: string): number | null {
  const match = SHADOW_REVIEW_TITLE_RE.exec(title);
  return match ? Number(match[1]) : null;
}

/** Whether a shadow-review issue body names at least one P1 (destructive/fail-open) finding. */
export function issueHasP1(body: string): boolean {
  return P1_LINE_RE.test(body);
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

export interface ShadowReviewClassification {
  reviewedPRs: number[];
  p1PRs: number[];
  failedPRs: number[];
}

/**
 * Classifies `prNumbers` into reviewed / P1 / failed, applying the precedence rule from
 * the file header: a real review is never erased by a stale (or concurrent) failure
 * label. Reviewed is computed first (issue OR `shadow-reviewed` label); failed is then
 * "carries `shadow-review-failed`" MINUS reviewed, so a PR holding both never double-
 * counts as failed. Shared by `buildBucket` (file-based low-risk population) and
 * `computeShadowCoverage` (label-based eligible population) so the precedence rule can't
 * drift between the two.
 */
export function classifyShadowReview(
  prNumbers: number[],
  shadowReviewIndex: Map<number, { hasP1: boolean }>,
  reviewedLabelPrNumbers: ReadonlySet<number>,
  failedLabelPrNumbers: ReadonlySet<number>,
): ShadowReviewClassification {
  const reviewedPRs = prNumbers.filter((n) => shadowReviewIndex.has(n) || reviewedLabelPrNumbers.has(n));
  const reviewedSet = new Set(reviewedPRs);
  // P1 is issue-derived only: shadowReviewIndex.get(n) is undefined for a label-only PR
  // (no issue), and `?.hasP1 === true` reads that as false, which is correct — the label
  // alone carries no severity information.
  const p1PRs = reviewedPRs.filter((n) => shadowReviewIndex.get(n)?.hasP1 === true);
  const failedPRs = prNumbers.filter((n) => failedLabelPrNumbers.has(n) && !reviewedSet.has(n));
  return { reviewedPRs, p1PRs, failedPRs };
}

const RISK_HIGH_LABEL = 'risk:high';
const REVIEW_REQUESTED_LABEL = 'review:requested';

/**
 * Mirrors the LABEL half of `shadow-review.yml`'s own selection rule (`report`'s
 * job-level `if:`, shadow-review.yml:350-356): eligible for shadow review when CURRENT
 * labels include neither `risk:high` nor `review:requested`. The base-ref half of that
 * same `if:` (`github.event.pull_request.base.ref == 'main'`) is checked separately in
 * `computeShadowCoverage` via `baseRefName`, since it isn't a label. Used by
 * `computeShadowCoverage` (the before/after bucket keeps the file-based glob replay, see
 * file header) and by `isSkipVerdict` below, which composes it with `isLowRisk` to
 * replay the merge gate's OWN skip-verdict rule.
 */
export function isEligibleForShadowReview(labels: string[]): boolean {
  return !labels.includes(RISK_HIGH_LABEL) && !labels.includes(REVIEW_REQUESTED_LABEL);
}

/**
 * Composes `isLowRisk` (the file-glob half of `codex-review.sh`'s `scope_eval`
 * skip-verdict rule, `codex-review.sh:750`,`:765-767`) with `isEligibleForShadowReview`
 * (the identical label check `shadow-review.yml`'s own selection rule uses) against
 * `riskHighGlobs`/`pr.labels` AS GIVEN — CURRENT state, whatever the caller passes.
 *
 * **This is NOT a historical replay and must never be read as one.** `riskHighGlobs`
 * grows over time (22 at go-live, 62 as of this file's last edit) and `pr.labels` is a
 * PR's CURRENT labels, which can drift from what they were at its merge (see
 * `computeShadowCoverage`'s own `LABEL_DRIFT_CAVEAT`). Calling this with CURRENT globs
 * against an OLD PR silently answers "would this merge on skip TODAY", not "did it merge
 * on skip AT ITS OWN MERGE" — the exact bug PR #620 exposed (skipped correctly under the
 * 22 globs live at its merge; flips to "reviewed" under the 62 live now, and #620 is
 * itself a linked bug-introducer, so the flip hides a real miss). The weekly report's
 * post-gate reviewed/skipped lane split uses `classifyAtMergeVerdict` below instead,
 * which replays `.github/labeler.yml` and labels AS THEY STOOD at each PR's own merge.
 * This function stays exported for ad-hoc "under today's rules" questions, where CURRENT
 * state is exactly what's wanted.
 */
export function isSkipVerdict(pr: PullRequestData, riskHighGlobs: string[]): boolean {
  return isLowRisk(pr.files, riskHighGlobs) && isEligibleForShadowReview(pr.labels);
}

/**
 * Classifies a PR's post-gate lane from its `AtMergeContext` — `null`/`undefined`
 * (context unresolved, or never attempted) fails closed to `'review'`, mirroring
 * `codex-review.sh scope_eval`'s own philosophy that any doubt about the files or labels
 * a verdict would be based on is `review`, never `skip` (see that function's own comment,
 * "Anything that keeps the files from being judged is `review` as well").
 */
export function classifyAtMergeVerdict(ctx: AtMergeContext | null | undefined): 'skip' | 'review' {
  if (ctx == null) return 'review';
  return isLowRisk(ctx.files, ctx.riskHighGlobs) && isEligibleForShadowReview(ctx.labels) ? 'skip' : 'review';
}

/** `shadow-review.yml`'s `report` job only ever runs against PRs merged into this branch. */
const SHADOW_REVIEW_BASE_REF = 'main';

/**
 * When the risk-scoped merge gate went live: PR #605's `mergedAt`
 * (`gh pr view 605 --json mergedAt` against davekim917/nanoclaw —
 * `container/skills/pr-review-loop/scripts/codex-review.sh`'s `merge-check`/`scope_eval`
 * started gating merges at this instant). Every PR merged before it was auto-reviewed —
 * there was no skip verdict to have merged on — so the weekly report classifies it by a
 * plain low-risk/high-risk file class (`isLowRisk` against the CURRENT glob list, same as
 * the before/after bucket already does), never as "reviewed" or "skipped". A PR merged at
 * or after this instant gets the real post-gate verdict, replayed via
 * `classifyAtMergeVerdict`/`AtMergeContext`.
 */
export const GATE_GO_LIVE_ISO = '2026-09-10T16:43:16Z';

/**
 * When the `Fixes-PR:` convention started: PR #642's `mergedAt` (verified via
 * `gh pr view 642 --json mergedAt`; #642 introduced the gate-integrity change that
 * requires the trailer on `fix`-titled PRs — plan.md, Tier 1 status). Pinned as a
 * constant, NOT recomputed via `findConventionStartIso` over each run's own fetch
 * window: a window that doesn't reach back far enough would compute a LATER date than
 * the truth, silently misclassifying weeks that are actually link-complete as
 * `heuristicOnly`/partial. `findConventionStartIso` stays exported for verifying this
 * constant against a fresh, wide fetch — not for the weekly report to call itself.
 */
export const FIXES_PR_CONVENTION_START_ISO = '2026-09-11T12:44:10Z';

// ─────────────────────────── at-merge replay (pure) ────────────────────────
//
// The pure half of reconstructing a PR's `AtMergeContext` — codex-review.sh `audit`'s
// own two mechanisms (`codex-review.sh:663-701` for the base, `:1660-1695` for labels),
// factored so each is independently testable without a real merge commit or GraphQL
// response. The I/O half (fetching the merge commit's shape, its label-event timeline,
// the compare listing, and `.github/labeler.yml` AT that base) lives in the "gh I/O"
// section below, in `resolveAtMergeContexts`.

/** One `LabeledEvent`/`UnlabeledEvent` from a PR's timeline, as `audit` itself reads it. */
export interface RawLabelEvent {
  type: 'labeled' | 'unlabeled';
  name: string;
  createdAt: string; // ISO-8601 UTC
}

/**
 * Replays a PR's label history up to (and including) `mergedAtIso`, mirroring
 * `codex-review.sh`'s `audit` case's own `reduce` over `labelEvents` sorted by
 * `createdAt` (`codex-review.sh:1688-1691`): a `LabeledEvent` adds the name, an
 * `UnlabeledEvent` removes it, applied strictly in time order, and anything after the
 * merge is not read at all — labels the PR grew or lost afterward say nothing about
 * what the gate saw when it merged.
 */
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

/** The shape of one PR's merge commit, as `audit` reads it to decide how (and whether)
 *  it can name the commit the PR merged onto. */
export interface MergeCommitShape {
  headRefOid: string;
  mergeCommitOid: string | null;
  parentOids: string[];
}

/**
 * The commit a PR's merge commit merged ONTO, or `null` when that cannot be determined
 * reliably — mirrors `audit`'s own `shape.method` classification (`codex-review.sh
 * :1657-1661`), simplified for measurement rather than enforcement: a 2-parent merge
 * commit whose second parent IS the PR's head names its first parent as the base (a
 * normal "Create a merge commit" merge); a 1-parent commit names that parent (a squash).
 * Anything else — 0 or 3+ parents, or a 2-parent commit whose second parent ISN'T this
 * PR's head (an octopus merge, or a base resolved for the wrong head) — is NOT trusted:
 * `null`, so the caller fails closed to `review` rather than guess. Unlike `audit`, this
 * does not require the commit be GitHub-signed: that check exists to prove GitHub (not
 * a human with push access) made the commit, which matters for a merge GATE's authority
 * but not for reading which commit history a diff should be measured against.
 */
export function resolveAtMergeBaseSha(shape: MergeCommitShape): string | null {
  if (shape.mergeCommitOid === null) return null;
  if (shape.parentOids.length === 2 && shape.parentOids[1] === shape.headRefOid) return shape.parentOids[0];
  if (shape.parentOids.length === 1) return shape.parentOids[0];
  return null;
}

/**
 * When shadow review went live: PR #660's merge time (`gh pr view 660 --json mergedAt`
 * against davekim917/nanoclaw). PRs merged before this were never candidates for shadow
 * review at all, so `computeShadowCoverage` excludes them from its denominator.
 */
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

/**
 * Shadow coverage since go-live — see the file header's "Shadow coverage" section for
 * why this is a separate denominator from the before/after bucket above. `allPRs` should
 * already include every PR merged at or after `sinceIso` (the caller's fetch window);
 * PRs merged earlier are filtered out here regardless.
 */
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

  // Reviewed = has a shadow-review issue OR carries the shadow-reviewed label — see the
  // file header for why the label is needed (a clean review leaves no issue) and why the
  // OR (a PR reviewed before the label shipped has only an issue). Failed excludes
  // reviewed — see the file header's "Precedence" note: a real review is never erased.
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

// ─────────────────────────── weekly mode ───────────────────────────────────
//
// `--weekly` is a different SHAPE over the same population and the same classification
// functions above — one row per ISO week of PRs merged into `main`, not a single
// before/after split. It answers the tracking-issue question directly: for THIS week,
// how many PRs merged reviewed vs skipped, how many reverted, and how many drew a
// follow-up fix, at both the PR-count grain and per 1,000 changed lines. These are this
// file's OWN definitions — Augment's Cosmos post names neither its output unit nor its
// matching method, so a number here is not directly comparable to Cosmos's, only to an
// earlier run of this same query.
//
// **Pre-gate vs. post-gate.** `GATE_GO_LIVE_ISO` (PR #605) is when the skip verdict
// itself started existing. A PR merged before it was auto-reviewed unconditionally —
// there was no gate to have merged on skip — so counting it as "reviewed" or "skipped"
// answers a question that didn't apply yet. Such a PR gets a purely DESCRIPTIVE
// low-risk/high-risk file class instead (`isLowRisk` against the CURRENT glob list,
// same as the before/after bucket already does), reported under `preGate*` fields, never
// folded into `reviewed`/`skipped`. A PR merged at or after go-live gets the real verdict,
// replayed AT ITS OWN MERGE via `classifyAtMergeVerdict`/`AtMergeContext` — never a
// CURRENT-state replay: the `risk:high` glob list has grown from 22 at go-live to 62 as
// of this file's last edit, and PR #620 is the concrete case that growth mis-scores under
// a naive CURRENT-state replay (skipped correctly under the 22 globs live at its merge;
// flips to "reviewed" under the 62 live now — and #620 is itself a linked
// bug-introducer, so the flip would have hidden a real miss instead of exposing it). A
// week whose PRs straddle go-live (`isMixedGateWeek`) reports BOTH the pre-gate
// descriptive counts and the post-gate verdict counts, clearly separated, so the table
// can't be misread as one uniform "reviewed vs skipped" split.
//
// **Bug-introducing, ground truth.** A PR counts as bug-introducing (the `linked`
// count — the only one this file treats as ground truth, never the overlap heuristic)
// when EITHER a later PR names it via `Fixes-PR:` OR a later PR reverts it
// (`findRevert`), both within `followupDays` — a revert is exactly as strong evidence
// that a PR introduced a bug as a linked fix is, and #608 (reverted by #610, never
// itself `Fixes-PR:`-linked) would otherwise silently not count as one.

/** One lane's (overall / reviewed / skipped) follow-up counts for one week. `linked` is
 *  the GROUND-TRUTH count — a `Fixes-PR:` link OR a revert found within the window (see
 *  the section header above); `overlapHeuristic` is the file-overlap fallback, an upper
 *  bound never folded into `linked`. */
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
  /** True when this week's PRs straddle `GATE_GO_LIVE_ISO` — some pre-gate, some
   *  post-gate. Render this prominently: it is the reason `reviewed + skipped` can be
   *  LESS than `merged` for this row (`preGateMerged` accounts for the rest). */
  isMixedGateWeek: boolean;
  /** Merged before `GATE_GO_LIVE_ISO` — descriptive only, see the section header. */
  preGateMerged: number;
  preGateLowRisk: number;
  preGateHighRisk: number;
  /** Merged at/after `GATE_GO_LIVE_ISO` — `reviewed + skipped + postGateUnresolved`. */
  postGateMerged: number;
  /** Post-gate PRs whose at-merge replay verdict is `review`. Rate is over
   *  `postGateMerged`, NOT `merged` — a mixed week's pre-gate PRs never had a verdict to
   *  be counted against. */
  reviewed: number;
  reviewedRate: number;
  /** Post-gate PRs whose at-merge replay verdict is `skip`. */
  skipped: number;
  skippedRate: number;
  /** Post-gate PRs whose `AtMergeContext` could not be resolved at all — counted in
   *  neither `reviewed` nor `skipped` (fail-closed to "unknown", not silently folded
   *  into either bucket). Expected to be 0 in ordinary operation; see
   *  `resolveAtMergeContexts`'s own comment for what can produce one. */
  postGateUnresolved: number;
  /** PRs merged THIS WEEK that are themselves reverts (`isRevertPR`) — the numerator of
   *  the WEEKLY revert rate. A different thing from a low-risk PR LATER reverted, which
   *  the cumulative before/after bucket (`BucketResult.reverted`) reports instead —
   *  `renderWeeklyMarkdown` labels both explicitly so the two never sit side by side
   *  looking like the same number. */
  reverted: number;
  revertRate: number;
  /** additions+deletions summed over the week, EXCLUDING `GENERATED_FILES` (see
   *  `generatedFileChangedLines`) — the kLOC denominator below. */
  changedLines: number;
  overall: WeeklyLaneStats; // over ALL PRs this week, pre- and post-gate alike
  reviewedLane: WeeklyLaneStats; // over POST-GATE reviewed PRs only
  skippedLane: WeeklyLaneStats; // over POST-GATE skipped PRs only
  /** Overall linked (ground-truth) bug-introducing count per 1,000 non-generated changed
   *  lines. 0 when `changedLines` is 0 — an all-deletion or metadata-only week, not a
   *  divide-by-zero. */
  linkedPerKLoc: number;
  /** `--followup-days` have not yet passed since `weekEndIso` — this week's follow-up
   *  counts can still change and are not a final read. */
  immature: boolean;
  /** `weekStartIso >= FIXES_PR_CONVENTION_START_ISO` — every PR in this week merged
   *  after the `Fixes-PR:` convention started, so its `linked` count is a real read, not
   *  an artifact of the convention not existing yet. `false` means "partial": some (see
   *  `preConventionMerged`) or all of this week's PRs predate the convention, and their
   *  `linked` contribution reads as an undercount, not a true zero — only the overlap
   *  heuristic (an upper bound, never ground truth) says anything about THOSE PRs. */
  linkComplete: boolean;
  /** PRs in this week merged before `FIXES_PR_CONVENTION_START_ISO` — 0 whenever
   *  `linkComplete` is true. */
  preConventionMerged: number;
}

export interface WeeklyReport {
  rows: WeeklyReviewRow[];
  conventionStartIso: string; // always FIXES_PR_CONVENTION_START_ISO — pinned, not recomputed (see that constant)
}

/**
 * Inverse of `isoWeekKey`: the UTC instant range `[startIso, endIso]` (inclusive) an
 * ISO week key covers. Mirrors that function's own week-1-anchor math exactly (Jan 4
 * always falls in week 1; the anchor is Jan 4 shifted back to the start of its own ISO
 * week), so `isoWeekKey(isoWeekDateRange(k).startIso) === k` for every `k` it produces.
 */
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

/** `lanePRs`' follow-up counts against `sortedAll` (every fetched PR, ascending), within
 *  `followupDays` of each candidate's own merge — same window rule `buildBucket` uses.
 *  `linked` counts a `Fixes-PR:` link OR a revert found in that same window as ground
 *  truth (see the section header's "Bug-introducing, ground truth"); a candidate never
 *  double-counts even when both apply. */
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

  const preGatePRs = weekPRs.filter((pr) => new Date(pr.mergedAt).getTime() < goLiveMs);
  const postGatePRs = weekPRs.filter((pr) => new Date(pr.mergedAt).getTime() >= goLiveMs);
  // `classifyAtMergeVerdict` itself fails closed to `'review'` for a nullish context —
  // correct for a caller that only wants one bit ("would this have gated?"), but WRONG
  // here on its own: it would silently fold every unresolved PR into `reviewed`,
  // contradicting `postGateUnresolved`'s own contract ("neither reviewed nor skipped").
  // So resolution is checked FIRST, before the verdict is even asked for.
  const isResolved = (pr: PullRequestData): boolean => pr.atMergeContext != null;
  const reviewedPRs = postGatePRs.filter(
    (pr) => isResolved(pr) && classifyAtMergeVerdict(pr.atMergeContext) === 'review',
  );
  const skippedPRs = postGatePRs.filter((pr) => isResolved(pr) && classifyAtMergeVerdict(pr.atMergeContext) === 'skip');
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

/**
 * One row per ISO week of PRs merged into `main`, ascending. `allPRs` need not be
 * pre-filtered to `main` — filtered here, same as `computeShadowCoverage` filters by
 * `baseRefName` for its own reason. `nowIso` defaults to the real current time; tests
 * pin it explicitly so the `immature` flag is deterministic. Post-gate lane
 * classification reads each PR's OWN `atMergeContext` (set by `resolveAtMergeContexts`,
 * or left `undefined` for a pre-gate PR / a fixture that isn't exercising it) — this
 * function does no I/O and assumes that resolution already happened.
 */
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

/**
 * The tracking-issue comment body: the most recent `weeksToShow` weeks (default 8, per
 * the weekly workflow's own spec), then the cumulative before/after-switch comparison
 * `computeReport` already produces — one document, one `gh issue comment` post.
 */
export function renderWeeklyMarkdown(weekly: WeeklyReport, cumulative: ReportResult, weeksToShow = 8): string {
  const lines: string[] = [];
  lines.push('## Review metrics (weekly)');
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

/**
 * Sum of `additions`+`deletions` across files this suite already treats as generated
 * noise (`GENERATED_FILES`) — excluded from the weekly report's kLOC denominator for the
 * same reason the file header already excludes them from file-overlap matching:
 * `src/upstream-ratchet.json` alone produced 32 of 93 overlap matches in an early run,
 * because every upstream-owned edit regenerates it, and a huge auto-regenerated diff
 * would dilute a per-output-unit rate the same way.
 */
export function generatedFileChangedLines(entries: readonly ResolvedFileEntry[]): number {
  return entries.filter((e) => GENERATED_FILES.has(e.path)).reduce((sum, e) => sum + e.additions + e.deletions, 0);
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
    'number,title,body,mergedAt,changedFiles,files,labels,baseRefName,additions,deletions',
    '--limit',
    '1000',
  ]);
  const prs = JSON.parse(raw) as RawPr[];
  return prs.map((pr) => {
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
    };
  });
}

// ─────────────────────────── at-merge replay (I/O) ─────────────────────────
//
// Resolves `AtMergeContext` for every PR merged at/after `GATE_GO_LIVE_ISO` — the I/O
// half of the pure functions above. Deliberately scoped to POST-GATE PRs only: a
// pre-gate PR was never subject to any skip verdict at all (see the file header and
// `GATE_GO_LIVE_ISO`'s own doc comment), so spending a GraphQL + two REST calls per PR
// on history that predates the gate would only cost budget for a number nobody reads.
//
// Cost note (a known, deliberately deferred scaling concern, not fixed here): this
// population only grows — every week that passes adds its PRs to "post-gate" and none
// ever leave. At this file's last measurement (2026-09-12, ~68 post-gate PRs since
// go-live two days earlier) a full run took well under a minute. Once `--weekly-days`'
// window is mostly post-gate PRs (a few weeks from now, at this repo's throughput),
// this may need a persistent cache keyed by PR number — an at-merge fact is immutable
// once computed, so the RIGHT fix is caching the RESULT, not narrowing the window. Re-
// raise if a real run starts approaching the 2-minute Actions budget the workflow's own
// header cites.

interface RawAtMergeLabelEventNode {
  __typename: 'LabeledEvent' | 'UnlabeledEvent';
  createdAt: string;
  label: { name: string } | null;
}

interface RawAtMergePrNode {
  headRefOid: string;
  mergeCommit: { oid: string; parents: { totalCount: number; nodes: { oid: string }[] } } | null;
  labelEvents: { pageInfo: { hasNextPage: boolean }; nodes: RawAtMergeLabelEventNode[] };
}

const AT_MERGE_GRAPHQL_BATCH_SIZE = 15;

/**
 * One batched GraphQL call per `AT_MERGE_GRAPHQL_BATCH_SIZE` PR numbers — every PR
 * aliased (`pr0`, `pr1`, ...) in a single query, rather than one call per PR, to keep
 * this bounded as the post-gate population grows. PR numbers are our own already-
 * fetched integers (never PR-authored text), so inlining them directly into the query
 * string, instead of threading N `-F` variables through aliases, is safe here.
 */
function fetchAtMergeGitContextBatch(repo: string, prNumbers: readonly number[]): Map<number, RawAtMergePrNode> {
  const [owner, name] = repo.split('/');
  const fields = prNumbers
    .map(
      (n, i) => `pr${i}: pullRequest(number: ${n}) {
        headRefOid
        mergeCommit { oid parents(first: 3) { totalCount nodes { oid } } }
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
  const raw = gh(['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`]);
  const parsed = JSON.parse(raw) as { data: { repository: Record<string, RawAtMergePrNode | null> } };
  const result = new Map<number, RawAtMergePrNode>();
  prNumbers.forEach((n, i) => {
    const node = parsed.data.repository[`pr${i}`];
    if (node) result.set(n, node);
  });
  return result;
}

interface RawCompareFile {
  filename?: string;
  previous_filename?: string;
}

/**
 * The merge commit's diff against `baseSha`, mirroring `codex-review.sh scope_eval`'s
 * own completeness rule EXACTLY (`codex-review.sh:756-760`): a comparison lists at most
 * 300 files, and if the listed count doesn't match GitHub's own `changedFiles` for this
 * PR, the listing is incomplete — either way, `null` (fail closed), never a partial
 * list read as the whole truth. Includes each rename's `previous_filename` alongside
 * its new name, same as `scope_eval`: moving a file OFF a risky path still changes that
 * path.
 */
function fetchFilesAtMerge(
  repo: string,
  baseSha: string,
  mergeCommitOid: string,
  changedFiles: number,
): string[] | null {
  let raw: string;
  try {
    raw = gh(['api', `repos/${repo}/compare/${baseSha}...${mergeCommitOid}?per_page=1`]);
    // Deliberately fail closed to `null` (unresolvable at-merge context) on ANY `gh api`
    // failure — a network error, a 404 for a commit GitHub has since garbage-collected,
    // anything — same "any doubt is review, never skip" rule `scope_eval` itself applies.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return null;
  }
  let parsed: { files?: RawCompareFile[] };
  try {
    parsed = JSON.parse(raw) as { files?: RawCompareFile[] };
    // Same fail-closed reasoning: unparseable JSON from `gh` is not a listing to trust.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return null;
  }
  const files = parsed.files;
  if (!Array.isArray(files)) return null;
  const names = new Set<string>();
  for (const f of files) {
    if (typeof f.filename !== 'string') return null;
    names.add(f.filename);
    if (typeof f.previous_filename === 'string') names.add(f.previous_filename);
  }
  const listedCount = new Set(files.map((f) => f.filename)).size;
  if (listedCount >= 300) return null; // GitHub's per-comparison cap — some files may be missing
  if (listedCount !== changedFiles) return null; // count mismatch — incomplete or wrong listing
  return [...names];
}

const riskHighGlobsAtShaCache = new Map<string, string[] | null>();

/**
 * `risk:high` from `.github/labeler.yml` AT commit `sha` — never the current tip.
 * Memoized per sha: consecutive PRs' at-merge bases are usually distinct commits (each
 * merge advances `main`'s first-parent chain by one), so this rarely re-hits, but costs
 * nothing when it does. `null` — fail closed — when the file didn't exist at that
 * commit yet (a PR merged before `.github/labeler.yml` itself landed) or couldn't be
 * read or parsed.
 */
function fetchRiskHighGlobsAtSha(repo: string, sha: string): string[] | null {
  const cached = riskHighGlobsAtShaCache.get(sha);
  if (cached !== undefined) return cached;
  let globs: string[] | null;
  try {
    const raw = gh([
      'api',
      `repos/${repo}/contents/.github/labeler.yml?ref=${sha}`,
      '-H',
      'Accept: application/vnd.github.raw',
    ]);
    globs = globsForRiskHigh(parse(raw) as Record<string, unknown>);
    // Fail closed to `null` whether the file didn't exist yet at this commit (a 404 — a
    // PR merged before `.github/labeler.yml` itself landed), the YAML failed to parse,
    // or `globsForRiskHigh` rejected its shape: none of those is a `risk:high` list this
    // replay can trust.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    globs = null;
  }
  riskHighGlobsAtShaCache.set(sha, globs);
  return globs;
}

/**
 * Resolves `AtMergeContext` (or `null`, fail-closed) for every PR in `prs` merged at or
 * after `GATE_GO_LIVE_ISO`; a PR merged before it is left absent from the returned map
 * entirely (never attempted — see the section header above). `prs` needs only the three
 * fields the resolution actually reads, so a caller can pass raw fetch data straight
 * through without building full `PullRequestData` first.
 */
export function resolveAtMergeContexts(
  repo: string,
  prs: readonly { number: number; mergedAt: string; changedFiles: number }[],
): Map<number, AtMergeContext | null> {
  const result = new Map<number, AtMergeContext | null>();
  const goLiveMs = new Date(GATE_GO_LIVE_ISO).getTime();
  const postGate = prs.filter((pr) => new Date(pr.mergedAt).getTime() >= goLiveMs);
  for (let i = 0; i < postGate.length; i += AT_MERGE_GRAPHQL_BATCH_SIZE) {
    const batch = postGate.slice(i, i + AT_MERGE_GRAPHQL_BATCH_SIZE);
    const gitContexts = fetchAtMergeGitContextBatch(
      repo,
      batch.map((pr) => pr.number),
    );
    for (const pr of batch) {
      const node = gitContexts.get(pr.number);
      if (!node || !node.mergeCommit || node.labelEvents.pageInfo.hasNextPage) {
        result.set(pr.number, null);
        continue;
      }
      const shape: MergeCommitShape = {
        headRefOid: node.headRefOid,
        mergeCommitOid: node.mergeCommit.oid,
        parentOids: node.mergeCommit.parents.nodes.map((p) => p.oid),
      };
      const baseSha = resolveAtMergeBaseSha(shape);
      if (baseSha === null) {
        result.set(pr.number, null);
        continue;
      }
      const files = fetchFilesAtMerge(repo, baseSha, node.mergeCommit.oid, pr.changedFiles);
      const riskHighGlobs = files === null ? null : fetchRiskHighGlobsAtSha(repo, baseSha);
      if (files === null || riskHighGlobs === null) {
        result.set(pr.number, null);
        continue;
      }
      const events: RawLabelEvent[] = node.labelEvents.nodes
        .filter((n): n is RawAtMergeLabelEventNode & { label: { name: string } } => n.label !== null)
        .map((n) => ({
          type: n.__typename === 'LabeledEvent' ? 'labeled' : 'unlabeled',
          name: n.label.name,
          createdAt: n.createdAt,
        }));
      const labels = replayLabelsAtMerge(events, pr.mergedAt);
      result.set(pr.number, { files, labels, riskHighGlobs });
    }
  }
  return result;
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

/**
 * PR numbers currently carrying `shadow-review-failed` — `analyze` errored before
 * producing a result, so no shadow-review issue exists for these even though they were
 * selected for review (see the file header, "Shadow-review FAILURE counting").
 */
export function fetchShadowReviewFailedPRs(repo: string): number[] {
  return fetchPRsByLabel(repo, 'shadow-review-failed');
}

/**
 * PR numbers currently carrying `shadow-reviewed` — applied by `report`'s success path
 * whether the review was clean or found something, so a clean review (no issue) still
 * counts as coverage (see the file header, "Shadow-review counting").
 */
export function fetchShadowReviewedPRs(repo: string): number[] {
  return fetchPRsByLabel(repo, 'shadow-reviewed');
}

// ─────────────────────────── CLI ───────────────────────────────────────────

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    repo: 'davekim917/nanoclaw',
    // The gate's actual go-live instant (GATE_GO_LIVE_ISO, PR #605's mergedAt) — not a
    // rounded midnight. Before this correction the default read 2026-09-10T00:00:00Z,
    // over 16 hours earlier than the real switch, which misclassified every PR merged
    // in that gap as "after" when the gate hadn't gone live yet.
    switchIso: GATE_GO_LIVE_ISO,
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
    else if (name === '--weekly') options.weekly = true;
    else if (name === '--weekly-days') options.weeklyDays = Number(inline ?? next());
    else if (name === '--help' || name === '-h') usage();
    else if (arg !== '--') fail(`unknown argument: ${arg}`);
  }
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

/**
 * The `merged:>=X` lower bound `fetchMergedPRs` fetches from — the EARLIER of
 * `switch - days` (what the before/after bucket needs) and `goLiveIso` (what
 * `computeShadowCoverage` needs). `switch - days` alone isn't enough: a run like
 * `--switch 2026-10-01 --days 7` would fetch nothing earlier than 2026-09-24, silently
 * dropping every PR merged between go-live (2026-09-11) and then from `allPRs` — and
 * `computeShadowCoverage`'s own denominator would undercount without any error, since it
 * only ever sees what `allPRs` contains. Compared as timestamps, not ISO strings: a bare
 * `SHADOW_REVIEW_GO_LIVE_ISO` (no milliseconds) and a `.toISOString()` result (always
 * `.sssZ`) don't sort the same lexically as they do chronologically (`.` sorts before
 * `Z`), so a string comparison here would silently pick the wrong bound.
 */
export function computeFetchSinceIso(
  switchIso: string,
  days: number,
  goLiveIso: string = SHADOW_REVIEW_GO_LIVE_ISO,
): string {
  const switchBasedMs = new Date(switchIso).getTime() - days * MS_PER_DAY;
  const goLiveMs = new Date(goLiveIso).getTime();
  return new Date(Math.min(switchBasedMs, goLiveMs)).toISOString();
}

/** The lower fetch bound `--weekly` needs on its own: `weeklyDays` back from `nowIso`. */
export function computeWeeklyFetchSinceIso(nowIso: string, weeklyDays: number): string {
  return new Date(new Date(nowIso).getTime() - weeklyDays * MS_PER_DAY).toISOString();
}

function printWeeklyReport(weekly: WeeklyReport): void {
  console.log(
    `review-outcomes --weekly: gate go-live = ${GATE_GO_LIVE_ISO}, Fixes-PR convention start = ${weekly.conventionStartIso}`,
  );
  console.log("(these are this file's own definitions — not directly comparable to Augment Cosmos's figures)");
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

  const beforeAfterSinceIso = computeFetchSinceIso(options.switchIso, options.days);

  if (options.weekly) {
    // One `gh` fetch batch serves both reports: the weekly rows need `--weekly-days`
    // of history back from now, and the cumulative before/after comparison
    // (`renderWeeklyMarkdown`'s second table) needs the same window `computeReport`
    // always has — so the fetch bound is the EARLIER of the two, same reasoning as
    // `computeFetchSinceIso` already applies to its own two callers.
    const weeklySinceIso = computeWeeklyFetchSinceIso(new Date().toISOString(), options.weeklyDays ?? 90);
    const sinceIso =
      new Date(weeklySinceIso).getTime() < new Date(beforeAfterSinceIso).getTime()
        ? weeklySinceIso
        : beforeAfterSinceIso;
    const fetchedPRs = fetchMergedPRs(options.repo, sinceIso);
    const shadowReviewIssues = fetchShadowReviewIssues(options.repo);
    const shadowReviewFailedPrNumbers = fetchShadowReviewFailedPRs(options.repo);
    const shadowReviewedLabelPrNumbers = fetchShadowReviewedPRs(options.repo);

    // Post-gate lane classification needs each PR's OWN at-merge context (never
    // current-state data — see the "weekly mode" section header's "Pre-gate vs.
    // post-gate" note). Resolved once here, attached onto each PR object, so
    // `computeWeeklyReport` itself stays a pure function over `PullRequestData[]`.
    const atMergeContexts = resolveAtMergeContexts(options.repo, fetchedPRs);
    const allPRs = fetchedPRs.map((pr) => ({ ...pr, atMergeContext: atMergeContexts.get(pr.number) ?? undefined }));

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
            weekly,
            cumulative,
            markdown: renderWeeklyMarkdown(weekly, cumulative),
          },
          null,
          2,
        ),
      );
    } else {
      printWeeklyReport(weekly);
      console.log('');
      printReport(cumulative);
    }
    return;
  }

  const allPRs = fetchMergedPRs(options.repo, beforeAfterSinceIso);
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

// ESM-safe "is this the entrypoint" check (mirrors scripts/upstream-ratchet-report.ts's
// `main()` being called unconditionally at module scope — this one guards it instead so
// `computeReport` etc. can be imported from the test file without side effects).
if (process.argv[1] && new URL(process.argv[1], 'file:').href === import.meta.url) {
  main();
}
