import { describe, expect, it } from 'vitest';

import { addedCases, extractCases, findDuplicateTests } from './duplicate-tests.js';

const FILE = 'src/f.test.ts';
const header = "import { expect, it, describe, beforeEach } from 'vitest';\nimport { f, g } from './f.js';\n";

function duplicates(base: string, head: string): string[] {
  const headCases = extractCases(FILE, header + head);
  const added = addedCases(extractCases(FILE, header + base), headCases);
  return findDuplicateTests(added, headCases).map((d) => `${d.kind} ${d.test.name} <- ${d.keeper.name}`);
}

const keeper = `
it('keeper', () => {
  const out = f(1);
  expect(out).toBe(2);
});
`;

describe('duplicate test detection', () => {
  it('flags a new case that runs the same statements under other names, comments and formatting', () => {
    const copy = `
it("copy", () => {
  // same call, same input, same expectation
  const result = f(1)
  expect(result).toBe(2)
});
`;
    expect(duplicates(keeper, keeper + copy)).toEqual(['same-as copy <- keeper']);
  });

  it('flags a new case that only repeats the first statements of a case that asserts more, not the reverse', () => {
    const wider = `
it('wider', () => {
  const out = f(1);
  expect(out).toBe(2);
  expect(g(out)).toBe(3);
});
`;
    expect(duplicates(wider, wider + keeper)).toEqual(['subsumed-by keeper <- wider']);
    expect(duplicates(keeper, keeper + wider)).toEqual([]);
  });

  it('reports only cases the change adds, not a duplicate already on main', () => {
    const pair = `${keeper}it('old copy', () => {\n  const x = f(1);\n  expect(x).toBe(2);\n});\n`;
    expect(duplicates(pair, `${pair}\n// a comment-only edit\n`)).toEqual([]);
  });

  it.each([
    ['a different input', "it('other', () => {\n  const out = f(5);\n  expect(out).toBe(2);\n});"],
    ['a different expectation', "it('other', () => {\n  const out = f(1);\n  expect(out).toBe(7);\n});"],
    [
      'a different destructured row field',
      "it.each(rows)('a %s', ({ x }) => {\n  expect(f(x)).toBe(2);\n});\nit.each(rows)('b %s', ({ y }) => {\n  expect(f(y)).toBe(2);\n});",
    ],
    [
      'a block with its own setup hook',
      "describe('fresh', () => {\n  beforeEach(() => g(0));\n  it('other', () => {\n    const out = f(1);\n    expect(out).toBe(2);\n  });\n});",
    ],
    ['a case that asserts nothing', "it('probe', () => {\n  const out = f(1);\n});"],
    [
      'the same body under two same-titled blocks with different fixtures',
      "describe('s', () => {\n  const v = 1;\n  it('a', () => {\n    expect(f(v)).toBe(2);\n  });\n});\ndescribe('s', () => {\n  const v = 5;\n  it('b', () => {\n    expect(f(v)).toBe(2);\n  });\n});",
    ],
    [
      'the same body in loops over different rows',
      "for (const x of [1]) it('a', () => {\n  expect(f(x)).toBe(2);\n});\nfor (const x of [5]) it('b', () => {\n  expect(f(x)).toBe(2);\n});",
    ],
  ])('does not flag %s', (_label, added) => {
    expect(duplicates(keeper, `${keeper}${added}\n`)).toEqual([]);
  });

  it('does not flag a case that calls a different import and shadows a name only in a nested block', () => {
    const a = "it('a', () => {\n  expect(f(1)).toBe(2);\n  { const f = 0; }\n});\n";
    const b = "it('b', () => {\n  expect(g(1)).toBe(2);\n  { const g = 0; }\n});\n";
    expect(duplicates(a, a + b)).toEqual([]);
  });

  it('ignores every case inside a skipped suite', () => {
    const copy =
      "describe.skip('off', () => {\n  it('copy', () => {\n    const out = f(1);\n    expect(out).toBe(2);\n  });\n});\n";
    expect(duplicates(keeper, keeper + copy)).toEqual([]);
  });

  it('does not report duplicates a change only moves under a renamed suite', () => {
    const suite = (title: string) =>
      `describe('${title}', () => {\n  const v = 1;\n  it('a', () => {\n    expect(f(v)).toBe(2);\n  });\n  it('b', () => {\n    expect(f(v)).toBe(2);\n  });\n});\n`;
    expect(duplicates(suite('old'), suite('new'))).toEqual([]);
  });

  it('does not flag a case whose longer match adds no assertion', () => {
    const longer = "it('longer', () => {\n  const out = f(1);\n  expect(out).toBe(2);\n  g(0);\n});\n";
    expect(duplicates(longer, longer + keeper)).toEqual([]);
  });

  it('reports the added copy, not the existing case, when the copy is inserted above it', () => {
    const copy = "it('copy', () => {\n  const out = f(1);\n  expect(out).toBe(2);\n});\n";
    expect(duplicates(keeper, copy + keeper)).toEqual(['same-as copy <- keeper']);
  });

  it('does not treat a skipped case as the keeper', () => {
    const skipped = keeper.replace("it('keeper'", "it.skip('keeper'");
    const copy = "it('copy', () => {\n  const out = f(1);\n  expect(out).toBe(2);\n});\n";
    expect(duplicates(skipped, skipped + copy)).toEqual([]);
  });

  it('never compares cases across files', () => {
    const [a] = extractCases('src/a.test.ts', header + keeper);
    const [b] = extractCases('src/b.test.ts', header + keeper.replace('keeper', 'copy'));
    expect(findDuplicateTests([b], [a, b])).toEqual([]);
  });
});
