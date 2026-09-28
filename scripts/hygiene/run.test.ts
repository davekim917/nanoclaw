import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../../src/test-hermeticity.js';
import { scaledTimeout } from '../../src/test-timeout-scale.js';
import { createHash } from 'node:crypto';

import {
  commentFindings,
  commentGrowth,
  commentGrowthFindings,
  duplicateTestFindings,
  exemptFiles,
  failsRun,
  growthBase,
  hygieneFindings,
  jscpdFindings,
  knipFindings,
  sourceFiles,
} from './run.js';

enforceHermeticity();
allowSubprocess(['knip', 'jscpd', 'git']);

const TOOL_TIMEOUT = scaledTimeout(30_000);

function project(name: string, files: Record<string, string>): string {
  const root = globalThis.uniqueTmpRoot(`hygiene-${name}`);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const summary = (findings: { kind: string; location: string; message: string }[]) =>
  findings.map((finding) => `${finding.kind} ${finding.location} ${finding.message}`);

describe('knip', () => {
  const knipProject = (files: Record<string, string>) =>
    project('knip', {
      'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module', dependencies: {} }),
      'knip.json': JSON.stringify({ entry: ['src/index.ts'], project: ['src/**/*.ts'] }),
      ...files,
    });

  it(
    'reports an unused export in a module that is not an entry',
    () => {
      const root = knipProject({
        'src/index.ts': "import { used } from './lib.js';\nused();\n",
        'src/lib.ts': 'export function used() {}\nexport function unused() {}\n',
      });
      expect(summary(knipFindings(root, '.'))).toEqual(['exports src/lib.ts:2 unused']);
    },
    TOOL_TIMEOUT,
  );

  it(
    'reports an unused dependency',
    () => {
      const root = knipProject({
        'package.json': JSON.stringify({ name: 'fixture', private: true, dependencies: { 'left-pad': '1.3.0' } }),
        'src/index.ts': 'export {};\n',
      });
      expect(summary(knipFindings(root, '.'))).toEqual(['dependencies package.json left-pad']);
    },
    TOOL_TIMEOUT,
  );

  it(
    'reports nothing for a worker target declared as an entry and a step module behind a dynamic import',
    () => {
      const root = knipProject({
        'knip.json': JSON.stringify({ entry: ['src/index.ts', 'src/worker-thread.ts'], project: ['src/**/*.ts'] }),
        'src/index.ts': [
          "import { Worker } from 'node:worker_threads';",
          "const url = new URL(import.meta.url.endsWith('.ts') ? './worker-thread.ts' : './worker-thread.js', import.meta.url);",
          'new Worker(url);',
          "const STEPS: Record<string, () => Promise<{ run: () => Promise<void> }>> = { alpha: () => import('./step.js') };",
          "await STEPS[process.argv[2] ?? 'alpha']!().then((step) => step.run());",
          '',
        ].join('\n'),
        'src/worker-thread.ts':
          "import { parentPort } from 'node:worker_threads';\nparentPort?.postMessage('ready');\n",
        'src/step.ts': 'export async function run() {}\n',
      });
      expect(knipFindings(root, '.')).toEqual([]);
    },
    TOOL_TIMEOUT,
  );

  it(
    'throws when knip cannot run, rather than reporting nothing',
    () => {
      const root = knipProject({ 'knip.json': '{ "entry": ', 'src/index.ts': 'export {};\n' });
      expect(() => knipFindings(root, '.')).toThrow(/^knip failed/);
    },
    TOOL_TIMEOUT,
  );

  it(
    'misses an export hidden by a suppression tag, which the comment scan reports instead',
    () => {
      const root = knipProject({
        'src/index.ts': "import { used } from './lib.js';\nused();\n",
        'src/lib.ts': 'export function used() {}\n/* eslint-disable -- @public */\nexport function hidden() {}\n',
      });
      expect(knipFindings(root, '.')).toEqual([]);
      expect(summary(commentFindings(root, ['src/lib.ts']))).toEqual([
        'inline-suppression src/lib.ts:2 /* eslint-disable -- @public */',
      ]);
    },
    TOOL_TIMEOUT,
  );
});

