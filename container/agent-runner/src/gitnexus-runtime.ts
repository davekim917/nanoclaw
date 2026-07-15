import { createHash } from 'crypto';
import fs, { type Dirent } from 'fs';
import path from 'path';

import type { McpServerConfig } from './providers/types.js';

const DEFAULT_PLUGINS_ROOT = '/workspace/plugins';
const DEFAULT_CLI_PATH = '/pnpm/gitnexus';
const DEFAULT_OVERLAY_ROOT = '/tmp/nanoclaw-plugin-overlays';

const GITNEXUS_INSTRUCTIONS = [
  '## GitNexus Code Intelligence',
  '',
  'The GitNexus plugin is active for this session. Before modifying an existing function, class, or other named symbol, call `gitnexus_impact` with `direction: "upstream"`. Report the blast radius and stop for human review when the result is HIGH or CRITICAL. Before committing, call `gitnexus_detect_changes`. Use `gitnexus_rename` for cross-file renames instead of blind find-and-replace.',
  '',
  'If GitNexus reports that the repository is missing or stale, run `/pnpm/gitnexus analyze --skip-agents-md --skip-skills` from that repository root, then retry the tool. These requirements apply only while the GitNexus plugin and tools are available.',
].join('\n');

interface GitNexusRuntimeOptions {
  pluginsRoot?: string;
  cliPath?: string;
  excludedMcpServers?: readonly string[];
  injectInstructions?: boolean;
}

export interface GitNexusRuntimeResult {
  active: boolean;
  injected: boolean;
  instructions?: string;
}

function manifestName(pluginDir: string): string | undefined {
  for (const relativePath of [
    path.join('.claude-plugin', 'plugin.json'),
    path.join('.codex-plugin', 'plugin.json'),
  ]) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, relativePath), 'utf8')) as {
        name?: unknown;
      };
      if (typeof manifest.name === 'string') return manifest.name;
    } catch {
      // Not a plugin root for this runtime; keep checking other manifests.
    }
  }
  return undefined;
}

function findGitNexusPlugin(pluginsRoot: string): string | undefined {
  if (!fs.existsSync(pluginsRoot)) return undefined;

  const pending: Array<{ dir: string; depth: number }> = [{ dir: pluginsRoot, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) break;

    if (current.depth > 0 && manifestName(current.dir)?.toLowerCase() === 'gitnexus') {
      return current.dir;
    }
    if (current.depth >= 3) continue;

    let entries: Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      pending.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return undefined;
}

/**
 * Add the image-pinned GitNexus MCP server when the GitNexus plugin is mounted.
 * The repository and team-workflow instructions remain portable; the optional
 * plugin is the sole activation signal for both the tools and hard guidance.
 */
export function configureGitNexusRuntime(
  mcpServers: Record<string, McpServerConfig>,
  options: GitNexusRuntimeOptions = {},
): GitNexusRuntimeResult {
  const pluginsRoot = options.pluginsRoot ?? process.env.CLAUDE_PLUGINS_ROOT ?? DEFAULT_PLUGINS_ROOT;
  const cliPath = options.cliPath ?? DEFAULT_CLI_PATH;
  const pluginDir = findGitNexusPlugin(pluginsRoot);
  if (!pluginDir || options.excludedMcpServers?.includes('gitnexus')) {
    return { active: false, injected: false };
  }

  let injected = false;
  if (!mcpServers.gitnexus) {
    if (!fs.existsSync(cliPath)) return { active: false, injected: false };
    mcpServers.gitnexus = {
      type: 'stdio',
      command: cliPath,
      args: ['mcp'],
      env: {},
    };
    injected = true;
  }

  return {
    active: true,
    injected,
    ...(options.injectInstructions ? { instructions: GITNEXUS_INSTRUCTIONS } : {}),
  };
}

/**
 * Claude plugins may declare their own MCP server in `.mcp.json`. GitNexus's
 * manifest launches unpinned `npx gitnexus@latest`, duplicating the pinned
 * server configured above. Present Claude with a symlink overlay that keeps
 * the plugin's skills and hooks but deliberately omits only that MCP manifest.
 */
export function prepareGitNexusPluginForClaude(
  pluginDir: string,
  overlayRoot = DEFAULT_OVERLAY_ROOT,
): string {
  if (manifestName(pluginDir)?.toLowerCase() !== 'gitnexus') return pluginDir;

  const key = createHash('sha256').update(path.resolve(pluginDir)).digest('hex').slice(0, 16);
  const overlayDir = path.join(overlayRoot, `gitnexus-${key}`);
  fs.mkdirSync(overlayDir, { recursive: true });

  let entries: Dirent[];
  try {
    entries = fs.readdirSync(pluginDir, { withFileTypes: true });
  } catch {
    return pluginDir;
  }

  for (const entry of entries) {
    if (entry.name === '.mcp.json') continue;
    const source = path.join(pluginDir, entry.name);
    const target = path.join(overlayDir, entry.name);
    if (fs.existsSync(target)) continue;
    try {
      fs.symlinkSync(source, target, entry.isDirectory() ? 'dir' : 'file');
    } catch {
      // A concurrent query may have created the same stable overlay entry.
      if (!fs.existsSync(target)) return pluginDir;
    }
  }

  return overlayDir;
}
