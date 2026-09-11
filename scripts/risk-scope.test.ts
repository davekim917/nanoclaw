import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';
import { globsForRiskHigh } from './review-outcomes.js';

allowSubprocess(['jq', 'git']);
enforceHermeticity();

/**
 * container/skills/pr-review-loop/scripts/risk-scope.jq decides, for
 * `codex-review.sh scope` and `merge-check`, whether a PR's changed files need
 * review. It has to answer exactly what actions/labeler v7 answers for the same
 * globs and paths: `new Minimatch(glob, {dot})` (labeler src/changedFiles.ts:229
 * at tag v7) with `dot` defaulting to true (action.yml:17-19), minimatch 10.2.5 in
 * its lockfile.
 *
 * minimatch is not a direct dependency, so it does not resolve from here; the
 * oracle is Node's `path.matchesGlob`, as in scripts/review-outcomes.ts. That is
 * minimatch WITHOUT `dot`: a wildcard there never matches a name that starts with
 * `.`. `labelerMatches` removes exactly that difference by renaming every dot
 * that opens a path segment, in the path and in the glob alike, to a character
 * neither contains. Nothing then starts with a dot, so `dot` has nothing left to
 * decide, and a literal `.github` still meets a literal `.github`. Git never
 * stores a `.` or `..` segment, which is the one place the rename would change an
 * answer. The anchors below pin the dot answers on their own, so the rename is
 * not the only evidence for them.
 */
function labelerMatches(file: string, glob: string): boolean {
  const undot = (s: string) => s.replace(/(^|\/)\./g, '$1\u0001');
  return path.matchesGlob(undot(file), undot(glob));
}

const SCRIPTS = path.resolve('container/skills/pr-review-loop/scripts');
const LABELER_YML = fs.readFileSync(path.resolve('.github/labeler.yml'), 'utf8');

