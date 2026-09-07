#!/usr/bin/env tsx
/**
 * Agent-session worktree GC entry point.
 *
 * Reports only. Removal happens exactly when NANOCLAW_WORKTREE_GC=apply is set;
 * a bare run never deletes anything.
 *
 *   pnpm exec tsx scripts/agent-worktree-gc.ts
 *   NANOCLAW_WORKTREE_GC=apply pnpm exec tsx scripts/agent-worktree-gc.ts
 *
 * Covers agent-session worktrees (/tmp scratch, ad-hoc topic dirs,
 * .claude/worktrees) — NOT the repo-store topic worktrees that
 * scripts/storage-gc.ts already collects, and not .codex/worktrees.
 *
 * Like storage-gc, deliberately not wired into an in-process timer: a pass
 * shells out to git once per worktree and scans /proc, which would stall host
 * message routing. Schedule it out of process if it should run unattended.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import { runAgentWorktreeGcOnce, type Verdict } from '../src/agent-worktree-gc.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = runAgentWorktreeGcOnce(repoRoot);

// Every verdict must appear here. A missing one is silently dropped from the
// summary, which is how a run reporting 19 of 102 worktrees looked plausible.
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

console.log(`agent-worktree-gc: ${report.mode} — ${report.assessments.length} worktrees registered\n`);
const listed = ORDER.reduce((n, v) => n + (counts.get(v) ?? 0), 0);
if (listed !== report.assessments.length) {
  console.log(`  WARNING: summary lists ${listed} of ${report.assessments.length} — a verdict is missing from ORDER\n`);
}
for (const v of ORDER) {
  const n = counts.get(v) ?? 0;
  if (n > 0) console.log(`  ${String(n).padStart(3)}  ${v}`);
}

const eligible = report.assessments.filter((a) => a.verdict === 'eligible');
if (eligible.length > 0) {
  console.log(`\n${report.mode === 'apply' ? 'Removing' : 'Would remove'}:`);
  for (const a of eligible) console.log(`  ${a.row.path}\n      ${a.detail}`);
}

// Print what was SPARED and why. A collector that only reports its deletions
// gives no way to notice it has started refusing everything for a bad reason —
// e.g. an unreadable /proc marking every worktree live.
const spared = report.assessments.filter((a) => a.verdict !== 'eligible' && a.verdict !== 'main' && a.verdict !== 'out-of-scope');
if (spared.length > 0) {
  console.log(`\nSpared (${spared.length}):`);
  for (const a of spared) console.log(`  [${a.verdict}] ${a.row.path} — ${a.detail}`);
}

if (report.mode === 'apply') {
  console.log(
    `\nremoved=${report.removed.length} pruned_registrations=${report.prunedRegistrations} skipped_on_recheck=${report.skippedOnRecheck.length} failed=${report.failed.length}`,
  );
  for (const sk of report.skippedOnRecheck) console.log(`  SKIPPED (became ${sk.verdict}) ${sk.path}`);
  for (const f of report.failed) console.log(`  FAILED ${f.path}: ${f.err}`);
} else if (eligible.length > 0) {
  console.log(`\nDry run. Set NANOCLAW_WORKTREE_GC=apply to act.`);
}

process.exit(report.failed.length > 0 ? 1 : 0);
