import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';
import { scaledTimeout } from '../src/test-timeout-scale.js';

import { checkLineCitation, citationRuns, gitRead } from './lib/doc-citations.js';

allowSubprocess(['git']);
enforceHermeticity();

/**
 * Every `path:line` citation in the repo's markdown (skills, docs, top-level guides) must still land inside its file:
 * at HEAD, or at the commit named by a trailing `at <sha>`. docs/review-notes has its own check
 * (review-notes.test.ts). The docs below are frozen records of past work whose citations described the code of their
 * day; they are not maintained against HEAD. A citation names a path with an extension or a directory
 * (`container/Dockerfile:3`); a bare extensionless `Dockerfile:3` is not read as one.
 */
const EXCLUDED_DOC_PREFIXES = ['docs/specs/', 'docs/retros/', 'docs/review-notes', 'CHANGELOG.md', 'PROGRESS.md'];

/** `<doc> <citation>` pairs that illustrate a format, or name a file in another repository. */
const ILLUSTRATIVE_CITATIONS = new Set([
  '.claude/skills/qodo-pr-resolver/SKILL.md src/auth/service.py:42',
  '.claude/skills/qodo-pr-resolver/SKILL.md src/api/handlers.py:156',
  '.claude/skills/qodo-pr-resolver/SKILL.md src/db/repository.py:89',
]);

const REPO_ROOT = path.join(__dirname, '..');

function trackedFiles(root: string): string[] {
  return (gitRead(root, ['ls-files', '-z']) ?? '').split('\0').filter(Boolean);
}

type Resolution = { file: string } | { missing: true } | { ambiguous: number } | { skip: true };

function resolveCitedPath(cited: string, doc: string, tracked: ReadonlySet<string>, deletedNames: ReadonlySet<string>) {
  if (tracked.has(cited)) return { file: cited } satisfies Resolution;
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(doc), cited));
  if (tracked.has(relative)) return { file: relative } satisfies Resolution;
  const shaped = cited.startsWith('.') ? relative : cited;
  if (cited.startsWith('./') || cited.startsWith('../') || /^\.?[A-Za-z_][\w-]*\//.test(shaped))
    return { missing: true } satisfies Resolution;
  if (cited.includes('/')) return { skip: true } satisfies Resolution;
  const byName = [...tracked].filter((file) => file.endsWith(`/${cited}`));
  if (byName.length === 1) return { file: byName[0] } satisfies Resolution;
  if (byName.length > 1) return { ambiguous: byName.length } satisfies Resolution;
  if (deletedNames.has(cited)) return { missing: true } satisfies Resolution;
  return { skip: true } satisfies Resolution;
}

