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
 *
 * Env passthrough covers the two knobs that are read at runtime:
 *   OPENAI_API_KEY  — fallback auth when auth.json isn't a subscription token
 *   CODEX_MODEL     — model override if the user wants something other than the default
 *   OPENAI_BASE_URL — rare, but supports API-compatible alternates
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

function resolveCodexSourceDir(agentGroupFolder: string | undefined, agentGroupId: string, hostHome: string): string {
  const scopedFolder = agentGroupFolder || agentGroupId;
  const scoped = path.join(hostHome, `.codex-${scopedFolder}`);
  if (fs.existsSync(path.join(scoped, 'auth.json'))) return scoped;
  return path.join(hostHome, '.codex');
}

function stripMcpServerBlocks(toml: string): string {
  const out: string[] = [];
  let inMcpBlock = false;
  for (const line of toml.split('\n')) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      inMcpBlock = header[1].trim().startsWith('mcp_servers.');
      if (inMcpBlock) continue;
    }
    if (!inMcpBlock) out.push(line);
  }
  return out.join('\n').trimEnd() + '\n';
}

registerProviderContainerConfig('codex', (ctx) => {
  const codexDir = path.join(ctx.sessionDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  // Copy auth.json from the per-group Codex home when present
  // (`~/.codex-<folder>/auth.json`), otherwise fall back to global ~/.codex.
  // Copy config.toml too, but strip MCP blocks: the container rewrites MCPs
  // from runtime wiring, while non-MCP blocks such as [plugins.*] must survive.
  const hostHome = ctx.hostEnv.HOME || os.homedir();
  if (hostHome) {
    const sourceDir = resolveCodexSourceDir(ctx.agentGroupFolder, ctx.agentGroupId, hostHome);
    const hostAuth = path.join(sourceDir, 'auth.json');
    if (fs.existsSync(hostAuth)) {
      fs.copyFileSync(hostAuth, path.join(codexDir, 'auth.json'));
    }
    const hostConfig = path.join(sourceDir, 'config.toml');
    if (fs.existsSync(hostConfig)) {
      const stripped = stripMcpServerBlocks(fs.readFileSync(hostConfig, 'utf-8'));
      fs.writeFileSync(path.join(codexDir, 'config.toml'), stripped);
    }
  }

  const env: Record<string, string> = {};
  for (const key of ['OPENAI_API_KEY', 'CODEX_MODEL', 'OPENAI_BASE_URL'] as const) {
    const value = ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  return {
    mounts: [{ hostPath: codexDir, containerPath: '/home/node/.codex', readonly: false }],
    env,
  };
});
