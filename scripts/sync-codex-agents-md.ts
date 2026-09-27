#!/usr/bin/env tsx
/**
 * CLI shim for `syncCodexAgentsMd()` (src/codex-sync.ts): regenerates ~/.codex/AGENTS.md.
 *
 *   pnpm exec tsx scripts/sync-codex-agents-md.ts
 */
import { syncCodexAgentsMd } from '../src/codex-sync.js';

function main(): void {
  const result = syncCodexAgentsMd();
  if (result.changed) {
    console.log(`Wrote ${result.target} (${result.bytes} bytes, ${result.lines} lines)`);
  } else {
    console.log(`Unchanged: ${result.target}`);
  }
}

main();
