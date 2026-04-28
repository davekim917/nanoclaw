/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import type { McpServerConfig } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Runtime-generated system-prompt addendum: agent identity + communication
  // invariants + live destinations map. Rest of the system prompt (per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md (composed base + module fragments). Per-group
  // memory lives in /workspace/agent/CLAUDE.local.md (auto-loaded).
  const addendum = buildSystemPromptAddendum(config.assistantName || undefined);

  // Always-on tone profile injection. Host resolves per-channel tone (via
  // messaging_group_agents.default_tone → container.json `tone`) and forwards
  // the name in NANOCLAW_DEFAULT_TONE. When set, read the corresponding
  // tone-profiles/<name>.md and prepend it to the system prompt so every
  // response — chat or drafted content — picks up the voice. Mirrors v1
  // index.ts:2138-2147.
  let toneBlock: string | undefined;
  const toneName = process.env.NANOCLAW_DEFAULT_TONE;
  if (toneName) {
    const toneProfilePath = `/workspace/tone-profiles/${toneName}.md`;
    try {
      const toneContent = fs.readFileSync(toneProfilePath, 'utf-8');
      toneBlock = `## Default Tone: ${toneName}\n\nApply this voice to every response in this session — chat replies AND any content you draft (emails, documents, messages). Per-response overrides from the user ("use X tone") take precedence.\n\n${toneContent}`;
      log(`Loaded default tone profile: ${toneName}`);
    } catch {
      log(`NANOCLAW_DEFAULT_TONE=${toneName} but ${toneProfilePath} not found — skipping injection`);
    }
  }

  // Capability-awareness note — short and always-on. Points the agent at
  // the `get_capabilities` MCP tool instead of statically listing every
  // CLI/auth detail (v1 pattern drifted from reality).
  const capabilityNote = [
    '## Capability Awareness',
    '',
    "Before saying you don't have access to a service, VERIFY. Call `mcp__nanoclaw__get_capabilities` with `section: \"session\"` for a live per-service snapshot — it lists the scoped accounts/connections actually wired in this session AND the exact activation step (e.g. which env var to export). Gmail/Calendar/Drive/Docs/Sheets/Slides go through the `gws` CLI via Bash in v2 — there are NO `mcp__gmail__*` / `mcp__calendar__*` tools. Note: `gws auth status` reports `auth_method: none` until you `export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/<name>.json`; that's the CLI's default-path probe missing the mounted files, not the creds being absent.",
  ].join('\n');

  const instructions = [toneBlock, capabilityNote, addendum].filter(Boolean).join('\n\n');

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: nanoclaw built-in + any from container.json
  // or host-injected NANOCLAW_MCP_SERVERS. Host may inject stdio or http
  // servers — http servers rely on the container's HTTPS_PROXY pointing at
  // the OneCLI gateway for auth.
  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: {
      type: 'stdio',
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };

  // Static per-group config from container.json.
  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = serverConfig;
    log(`Additional MCP server: ${name} (${serverConfig.command})`);
  }

  // Dynamic host-injected servers via env — lets the host wire universal
  // MCPs (DeepWiki, Context7, Exa, etc.) without rewriting every container.json.
  if (process.env.NANOCLAW_MCP_SERVERS) {
    try {
      const additional = JSON.parse(process.env.NANOCLAW_MCP_SERVERS) as Record<string, McpServerConfig>;
      for (const [name, serverConfig] of Object.entries(additional)) {
        mcpServers[name] = serverConfig;
        const summary =
          serverConfig.type === 'http' || serverConfig.type === 'sse' ? serverConfig.url : serverConfig.command;
        log(`Additional MCP server: ${name} (${serverConfig.type ?? 'stdio'}: ${summary})`);
      }
    } catch (e) {
      log(`Failed to parse NANOCLAW_MCP_SERVERS: ${e}`);
    }
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    providerConfig: config.providerConfig,
  });

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions },
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
