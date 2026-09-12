import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
// A citation reads as pinned to a historical commit when `at <sha>` shares its
// clause — the run of text between the nearest `(`, `)` or `;` boundary
// before it and the nearest one at or after it. Not real sentence parsing,
// just a partition that happens to isolate every "at <sha>" instance
// currently in docs/review-notes.md correctly (checked by hand): line 72's
// "`:1084`, `:1556`, `:1777` at 35c8c952b" (all three share one clause with
// the sha), and line 62's "`receipt-order.jq:5-6`, #692 at f6d93e3b0; first
// closed in #679 at 0e5e11a68" (the first sha shares its clause with the
// citation; the second has none in its own clause and pins nothing). A pinned
// citation must never be read against the working tree — it is checked
// against that commit with `git show <sha>:<path>` instead (#713).
const AT_SHA_RE = /\bat\s+([0-9a-f]{7,40})\b/g;

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

/** True when `rev:path` names a real blob or tree (file or directory) in `root`'s repo. */
function gitPathExists(root: string, rev: string, filePath: string): boolean {
  return spawnSync('git', ['cat-file', '-e', `${rev}:${filePath}`], { cwd: root }).status === 0;
}

/** True when `sha` resolves to a real commit object in `root`'s repo — false in a checkout too shallow to have it. */
function gitCommitResolvable(root: string, sha: string): boolean {
  return spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root }).status === 0;
}

/** `path`'s line count at `rev` in `root`'s repo, or null when it can't be read there. */
function gitLineCount(root: string, rev: string, filePath: string): number | null {
  const content = gitRead(root, ['show', `${rev}:${filePath}`]);
  return content === null ? null : countLines(content);
}

function clauseBoundaries(text: string): number[] {
  const positions = [-1];
  for (let i = 0; i < text.length; i++) if (text[i] === '(' || text[i] === ')' || text[i] === ';') positions.push(i);
  positions.push(text.length);
  return positions;
}

/** The [left, right) span of the clause enclosing `index`, from a `clauseBoundaries` list. */
function clauseRange(positions: number[], index: number): [number, number] {
  let left = positions[0];
  let right = positions[positions.length - 1];
  for (const p of positions) {
    if (p <= index) left = p;
    if (p > index && p < right) right = p;
  }
  return [left, right];
}

interface FileLineCitation {
  file: string;
  span: string; // "N" or "N-M", exactly as cited
  endLine: number; // M when a range, else N
  pinnedSha: string | null;
}

function fileLineCitations(fix: string): FileLineCitation[] {
  const positions = clauseBoundaries(fix);
  const shaClauses: { left: number; right: number; sha: string }[] = [];
  for (const m of fix.matchAll(AT_SHA_RE)) {
    const [left, right] = clauseRange(positions, m.index ?? -1);
    shaClauses.push({ left, right, sha: m[1] });
  }
  const citations: FileLineCitation[] = [];
  for (const m of fix.matchAll(CITED_FILE_LINE_RE)) {
    const [left, right] = clauseRange(positions, m.index ?? -1);
    const clause = shaClauses.find((c) => c.left === left && c.right === right);
    const [, file, startStr, endStr] = m;
    citations.push({
      file,
      span: endStr ? `${startStr}-${endStr}` : startStr,
      endLine: Number(endStr ?? startStr),
      pinnedSha: clause ? clause.sha : null,
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
        // shas at all. Refusing every such citation there forever would be
        // spurious; silently skipping it would let a wrong one through. Split the
        // difference: still check the path exists now, but skip the line bound.
        if (!gitPathExists(root, 'HEAD', file))
          problems.push(`cites \`${file}:${span}\` at ${pinnedSha}, but ${file} does not exist`);
        continue;
      }
      if (!gitPathExists(root, pinnedSha, file)) {
        problems.push(`cites \`${file}:${span}\` at ${pinnedSha}, but ${file} does not exist at ${pinnedSha}`);
        continue;
      }
      const lineCount = gitLineCount(root, pinnedSha, file);
      if (lineCount === null || lineCount < endLine)
        problems.push(
          `cites \`${file}:${span}\` at ${pinnedSha}, but ${file} has only ${lineCount ?? 0} lines at ${pinnedSha}`,
        );
      continue;
    }
    if (!gitPathExists(root, 'HEAD', file)) {
      problems.push(`cites \`${file}:${span}\`, but ${file} does not exist`);
      continue;
    }
    const lineCount = gitLineCount(root, 'HEAD', file);
    if (lineCount === null || lineCount < endLine)
      problems.push(`cites \`${file}:${span}\`, but ${file} has only ${lineCount ?? 0} lines`);
  }

  for (const [, span] of fix.matchAll(CITED_BACKTICK_PATH_RE)) {
    if (!/[./]/.test(span)) continue; // not path-like: a bare identifier, not a citation
    if (/:\d/.test(span)) continue; // a file:line span, already checked above
    if (span.startsWith('~')) continue; // a host path outside the repo: format-only, like #<n> and a sha
    if (!gitPathExists(root, 'HEAD', span)) problems.push(`cites \`${span}\`, which does not exist in the repo`);
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

  // #713: a citation pinned to a sha this checkout cannot resolve (as in a
  // shallow CI checkout — .github/workflows/ci.yml uses actions/checkout@v4
  // with no fetch-depth override, so depth 1) must not fail spuriously: the
  // path is still checked at HEAD, but the line bound is skipped rather than
  // read against the wrong commit or refused outright.
  it('falls back to checking a pinned citation at HEAD when its sha cannot be resolved here', () => {
    const root = gitRoot();
    fs.writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\nthree\n');
    commit(root);
    const unresolvable = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'; // well-formed, but no such commit here

    const inBounds = notes(['alpha'], [`- 2026-09-01 · #1 · alpha · A lesson · fixed at \`a.ts:1\` at ${unresolvable}`]);
    expect(reviewNotesProblems(inBounds, TODAY, root)).toEqual([]);

    // The line bound is skipped entirely for an unresolvable sha — even a
    // wildly out-of-range line passes, since there is nothing to check it
    // against without failing every PR on this line forever.
    const outOfBounds = notes(['alpha'], [`- 2026-09-01 · #1 · alpha · A lesson · fixed at \`a.ts:999\` at ${unresolvable}`]);
    expect(reviewNotesProblems(outOfBounds, TODAY, root)).toEqual([]);

    // The path itself is still checked, against HEAD.
    const missing = notes(['alpha'], [`- 2026-09-01 · #1 · alpha · A lesson · fixed at \`no/such.ts:1\` at ${unresolvable}`]);
    expect(reviewNotesProblems(missing, TODAY, root)).toEqual([
      expect.stringMatching(new RegExp(`cites \`no/such\\.ts:1\` at ${unresolvable}, but no/such\\.ts does not exist`)),
    ]);
  });
});
