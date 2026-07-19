/**
 * Host-side container config for the `codex` provider.
 *
 * Codex reads auth and MCP config from ~/.codex. We give each session its
 * own private copy of that directory so:
 *
 * - The user's host ~/.codex/auth.json reaches the container without us
 *   touching their host config.toml (which the host's own `codex` CLI
 *   might be using).
 * - The in-container provider can rewrite config.toml freely on every
 *   wake with container-appropriate MCP server paths, without racing
 *   other sessions or leaking per-session paths back to the host.
 * - Host-installed Codex plugins remain resolvable in the container: config
 *   preserves `[plugins.*]` tables, and the plugin cache is mounted read-only
 *   at the matching `~/.codex/plugins` path.
 *
 * Env passthrough covers the two knobs that are read at runtime:
 *   OPENAI_API_KEY  — fallback auth when auth.json isn't a subscription token
 *   CODEX_MODEL     — model override if the user wants something other than the default
 *   OPENAI_BASE_URL — rare, but supports API-compatible alternates
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { assertValidGroupFolder } from '../group-folder.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

function resolveCodexSourceDir(agentGroupFolder: string | undefined, agentGroupId: string, hostHome: string): string {
  const scopedFolder = agentGroupFolder || agentGroupId;
  // Defense-in-depth — same rationale as resolveOpenCodeSourceDir in opencode.ts.
  assertValidGroupFolder(scopedFolder);
  const scoped = path.join(hostHome, `.codex-${scopedFolder}`);
  if (fs.existsSync(path.join(scoped, 'auth.json'))) return scoped;
  return path.join(hostHome, '.codex');
}

function stripMcpServerBlocks(toml: string): string {
  const out: string[] = [];
  let inGitNexusBlock = false;
  for (const line of toml.split('\n')) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      const table = header[1].trim().replace(/["']/g, '').toLowerCase();
      inGitNexusBlock = table.includes('gitnexus');
      if (inGitNexusBlock) continue;
    }
    if (!inGitNexusBlock) out.push(line);
  }
  return out.join('\n').trimEnd() + '\n';
}

function unescapeTomlBasicString(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function rewriteLocalMarketplaceSourcesForContainer(toml: string, hostHome: string): string {
  const hostPluginsRoot = path.join(hostHome, 'plugins');
  const lines = toml.split('\n');
  return (
    lines
      .map((line) => {
        const match = line.match(/^(\s*source\s*=\s*)"((?:\\.|[^"\\])*)"\s*$/);
        if (!match) return line;
        const source = unescapeTomlBasicString(match[2]);
        const relative = path.relative(hostPluginsRoot, source);
        if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') return line;
        return `${match[1]}${tomlBasicString(path.posix.join('/workspace/plugins', relative.split(path.sep).join('/')))}`;
      })
      .join('\n')
      .trimEnd() + '\n'
  );
}

function resolveCodexPluginsDir(sourceDir: string, hostHome: string): string | null {
  const candidates = [
    // Per-group Codex homes may eventually carry their own plugin cache.
    path.join(sourceDir, 'plugins'),
    // Today plugin installs are normally global even when auth is scoped.
    path.join(hostHome, '.codex', 'plugins'),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

registerProviderContainerConfig('codex', (ctx) => {
  const codexDir = path.join(ctx.sessionDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });
  const mounts = [{ hostPath: codexDir, containerPath: '/home/node/.codex', readonly: false }];

  // Copy auth.json from the per-group Codex home when present
  // (`~/.codex-<folder>/auth.json`), otherwise fall back to global ~/.codex.
  // Copy config.toml too, but remove only container-retired GitNexus reentry
  // tables. All unrelated MCP, plugin, model, approval, and sandbox settings
  // remain intact.
  const hostHome = ctx.hostEnv.HOME || os.homedir();
  if (hostHome) {
    const sourceDir = resolveCodexSourceDir(ctx.agentGroupFolder, ctx.agentGroupId, hostHome);
    const hostAuth = path.join(sourceDir, 'auth.json');
    if (fs.existsSync(hostAuth)) {
      fs.copyFileSync(hostAuth, path.join(codexDir, 'auth.json'));
    }
    const hostConfig = path.join(sourceDir, 'config.toml');
    const globalConfig = path.join(hostHome, '.codex', 'config.toml');
    const configSource = fs.existsSync(hostConfig) ? hostConfig : globalConfig;
    if (fs.existsSync(configSource)) {
      const stripped = stripMcpServerBlocks(fs.readFileSync(configSource, 'utf-8'));
      const rewritten = rewriteLocalMarketplaceSourcesForContainer(stripped, hostHome);
      fs.writeFileSync(path.join(codexDir, 'config.toml'), rewritten);
    }
    const pluginsDir = resolveCodexPluginsDir(sourceDir, hostHome);
    if (pluginsDir) {
      fs.mkdirSync(path.join(codexDir, 'plugins'), { recursive: true });
      mounts.push({ hostPath: pluginsDir, containerPath: '/home/node/.codex/plugins', readonly: true });
    }

    // agents/: surface the synced named subagent role definitions so a
    // codex-primary session can spawn the same custom roles the host has
    // (architecture-advisor, code-review-specialist, security-reviewer, ...).
    //
    // The `multi_agent` feature is stable + default-on in Codex 0.140, so the
    // spawn_agent/wait_agent/close_agent tools — and thus GENERIC subagents —
    // already work in the container without this. What was missing is the
    // NAMED role layer: Codex reads `[agents.*]` roles from
    // $CODEX_HOME/agents/*.toml, which `src/codex-sync.ts` writes to the
    // per-group (`~/.codex-<folder>/agents/`) and global (`~/.codex/agents/`)
    // homes. Our fresh session-local /home/node/.codex copied auth/config/
    // plugins but not agents/, so those roles never reached codex-primary
    // groups. Mount RO (definitions are read-only to Codex; keeps host
    // re-syncs live and prevents the container from mutating host defs).
    // Mirrors codex-companion-setup.ts's agents/ symlink for the peer path.
    const sourceAgents = path.join(sourceDir, 'agents');
    const globalAgents = path.join(hostHome, '.codex', 'agents');
    const agentsDir = fs.existsSync(sourceAgents) ? sourceAgents : fs.existsSync(globalAgents) ? globalAgents : null;
    if (agentsDir) {
      fs.mkdirSync(path.join(codexDir, 'agents'), { recursive: true });
      mounts.push({ hostPath: agentsDir, containerPath: '/home/node/.codex/agents', readonly: true });
    }
  }

  const env: Record<string, string> = {};
  for (const key of ['OPENAI_API_KEY', 'CODEX_MODEL', 'OPENAI_BASE_URL'] as const) {
    const value = ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  return {
    mounts,
    env,
  };
});
