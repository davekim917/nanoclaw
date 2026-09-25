import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// @ts-expect-error -- plain ESM with no type declarations; it runs under node or bun with nothing installed
import { analyze, classify } from '../container/skills/pr-review-loop/scripts/test-weakening.mjs';

interface Finding {
  file: string;
  case: string;
  kind: string;
  change: string;
}

interface Result {
  verdict: 'clean' | 'review' | 'refuse';
  summary: string;
  findings: Finding[];
  refusals: Finding[];
}

type Tree = Record<string, string>;

/** The detector's answer for `before` becoming `after`: a path in both is modified, in one only added or removed. */
function judge(before: Tree, after: Tree): Promise<Result> {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  const files = [...paths].map((filename) => ({
    filename,
    status: !(filename in before) ? 'added' : !(filename in after) ? 'removed' : 'modified',
  }));
  return analyze({
    ts,
    files,
    read: async (side: 'base' | 'head', file: string) => (side === 'base' ? before : after)[file] ?? null,
  }) as Promise<Result>;
}

const kinds = (result: Result) => result.findings.map((f) => f.kind);

const SUITE = `import { describe, expect, it } from 'vitest';

describe('adder', () => {
  it('adds', () => {
    const expected = 3;
    expect(add(1, 2)).toBe(expected);
    expect(add(2, 2)).toEqual(4);
  });

  it.each([
    [1, 2],
    [3, 4],
  ])('orders %s before %s', (a, b) => {
    expect(a).toBeLessThan(b);
  });

  it('subtracts', () => {
    expect(sub(3, 1)).toBe(2);
  });
});
`;
const WITHOUT_SUBTRACTS = SUITE.replace(/\n {2}it\('subtracts'[\s\S]*?\n {2}\}\);\n/, '\n');

