#!/usr/bin/env tsx
/**
 * Upstream-ownership ratchet — the git half.
 *
 * `src/upstream-ratchet.ts` (and the vitest suite over it) can only prove the
 * manifest is CURRENT: it has no git and, in CI, no upstream commit objects.
 * This script is where the arbitration lives. It recomputes every upstream-owned
 * path's divergence against the PINNED commit and compares that to the committed
 * manifest:
 *
 *   GROWTH     the fork diverged further in that file        → fails
 *   NEW        the file was byte-identical and no longer is,
 *              or was present and is now deleted             → fails
 *   SHRINK     the fork moved back toward upstream           → always allowed
 *   STALE      recorded as divergent, now byte-identical     → allowed, but the
 *              manifest owes a regeneration
 *   UNCHANGED  same divergence as recorded
 *
 * Modes:
 *   (default)              report; exit 1 on any GROWTH or NEW, else 0
 *   --write                regenerate src/upstream-ratchet.json; REFUSES while
 *                          any GROWTH or NEW path is not named by --accept
 *   --accept <path>        (repeatable) permit one growing/new path in --write
 *   --accept-all           permit all of them
 *   --upstream <sha>       re-pin to a new upstream commit; implies --write and
 *                          --accept-all, because re-pinning changes every number
 *                          for reasons outside the fork
 *   --root <dir>           repo to operate on (default: this script's checkout)
 *   --json                 machine-readable output
 *
 * Cost: one `git ls-tree -r` plus one `git diff --numstat` for the whole tree,
 * never a per-file git call.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  divergentEntries,
  hashFile,
  manifestPath,
  pathExists,
  readManifest,
  sortManifest,
  totalDiffLines,
  writeManifest,
  type UpstreamRatchetEntry,
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
      if (value === undefined || value.startsWith('--')) fail(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--root') options.root = path.resolve(next());
    else if (arg === '--write') options.write = true;
    else if (arg === '--accept') options.accept.add(normalizeRel(next()));
    else if (arg === '--accept-all') options.acceptAll = true;
    else if (arg === '--upstream') options.upstream = next();
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') usage();
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
      '       tsx scripts/upstream-ratchet-report.ts --upstream <sha>',
      '',
      'Reports the fork divergence recorded in src/upstream-ratchet.json against the pinned',
      'upstream commit. Exits 1 when any upstream-owned file grew its diff or became newly',
      'divergent; shrink is always allowed. See docs/upstream-ratchet.md.',
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

/** Exit 2 with the fetch to run when the pinned commit is not in this clone. */
function requireCommit(root: string, sha: string): void {
  try {
    git(root, ['cat-file', '-e', `${sha}^{commit}`], true);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    void error;
    console.error(
      `upstream-ratchet: upstream commit ${sha} is not in this clone.\n` + `  run: git fetch upstream ${sha}`,
    );
    process.exit(2);
  }
}

/** Every path upstream owns at `sha`. */
function upstreamPaths(root: string, sha: string): string[] {
  return git(root, ['ls-tree', '-r', '--name-only', '-z', sha]).split('\0').filter(Boolean);
}

interface Numstat {
  /** `null` for a binary path — git reports `-` for both counts. */
  lines: number | null;
}

/** One `git diff --numstat` for the whole tree: path → its diff size. */
function numstat(root: string, sha: string): Map<string, Numstat> {
  const out = new Map<string, Numstat>();
  // `-z` so a path with a space, a quote or a non-ASCII byte arrives verbatim
  // rather than C-quoted. Records are `added\tdeleted\tpath\0`; `--no-renames`
  // keeps every record to that one shape.
  for (const record of git(root, ['diff', '--numstat', '--no-renames', '-z', sha]).split('\0')) {
    if (record === '') continue;
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab === -1 || secondTab === -1) fail(`could not parse numstat record: ${JSON.stringify(record)}`);
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    const relPath = record.slice(secondTab + 1);
    out.set(relPath, { lines: added === '-' || deleted === '-' ? null : Number(added) + Number(deleted) });
  }
  return out;
}

/**
 * The manifest the working tree implies right now, measured against `sha`.
 *
 * `git diff <commit>` compares the commit to the WORKING TREE, so an uncommitted
 * edit is measured — that is deliberate: the report is meant to be run before a
 * commit as much as after one.
 */
export function computeFromGit(root: string, sha: string): UpstreamRatchetManifest {
  const stats = numstat(root, sha);
  const paths = upstreamPaths(root, sha);
  // `git diff <commit>` only ever looks at TRACKED paths. An upstream-owned path
  // that exists on disk but is untracked therefore reads as fully deleted, and
  // the entry would record upstream's whole line count as the fork's divergence
  // — a wrong number, silently. Refuse instead: `git add` it, or delete it.
  const untracked = new Set(git(root, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean));
  const shadowed = paths.filter((p) => untracked.has(p));
  if (shadowed.length > 0) {
    fail(
      `${shadowed.length} upstream-owned path(s) are present but untracked, so their divergence cannot be ` +
        `measured. Stage or remove them first:\n` +
        shadowed.map((p) => `  ${p}`).join('\n'),
    );
  }
  const files: Record<string, UpstreamRatchetEntry> = {};
  for (const relPath of paths) {
    const abs = path.join(root, relPath);
    const present = pathExists(abs);
    const stat = stats.get(relPath);
    const entry: UpstreamRatchetEntry = present
      ? { diff: 0, sha256: hashFile(abs) }
      : { diff: 0, sha256: null, deleted: true };
    if (stat !== undefined) {
      if (stat.lines === null) {
        entry.binary = true;
        // A binary path only appears in numstat when its bytes differ, and
        // there are no lines to count — one unit of divergence.
        entry.diff = 1;
      } else {
        entry.diff = stat.lines;
      }
    }
    files[relPath] = entry;
  }
  return sortManifest({ upstream: sha, files });
}

