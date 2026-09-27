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
    [
      'the same body in sibling blocks with different bindings',
      "{\n  const v = 1;\n  it('a', () => {\n    expect(f(v)).toBe(2);\n  });\n}\n{\n  const v = 5;\n  it('b', () => {\n    expect(f(v)).toBe(2);\n  });\n}",
    ],
    [
      'the same body in suites under loops over different rows',
      "for (const x of [1]) describe('s', () => {\n  it('a', () => {\n    expect(f(x)).toBe(2);\n  });\n});\nfor (const x of [5]) describe('s', () => {\n  it('b', () => {\n    expect(f(x)).toBe(2);\n  });\n});",
    ],
    [
      'the same body in sibling suites whose aliased setup hooks differ',
      "describe('s', () => {\n  setup(() => g(1));\n  it('a', () => {\n    expect(f(1)).toBe(2);\n  });\n});\ndescribe('t', () => {\n  setup(() => g(5));\n  it('b', () => {\n    expect(f(1)).toBe(2);\n  });\n});",
    ],
    [
      'the same table under each and for, whose callbacks receive different arguments',
      "it.each([[1, 2]])('a', (x) => {\n  expect(f(x)).toBe(2);\n});\nit.for([[1, 2]])('b', (x) => {\n  expect(f(x)).toBe(2);\n});",
    ],
    [
      'the same body in the two branches of an if',
      "if (process.platform === 'win32') it('a', () => {\n  expect(f(1)).toBe(2);\n});\nelse it('b', () => {\n  expect(f(1)).toBe(2);\n});",
    ],
    [
      'the same body under a wrapper called with different arguments',
      "withBackend('sqlite', () => {\n  it('a', () => {\n    expect(f(1)).toBe(2);\n  });\n});\nwithBackend('postgres', () => {\n  it('b', () => {\n    expect(f(1)).toBe(2);\n  });\n});",
    ],
    [
      'a copy inside a suite that carries options',
      "describe('off', { skip: true }, () => {\n  it('copy', () => {\n    const out = f(1);\n    expect(out).toBe(2);\n  });\n});",
    ],
    [
      'the same body under test and it, which may carry different fixtures',
      "test('copy', () => {\n  const out = f(1);\n  expect(out).toBe(2);\n});",
    ],
    [
      'a var that one body hoists and the other reads from outside',
      "it('a', () => {\n  if (g(0)) { var x = 1; }\n  expect(f(x)).toBe(2);\n});\nit('b', () => {\n  if (g(0)) { var y = 1; }\n  expect(f(x)).toBe(2);\n});",
    ],
    [
      'bodies that differ only in a getter name',
      "it('a', () => {\n  const a = 1;\n  expect(f({ get a() { return a; } })).toBe(2);\n});\nit('b', () => {\n  const b = 1;\n  expect(f({ get b() { return b; } })).toBe(2);\n});",
    ],
    [
      'raw templates with different raw text',
      "it('a', () => {\n  expect(f(String.raw`\\n`)).toBe(2);\n});\nit('b', () => {\n  expect(f(String.raw`\n`)).toBe(2);\n});",
    ],
    [
      'loop headers that differ only in where a semicolon falls',
      "it('a', () => {\n  for (let i = 0; i++; ) g(i);\n  expect(f(1)).toBe(2);\n});\nit('b', () => {\n  for (let i = 0; ; i++) g(i);\n  expect(f(1)).toBe(2);\n});",
    ],
    [
      'bodies that differ only in where a statement ends',
      "it('a', () => {\n  const cb = (stop) => { if (stop) return; g(0); };\n  expect(f(cb)).toBe(2);\n});\nit('b', () => {\n  const cb = (stop) => { if (stop) return g(0); };\n  expect(f(cb)).toBe(2);\n});",
    ],
    [
      'bodies that read the running test from their context',
      "it('sqlite', ({ task }) => {\n  expect(f(task.name)).toBe(2);\n});\nit('postgres', ({ task }) => {\n  expect(f(task.name)).toBe(2);\n});",
    ],
    [
      'bodies whose shared setup reads the running test',
      "describe('s', () => {\n  let v;\n  beforeEach(({ task }) => { v = task.name; });\n  it('sqlite', () => {\n    expect(f(v)).toBe(2);\n  });\n  it('postgres', () => {\n    expect(f(v)).toBe(2);\n  });\n});",
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

  it('does not treat assertion words inside a string as an assertion', () => {
    const longer =
      "it('longer', () => {\n  const out = f(1);\n  expect(out).toBe(2);\n  g('assertion complete');\n});\n";
    expect(duplicates(longer, longer + keeper)).toEqual([]);
  });

  it('does not report duplicates already on main when a change only edits their setup hook', () => {
    const suite = (n: number) =>
      `describe('s', () => {\n  beforeEach(() => g(${n}));\n  it('a', () => {\n    expect(f(1)).toBe(2);\n  });\n  it('b', () => {\n    expect(f(1)).toBe(2);\n  });\n});\n`;
    expect(duplicates(suite(1), suite(2))).toEqual([]);
  });

  it('reports the added copy, not the existing case, when the copy is inserted above it', () => {
    const copy = "it('copy', () => {\n  const out = f(1);\n  expect(out).toBe(2);\n});\n";
    expect(duplicates(keeper, copy + keeper)).toEqual(['same-as copy <- keeper']);
  });

  it('does not treat a case skipped through its options as the keeper', () => {
    const skipped = keeper.replace("it('keeper', ", "it('keeper', { skip: true }, ");
    const copy = "it('copy', () => {\n  const out = f(1);\n  expect(out).toBe(2);\n});\n";
    expect(duplicates(skipped, skipped + copy)).toEqual([]);
  });

  it('does not report duplicates already on main when a change edits both of them', () => {
    const pair = (n: number) =>
      `it('a', () => {\n  expect(f(${n})).toBe(2);\n});\nit('b', () => {\n  expect(f(${n})).toBe(2);\n});\n`;
    expect(duplicates(pair(1), pair(2))).toEqual([]);
  });

  it('does not report duplicates already on main when a change only drops an unused context parameter', () => {
    const suite = (param: string) =>
      `describe('s', () => {\n  beforeEach((${param}) => g(0));\n  it('a', () => {\n    expect(f(1)).toBe(2);\n  });\n  it('b', () => {\n    expect(f(1)).toBe(2);\n  });\n});\n`;
    expect(duplicates(suite('ctx'), suite(''))).toEqual([]);
  });

  it('does not report duplicates already on main when a change only drops empty options', () => {
    const suite = (opts: string) =>
      `it('a', ${opts}() => {\n  expect(f(1)).toBe(2);\n});\nit('b', ${opts}() => {\n  expect(f(1)).toBe(2);\n});\n`;
    expect(duplicates(suite('{}, '), suite(''))).toEqual([]);
  });

  const choose = `function choose(...args) {\n  backend = open(args.at(-1).task.name);\n}\n`;

  it.each([
    [
      'a hook registered by reference',
      `function setup({ task }) {\n  backend = open(task.name);\n}\nbeforeEach(setup);\n`,
    ],
    ['a hook registered conditionally', `if (enabled) beforeEach(({ task }) => {\n  backend = open(task.name);\n});\n`],
    ['the current test name', `beforeEach(() => {\n  backend = open(expect.getState().currentTestName);\n});\n`],
    ['the runner current test', `beforeEach(() => {\n  backend = open(getCurrentTest().name);\n});\n`],
    ['an aliased hook', `import { beforeEach as setup } from 'vitest';\n${choose}setup(choose);\n`],
    ['a hook on a namespace', `${choose}v.beforeEach(choose);\n`],
    ['an around hook', `${choose}aroundEach(choose);\n`],
    [
      'a fixture factory',
      `function useBackend() {\n  beforeEach(({ task }) => {\n    active = open(task.name);\n  });\n  return {};\n}\nconst backend = useBackend();\n`,
    ],
    [
      'a harness constructor',
      `class Harness {\n  constructor() {\n    beforeEach(({ task }) => {\n      active = open(task.name);\n    });\n  }\n}\nbackend = new Harness();\n`,
    ],
    ['a hook reading its arguments', `beforeEach(function () {\n  backend = open(arguments[0].task.name);\n});\n`],
  ])('does not judge a file whose setup can tell its cases apart through %s', (_, setup) => {
    const cases = `it('sqlite', () => {\n  expect(backend.query(1)).toEqual([1]);\n});\n`;
    expect(duplicates(setup + cases, setup + cases + cases.replace('sqlite', 'postgres'))).toEqual([]);
  });

  it('does not judge a case that reads its arguments', () => {
    const named = (name: string) =>
      `it('${name}', function () {\n  expect(open(arguments[0].task.name).query(1)).toEqual([1]);\n});\n`;
    expect(duplicates(named('sqlite'), named('sqlite') + named('postgres'))).toEqual([]);
  });

  it('does not report duplicates already on main when a change inlines a shared callback', () => {
    const inlined = `it('a', () => {\n  expect(f(1)).toBe(2);\n});\nit('b', () => {\n  expect(f(1)).toBe(2);\n});\n`;
    const shared = `function check() {\n  expect(f(1)).toBe(2);\n}\nit('a', check);\nit('b', check);\n`;
    expect(duplicates(shared, inlined)).toEqual([]);
  });

  it('still judges a file whose only setup is mocks and plain hooks', () => {
    const setup = `vi.mock('./db');\nexpect.extend({});\nprocess.env.TZ = 'UTC';\nbeforeEach(() => {\n  reset();\n});\n`;
    const cases = `it('a', () => {\n  expect(f(1)).toBe(2);\n});\n`;
    expect(duplicates(setup + cases, setup + cases + cases.replace("'a'", "'b'"))).toEqual(['same-as b <- a']);
  });

  it('does not judge an it.for case that reads its test context', () => {
    const row = (name: string) =>
      `it.for([1])('${name}', (row, { task }) => {\n  expect(open(task.name).query(row)).toEqual([1]);\n});\n`;
    expect(duplicates(row('sqlite'), row('sqlite') + row('postgres'))).toEqual([]);
  });

  it('does not judge an it.for case whose rest parameter receives the test context', () => {
    const row = (name: string) =>
      `it.for([1])('${name}', (...args) => {\n  expect(open(args[1].task.name).query(args[0])).toEqual([1]);\n});\n`;
    expect(duplicates(row('sqlite'), row('sqlite') + row('postgres'))).toEqual([]);
  });

  it('flags a copy under a second suite set up the same way', () => {
    const suite = (title: string, name: string) =>
      `describe('${title}', () => {\n  beforeEach(() => g(1));\n  it('${name}', () => {\n    expect(f(1)).toBe(2);\n  });\n});\n`;
    expect(duplicates(suite('s', 'a'), suite('s', 'a') + suite('t', 'b'))).toEqual(['same-as b <- a']);
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
