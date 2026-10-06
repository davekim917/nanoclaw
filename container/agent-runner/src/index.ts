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
import { builtInNanoclawMcpEnv } from './nanoclaw-mcp-env.js';
import { resolvePluginServer } from './plugin-mcp.js';
// Module barrel — loads registration modules, including the singular mailbox slot.
import './modules/index.js';
import { getAgentMailbox, readMailboxContext } from './mailbox/index.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import type { McpServerConfig } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';
import { readToneProfile } from './tone-profiles.js';
import { readChannelInstructions, isSafeInstructionsProfileName } from './channel-instructions.js';
import { setupCodexPrimaryRuntime, setupCodexRuntime, syncAgentSkillsMirror } from './codex-companion-setup.js';
import { activateGcpServiceAccount } from './gcp-auth-setup.js';
import { ensureClaudeUserConfig } from './claude-user-config.js';
import { startResourceTelemetry } from './resource-telemetry.js';
import { CLAUDE_REVIEW_SOCKET_ENV } from './cli/claude-review-contract.js';
import { startClaudeReviewService } from './cli/claude-review-service.js';
import { dropRetiredMcpServers } from './retired-mcp-servers.js';

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
  // Start before any provider snapshots process.env; the service reads the current runner env per request.
  let reviewService: Awaited<ReturnType<typeof startClaudeReviewService>> | undefined;
  delete process.env[CLAUDE_REVIEW_SOCKET_ENV];
  try {
    reviewService = await startClaudeReviewService({ onDiagnostic: log });
    process.env[CLAUDE_REVIEW_SOCKET_ENV] = reviewService.socketPath;
  } catch {
    log('Claude review launcher unavailable: could not start local review service');
  }
  let reviewServiceStopped = false;
  const stopReviewService = async () => {
    if (reviewServiceStopped) return;
    reviewServiceStopped = true;
    delete process.env[CLAUDE_REVIEW_SOCKET_ENV];
    await reviewService?.stop();
  };
  let handlingSignal = false;
  const stopForSignal = (signal: NodeJS.Signals) => {
    if (handlingSignal) return;
    handlingSignal = true;
    void stopReviewService().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', stopForSignal);
  process.once('SIGTERM', stopForSignal);
  const providerName = config.provider.toLowerCase() as ProviderName;
  const mailbox = getAgentMailbox();
  await mailbox.start(await readMailboxContext());

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  activateGcpServiceAccount(log);
  ensureClaudeUserConfig(log);

  ensureMemoryScaffold();

  // Runtime-generated system-prompt addendum: agent identity + communication
  // invariants + live destinations map. Rest of the system prompt (per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md (the group's standing instructions + composed
  // base + module fragments); durable memory lives in
  // /workspace/agent/memory/. Canonical bytes enter each admissible turn only
  // through paired untrusted recall; the provider lifecycle hook supplies
  // trusted static handling and write guidance.
  const taskId = getTaskSeriesId();
  const addendum = buildSystemPromptAddendum(
    config.assistantName || undefined,
    taskId ? { kind: 'task', taskId } : { kind: 'chat' },
  );

  // THE ONLY ALWAYS-ON VOICE LAYER: never add a second one (e.g. a persona in a group's instructions);
  // it cannot vary by channel and fights this one. Channel instructions are a separate layer, not a voice slot.
  let toneBlock: string | undefined;
  const toneName = process.env.NANOCLAW_DEFAULT_TONE;
  if (toneName) {
    const toneContent = readToneProfile(toneName);
    if (toneContent !== null) {
      toneBlock = `## Default Tone: ${toneName}\n\nApply this voice to every response in this session — chat replies AND any content you draft (emails, documents, messages). Per-response overrides from the user ("use X tone") take precedence.\n\n${toneContent}`;
      log(`Loaded default tone profile: ${toneName}`);
    } else {
      log(
        `NANOCLAW_DEFAULT_TONE=${toneName} but no such profile in group or shared tone-profiles — skipping injection`,
      );
    }
  }

  const capabilityNote = [
    '## Capability Awareness',
    '',
    'Before saying a service is unavailable, verify it with `mcp__nanoclaw__get_capabilities` using `section: "session"`. Absence of a dedicated MCP tool is not proof of no access; follow the live snapshot\'s activation instructions.',
  ].join('\n');

  // Ordered before the tone block: the room's rules must be read before the voice. A missing or unreadable
  // profile is a warning, never a session failure.
  let channelInstructionsBlock: string | undefined;
  const instructionsProfile = process.env.NANOCLAW_INSTRUCTIONS_PROFILE;
  if (instructionsProfile) {
    if (!isSafeInstructionsProfileName(instructionsProfile)) {
      log(
        `NANOCLAW_INSTRUCTIONS_PROFILE=${instructionsProfile} is not a valid profile name (expected ^[a-z0-9][a-z0-9-]*$) — skipping injection`,
      );
    } else {
      const content = readChannelInstructions(instructionsProfile);
      if (content !== null) {
        channelInstructionsBlock = `# Channel instructions (${instructionsProfile})\n\nOperating rules for THIS channel, on top of your standing instructions. Where they conflict with a general habit of yours, these win; where they conflict with an explicit instruction from the user in this conversation, the user wins.\n\n${content}`;
        log(`Loaded channel instructions profile: ${instructionsProfile}`);
      } else {
        log(
          `NANOCLAW_INSTRUCTIONS_PROFILE=${instructionsProfile} but no such file in /workspace/channel-instructions — skipping injection`,
        );
      }
    }
  }

  const baseInstructions = [channelInstructionsBlock, toneBlock, capabilityNote, addendum].filter(Boolean).join('\n\n');

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

  // Codex scrubs stdio MCP children's env down to a proxy/CA allowlist, so NANOCLAW_* must be forwarded
  // explicitly through the per-server env table. Unset or empty vars are omitted.
  const nanoclawEnv = builtInNanoclawMcpEnv();

  // Build MCP servers config: nanoclaw built-in + any from container.json
  const mcpServers: Record<string, McpServerConfig> = {
    nanoclaw: {
      type: 'stdio',
      command: 'bun',
      args: ['run', mcpServerPath],
      env: nanoclawEnv,
    },
  };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    // Plugin-shipped servers get ${PLUGIN_ROOT}/${PLUGIN_DATA} expansion and
    // the two injected env vars; everything else passes through untouched.
    mcpServers[name] = resolvePluginServer(serverConfig);
    log(`Additional MCP server: ${name} (${mcpServerSummary(name, serverConfig)})`);
  }

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

  dropRetiredMcpServers(mcpServers, log);
  const instructions = baseInstructions;

  // Unconditional so codex-primary and codex-as-peer see the same plugin skills; the runtime picks the denylist.
  const skillRuntime: 'codex' | 'opencode' | 'claude' =
    providerName === 'codex' ? 'codex' : providerName === 'opencode' ? 'opencode' : 'claude';
  syncAgentSkillsMirror(skillRuntime);

  // Codex-primary uses a persistent session-local ~/.codex; peer-mode Codex (codex-companion) uses the
  // synthesized ~/.codex-runtime.
  if (providerName === 'codex') {
    setupCodexPrimaryRuntime();
  } else {
    // null means no codex auth is mounted, so CODEX_HOME stays unset. Any other failure returns the nonexistent
    // FAILED_CODEX_HOME sentinel, which must still be assigned: an unset CODEX_HOME would run codex unguarded
    // against the staged ~/.codex.
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
    speed: config.speed,
  });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  // Must run after mailbox.start has opened the session DB.
  provider.restorePersistedCredentialSlot?.();

  const stopResourceTelemetry = startResourceTelemetry(log);
  try {
    await runPollLoop({
      provider,
      providerName,
      providerFallbackActive: config.fallbackApplied,
      cwd: CWD,
      systemContext: { instructions },
    });
  } finally {
    process.off('SIGINT', stopForSignal);
    process.off('SIGTERM', stopForSignal);
    await stopReviewService();
    stopResourceTelemetry();
    await mailbox.stop();
  }
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
