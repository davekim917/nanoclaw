#!/usr/bin/env tsx
/**
 * CLI shim — convert every Claude-format subagent `.md` (plugin tree +
 * `~/.claude/agents/`) into a Codex TOML and write to `~/.codex/agents/`
 * (plus every `~/.codex-<folder>/agents/` whose folder has an auth.json).
 *
 * Real work lives in `src/codex-sync.ts:syncCodexSubagents()` so the
 * watcher daemon can call it in-process without spawn overhead.
 *
 * Usage:
 *   pnpm exec tsx scripts/sync-codex-subagents.ts
 */
import { syncCodexSubagents } from '../src/codex-sync.js';

function main(): void {
  const result = syncCodexSubagents();
  console.log(`Targets (${result.targets.length}):`);
  for (const t of result.targets) console.log(`  ${t}`);
  console.log(
    `Discovered ${result.discovered} subagent(s) — writes=${result.writes} ` +
      `unchangedFiles=${result.unchangedFiles} removedFiles=${result.removedFiles} ` +
      `skipped=${result.skipped.length}`,
  );
  if (result.skipped.length > 0) {
    console.log(`Skipped (hand-written TOML present): ${result.skipped.join(', ')}`);
  }
}

main();
