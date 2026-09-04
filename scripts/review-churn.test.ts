// The pr-review-loop churn gate: does a finding CLASS that has survived three
// rounds actually stop the next site patch?
//
// The classifier ships with the skill as dependency-free ESM
// (`.claude/skills/pr-review-loop/scripts/review-churn.mjs`) because it also
// runs inside an agent container, where nothing is installed. So this suite
// drives it the way the loop does: as a subprocess, payload on stdin, decision
// on stderr and `--json` on stdout, and the exit code as the gate itself.
// Every fixture carries its own `sources`, so no case reads the checkout.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

allowSubprocess(['node', 'bun', 'git']);
enforceHermeticity();

const SCRIPT = path.resolve('.claude/skills/pr-review-loop/scripts/review-churn.mjs');
const CONTAINER_SCRIPT = path.resolve('container/skills/pr-review-loop/scripts/review-churn.mjs');
const FIXTURES = path.resolve('scripts/__fixtures__/review-churn');

// The classifier runs on the host under node and inside agent containers under
// bun, so the cross-runtime case needs both. Missing bun is an error, not a
// skip: the property it checks — that the two runtimes decide identically — is
// the whole reason the deny set is a frozen list.
function bunBinary(): string {
  const candidates = [
    ...(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, 'bun')),
    path.join(process.env.HOME ?? '', '.bun/bin/bun'),
    '/usr/local/bin/bun',
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('bun is required for the cross-runtime case; install it or put it on PATH');
  return found;
}

interface Site {
  file: string;
  line: number | null;
  title?: string;
}
interface ClassRow {
  key: string;
  signature: string;
  seam: string | null;
  seamSubstantiated?: boolean;
  primitives: string[];
  rounds: number;
  findings: number;
  sites: Site[];
}
interface SeamRow {
  seam: string;
  rounds: number;
  severityFalling: boolean;
  seamSubstantiated?: boolean;
}
interface Report {
  classes: ClassRow[];
  seams: SeamRow[];
  totalRounds: number;
  totalFindings: number;
}
interface Decision {
  status: 'pass' | 'refuse' | 'override';
  flagged: (ClassRow & { lifted: boolean; liftedBy: string | null; reason: string })[];
  unlifted: ClassRow[];
  reported: { key: string; rounds: number; seam: string | null; reason: string }[];
  report: Report;
}

interface Payload {
  findings: unknown[];
  sources?: Record<string, string>;
  repoRoot?: string;
  commits?: {
    sha: string;
    date: string;
    message: string;
    files: string[];
    before?: Record<string, string>;
    after?: Record<string, string>;
  }[];
  worktree?: string[];
}

function fixture(name: string): Payload {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as Payload;
}

