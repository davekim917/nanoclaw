/**
 * Shared discovery for Claude-format subagent `.md` files.
 *
 * Both codex-sync and opencode-sync need the same source set, so the walk
 * lives here. Output ordering: personal scope under ~/.claude/agents/ wins
 * over plugin-tree (recursive scan under ~/plugins/) when names collide — a
 * user-authored override should beat a plugin-shipped default.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadPluginScopes, scopedPluginNames } from './plugin-scopes.js';

export interface DiscoveredSubagent {
  name: string;
  path: string;
  source: 'plugin' | 'personal';
}

/**
 * Find Claude-format subagent `.md` files in two locations:
 *   1. `~/plugins/<plugin>/[plugins/<sub>/]agents/*.md`
 *   2. `~/.claude/agents/*.md` (personal scope)
 *
 * First-occurrence-by-name wins, with personal scope outranking plugins so a
 * user-authored override beats a plugin-shipped default. Runtime-specific
 * dirs (`.claude/`, `.cursor/`, `.codex/`, etc.) under a plugin root are
 * skipped — those are runtime-specific copies; we want the canonical Claude
 * `.md` shape only. Hidden dirs (starting with `.`) and `deprecated/` dirs
 * are skipped too.
 */
export function discoverClaudeSubagents(): DiscoveredSubagent[] {
  const home = os.homedir();
  const seen = new Map<string, DiscoveredSubagent>();

  // Personal scope first — these override plugin defaults.
  const personalDir = path.join(home, '.claude', 'agents');
  if (fs.existsSync(personalDir)) {
    for (const f of fs.readdirSync(personalDir)) {
      if (!f.endsWith('.md')) continue;
      const name = f.replace(/\.md$/, '');
      seen.set(name, { name, path: path.join(personalDir, f), source: 'personal' });
    }
  }

  // Plugin tree. A workgroup-scoped plugin's agents are never mirrored: both
  // consumers (codex-sync, opencode-sync) write to targets not keyed by
  // workgroup (src/plugin-scopes.ts). Claude loads plugin agents from the
  // plugin mount, which the scope already gates.
  const pluginsRoot = path.join(home, 'plugins');
  if (fs.existsSync(pluginsRoot)) {
    const scoped = scopedPluginNames(loadPluginScopes());
    for (const plugin of fs.readdirSync(pluginsRoot)) {
      if (plugin.startsWith('.') || scoped.has(plugin)) continue;
      walkPluginAgents(path.join(pluginsRoot, plugin), seen);
    }
  }

  return [...seen.values()];
}

/**
 * The walk under one plugin root. Exported for read-only audits
 * (scripts/model-inventory.ts) that must see scoped plugins too — the mirror
 * consumers above deliberately skip those.
 */
export function walkPluginAgents(dir: string, seen: Map<string, DiscoveredSubagent>, depth = 0): void {
  if (depth > 3) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'deprecated') continue;
    if (entry.name === 'node_modules') continue;
    if (!entry.isDirectory()) continue;
    const childPath = path.join(dir, entry.name);
    if (entry.name === 'agents') {
      for (const file of fs.readdirSync(childPath)) {
        if (!file.endsWith('.md')) continue;
        const name = file.replace(/\.md$/, '');
        if (seen.has(name)) continue;
        seen.set(name, { name, path: path.join(childPath, file), source: 'plugin' });
      }
      continue;
    }
    walkPluginAgents(childPath, seen, depth + 1);
  }
}
