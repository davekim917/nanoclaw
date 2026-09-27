import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

import { checkLineCitation, citationRuns, gitRead } from './lib/doc-citations.js';

allowSubprocess(['git']);
enforceHermeticity();

/**
 * Every `path:line` citation in the repo's markdown (skills, docs, top-level guides) must still land inside its file:
 * at HEAD, or at the commit named by a trailing `at <sha>`. docs/review-notes has its own check
 * (review-notes.test.ts). The docs below are frozen records of past work whose citations described the code of their
 * day; they are not maintained against HEAD.
 */
const EXCLUDED_DOC_PREFIXES = ['docs/specs/', 'docs/retros/', 'docs/review-notes', 'CHANGELOG.md', 'PROGRESS.md'];

/** `<doc> <citation>` pairs that illustrate a format and name no file in this repo. */
const ILLUSTRATIVE_CITATIONS = new Set([
  '.claude/skills/qodo-pr-resolver/SKILL.md src/auth/service.py:42',
  '.claude/skills/qodo-pr-resolver/SKILL.md src/api/handlers.py:156',
  '.claude/skills/qodo-pr-resolver/SKILL.md src/db/repository.py:89',
]);

const REPO_ROOT = path.join(__dirname, '..');

function trackedFiles(root: string): string[] {
  return (gitRead(root, ['ls-files', '-z']) ?? '').split('\0').filter(Boolean);
}

type Resolution = { file: string } | { missing: true } | { skip: true };

function resolveCitedPath(cited: string, doc: string, tracked: ReadonlySet<string>, topDirs: ReadonlySet<string>) {
  if (tracked.has(cited)) return { file: cited } satisfies Resolution;
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(doc), cited));
  if (tracked.has(relative)) return { file: relative } satisfies Resolution;
  const bySuffix = [...tracked].filter((file) => file.endsWith(`/${cited}`));
  if (bySuffix.length === 1) return { file: bySuffix[0] } satisfies Resolution;
  if (bySuffix.length === 0 && cited.includes('/') && topDirs.has(cited.split('/')[0]))
    return { missing: true } satisfies Resolution;
  return { skip: true } satisfies Resolution;
}

function docCitationProblems(root: string, docs?: readonly string[]): string[] {
  const all = trackedFiles(root);
  const tracked = new Set(all);
  const topDirs = new Set(all.filter((file) => file.includes('/')).map((file) => file.split('/')[0]));
  const inScope =
    docs ??
    all.filter((file) => file.endsWith('.md') && !EXCLUDED_DOC_PREFIXES.some((prefix) => file.startsWith(prefix)));
  const problems: string[] = [];
  for (const doc of inScope) {
    const lines = fs.readFileSync(path.join(root, doc), 'utf8').split('\n');
    lines.forEach((text, index) => {
      for (const run of citationRuns(text))
        for (const link of run.links) {
          const cited = `${link.file}:${link.span}`;
          if (ILLUSTRATIVE_CITATIONS.has(`${doc} ${cited}`)) continue;
          const resolved = resolveCitedPath(link.file, doc, tracked, topDirs);
          if ('skip' in resolved) continue;
          const where = `${doc}:${index + 1}`;
          if ('missing' in resolved) {
            problems.push(`${where}: cites \`${cited}\`, but no tracked file has that path`);
            continue;
          }
          const check = checkLineCitation(root, { ...link, file: resolved.file }, `\`${cited}\``);
          if (check.ok === 'skipped') console.warn(`doc-citations: skipping ${check.reason}; not checked`);
          else if (!check.ok) problems.push(`${where}: ${check.problem}`);
        }
    });
  }
  return problems;
}

describe('line citations in skills and docs', () => {
  it('land inside the cited file at HEAD, or at their pinned commit', () => {
    expect(docCitationProblems(REPO_ROOT)).toEqual([]);
  });
});

describe('docCitationProblems', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function repo(files: Record<string, string>): { root: string; sha: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-citations-'));
    roots.push(root);
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-q', '-m', 'fixture', '--no-gpg-sign'], { cwd: root });
    return { root, sha: (gitRead(root, ['rev-parse', '--short=9', 'HEAD']) ?? '').trim() };
  }

  it('fails a citation past the end of its file, a continuation included', () => {
    const { root } = repo({ 'src/a.ts': 'one\ntwo\n', 'docs/guide.md': 'see `src/a.ts:2`, `:5`\n' });
    expect(docCitationProblems(root, ['docs/guide.md'])).toEqual([
      'docs/guide.md:1: cites `src/a.ts:5`, but src/a.ts has only 2 lines',
    ]);
  });

  it('checks a pinned citation at its commit, not at HEAD', () => {
    const { root, sha } = repo({ 'src/a.ts': 'one\ntwo\nthree\n' });
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'one\n');
    fs.writeFileSync(path.join(root, 'guide.md'), `\`src/a.ts:3\` at ${sha} and \`src/a.ts:3\`\n`);
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-q', '-m', 'shrink', '--no-gpg-sign'], { cwd: root });
    expect(docCitationProblems(root, ['guide.md'])).toEqual([
      'guide.md:1: cites `src/a.ts:3`, but src/a.ts has only 1 lines',
    ]);
  });

  it('resolves a path relative to the doc, and a bare file name that one tracked file ends with', () => {
    const { root } = repo({
      'skills/x/scripts/run.sh': 'a\n',
      'skills/x/SKILL.md': '`scripts/run.sh:1` and `run.sh:4`\n',
    });
    expect(docCitationProblems(root, ['skills/x/SKILL.md'])).toEqual([
      'skills/x/SKILL.md:1: cites `run.sh:4`, but skills/x/scripts/run.sh has only 1 lines',
    ]);
  });

  it('fails a repo-shaped path that no longer exists, and skips hosts, ratios and other repos', () => {
    const { root } = repo({
      'src/a.ts': 'a\n',
      'doc.md': '`src/gone.ts:3`; http://127.0.0.1:8080; 4.5:1 contrast; `pkg/cmd/list.go:9`\n',
    });
    expect(docCitationProblems(root, ['doc.md'])).toEqual([
      'doc.md:1: cites `src/gone.ts:3`, but no tracked file has that path',
    ]);
  });
});
