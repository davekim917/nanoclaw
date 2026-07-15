/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

import type { McpServerConfig } from './providers/types.js';

const DEFAULT_CONFIG_PATH = '/workspace/agent/container.json';

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, McpServerConfig>;
  excludeMcpServers: string[];

  // ADDED: per-provider sticky config from container.json.providerConfig
  providerConfig: Record<string, unknown>;
  model?: string;
  effort?: string;
}

const DEFAULT_MAX_MESSAGES = 10;

let _config: RunnerConfig | null = null;

function validateMcpServers(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  for (const [name, server] of Object.entries(servers)) {
    if (server?.type === 'sse') {
      throw new Error(
        `MCP server "${name}" uses deprecated SSE transport. Use Streamable HTTP (type: "http") instead.`,
      );
    }
  }
  return servers;
}

/**
 * Pure parse — exported so unit tests can verify schema mapping without
 * touching the filesystem.
 */
export function parseRawConfig(raw: Record<string, unknown>): RunnerConfig {
  // NANOCLAW_ASSISTANT_NAME is per-spawn, set by the host (container-runner)
  // after resolving the agent's user-facing name for THIS session's channel
  // (Slack display, Discord username, or agent_group.name fallback). When
  // present it wins over container.json's static value — the JSON is
  // operator-static while the env is channel-aware. See
  // src/container-runner.ts `resolveAssistantName`.
  const envAssistantName = typeof process !== 'undefined' ? process.env?.NANOCLAW_ASSISTANT_NAME : undefined;
  return {
    provider: (raw.provider as string) || 'claude',
    assistantName: envAssistantName || (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: validateMcpServers((raw.mcpServers as RunnerConfig['mcpServers']) || {}),
    excludeMcpServers: Array.isArray(raw.excludeMcpServers)
      ? raw.excludeMcpServers.filter((name): name is string => typeof name === 'string')
      : [],
    providerConfig: (raw.providerConfig as Record<string, unknown>) ?? {},
    model: (raw.model as string) || undefined,
    effort: (raw.effort as string) || undefined,
  };
}

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${DEFAULT_CONFIG_PATH}, using defaults`);
  }

  _config = parseRawConfig(raw);

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}

/** Reset cached config — for use in tests only. */
export function _resetConfig(): void {
  _config = null;
}
