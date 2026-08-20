#!/usr/bin/env tsx
/**
 * Prebuild guard: dist/ is compiled from the WORKING TREE, not from HEAD. In
 * a checkout shared by several concurrent agents, `pnpm run build` would
 * otherwise silently capture whoever's half-finished work happens to be on
 * disk. This refuses to build on a dirty tree; BUILD_ALLOW_DIRTY=1 overrides
 * (loudly) for a deliberate local build.
 */
import { execFileSync } from 'node:child_process';

const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();

if (!status) process.exit(0);

const files = status.split('\n');

if (process.env.BUILD_ALLOW_DIRTY === '1') {
  console.warn('WARNING: BUILD_ALLOW_DIRTY=1 — building a dirty working tree. dist/ will not match HEAD:');
  for (const f of files) console.warn(`  ${f}`);
  process.exit(0);
}

console.error('BUILD REFUSED: working tree is dirty.\n');
console.error('dist/ is compiled from the working tree, not from HEAD. Building now would bake');
console.error('these uncommitted changes into dist/, which a restart could then run.\n');
console.error('Dirty paths (git status --porcelain):');
for (const f of files) console.error(`  ${f}`);
console.error('\nTo proceed, either:');
console.error('  1. Commit or stash the changes above, then rebuild.');
console.error('  2. Set BUILD_ALLOW_DIRTY=1 to build anyway (prints a warning, stamps dirty:true).');
process.exit(1);
