#!/usr/bin/env tsx
/**
 * CLI shim — regenerate ~/.codex/AGENTS.md from ~/.claude/CLAUDE.md.
 *
 * Real work lives in `src/codex-sync.ts:syncCodexAgentsMd()` so the
 * watcher daemon can call it in-process without spawn overhead.
 *
 * Usage:
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
