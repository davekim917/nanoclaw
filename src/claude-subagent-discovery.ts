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
 * Claude-format subagent `.md` files from `~/.claude/agents/*.md` and
 * `~/plugins/<plugin>/[plugins/<sub>/]agents/*.md`. First occurrence by name wins, personal scope first.
 * Runtime-specific (`.claude/`, `.cursor/`, `.codex/`), hidden and `deprecated/` dirs under a plugin root are skipped.
 */
export function discoverClaudeSubagents(): DiscoveredSubagent[] {
  const home = os.homedir();
  const seen = new Map<string, DiscoveredSubagent>();

  const personalDir = path.join(home, '.claude', 'agents');
  if (fs.existsSync(personalDir)) {
    for (const f of fs.readdirSync(personalDir)) {
      if (!f.endsWith('.md')) continue;
      const name = f.replace(/\.md$/, '');
      seen.set(name, { name, path: path.join(personalDir, f), source: 'personal' });
    }
  }

  // A workgroup-scoped plugin's agents are never mirrored: both consumers write targets not keyed by workgroup.
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

function walkPluginAgents(dir: string, seen: Map<string, DiscoveredSubagent>, depth = 0): void {
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
