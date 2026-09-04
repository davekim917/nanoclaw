#!/usr/bin/env tsx
/**
 * Upstream-ownership ratchet — the git half.
 *
 * `src/upstream-ratchet.ts` (and the vitest suite over it) can only prove the
 * manifest is CURRENT: it has no git and, in CI, no upstream commit objects
 * until this tool's own CI step fetches them. This script is where the
 * arbitration runs. It recomputes every upstream-owned path's divergence against
 * the PINNED commit and compares that to the committed manifest:
 *
 *   GROWTH     the fork diverged further in that file        → fails
 *   NEW        the file was byte-identical and no longer is,
 *              or was present and is now deleted             → fails
 *   SHRINK     the fork moved back toward upstream           → always allowed
 *   STALE      recorded as divergent, now byte-identical     → allowed, but the
 *              manifest owes a regeneration
 *   UNCHANGED  same divergence as recorded
 *   DROPPED    the path left upstream's tree (re-pin only)   → never a failure
 *
 * Modes:
 *   (default)              report; exit 1 on any GROWTH or NEW, else 0
 *   --write                regenerate src/upstream-ratchet.json; REFUSES while
 *                          any GROWTH or NEW path is not named by --accept
 *   --accept <path>        (repeatable, `--accept=<path>` too) permit one path
 *   --accept-all           permit all of them
 *   --upstream <rev>       re-pin; resolves <rev> with `git rev-parse --verify`
 *                          and persists the full 40-hex commit id. Implies
 *                          --write and --accept-all, because re-pinning changes
 *                          every number for reasons outside the fork
 *   --root <dir>           repo to operate on (default: this script's checkout)
 *   --json                 machine-readable output
 *
 * Exit 2 (not 1) when the pinned commit is not in the clone: that is "cannot
 * measure", not "the ratchet failed", and CI needs to tell them apart.
 *
 * This file holds NO decisions. Parsing, entry building, classification and the
 * write gate all live in `src/upstream-ratchet-core.ts` so they can be tested
 * without a subprocess; what is left here is git invocation, filesystem access,
 * rendering and the exit code.
 *
 * Cost: five whole-tree git calls (`rev-parse`, `ls-tree`, `ls-files`,
 * `diff --numstat`, `check-ignore --stdin`), never a per-file one.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildManifest,
  classify,
  findUntrackedShadows,
  parseLsFiles,
  parseLsTree,
  parseNumstat,
  RatchetError,
  writeGate,
  type Row,
  type Verdict,
} from '../src/upstream-ratchet-core.js';
import {
  acceptFlag,
  divergentEntries,
  fileModeOf,
  hashFile,
  manifestPath,
  pathExists,
  readManifest,
  sealManifest,
  shellQuote,
  totalDiffLines,
  writeManifest,
  type UpstreamRatchetManifest,
} from '../src/upstream-ratchet.js';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Options {
  root: string;
  write: boolean;
  accept: Set<string>;
  acceptAll: boolean;
  upstream: string | null;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    root: SCRIPT_ROOT,
    write: false,
    accept: new Set<string>(),
    acceptAll: false,
    upstream: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      // A path may legitimately begin with a dash, so `--accept -- -weird.md`
      // has to stay possible; only a missing value is an error.
      if (value === undefined) fail(`${arg} needs a value`);
      i += 1;
      return value;
    };
    // `--flag=value` as well as `--flag value`: a path starting with a dash is
    // unambiguous in the first form, and shells and CI configs prefer it.
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);

    if (name === '--root') options.root = path.resolve(inline ?? next());
    else if (name === '--write') options.write = true;
    else if (name === '--accept') options.accept.add(normalizeRel(inline ?? next()));
    else if (name === '--accept-all') options.acceptAll = true;
    else if (name === '--upstream') options.upstream = inline ?? next();
    else if (name === '--json') options.json = true;
    else if (name === '--help' || name === '-h') usage();
    // `pnpm run ratchet:report -- --write` can forward a bare `--`.
    else if (arg !== '--') fail(`unknown argument: ${arg}`);
  }
  if (options.upstream !== null) {
    // Re-pinning moves the base under every path at once. There is no honest
    // per-path arbitration to do, so it writes and accepts everything, with the
    // full delta printed for review.
    options.write = true;
    options.acceptAll = true;
  }
  return options;
}

function normalizeRel(p: string): string {
  return p.split(path.sep).join('/').replace(/^\.\//, '');
}

function fail(message: string): never {
  console.error(`upstream-ratchet: ${message}`);
  process.exit(1);
}

function usage(): never {
  console.log(
    [
      'Usage: tsx scripts/upstream-ratchet-report.ts [--root <dir>] [--json]',
      '       tsx scripts/upstream-ratchet-report.ts --write [--accept <path>]... [--accept-all]',
      '       tsx scripts/upstream-ratchet-report.ts --upstream <rev>',
      '',
      'Reports the fork divergence recorded in src/upstream-ratchet.json against the pinned',
      'upstream commit. Exits 1 when any upstream-owned file grew its diff or became newly',
      'divergent; shrink is always allowed. Exits 2 when the pinned commit is not in this',
      'clone. See docs/upstream-ratchet.md.',
    ].join('\n'),
  );
  process.exit(0);
}

// ── git ──────────────────────────────────────────────────────────────────────

function git(root: string, args: string[], quiet = false): string {
  return execFileSync('git', ['-C', root, ...args], {
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
    // A probe that is EXPECTED to fail should not print git's own `fatal:` line
    // over the actionable message this script is about to give instead.
    stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'inherit'],
  });
}

/**
 * The full 40-hex commit id `rev` names, or exit 2 with the fetch to run.
 *
 * Everything downstream stores and compares this value, so a short sha, a tag or
 * a branch name has to be resolved here rather than written into the manifest
 * verbatim — `upstream/main` persisted literally would have made the pin move
 * under the fork, which is the one thing the pin exists to prevent.
 */
