import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

allowSubprocess(['git']);
enforceHermeticity();

/**
 * docs/review-notes.md is the review loop's memory: one line per lesson, which
 * the author and the reviewer read before writing or reviewing code
 * (docs/review-policy.md, "Review notes and fix links"). This test holds these
 * rules on it:
 *
 *  1. every line under `## Lessons` is `- YYYY-MM-DD · PR · class · lesson ·
 *     structural fix`, five fields split on ` · `, dated no later than today (UTC);
 *  2. its class is one `## Classes` registers;
 *  3. its structural fix is exactly `none`, or cites something a reader can
 *     open: a backtick path, a `file:line`, a `#<n>`, or a commit sha;
 *  4. the same mistake twice becomes a check: a class on two or more lines
 *     whose NEWEST line's structural fix is `none` fails. It fails the PR that
 *     records the second occurrence, which is exactly where the structural
 *     fix — a lint rule, a test, a primitive — belongs.
 *
 * Newest is the latest date, and among lines of one date the later line in the
 * file: the file is appended in order.
 */

const NOTES_PATH = path.join(__dirname, '..', 'docs', 'review-notes.md');
const REPO_ROOT = path.join(__dirname, '..');
const SEPARATOR = ' · ';
const PR_FIELD = /^(#\d+(\/#\d+)*|rule)$/;
const CLASS_ENTRY = /^- `([^`]+)` — \S/;
// What a structural fix may cite: a backtick span holding a path (a `/` or a
// `.`), a file:line, a PR or issue number, or a commit sha (7-40 hex digits,
// at least one of them a digit, so a hex-letter word never passes as one).
const CITATIONS = [/`[^`]*[./][^`]*`/, /[\w./-]+\.\w+:\d+/, /#\d+/, /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/];

// #707 P3-d: CITATIONS only checks shape, so a citation can be well-formed and
// still be wrong — a renamed file, a typo, a line moved past the file's end.
// When a repo root is given, these two check it names something real, against
// git rather than the filesystem (#713): a gitignored path must fail exactly
// as it would in a fresh CI checkout, which never has it either.
//   - a whitespace-free backtick span with a `.` or `/` and no `:line` tail
//     must be an existing path (a file or a directory), unless it starts with
//     `~` — a host path outside the repo, left format-only like `#<n>` and a
//     commit sha, since there is nothing here to check it against;
//   - a `path.ext:N` (or `path.ext:N-M`) span, backtick-quoted or bare, must
//     name an existing file with at least N lines — and at least M, for a
//     range, not just N (#713: only N was checked before).
// `#<n>` and a commit sha are left format-only: neither can be checked
// offline — there is no local issue/PR list, and a sha may predate this
// checkout's history or belong to a commit later squashed or rebased away.
const CITED_BACKTICK_PATH_RE = /`([\w.][^`\s]*)`/g;
const CITED_FILE_LINE_RE = /([\w./-]+\.\w+):(\d+)(?:-(\d+))?/g;

/**
 * True when a whitespace-free backtick span (already matched by
 * CITED_BACKTICK_PATH_RE) reads as a repo path rather than something else
 * that happens to contain a `.` or `/`: a GitHub search qualifier
 * (`merged:<start>..<end>`), a bare placeholder (`<start>`), or a comparison
 * (`>=1,000`). #713 P3: without this, `merged:<start>..<end>` in #706's
 * `silent cap` line read as a missing file, and the backticks around it had
 * to be dropped instead of fixing the checker. Checked against every real
 * backtick span in docs/review-notes.md and docs/review-policy.md: the only
 * span this drops that the old (bare `/[./]/`) heuristic kept is
 * `url.<base>.insteadOf`, a git config key template, never a real path.
 */
function looksLikePath(span: string): boolean {
  if (!/[./]/.test(span)) return false; // no dot or slash at all: a bare identifier
  if (/[<>]/.test(span)) return false; // a placeholder (<start>) or a comparison (>=, <=)
  if (/\.\./.test(span)) return false; // a range like <start>..<end>: no real repo path has one
  const colon = span.indexOf(':');
  const slash = span.indexOf('/');
  // A colon before the first slash (or with no slash at all) is a qualifier
  // (`merged:x`) or a scheme (`http://x`), never a path — a real `path/to`
  // always puts its first `/` before any `:line` suffix.
  if (colon !== -1 && (slash === -1 || colon < slash)) return false;
  return true;
}
// A citation reads as pinned to a historical commit only when `at <sha>`
// immediately follows it — or follows an unbroken run of citations, joined
// only by `, ` or ` and `, that it belongs to. Not a clause-boundary
// heuristic (#713 P3: any `at <sha>` sharing a `(`, `)` or `;`-delimited
// clause with a citation used to pin it, so a stray sha elsewhere in the same
// clause silently suppressed the line check, and read the wrong direction —
// a sha *before* a citation counted the same as one after). Checked by hand
// against every pin currently in docs/review-notes.md: line 69's
// "`git-safety.sh:551-557`, `:627`, `:681-683` at 545c164cf" and line 70's
// "`git-safety.sh:154-156`, `:886-891` at 545c164cf" (a same-file `:N-M`
// continuation, comma-joined, still pins); line 72's "`git-safety.sh:681`,
// `:834`, `:889` and `secret-scan-allow.sh:93` at 545c164cf" (an " and "
// join, and a second file's own citation, both still pin); line 74's
// "`codex-review.sh:1084`, `:1556`, `:1777` at 35c8c952b"; and line 64's
// "`receipt-order.jq:5-6`, #692 at f6d93e3b0" (a bare `#<n>` — itself one of
// this file's own citation shapes — joins the run same as a file:line does).
// Line 65's "(#692 at f6d93e3b0, `codex-review.sh:858`), and one edited in it
// too (#698 at 35c8c952b" pins nothing: the first sha *precedes* the
// citation, and prose ("and one edited in it too") sits between the citation
// and the next sha, breaking the run. A pinned citation must never be read
// against the working tree — it is checked against that commit with `git
// show <sha>:<path>` instead (#713).
const AT_SHA_RE = /^at\s+([0-9a-f]{7,40})\b/;
// One hop in a pinning run: either a same-file `:N` / `:N-M` continuation (no
// filename of its own), a whole other file's own citation, or a bare `#<n>` —
// each optionally backtick-quoted.
const PIN_CHAIN_LINK_RE = /^`?(?:(?:[\w./-]+\.\w+)?:\d+(?:-\d+)?|#\d+)`?/;
const PIN_CHAIN_JOIN_RE = /^\s*(?:,|and)\s*/;

