import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
// When a repo root is given, these two check it names something real at that
// root, at HEAD:
//   - a whitespace-free backtick span with a `.` or `/` and no `:line` tail
//     must be an existing path;
//   - a `path.ext:N` (or `path.ext:N-M`) span, backtick-quoted or bare, must
//     name an existing file with at least N lines.
// `#<n>` and a commit sha are left format-only: neither can be checked
// offline — there is no local issue/PR list, and a sha may predate this
// checkout's history or belong to a commit later squashed or rebased away.
const CITED_BACKTICK_PATH_RE = /`([\w.][^`\s]*)`/g;
const CITED_FILE_LINE_RE = /([\w./-]+\.\w+):(\d+)(?:-\d+)?/g;

/** Existence problems for one structural-fix field's citations, checked against `root`. */
function citationExistenceProblems(fix: string, root: string): string[] {
  const problems: string[] = [];

  for (const [, file, lineStr] of fix.matchAll(CITED_FILE_LINE_RE)) {
    const full = path.join(root, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      problems.push(`cites \`${file}:${lineStr}\`, but ${file} does not exist`);
      continue;
    }
    const lineCount = fs.readFileSync(full, 'utf8').split('\n').length;
    if (lineCount < Number(lineStr))
      problems.push(`cites \`${file}:${lineStr}\`, but ${file} has only ${lineCount} lines`);
  }

  for (const [, span] of fix.matchAll(CITED_BACKTICK_PATH_RE)) {
    if (!/[./]/.test(span)) continue; // not path-like: a bare identifier, not a citation
    if (/:\d/.test(span)) continue; // a file:line span, already checked above
    if (!fs.existsSync(path.join(root, span))) problems.push(`cites \`${span}\`, which does not exist in the repo`);
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

  it('fails a structural fix citing a backtick path that does not exist', () => {
    const root = tempRoot();
    const text = notes(['alpha'], ['- 2026-09-01 · #1 · alpha · A lesson · fixed in `no/such/file.ts`']);
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([
      expect.stringMatching(/cites `no\/such\/file\.ts`, which does not exist/),
    ]);
  });

  it('fails a structural fix whose file:line names a line past the end of the file', () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'small.ts'), 'line one\nline two\nline three\n');
    const text = notes(['alpha'], ['- 2026-09-01 · #1 · alpha · A lesson · guarded at `small.ts:99`']);
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([
      expect.stringMatching(/cites `small\.ts:99`, but small\.ts has only \d+ lines/),
    ]);
  });

  it('fails a structural fix whose file:line names a file that does not exist at all', () => {
    const root = tempRoot();
    const text = notes(['alpha'], ['- 2026-09-01 · #1 · alpha · A lesson · guarded at `no/such/file.ts:5`']);
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([
      expect.stringMatching(/cites `no\/such\/file\.ts:5`, but no\/such\/file\.ts does not exist/),
    ]);
  });

  it('passes real citations: a backtick path and a file:line that both resolve', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'thing.ts'), Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n'));
    fs.writeFileSync(path.join(root, 'README.md'), '# hi\n');
    const text = notes(
      ['alpha'],
      ['- 2026-09-01 · #1 · alpha · A lesson · documented in `README.md`, guarded at `src/thing.ts:5`'],
    );
    expect(reviewNotesProblems(text, TODAY, root)).toEqual([]);
  });

  it('never checks a #<n> or a commit sha against the filesystem', () => {
    const root = tempRoot();
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
});
