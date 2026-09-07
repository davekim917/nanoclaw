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

  /**
   * Where the host routes spawns while this provider is unavailable. The
   * runner only needs to know whether one EXISTS: when a turn dies on a
   * provider-level quota and a fallback is declared, the failure is reported
   * to the host and the session respawns onto the fallback instead of
   * surfacing a dead-end error to the user.
   */
  providerFallback?: { provider: string; model?: string; effort?: string };
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
  // Spawn-time provider fallback. The host decides which provider this
  // container runs (it owns the outage record and the credentials it
  // mounted); container.json is static per group and cannot express "the
  // primary is exhausted right now". Same precedence shape as the assistant
  // name: env is per-spawn truth, the file is the static default.
  const env = typeof process !== 'undefined' ? process.env : undefined;
  const envProvider = env?.NANOCLAW_PROVIDER_OVERRIDE;
  const envModel = env?.NANOCLAW_MODEL_OVERRIDE;
  // Channel defaults are injected by the host at spawn time. Keep them on a
  // provider-specific surface: Codex's config schema uses `model` and
  // `reasoning_effort`, while Claude uses `model` and `effort`. They must be
  // applied only to the primary Codex provider; a provider fallback gets its
  // own model/effort from providerFallback / the generic bridge above.
  const envCodexModel = env?.NANOCLAW_CODEX_MODEL_OVERRIDE;
  const envCodexEffort = env?.NANOCLAW_CODEX_EFFORT_OVERRIDE;
  const fileProvider = (raw.provider as string) || 'claude';
  const provider = envProvider || fileProvider;
  // `providerConfig`, `model` and `effort` in the file describe the PRIMARY
  // provider. Under a spawn-time override they are the wrong provider's
  // settings, and the provider config schemas are strict — codex's
  // `reasoning_effort` key is a fatal boot error under claude, which turned
  // every fallback spawn into an instant crash loop. Take the declared
  // fallback's own model/effort instead; drop the primary's sticky config.
  const declaredFallback = raw.providerFallback as RunnerConfig['providerFallback'];
  const onFallback = provider !== fileProvider;
  const activeFallback = onFallback && declaredFallback?.provider === provider ? declaredFallback : undefined;
  const configuredProviderConfig = (raw.providerConfig as Record<string, unknown>) ?? {};
  const providerConfig = onFallback ? {} : { ...configuredProviderConfig };
  const configuredModel = typeof raw.model === 'string' ? raw.model : undefined;
  const configuredEffort = typeof raw.effort === 'string' ? raw.effort : undefined;
  const configuredProviderModel = typeof providerConfig.model === 'string' ? providerConfig.model : undefined;
  const configuredProviderEffort =
    typeof providerConfig.reasoning_effort === 'string' ? providerConfig.reasoning_effort : undefined;
  const activeCodexModel = !onFallback && provider === 'codex' ? envCodexModel : undefined;
  const activeCodexEffort = !onFallback && provider === 'codex' ? envCodexEffort : undefined;
  if (!onFallback && provider === 'codex') {
    // Channel values beat the per-agent provider config, which in turn beats
    // the provider-level model/effort fields materialized by `ncl groups
    // config`. Copy into the strict providerConfig object because Codex reads
    // its sticky values there at app-server startup.
    const codexModel = activeCodexModel || configuredProviderModel || configuredModel;
    const codexEffort = activeCodexEffort || configuredProviderEffort || configuredEffort;
    if (codexModel) providerConfig.model = codexModel;
    if (codexEffort) providerConfig.reasoning_effort = codexEffort;
  }
  return {
    provider,
    assistantName: envAssistantName || (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: validateMcpServers((raw.mcpServers as RunnerConfig['mcpServers']) || {}),
    excludeMcpServers: Array.isArray(raw.excludeMcpServers)
      ? raw.excludeMcpServers.filter((name): name is string => typeof name === 'string')
      : [],
    providerConfig,
    model:
      activeCodexModel ||
      envModel ||
      activeFallback?.model ||
      (onFallback ? undefined : configuredProviderModel || configuredModel) ||
      undefined,
    effort:
      activeCodexEffort ||
      activeFallback?.effort ||
      (onFallback ? undefined : configuredProviderEffort || configuredEffort) ||
      undefined,
    providerFallback: declaredFallback || undefined,
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
