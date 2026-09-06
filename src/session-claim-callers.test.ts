/**
 * Ratchet: `tryClaimSession` is the only path that may start a container, and
 * exactly one function calls it.
 *
 * The compare-and-set on `session_claims.incarnation` is the cross-process
 * spawn fence (plan §4.1, "Invariant in a primitive, part 1"). It only fences
 * what goes through it: a second call site that claims on its own terms — a
 * different expected incarnation, a claim taken after the runtime state was
 * already touched, a claim never released — reopens the window the CAS exists
 * to close. Pinning the caller set as a file/function list makes that a diff
 * nobody can add by accident.
 *
 * The list may SHRINK, never grow. Seam 4 series E adds `adoptRunningSessions`
 * in its own PR, deliberately and visibly — the same shape seam 3 uses for
 * `getRawDb` (src/db/raw-db-ratchet.test.ts) and seam 2 for `computeOffenders`.
 * The adopter claims THROUGH `claimSessionRun` rather than beside it (it is
 * the same fence with the container half skipped, plan §4.3.4), so the growth
 * is visible one layer up: `CLAIM_SESSION_RUN_CALLERS` pins the functions that
 * reach the fence, and `adoptRunningSessions` is the one entry E adds.
 *
 * Scope note: this counts any reference to the identifier in a file with
 * comments stripped, not only a static `import` — a dynamic `await import(...)`
 * destructuring or a `vi.mock` factory property reaches the seam just as well,
 * and an import-only scan would let one in for free.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['src', 'scripts', 'setup'] as const;

/**
 * Not callers, and excluded from the scan:
 *  - `db/coordination.ts` defines the function (byte-identical to upstream) and
 *    `db/coordination.test.ts` is its own unit suite — the CAS's semantics are
 *    proved there, one layer below the fence this file pins.
 *  - this file names it in its own matcher, so it would otherwise match itself.
 *  - `session-claim-spawn.test.ts` is the acceptance suite for the one caller;
 *    it wraps the real accessor to inject a lost CAS and a failed write, which
 *    is the only way a single process can produce either.
 *  - `container-adoption.test.ts` and `container-supervision-channel.test.ts`
 *    (seam 4 E) wrap it the same way, to inject the failed write the
 *    pending-adoption cases need.
 */
const NOT_CALLERS: readonly string[] = [
  'src/container-adoption.test.ts',
  'src/container-supervision-channel.test.ts',
  'src/db/coordination.test.ts',
  'src/db/coordination.ts',
  'src/session-claim-callers.test.ts',
  'src/session-claim-spawn.test.ts',
];

/**
 * Every file that reaches `tryClaimSession`, and the function inside it that
 * does. One entry, and the fence's whole surface area.
 */
export const TRY_CLAIM_SESSION_CALLERS: ReadonlyArray<{ file: string; fn: string }> = [
  { file: 'src/container-runner.ts', fn: 'claimSessionRun' },
];

/**
 * Every function that reaches the fence itself. Two entries and no more: the
 * spawn path, and the boot-time adopter that takes over a survivor of the
 * previous host under `{ adopting: true }`.
 */
export const CLAIM_SESSION_RUN_CALLERS: ReadonlyArray<{ file: string; fn: string }> = [
  // The per-container adopter step, shared by the boot pass (`adoptRunningSessions`)
  // and the wake-path retry (`retryPendingAdoption`, P4).
  { file: 'src/container-runner.ts', fn: 'adoptRunningSession' },
  { file: 'src/container-runner.ts', fn: 'spawnContainer' },
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

/**
 * Blank out `import … from '…'` statements, single- and multi-line, keeping
 * every character position so reported line numbers stay true. An import
 * BINDING is not a call site, and a formatter wrapping one across lines must
 * not read as a second claimant.
 */
function blankImports(source: string): string {
  return source.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?/gm, (match) => match.replace(/[^\n]/g, ' '));
}

function listTsFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts'))
        out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
    }
  };
  for (const root of SCAN_ROOTS) walk(path.join(REPO_ROOT, root));
  return out.sort();
}

function currentCallerFiles(): string[] {
  return listTsFiles()
    .filter((rel) => !NOT_CALLERS.includes(rel))
    .filter((rel) => /\btryClaimSession\b/.test(stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))));
}