function spawn(args: string[], payload: Payload, env: Record<string, string> = {}) {
  // REVIEW_LOOP_ALLOW_SITE_PATCH must never leak in from the caller's shell:
  // the override case has to be the one that sets it.
  const base = { ...process.env };
  delete base.REVIEW_LOOP_ALLOW_SITE_PATCH;
  const res = spawnSync('node', [SCRIPT, ...args], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...base, ...env },
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

function classify(payload: Payload): Report {
  const out = spawn(['classify', '--json'], payload);
  expect(out.status).toBe(0);
  return JSON.parse(out.stdout) as Report;
}

/** The gate as the loop sees it: exit status, machine decision, human text. */
function gate(payload: Payload, env: Record<string, string> = {}) {
  const out = spawn(['gate', '--json'], payload, env);
  return { status: out.status, decision: JSON.parse(out.stdout) as Decision, text: out.stderr };
}

const AFTER = '2026-09-02T00:00:00Z'; // later than every finding in toctou-class
const BEFORE = '2026-08-30T00:00:00Z'; // earlier than every finding in toctou-class

describe('review-churn classifier', () => {
  it('collapses one invariant reported at four call sites into one class', () => {
    const report = classify(fixture('toctou-class'));

    const churning = report.classes.filter((c) => c.rounds >= 3);
    expect(churning).toHaveLength(1);
    expect(churning[0].signature).toBe('inv:race');
    expect(churning[0].rounds).toBe(4);
    expect(churning[0].findings).toBe(4);
    expect(new Set(churning[0].sites.map((s) => s.file))).toEqual(
      new Set(['src/router.ts', 'src/delivery.ts', 'src/tasks.ts', 'src/dashboard/close.ts']),
    );
  });

  it('names the seam those sites share and the primitives they call', () => {
    const churning = classify(fixture('toctou-class')).classes.find((c) => c.rounds >= 3)!;
    expect(churning.seam).toBe('src/mailbox/write.ts');
    expect(churning.primitives).toContain('writeSessionMessage');
    expect(churning.primitives).toContain('wakeContainer');
  });

  it('sees churn the file-level detector cannot: no file reaches three rounds', () => {
    const payload = fixture('toctou-class');
    const roundsPerFile = new Map<string, Set<string>>();
    for (const f of payload.findings as { path: string; reviewId: string }[]) {
      if (!roundsPerFile.has(f.path)) roundsPerFile.set(f.path, new Set());
      roundsPerFile.get(f.path)!.add(f.reviewId);
    }
    expect(Math.max(...[...roundsPerFile.values()].map((s) => s.size))).toBeLessThan(3);

    expect(classify(payload).classes.some((c) => c.rounds >= 3)).toBe(true);
  });

  it('keeps an unrelated finding out of the churning class', () => {
    const report = classify(fixture('toctou-class'));
    const nullability = report.classes.find((c) => c.signature === 'inv:nullability');
    expect(nullability?.rounds).toBe(1);
    expect(report.classes.find((c) => c.rounds >= 3)!.sites.map((s) => s.title)).not.toContain(
      'Treat an absent config value as empty',
    );
  });

  it('splits one invariant at two unrelated seams into two classes', () => {
    const churning = classify(fixture('two-seams')).classes.filter((c) => c.rounds >= 3);
    expect(churning).toHaveLength(2);
    expect(new Set(churning.map((c) => c.seam))).toEqual(new Set(['src/mailbox/write.ts', 'src/db/tasks.ts']));
    for (const c of churning) {
      expect(c.findings).toBe(3);
      expect(c.primitives).toHaveLength(1);
    }
  });

  it('reports a class whose sites share no seam, with no seam to name', () => {
    const churning = classify(fixture('seamless-class')).classes.filter((c) => c.rounds >= 3);
    expect(churning).toHaveLength(1);
    expect(churning[0].seam).toBeNull();
    expect(churning[0].primitives).toEqual([]);
  });

  it('never seams a class on a Node builtin, bare, prefixed, or prefix-only', () => {
    // A builtin is shared by nearly every file in the tree and owns no
    // write/wake/read primitive, so it is the specifier the seam ranking would
    // reward and the one answer that can never be right. The fixture's sites
    // share `path` (bare), `node:fs` (prefixed, in builtinModules) and
    // `node:test` (prefixed, in builtinModules on neither runtime) — so the
    // `node:` prefix has to be rejected outright, not looked up in the list.
    const churning = classify(fixture('builtin-seam')).classes.filter((c) => c.rounds >= 3);
    expect(churning).toHaveLength(1);
    expect(churning[0].seam).toBeNull();
    expect(churning[0].primitives).toEqual([]);
  });

  it('prefers the module that owns the primitive over the builtins every file shares', () => {
    const churning = classify(fixture('builtin-with-real-seam')).classes.filter((c) => c.rounds >= 3);
    expect(churning[0].seam).toBe('src/mailbox/write.ts');
    expect(churning[0].primitives).toContain('writeSessionMessage');
  });

  it("never seams a class on Node's underscore-prefixed internals", () => {
    // `_http_agent` and friends are bare-loadable on both runtimes. npm forbids
    // package names starting with `_`, so a bare `_`-specifier is always a core
    // internal — a rule, rather than an enumeration of the `_http_*`,
    // `_stream_*` and `_tls_*` families that invites the next omission.
    const churning = classify(fixture('internal-builtin-seam')).classes.filter((c) => c.rounds >= 3);
    expect(churning).toHaveLength(1);
    expect(churning[0].seam).toBeNull();
  });

  it('still seams on an in-repo module whose name starts with an underscore', () => {
    // The rule is about package specifiers, not about the character: a relative
    // import resolves to a path in this repo, which a diff can touch.
    const churning = classify(fixture('underscore-module-seam')).classes.filter((c) => c.rounds >= 3);
    expect(churning[0].seam).toBe('src/_shared.ts');
    expect(churning[0].primitives).toContain('writeThing');
  });

  it('keeps a real dependency seam-eligible, builtins around it notwithstanding', () => {
    // `undici` is a direct dependency of this repo AND a name bun reports as a
    // builtin. Its sites here also share `fs` and `node:test`, so the two
    // categories are exercised together.
    const churning = classify(fixture('undici-seam')).classes.filter((c) => c.rounds >= 3);
    expect(churning).toHaveLength(1);
    expect(churning[0].seam).toBe('undici');
    expect(churning[0].primitives).toContain('requestWithPool');
  });

  it('decides identically under node and under bun', () => {
    // The deny set is a frozen list of Node core specifiers, never the
    // executing runtime's `builtinModules`: bun reports `undici`, `ws` and
    // `bun` as builtins and node does not, so a runtime-derived set gave one
    // payload two verdicts — a class seamed on `undici` refused a push on the
    // host and passed in a container.
    const bun = bunBinary();
    for (const name of [
      'undici-seam',
      'builtin-seam',
      'builtin-with-real-seam',
      'internal-builtin-seam',
      'underscore-module-seam',
    ]) {
      const payload = fixture(name);
      const underNode = spawn(['classify', '--json'], payload);
      const underBun = spawnSync(bun, [SCRIPT, 'classify', '--json'], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
      });
      expect(underNode.status, `node failed on ${name}`).toBe(0);
      expect(underBun.status, `bun failed on ${name}: ${underBun.stderr}`).toBe(0);
      expect(JSON.parse(underBun.stdout), `${name} classifies differently under bun`).toEqual(
        JSON.parse(underNode.stdout),
      );
    }
  });

  it('does not derive the deny set from whatever runtime is executing it', () => {
    // A structural guard, because the cross-runtime case above can only catch
    // the disagreements those two runtimes happen to have today.
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const code = source.replace(/^\s*(\/\/.*|\*.*|\/\*.*)$/gm, '');
    expect(code).not.toContain('builtinModules');
    expect(code).not.toContain("from 'node:module'");
  });

  it('marks a seam it had to guess at, and one it has evidence for', () => {
    // With one flagged file there is no shared import to measure, so the seam
    // is whichever import ranks first. The findings naming what that module
    // exports is the only evidence left; without it the answer is a guess.
    const guessed = classify(fixture('guessed-seam')).classes[0];
    expect(guessed.rounds).toBe(3);
    expect(guessed.seam).toBe('src/db/messages-out.ts');
    expect(guessed.seamSubstantiated).toBe(false);

    const named = classify(fixture('named-seam-single-file')).classes[0];
    expect(named.rounds).toBe(3);
    expect(named.seam).toBe('src/gate.ts');
    expect(named.seamSubstantiated).toBe(true);

    // Two flagged files sharing the module is evidence on its own.
    expect(classify(fixture('toctou-class')).classes[0].seamSubstantiated).toBe(true);
  });

  it('reads imports at line starts, so neither a doc example nor a string blinds it', () => {
    // The classifier's own header contains ` *   import { a, b } from '…'`,
    // which is not an import; a file may equally contain `const marker = "/*"`
    // above its imports, which does not open a comment. Anchoring to the line
    // start answers both without a lexer.
    const payload = fixture('toctou-class');
    payload.sources = {
      ...payload.sources,
      'src/router.ts':
        "/**\n *   import { fake } from './not-real.js';\n */\n" +
        'const marker = "/*";\n' +
        "import { writeSessionMessage, wakeContainer } from './mailbox/write.js';\n",
    };
    const report = JSON.parse(spawn(['classify', '--json'], payload).stdout) as Report;
    const churning = report.classes.find((c) => c.rounds >= 3)!;
    expect(churning.seam).toBe('src/mailbox/write.ts');
  });

  it('substantiates a seam reached through a destructured dynamic import', () => {
    // `const { evaluateGate } = await import('./gate.js')` binds the same name
    // a static import would, and this tree prescribes that form for circular
    // imports on the host, so it is how a named seam often arrives.
    const churning = classify(fixture('dynamic-import-seam')).classes[0];
    expect(churning.seam).toBe('src/gate.ts');
    expect(churning.primitives).toContain('evaluateGate');
    expect(churning.seamSubstantiated).toBe(true);
  });

  it('substantiates a seam the findings name through an alias', () => {
    // `import { evaluateGate as gate }` binds `gate`, which is the name a
    // finding will use, while the module exports `evaluateGate`. Both spellings
    // are what the module provides, so either one is evidence.
    const aliased = classify(fixture('aliased-seam')).classes[0];
    expect(aliased.seam).toBe('src/gate.ts');
    expect(aliased.seamSubstantiated).toBe(true);
  });

  it('substantiates a rollup on its own files, never on a sibling class naming it', () => {
    // The rollup exists to see signature drift across files that share a
    // callee, where no single class can substantiate the seam alone. Its
    // evidence is therefore its own: two or more flagged files importing the
    // module, the same standard the class-level rule uses. One class's naming
    // is evidence for that class only.
    const report = classify(fixture('guessed-seam-with-named-sibling'));
    expect(report.classes.find((c) => c.rounds === 3)!.seamSubstantiated).toBe(false);
    // Two flagged FILES import it, which is the rollup's own evidence.
    expect(report.seams[0].seamSubstantiated).toBe(true);

    // One file, so no collective evidence exists: a sibling class naming the
    // module substantiates only itself, and the guessed class's rounds are not
    // carried behind it.
    const sameFile = fixture('guessed-seam-with-named-sibling');
    const findings = sameFile.findings as { path: string }[];
    for (const f of findings) f.path = 'src/tool.ts';
    const collapsed = JSON.parse(spawn(['classify', '--json'], sameFile).stdout) as Report;
    expect(collapsed.seams.every((seam) => !seam.seamSubstantiated)).toBe(true);

    // And with EVERY class a guess, the shared files still substantiate it —
    // three signatures, three files, one import, nobody naming it.
    const collective = classify(fixture('collective-seam'));
    expect(collective.classes).toHaveLength(3);
    expect(collective.classes.every((c) => c.rounds === 1 && !c.seamSubstantiated)).toBe(true);
    expect(collective.seams[0].seam).toBe('src/mailbox/write.ts');
    expect(collective.seams[0].rounds).toBe(3);
    expect(collective.seams[0].seamSubstantiated).toBe(true);
  });

  it('does not count a bound name that only appears inside a longer word', () => {
    // `get` must not be substantiated by a finding that said "target".
    const churning = classify(fixture('substring-name-seam')).classes[0];
    expect(churning.rounds).toBe(3);
    expect(churning.seam).toBe('src/store.ts');
    expect(churning.seamSubstantiated).toBe(false);
  });

  it('reads severity direction per seam, not per finding', () => {
    const falling = classify(fixture('seam-drift-falling'));
    const flat = classify(fixture('seam-drift-flat'));
    expect(falling.seams[0].seam).toBe('src/mailbox/write.ts');
    expect(falling.seams[0].rounds).toBe(3);
    expect(falling.seams[0].severityFalling).toBe(true);
    expect(flat.seams[0].severityFalling).toBe(false);
  });
});