describe('test-weakening detector', () => {
  it('is clean when only formatting, quotes, comments and case order change', async () => {
    const reformatted = `import { describe, expect, it } from "vitest";

describe("adder", () => {
  // subtraction first now
  it("subtracts", () => { expect(sub(3, 1)).toBe(2) });
  it("adds", () => {
    const expected = 3;
    expect(
      add(1, 2),
    ).toBe(expected);
    expect(add(2, 2)).toEqual(4);
  });
  it.each([[1, 2], [3, 4]])("orders %s before %s", (a, b) => { expect(a).toBeLessThan(b); });
});
`;
    const result = await judge({ 'src/a.test.ts': SUITE }, { 'src/a.test.ts': reformatted });
    expect(result).toMatchObject({ verdict: 'clean', findings: [], refusals: [] });
  });

  it('is clean when a case moves unchanged into a new file, and when cases and assertions are only added', async () => {
    const moved = `describe('elsewhere', () => {\n  it('subtracts', () => { expect(sub(3, 1)).toBe(2); });\n});\n`;
    const grown = WITHOUT_SUBTRACTS.replace(
      'expect(add(2, 2)).toEqual(4);',
      'expect(add(2, 2)).toEqual(4);\n    expect(add(0, 0)).toBe(0);',
    );
    const result = await judge({ 'src/a.test.ts': SUITE }, { 'src/a.test.ts': grown, 'src/b.test.ts': moved });
    expect(result.verdict).toBe('clean');
  });

  it('names a removed case', async () => {
    const result = await judge({ 'src/a.test.ts': SUITE }, { 'src/a.test.ts': WITHOUT_SUBTRACTS });
    expect(result.verdict).toBe('review');
    expect(result.findings).toEqual([
      expect.objectContaining({ file: 'src/a.test.ts', case: 'adder › subtracts', kind: 'case-removed' }),
    ]);
  });

  it('names every case of a deleted test file', async () => {
    const result = await judge({ 'src/a.test.ts': SUITE }, {});
    expect(kinds(result)).toEqual(['case-removed', 'case-removed', 'case-removed']);
    expect(result.findings[0]!.change).toBe('case removed with its file');
  });

  it.each([
    ['a matcher', 'expect(add(2, 2)).toEqual(4);', 'expect(add(2, 2)).toBeDefined();'],
    ['a matcher argument', 'expect(add(2, 2)).toEqual(4);', 'expect(add(2, 2)).toEqual(expect.any(Number));'],
    ['a removed assertion', 'expect(add(2, 2)).toEqual(4);', ''],
  ])('flags %s as a changed assertion', async (_name, from, to) => {
    const result = await judge({ 'src/a.test.ts': SUITE }, { 'src/a.test.ts': SUITE.replace(from, to) });
    expect(result.findings).toEqual([expect.objectContaining({ case: 'adder › adds', kind: 'assertion-changed' })]);
    expect(result.summary).toContain('src/a.test.ts › adder › adds: 1 assertion removed or changed');
  });

  it('flags a changed case-local expected value as changed setup', async () => {
    const result = await judge(
      { 'src/a.test.ts': SUITE },
      { 'src/a.test.ts': SUITE.replace('const expected = 3;', 'const expected = add(1, 2);') },
    );
    expect(result.findings).toEqual([expect.objectContaining({ case: 'adder › adds', kind: 'setup-changed' })]);
  });

  it('flags the value under test replaced by a constant, with its assertion untouched', async () => {
    const before = `it('computes', () => {\n  const actual = subject();\n  expect(actual).toBe(1);\n});\n`;
    const result = await judge({ 'src/c.test.ts': before }, { 'src/c.test.ts': before.replace('subject()', '1') });
    expect(result.findings).toEqual([expect.objectContaining({ case: 'computes', kind: 'setup-changed' })]);
  });

  it('flags a changed in-case mock with its assertion untouched, and ignores an added setup line', async () => {
    const before = `it('reads', () => {\n  vi.mocked(load).mockReturnValue(null);\n  expect(read()).toBeNull();\n});\n`;
    const changed = before.replace('mockReturnValue(null)', 'mockReturnValue(undefined)');
    const grown = before.replace('  expect(', '  const unused = 1;\n  expect(');
    const flagged = await judge({ 'src/r.test.ts': before }, { 'src/r.test.ts': changed });
    expect(flagged.findings).toEqual([
      expect.objectContaining({
        case: 'reads',
        kind: 'setup-changed',
        change: '1 setup statement changed or removed, e.g. vi.mocked(load).mockReturnValue(null);',
      }),
    ]);
    expect((await judge({ 'src/r.test.ts': before }, { 'src/r.test.ts': grown })).verdict).toBe('clean');
  });

  it('flags a changed multiline matcher argument', async () => {
    const before = `it('shapes', () => {\n  expect(shape()).toEqual({\n    a: 1,\n    b: 2,\n  });\n});\n`;
    const after = `it('shapes', () => {\n  expect(shape()).toEqual({\n    a: 1,\n  });\n});\n`;
    const result = await judge({ 'src/s.test.ts': before }, { 'src/s.test.ts': after });
    expect(kinds(result)).toEqual(['assertion-changed']);
  });

  it('flags a removed .each row', async () => {
    const result = await judge({ 'src/a.test.ts': SUITE }, { 'src/a.test.ts': SUITE.replace('    [3, 4],\n', '') });
    expect(result.findings).toEqual([
      expect.objectContaining({ case: 'adder › orders %s before %s', kind: 'row-removed' }),
    ]);
    expect(result.findings[0]!.change).toContain('[3, 4]');
  });

  it('flags a removed row of a template .each table', async () => {
    const table = (rows: string) =>
      `it.each\`\n  a | b\n${rows}\`('$a < $b', ({ a, b }) => { expect(a).toBeLessThan(b); });\n`;
    const result = await judge(
      { 'src/t.test.ts': table('  ${1} | ${2}\n  ${3} | ${4}\n') },
      { 'src/t.test.ts': table('  ${1} | ${2}\n') },
    );
    expect(kinds(result)).toEqual(['row-removed']);
  });

  it.each([
    ["it('subtracts'", "it.skip('subtracts'", '.skip'],
    ["it('subtracts'", "it.fails('subtracts'", '.fails'],
    ["it('subtracts'", "it.skipIf(process.env.CI)('subtracts'", '.skipIf'],
    ["describe('adder'", "describe.skip('adder'", '.skip'],
  ])('flags an added modifier: %s -> %s', async (from, to, mod) => {
    const result = await judge({ 'src/a.test.ts': SUITE }, { 'src/a.test.ts': SUITE.replace(from, to) });
    expect(result.verdict).toBe('review');
    expect(result.findings.some((f) => f.kind === 'modifier-added' && f.change.includes(mod))).toBe(true);
  });

  it('flags a case turned into a .todo', async () => {
    const result = await judge(
      { 'src/a.test.ts': SUITE },
      { 'src/a.test.ts': SUITE.replace(/it\('subtracts'[\s\S]*?\n {2}\}\);/, "it.todo('subtracts');") },
    );
    expect(result.findings).toEqual([
      expect.objectContaining({ case: 'adder › subtracts', kind: 'modifier-added', change: 'now .todo' }),
      expect.objectContaining({ case: 'adder › subtracts', kind: 'assertion-changed' }),
    ]);
  });

  it('refuses a .only in a touched test file, new or existing', async () => {
    const result = await judge(
      { 'src/a.test.ts': SUITE },
      { 'src/a.test.ts': SUITE.replace("it('adds'", "it.only('adds'"), 'src/n.test.ts': "test.only('x', () => {});\n" },
    );
    expect(result.verdict).toBe('refuse');
    expect(result.refusals.map((f) => `${f.file} › ${f.case}`)).toEqual([
      'src/a.test.ts › adder › adds',
      'src/n.test.ts › x',
    ]);
    expect(result.summary).toContain('.only runs this case alone and skips the rest');
  });

  it('flags a changed in-file helper or hook, and ignores added ones and import changes', async () => {
    const withHelpers = `import { a } from './a';\nconst fixture = { n: 1 };\nbeforeEach(() => reset());\n${SUITE}`;
    const changed = withHelpers.replace('{ n: 1 }', '{ n: 2 }');
    const grown = withHelpers
      .replace("import { a } from './a';", "import { a, b } from './a';\nconst { c } = await import('./c');")
      .replace('beforeEach', 'function extra() {}\nbeforeEach');
    const flagged = await judge({ 'src/a.test.ts': withHelpers }, { 'src/a.test.ts': changed });
    expect(flagged.findings).toEqual([expect.objectContaining({ case: 'fixture', kind: 'support-changed' })]);
    expect((await judge({ 'src/a.test.ts': withHelpers }, { 'src/a.test.ts': grown })).verdict).toBe('clean');
  });

  it('flags a changed wrapper around a test, with the test inside it unchanged', async () => {
    const wrapped = (cond: string) => `if (${cond}) {\n  it('runs', () => { expect(run()).toBe(1); });\n}\n`;
    const result = await judge({ 'src/w.test.ts': wrapped('RUN_IN_CI') }, { 'src/w.test.ts': wrapped('false') });
    expect(result.findings).toEqual([expect.objectContaining({ kind: 'support-changed' })]);
  });

  it('flags an import whose name now binds another module or export, and a removed side-effect import', async () => {
    const before = `import './setup';\nimport { subject } from './real.js';\nit('works', () => { expect(subject()).toBe(1); });\n`;
    const result = await judge(
      { 'src/i.test.ts': before },
      { 'src/i.test.ts': before.replace("import './setup';\n", '').replace('./real.js', './stub.js') },
    );
    expect(result.findings).toEqual([
      expect.objectContaining({ case: 'import subject', change: 'now ./stub.js › subject, was ./real.js › subject' }),
      expect.objectContaining({ case: "import './setup'", change: 'side-effect import removed' }),
    ]);
  });

  it('flags a hook removed from one suite though an identical hook stays in another', async () => {
    const suite = (name: string, hook: string) =>
      `describe('${name}', () => {\n  ${hook}\n  it('x', () => { expect(x()).toBe(1); });\n});\n`;
    const hook = 'beforeEach(() => reset());';
    const result = await judge(
      { 'src/d.test.ts': suite('a', hook) + suite('b', hook) },
      { 'src/d.test.ts': suite('a', hook) + suite('b', '') },
    );
    expect(result.findings).toEqual([expect.objectContaining({ case: 'b › beforeEach', kind: 'support-changed' })]);
  });

  it('flags a changed statement in a shared helper file, and a changed fixture line', async () => {
    const helper = "export const WAIT_MS = 500;\nexport function makeDb() { return open(':memory:'); }\n";
    const result = await judge(
      { 'src/test-fixtures/db.ts': helper, 'tests/fixtures/rows.json': '{\n  "a": 1,\n  "b": 2\n}\n' },
      {
        'src/test-fixtures/db.ts': helper.replace('500', '5000'),
        'tests/fixtures/rows.json': '{\n  "a": 1,\n  "b": 3\n}\n',
      },
    );
    expect(result.findings).toEqual([
      expect.objectContaining({ file: 'tests/fixtures/rows.json', kind: 'support-changed' }),
      expect.objectContaining({ file: 'src/test-fixtures/db.ts', case: 'WAIT_MS', kind: 'support-changed' }),
    ]);
  });

  it('flags a changed test config', async () => {
    const config = "export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });\n";
    const result = await judge(
      { 'vitest.config.ts': config },
      { 'vitest.config.ts': config.replace("'src/**/*.test.ts'", "'src/a.test.ts'") },
    );
    expect(kinds(result)).toEqual(['support-changed']);
  });

  it('requires review for a changed test in a language it cannot parse, but not for a pure rename', async () => {
    const changed = await judge({ 'scripts/x.test.sh': 'a\n' }, { 'scripts/x.test.sh': 'b\n' });
    expect(changed.findings).toEqual([expect.objectContaining({ kind: 'unknown', file: 'scripts/x.test.sh' })]);
    const renamed = await analyze({
      ts,
      files: [{ filename: 'scripts/y_test.py', previous_filename: 'scripts/x_test.py', status: 'renamed', changes: 0 }],
      read: async () => null,
    });
    expect(renamed.verdict).toBe('clean');
  });

  it('requires review, never a pass, when a file cannot be parsed or read, or typescript is missing', async () => {
    const broken = await judge({ 'src/a.test.ts': SUITE }, { 'src/a.test.ts': `${SUITE}\nit('x', () => {` });
    expect(broken.findings).toEqual([expect.objectContaining({ kind: 'incomplete', file: 'src/a.test.ts' })]);
    expect(broken.findings[0]!.change).toContain('parse error');

    const unreadable = await analyze({
      ts,
      files: [{ filename: 'src/a.test.ts', status: 'modified' }],
      read: async () => {
        throw new Error('HTTP 502');
      },
    });
    expect(unreadable.verdict).toBe('review');
    expect(unreadable.findings[0]!.change).toContain('HTTP 502');

    const noParser = await analyze({
      ts: null,
      files: [{ filename: 'src/a.test.ts', status: 'modified' }],
      read: async () => SUITE,
    });
    expect(noParser.verdict).toBe('review');
    expect(noParser.findings[0]!.kind).toBe('incomplete');
  });

  it('ignores files that are neither tests nor test support', async () => {
    const result = await judge(
      { 'src/router.ts': 'export const a = 1;\n' },
      { 'src/router.ts': 'export const a = 2;\n' },
    );
    expect(result.verdict).toBe('clean');
  });

  it.each([
    ['src/a.test.ts', 'ast-test'],
    ['container/agent-runner/src/b.spec.tsx', 'ast-test'],
    ['scripts/c.test.mjs', 'ast-test'],
    ['container/x.test.sh', 'other-test'],
    ['skills/y.test.py', 'other-test'],
    ['src/test-fixtures/claim-harness.ts', 'ast-support'],
    ['src/test-setup.ts', 'ast-support'],
    ['src/db/testing/driver-conformance.ts', 'ast-support'],
    ['container/agent-runner/src/modules/mailbox/testing.ts', 'ast-support'],
    ['vitest.skills.config.ts', 'ast-support'],
    ['tests/fixtures/vectors.json', 'data-support'],
    ['src/__snapshots__/a.test.ts.snap', 'data-support'],
    ['container/agent-runner/bunfig.toml', 'data-support'],
    ['src/router.ts', null],
    ['src/mocked-transport.ts', null],
  ])('classifies %s as %s', (file, expected) => {
    expect(classify(file)).toBe(expected);
  });
});