describe('tryClaimSession has exactly one caller', () => {
  it('scans a tree that actually contains the seam', () => {
    // Guards the scanner: a broken walk would report an empty set and pass the
    // shrink assertion below while checking nothing.
    const files = listTsFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('src/db/coordination.ts');
    expect(files).toContain('src/session-claim-callers.test.ts');
  });

  it('the caller files are exactly the pinned set', () => {
    const pinned = new Set(TRY_CLAIM_SESSION_CALLERS.map((caller) => caller.file));
    const added = currentCallerFiles().filter((file) => !pinned.has(file));
    expect(
      added,
      'a NEW file claims a session. The claim is the only path that may start or adopt a container, and it lives ' +
        'in ONE function (claimSessionRun, src/container-runner.ts) so the CAS, the release and the ordering ' +
        'against the heartbeat clear are decided in one place. Route the new caller through it, or extend this ' +
        'list deliberately. See docs/specs/upstream-restart-survival-seam/plan.md §4.1.',
    ).toEqual([]);
  });

  it('records removals so the pin cannot rot into a stale list', () => {
    const current = new Set(currentCallerFiles());
    const removed = TRY_CLAIM_SESSION_CALLERS.map((caller) => caller.file).filter((file) => !current.has(file));
    expect(
      removed,
      'these pinned files no longer claim a session — delete them from TRY_CLAIM_SESSION_CALLERS in this commit',
    ).toEqual([]);
  });

  it('each pinned file claims from the pinned function, and only there', () => {
    for (const { file, fn } of TRY_CLAIM_SESSION_CALLERS) {
      const source = blankImports(stripComments(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')));
      const declaration = source.indexOf(`function ${fn}(`);
      expect(declaration, `${file} no longer declares ${fn}`).toBeGreaterThan(-1);

      // The call sites, minus the import binding: every one must fall inside
      // the pinned function's body, which ends at the next top-level `\n}`.
      const bodyEnd = source.indexOf('\n}\n', declaration);
      expect(bodyEnd, `${fn} has no top-level body end in ${file}`).toBeGreaterThan(declaration);
      const callSites = [...source.matchAll(/\btryClaimSession\b/g)].map((match) => match.index);
      const outside = callSites.filter((index) => index < declaration || index > bodyEnd);
      expect(
        outside.map((index) => source.slice(0, index).split('\n').length),
        `${file} claims outside ${fn}`,
      ).toEqual([]);
      // Not vacuous: the pinned function really does claim.
      expect(callSites.filter((index) => index > declaration && index < bodyEnd).length).toBeGreaterThan(0);
    }
  });

  it('is sorted and free of duplicates, so two PRs merge instead of colliding', () => {
    const files = TRY_CLAIM_SESSION_CALLERS.map((caller) => caller.file);
    expect(files).toEqual([...files].sort());
    expect(new Set(files).size).toBe(files.length);
  });
});

/**
 * The span of a top-level function declaration in `source`: from its
 * `function <name>(` to the next top-level `\n}\n`.
 */
function functionSpan(source: string, fn: string): { start: number; end: number } {
  const start = source.indexOf(`function ${fn}(`);
  expect(start, `no top-level declaration of ${fn}`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}\n', start);
  expect(end, `${fn} has no top-level body end`).toBeGreaterThan(start);
  return { start, end };
}

describe('claimSessionRun is reached from exactly the pinned functions', () => {
  it('every call site falls inside a pinned function, and each pinned function calls it', () => {
    const file = 'src/container-runner.ts';
    const source = blankImports(stripComments(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')));
    const declaration = functionSpan(source, 'claimSessionRun');
    const spans = CLAIM_SESSION_RUN_CALLERS.map(({ fn }) => ({ fn, ...functionSpan(source, fn) }));

    const callSites = [...source.matchAll(/\bclaimSessionRun\b/g)]
      .map((match) => match.index)
      // The declaration itself is not a call.
      .filter((index) => index < declaration.start || index > declaration.end);
    const unpinned = callSites.filter((index) => !spans.some((span) => index > span.start && index < span.end));
    expect(
      unpinned.map((index) => source.slice(0, index).split('\n').length),
      'a NEW function claims a session. The claim fence has two callers by design — the spawn path and the ' +
        'boot-time adopter — and a third reopens the window it closes. Route the caller through one of them, ' +
        'or extend CLAIM_SESSION_RUN_CALLERS deliberately.',
    ).toEqual([]);
    for (const span of spans) {
      expect(
        callSites.filter((index) => index > span.start && index < span.end).length,
        `${span.fn} no longer claims — drop it from CLAIM_SESSION_RUN_CALLERS in this commit`,
      ).toBeGreaterThan(0);
    }
    // The other callers file: no second file may reach the fence at all.
    const others = listTsFiles()
      .filter((rel) => rel !== file && !NOT_CALLERS.includes(rel))
      .filter((rel) => /\bclaimSessionRun\b/.test(stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))));
    expect(others).toEqual([]);
  });

  it('is sorted by function and free of duplicates', () => {
    const fns = CLAIM_SESSION_RUN_CALLERS.map((caller) => caller.fn);
    expect(fns).toEqual([...fns].sort());
    expect(new Set(fns).size).toBe(fns.length);
  });
});
