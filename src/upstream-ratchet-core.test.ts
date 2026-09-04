/**
 * Upstream-ownership ratchet — the arbitrator's boundary matrix.
 *
 * `scripts/upstream-ratchet-report.ts` is what decides GROWTH vs SHRINK, what
 * `--write` may write, and whether the tree can be measured at all. None of that
 * could be tested while it lived inside the script: `src/test-hermeticity.ts`
 * mocks `child_process` for every host suite, so a test can never drive the CLI.
 * The decisions live in `src/upstream-ratchet-core.ts` as pure functions over
 * strings and maps, and this suite drives them directly.
 *
 * RESIDUE: no test here proves that real `git` output has the shape the parsers
 * expect, or that the script calls them in the right order. That is covered by
 * running the script for real — the CI job fetches the pinned commit and runs
 * the report on every PR.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { enforceHermeticity, hermeticityAttempts } from './test-hermeticity.js';
import {
  buildManifest,
  classify,
  findUntrackedShadows,
  isBlocking,
  parseLsFiles,
  parseLsTree,
  parseNumstat,
  RatchetError,
  writeGate,
  type NumstatRecord,
  type Row,
} from './upstream-ratchet-core.js';
import {
  sealManifest,
  type GitMode,
  type UpstreamRatchetEntry,
  type UpstreamRatchetManifest,
} from './upstream-ratchet.js';

beforeAll(() => enforceHermeticity());

const NUL = '\0';
const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

function manifestOf(files: Record<string, UpstreamRatchetEntry>): UpstreamRatchetManifest {
  return sealManifest({ upstream: 'a'.repeat(40), paths: '', files });
}

function verdictOf(rows: readonly Row[], relPath: string): string {
  const row = rows.find((r) => r.path === relPath);
  return row === undefined ? 'ABSENT' : row.verdict;
}

describe('parsing git output', () => {
  it('reads modes and paths out of ls-tree, including spaces and non-ASCII', () => {
    const stdout =
      `100644 blob aaaa\tsrc/router.ts${NUL}` +
      `100755 blob bbbb\tbin/ncl${NUL}` +
      `120000 blob cccc\tAGENTS.md${NUL}` +
      `100644 blob dddd\tdocs/a naïve file.md${NUL}`;
    expect([...parseLsTree(stdout)]).toEqual([
      ['src/router.ts', '100644'],
      ['bin/ncl', '100755'],
      ['AGENTS.md', '120000'],
      ['docs/a naïve file.md', '100644'],
    ]);
  });

  it('refuses a submodule on either side rather than recording it as something else', () => {
    // A gitlink has no bytes to hash and no lines to count, so every check the
    // ratchet makes would be vacuously true for it.
    expect(() => parseLsTree(`160000 commit abcd\tvendor/thing${NUL}`)).toThrow(RatchetError);
    expect(() => parseLsTree(`160000 commit abcd\tvendor/thing${NUL}`)).toThrow(/submodules are not supported/);
    expect(() =>
      buildManifest({
        upstream: 'a'.repeat(40),
        upstreamModes: new Map<string, GitMode>([['vendor/thing', '100644']]),
        forkIndex: new Map([['vendor/thing', '160000']]),
        numstat: new Map(),
        modeOf: () => '100644',
        hashOf: () => hash('1'),
      }),
    ).toThrow(/gitlink in the fork/);
  });

  it('rejects an unknown mode instead of coercing it', () => {
    expect(() => parseLsTree(`100777 blob abcd\tweird${NUL}`)).toThrow(/unexpected git mode/);
  });

  it('reads ls-files stage records for the tracked set', () => {
    const stdout = `100644 aaaa 0\tsrc/router.ts${NUL}120000 bbbb 0\tAGENTS.md${NUL}`;
    expect([...parseLsFiles(stdout)]).toEqual([
      ['src/router.ts', '100644'],
      ['AGENTS.md', '120000'],
    ]);
  });

  it('sums added and deleted lines and marks binary records', () => {
    const stdout = `12\t7\tsrc/router.ts${NUL}0\t40\tdocs/gone.md${NUL}-\t-\tassets/logo.png${NUL}`;
    const stats = parseNumstat(stdout);
    expect(stats.get('src/router.ts')).toEqual({ lines: 19 });
    expect(stats.get('docs/gone.md')).toEqual({ lines: 40 });
    expect(stats.get('assets/logo.png')).toEqual({ lines: null });
    // An empty diff is an empty map, not a parse error.
    expect(parseNumstat('').size).toBe(0);
  });

  it('refuses a malformed record rather than guessing', () => {
    expect(() => parseNumstat(`12 7 src/router.ts${NUL}`)).toThrow(/could not parse numstat record/);
    expect(() => parseNumstat(`x\ty\tsrc/router.ts${NUL}`)).toThrow(/could not parse numstat counts/);
    expect(() => parseLsTree(`100644 blob aaaa src/router.ts${NUL}`)).toThrow(/could not parse ls-tree record/);
  });
});

describe('untracked shadows', () => {
  const upstream = ['docs/gone.md', 'src/router.ts', 'templates/README.md'];

  it('flags an upstream path that exists on disk but is not tracked', () => {
    // `git diff <commit>` only looks at tracked paths, so this path reads as
    // fully deleted while lstat and hashFile happily consume whatever is there.
    const tracked = new Set(['src/router.ts']);
    const exists = (p: string): boolean => p !== 'templates/README.md';
    expect(findUntrackedShadows(upstream, tracked, exists)).toEqual(['docs/gone.md']);
  });

  it('flags an IGNORED shadow, which an untracked-file enumeration would miss', () => {
    // This is the hole in `git ls-files -o --exclude-standard`: it omits ignored
    // files by default, and a fork-deleted upstream path recreated as an ignored
    // file is exactly the case worth catching. Asking "is it tracked?" has no
    // such exception — an ignored file is not tracked either.
    expect(findUntrackedShadows(['logs/app.log'], new Set(), () => true)).toEqual(['logs/app.log']);
  });

  it('flags a path that is now a directory', () => {
    // A directory is not a tracked path and it lstat-exists, so the same rule
    // covers it with nothing extra.
    expect(findUntrackedShadows(['docs/gone.md'], new Set(['docs/gone.md/inner.md']), () => true)).toEqual([
      'docs/gone.md',
    ]);
  });

  it('is silent on a genuinely deleted path and on a tracked one', () => {
    expect(findUntrackedShadows(upstream, new Set(upstream), () => true)).toEqual([]);
    expect(findUntrackedShadows(upstream, new Set(), () => false)).toEqual([]);
  });
});

describe('building entries from the working tree', () => {
  const base = {
    upstream: 'a'.repeat(40),
    forkIndex: new Map<string, string>(),
    hashOf: (): string | null => hash('1'),
  };

  function build(
    upstreamModes: Array<[string, GitMode]>,
    numstat: Array<[string, NumstatRecord]>,
    modeOf: (p: string) => GitMode | null,
    hashOf: (p: string) => string | null = base.hashOf,
  ): Record<string, UpstreamRatchetEntry> {
    return buildManifest({
      upstream: base.upstream,
      upstreamModes: new Map(upstreamModes),
      forkIndex: new Map(upstreamModes.map(([p]) => [p, '100644'])),
      numstat: new Map(numstat),
      modeOf,
      hashOf,
    }).files;
  }

  it('scores an identical file zero', () => {
    expect(build([['a.md', '100644']], [], () => '100644')['a.md']).toEqual({
      diff: 0,
      mode: '100644',
      sha256: hash('1'),
    });
  });

  it('counts a mode-only change as one unit, which nothing else would see', () => {
    // Identical bytes and an empty numstat: without the mode term the whole
    // ratchet reports UNCHANGED for `chmod -x`.
    expect(build([['bin/x', '100755']], [], () => '100644')['bin/x']).toEqual({
      diff: 1,
      mode: '100644',
      sha256: hash('1'),
    });
  });

  it('adds the mode unit on top of the line delta', () => {
    expect(build([['bin/x', '100644']], [['bin/x', { lines: 9 }]], () => '100755')['bin/x'].diff).toBe(10);
  });

  it('records upstream mode and the full line count for a fork-deleted path', () => {
    expect(
      build(
        [['gone.md', '100755']],
        [['gone.md', { lines: 40 }]],
        () => null,
        () => null,
      )['gone.md'],
    ).toEqual({
      diff: 40,
      mode: '100755',
      sha256: null,
      deleted: true,
    });
  });

  it('scores a differing binary one unit for its bytes', () => {
    expect(build([['logo.png', '100644']], [['logo.png', { lines: null }]], () => '100644')['logo.png']).toEqual({
      diff: 1,
      mode: '100644',
      sha256: hash('1'),
      binary: true,
    });
    // Plus the mode unit when that moved too.
    expect(build([['logo.png', '100755']], [['logo.png', { lines: null }]], () => '100644')['logo.png'].diff).toBe(2);
  });

  it('refuses a path the manifest could not safely address', () => {
    expect(() => build([['../escape.md' as string, '100644']], [], () => '100644')).toThrow(/unusable path/);
  });
});

describe('classification boundary matrix', () => {
  const present = (diff: number, extra: Partial<UpstreamRatchetEntry> = {}): UpstreamRatchetEntry => ({
    diff,
    mode: '100644',
    sha256: hash('1'),
    ...extra,
  });

  it('names growth, shrink, stale, new and unchanged', () => {
    const before = manifestOf({
      grew: present(10),
      shrank: present(10),
      stale: present(10),
      fresh: present(0),
      same: present(10),
    });
    const after = manifestOf({
      grew: present(11),
      shrank: present(4),
      stale: present(0),
      fresh: present(3),
      same: present(10),
    });
    const rows = classify(before, after);
    expect(verdictOf(rows, 'grew')).toBe('GROWTH');
    expect(verdictOf(rows, 'shrank')).toBe('SHRINK');
    expect(verdictOf(rows, 'stale')).toBe('STALE');
    expect(verdictOf(rows, 'fresh')).toBe('NEW');
    expect(verdictOf(rows, 'same')).toBe('UNCHANGED');
    // Only the first two stop a build. Shrink is always allowed; a stale entry
    // owes a regeneration but has moved TOWARD upstream.
    expect(
      rows
        .filter((r) => isBlocking(r.verdict))
        .map((r) => r.path)
        .sort(),
    ).toEqual(['fresh', 'grew']);
  });

  it('treats a presence flip in either direction as blocking', () => {
    const deleted = (diff: number): UpstreamRatchetEntry => ({ diff, mode: '100644', sha256: null, deleted: true });
    const dropped = classify(manifestOf({ f: present(4) }), manifestOf({ f: deleted(40) }));
    expect(verdictOf(dropped, 'f')).toBe('NEW');
    const restored = classify(manifestOf({ f: deleted(40) }), manifestOf({ f: present(4) }));
    expect(verdictOf(restored, 'f')).toBe('GROWTH');
    expect(restored.find((r) => r.path === 'f')?.reason).toBe('restored in fork');
  });

  it('blocks a binary whose bytes changed while its diff stayed at one', () => {
    // Every differing binary scores 1 forever, so swapping it for arbitrary new
    // bytes moves no number at all — the one case where the line count is not a
    // measurement.
    const bin = (sha: string): UpstreamRatchetEntry => ({ diff: 1, mode: '100644', sha256: sha, binary: true });
    const changed = classify(manifestOf({ 'logo.png': bin(hash('1')) }), manifestOf({ 'logo.png': bin(hash('2')) }));
    expect(verdictOf(changed, 'logo.png')).toBe('GROWTH');
    expect(changed[0].reason).toBe('binary bytes changed');

    // NEW: was byte-identical, now divergent.
    const fresh = classify(
      manifestOf({ 'logo.png': { diff: 0, mode: '100644', sha256: hash('1') } }),
      manifestOf({ 'logo.png': bin(hash('2')) }),
    );
    expect(verdictOf(fresh, 'logo.png')).toBe('NEW');

    // Restored to upstream's bytes: a shrink, always allowed.
    const restored = classify(
      manifestOf({ 'logo.png': bin(hash('1')) }),
      manifestOf({ 'logo.png': { diff: 0, mode: '100644', sha256: hash('9') } }),
    );
    expect(verdictOf(restored, 'logo.png')).toBe('STALE');
    expect(isBlocking('STALE')).toBe(false);

    // Same bytes, same diff: nothing happened.
    const idle = classify(manifestOf({ 'logo.png': bin(hash('1')) }), manifestOf({ 'logo.png': bin(hash('1')) }));
    expect(verdictOf(idle, 'logo.png')).toBe('UNCHANGED');
  });

  it('blocks a mode change even when the diff total does not move', () => {
    // The mode unit normally surfaces as GROWTH on its own. This is the case it
    // cannot: a mode change and a one-line shrink that cancel out.
    const rows = classify(
      manifestOf({ 'bin/x': { diff: 5, mode: '100755', sha256: hash('1') } }),
      manifestOf({ 'bin/x': { diff: 5, mode: '100644', sha256: hash('1') } }),
    );
    expect(verdictOf(rows, 'bin/x')).toBe('GROWTH');
    expect(rows[0].reason).toBe('mode 100755 → 100644');
  });

  it('does NOT block a text file re-edited to the same line count', () => {
    // Deliberate: for text, added+deleted IS the metric, and an equal-size edit
    // has not grown the fork's divergence. Blocking it would make every reformat
    // need an --accept and train people to reach for --accept-all.
    const rows = classify(
      manifestOf({ 'src/router.ts': present(20) }),
      manifestOf({ 'src/router.ts': present(20, { sha256: hash('7') }) }),
    );
    expect(verdictOf(rows, 'src/router.ts')).toBe('UNCHANGED');
  });

  it('reports a path that left upstream and never fails for it', () => {
    const rows = classify(manifestOf({ old: present(9) }), manifestOf({}));
    expect(verdictOf(rows, 'old')).toBe('DROPPED');
    expect(isBlocking('DROPPED')).toBe(false);
  });

  it('treats an unlisted path as NEW, which is what a first pin produces', () => {
    const rows = classify(manifestOf({}), manifestOf({ anything: present(0) }));
    expect(verdictOf(rows, 'anything')).toBe('NEW');
  });

  it('sorts rows by path so two regenerations produce the same report', () => {
    const rows = classify(manifestOf({}), manifestOf({ b: present(1), a: present(1), c: present(1) }));
    expect(rows.map((r) => r.path)).toEqual(['a', 'b', 'c']);
  });
});

describe('the write gate', () => {
  const rows: Row[] = [
    {
      verdict: 'GROWTH',
      path: 'src/host-sweep.ts',
      before: 10,
      after: 11,
      deletedBefore: false,
      deletedAfter: false,
      reason: null,
    },
    { verdict: 'NEW', path: 'a file.md', before: 0, after: 4, deletedBefore: false, deletedAfter: false, reason: null },
    {
      verdict: 'SHRINK',
      path: 'src/router.ts',
      before: 10,
      after: 2,
      deletedBefore: false,
      deletedAfter: false,
      reason: null,
    },
    {
      verdict: 'STALE',
      path: 'tsconfig.json',
      before: 5,
      after: 0,
      deletedBefore: false,
      deletedAfter: false,
      reason: null,
    },
    {
      verdict: 'UNCHANGED',
      path: 'README.md',
      before: 3,
      after: 3,
      deletedBefore: false,
      deletedAfter: false,
      reason: null,
    },
    {
      verdict: 'DROPPED',
      path: 'old.md',
      before: 2,
      after: 0,
      deletedBefore: false,
      deletedAfter: false,
      reason: null,
    },
  ];

  it('blocks only growth and new divergence', () => {
    const gate = writeGate(rows, new Set(), false);
    expect(gate.blocking.map((r) => r.path).sort()).toEqual(['a file.md', 'src/host-sweep.ts']);
    expect(gate.unaccepted.map((r) => r.path).sort()).toEqual(['a file.md', 'src/host-sweep.ts']);
  });

  it('clears exactly the accepted paths and no others', () => {
    const partial = writeGate(rows, new Set(['src/host-sweep.ts']), false);
    expect(partial.unaccepted.map((r) => r.path)).toEqual(['a file.md']);
    // Accepting a path that is not blocking changes nothing.
    const irrelevant = writeGate(rows, new Set(['src/router.ts']), false);
    expect(irrelevant.unaccepted.map((r) => r.path).sort()).toEqual(['a file.md', 'src/host-sweep.ts']);
    const both = writeGate(rows, new Set(['src/host-sweep.ts', 'a file.md']), false);
    expect(both.unaccepted).toEqual([]);
    expect(both.blocking).toHaveLength(2);
  });

  it('accept-all clears everything, which is what a re-pin implies', () => {
    const gate = writeGate(rows, new Set(), true);
    expect(gate.unaccepted).toEqual([]);
    expect(gate.blocking).toHaveLength(2);
  });

  it('lets a clean tree through', () => {
    expect(
      writeGate(
        rows.filter((r) => !isBlocking(r.verdict)),
        new Set(),
        false,
      ).unaccepted,
    ).toEqual([]);
  });
});

describe('hermeticity', () => {
  it('the core module never spawns a subprocess or reaches the network', () => {
    expect(hermeticityAttempts().map((a) => `${a.kind} ${a.api}(${a.target})`)).toEqual([]);
  });
});
