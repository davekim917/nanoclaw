#!/usr/bin/env tsx
/**
 * Sync `~/plugins/*` skills into `~/.agents/skills/`.
 *
 * Targets the runtime-agnostic `.agents/skills/` convention rather than
 * Codex-specific `$CODEX_HOME/skills/`. Verified empirically: Codex
 * auto-discovers from `~/.agents/skills/` (as root `r1` in `codex debug
 * prompt-input`). Other compliant agent runtimes follow the same path.
 *
 * Tool-native installs always win: tools with first-class Codex support
 * (e.g. `gitnexus setup`) write real directories under `~/.agents/skills/`.
 * `syncSkillSymlinks` defers to those — it only writes symlinks at names
 * where nothing else exists.
 *
 * Auto-update story: the symlinks point at the plugin source dirs, so
 * whenever Claude's marketplace pulls an update for a plugin (which
 * rewrites files inside `~/plugins/<plugin>/...`), Codex sees the new
 * content immediately via the symlink — no separate sync step needed.
 *
 * Usage:
 *   pnpm exec tsx scripts/sync-codex-plugin-skills.ts
 *
 * Use `--dry-run` to preview without writing.
 */
import os from 'os';
import path from 'path';

import { discoverPortableSkills, syncSkillSymlinks } from '../src/plugin-skill-discovery.js';

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const pluginsRoot = path.join(os.homedir(), 'plugins');
  const agentsSkills = path.join(os.homedir(), '.agents', 'skills');

  const discovered = discoverPortableSkills(pluginsRoot);
  console.log(`Discovered ${discovered.length} portable skill(s) under ${pluginsRoot}:`);
  for (const s of discovered) {
    console.log(`  ${s.name.padEnd(34)} ← ${s.plugin}/${path.relative(path.join(pluginsRoot, s.plugin), s.skillDir)}`);
  }

  if (dryRun) {
    console.log('\n(--dry-run) No symlinks written.');
    return;
  }

  const result = syncSkillSymlinks(agentsSkills, discovered);
  console.log(`\nSync result for ${agentsSkills}:`);
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
