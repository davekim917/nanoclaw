#!/usr/bin/env tsx
/**
 * Agent-session worktree report: classifies every registered worktree and prints the commands to
 * reclaim the safe ones. It deletes nothing, by design.
 *
 *   sudo pnpm worktrees
 *
 * Needs root to read other users' /proc/<pid>/cwd (else every worktree is `probe-failed`), and
 * GH_TOKEN (else branch-carrying worktrees are `pr-unknown`). Does not cover the repo-store topic
 * worktrees scripts/storage-gc.ts collects.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import { runAgentWorktreeGcOnce, type Verdict } from '../src/agent-worktree-gc.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof process.getuid === 'function' && process.getuid() !== 0) {
  // Exit rather than carry on: a probe-failed row per worktree is the confusing no-op this replaces.
  console.error('agent-worktree-gc: not running as root — re-run as `sudo pnpm worktrees`.');
  console.error("  Without root, another user's /proc/<pid>/cwd is unreadable, so every");
  console.error('  worktree would report `probe-failed` and nothing could be classified.');
  process.exit(1);
}

const report = runAgentWorktreeGcOnce(repoRoot);

if (report === null) {
  console.error('agent-worktree-gc: could not read the worktree inventory — nothing was assessed');
  process.exit(1);
}

// Every verdict must appear here: a missing one is silently dropped from the summary.
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

/** Single-quote for the shell; a path can contain spaces, and some here do. */
function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

if (eligible.length > 0) {
  // Deliberately WITHOUT --force: git refusing a modified worktree is the last gate. Investigate, don't force.
  console.log(`\nSafe to reclaim (${eligible.length}) — run from ${report.mainWorktreePath}:\n`);
  for (const a of eligible) console.log(`  git worktree remove ${shq(a.row.path)}`);
}

if (orphans.length > 0) {
  // NOT `git worktree prune`: it is repository-wide and would drop registrations this run
  // refused, which may be a commit's only reference.
  console.log(`\nOrphaned registrations verified merged (${orphans.length}) — run from ${report.mainWorktreePath}:\n`);
  for (const o of orphans) console.log(`  git worktree remove ${shq(o)}`);
  console.log(`\n  (Do NOT use \`git worktree prune\`: it also drops stale registrations this run refused.)`);
}

if (eligible.length === 0 && orphans.length === 0) {
  console.log('\nNothing is safe to reclaim right now.');
}

// Print what was SPARED and why, so a run refusing everything for a bad reason is noticeable.
const spared = report.assessments.filter(
  (a) => a.verdict !== 'eligible' && a.verdict !== 'main' && a.verdict !== 'out-of-scope',
);
if (spared.length > 0) {
  console.log(`\nSpared (${spared.length}):`);
  for (const a of spared) console.log(`  [${a.verdict}] ${a.row.path} — ${a.detail}`);
}
