#!/usr/bin/env tsx
/**
 * Agent-session worktree report.
 *
 * Classifies every registered worktree and prints the commands to reclaim the
 * safe ones. It does NOT delete anything, by design — see the header of
 * src/agent-worktree-gc.ts for why the destructive mode was removed.
 *
 *   sudo pnpm worktrees
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
// Without root, /proc/<pid>/cwd for other users is unreadable, every worktree
// reports `probe-failed`, and the run is a confusing no-op. Say so once, up
// front, instead of leaving the reader to decode a hundred identical lines.
if (typeof process.getuid === 'function' && process.getuid() !== 0) {
  console.log('agent-worktree-gc: not running as root — re-run as `sudo pnpm worktrees`.');
  console.log('  Without root, another user\'s /proc/<pid>/cwd is unreadable and every');
  console.log('  worktree reports `probe-failed` because idleness cannot be proven.\n');
}

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

/** Single-quote for the shell; a path can contain spaces, and some here do. */
function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

if (eligible.length > 0) {
  // Deliberately WITHOUT --force. git refuses a worktree carrying
  // modifications or untracked files, which is the last gate and the one that
  // has never been wrong. Anything git refuses here should be investigated,
  // not forced.
  console.log(`\nSafe to reclaim (${eligible.length}) — run from ${report.mainWorktreePath}:\n`);
  for (const a of eligible) console.log(`  git worktree remove ${shq(a.row.path)}`);
}

if (orphans.length > 0) {
  // NOT `git worktree prune`. That is repository-wide: it drops EVERY stale
  // registration, including ones this run refused because their HEAD is not
  // merged and the registration may be a commit's only reference. Printing it
  // would recommend an action broader than the evidence gathered — the exact
  // overreach this tool exists to avoid. `remove` names one target.
  console.log(`\nOrphaned registrations verified merged (${orphans.length}) — run from ${report.mainWorktreePath}:\n`);
  for (const o of orphans) console.log(`  git worktree remove ${shq(o)}`);
  console.log(`\n  (Do NOT use \`git worktree prune\`: it also drops stale registrations this run refused.)`);
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
