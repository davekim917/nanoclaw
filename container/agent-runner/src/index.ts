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
import { getTaskSeriesId } from './db/session-routing.js';
import { ensureMemoryScaffold } from './memory/scaffold.js';
import { MEMORY_SESSION_HOOK } from './memory/session-hook.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import type { McpServerConfig } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';
import { readToneProfile } from './tone-profiles.js';
import {
  setupCodexPrimaryRuntime,
  setupCodexRuntime,
  syncAgentSkillsMirror,
} from './codex-companion-setup.js';
import { activateGcpServiceAccount } from './gcp-auth-setup.js';
import { startResourceTelemetry } from './resource-telemetry.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

function mcpServerSummary(name: string, server: McpServerConfig): string {
  if (server.type === 'sse') {
    throw new Error(`MCP server "${name}" uses deprecated SSE transport. Use type: "http" instead.`);
  }
  if (server.type === 'http') return `http: ${server.url}`;
  return `${server.type ?? 'stdio'}: ${server.command}`;
}

const CWD = '/workspace/agent';

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // GCP service-account: when the host mounted a key (GOOGLE_APPLICATION_CREDENTIALS),
  // activate it so the `gcloud`/`bq` CLIs authenticate. No-op otherwise. All providers.
  activateGcpServiceAccount(log);

  // All providers share one canonical file-memory tree. Graphify indexes these
  // source files; no second derived retrieval store is introduced.
  ensureMemoryScaffold();

  // Runtime-generated system-prompt addendum: agent identity + communication
  // invariants + live destinations map. Rest of the system prompt (per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md (composed base + module fragments). Per-group
  // standing operator customizations live in
  // /workspace/agent/CLAUDE.local.md (auto-loaded); durable memory lives in
  // /workspace/agent/memory/. Canonical bytes enter each admissible turn only
  // through paired untrusted recall; the provider lifecycle hook supplies
  // trusted static handling and write guidance.
  const taskId = getTaskSeriesId();
  const addendum = buildSystemPromptAddendum(
    config.assistantName || undefined,
    taskId ? { kind: 'task', taskId } : { kind: 'chat' },
  );

  // Always-on voice injection. Host resolves per-channel tone (via
  // messaging_group_agents.default_tone → container.json `tone`) and forwards
  // the name in NANOCLAW_DEFAULT_TONE. The name resolves group-local first
  // (groups/<folder>/tone-profiles/) then shared — see ../tone-profiles.ts —
  // so a group-owned persona and a fleet-wide tone are the same mechanism and
  // occupy the same single slot. THIS IS THE ONLY ALWAYS-ON VOICE LAYER: never
  // add a second one (a persona section in a group's instructions file, say),
  // because a per-group layer cannot vary by channel and ends up arguing with
  // this one in rooms where a different voice was selected.
  let toneBlock: string | undefined;
  const toneName = process.env.NANOCLAW_DEFAULT_TONE;
  if (toneName) {
    const toneContent = readToneProfile(toneName);
    if (toneContent !== null) {
      toneBlock = `## Default Tone: ${toneName}\n\nApply this voice to every response in this session — chat replies AND any content you draft (emails, documents, messages). Per-response overrides from the user ("use X tone") take precedence.\n\n${toneContent}`;
      log(`Loaded default tone profile: ${toneName}`);
    } else {
      log(`NANOCLAW_DEFAULT_TONE=${toneName} but no such profile in group or shared tone-profiles — skipping injection`);
    }
  }

  // Capability-awareness note — short and always-on. Points the agent at
  // the `get_capabilities` MCP tool instead of statically listing every
  // CLI/auth detail (v1 pattern drifted from reality).
  const capabilityNote = [
    '## Capability Awareness',
    '',
    "Before saying a service is unavailable, verify it with `mcp__nanoclaw__get_capabilities` using `section: \"session\"`. Absence of a dedicated MCP tool is not proof of no access; follow the live snapshot's activation instructions.",
  ].join('\n');

  const baseInstructions = [toneBlock, capabilityNote, addendum].filter(Boolean).join('\n\n');

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

  // The Codex CLI scrubs stdio MCP server children down to a small
  // proxy/CA allowlist — NANOCLAW_* spawn context never reaches the
  // nanoclaw tool process through inheritance, which made every managed
  // repository tool fail with "repository workgroup context is
  // unavailable" in codex groups. Forward the runner's own NANOCLAW_*
  // vars through the per-server env table (rendered into codex's
  // [mcp_servers.nanoclaw.env] and opencode's environment map); providers
  // that inherit full env merge the same values harmlessly. Unset or
  // empty vars are omitted so "absent" semantics stay intact.
  const nanoclawEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('NANOCLAW_') && value) nanoclawEnv[key] = value;
  }

  // Build MCP servers config: nanoclaw built-in + any from container.json
  // or host-injected NANOCLAW_MCP_SERVERS. Host may inject stdio or http
  // servers — http servers rely on the container's HTTPS_PROXY pointing at
  // the OneCLI gateway for auth.
  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: {
      type: 'stdio',
      command: 'bun',
      args: ['run', mcpServerPath],
      env: nanoclawEnv,
    },
  };

  // MCP names that are HOST-ONLY: container.json's mcpServers cannot wire
  // them, because the host runs a per-session permission gate that the
  // static config would bypass. Anything in this list MUST be injected via
  // NANOCLAW_MCP_SERVERS env (host-controlled) to take effect.
  // (Codex P2 catch on PR #108 — closes the static-declaration bypass.)
  const HOST_ONLY_MCP_NAMES = new Set(['slack-user-token']);

  // Static per-group config from container.json.
  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    if (HOST_ONLY_MCP_NAMES.has(name)) {
      log(
        `Ignored container.json mcpServers[${name}] — host-only MCP; ` +
          `wire via host config (gated per-session) instead`,
      );
      continue;
    }
    mcpServers[name] = serverConfig;
    log(`Additional MCP server: ${name} (${mcpServerSummary(name, serverConfig)})`);
  }

  // Dynamic host-injected servers via env — lets the host wire universal
  // MCPs (DeepWiki, Context7, Exa, etc.) without rewriting every container.json.
  if (process.env.NANOCLAW_MCP_SERVERS) {
    try {
      const additional = JSON.parse(process.env.NANOCLAW_MCP_SERVERS) as Record<string, McpServerConfig>;
      for (const [name, serverConfig] of Object.entries(additional)) {
        mcpServers[name] = serverConfig;
        log(`Additional MCP server: ${name} (${mcpServerSummary(name, serverConfig)})`);
      }
    } catch (e) {
      log(`Failed to parse NANOCLAW_MCP_SERVERS: ${e}`);
    }
  }

  const instructions = baseInstructions;

  // Skills parity: populate `/home/node/.agents/skills/` unconditionally so
  // BOTH codex-primary (helper-codex) AND codex-as-peer (helper running the
  // codex companion) see the same plugin skills (humanizer, impeccable,
  // etc.). Pass runtime so runtime-specific denylists apply
  // correctly — e.g., opencode runtime surfaces workflow-agents skills as
  // text (since there's no codex-plugin loader on opencode), while codex
  // runtime continues to deny them (loaded via .codex-plugin/ instead).
  const skillRuntime: 'codex' | 'opencode' | 'claude' =
    providerName === 'codex' ? 'codex' : providerName === 'opencode' ? 'opencode' : 'claude';
  syncAgentSkillsMirror(skillRuntime);

  // Container-local CODEX_HOME for codex-as-peer mode (invoked by Claude
  // via the codex-companion script). Builds ~/.codex-runtime/ with auth.json
  // symlink + merged config.toml so the peer sees the same MCP servers
  // Claude does — most importantly the in-container `nanoclaw` server.
  // Codex-primary owns a persistent session-local ~/.codex and registers
  // plugins there. Peer-mode Codex uses the synthesized ~/.codex-runtime.
  if (providerName === 'codex') {
    setupCodexPrimaryRuntime();
  } else {
    // Pass the host runtime so the registration log names it accurately. Only the
    // label varies — which plugins get registered is always codex's own set,
    // since this CODEX_HOME is what the peer `codex` process reads.
    const codexHome = setupCodexRuntime(mcpServers, providerName === 'opencode' ? 'opencode' : 'claude');
    if (codexHome) {
      process.env.CODEX_HOME = codexHome;
    }
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    providerConfig: config.providerConfig,
    model: config.model,
    effort: config.effort,
  });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

  const stopResourceTelemetry = startResourceTelemetry(log);
  try {
    await runPollLoop({
      provider,
      providerName,
      cwd: CWD,
      systemContext: { instructions },
    });
  } finally {
    stopResourceTelemetry();
  }
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
