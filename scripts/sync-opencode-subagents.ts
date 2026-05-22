#!/usr/bin/env tsx
/**
 * CLI shim — convert every Claude-format subagent `.md` (plugin tree +
 * `~/.claude/agents/`) into an OpenCode agent `.md` and write to
 * `~/.config/opencode/agent/` (host's personal opencode session) plus every
 * `~/.local/share/opencode-<folder>/agent/` whose folder has an `auth.json`.
 *
 * Real work lives in `src/opencode-sync.ts:syncOpenCodeSubagents()` so the
 * watcher daemon can call it in-process without spawn overhead.
 *
 * Usage:
 *   pnpm exec tsx scripts/sync-opencode-subagents.ts
 */
import { syncOpenCodeSubagents } from '../src/opencode-sync.js';

function main(): void {
  const result = syncOpenCodeSubagents();
  console.log(`Targets (${result.targets.length}):`);
  for (const t of result.targets) console.log(`  ${t}`);
  console.log(
    `Discovered ${result.discovered} subagent(s) — writes=${result.writes} ` +
      `unchangedFiles=${result.unchangedFiles} removedFiles=${result.removedFiles} ` +
      `skipped=${result.skipped.length}`,
  );
  if (result.skipped.length > 0) {
    console.log(`Skipped (hand-written .md present): ${result.skipped.join(', ')}`);
  }
}

main();
