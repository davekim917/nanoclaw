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
 */
import { execFileSync } from 'node:child_process';
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

function main(): void {
  // NOTE: don't .trim() the raw output before splitting — porcelain status
  // codes can start with a leading space (e.g. " M path" for an unstaged
  // modification), and trimming the whole multi-line string strips that
  // leading space off the FIRST line only, shifting `pathsForLine`'s 3-char
  // prefix slice by one and corrupting the path. Split first, then drop the
  // empty trailing element from the output's final newline.
  const raw = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });

  if (!raw.trim()) process.exit(0);

  const files = raw.split('\n').filter((line) => line.length > 0);

  if (process.env.BUILD_ALLOW_DIRTY === '1') {
    console.warn('WARNING: BUILD_ALLOW_DIRTY=1 — building a dirty working tree. dist/ will not match HEAD:');
    for (const f of files) console.warn(`  ${f}`);
    process.exit(0);
  }

  const { blocking, ignored } = partitionDirt(files);

  if (ignored.length > 0) {
    console.warn(`ignoring docs-only dirt: ${ignored.map((line) => line.slice(3)).join(', ')}`);
  }

  if (blocking.length === 0) process.exit(0);

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

// tsx runs this file directly; vitest imports it for the pure helpers above,
// so guard the side-effecting entry point behind a direct-execution check.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