/** Runs `program` with risk-scope.jq included, over `input` as JSON, or as raw text when `raw`. */
function jq(program: string, input: unknown, raw = false): { status: number | null; value: unknown; stderr: string } {
  const result = spawnSync('jq', ['-c', ...(raw ? ['-Rs'] : []), '-L', SCRIPTS, `include "risk-scope"; ${program}`], {
    input: raw ? String(input) : JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: result.status,
    value: result.status === 0 ? JSON.parse(result.stdout) : undefined,
    stderr: result.stderr,
  };
}

/** jq's answer for every (glob, path) pair, as one row of booleans per glob. */
function jqMatrix(globs: string[], paths: string[]): boolean[][] {
  const result = jq('.paths as $p | [ .globs[] | glob_regex as $re | [ $p[] | test($re) ] ]', { globs, paths });
  expect(result.stderr).toBe('');
  return result.value as boolean[][];
}

// Paths shaped like each glob: every `**` swapped for nothing, one segment, a deep
// run, or dotted ones, and every `*` for nothing, a name, or a dotted name — then
// each of those with a character or a segment added at either end, and upper-cased.
function pathsShapedLike(glob: string): string[] {
  const shaped: string[] = [];
  for (const deep of ['', 'd', 'd/e/f/g/h', '.d', '.d/e/.f']) {
    for (const star of ['', 's', '.s']) {
      const p = glob
        .split('/')
        .map((seg) => (seg === '**' ? deep : seg.replaceAll('*', star)))
        .filter(Boolean)
        .join('/');
      shaped.push(p, `${p}x`, `x${p}`, `x/${p}`, `${p}/x`, p.toUpperCase());
    }
  }
  return shaped.filter((p) => p !== '' && !p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..'));
}

describe('risk-scope.jq reads labeler.yml', () => {
  const rule = (items: string) => `risk:high:\n- changed-files:\n  - any-glob-to-any-file:\n${items}`;

  it('reads the real risk:high globs exactly as a YAML parser does', () => {
    const globs = globsForRiskHigh(parse(LABELER_YML) as Record<string, unknown>);
    expect(globs.length).toBeGreaterThan(0);
    expect(jq('risk_high_globs', LABELER_YML, true).value).toEqual(globs);
  });

  it.each([
    [
      'comments and blank lines anywhere, and other keys around it',
      '# head\nother:\n- x\nrisk:high: # why\n# note\n- changed-files:\n\n  - any-glob-to-any-file:\n    # group\n    - \'a/**\'  # trailing\n# column-0 comment\n    - "b.ts"\nnext:\n- y\n',
      ['a/**', 'b.ts'],
    ],
    ['a quote escaped by doubling it', rule("    - 'it''s/**'\n"), ["it's/**"]],
    ['CRLF line endings', rule("    - 'a/**'\n").replaceAll('\n', '\r\n'), ['a/**']],
    ['deeper indentation', "risk:high:\n  - changed-files:\n      - any-glob-to-any-file:\n          - 'a'\n", ['a']],
    ['a quoted key', "'risk:high':\n- changed-files:\n  - any-glob-to-any-file:\n    - 'a'\n", ['a']],
  ])('reads %s as a YAML parser does', (_name, yml, globs) => {
    expect(globsForRiskHigh(parse(yml) as Record<string, unknown>)).toEqual(globs);
    expect(jq('risk_high_globs', yml, true).value).toEqual(globs);
  });

  it.each([
    ['no risk:high key', "other:\n- changed-files:\n  - any-glob-to-any-file:\n    - 'a'\n"],
    ['risk:high twice', rule("    - 'a'\n") + rule("    - 'b'\n")],
    ['a value on the key line', 'risk:high: []\n'],
    [
      'two rules, which the labeler ANDs',
      `${rule("    - 'a'\n")}- changed-files:\n  - any-glob-to-any-file:\n    - 'b'\n`,
    ],
    ['another match option', "risk:high:\n- changed-files:\n  - all-globs-to-all-files:\n    - 'a'\n"],
    ['a second match option', `${rule("    - 'a'\n")}  - any-glob-to-all-files:\n    - 'b'\n`],
    ["a glob at its option's column, which makes it a sibling", rule("  - 'a'\n")],
    ['a flow list', "risk:high:\n- changed-files:\n  - any-glob-to-any-file: ['a', 'b']\n"],
    ['a bare string value', "risk:high:\n- changed-files:\n  - any-glob-to-any-file: 'a'\n"],
    ['a plain scalar', rule('    - a/**\n')],
    ['an escaped double-quoted scalar', rule('    - "a\\tb"\n')],
    ['an anchor', rule("    - &g 'a'\n")],
    ['a multi-line scalar', rule("    - 'a\n      b'\n")],
    ['a branch rule beside changed-files', `${rule("    - 'a'\n")}  head-branch: ['x']\n`],
    ['an any: wrapper', "risk:high:\n- any:\n  - changed-files:\n    - any-glob-to-any-file:\n      - 'a'\n"],
    ['items at two indentations', rule("    - 'a'\n      - 'b'\n")],
    ['no globs', rule('')],
  ])('refuses %s', (_name, yml) => {
    const result = jq('risk_high_globs', yml, true);
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('risk:high');
  });

  // Valid YAML the labeler reads, in a form this reader does not. codex-review.sh
  // still calls such a repo risk-scoped, so the refusal fails closed to review.
  it.each([
    ['an indented document', "  risk:high:\n  - changed-files:\n    - any-glob-to-any-file:\n      - 'a'\n"],
    ['an explicit key', "? risk:high\n: - changed-files:\n    - any-glob-to-any-file:\n      - 'a'\n"],
    ['a hex-escaped key', `"\\x72isk:high":\n- changed-files:\n  - any-glob-to-any-file:\n    - 'a'\n`],
    ['a unicode-escaped key', `"\\u0072isk:high":\n- changed-files:\n  - any-glob-to-any-file:\n    - 'a'\n`],
    [
      'a key across an escaped line break',
      `? "ri\\\n  sk:high"\n: - changed-files:\n    - any-glob-to-any-file:\n      - 'a'\n`,
    ],
  ])('refuses %s, which a YAML parser reads', (_name, yml) => {
    expect(globsForRiskHigh(parse(yml) as Record<string, unknown>)).toEqual(['a']);
    const result = jq('risk_high_globs', yml, true);
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('not the one top-level `risk:high:` key');
  });
});

describe('risk-scope.jq matches as actions/labeler v7 does', () => {
  it('agrees on every labeler.yml glob against every tracked path, plus dotted and deep ones', () => {
    // labeler-config.test.ts holds every risk:<dimension> glob to a subset of
    // risk:high, so these are all of labeler.yml's globs.
    const globs = globsForRiskHigh(parse(LABELER_YML) as Record<string, unknown>);
    const tracked = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(tracked.status).toBe(0);
    const paths = [
      ...new Set([
        ...tracked.stdout.split('\0').filter(Boolean),
        ...globs.flatMap(pathsShapedLike),
        '.github/.hidden',
        '.github/workflows/.x.yml',
        '.githubx/ci.yml',
        'x/.github/ci.yml',
        'src/.hidden/router-guard.ts',
        'src/.guard.ts',
        'src/guard',
        'container/agent-runner/src/.cache/deep/a-guard.ts',
        'src/db/migrations/.keep',
      ]),
    ];

    const answers = jqMatrix(globs, paths);
    const disagreements: string[] = [];
    let matched = 0;
    globs.forEach((glob, g) =>
      paths.forEach((file, p) => {
        const expected = labelerMatches(file, glob);
        if (expected) matched++;
        if (answers[g][p] !== expected)
          disagreements.push(`${glob} vs ${file}: jq ${answers[g][p]}, labeler ${expected}`);
      }),
    );
    expect(disagreements.slice(0, 20)).toEqual([]);
    // Both answers are not trivially all-false or all-true.
    expect(matched).toBeGreaterThan(globs.length);
    expect(matched).toBeLessThan((globs.length * paths.length) / 2);
  }, 60_000);

  it.each([
    ['src/**/*guard*.ts', 'src/.hidden/router-guard.ts', true],
    ['src/**/*guard*.ts', 'src/.guard.ts', true],
    ['src/**/*guard*.ts', 'src/guard.ts', true],
    ['src/**/*guard*.ts', 'x/src/guard.ts', false],
    ['.github/**', '.github/.hidden', true],
    ['.github/**', '.github/workflows/ci.yml', true],
    ['.github/**', '.github', false],
    ['src/guard/**', 'src/guard', false],
    ['src/router.ts', 'src/Router.ts', false],
    ['scripts/git-safety*.sh', 'scripts/git-safety.sh', true],
    ['scripts/git-safety*.sh', 'scripts/git-safety/x.sh', false],
  ])('answers %s against %s as minimatch {dot: true} does: %s', (glob, file, expected) => {
    expect(jqMatrix([glob], [file])).toEqual([[expected]]);
  });

  it('refuses `?`, which the labeler counts in UTF-16 code units and jq in code points', () => {
    // Under minimatch, `??` takes the two halves of one emoji.
    expect(path.matchesGlob('a/\u{1F600}', 'a/??')).toBe(true);
    const result = jq('glob_regex', 'a/??');
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('uses syntax codex-review.sh does not match');
  });

  it.each([
    'src/a?.ts',
    'src/{a,b}.ts',
    'src/[ab].ts',
    'src/+(a).ts',
    '!src/a.ts',
    '#src',
    'src\\a.ts',
    '/src/a.ts',
    'src/',
    'src//a.ts',
    'src/./a.ts',
    'src/../a.ts',
    '',
  ])('refuses glob %j rather than guess at it', (glob) => {
    const result = jq('glob_regex', glob);
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('risk:high');
  });
});