describe('jscpd', () => {
  const block = [
    'export function totals(rows: { id: string; size: number; tags: string[] }[]): Map<string, number> {',
    '  const totals = new Map<string, number>();',
    '  for (const row of rows) {',
    '    if (row.size <= 0 || row.tags.length === 0) continue;',
    "    const key = row.tags.includes('primary') ? `primary:${row.id}` : `other:${row.id}`;",
    '    const previous = totals.get(key) ?? 0;',
    '    totals.set(key, previous + row.size * row.tags.length);',
    '  }',
    '  for (const [key, value] of totals) {',
    '    if (value > 1000) totals.set(key, Math.round(value / 1000));',
    '  }',
    '  return totals;',
    '}',
    '',
  ].join('\n');

  const otherBlock = [
    'export async function drain(queue: AsyncIterable<Uint8Array>, limit: number): Promise<string> {',
    '  const chunks: Buffer[] = [];',
    '  let received = 0;',
    '  for await (const chunk of queue) {',
    '    received += chunk.byteLength;',
    '    if (received > limit) throw new RangeError(`input exceeds ${limit} bytes`);',
    '    chunks.push(Buffer.from(chunk));',
    '  }',
    "  const text = Buffer.concat(chunks).toString('utf8');",
    "  if (text.includes('\\uFFFD')) throw new TypeError('input is not valid UTF-8');",
    '  return text.trim();',
    '}',
    '',
  ].join('\n');

  const jscpdProject = (mirrors: { files: string[]; reason: string }[], files: Record<string, string>) =>
    project('jscpd', { '.jscpd.json': JSON.stringify({ minLines: 10, minTokens: 80, mirrors }), ...files });

  it(
    'reports a clone between two files',
    () => {
      const root = jscpdProject([], { 'src/a.ts': block, 'src/b.ts': `const pad = 1;\n${block}` });
      expect(summary(jscpdFindings(root, sourceFiles(root)))).toEqual(['clone src/a.ts:1 13 lines also at src/b.ts:2']);
    },
    TOOL_TIMEOUT,
  );

  it(
    'reports a clone within one file',
    () => {
      const root = jscpdProject([], { 'src/a.ts': `${block}\n${block}` });
      expect(jscpdFindings(root, sourceFiles(root)).map((finding) => finding.kind)).toEqual(['clone']);
    },
    TOOL_TIMEOUT,
  );

  it(
    'accepts a clone between the two files of a listed mirror, and only between them',
    () => {
      const mirror = { files: ['src/a.ts', 'container/agent-runner/src/a.ts'], reason: 'fixture' };
      const root = jscpdProject([mirror], {
        'src/a.ts': block,
        'container/agent-runner/src/a.ts': block,
        'src/c.ts': `${otherBlock}\n${block}`,
      });
      expect(summary(jscpdFindings(root, sourceFiles(root)))).toEqual([
        'clone container/agent-runner/src/a.ts:1 13 lines also at src/c.ts:14',
      ]);
    },
    TOOL_TIMEOUT,
  );

  it(
    'drops a clone between two exempt files and reports one with a single exempt side at the other side',
    () => {
      const root = jscpdProject([], {
        'src/a-upstream.ts': block,
        'src/b-ours.ts': `const pad = 1;\n${block}`,
        'src/c-upstream.ts': otherBlock,
        'src/d-vendored.ts': otherBlock,
      });
      const exempt = {
        upstream: new Set(['src/a-upstream.ts', 'src/c-upstream.ts']),
        vendored: new Set(['src/d-vendored.ts']),
      };
      expect(summary(jscpdFindings(root, sourceFiles(root), exempt))).toEqual([
        'clone src/b-ours.ts:2 13 lines also at src/a-upstream.ts:1',
      ]);
    },
    TOOL_TIMEOUT,
  );

  it(
    'reports a mirror entry that no longer matches any clone',
    () => {
      const root = jscpdProject([{ files: ['src/a.ts', 'src/gone.ts'], reason: 'fixture' }], {
        'src/a.ts': block,
      });
      expect(summary(jscpdFindings(root, sourceFiles(root)))).toEqual([
        'stale-mirror .jscpd.json no clone left between src/a.ts and src/gone.ts; remove the entry',
      ]);
    },
    TOOL_TIMEOUT,
  );
});

