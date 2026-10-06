/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

import { providerContract } from './providers/contract.js';
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

  providerConfig: Record<string, unknown>;
  model?: string;
  effort?: string;
  /** Provider speed tier from container.json; the host validated it against the provider's tiers. */
  speed?: string;

  /** True only when this spawn runs on the group's declared secondary provider; task pins validated for the primary must not cross into it. */
  fallbackApplied: boolean;

  /** The runner only checks that one exists: a provider-quota death is then reported to the host for respawn. */
  providerFallback?: { provider: string; model?: string; effort?: string };

  /** Only an explicit `false` disables it; missing, null or non-boolean means ON. */
  statusSubtext: boolean;
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

export function parseRawConfig(raw: Record<string, unknown>): RunnerConfig {
  // Per-spawn, channel-aware name from the host; wins over container.json's static value.
  const envAssistantName = typeof process !== 'undefined' ? process.env?.NANOCLAW_ASSISTANT_NAME : undefined;
  // Env is per-spawn truth (the host owns the outage record); the file is the static default.
  const env = typeof process !== 'undefined' ? process.env : undefined;
  const envProvider = env?.NANOCLAW_PROVIDER_OVERRIDE;
  const envModel = env?.NANOCLAW_MODEL_OVERRIDE;
  // Provider equality cannot detect a fallback (a Codex-pinned session may fall back to the file's provider),
  // so the host's decision is carried explicitly.
  const envFallbackApplied = env?.NANOCLAW_PROVIDER_FALLBACK_APPLIED === '1';
  const fileProvider = (raw.provider as string) || 'claude';
  const provider = envProvider || fileProvider;
  // The file's providerConfig/model/effort describe the PRIMARY provider. Under an override they are the wrong
  // provider's settings and strict schemas crash boot (codex `reasoning_effort` under claude), so use the
  // declared fallback's own model/effort and drop the primary's sticky config.
  const declaredFallback = raw.providerFallback as RunnerConfig['providerFallback'];
  // The provider-difference check covers hosts deployed before the explicit marker.
  const onFallback = envFallbackApplied || provider !== fileProvider;
  const activeFallback = onFallback && declaredFallback?.provider === provider ? declaredFallback : undefined;
  const configuredProviderConfig = (raw.providerConfig as Record<string, unknown>) ?? {};
  const providerConfig = onFallback ? {} : { ...configuredProviderConfig };
  const configuredModel = typeof raw.model === 'string' ? raw.model : undefined;
  const configuredEffort = typeof raw.effort === 'string' ? raw.effort : undefined;
  const configuredProviderModel = typeof providerConfig.model === 'string' ? providerConfig.model : undefined;
  const configuredProviderEffort =
    typeof providerConfig.reasoning_effort === 'string' ? providerConfig.reasoning_effort : undefined;
  // Channel defaults apply to the primary provider, never to a fallback.
  const channelDefaults = onFallback ? null : providerContract(provider).channelDefaults;
  const activeCodexModel = channelDefaults ? env?.[channelDefaults.modelEnv] : undefined;
  const activeCodexEffort = channelDefaults ? env?.[channelDefaults.effortEnv] : undefined;
  if (channelDefaults) {
    // Precedence: channel > per-agent providerConfig > provider-level fields. Copied into providerConfig because
    // the provider reads its sticky values there at app-server startup.
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
    // A fallback runs the other provider's defaults: the primary's tier is not its vocabulary.
    speed: onFallback ? undefined : readSpeed(raw),
    fallbackApplied: onFallback,
    providerFallback: declaredFallback || undefined,
    statusSubtext: raw.statusSubtext !== false,
  };
}

const SPEED_TIERS: ReadonlySet<string> = new Set(['standard', 'fast']);

function readSpeed(raw: Record<string, unknown>): string | undefined {
  return typeof raw.speed === 'string' && SPEED_TIERS.has(raw.speed) ? raw.speed : undefined;
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

/** Test seam: install a parsed config without reading the fixed in-container path. */
export function _setConfigForTest(raw: Record<string, unknown>): void {
  _config = parseRawConfig(raw);
}