/**
 * The sha pinning the citation that ends at `pos` in `fix`, or null when
 * nothing pins it. Walks forward from `pos` through zero or more
 * comma-/"and"-joined chain links (PIN_CHAIN_LINK_RE) — consuming a citation's
 * own closing backtick first, if there is one — then requires `at <sha>` to
 * follow immediately (only whitespace in between).
 */
function pinningShaAfter(fix: string, pos: number): string | null {
  let i = fix[pos] === '`' ? pos + 1 : pos;
  for (;;) {
    const join = PIN_CHAIN_JOIN_RE.exec(fix.slice(i));
    if (!join) break;
    const afterJoin = i + join[0].length;
    const link = PIN_CHAIN_LINK_RE.exec(fix.slice(afterJoin));
    if (!link) break;
    i = afterJoin + link[0].length;
  }
  const rest = fix.slice(i).replace(/^\s*/, '');
  const sha = AT_SHA_RE.exec(rest);
  return sha ? sha[1] : null;
}

/** A file's real line count: `.split('\n').length` over-counts by one when the file ends with a trailing newline (#713). */
function countLines(content: string): number {
  if (content === '') return 0;
  return (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n').length;
}

/** Runs `git <args>` in `root`, returning stdout on a zero exit, or null on any failure. */
function gitRead(root: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/**
 * True when `filePath` names a real blob or tree (file or directory) in
 * `root`'s repo. `rev` checks a historical commit-ish for a pinned citation.
 * Omit it to check the index rather than HEAD (#713 P3): a file staged but
 * not yet committed then passes the local review loop the same way it will
 * once committed, while an untracked or gitignored path still fails exactly
 * as it would in a fresh checkout that never had it either. `git cat-file -e
 * :<path>` cannot see a directory this way — the index holds blobs, not tree
 * entries — so the no-`rev` case goes through `ls-files --error-unmatch`
 * instead, which matches a directory against every tracked/staged path under
 * it the same way `cat-file` matches a tree object at a real commit.
 */
function gitPathExists(root: string, filePath: string, rev?: string): boolean {
  if (rev === undefined)
    // --literal-pathspecs (#730 P3): ls-files otherwise treats `filePath` as a
    // pathspec, so a citation shaped like a glob (`scripts/*.test.ts`) or a
    // single-char wildcard (`docs/review-notes.m?`) passes existence just by
    // matching some other tracked file — this repo's own `pathspec quoting`
    // class (docs/review-notes.md:67).
    return (
      spawnSync('git', ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', filePath], { cwd: root })
        .status === 0
    );
  return spawnSync('git', ['cat-file', '-e', `${rev}:${filePath}`], { cwd: root }).status === 0;
}

/** True when `sha` resolves to a real commit object in `root`'s repo — false in a checkout too shallow to have it. */
function gitCommitResolvable(root: string, sha: string): boolean {
  return spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root }).status === 0;
}

/** True when `root`'s repo is a shallow clone (a partial history, missing most commit objects) — the only case an unresolvable pinned sha is expected, not a typo (#730 P3). */
function gitIsShallowRepo(root: string): boolean {
  return (gitRead(root, ['rev-parse', '--is-shallow-repository']) ?? '').trim() === 'true';
}

/** `filePath`'s line count at `rev` in `root`'s repo, or null when it can't be read there. Omit `rev` to read the index (see gitPathExists). */
function gitLineCount(root: string, filePath: string, rev?: string): number | null {
  const content = gitRead(root, ['show', `${rev ?? ''}:${filePath}`]);
  return content === null ? null : countLines(content);
}

interface FileLineCitation {
  file: string;
  span: string; // "N" or "N-M", exactly as cited
  endLine: number; // M when a range, else N
  pinnedSha: string | null;
}

function fileLineCitations(fix: string): FileLineCitation[] {
  const citations: FileLineCitation[] = [];
  for (const m of fix.matchAll(CITED_FILE_LINE_RE)) {
    const [, file, startStr, endStr] = m;
    citations.push({
      file,
      span: endStr ? `${startStr}-${endStr}` : startStr,
      endLine: Number(endStr ?? startStr),
      pinnedSha: pinningShaAfter(fix, (m.index ?? 0) + m[0].length),
    });
  }
  return citations;
}

/** Existence problems for one structural-fix field's citations, checked against `root`'s git repo. */
function citationExistenceProblems(fix: string, root: string): string[] {
  const problems: string[] = [];

  for (const { file, span, endLine, pinnedSha } of fileLineCitations(fix)) {
    if (pinnedSha) {
      if (!gitCommitResolvable(root, pinnedSha)) {
        // A shallow CI checkout (.github/workflows/ci.yml uses actions/checkout@v4
        // with no fetch-depth override, so depth 1) cannot resolve most historical
        // shas at all — the *only* case an unresolvable sha is expected, not a
        // mistake. Skipping unconditionally here (#730 P3 regression) let a
        // typo'd `at <sha>` silently exempt a wrong line, or a citation to a
        // file that never existed, even in a full clone that could have
        // caught it. So only a genuinely shallow repo skips (with a test-log
        // note, never checking the path at HEAD as a fallback — a citation
        // correct at its own pinned commit but whose file has since been
        // deleted must not fail only there); a full clone that simply cannot
        // resolve the sha treats that as the problem it is.
        if (gitIsShallowRepo(root)) {
          console.warn(
            `review-notes: skipping \`${file}:${span}\` at ${pinnedSha} — that commit is not resolvable in ` +
              'this checkout (a shallow clone); not checked',
          );
          continue;
        }
        problems.push(`cites \`${file}:${span}\` at ${pinnedSha}, but ${pinnedSha} does not resolve to a commit here`);
        continue;
      }
      if (!gitPathExists(root, file, pinnedSha)) {
        problems.push(`cites \`${file}:${span}\` at ${pinnedSha}, but ${file} does not exist at ${pinnedSha}`);
        continue;
      }
      const lineCount = gitLineCount(root, file, pinnedSha);
      if (lineCount === null || lineCount < endLine)
        problems.push(
          `cites \`${file}:${span}\` at ${pinnedSha}, but ${file} has only ${lineCount ?? 0} lines at ${pinnedSha}`,
        );
      continue;
    }
    if (!gitPathExists(root, file)) {
      problems.push(`cites \`${file}:${span}\`, but ${file} does not exist`);
      continue;
    }
    const lineCount = gitLineCount(root, file);
    if (lineCount === null || lineCount < endLine)
      problems.push(`cites \`${file}:${span}\`, but ${file} has only ${lineCount ?? 0} lines`);
  }

  for (const [, span] of fix.matchAll(CITED_BACKTICK_PATH_RE)) {
    if (!looksLikePath(span)) continue; // not path-like: a bare identifier, a qualifier, a placeholder…
    if (/:\d/.test(span)) continue; // a file:line span, already checked above
    if (span.startsWith('~')) continue; // a host path outside the repo: format-only, like #<n> and a sha
    if (!gitPathExists(root, span)) problems.push(`cites \`${span}\`, which does not exist in the repo`);
  }

  return problems;
}

type Lesson = { line: number; date: string; cls: string; fix: string };

/** The lines of `## <name>`, up to the next `## ` heading, with their 1-based line numbers. */
function section(lines: string[], name: string): { line: number; text: string }[] | null {
  const start = lines.findIndex((text) => text === `## ${name}`);
  if (start === -1) return null;
  const out: { line: number; text: string }[] = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i++)
    out.push({ line: i + 1, text: lines[i] });
  return out;
}

