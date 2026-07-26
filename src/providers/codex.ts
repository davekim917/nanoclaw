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
 * - Plugin delivery is container-owned. Host `[plugins.*]` /
 *   `[marketplaces.*]` state is removed before the config enters the
 *   container; the agent-runner registers the mounted `/workspace/plugins`
 *   sources into this session-local Codex home on every spawn.
 *
 * Env passthrough covers the two knobs that are read at runtime:
 *   OPENAI_API_KEY  — fallback auth when auth.json isn't a subscription token
 *   CODEX_MODEL     — model override if the user wants something other than the default
 *   OPENAI_BASE_URL — rare, but supports API-compatible alternates
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  assertRealDirectory,
  removeUntrustedPathEntry,
  replaceUntrustedDirectory,
  replaceUntrustedFile,
} from '../fs-safety.js';
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

function stripPluginBlocks(toml: string): string {
  const out: string[] = [];
  let inPluginBlock = false;
  for (const line of toml.split('\n')) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      const table = header[1].trim();
      inPluginBlock =
        table === 'plugins' ||
        table === 'marketplaces' ||
        table === 'plugin_marketplaces' ||
        table.startsWith('plugins.') ||
        table.startsWith('marketplaces.') ||
        table.startsWith('plugin_marketplaces.');
      if (inPluginBlock) continue;
    }
    if (!inPluginBlock) out.push(line);
  }
  return out.join('\n').trimEnd() + '\n';
}

registerProviderContainerConfig('codex', (ctx) => {
  const codexDir = path.join(ctx.sessionDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });
  assertRealDirectory(codexDir);
  // The plugin cache is derived exclusively from `/workspace/plugins`.
  // Rebuild it on every container spawn so an unchanged plugin version cannot
  // leave stale bytes in a long-lived session directory.
  removeUntrustedPathEntry(codexDir, 'plugins');
  // Remove the top-level derived temp entry, not `.tmp/marketplaces`: `.tmp`
  // was container-writable and could otherwise redirect host cleanup through
  // a planted intermediate symlink.
  removeUntrustedPathEntry(codexDir, '.tmp');
  const mounts = [{ hostPath: codexDir, containerPath: '/home/node/.codex', readonly: false }];

  // Copy auth.json from the per-group Codex home when present
  // (`~/.codex-<folder>/auth.json`), otherwise fall back to global ~/.codex.
  // Copy config.toml too, but remove container-retired GitNexus reentry
  // surfaces and every host plugin/marketplace table. All unrelated MCP,
  // model, approval, sandbox, and feature settings remain intact.
  const hostHome = ctx.hostEnv.HOME || os.homedir();
  let authContents: Buffer | null = null;
  let configContents = '';
  let agentsDir: string | null = null;
  if (hostHome) {
    const sourceDir = resolveCodexSourceDir(ctx.agentGroupFolder, ctx.agentGroupId, hostHome);
    const hostAuth = path.join(sourceDir, 'auth.json');
    if (fs.existsSync(hostAuth)) {
      authContents = fs.readFileSync(hostAuth);
    }
    const hostConfig = path.join(sourceDir, 'config.toml');
    const globalConfig = path.join(hostHome, '.codex', 'config.toml');
    const configSource = fs.existsSync(hostConfig) ? hostConfig : globalConfig;
    if (fs.existsSync(configSource)) {
      const withoutGitNexus = stripMcpServerBlocks(fs.readFileSync(configSource, 'utf-8'));
      configContents = stripPluginBlocks(withoutGitNexus);
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
    agentsDir = fs.existsSync(sourceAgents) ? sourceAgents : fs.existsSync(globalAgents) ? globalAgents : null;
  }

  // Every generated entry may have been replaced while the prior container
  // owned this RW mount. Recreate them without following prior symlinks.
  if (authContents) replaceUntrustedFile(codexDir, 'auth.json', authContents);
  else removeUntrustedPathEntry(codexDir, 'auth.json');
  replaceUntrustedFile(codexDir, 'config.toml', configContents);
  removeUntrustedPathEntry(codexDir, 'agents');
  if (agentsDir) {
    replaceUntrustedDirectory(codexDir, 'agents');
    mounts.push({ hostPath: agentsDir, containerPath: '/home/node/.codex/agents', readonly: true });
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
