#!/usr/bin/env tsx
/**
 * Prebuild guard: dist/ is compiled from the WORKING TREE, not from HEAD. In
 * a checkout shared by several concurrent agents, `pnpm run build` would
 * otherwise silently capture whoever's half-finished work happens to be on
 * disk. This refuses to build on a dirty tree; BUILD_ALLOW_DIRTY=1 overrides
 * (loudly) for a deliberate local build.
 *
 * Docs-only dirt is exempted: `dist/` never contains docs/** or root-level
 * markdown, so a peer session's staged docs/specs/**\/*.md can't leak into a
 * build the way a src/ or scripts/ change could. The whitelist below is
 * intentionally narrow — anything under src/, container/, scripts/,
 * dashboard/, setup/, .github/, or a build-relevant manifest still blocks.
 *
 * Second guard, same failure family: a build must also start from a HEAD
 * that matches origin/main — a peer committing then resetting local main
 * mid-build must not have its stale dist/ mistaken for current. BUILD_ALLOW_LOCAL=1
 * overrides (loudly) for a deliberate local/unpushed build. The HEAD sha this
 * check settles on is written to dist/.build-start-sha so the postbuild step
 * (scripts/write-build-info.ts) can detect HEAD moving *during* the build.
 *
 * A content fingerprint of whatever blocking dirt BUILD_ALLOW_DIRTY=1 let
 * through is written alongside it (dist/.build-allowed-dirt-fingerprint), so
 * BUILD_ALLOW_DIRTY waives the check for exactly the dirt that was present
 * at prebuild time — not for a peer's mid-build edit to an already-dirty (or
 * newly dirty) file, which would otherwise slip through unnoticed just
 * because *some* dirt was already permitted.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Path prefixes that never affect dist/ output, wherever they appear in the tree. */
const IGNORABLE_DIRT_PREFIXES = ['docs/'];

/**
 * A dirty path that cannot affect dist/ and is safe to build through
 * without the BUILD_ALLOW_DIRTY escape hatch. Root-level markdown
 * (README*, CHANGELOG.md, any other *.md directly at repo root) is
 * documentation by convention in this repo; everything nested elsewhere
 * (including dashboard/README.md, say) still blocks.
 */
export function isIgnorableDirtPath(filePath: string): boolean {
  if (IGNORABLE_DIRT_PREFIXES.some((prefix) => filePath.startsWith(prefix))) return true;
  if (!filePath.includes('/')) {
    if (filePath.startsWith('README')) return true;
    if (filePath.endsWith('.md')) return true;
  }
  return false;
}

function stripQuotes(p: string): string {
  // git quotes paths containing unusual characters; docs-only dirt never
  // needs that, so a plain strip (no C-style unescape) is sufficient here.
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1);
  return p;
}

/** Extracts the path(s) a `git status --porcelain` line refers to. Rename entries yield both sides. */
function pathsForLine(line: string): string[] {
  const rest = line.slice(3); // "XY " prefix
  const arrow = rest.indexOf(' -> ');
  if (arrow === -1) return [stripQuotes(rest)];
  return [stripQuotes(rest.slice(0, arrow)), stripQuotes(rest.slice(arrow + 4))];
}

export interface DirtPartition {
  /** Porcelain lines that block the build. */
  blocking: string[];
  /** Porcelain lines that are docs-only and safe to build through. */
  ignored: string[];
}

/** Splits `git status --porcelain` lines into build-blocking and safely-ignorable dirt. */
export function partitionDirt(lines: string[]): DirtPartition {
  const blocking: string[] = [];
  const ignored: string[] = [];
  for (const line of lines) {
    const paths = pathsForLine(line);
    if (paths.every(isIgnorableDirtPath)) {
      ignored.push(line);
    } else {
      blocking.push(line);
    }
  }
  return { blocking, ignored };
}

/** The distinct paths referenced by a set of `git status --porcelain` lines, sorted for determinism. */
export function pathsForLines(lines: string[]): string[] {
  const paths = new Set<string>();
  for (const line of lines) {
    for (const p of pathsForLine(line)) paths.add(p);
  }
  return [...paths].sort();
}

/**
 * Content fingerprint of a set of blocking dirty paths, read relative to the
 * current working directory. Order-independent and stable across separate
 * processes (prebuild writes it, postbuild recomputes it) so a BUILD_ALLOW_DIRTY
 * build can detect its allowed dirt changing content mid-build, not just a
 * change in *which* paths are dirty.
 */