function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date);
}

/**
 * Every rule violation in a review-notes file's text; empty when it passes.
 * `today` is a UTC YYYY-MM-DD date; no lesson may be dated after it. `root`,
 * when given, additionally checks every cited backtick path and file:line
 * against the filesystem there (citationExistenceProblems) — omit it to
 * check format only, as every caller but the real docs/review-notes.md check
 * does.
 */
export function reviewNotesProblems(
  text: string,
  today = new Date().toISOString().slice(0, 10),
  root?: string,
): string[] {
  const lines = text.split('\n');
  const problems: string[] = [];

  const classes = section(lines, 'Classes');
  const lessonLines = section(lines, 'Lessons');
  if (!classes) problems.push('no `## Classes` section');
  if (!lessonLines) problems.push('no `## Lessons` section');
  if (!classes || !lessonLines) return problems;

  const registry = new Set<string>();
  for (const { line, text: entry } of classes) {
    if (!entry.startsWith('- ')) continue;
    const match = CLASS_ENTRY.exec(entry);
    if (!match) {
      problems.push(`line ${line}: a class entry is "- \`<class>\` — <definition>": ${entry}`);
      continue;
    }
    if (registry.has(match[1])) problems.push(`line ${line}: class \`${match[1]}\` is registered twice`);
    registry.add(match[1]);
  }
  if (registry.size === 0) problems.push('`## Classes` registers no class');

  const lessons: Lesson[] = [];
  for (const { line, text: entry } of lessonLines) {
    if (entry.trim() === '') continue;
    if (!entry.startsWith('- ')) {
      problems.push(`line ${line}: every line under Lessons is one whole lesson starting "- ": ${entry}`);
      continue;
    }
    const fields = entry.slice(2).split(SEPARATOR);
    if (fields.length !== 5) {
      problems.push(
        `line ${line}: ${fields.length} fields, not 5 (YYYY-MM-DD · PR · class · lesson · structural fix); ` +
          `a ' · ' inside a field splits it`,
      );
      continue;
    }
    const [date, pr, cls, lesson, fix] = fields.map((field) => field.trim());
    if (!isRealDate(date)) problems.push(`line ${line}: "${date}" is not a YYYY-MM-DD date`);
    else if (date > today) problems.push(`line ${line}: ${date} is after today (${today}, UTC)`);
    if (!PR_FIELD.test(pr)) problems.push(`line ${line}: PR "${pr}" is not #<n>, #<n>/#<m>…, or rule`);
    if (!registry.has(cls)) problems.push(`line ${line}: class "${cls}" is not registered under Classes`);
    if (lesson === '') problems.push(`line ${line}: the lesson is empty`);
    if (fix === '') problems.push(`line ${line}: the structural fix is empty; write "none" if there is none`);
    else if (fix !== 'none' && !CITATIONS.some((re) => re.test(fix)))
      problems.push(
        `line ${line}: structural fix "${fix}" is neither exactly "none" nor a citation ` +
          '(a backtick path, a file:line, a #<n>, or a commit sha)',
      );
    if (root && fix !== 'none')
      for (const problem of citationExistenceProblems(fix, root)) problems.push(`line ${line}: ${problem}`);
    lessons.push({ line, date, cls, fix });
  }
  if (lessons.length === 0) problems.push('`## Lessons` holds no lesson');

  const byClass = new Map<string, Lesson[]>();
  for (const lesson of lessons) byClass.set(lesson.cls, [...(byClass.get(lesson.cls) ?? []), lesson]);
  for (const [cls, group] of byClass) {
    if (group.length < 2) continue;
    const newest = group.reduce((a, b) => (b.date > a.date || (b.date === a.date && b.line > a.line) ? b : a));
    if (newest.fix === 'none') {
      problems.push(
        `class "${cls}" recurs (lines ${group.map((l) => l.line).join(', ')}) and its newest line (${newest.line}) ` +
          `has structural fix "none": the second occurrence is where the lint rule, test or primitive lands — name it`,
      );
    }
  }
  return problems;
}

