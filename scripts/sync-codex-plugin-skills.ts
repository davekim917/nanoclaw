#!/usr/bin/env tsx
/**
 * CLI shim — sync `~/plugins/*` skills into `~/.agents/skills/`.
 *
 * Real work lives in `src/codex-sync.ts:syncCodexPluginSkills()` so the
 * watcher daemon can call it in-process without spawn overhead.
 *
 * Usage:
 *   pnpm exec tsx scripts/sync-codex-plugin-skills.ts
 *   pnpm exec tsx scripts/sync-codex-plugin-skills.ts --dry-run
 */
import os from 'os';
import path from 'path';

import { discoverPortableSkills } from '../src/plugin-skill-discovery.js';
import { syncCodexPluginSkills } from '../src/codex-sync.js';

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const pluginsRoot = path.join(os.homedir(), 'plugins');

  const discovered = discoverPortableSkills(pluginsRoot);
  console.log(`Discovered ${discovered.length} portable skill(s) under ${pluginsRoot}:`);
  for (const s of discovered) {
    console.log(`  ${s.name.padEnd(34)} ← ${s.plugin}/${path.relative(path.join(pluginsRoot, s.plugin), s.skillDir)}`);
  }

  if (dryRun) {
    console.log('\n(--dry-run) No symlinks written.');
    return;
  }

  const result = syncCodexPluginSkills();
  console.log(`\nSync result for ${result.target}:`);
  console.log(`  created:   ${result.created.length}`);
  console.log(`  removed:   ${result.removed.length}`);
  console.log(`  unchanged: ${result.unchanged.length}`);
  console.log(`  skipped:   ${result.skipped.length} (existing non-symlink content preserved)`);
  if (result.created.length > 0) {
    console.log(`  + ${result.created.join(', ')}`);
  }
  if (result.removed.length > 0) {
    console.log(`  - ${result.removed.join(', ')}`);
  }
  if (result.skipped.length > 0) {
    console.log(`  ~ skipped: ${result.skipped.join(', ')}`);
  }
}

main();