export function fingerprintDirt(blockingLines: string[]): string {
  const hash = crypto.createHash('sha256');
  for (const p of pathsForLines(blockingLines)) {
    hash.update(p);
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(p));
    } catch {
      hash.update('<missing>'); // deleted/renamed-away path
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

export interface FreshnessCheck {
  ok: boolean;
  /** Printed via console.warn when ok+overridden, console.error when refused. Null when HEAD already matches. */
  message: string | null;
}

/** Decides whether HEAD is fresh enough to build from: it must match origin/main unless BUILD_ALLOW_LOCAL=1 overrides. */
export function checkFreshness(head: string, originMain: string, allowLocal: boolean): FreshnessCheck {
  if (head === originMain) return { ok: true, message: null };
  if (allowLocal) {
    return {
      ok: true,
      message: `WARNING: BUILD_ALLOW_LOCAL=1 — HEAD (${head}) does not match origin/main (${originMain}). Building a local/unpushed tree.`,
    };
  }
  return {
    ok: false,
    message: [
      `BUILD REFUSED: HEAD (${head}) does not match origin/main (${originMain}).`,
      '',
      'A build must start from a tree matching origin/main so a build compiled from a',
      "stale local HEAD can't be mistaken for current after a reset or rebase.",
      '',
      'To proceed, either:',
      '  1. Fetch and fast-forward/rebase onto origin/main, then rebuild.',
      '  2. Set BUILD_ALLOW_LOCAL=1 to build the local tree anyway (prints a warning).',
    ].join('\n'),
  };
}

function main(): void {
  // NOTE: don't .trim() the raw output before splitting — porcelain status
  // codes can start with a leading space (e.g. " M path" for an unstaged
  // modification), and trimming the whole multi-line string strips that
  // leading space off the FIRST line only, shifting `pathsForLine`'s 3-char
  // prefix slice by one and corrupting the path. Split first, then drop the
  // empty trailing element from the output's final newline.
  const raw = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  const files = raw.trim() ? raw.split('\n').filter((line) => line.length > 0) : [];

  let blocking: string[] = [];
  if (files.length > 0) {
    const partition = partitionDirt(files);
    blocking = partition.blocking;

    if (process.env.BUILD_ALLOW_DIRTY === '1') {
      console.warn('WARNING: BUILD_ALLOW_DIRTY=1 — building a dirty working tree. dist/ will not match HEAD:');
      for (const f of files) console.warn(`  ${f}`);
    } else {
      if (partition.ignored.length > 0) {
        console.warn(`ignoring docs-only dirt: ${partition.ignored.map((line) => line.slice(3)).join(', ')}`);
      }

      if (blocking.length > 0) {
        console.error('BUILD REFUSED: working tree is dirty.\n');
        console.error('dist/ is compiled from the working tree, not from HEAD. Building now would bake');
        console.error('these uncommitted changes into dist/, which a restart could then run.\n');
        console.error('Dirty paths (git status --porcelain):');
        for (const f of blocking) console.error(`  ${f}`);
        console.error('\nTo proceed, either:');
        console.error('  1. Commit or stash the changes above, then rebuild.');
        console.error('  2. Set BUILD_ALLOW_DIRTY=1 to build anyway (prints a warning, stamps dirty:true).');
        process.exit(1);
      }
    }
  }

  let head: string;
  let originMain: string;
  try {
    execFileSync('git', ['fetch', '-q', 'origin', 'main']);
    head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    originMain = execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error('BUILD REFUSED: could not verify HEAD against origin/main.');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const freshness = checkFreshness(head, originMain, process.env.BUILD_ALLOW_LOCAL === '1');
  if (freshness.message) {
    if (freshness.ok) console.warn(freshness.message);
    else console.error(freshness.message);
  }
  if (!freshness.ok) process.exit(1);

  fs.mkdirSync('dist', { recursive: true });
  fs.writeFileSync(path.join('dist', '.build-start-sha'), `${head}\n`);
  fs.writeFileSync(path.join('dist', '.build-allowed-dirt-fingerprint'), fingerprintDirt(blocking));
  process.exit(0);
}

// tsx runs this file directly; vitest imports it for the pure helpers above,
// so guard the side-effecting entry point behind a direct-execution check.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
