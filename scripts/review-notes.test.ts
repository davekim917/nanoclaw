import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

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
const SEPARATOR = ' · ';
const PR_FIELD = /^(#\d+(\/#\d+)*|rule)$/;
const CLASS_ENTRY = /^- `([^`]+)` — \S/;
// What a structural fix may cite: a backtick span holding a path (a `/` or a
// `.`), a file:line, a PR or issue number, or a commit sha (7-40 hex digits,
// at least one of them a digit, so a hex-letter word never passes as one).
const CITATIONS = [/`[^`]*[./][^`]*`/, /[\w./-]+\.\w+:\d+/, /#\d+/, /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/];

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
 * `today` is a UTC YYYY-MM-DD date; no lesson may be dated after it.
 */
export function reviewNotesProblems(text: string, today = new Date().toISOString().slice(0, 10)): string[] {
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
