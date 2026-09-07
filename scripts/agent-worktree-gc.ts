#!/usr/bin/env tsx
/**
 * Agent-session worktree report.
 *
 * Classifies every registered worktree and prints the commands to reclaim the
 * safe ones. It does NOT delete anything, by design — see the header of
 * src/agent-worktree-gc.ts for why the destructive mode was removed.
 *
 *   pnpm exec tsx scripts/agent-worktree-gc.ts
 *
 * Run it as root. Reading another user's /proc/<pid>/cwd needs it, and without
 * it every worktree reports `probe-failed` because idleness cannot be proven.
 * Give it GH_TOKEN too, or branch-carrying worktrees report `pr-unknown`.
 *
 * Covers agent-session worktrees (/tmp scratch, ad-hoc topic dirs,
 * .claude/worktrees) — NOT the repo-store topic worktrees that
 * scripts/storage-gc.ts already collects, and not .codex/worktrees.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import { runAgentWorktreeGcOnce, type Verdict } from '../src/agent-worktree-gc.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = runAgentWorktreeGcOnce(repoRoot);

if (report === null) {
  console.error('agent-worktree-gc: could not read the worktree inventory — nothing was assessed');
  process.exit(1);
}

// Every verdict must appear here. A missing one is silently dropped from the
// summary, which is how a run reporting 19 of 102 worktrees once looked fine.
const ORDER: Verdict[] = [
  'eligible',
  'live-process',
  'probe-failed',
  'locked',
  'open-pr',
  'pr-unknown',
  'unmerged',
  'dirty',
  'out-of-scope',
  'main',
];

const counts = new Map<Verdict, number>();
for (const a of report.assessments) counts.set(a.verdict, (counts.get(a.verdict) ?? 0) + 1);

console.log(`agent-worktree-gc: ${report.assessments.length} worktrees registered\n`);
const listed = ORDER.reduce((n, v) => n + (counts.get(v) ?? 0), 0);
if (listed !== report.assessments.length) {
  console.log(`  WARNING: summary lists ${listed} of ${report.assessments.length} — a verdict is missing from ORDER\n`);
}
for (const v of ORDER) {
  const n = counts.get(v) ?? 0;
  if (n > 0) console.log(`  ${String(n).padStart(3)}  ${v}`);
}

const eligible = report.assessments.filter((a) => a.verdict === 'eligible' && !a.row.missing);
const orphans = report.orphanedRegistrations;

if (eligible.length > 0) {
  // Deliberately WITHOUT --force. git refuses a worktree carrying
  // modifications or untracked files, which is the last gate and the one that
  // has never been wrong. Anything git refuses here should be investigated,
  // not forced.
  console.log(`\nSafe to reclaim (${eligible.length}) — run from ${report.mainWorktreePath}:\n`);
  for (const a of eligible) console.log(`  git worktree remove ${a.row.path}`);
}

if (orphans.length > 0) {
  console.log(`\n${orphans.length} registration(s) whose directory is gone and whose HEAD is merged:\n`);
  console.log('  git worktree prune');
}

if (eligible.length === 0 && orphans.length === 0) {
  console.log('\nNothing is safe to reclaim right now.');
}

// Print what was SPARED and why. A report that only lists its candidates gives
// no way to notice it has started refusing everything for a bad reason — an
// unreadable /proc marking all 100 `probe-failed`, say.
const spared = report.assessments.filter(
  (a) => a.verdict !== 'eligible' && a.verdict !== 'main' && a.verdict !== 'out-of-scope',
);
if (spared.length > 0) {
  console.log(`\nSpared (${spared.length}):`);
  for (const a of spared) console.log(`  [${a.verdict}] ${a.row.path} — ${a.detail}`);
}
