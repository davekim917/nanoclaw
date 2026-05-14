#!/usr/bin/env tsx
/**
 * Sync `~/plugins/*` skills into `~/.codex/skills/`.
 *
 * Mirrors what `composeGroupClaudeMd` does for AGENTS.md, but for skills.
 * Walks the host's plugin tree, applies the discovery rules in
 * `plugin-skill-discovery.ts`, and creates a symlink per skill so Codex's
 * `$CODEX_HOME/skills/<name>/` auto-discovery picks them up.
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
  const codexSkills = path.join(os.homedir(), '.codex', 'skills');

  const discovered = discoverPortableSkills(pluginsRoot);
  console.log(`Discovered ${discovered.length} portable skill(s) under ${pluginsRoot}:`);
  for (const s of discovered) {
    console.log(`  ${s.name.padEnd(34)} ← ${s.plugin}/${path.relative(path.join(pluginsRoot, s.plugin), s.skillDir)}`);
  }

  if (dryRun) {
    console.log('\n(--dry-run) No symlinks written.');
    return;
  }

  const result = syncSkillSymlinks(codexSkills, discovered);
  console.log(`\nSync result for ${codexSkills}:`);
  console.log(`  created:   ${result.created.length}`);
  console.log(`  removed:   ${result.removed.length}`);
  console.log(`  unchanged: ${result.unchanged.length}`);
  if (result.created.length > 0) {
    console.log(`  + ${result.created.join(', ')}`);
  }
  if (result.removed.length > 0) {
    console.log(`  - ${result.removed.join(', ')}`);
  }
}

main();