describe('review-churn gate', () => {
  it('refuses a site patch once a class has run three rounds', () => {
    const { status, decision, text } = gate(fixture('toctou-class'));
    expect(status).toBe(3);
    expect(decision.status).toBe('refuse');
    expect(decision.unlifted).toHaveLength(1);
    expect(text).toContain('REFRAME REQUIRED');
    expect(text).toContain('inv:race @ src/mailbox/write.ts');
    expect(text).toContain('src/mailbox/write.ts');
    expect(text).toContain('writeSessionMessage');
    expect(text).toContain('src/dashboard/close.ts');
    expect(text).toContain('Reframe: <invariant> enforced in <primitive>');
  });

  it('lifts when a commit after the last finding touches the primitive', () => {
    const payload = fixture('toctou-class');
    payload.commits = [
      { sha: 'aaa1111', date: AFTER, message: 'fix(mailbox): guard the write', files: ['src/mailbox/write.ts'] },
    ];
    const { status, decision } = gate(payload);
    expect(status).toBe(0);
    expect(decision.status).toBe('pass');
    expect(decision.flagged[0].liftedBy).toBe('diff touches the primitive');
  });

  it('lifts on the reframe trailer even when the diff is elsewhere', () => {
    const payload = fixture('toctou-class');
    payload.commits = [
      {
        sha: 'bbb2222',
        date: AFTER,
        message:
          'fix(mailbox): one guard for every caller\n\nReframe: session revalidation enforced in writeSessionMessage\n',
        files: ['src/somewhere-else.ts'],
      },
    ];
    const { status, decision } = gate(payload);
    expect(status).toBe(0);
    expect(decision.flagged[0].liftedBy).toBe('reframe trailer');
  });

  it('lifts on uncommitted work at the primitive, so the gate is runnable before committing', () => {
    const payload = fixture('toctou-class');
    payload.worktree = ['src/mailbox/write.ts'];
    expect(gate(payload).status).toBe(0);
  });

  it('does not accept a seam commit that predates the finding as the reframe', () => {
    const payload = fixture('toctou-class');
    payload.commits = [
      { sha: 'ccc3333', date: BEFORE, message: 'chore: earlier work', files: ['src/mailbox/write.ts'] },
    ];
    const { status, decision } = gate(payload);
    expect(status).toBe(3);
    expect(decision.status).toBe('refuse');
  });

  it('does not accept a patch at another site as the reframe', () => {
    const payload = fixture('toctou-class');
    payload.commits = [
      { sha: 'ddd4444', date: AFTER, message: 'fix: revalidate in the task path', files: ['src/tasks.ts'] },
    ];
    expect(gate(payload).status).toBe(3);
  });

  it('lets the override through, loudly, still naming the class', () => {
    const { status, decision, text } = gate(fixture('toctou-class'), { REVIEW_LOOP_ALLOW_SITE_PATCH: '1' });
    expect(status).toBe(0);
    expect(decision.status).toBe('override');
    expect(decision.unlifted).toHaveLength(1);
    expect(text).toContain('SITE PATCH OVERRIDE');
    expect(text).toContain('REVIEW_LOOP_ALLOW_SITE_PATCH=1');
    expect(text).toContain('inv:race @ src/mailbox/write.ts');
  });

  it('refuses three flat-severity rounds on one seam even when no class repeats', () => {
    const flat = gate(fixture('seam-drift-flat'));
    expect(flat.status).toBe(3);
    expect(flat.decision.unlifted[0].key).toBe('seam src/mailbox/write.ts');
    expect(flat.text).toContain('severity not falling');
  });

  it('passes three rounds on one seam when severity is falling', () => {
    const falling = gate(fixture('seam-drift-falling'));
    expect(falling.status).toBe(0);
    expect(falling.decision.status).toBe('pass');
    expect(falling.decision.flagged).toHaveLength(0);
  });

  it('reports a guessed seam without gating it', () => {
    // The refusal would name a primitive the fix has no reason to touch, so
    // the only way past would be the override — the failure the gate exists to
    // prevent, arrived at by the gate itself.
    const { status, decision } = gate(fixture('guessed-seam'));
    expect(status).toBe(0);
    expect(decision.status).toBe('pass');
    expect(decision.flagged).toHaveLength(0);
    expect(decision.report.classes[0].rounds).toBe(3);
  });

  it('still gates a single-file class when the findings name what the seam exports', () => {
    const { status, decision } = gate(fixture('named-seam-single-file'));
    expect(status).toBe(3);
    expect(decision.unlifted[0].seam).toBe('src/gate.ts');
  });

  it('lifts on a trailer naming a primitive the commit declares, not only the classifier guess', () => {
    // The classifier's candidates are a ranking, not a fact. An author who
    // moved the invariant somewhere else says so, and the commit's own added
    // lines are what back the claim.
    const payload = fixture('toctou-class');
    payload.commits = [
      {
        sha: 'kkk1111',
        date: AFTER,
        message: 'fix: one guard for every caller\n\nReframe: race enforced in guardEveryWrite\n',
        files: ['src/guard.ts'],
        before: { 'src/guard.ts': '' },
        after: { 'src/guard.ts': 'export function guardEveryWrite(session: Session) {}\n' },
      },
    ];
    const { status, decision } = gate(payload);
    expect(status).toBe(0);
    expect(decision.flagged[0].liftedBy).toBe('reframe trailer');
  });

  it('lifts on a short primitive name, which is an ordinary name', () => {
    const payload = fixture('toctou-class');
    payload.commits = [
      {
        sha: 'mmm3333',
        date: AFTER,
        message: 'fix: one guard\n\nReframe: race enforced in run\n',
        files: ['src/guard.ts'],
        before: { 'src/guard.ts': '' },
        after: { 'src/guard.ts': 'export function run(session: Session) {}\n' },
      },
    ];
    expect(gate(payload).status).toBe(0);
  });

  it('does not accept a declaration the commit merely touched the file of', () => {
    // Otherwise a site patch edits that file for something unrelated, points
    // its trailer at a helper that was already there, and the gate opens.
    const payload = fixture('toctou-class');
    payload.commits = [
      {
        sha: 'nnn4444',
        date: AFTER,
        message: 'chore: unrelated edit\n\nReframe: race enforced in guardEveryWrite\n',
        files: ['src/guard.ts'],
        before: { 'src/guard.ts': 'export function guardEveryWrite() {}\n' },
        after: { 'src/guard.ts': 'export function guardEveryWrite() {}\nlogger.debug("unrelated");\n' },
      },
    ];
    expect(gate(payload).status).toBe(3);
  });

  it('does not lift on a trailer naming something the commit never declares', () => {
    const payload = fixture('toctou-class');
    payload.commits = [
      {
        sha: 'lll2222',
        date: AFTER,
        message: 'fix: claim without a diff\n\nReframe: race enforced in someOtherPlace\n',
        files: ['src/guard.ts'],
        before: { 'src/guard.ts': '' },
        after: { 'src/guard.ts': 'export function guardEveryWrite() {}\n' },
      },
    ];
    expect(gate(payload).status).toBe(3);
  });

  it('does not let one declared primitive clear two classes at once', () => {
    // Both classes were reframed into the same new function, so the classifier
    // seams no longer separate them. The trailer has to say which invariant it
    // fixed, and it only clears that one.
    const payload = fixture('shared-primitive');
    payload.commits = [
      {
        sha: 'ooo5555',
        date: AFTER,
        message: 'fix: one guard\n\nReframe: race enforced in guardEveryWrite\n',
        files: ['src/guard.ts'],
        before: { 'src/guard.ts': '' },
        after: { 'src/guard.ts': 'export function guardEveryWrite(session: Session) {}\n' },
      },
    ];
    const { status, decision } = gate(payload);
    expect(status).toBe(3);
    expect(decision.unlifted).toHaveLength(1);
    expect(decision.unlifted[0].signature).toBe('inv:durability');
  });

  it('gates an aliased seam like any other substantiated one', () => {
    expect(gate(fixture('aliased-seam')).status).toBe(3);
  });

  it('gates a seam its files collectively substantiate, and says so only once', () => {
    // Two flagged files sharing the import is the rollup's own evidence, so
    // the seam gates. The class table must not simultaneously report that
    // class as "not gated" — two answers to one question.
    const { status, decision, text } = gate(fixture('guessed-seam-with-named-sibling'));
    expect(status).toBe(3);
    expect(decision.flagged[0].key).toBe('seam src/db/messages-out.ts');
    expect(decision.reported).toHaveLength(0);
    expect(text).not.toContain('reported, not gated');
  });

  it('gates signature drift no single class can substantiate', () => {
    const { status, decision } = gate(fixture('collective-seam'));
    expect(status).toBe(3);
    expect(decision.unlifted[0].key).toBe('seam src/mailbox/write.ts');
  });

  it('does not gate a seam substantiated only by a substring of a finding', () => {
    const { status, decision } = gate(fixture('substring-name-seam'));
    expect(status).toBe(0);
    expect(decision.reported[0].rounds).toBe(3);
  });

  it('accepts any shape the commit introduced, method or otherwise', () => {
    // The check does not try to recognise declaration syntax, so a method on an
    // existing class, an arrow in an object literal and a plain function all
    // count without enumerating them.
    const payload = fixture('toctou-class');
    for (const introduced of [
      'export function guardEveryWrite(session: Session) {}\n',
      'class Guards {\n  async guardEveryWrite(session: Session) {}\n}\n',
      'const guards = { guardEveryWrite: (session: Session) => {} };\n',
    ]) {
      payload.commits = [
        {
          sha: 'rrr8888',
          date: AFTER,
          message: 'fix: one guard\n\nReframe: race enforced in guardEveryWrite\n',
          files: ['src/guard.ts'],
          before: { 'src/guard.ts': '// nothing yet\n' },
          after: { 'src/guard.ts': introduced },
        },
      ];
      expect(gate(payload).status, introduced).toBe(0);
    }
  });

  it('accepts a name introduced only in a comment — the documented trade', () => {
    // Presence and absence, not "is this executable". Proving the latter with
    // regexes took four review rounds and still leaked, so this weaker rule is
    // deliberate: the trailer is already an explicit claim by the author on a
    // file the commit changed, and the classifier's candidates remain the
    // primary lift path. Encoded as a test so the trade stays visible rather
    // than being rediscovered as a bug.
    const payload = fixture('toctou-class');
    payload.commits = [
      {
        sha: 'sss9999',
        date: AFTER,
        message: 'docs: sketch it\n\nReframe: race enforced in guardEveryWrite\n',
        files: ['src/guard.ts'],
        before: { 'src/guard.ts': '// nothing yet\n' },
        after: { 'src/guard.ts': '// export function guardEveryWrite() {}\n' },
      },
    ];
    expect(gate(payload).status).toBe(0);
  });

  it('matches a binding containing a dollar sign as a whole identifier', () => {
    // `$` is a regex metacharacter and not a word character, so the old
    // `\b${name}\b` neither escaped it nor anchored where it appeared to.
    const churning = classify(fixture('dollar-name-seam')).classes[0];
    expect(churning.rounds).toBe(3);
    expect(churning.seamSubstantiated).toBe(true);
    expect(gate(fixture('dollar-name-seam')).status).toBe(3);
  });

  it('says so when a class at three rounds is reported rather than gated', () => {
    // "no finding class has reached 3 rounds" would be false here, and these
    // commands do not print the class table.
    const { status, text } = gate(fixture('guessed-seam'));
    expect(status).toBe(0);
    expect(text).toContain('reported, not gated');
    expect(text).toContain('inv:race @ src/db/messages-out.ts');
    expect(text).toContain('3 rounds');
    expect(text).not.toContain('no finding class has reached 3 rounds');
  });

  it('does not gate a class whose only shared import is a Node internal', () => {
    const { status, decision } = gate(fixture('internal-builtin-seam'));
    expect(status).toBe(0);
    expect(decision.status).toBe('pass');
    expect(decision.report.classes[0].rounds).toBe(3);
  });

  it('does not gate a class whose only shared import is a builtin', () => {
    // Seamed on `path`, the refusal named `path` as the primitive: no diff
    // could lift it, because the lift-by-diff path only matches in-repo
    // modules. A gate whose only exit is the override is worse than no gate.
    const { status, decision } = gate(fixture('builtin-seam'));
    expect(status).toBe(0);
    expect(decision.status).toBe('pass');
    expect(decision.flagged).toHaveLength(0);
  });

  it('passes a PR whose worst class has run two rounds', () => {
    const payload = fixture('toctou-class');
    payload.findings = (payload.findings as { reviewId: string }[]).filter(
      (f) => f.reviewId === 'PRR_1' || f.reviewId === 'PRR_2',
    );
    const { status, decision } = gate(payload);
    expect(status).toBe(0);
    expect(decision.status).toBe('pass');
    expect(decision.report.classes.every((c) => c.rounds < 3)).toBe(true);
  });

  it('gates each seam separately when one invariant runs at two of them', () => {
    const payload = fixture('two-seams');
    const refused = gate(payload);
    expect(refused.status).toBe(3);
    expect(refused.decision.unlifted).toHaveLength(2);

    payload.commits = [
      { sha: 'eee5555', date: AFTER, message: 'fix: guard the mailbox write', files: ['src/mailbox/write.ts'] },
    ];
    const partial = gate(payload);
    expect(partial.status).toBe(3);
    expect(partial.decision.unlifted).toHaveLength(1);
    expect(partial.decision.unlifted[0].seam).toBe('src/db/tasks.ts');
  });

  it('never gates a class with no seam, because nothing could lift it', () => {
    const { status, decision } = gate(fixture('seamless-class'));
    expect(status).toBe(0);
    expect(decision.status).toBe('pass');
    expect(decision.flagged).toHaveLength(0);
    expect(decision.report.classes[0].rounds).toBe(3);
  });

  it('compares commit dates as instants, not strings, across UTC offsets', () => {
    // The last finding is 15:00Z. 09:00-07:00 is 16:00Z — later, though it
    // sorts earlier as a string.
    const later = fixture('toctou-class');
    later.commits = [
      {
        sha: 'fff6666',
        date: '2026-09-01T09:00:00-07:00',
        message: 'fix(mailbox): guard the write',
        files: ['src/mailbox/write.ts'],
      },
    ];
    expect(gate(later).status).toBe(0);

    // 23:00+09:00 is 14:00Z — earlier, though it sorts later.
    const earlier = fixture('toctou-class');
    earlier.commits = [
      {
        sha: 'ggg7777',
        date: '2026-09-01T23:00:00+09:00',
        message: 'chore: earlier work',
        files: ['src/mailbox/write.ts'],
      },
    ];
    expect(gate(earlier).status).toBe(3);
  });

  it('requires the invariant in the trailer when two classes share a primitive', () => {
    const named = fixture('shared-primitive');
    named.commits = [
      {
        sha: 'hhh8888',
        date: AFTER,
        message: 'fix: one guard\n\nReframe: race enforced in writeSessionMessage\n',
        files: ['src/elsewhere.ts'],
      },
    ];
    const one = gate(named);
    expect(one.status).toBe(3);
    expect(one.decision.unlifted).toHaveLength(1);
    expect(one.decision.unlifted[0].signature).toBe('inv:durability');

    const vague = fixture('shared-primitive');
    vague.commits = [
      {
        sha: 'iii9999',
        date: AFTER,
        message: 'fix: one guard\n\nReframe: the write path enforced in writeSessionMessage\n',
        files: ['src/elsewhere.ts'],
      },
    ];
    expect(gate(vague).decision.unlifted).toHaveLength(2);
  });

  it('reads the file either side of a real commit to judge a reframe trailer', () => {
    // The payload can supply both images, so the tests above are hermetic; this
    // one exercises the `git show` path they stand in for, including the rename
    // case, where the pre-image lives at the OLD path and reading the new one
    // would make every line in the file look newly introduced.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-churn-blob-'));
    const git = (date: string, ...args: string[]) => {
      const res = spawnSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });
      if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
      return res.stdout.trim();
    };
    const BEFORE_FINDINGS = '2026-08-01T10:00:00Z';
    const AFTER_FINDINGS = '2026-09-01T16:00:00Z';
    try {
      git(BEFORE_FINDINGS, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(root, 'guard.ts'), '// nothing yet\n');
      git(BEFORE_FINDINGS, 'add', '-A');
      git(BEFORE_FINDINGS, 'commit', '-qm', 'base');

      // The real introduction, after the findings: it lifts.
      fs.writeFileSync(path.join(root, 'guard.ts'), 'export function guardEveryWrite() {}\n');
      git(AFTER_FINDINGS, 'add', '-A');
      git(AFTER_FINDINGS, 'commit', '-qm', 'fix\n\nReframe: race enforced in guardEveryWrite\n');
      const payload = fixture('toctou-class');
      payload.repoRoot = root;
      expect(spawn(['gate', '--json'], payload).status).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    // A commit that only renames the file claims nothing. Its own repository,
    // so the introduction is outside the window and the rename stands alone.
    const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'review-churn-rename-'));
    const gitMoved = (date: string, ...args: string[]) => {
      const res = spawnSync('git', args, {
        cwd: moved,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });
      if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
      return res.stdout.trim();
    };
    try {
      gitMoved(BEFORE_FINDINGS, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(moved, 'guard.ts'), 'export function guardEveryWrite() {}\n');
      gitMoved(BEFORE_FINDINGS, 'add', '-A');
      gitMoved(BEFORE_FINDINGS, 'commit', '-qm', 'the primitive, long before these findings');

      gitMoved(AFTER_FINDINGS, 'mv', 'guard.ts', 'guard-renamed.ts');
      gitMoved(AFTER_FINDINGS, 'commit', '-qm', 'chore: move it\n\nReframe: race enforced in guardEveryWrite\n');

      const payload = fixture('toctou-class');
      payload.repoRoot = moved;
      expect(spawn(['gate', '--json'], payload).status).toBe(3);
    } finally {
      fs.rmSync(moved, { recursive: true, force: true });
    }
  });

  it('reads commits back to the oldest finding, not a fixed history cap', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-churn-git-'));
    const git = (...args: string[]) => {
      const res = spawnSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2026-09-01T16:00:00Z',
          GIT_COMMITTER_DATE: '2026-09-01T16:00:00Z',
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      });
      if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
    };
    try {
      git('init', '-q', '-b', 'main');
      fs.mkdirSync(path.join(root, 'src/mailbox'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src/mailbox/write.ts'), 'export function writeSessionMessage() {}\n');
      git('add', '-A');
      git('commit', '-qm', 'fix(mailbox): guard the write');
      // 34 later commits, so the reframe above falls outside any `-n 30` cap.
      for (let i = 0; i < 34; i += 1) git('commit', '-q', '--allow-empty', '-m', `filler ${i}`);

      const payload = fixture('toctou-class');
      payload.repoRoot = root;
      const { status, decision } = gate(payload);
      expect(status).toBe(0);
      expect(decision.flagged[0].liftedBy).toBe('diff touches the primitive');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('skill wiring', () => {
  // The loop runs on the host AND inside agent containers, which mount
  // container/skills/. There is exactly one copy — the host path is a symlink
  // into the container tree — and a gate that exists in only one of them is a
  // gate half the fleet does not have. This asserts the link, because turning
  // it into a real directory is how the two would silently drift.
  it('serves one copy to the host and the container', () => {
    const host = path.resolve('.claude/skills/pr-review-loop');
    expect(fs.lstatSync(host).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(host)).toBe('../../container/skills/pr-review-loop');
    expect(fs.realpathSync(SCRIPT)).toBe(fs.realpathSync(CONTAINER_SCRIPT));
  });

  it('ships the classifier executable next to the helper', () => {
    expect(fs.existsSync(CONTAINER_SCRIPT)).toBe(true);
    expect(fs.statSync(CONTAINER_SCRIPT).mode & 0o111).toBeGreaterThan(0);
  });

  it('routes the push subcommand through the gate, and records the override only after the push', () => {
    const helper = fs.readFileSync(path.resolve('container/skills/pr-review-loop/scripts/codex-review.sh'), 'utf8');
    // gate → push → record, in that order. Recording is a claim that a site
    // patch was pushed, so a refused push must not leave it in the PR body.
    expect(helper).toMatch(
      /push\)\n[\s\S]*?run_gate\n\s+shift\n\s+git push "\$@"\n\s+if \[ -n "\$GATE_OVERRIDE_LINE" \]; then\n\s+record_site_patch_override/,
    );
    // Evaluating the gate writes nothing at all.
    const gateBranch = helper.slice(helper.indexOf('  gate)'), helper.indexOf('  push)'));
    expect(gateBranch).not.toContain('record_site_patch_override');
    expect(helper.slice(helper.indexOf('run_gate() {'), helper.indexOf('case "${1'))).not.toContain(
      'record_site_patch_override',
    );
  });
});