describe('exempt files', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const ENGINE = 'container/agent-runner/src/mcp-tools/design-review';

  it('exempts upstream files whose bytes still match a diff-0 entry, and the vendored engine but its wrapper', () => {
    const root = project('exempt', {
      'src/same.ts': 'export const same = 1;\n',
      'src/edited.ts': 'export const edited = 2;\n',
      'src/diverged.ts': 'export const diverged = 3;\n',
      [`${ENGINE}/index.ts`]: 'export {};\n',
      [`${ENGINE}/state.ts`]: 'export {};\n',
      'src/upstream-ratchet.json': JSON.stringify({
        upstream: 'a'.repeat(40),
        paths: 'b'.repeat(64),
        files: {
          'src/same.ts': { diff: 0, mode: '100644', sha256: sha('export const same = 1;\n') },
          'src/edited.ts': { diff: 0, mode: '100644', sha256: sha('export const edited = 1;\n') },
          'src/diverged.ts': { diff: 4, mode: '100644', sha256: sha('export const diverged = 3;\n') },
          'src/gone.ts': { diff: 7, mode: '100644', sha256: null, deleted: true },
        },
      }),
    });
    const exempt = exemptFiles(root);
    expect([...exempt.upstream]).toEqual(['src/same.ts']);
    expect([...exempt.vendored]).toEqual([`${ENGINE}/state.ts`]);
  });

  it(
    'reports no knip or comment finding in an exempt file, and still reports the same finding elsewhere',
    () => {
      const workspace = (dir: string) => ({
        [`${dir}package.json`]: JSON.stringify({ name: 'fixture', private: true, type: 'module', dependencies: {} }),
        [`${dir}knip.json`]: JSON.stringify({ entry: ['src/index.ts'], project: ['src/**/*.ts'] }),
        [`${dir}src/index.ts`]:
          "import { used } from './lib.js';\nimport { kept } from './upstream.js';\nused();\nkept();\n",
        [`${dir}src/lib.ts`]: 'export function used() {}\n// See #123.\nexport function unused() {}\n',
        [`${dir}src/upstream.ts`]: 'export function kept() {}\n// See #123.\nexport function unusedUpstream() {}\n',
      });
      const root = project('exempt-findings', {
        '.jscpd.json': JSON.stringify({ minLines: 10, minTokens: 80 }),
        ...workspace(''),
        ...workspace('container/agent-runner/'),
      });
      const exempt = {
        upstream: new Set(['src/upstream.ts']),
        vendored: new Set(['container/agent-runner/src/upstream.ts']),
      };
      const locations = hygieneFindings(root, exempt).map((finding) => `${finding.check} ${finding.location}`);
      expect(locations.filter((location) => location.includes('upstream.ts'))).toEqual([]);
      expect(locations).toEqual(
        expect.arrayContaining([
          'knip src/lib.ts:3',
          'comments src/lib.ts:2',
          'knip container/agent-runner/src/lib.ts:3',
          'comments container/agent-runner/src/lib.ts:2',
        ]),
      );
    },
    TOOL_TIMEOUT * 2,
  );
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

function write(root: string, files: Record<string, string | null>): void {
  for (const [file, text] of Object.entries(files)) {
    if (text === null) {
      fs.rmSync(path.join(root, file));
      continue;
    }
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}

/** A repository whose origin/main is `main`, with HEAD on a branch that commits `change` on top. */
function repo(main: Record<string, string>, change: Record<string, string | null>): string {
  const root = project('growth', {});
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'work');
  write(root, main);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'main');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  write(root, change);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'change');
  return root;
}