// ── classification ───────────────────────────────────────────────────────────

type Verdict = 'GROWTH' | 'NEW' | 'SHRINK' | 'STALE' | 'UNCHANGED' | 'DROPPED';

interface Row {
  verdict: Verdict;
  path: string;
  before: number;
  after: number;
  /** Whether the fork deletes the path, before and after. */
  deletedBefore: boolean;
  deletedAfter: boolean;
}

function classify(committed: UpstreamRatchetManifest, current: UpstreamRatchetManifest): Row[] {
  const rows: Row[] = [];
  for (const [relPath, after] of Object.entries(current.files)) {
    const before = committed.files[relPath];
    const beforeDiff = before?.diff ?? 0;
    const deletedBefore = before?.deleted === true;
    const deletedAfter = after.deleted === true;
    // NEW is checked before GROWTH: 0 → >0 is arithmetically growth too, but it
    // is the case worth naming — the fork just took ownership of a file it had
    // been carrying byte-identical, or dropped one it had been carrying at all.
    // An unlisted path (only possible right after a re-pin) is new by the same
    // reading: nothing has audited it.
    const isNew = before === undefined || (beforeDiff === 0 && after.diff > 0) || (!deletedBefore && deletedAfter);
    const verdict: Verdict = isNew
      ? 'NEW'
      : after.diff > beforeDiff
        ? 'GROWTH'
        : after.diff === 0 && beforeDiff > 0
          ? 'STALE'
          : after.diff < beforeDiff
            ? 'SHRINK'
            : 'UNCHANGED';
    rows.push({ verdict, path: relPath, before: beforeDiff, after: after.diff, deletedBefore, deletedAfter });
  }
  // Paths that left upstream's tree between the committed pin and a new one.
  // Not a fork action, so never a failure — reported so a re-pin's delta is complete.
  for (const [relPath, before] of Object.entries(committed.files)) {
    if (current.files[relPath] !== undefined) continue;
    rows.push({
      verdict: 'DROPPED',
      path: relPath,
      before: before.diff,
      after: 0,
      deletedBefore: before.deleted === true,
      deletedAfter: false,
    });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
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
      ? ' (deleted in fork)'
      : row.deletedBefore && !row.deletedAfter
        ? ' (restored in fork)'
        : '';
  return `  ${row.verdict.padEnd(9)} ${row.path.padEnd(58)} ${n(row.before)} → ${n(row.after)} (${sign})${state}`;
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
    committed = { upstream: options.upstream, files: {} };
  }

  const sha = options.upstream ?? committed.upstream;
  requireCommit(root, sha);
  const started = Date.now();
  const current = computeFromGit(root, sha);
  const elapsedMs = Date.now() - started;

  const rows = classify(committed, current);
  const blocking = rows.filter((r) => r.verdict === 'GROWTH' || r.verdict === 'NEW');
  const unaccepted = options.acceptAll ? [] : blocking.filter((r) => !options.accept.has(r.path));

  const before = counts(committed);
  const after = counts(current);
  const summary =
    `${n(after.divergent)} divergent files, ${n(after.lines)} diff lines vs ${sha.slice(0, 8)} ` +
    `(Δ ${after.lines - before.lines >= 0 ? '' : '-'}${n(Math.abs(after.lines - before.lines))})`;

  // `--json` is emitted at the very end, so `wrote` reports what actually
  // happened rather than what was about to be attempted.
  const emitJson = (wrote: boolean): void => {
    console.log(
      JSON.stringify(
        {
          upstream: sha,
          repinnedFrom:
            options.upstream !== null && options.upstream !== committed.upstream ? committed.upstream : null,
          summary,
          elapsedMs,
          counts: after,
          delta: { lines: after.lines - before.lines, divergent: after.divergent - before.divergent },
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
    if (options.upstream !== null && options.upstream !== committed.upstream) {
      console.log(
        `Re-pinning ${committed.upstream} → ${sha}. Every number below moves for upstream's reasons, not the fork's.\n`,
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
          unaccepted.map((r) => `  ${r.verdict} ${r.path} (${n(r.before)} → ${n(r.after)})`).join('\n') +
          `\nRe-run with ${unaccepted.map((r) => `--accept ${r.path}`).join(' ')} (or --accept-all), and say why in the PR body.`,
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
        `Shrink freely; growth is a deliberate act — regenerate with ` +
        `\`pnpm run ratchet:report -- --write ${blocking.map((r) => `--accept ${r.path}`).join(' ')}\` ` +
        `and justify it in the PR body.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

main();