function docCitationProblems(root: string, docs?: readonly string[]): string[] {
  const all = trackedFiles(root);
  const deletedNames = new Set(
    (gitRead(root, ['log', '--format=', '--name-only', '--no-renames', '--diff-filter=D']) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((file) => path.posix.basename(file)),
  );
  const tracked = new Set(all);
  const treeCache = new Map<string, Set<string>>();
  const filesAt = (sha: string | null): Set<string> => {
    if (!sha) return tracked;
    if (!treeCache.has(sha)) {
      const listing = gitRead(root, ['ls-tree', '-r', '-z', '--name-only', sha]);
      treeCache.set(sha, listing === null ? tracked : new Set(listing.split('\0').filter(Boolean)));
    }
    return treeCache.get(sha)!;
  };
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
          const resolved = resolveCitedPath(link.file, doc, filesAt(link.pinnedSha), deletedNames);
          if ('skip' in resolved) continue;
          const where = `${doc}:${index + 1}`;
          if ('ambiguous' in resolved) {
            problems.push(`${where}: cites \`${cited}\` by bare name, which ${resolved.ambiguous} tracked files have`);
            continue;
          }
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
  it(
    'land inside the cited file at HEAD, or at their pinned commit',
    () => {
      expect(docCitationProblems(REPO_ROOT)).toEqual([]);
    },
    scaledTimeout(30_000),
  );
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

  it('checks a path with no file extension', () => {
    const { root } = repo({
      'container/Dockerfile': 'FROM x\n',
      'doc.md': '`container/Dockerfile:1`, `container/Dockerfile:99`\n',
    });
    expect(docCitationProblems(root, ['doc.md'])).toEqual([
      'doc.md:1: cites `container/Dockerfile:99`, but container/Dockerfile has only 1 lines',
    ]);
  });

  it('fails a line zero and a range that runs backwards', () => {
    const { root } = repo({ 'src/a.ts': 'one\ntwo\n', 'doc.md': '`src/a.ts:0` and `src/a.ts:9-2`\n' });
    expect(docCitationProblems(root, ['doc.md'])).toEqual([
      'doc.md:1: cites `src/a.ts:0`, which is not a line range (lines start at 1 and run forward)',
      'doc.md:1: cites `src/a.ts:9-2`, which is not a line range (lines start at 1 and run forward)',
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

  it('resolves a pinned citation against its commit, so a file deleted since still passes', () => {
    const { root, sha } = repo({ 'src/old.ts': 'one\ntwo\n', 'src/keep.ts': 'a\n' });
    fs.rmSync(path.join(root, 'src/old.ts'));
    fs.writeFileSync(path.join(root, 'guide.md'), `\`src/old.ts:2\` at ${sha}; \`src/old.ts:5\` at ${sha}\n`);
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-q', '-m', 'delete', '--no-gpg-sign'], { cwd: root });
    expect(docCitationProblems(root, ['guide.md'])).toEqual([
      `guide.md:1: cites \`src/old.ts:5\` at ${sha}, but src/old.ts has only 2 lines at ${sha}`,
    ]);
  });

  it('resolves a path relative to the doc, and a bare file name that exactly one tracked file has', () => {
    const { root } = repo({
      'skills/x/scripts/run.sh': 'a\n',
      'skills/x/SKILL.md': '`scripts/run.sh:1` and `run.sh:4`\n',
    });
    expect(docCitationProblems(root, ['skills/x/SKILL.md'])).toEqual([
      'skills/x/SKILL.md:1: cites `run.sh:4`, but skills/x/scripts/run.sh has only 1 lines',
    ]);
  });

  it('fails a repo-shaped path that no longer exists, and skips hosts and ratios', () => {
    const { root } = repo({
      'src/a.ts': 'a\n',
      'doc.md': '`src/gone.ts:3`; http://127.0.0.1:8080; 4.5:1 contrast; `old/code.ts:1`\n',
    });
    expect(docCitationProblems(root, ['doc.md'])).toEqual([
      'doc.md:1: cites `src/gone.ts:3`, but no tracked file has that path',
      'doc.md:1: cites `old/code.ts:1`, but no tracked file has that path',
    ]);
  });

  it('fails a deleted repo path instead of resolving it to another file with the same suffix', () => {
    const { root } = repo({ 'src/keep.ts': 'a\n', 'container/src/code.ts': 'a\n', 'guide.md': '`src/code.ts:1`\n' });
    expect(docCitationProblems(root, ['guide.md'])).toEqual([
      'guide.md:1: cites `src/code.ts:1`, but no tracked file has that path',
    ]);
  });

  it('fails a partial path instead of matching it against the end of another path', () => {
    const { root } = repo({ 'container/old/code.ts': 'a\n', 'guide.md': '`old/code.ts:1`\n' });
    expect(docCitationProblems(root, ['guide.md'])).toEqual([
      'guide.md:1: cites `old/code.ts:1`, but no tracked file has that path',
    ]);
  });

  it('fails a bare file name that no tracked file has any more, or that several have, and skips hosts', () => {
    const { root } = repo({ 'a/x.ts': 'a\n', 'b/x.ts': 'b\n', 'settings.ini': 'enabled=true\n' });
    fs.rmSync(path.join(root, 'settings.ini'));
    fs.writeFileSync(path.join(root, 'doc.md'), '`settings.ini:1`, `x.ts:1` and `api.example.com:443`\n');
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-q', '-m', 'delete', '--no-gpg-sign'], { cwd: root });
    expect(docCitationProblems(root, ['doc.md'])).toEqual([
      'doc.md:1: cites `settings.ini:1`, but no tracked file has that path',
      'doc.md:1: cites `x.ts:1` by bare name, which 2 tracked files have',
    ]);
  });

  it('fails a bare file name whose file was renamed away', () => {
    const { root } = repo({ 'settings.ini': 'enabled=true\n', 'guide.md': '`settings.ini:1`\n' });
    spawnSync('git', ['mv', 'settings.ini', 'config.ini'], { cwd: root });
    spawnSync('git', ['commit', '-q', '-m', 'rename', '--no-gpg-sign'], { cwd: root });
    expect(docCitationProblems(root, ['guide.md'])).toEqual([
      'guide.md:1: cites `settings.ini:1`, but no tracked file has that path',
    ]);
  });

  it('fails an explicit relative path to a deleted root file', () => {
    const { root } = repo({ 'keep.ts': 'a\n', 'guide.md': '`./gone.ts:1`\n', 'docs/guide.md': '`../gone.ts:1`\n' });
    expect(docCitationProblems(root, ['guide.md', 'docs/guide.md'])).toEqual([
      'guide.md:1: cites `./gone.ts:1`, but no tracked file has that path',
      'docs/guide.md:1: cites `../gone.ts:1`, but no tracked file has that path',
    ]);
  });

  it('fails a doc-relative path to a file that no longer exists', () => {
    const { root } = repo({ 'src/a.ts': 'a\n', 'docs/guide.md': '`../src/gone.ts:3` and `../src/a.ts:1`\n' });
    expect(docCitationProblems(root, ['docs/guide.md'])).toEqual([
      'docs/guide.md:1: cites `../src/gone.ts:3`, but no tracked file has that path',
    ]);
  });
});