// Synthetic cases judge against a fixed day, so they never depend on the clock.
const TODAY = '2026-09-12';
const FIX = '`src/x.ts`';

/** A notes file with the given class registry and lesson lines. */
function notes(classes: string[], lessons: string[]): string {
  return [
    '# Review notes',
    '',
    'Intro.',
    '',
    '## Classes',
    '',
    ...classes.map((cls) => `- \`${cls}\` — what it means`),
    '',
    '## Lessons',
    '',
    ...lessons,
    '',
  ].join('\n');
}

describe('docs/review-notes.md', () => {
  it('is in format, uses registered classes, cites its fixes, and names a fix for every recurring class', () => {
    expect(reviewNotesProblems(fs.readFileSync(NOTES_PATH, 'utf8'))).toEqual([]);
  });

  // #707 P3-d: every cited backtick path and file:line must name something
  // real in the repo at HEAD, not just look like one.
  it('cites paths and file:lines that actually exist at HEAD', () => {
    expect(reviewNotesProblems(fs.readFileSync(NOTES_PATH, 'utf8'), undefined, REPO_ROOT)).toEqual([]);
  });

  // #730 P3: fix 1 (an unresolvable pinned sha is a problem in a full clone)
  // must not turn a real, historical pin into a false failure in CI's own
  // shallow checkout (.github/workflows/ci.yml: actions/checkout@v4, no
  // fetch-depth override, so depth 1) — proved against a real `--depth 1`
  // clone of this repo, not a synthetic fixture.
  it('cites paths and file:lines that still pass in a shallow clone', () => {
    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'review-notes-shallow-'));
    try {
      spawnSync('git', ['clone', '-q', '--depth', '1', `file://${REPO_ROOT}`, shallow]);
      expect((gitRead(shallow, ['rev-parse', '--is-shallow-repository']) ?? '').trim()).toBe('true'); // sanity
      const shallowNotes = fs.readFileSync(path.join(shallow, 'docs', 'review-notes.md'), 'utf8');
      expect(reviewNotesProblems(shallowNotes, undefined, shallow)).toEqual([]);
    } finally {
      fs.rmSync(shallow, { recursive: true, force: true });
    }
  });
});

