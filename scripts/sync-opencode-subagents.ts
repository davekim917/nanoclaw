#!/usr/bin/env tsx
/**
 * CLI shim for `syncOpenCodeSubagents()` (src/opencode-sync.ts): Claude-format subagents to
 * OpenCode agent `.md` files.
 *
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