function resolveCommit(root: string, rev: string): string {
  let resolved: string;
  try {
    resolved = git(root, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`], true).trim();
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    void error;
    console.error(
      `upstream-ratchet: upstream commit ${rev} is not in this clone.\n` +
        `  run: git fetch upstream ${shellQuote(rev)}`,
    );
    process.exit(2);
  }
  if (!/^[0-9a-f]{40}$/.test(resolved)) fail(`git resolved ${rev} to ${JSON.stringify(resolved)}, not a commit sha`);
  return resolved;
}

/**
 * Which of `paths` the fork's `.gitignore` covers.
 *
 * `git check-ignore` is INDEX-AWARE by default: it never reports a tracked path,
 * so every path this returns is one the fork does not track. That is what makes
 * `ignored` safe to imply `deleted` on the entry.
 *
 * One `--stdin` call for the whole set (53 ms for 959 paths), not one call per
 * path. It exits 1 when nothing matches, which is a normal answer and not a
 * failure — hence the catch.
 */
function gitIgnored(root: string, paths: readonly string[]): Set<string> {
  if (paths.length === 0) return new Set();
  let stdout: string;
  try {
    stdout = execFileSync('git', ['-C', root, 'check-ignore', '-z', '--stdin'], {
      input: paths.join('\0'),
      maxBuffer: 512 * 1024 * 1024,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (error) {
    // Exit 1 means "none of them are ignored", and the child still wrote its
    // (empty) stdout. Anything without stdout is a real failure.
    const output = (error as { stdout?: string }).stdout;
    if (typeof output !== 'string') throw error;
    stdout = output;
  }
  return new Set(stdout.split('\0').filter(Boolean));
}

/**
 * The manifest the working tree implies right now, measured against `sha`.
 *
 * `git diff <commit>` compares the commit to the WORKING TREE, so an uncommitted
 * edit is measured — that is deliberate: the report is meant to be run before a
 * commit as much as after one. It also only ever looks at TRACKED paths, which
 * is why the shadow check below exists.
 */
export function computeFromGit(root: string, sha: string): UpstreamRatchetManifest {
  const upstreamModes = parseLsTree(git(root, ['ls-tree', '-r', '-z', sha]));
  const forkIndex = parseLsFiles(git(root, ['ls-files', '-s', '-z']));
  const numstat = parseNumstat(git(root, ['diff', '--numstat', '--no-renames', '-z', sha]));
  const paths = [...upstreamModes.keys()];

  // Gitlink and ignored/tracked refusals live in buildManifest, so they are one
  // rule with unit tests rather than a lexical copy here that could drift. Its
  // exact-path check was also the weaker one: it missed a submodule standing
  // ABOVE upstream-owned files.
  const ignored = gitIgnored(root, paths);
  const shadowed = findUntrackedShadows(
    paths,
    new Set(forkIndex.keys()),
    (rel) => pathExists(path.join(root, rel)),
    ignored,
  );
  if (shadowed.length > 0) {
    fail(
      `${shadowed.length} upstream-owned path(s) exist on disk but are not tracked, so their divergence cannot ` +
        `be measured — git would report them as deleted while the file is read for its hash. Stage or remove ` +
        `them first:\n` +
        shadowed.map((p) => `  ${p}`).join('\n'),
    );
  }

  // The seal is over the manifest's own key set, which `buildManifest` fills
  // from exactly these paths — so it is the pinned commit's path list by
  // construction, not a second list that could drift from it.
  return sealManifest(
    buildManifest({
      upstream: sha,
      upstreamModes,
      forkIndex,
      numstat,
      modeOf: (rel) => fileModeOf(path.join(root, rel)),
      hashOf: (rel) => hashFile(path.join(root, rel)),
      ignored,
    }),
  );
}

// ── output ───────────────────────────────────────────────────────────────────

const ORDER: Verdict[] = ['NEW', 'GROWTH', 'STALE', 'SHRINK', 'DROPPED'];

function n(value: number): string {
  return value.toLocaleString('en-US');
}

function renderRow(row: Row): string {
  const delta = row.after - row.before;
  const sign = delta > 0 ? `+${n(delta)}` : n(delta);
  const state =
    row.deletedAfter && !row.deletedBefore
      ? 'deleted in fork'
      : row.deletedBefore && !row.deletedAfter
        ? 'restored in fork'
        : (row.reason ?? '');
  const note = state === '' ? '' : ` (${state})`;
  return `  ${row.verdict.padEnd(9)} ${row.path.padEnd(58)} ${n(row.before)} → ${n(row.after)} (${sign})${note}`;
}

function counts(manifest: UpstreamRatchetManifest): {
  total: number;
  divergent: number;
  identical: number;
  deleted: number;
  modified: number;
  binary: number;
  lines: number;
} {
  const entries = Object.values(manifest.files);
  const divergent = divergentEntries(manifest).length;
  const deleted = entries.filter((e) => e.deleted === true).length;
  return {
    total: entries.length,
    divergent,
    identical: entries.length - divergent,
    deleted,
    modified: divergent - deleted,
    binary: entries.filter((e) => e.binary === true).length,
    lines: totalDiffLines(manifest),
  };
}

/** The `--write --accept …` line to re-run, safe to paste into a shell. */
function acceptCommand(rows: readonly Row[]): string {
  return `pnpm run ratchet:report -- --write ${rows.map((r) => acceptFlag(r.path)).join(' ')}`;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const root = options.root;
  const committedPath = manifestPath(root);
  let committed: UpstreamRatchetManifest;
  try {
    committed = readManifest(root);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    // Creating the manifest for the first time is a re-pin against an empty
    // baseline: everything upstream owns reads as NEW, which is exactly what an
    // unaudited starting point is. Any other mode needs the file to exist.
    if (options.upstream === null) {
      fail(`could not read ${committedPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    committed = { upstream: '', paths: '', files: {} };
  }

  const sha = resolveCommit(root, options.upstream ?? committed.upstream);
  const repinned = sha !== committed.upstream;
  const started = Date.now();
  let current: UpstreamRatchetManifest;
  try {
    current = computeFromGit(root, sha);
  } catch (error) {
    // A RatchetError is a refusal with a written-out reason (a gitlink, an
    // unparseable record); anything else is a bug and keeps its stack.
    if (error instanceof RatchetError) fail(error.message);
    throw error;
  }
  const elapsedMs = Date.now() - started;

  const rows = classify(committed, current);
  const { blocking, unaccepted } = writeGate(rows, options.accept, options.acceptAll);

  const before = counts(committed);
  const after = counts(current);
  const deltaLines = after.lines - before.lines;
  const summary =
    `${n(after.divergent)} divergent files, ${n(after.lines)} diff lines vs ${sha.slice(0, 8)} ` +
    `(Δ ${deltaLines >= 0 ? '' : '-'}${n(Math.abs(deltaLines))})`;

  // `--json` is emitted at the very end, so `wrote` reports what actually
  // happened rather than what was about to be attempted.
  const emitJson = (wrote: boolean): void => {
    console.log(
      JSON.stringify(
        {
          upstream: sha,
          repinnedFrom: options.upstream !== null && repinned ? committed.upstream : null,
          summary,
          elapsedMs,
          counts: after,
          delta: { lines: deltaLines, divergent: after.divergent - before.divergent },
          rows: rows.filter((r) => r.verdict !== 'UNCHANGED'),
          blocking: blocking.map((r) => r.path),
          unaccepted: unaccepted.map((r) => r.path),
          wrote,
        },
        null,
        2,
      ),
    );
  };

  if (!options.json) {
    if (options.upstream !== null && repinned) {
      console.log(
        `Re-pinning ${committed.upstream || '(no previous pin)'} → ${sha}` +
          (options.upstream === sha ? '' : ` (resolved from ${options.upstream})`) +
          `. Every number below moves for upstream's reasons, not the fork's.\n`,
      );
    }
    for (const verdict of ORDER) {
      const group = rows.filter((r) => r.verdict === verdict);
      if (group.length === 0) continue;
      console.log(`${verdict} (${n(group.length)})`);
      for (const row of group) console.log(renderRow(row));
      console.log('');
    }
    console.log(
      `${n(after.total)} upstream-owned files at ${sha.slice(0, 8)}: ` +
        `${n(after.modified)} modified, ${n(after.deleted)} deleted in fork, ` +
        `${n(after.identical)} byte-identical, ${n(after.binary)} binary`,
    );
    console.log(`UNCHANGED ${n(rows.filter((r) => r.verdict === 'UNCHANGED').length)}   (measured in ${elapsedMs} ms)`);
    console.log(summary);
  }

  if (options.write) {
    if (unaccepted.length > 0) {
      if (options.json) emitJson(false);
      console.error(
        `\nupstream-ratchet: refusing to write ${committedPath} — ${n(unaccepted.length)} path(s) grew or became ` +
          `newly divergent and were not accepted:\n` +
          unaccepted
            .map((r) => `  ${r.verdict} ${r.path} (${n(r.before)} → ${n(r.after)})${r.reason ? ` — ${r.reason}` : ''}`)
            .join('\n') +
          `\nRe-run with ${unaccepted.map((r) => acceptFlag(r.path)).join(' ')} (or --accept-all), and say why in ` +
          `the PR body.`,
      );
      process.exit(1);
    }
    writeManifest(current, root);
    if (options.json) emitJson(true);
    else console.log(`\nWrote ${committedPath} — ${n(after.total)} entries pinned at ${sha}.`);
    process.exit(0);
  }

  if (options.json) emitJson(false);

  if (blocking.length > 0) {
    console.error(
      `\nupstream-ratchet: ${n(blocking.length)} upstream-owned file(s) grew or became newly divergent. ` +
        `Shrink freely; growth is a deliberate act — regenerate with\n  ${acceptCommand(blocking)}\n` +
        `and justify it in the PR body.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

main();