describe('reviewNotesProblems', () => {
  it('passes well-formed lines, including a one-off class with no structural fix', () => {
    const text = notes(
      ['alpha', 'beta'],
      [
        '- 2026-09-01 · #1 · alpha · A lesson · a test at x.ts:1',
        '- 2026-09-02 · #2/#3 · beta · Another · none',
        `- ${TODAY} · rule · alpha · A rule line, dated today · the check at y.ts:2`,
      ],
    );
    expect(reviewNotesProblems(text, TODAY)).toEqual([]);
  });

  it.each([
    ['a backtick path', '`scripts/check.ts`'],
    ['a file:line', 'guarded at codex-review.sh:915'],
    ['a PR or issue number', 'tracked in #676'],
    ['a commit sha', 'fixed at 545c164cf'],
    ['exactly none', 'none'],
  ])('accepts a structural fix that is %s', (_case, fix) => {
    expect(reviewNotesProblems(notes(['alpha'], [`- 2026-09-01 · #1 · alpha · A lesson · ${fix}`]), TODAY)).toEqual([]);
  });

  it.each([
    ['four fields', `- 2026-09-01 · #1 · A lesson · ${FIX}`, /4 fields, not 5/],
    ['a separator inside a field', `- 2026-09-01 · #1 · alpha · A · lesson · ${FIX}`, /6 fields, not 5/],
    ['no leading dash', `2026-09-01 · #1 · alpha · A lesson · ${FIX}`, /starting "- "/],
    ['a wrapped continuation line', '  continued from the line above', /starting "- "/],
    ['a date that is not one', `- 2026-02-30 · #1 · alpha · A lesson · ${FIX}`, /not a YYYY-MM-DD date/],
    ['a date after today', `- 2026-09-13 · #1 · alpha · A lesson · ${FIX}`, /2026-09-13 is after today \(2026-09-12/],
    ['a PR field that is not a PR', `- 2026-09-01 · PR 1 · alpha · A lesson · ${FIX}`, /is not #<n>/],
    ['an empty structural fix', '- 2026-09-01 · #1 · alpha · A lesson ·  ', /structural fix is empty/],
    ['a structural fix of TBD', '- 2026-09-01 · #1 · alpha · A lesson · TBD', /"TBD" is neither exactly "none"/],
    ['a structural fix of -', '- 2026-09-01 · #1 · alpha · A lesson · -', /"-" is neither exactly "none"/],
    ['a structural fix of n/a', '- 2026-09-01 · #1 · alpha · A lesson · n/a', /"n\/a" is neither exactly "none"/],
    ['none with a tail', '- 2026-09-01 · #1 · alpha · A lesson · none; later', /"none; later" is neither/],
    ['None, capitalised', '- 2026-09-01 · #1 · alpha · A lesson · None', /"None" is neither/],
    ['prose that cites nothing', '- 2026-09-01 · #1 · alpha · A lesson · the `lstat` guard', /is neither/],
  ])('fails %s', (_case, line, problem) => {
    // A well-formed line alongside, so the bad one is the only problem.
    const text = notes(['alpha'], [`- 2026-08-31 · #9 · alpha · A good line · ${FIX}`, line]);
    expect(reviewNotesProblems(text, TODAY)).toEqual([expect.stringMatching(problem)]);
  });

  it('fails a class the registry does not list', () => {
    const problems = reviewNotesProblems(notes(['alpha'], [`- 2026-09-01 · #1 · gamma · A lesson · ${FIX}`]), TODAY);
    expect(problems).toEqual([expect.stringMatching(/class "gamma" is not registered/)]);
  });

  it('fails a class registered twice, and a file with no Classes or no Lessons section', () => {
    expect(reviewNotesProblems(notes(['alpha', 'alpha'], [`- 2026-09-01 · #1 · alpha · A · ${FIX}`]), TODAY)).toEqual([
      expect.stringMatching(/registered twice/),
    ]);
    expect(
      reviewNotesProblems(`# Review notes\n\n## Lessons\n\n- 2026-09-01 · #1 · alpha · A · ${FIX}\n`, TODAY),
    ).toContain('no `## Classes` section');
    expect(reviewNotesProblems('# Review notes\n\n## Classes\n\n- `alpha` — x\n', TODAY)).toContain(
      'no `## Lessons` section',
    );
  });

  // The recurrence rule (mutation: never treating the newest fix as `none` passes a repeat with no fix).
  it('fails a class on a second line whose newest structural fix is none', () => {
    const problems = reviewNotesProblems(
      notes(
        ['alpha'],
        ['- 2026-09-01 · #1 · alpha · First time · none', '- 2026-09-02 · #2 · alpha · Second time · none'],
      ),
      TODAY,
    );
    expect(problems).toEqual([
      expect.stringMatching(/class "alpha" recurs \(lines 11, 12\) and its newest line \(12\)/),
    ]);
  });

  it('passes a recurring class once its newest line names a structural fix, whatever the older ones said', () => {
    const problems = reviewNotesProblems(
      notes(
        ['alpha'],
        [
          '- 2026-09-01 · #1 · alpha · First time · none',
          '- 2026-09-02 · #2 · alpha · Second time · none',
          '- 2026-09-03 · #3 · alpha · Third time · a lint rule at z.ts:9',
        ],
      ),
      TODAY,
    );
    expect(problems).toEqual([]);
  });

  it('takes the newest line by date, then by position among lines of one date', () => {
    // Later in the file but older by date: the dated-newest line's `none` still fails.
    const byDate = notes(
      ['alpha'],
      ['- 2026-09-05 · #5 · alpha · Newer · none', `- 2026-09-01 · #1 · alpha · Older, appended late · ${FIX}`],
    );
    expect(reviewNotesProblems(byDate, TODAY)).toEqual([expect.stringMatching(/newest line \(11\)/)]);
    const sameDay = notes(
      ['alpha'],
      [`- 2026-09-05 · #5 · alpha · Earlier that day · ${FIX}`, '- 2026-09-05 · #6 · alpha · Later that day · none'],
    );
    expect(reviewNotesProblems(sameDay, TODAY)).toEqual([expect.stringMatching(/newest line \(12\)/)]);
  });
});

describe('citation existence, checked only when a root is given (#707 P3-d)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function tempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-notes-test-'));
    roots.push(root);
    return root;
  }

  // A real (if often empty) git repo: existence is now checked against git,
  // not the filesystem (#713), so every root a citation is checked against
  // must actually be one.
  function gitRoot(): string {
    const root = tempRoot();
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    return root;
  }

  /** Commits everything currently in `root` (gitignored files excluded, as `git add -A` does) and returns the new HEAD sha. */
  function commit(root: string, message = 'fixture'): string {
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-q', '--allow-empty', '-m', message, '--no-gpg-sign'], { cwd: root });
    return (gitRead(root, ['rev-parse', 'HEAD']) ?? '').trim();
  }

  /** A real `--depth 1` clone of `root`'s current HEAD — the one case gitCommitResolvable is expected to answer false for an otherwise-real, historical sha (#730 P3). `git clone` accepts an existing, empty destination directory. */
  function shallowCloneOf(root: string): string {
    const clone = tempRoot();
    spawnSync('git', ['clone', '-q', '--depth', '1', `file://${root}`, clone]);
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: clone });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: clone });
    return clone;
  }

  it('fails a structural fix citing a backtick path that does not exist', () => {
    const root = gitRoot();
    const text = notes(['alpha'], ['- 2026-09-01 · #1 · alpha · A lesson · fixed in `no/such/file.ts`']);
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([
      expect.stringMatching(/cites `no\/such\/file\.ts`, which does not exist/),
    ]);
  });

  it('fails a structural fix whose file:line names a line past the end of the file', () => {
    const root = gitRoot();
    fs.writeFileSync(path.join(root, 'small.ts'), 'line one\nline two\nline three\n');
    commit(root);
    const text = notes(['alpha'], ['- 2026-09-01 · #1 · alpha · A lesson · guarded at `small.ts:99`']);
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([
      expect.stringMatching(/cites `small\.ts:99`, but small\.ts has only \d+ lines/),
    ]);
  });

  it('fails a structural fix whose file:line names a file that does not exist at all', () => {
    const root = gitRoot();
    const text = notes(['alpha'], ['- 2026-09-01 · #1 · alpha · A lesson · guarded at `no/such/file.ts:5`']);
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([
      expect.stringMatching(/cites `no\/such\/file\.ts:5`, but no\/such\/file\.ts does not exist/),
    ]);
  });

  it('passes real citations: a backtick path and a file:line that both resolve', () => {
    const root = gitRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'thing.ts'), Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n'));
    fs.writeFileSync(path.join(root, 'README.md'), '# hi\n');
    commit(root);
    const text = notes(
      ['alpha'],
      ['- 2026-09-01 · #1 · alpha · A lesson · documented in `README.md`, guarded at `src/thing.ts:5`'],
    );
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([]);
  });

  it('never checks a #<n> or a commit sha against the filesystem', () => {
    const root = gitRoot();
    const text = notes(
      ['alpha'],
      ['- 2026-09-01 · #1 · alpha · A lesson · tracked in #9999999 and fixed at abcdef01234'],
    );
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([]);
  });

  it('skips the existence check entirely when no root is given', () => {
    const text = notes(['alpha'], ['- 2026-09-01 · #1 · alpha · A lesson · fixed in `no/such/file.ts`']);
    expect(reviewNotesProblems(text, TODAY)).toEqual([]);
  });

  // #713: a bare backtick path ending in `/`, or with no extension at all, is
  // a directory citation — `git cat-file -e <rev>:<path>` answers a tree
  // object the same way it answers a blob, so this keeps working unchanged.
  it('passes a directory citation that exists in the repo', () => {
    const root = gitRoot();
    fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'sub', 'file.ts'), 'x\n');
    commit(root);
    const text = notes(['alpha'], ['- 2026-09-01 · #1 · alpha · A lesson · see `src/sub/`']);
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([]);
  });

  // #713: a `~/` path names something on the host, never in this repo — left
  // format-only, exactly like `#<n>` and a commit sha, rather than reported as
  // a missing repo path.
  it('never checks a ~/ path against the repo', () => {
    const root = gitRoot();
    commit(root);
    const text = notes(['alpha'], ['- 2026-09-01 · #1 · alpha · A lesson · see `~/plugins/example/SKILL.md`']);
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([]);
  });

  // #713 P3: a GitHub search qualifier or placeholder must not be misread as
  // a missing repo path — the false positive that forced #706's `silent cap`
  // line to drop its backticks around `merged:<start>..<end>`.
  it('does not treat a search qualifier or a placeholder as a missing repo path', () => {
    const root = gitRoot();
    commit(root);
    const text = notes(
      ['alpha'],
      ['- 2026-09-01 · #1 · alpha · A lesson · now slices by `merged:<start>..<end>` and rejects `>=1,000` rows'],
    );
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([]);
  });

  // The heuristic narrows false positives; it must not stop checking real
  // paths alongside a non-path backtick span in the same fix.
  it('still fails a genuine missing path alongside a non-path backtick span', () => {
    const root = gitRoot();
    commit(root);
    const text = notes(
      ['alpha'],
      ['- 2026-09-01 · #1 · alpha · A lesson · slices by `merged:<start>..<end>`, fixed in `no/such/file.ts`'],
    );
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([
      expect.stringMatching(/cites `no\/such\/file\.ts`, which does not exist/),
    ]);
  });

  // #713: existence must come from git, not fs.existsSync — a path present on
  // disk but gitignored (so absent from any real checkout, CI's included)
  // must fail exactly as it would there.
  it('fails a gitignored path locally just as it would in CI', () => {
    const root = gitRoot();
    fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.ts\n');
    fs.writeFileSync(path.join(root, 'ignored.ts'), 'one\ntwo\nthree\n');
    commit(root); // .gitignore is tracked; ignored.ts, matching it, never is
    const text = notes(['alpha'], ['- 2026-09-01 · #1 · alpha · A lesson · fixed in `ignored.ts`']);
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([
      expect.stringMatching(/cites `ignored\.ts`, which does not exist/),
    ]);
  });

  // #713: `.split('\n').length` counts one line too many for a file ending in
  // a trailing newline (the normal case) — `:4` must fail on a real 3-line file.
  it("counts a trailing-newline file's real line count, not one more", () => {
    const root = gitRoot();
    fs.writeFileSync(path.join(root, 'three.ts'), 'line one\nline two\nline three\n');
    commit(root);
    expect(
      reviewNotesProblems(notes(['alpha'], ['- 2026-09-01 · #1 · alpha · A lesson · at `three.ts:3`']), TODAY, root),
    ).toEqual([]);
    expect(
      reviewNotesProblems(notes(['alpha'], ['- 2026-09-01 · #1 · alpha · A lesson · at `three.ts:4`']), TODAY, root),
    ).toEqual([expect.stringMatching(/cites `three\.ts:4`, but three\.ts has only 3 lines/)]);
  });

  // #713: a `file:N-M` range's end M must be in bounds too, not just N.
  it('fails a range citation whose end is past the file, and passes one whose end is exactly the last line', () => {
    const root = gitRoot();
    fs.writeFileSync(path.join(root, 'small.ts'), 'line one\nline two\nline three\n');
    commit(root);
    expect(
      reviewNotesProblems(notes(['alpha'], ['- 2026-09-01 · #1 · alpha · A lesson · guarded at `small.ts:2-99`']), TODAY, root),
    ).toEqual([expect.stringMatching(/cites `small\.ts:2-99`, but small\.ts has only 3 lines/)]);
    expect(
      reviewNotesProblems(notes(['alpha'], ['- 2026-09-01 · #1 · alpha · A lesson · guarded at `small.ts:2-3`']), TODAY, root),
    ).toEqual([]);
  });

  // #713: a citation pinned to an older commit ("`file:N` at <sha>") must be
  // judged against that commit, never the working tree — a file that has
  // since grown past the cited line must not retroactively make an old,
  // correct-at-the-time citation start failing (nor should it: it names a
  // line at that commit, not at HEAD).
  it('checks a pinned citation ("at <sha>") against that commit, not the working tree', () => {
    const root = gitRoot();
    fs.writeFileSync(path.join(root, 'evolve.ts'), 'line one\nline two\nline three\n');
    const oldSha = commit(root, 'three lines');
    fs.writeFileSync(path.join(root, 'evolve.ts'), 'line one\ntwo\nthree\nfour\nfive\n');
    commit(root, 'five lines');

    const passing = notes(['alpha'], [`- 2026-09-01 · #1 · alpha · A lesson · fixed at \`evolve.ts:3\` at ${oldSha}`]);
    expect(reviewNotesProblems(passing, TODAY, root)).toEqual([]);

    // 5 is in bounds at HEAD (5 lines) but not at oldSha (3 lines): pinning
    // must read this against oldSha, catching it, not silently pass it
    // because HEAD happens to have grown enough lines since.
    const failing = notes(['alpha'], [`- 2026-09-01 · #1 · alpha · A lesson · fixed at \`evolve.ts:5\` at ${oldSha}`]);
    expect(reviewNotesProblems(failing, TODAY, root)).toEqual([
      expect.stringMatching(new RegExp(`cites \`evolve\\.ts:5\` at ${oldSha}, but evolve\\.ts has only 3 lines at ${oldSha}`)),
    ]);
  });

  // #730 P3: an unresolvable pinned sha is a problem in a full clone — this
  // checker is never entitled to a free pass just because a sha it can look
  // up doesn't exist. Skipping unconditionally (as this used to) let a
  // typo'd `at <sha>` silently exempt a wrong line, and a full clone has
  // every commit it will ever have: there is nothing left to fetch that
  // would make the sha resolve later.
  it('fails a typo\'d pin against a wrong line, in a full clone', () => {
    const root = gitRoot();
    fs.writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\nthree\n');
    commit(root);
    const typo = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'; // well-formed, but no such commit anywhere
    const text = notes(['alpha'], [`- 2026-09-01 · #1 · alpha · A lesson · fixed at \`a.ts:99\` at ${typo}`]);
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([
      expect.stringMatching(new RegExp(`cites \`a\\.ts:99\` at ${typo}, but ${typo} does not resolve to a commit here`)),
    ]);
  });

  // #730 P3: the regression this class exists for — a typo'd pin against a
  // citation to a file that never existed used to be silently exempted too.
  it('fails a typo\'d pin against a missing file, in a full clone', () => {
    const root = gitRoot();
    commit(root);
    const typo = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const text = notes(['alpha'], [`- 2026-09-01 · #1 · alpha · A lesson · fixed at \`no/such.ts:1\` at ${typo}`]);
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([
      expect.stringMatching(
        new RegExp(`cites \`no/such\\.ts:1\` at ${typo}, but ${typo} does not resolve to a commit here`),
      ),
    ]);
  });

  // #730 P3: the one case an unresolvable pinned sha is expected, not a
  // mistake — a genuinely shallow checkout (CI's: .github/workflows/ci.yml
  // uses actions/checkout@v4 with no fetch-depth override, so depth 1)
  // cannot resolve a real, historical commit at all. A real `--depth 1`
  // clone proves it, rather than asserting on a merely well-formed sha that
  // was never a commit anywhere (that case is the full-clone tests above).
  // Checking the path at HEAD as a fallback (as this used to) fails a
  // citation that was correct at its own pinned commit but whose file has
  // since been deleted, and that failure would show up only in CI, never
  // locally — so it is skipped entirely instead, with a note in the test log.
  it('skips a pinned citation whose sha a shallow clone genuinely cannot resolve', () => {
    const full = gitRoot();
    fs.writeFileSync(path.join(full, 'a.ts'), 'one\n');
    const oldSha = commit(full, 'old'); // pruned by the shallow clone below
    fs.writeFileSync(path.join(full, 'a.ts'), 'one\ntwo\n');
    commit(full, 'new'); // depth 1 keeps only this commit
    const shallow = shallowCloneOf(full);

    // Sanity: the clone really is shallow, and really cannot resolve oldSha —
    // otherwise every assertion below would pass for the wrong reason.
    expect(gitIsShallowRepo(shallow)).toBe(true);
    expect(gitCommitResolvable(shallow, oldSha)).toBe(false);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = notes(['alpha'], [`- 2026-09-01 · #1 · alpha · A lesson · fixed at \`a.ts:1\` at ${oldSha}`]);
    expect(reviewNotesProblems(text, TODAY, shallow)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(oldSha);
    expect(warn.mock.calls[0][0]).toMatch(/not resolvable/);
    warn.mockRestore();
  });

  // #713 P3: existence for an unpinned citation is now checked against the
  // index, not HEAD, so a file staged in this same change — not yet
  // committed — is seen. The local review loop (author writes the note,
  // then commits) must not fail a citation to work still sitting staged.
  it('passes a citation to a file staged but not yet committed', () => {
    const root = gitRoot();
    commit(root); // an initial commit, so the repo has a HEAD at all
    fs.writeFileSync(path.join(root, 'new-file.ts'), 'line one\nline two\nline three\n');
    spawnSync('git', ['add', 'new-file.ts'], { cwd: root });
    const text = notes(['alpha'], ['- 2026-09-01 · #1 · alpha · A lesson · added in `new-file.ts:2`']);
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([]);
  });

  // #713 P3: the index still refuses a path nobody staged — present on disk,
  // untracked, never `git add`ed — exactly as a genuinely missing file would
  // read, so a citation to one must still fail rather than pass merely
  // because the bytes happen to exist on disk.
  it('still fails a citation to a file that is on disk but was never staged', () => {
    const root = gitRoot();
    commit(root);
    fs.writeFileSync(path.join(root, 'untracked.ts'), 'line one\nline two\nline three\n');
    const text = notes(['alpha'], ['- 2026-09-01 · #1 · alpha · A lesson · added in `untracked.ts:2`']);
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([
      expect.stringMatching(/cites `untracked\.ts:2`, but untracked\.ts does not exist/),
    ]);
  });

  // #730 P3: index existence went through a raw git pathspec, so a citation
  // shaped like a glob or a `?` wildcard passed just by matching some other
  // tracked file — this repo's own `pathspec quoting` class
  // (docs/review-notes.md:67). None of these three name a real file.
  it.each(['scripts/*.test.ts', 'src/**/*.ts', 'docs/review-notes.m?'])(
    'fails a citation shaped like a pathspec glob or wildcard: %s',
    (span) => {
      const root = gitRoot();
      fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts', 'foo.test.ts'), 'x\n'); // would match `scripts/*.test.ts`
      fs.writeFileSync(path.join(root, 'src', 'thing.ts'), 'x\n'); // would match `src/**/*.ts`
      fs.writeFileSync(path.join(root, 'docs', 'review-notes.md'), 'x\n'); // would match `docs/review-notes.m?`
      commit(root);
      const text = notes(['alpha'], [`- 2026-09-01 · #1 · alpha · A lesson · see \`${span}\``]);
      expect(reviewNotesProblems(text, TODAY, root)).toEqual([
        expect.stringMatching(new RegExp(`cites \\\`${span.replace(/[.*?+^${}()|[\]\\]/g, '\\$&')}\\\`, which does not exist`)),
      ]);
    },
  );

  // #713 P3: pinning is now "at <sha> immediately follows the citation (or an
  // unbroken run of citations it belongs to)", not "shares a clause with it" —
  // so a genuinely wrong citation must still fail even when an unrelated
  // `at <sha>` shares its parenthesized clause.
  it('fails a wrong citation even when an unrelated "at <sha>" shares its clause', () => {
    const root = gitRoot();
    fs.writeFileSync(path.join(root, 'small.ts'), 'line one\nline two\nline three\n');
    const sha = commit(root);
    const text = notes(
      ['alpha'],
      [`- 2026-09-01 · #1 · alpha · A lesson · (wrong at \`small.ts:99\`, an unrelated fix landed at ${sha})`],
    );
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([
      expect.stringMatching(/cites `small\.ts:99`, but small\.ts has only 3 lines/),
    ]);
  });

  // #713 P3: a decimal number is, textually, also a well-formed sha (every
  // digit is a valid hex digit) — "at 1000000" must not pin a citation just
  // because it matches that shape, when real prose sits between them.
  it('does not let a trailing "at 1000000" pin a citation across unrelated prose', () => {
    const root = gitRoot();
    fs.writeFileSync(path.join(root, 'small.ts'), 'line one\nline two\nline three\n');
    commit(root);
    const text = notes(
      ['alpha'],
      ['- 2026-09-01 · #1 · alpha · A lesson · wrong at `small.ts:99`, an unrelated count landed at 1000000'],
    );
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([
      expect.stringMatching(/cites `small\.ts:99`, but small\.ts has only 3 lines/),
    ]);
  });

  // #713 P3: a same-file `:N-M` continuation, comma-joined, still pins its
  // earlier citation — the shape docs/review-notes.md's own #683 lines use
  // ("`git-safety.sh:154-156`, `:886-891` at <sha>"). Proven by pinning to a
  // commit where the file was long enough, then shrinking it at HEAD: an
  // unpinned (HEAD-checked) read of this citation would fail.
  it('pins every citation in an unbroken run ending in "at <sha>"', () => {
    const root = gitRoot();
    fs.writeFileSync(path.join(root, 'git-safety.sh'), Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n'));
    const oldSha = commit(root, 'old, long enough');
    fs.writeFileSync(path.join(root, 'git-safety.sh'), 'shrunk\n');
    commit(root, 'new, far too short');
    const text = notes(
      ['alpha'],
      [`- 2026-09-01 · #1 · alpha · A lesson · fixed at \`git-safety.sh:154-156\`, \`:886-891\` at ${oldSha}`],
    );
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([]);
  });

  // #713 P3: a bare `#<n>` between a citation and "at <sha>" still pins —
  // `#<n>` is itself one of this file's own citation shapes — the shape
  // docs/review-notes.md's own #679 line uses ("citation, #<n> at <sha>").
  it('pins a citation joined to "at <sha>" only by a bare "#<n>"', () => {
    const root = gitRoot();
    fs.writeFileSync(path.join(root, 'thing.jq'), Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n'));
    const oldSha = commit(root, 'old, long enough');
    fs.writeFileSync(path.join(root, 'thing.jq'), 'shrunk\n');
    commit(root, 'new, far too short');
    const text = notes(['alpha'], [`- 2026-09-01 · #1 · alpha · A lesson · fixed in \`thing.jq:5-6\`, #692 at ${oldSha}`]);
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([]);
  });

  // #713 P3: a sha that precedes a citation must never pin it — pinning only
  // ever looks forward, from the citation to "at <sha>". Proven the same way:
  // if the preceding sha wrongly pinned it, the 1-line-old commit would fail
  // it; correctly unpinned, it is checked at the (3-line) index/HEAD instead.
  it('does not let an "at <sha>" that precedes a citation pin it', () => {
    const root = gitRoot();
    fs.writeFileSync(path.join(root, 'thing.ts'), 'one\n');
    const oldSha = commit(root, 'one line');
    fs.writeFileSync(path.join(root, 'thing.ts'), 'one\ntwo\nthree\n');
    commit(root, 'three lines');
    const text = notes(
      ['alpha'],
      [`- 2026-09-01 · #1 · alpha · A lesson · (#692 at ${oldSha}, fixed at \`thing.ts:3\`), and more prose after`],
    );
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([]);
  });
});