describe('comment growth', () => {
  const NO_EXEMPT = { upstream: new Set<string>(), vendored: new Set<string>() };

  const verdict = (root: string, exempt = NO_EXEMPT) => {
    const growth = commentGrowth(root, growthBase(root), exempt);
    return {
      net: growth.files.reduce((sum, file) => sum + file.head - file.base, 0),
      files: growth.files.map((file) => file.file),
      findings: summary(commentGrowthFindings(growth)),
    };
  };

  const code = 'export const a = 1;\n';

  it('fails a change that adds comment-only lines to a changed file', () => {
    const root = repo({ 'src/a.ts': code }, { 'src/a.ts': `// one\n/**\n * two\n */\n${code}` });
    const result = verdict(root);
    expect(result.net).toBe(4);
    expect(result.findings).toEqual([
      expect.stringMatching(
        /^net-growth since [0-9a-f]{12} \+4 comment-only line\(s\) on net in the changed files; delete narration in the files you touched, or keep only comments that name a hazard$/,
      ),
    ]);
  });

  it('passes a change that adds and removes the same number of comment lines across files', () => {
    const root = repo(
      { 'src/a.ts': code, 'setup/b.ts': `// old\n${code}` },
      { 'src/a.ts': `// new\n${code}`, 'setup/b.ts': code },
    );
    expect(verdict(root)).toEqual({ net: 0, files: ['setup/b.ts', 'src/a.ts'], findings: [] });
  });

  it('passes a change that deletes comments, counting a deleted file negative', () => {
    const root = repo(
      { 'src/a.ts': `// a\n// b\n${code}`, 'scripts/gone.ts': `// c\n${code}` },
      { 'src/a.ts': code, 'scripts/gone.ts': null },
    );
    expect(verdict(root)).toEqual({ net: -3, files: ['scripts/gone.ts', 'src/a.ts'], findings: [] });
  });

  it('counts a new file in full', () => {
    const root = repo({ 'src/a.ts': code }, { 'container/agent-runner/src/new.ts': `// fresh\n${code}` });
    expect(verdict(root).net).toBe(1);
    expect(verdict(root).findings).toHaveLength(1);
  });

  it('counts changed source outside the scanned roots', () => {
    const root = repo({ 'dashboard/src/main.tsx': code }, { 'dashboard/src/main.tsx': `// new\n${code}` });
    expect(verdict(root)).toMatchObject({ net: 1, files: ['dashboard/src/main.tsx'] });
  });

  it('counts a changed .jsx file', () => {
    const root = repo({ 'dashboard/src/view.jsx': code }, { 'dashboard/src/view.jsx': `// new\n${code}` });
    expect(verdict(root)).toMatchObject({ net: 1, files: ['dashboard/src/view.jsx'] });
  });

  it('ignores test files, fixtures, non-source files and exempt files', () => {
    const root = repo(
      { 'src/a.ts': code, 'src/upstream.ts': code },
      {
        'src/a.test.ts': `// test\n${code}`,
        'scripts/__fixtures__/f.ts': `// fixture\n${code}`,
        'dashboard/src/view.test.tsx': `// test\n${code}`,
        'docs/notes.md': `// doc\n`,
        'src/upstream.ts': `// upstream\n${code}`,
        'src/vendored.ts': `// vendored\n${code}`,
      },
    );
    const exempt = { upstream: new Set(['src/upstream.ts']), vendored: new Set(['src/vendored.ts']) };
    expect(verdict(root, exempt)).toEqual({ net: 0, files: [], findings: [] });
  });

  it('does not count comment markers inside a template literal', () => {
    const root = repo(
      { 'src/a.ts': code },
      { 'src/a.ts': `${code}export const t = \`\n// not a comment\n/* nor this */\n\`;\n` },
    );
    expect(verdict(root)).toEqual({ net: 0, files: ['src/a.ts'], findings: [] });
  });

  it('counts uncommitted and untracked source as changed', () => {
    const root = repo({ 'src/a.ts': code }, {});
    write(root, { 'src/a.ts': `// edited\n${code}`, 'src/untracked.ts': `// new\n${code}` });
    expect(verdict(root)).toMatchObject({ net: 2, files: ['src/a.ts', 'src/untracked.ts'] });
  });

  it('passes on origin/main itself, where the base is HEAD', () => {
    const root = repo({ 'src/a.ts': `// a\n${code}` }, {});
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(growthBase(root)).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(verdict(root)).toEqual({ net: 0, files: [], findings: [] });
  });

  it('fails closed when origin/main cannot be resolved', () => {
    const root = repo({ 'src/a.ts': code }, {});
    git(root, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect(() => growthBase(root)).toThrow(/^hygiene: cannot find the merge base of HEAD and origin\/main/);
  });
});

describe('duplicate tests', () => {
  const spec = (cases: string) => `import { expect, it } from 'vitest';\nimport { f } from './f.js';\n${cases}`;
  const keeper = "it('keeper', () => {\n  expect(f(1)).toBe(2);\n});\n";

  it('reports a new case that repeats one already on main, unless a commit trailer justifies it', () => {
    const root = repo(
      { 'src/f.test.ts': spec(keeper) },
      { 'src/f.test.ts': spec(`${keeper}it('copy', () => {\n  expect(f(1)).toBe(2);\n});\n`) },
    );
    const findings = duplicateTestFindings(root, growthBase(root));
    expect(summary(findings)).toEqual([
      expect.stringMatching(/^same-as src\/f\.test\.ts:6 "copy" runs the same statements as line 3 "keeper"; /),
    ]);
    expect(failsRun(findings)).toBe(false);
    expect(failsRun([...findings, { ...findings[0], check: 'comments' }])).toBe(true);
    git(root, 'commit', '-q', '--allow-empty', '-m', 'why\n\nDuplicate-test: src/f.test.ts | copy | pins a title');
    expect(duplicateTestFindings(root, growthBase(root))).toEqual([]);
  });

  it('accepts a trailer for a title that contains a pipe', () => {
    const root = repo(
      { 'src/f.test.ts': spec(keeper) },
      { 'src/f.test.ts': spec(`${keeper}it('a | b', () => {\n  expect(f(1)).toBe(2);\n});\n`) },
    );
    expect(duplicateTestFindings(root, growthBase(root))).toHaveLength(1);
    git(root, 'commit', '-q', '--allow-empty', '-m', 'why\n\nDuplicate-test: src/f.test.ts | a | b | pins a title');
    expect(duplicateTestFindings(root, growthBase(root))).toEqual([]);
  });

  it('survives a deleted test whose directory became a file', () => {
    const root = repo({ 'src/d/old.test.ts': spec(keeper) }, { 'src/d/old.test.ts': null });
    fs.rmdirSync(path.join(root, 'src/d'));
    write(root, { 'src/d': 'now a file\n' });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'dir to file');
    expect(duplicateTestFindings(root, growthBase(root))).toEqual([]);
  });

  it('survives a deleted test whose directory became a symlink loop', () => {
    const root = repo({ 'src/d/old.test.ts': spec(keeper) }, { 'src/d/old.test.ts': null });
    fs.rmSync(path.join(root, 'src/d'), { recursive: true, force: true });
    fs.symlinkSync('d', path.join(root, 'src/d'));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'dir to loop');
    expect(duplicateTestFindings(root, growthBase(root))).toEqual([]);
  });

  it('does not report a duplicate that a renamed file already held', () => {
    const pair = spec(`${keeper}it('copy', () => {\n  expect(f(1)).toBe(2);\n});\n`);
    const root = repo(
      { 'src/f.test.ts': pair },
      { 'src/f.test.ts': null, 'src/moved/f.test.ts': pair.replace("'./f.js'", "'../f.js'") },
    );
    expect(duplicateTestFindings(root, growthBase(root))).toEqual([]);
  });
});
