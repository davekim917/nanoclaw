/**
 * OpenAI Codex provider — wraps `codex app-server` via JSON-RPC.
 *
 * Unlike the (deprecated) @openai/codex-sdk approach, the app-server
 * protocol exposes proper session/stream semantics, native compaction, and
 * stable MCP config via ~/.codex/config.toml — which is the same mechanism
 * the standalone codex CLI uses, so the container and host share one
 * provider-integration story.
 *
 * Codex turns accept mid-turn input through the app-server's `turn/steer`
 * RPC. Follow-up `push()` messages steer the active turn by default and fall
 * back to the pending queue only when no turn is in flight or the steer races
 * with turn completion.
 */
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

import { z } from 'zod';

import { memoryContextForSessionStart, type MemorySessionHookRegistration } from '../memory/session-hook.js';
import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/container-state.js';
import { setProviderHealthState, type ProviderHealthState } from '../modules/mailbox/index.js';
import { registerProvider, registerProviderConfigSchema } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import {
  type AppServer,
  type CodexMcpServer,
  DEFAULT_CODEX_MAX_CONCURRENT_THREADS_PER_SESSION,
  type JsonRpcNotification,
  STALE_THREAD_RE,
  attachCodexAutoApproval,
  createCodexConfigOverrides,
  initializeCodexAppServer,
  interruptCodexTurn,
  killCodexAppServer,
  probeCodexThreadHealth,
  readCodexTurnSnapshot,
  spawnCodexAppServer,
  startCodexTurn,
  startOrResumeCodexThread,
  steerCodexTurn,
  writeCodexHooksJson,
  writeCodexMcpConfigToml,
} from './codex-app-server.js';
import { CodexTurnLiveness, isCodexTerminalTurnItem, normalizeCodexThreadStatus } from './codex-liveness.js';
import { attachTurnEffort } from './turn-effort.js';

/**
 * Health watchdog for a single turn. Guards against codex-app-server wedging
 * without treating a quiet Ultra/model/tool operation as dead.
 *
 * Previously this was a wall-clock timer from turn start (`TURN_TIMEOUT_MS
 * = 300_000`). That cut off every legitimate long turn — `xhigh` reasoning
 * with multi-step tool work routinely runs past 5 min while emitting
 * reasoning deltas every 1–10s. Wall-clock can't tell "thinking hard" from
 * "wedged"; idle-from-last-notification can.
 *
 * Notifications remain the primary activity signal. Once they go quiet, the
 * provider sends non-mutating thread/read + descendant thread/list requests.
 * A responsive active root/descendant may remain quiet indefinitely; only
 * repeated control-plane failures or repeated impossible inactive snapshots
 * trigger app-server replacement.
 *
 * Initial production defaults: wait 60s of notification silence, probe every
 * 30s with a 10s response deadline, and recover after three consecutive
 * failures. At those defaults a hard wedge is replaced in roughly two minutes.
 * Successful probes yield ProviderEvent.activity, keeping the host heartbeat
 * fresh even for a legitimate turn that stays notification-silent for hours.
 */
const CODEX_HEALTH_PROBE_QUIET_MS = 60_000;
const CODEX_HEALTH_PROBE_INTERVAL_MS = 30_000;
const CODEX_HEALTH_PROBE_TIMEOUT_MS = 10_000;
const CODEX_HEALTH_PROBE_FAILURE_LIMIT = 3;
const CODEX_INACTIVE_SNAPSHOT_LIMIT = 2;
const CODEX_HEALTH_STILL_WORKING_NOTICE_MS = 15 * 60_000;
const CODEX_IN_FLIGHT_ITEM_TIMEOUT_MS = 60 * 60 * 1000;
const CODEX_CONTROL_PLANE_RECOVERY_MAX = 1;
const CODEX_INTERRUPT_TIMEOUT_MS = 2_000;
const CODEX_TURN_BACKFILL_MAX_ATTEMPTS = 3;
const CODEX_TURN_BACKFILL_RETRY_BASE_MS = 50;

export interface CodexTurnHealthConfig {
  quietMs: number;
  intervalMs: number;
  timeoutMs: number;
  probeFailureLimit: number;
  inactiveSnapshotLimit: number;
  stillWorkingNoticeMs: number;
}

function positiveEnvMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function codexTurnHealthConfigFromEnv(): CodexTurnHealthConfig {
  return {
    quietMs: positiveEnvMs('CODEX_HEALTH_PROBE_QUIET_MS', CODEX_HEALTH_PROBE_QUIET_MS),
    intervalMs: positiveEnvMs('CODEX_HEALTH_PROBE_INTERVAL_MS', CODEX_HEALTH_PROBE_INTERVAL_MS),
    timeoutMs: positiveEnvMs('CODEX_HEALTH_PROBE_TIMEOUT_MS', CODEX_HEALTH_PROBE_TIMEOUT_MS),
    probeFailureLimit: positiveEnvMs('CODEX_HEALTH_PROBE_FAILURE_LIMIT', CODEX_HEALTH_PROBE_FAILURE_LIMIT),
    inactiveSnapshotLimit: positiveEnvMs('CODEX_INACTIVE_SNAPSHOT_LIMIT', CODEX_INACTIVE_SNAPSHOT_LIMIT),
    stillWorkingNoticeMs: positiveEnvMs('CODEX_HEALTH_STILL_WORKING_NOTICE_MS', CODEX_HEALTH_STILL_WORKING_NOTICE_MS),
  };
}

function persistCodexProviderHealth(state: ProviderHealthState): void {
  try {
    setProviderHealthState(state);
  } catch (err) {
    console.error('[codex-provider] Failed to persist provider health state:', err);
  }
}

/**
 * Lookup tables for translating Codex collaboration ThreadItems into
 * human-readable progress labels. Codex 0.144.1 emits both the legacy
 * `collabAgentToolCall` shape and the current `subAgentActivity` lifecycle
 * shape; both carry the originating collaboration call ID.
 */
const COLLAB_TOOL_EMOJI: Record<string, string> = {
  spawnAgent: '🌱',
  sendInput: '📨',
  resumeAgent: '▶️',
  wait: '⏳',
  closeAgent: '🛑',
};
const COLLAB_TOOL_VERB: Record<string, string> = {
  spawnAgent: 'spawned',
  sendInput: 'sent input to',
  resumeAgent: 'resumed',
  wait: 'waiting on',
  closeAgent: 'closed',
};

type SubAgentActivityKind = 'started' | 'interacted' | 'interrupted';

const SUBAGENT_ACTIVITY_EMOJI: Record<SubAgentActivityKind, string> = {
  started: '🌱',
  interacted: '📨',
  interrupted: '🛑',
};

type CodexCollaborationThreadItem = {
  id?: unknown;
  type?: unknown;
  tool?: unknown;
  receiverThreadIds?: unknown;
  agentPath?: unknown;
  kind?: unknown;
};

/**
 * Translate a Codex collaboration ThreadItem into a status message.
 *
 * The app-server may surface the same collaboration action through both
 * `collabAgentToolCall` and `subAgentActivity` (and through both item lifecycle
 * notifications). Their required `id` is the originating collaboration call
 * ID, so a per-turn set safely suppresses duplicate renderings without hiding
 * distinct actions against the same child agent.
 */
export function formatCodexCollaborationProgress(rawItem: unknown, emittedItemIds: Set<string>): string | null {
  if (!rawItem || typeof rawItem !== 'object') return null;
  const item = rawItem as CodexCollaborationThreadItem;
  let message: string | null = null;

  if (item.type === 'collabAgentToolCall' && typeof item.tool === 'string') {
    const emoji = COLLAB_TOOL_EMOJI[item.tool] ?? '🔧';
    const verb = COLLAB_TOOL_VERB[item.tool] ?? item.tool;
    const receivers = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((id): id is string => typeof id === 'string')
      : [];
    const receiverLabel =
      receivers.length > 0 ? ` (${receivers.length} agent${receivers.length === 1 ? '' : 's'})` : '';
    message = `${emoji} subagent: ${verb}${receiverLabel}`;
  } else if (
    item.type === 'subAgentActivity' &&
    (item.kind === 'started' || item.kind === 'interacted' || item.kind === 'interrupted')
  ) {
    const kind = item.kind;
    const agentPath = typeof item.agentPath === 'string' && item.agentPath.trim() ? ` (${item.agentPath.trim()})` : '';
    message = `${SUBAGENT_ACTIVITY_EMOJI[kind]} subagent: ${kind}${agentPath}`;
  }

  if (!message) return null;

  const itemId = typeof item.id === 'string' ? item.id.trim() : '';
  if (itemId && emittedItemIds.has(itemId)) return null;
  if (itemId) emittedItemIds.add(itemId);
  return message;
}

export function isCodexNotificationForActiveTurn(
  method: string,
  params: Record<string, unknown>,
  threadId: string,
  currentTurnId: string | null,
): boolean {
  if (method === 'thread/started') {
    const thread = params.thread;
    return !!thread && typeof thread === 'object' && (thread as Record<string, unknown>).id === threadId;
  }

  // Every current Codex lifecycle notification except thread/started carries
  // a top-level threadId. Missing scope is malformed under the exact-pinned
  // protocol and must not be allowed to mutate the active turn.
  if (params.threadId !== threadId) return false;

  const turn = params.turn;
  const nestedTurnId =
    turn && typeof turn === 'object' && typeof (turn as Record<string, unknown>).id === 'string'
      ? ((turn as Record<string, unknown>).id as string)
      : null;
  const notificationTurnId = typeof params.turnId === 'string' ? params.turnId : nestedTurnId;

  // Two separate rules, deliberately not merged.
  //
  // (1) PRESENCE is required only of the lifecycle namespaces that always
  //     carry a turn id. Missing scope there is malformed under the
  //     exact-pinned protocol and must not mutate the active turn.
  const requiresTurnId =
    method.startsWith('turn/') || method.startsWith('item/') || method.startsWith('rawResponseItem/');
  if (requiresTurnId && !notificationTurnId) return false;

  // (2) MATCHING applies to any notification that names a turn, whatever
  //     namespace its method sits in. `thread/tokenUsage/updated` carries a
  //     `turnId` (ThreadTokenUsageUpdatedNotification is a 3-field struct in
  //     codex 0.145.0: threadId, turnId, tokenUsage) but lives under
  //     `thread/`, so a prefix-only rule left it categorically unscoped: a
  //     late, reordered, or replayed-on-resume payload tagged with a PRIOR
  //     turn summed into the current turn's accumulator. That is the
  //     overcount mirror of the undercount 9f86ac2d fixed.
  //
  //     Presence is deliberately NOT required here. An app-server build that
  //     omits the field keeps today's behaviour instead of having every usage
  //     notification silently dropped — which would meter codex at zero.
  if (currentTurnId && notificationTurnId && notificationTurnId !== currentTurnId) return false;
  return true;
}

async function readCodexTurnSnapshotWithRetry(
  server: AppServer,
  threadId: string,
  turnId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CODEX_TURN_BACKFILL_MAX_ATTEMPTS; attempt++) {
    try {
      return await readCodexTurnSnapshot(server, threadId, turnId, timeoutMs);
    } catch (err) {
      lastError = err;
      if (attempt < CODEX_TURN_BACKFILL_MAX_ATTEMPTS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, CODEX_TURN_BACKFILL_RETRY_BASE_MS * attempt);
        });
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Thinking-label helpers — mirror the Claude provider's truncate /
// formatBlockquoteLabel / NANOCLAW_HIDE_THINKING semantics so Codex
// reasoning surfaces with the same 💭 blockquote affordance.
const LABEL_MAX = 2000;

function truncate(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= LABEL_MAX) return trimmed;
  return trimmed.slice(0, LABEL_MAX - 1).replace(/\s+\S*$/, '') + '…';
}

function formatBlockquoteLabel(emoji: string, prose: string): string {
  const lines = prose.split('\n');
  lines[0] = `${emoji} ${lines[0]}`;
  return lines.map((line) => `> ${line}`).join('\n');
}

function thinkingForwardingEnabled(): boolean {
  const v = process.env.NANOCLAW_HIDE_THINKING;
  return !v || v === '0' || v.toLowerCase() === 'false';
}

type ReasoningThreadItem = {
  id?: string;
  type?: string;
  summary?: unknown;
  content?: unknown;
};

type ImageGenerationThreadItem = {
  id?: unknown;
  type?: string;
  status?: string;
  savedPath?: unknown;
  saved_path?: unknown;
};

/**
 * `TokenUsageBreakdown` from the codex app-server protocol — the shape of BOTH
 * `tokenUsage.last` and `tokenUsage.total` on the `thread/tokenUsage/updated`
 * notification. Field list verified against the codex 0.145.0 binary's own
 * generated `TokenUsageBreakdown.ts`. Fleet Hardening Phase 0.1 — see
 * TurnUsageInfo in providers/types.ts.
 */
type CodexTokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type RawImageGenerationResponseItem = {
  id?: unknown;
  type?: string;
  status?: string;
  result?: unknown;
};

function joinStringArray(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('\n\n');
}

function extractReasoningItemText(item: ReasoningThreadItem | undefined): string | null {
  if (item?.type !== 'reasoning') return null;
  // ThreadItem reasoning payloads carry summary/content as string arrays.
  // Prefer summaries because those are the user-facing reasoning surface;
  // content is only a fallback for app-server builds that finalize raw text.
  const summary = joinStringArray(item.summary);
  if (summary) return summary;
  const content = joinStringArray(item.content);
  return content || null;
}

export function extractImageGenerationPath(item: ImageGenerationThreadItem | undefined): string | null {
  if (item?.type !== 'imageGeneration') return null;
  const status = typeof item.status === 'string' ? item.status.toLowerCase() : '';
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return null;
  const savedPath = item.savedPath ?? item.saved_path;
  return typeof savedPath === 'string' && savedPath.trim() ? savedPath : null;
}

function imageGenerationKey(item: { id?: unknown } | undefined, fallback: string): string {
  return typeof item?.id === 'string' && item.id.trim() ? `image:${item.id.trim()}` : fallback;
}

export function materializeRawImageGeneration(
  item: RawImageGenerationResponseItem | undefined,
  rootDir = '/home/node/.codex/generated_images/nanoclaw-raw',
): string | null {
  if (item?.type !== 'image_generation_call') return null;
  const status = typeof item.status === 'string' ? item.status.toLowerCase() : '';
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return null;
  if (typeof item.result !== 'string' || !item.result.trim()) return null;

  const id =
    typeof item.id === 'string' && item.id.trim()
      ? item.id.trim()
      : crypto.createHash('sha256').update(item.result).digest('hex').slice(0, 32);
  const filename = `${id.replace(/[^\w.-]/g, '_')}.png`;
  const outPath = path.join(rootDir, filename);
  const image = Buffer.from(item.result, 'base64');
  if (image.length === 0) return null;

  try {
    fs.mkdirSync(rootDir, { recursive: true });
    if (!fs.existsSync(outPath)) {
      fs.writeFileSync(outPath, image);
    }
  } catch {
    return null;
  }
  return outPath;
}

// ── Provider config schema ──────────────────────────────────────────────────
// Mirrors the `claudeConfigSchema` pattern but with Codex-native vocabulary:
// `reasoning_effort` instead of Claude's `effort`. Codex 0.144.1 exposes
// reasoning effort as a model-advertised string; its current model catalog
// uses low | medium | high | xhigh | max | ultra. Ultra is a real Codex effort
// value that adds proactive task delegation, not Claude's `ultracode` flag.
//
// Default is `low` for the production model (gpt-6-astra, trial 2026-09-07);
// see the note at this.model. Operators can dial
// down or up per-agent via container.json when cost/latency dictate ("high"
// covers the deeper of the standard tiers without the proactive-delegation
// extras of xhigh/max/ultra). Changed from xhigh → high per operator decision
// for GPT 5.6 SOL and Opus 5 (see claude.ts defaultEffortForModel).
//
// Sticky-only: `model` is applied at thread-start; `reasoning_effort` and the
// native collaboration cap are applied at app-server spawn. They persist for
// the query/session. Per-turn overrides for these fields are not currently
// exposed by Codex's `thread/start` shape.
export const codexConfigSchema = z.strictObject({
  model: z.string().min(1).optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional().default('low'),
  max_concurrent_threads_per_session: z
    .number()
    .int()
    .positive()
    .optional()
    .default(DEFAULT_CODEX_MAX_CONCURRENT_THREADS_PER_SESSION),
});

registerProviderConfigSchema('codex', codexConfigSchema);

// ── Per-query model/effort overrides (-m/-e flags) ──────────────────────────
// The poll-loop delivers host-parsed flag values via QueryInput.model/.effort
// (turn override → sticky, resolved in applyFlagBatch). Both are validated
// here before they reach the app-server: session_state can carry values from
// before the host's flag vocabulary became provider-aware (observed live
// 2026-06-10: sticky_model=claude-fable-5[1m] on a codex session), and a
// claude id at thread/start would fail every turn of the session.

/** Mirrors CODEX_VALID_MODEL_RE in the host's flag-parser (separate package trees). */
export const CODEX_MODEL_RE = /^gpt-[a-z0-9][a-z0-9.-]*$/;

const CODEX_EFFORT_VALUES: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

type CodexStickyConfig = z.infer<typeof codexConfigSchema>;

/** Flag-requested model if it's codex-shaped, else the configured fallback. */
export function resolveQueryModel(requested: string | undefined, fallback: string): string {
  if (!requested) return fallback;
  if (CODEX_MODEL_RE.test(requested)) return requested;
  console.error(`[codex-provider] Ignoring non-codex model override "${requested}" — staying on ${fallback}`);
  return fallback;
}

/**
 * Sticky config with the flag-requested effort folded in (when valid for
 * Codex's currently supported reasoning-effort set). Returned object feeds
 * createCodexConfigOverrides at app-server spawn — one server per query, so
 * a per-query effort lands as `-c model_reasoning_effort` naturally.
 */
export function resolveQueryEffort(requested: string | undefined, sticky: CodexStickyConfig): CodexStickyConfig {
  if (!requested) return sticky;
  if (CODEX_EFFORT_VALUES.has(requested)) {
    return { ...sticky, reasoning_effort: requested as CodexStickyConfig['reasoning_effort'] };
  }
  console.error(
    `[codex-provider] Ignoring non-codex effort override "${requested}" — staying on ${sticky.reasoning_effort}`,
  );
  return sticky;
}

export function buildCodexSubagentLifecycleInstructions(maxConcurrentThreadsPerSession: number): string {
  return `## Codex subagent lifecycle

This session allows up to ${maxConcurrentThreadsPerSession} concurrent subagents, excluding the primary thread.

- Track every subagent you spawn.
- A completed, errored, or interrupted subagent still owns runtime resources until you call \`close_agent\`.
- Call \`close_agent\` as soon as you no longer need follow-up from that subagent. Waiting for completion is not cleanup.
- Before ending your turn, close every subagent you spawned, including failure and cancellation paths.`;
}

// Group instructions (shared base + fragments + per-group standing
// instructions) reach Codex through AGENTS.md, which the app-server
// auto-loads as its project doc from cwd (`/workspace/agent` — see
// poll-loop's caller in index.ts). This function used to also read and
// @-import-resolve CLAUDE.md/CLAUDE.local.md by hand and fold that in here
// too, which doubled ~26KB of instructions into every turn's context and
// left two copies of every rule that could drift out of sync. AGENTS.md is
// now the single instruction surface for Codex.
function composeBaseInstructions(promptAddendum: string | undefined, maxConcurrentThreadsPerSession: number): string {
  const lifecycle = buildCodexSubagentLifecycleInstructions(maxConcurrentThreadsPerSession);
  const pieces = [promptAddendum, lifecycle].filter((s): s is string => Boolean(s));
  return pieces.join('\n\n---\n\n');
}

// ── Provider ────────────────────────────────────────────────────────────────

/**
 * Container env vars that need to reach every MCP subprocess for outbound
 * HTTPS to work through OneCLI's substitution proxy + CA. Order matters
 * only in that comments and key membership do; if the host has the var
 * set in process.env, it gets forwarded; if not, the slot is omitted.
 *
 * Categories:
 *   - HTTPS_PROXY / HTTP_PROXY / NO_PROXY (and lowercase): routes
 *     outbound HTTP through the OneCLI gateway. Without these, remote
 *     MCP calls bypass OneCLI and outbound auth substitution fails.
 *   - NODE_USE_ENV_PROXY: makes Node 22+ fetch honor HTTPS_PROXY without
 *     explicit ProxyAgent setup. Required because remote-mcp-bridge uses
 *     undici's fetch which only honors env-proxy when this flag is set.
 *   - NODE_EXTRA_CA_CERTS + the CA-bundle siblings: lets the MCP
 *     subprocess trust OneCLI's mitm CA. Without these, outbound TLS to
 *     the gateway fails with CERT_HAS_EXPIRED / SELF_SIGNED_CERT.
 */
const MCP_PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'PIP_CERT',
  'AWS_CA_BUNDLE',
  'DENO_CERT',
  'GIT_SSL_CAINFO',
] as const;

/**
 * Copy the proxy + CA env vars from `process.env` into `baseEnv` if they're
 * not already set. Existing keys in `baseEnv` (e.g. an MCP that intentionally
 * overrides a proxy setting) win. Returns a new object — never mutates the
 * input.
 */
export function augmentWithProxyEnv(baseEnv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...baseEnv };
  for (const key of MCP_PROXY_ENV_KEYS) {
    if (out[key] !== undefined) continue;
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

// ── Codex OAuth fallback (rollout-copy rotation) ───────────────────────────
// Codex stores per-thread state in `${CODEX_HOME}/sessions/YYYY/MM/DD/
// rollout-<ISO>-<threadId>.jsonl`. The file is self-contained: the codex
// app-server reconstructs full history from it and sends the inline message
// list to the responses API on resume — no `previous_response_id`, no
// account-binding (verified via openai/codex docs + empirical inspection of
// a real rollout's payload). So OAuth fallback can preserve conversation
// context by copying the rollout into the new CODEX_HOME's sessions tree
// before respawning the app-server.

/**
 * `codexErrorInfo.type` values that should trigger OAuth fallback rotation.
 * `Unauthorized` is also account-scoped: a second authenticated Codex
 * account can recover an invalidated primary token. Other terminal kinds
 * (`BadRequest`, `ContextWindowExceeded`, etc.) are not identity-specific
 * and must not consume a fallback account. Source: openai/codex
 * `CodexErrorInfo` enum + the TUI's `app_server_rate_limit_error_kind`
 * rate-limit classifier.
 */
const ROTATABLE_CODEX_ERROR_KINDS: ReadonlySet<string> = new Set([
  'UsageLimitExceeded',
  'ServerOverloaded',
  'Unauthorized',
]);

/**
 * The app-server's own usage-limit sentence, as thrown from the query path
 * (the event path carries the structured `UsageLimitExceeded` kind instead).
 * Deliberately anchored on the stable phrase pair rather than the whole
 * message, which embeds a per-account reset date and billing URL.
 */
const CODEX_USAGE_LIMIT_RE = /hit your usage limit|usage limit reached|purchase more credits/i;

/**
 * Map a terminal turn error to a ProviderEvent `classification` consumed by
 * the poll-loop catch path:
 *   - `quota` / `overloaded` / `auth_invalidated` → rotation-eligible
 *     (structured CodexErrorInfo)
 *   - `system_error` → coarse thread/status/changed wedge (no structured detail)
 *   - `control_plane_unresponsive` / `protocol_desync` → provider-local
 *     app-server replacement + persisted-thread resume
 *   - `idle_timeout` → legacy compatibility for older emitted errors
 * A rotation-eligible `errorKind` short-circuits the message checks (a
 * structured quota/overload error is never also a system/idle error).
 */
export function classifyCodexError(message: string, errorKind: string | null): string | undefined {
  if (errorKind && ROTATABLE_CODEX_ERROR_KINDS.has(errorKind)) {
    if (errorKind === 'UsageLimitExceeded') return 'quota';
    if (errorKind === 'ServerOverloaded') return 'overloaded';
    if (errorKind === 'Unauthorized') return 'auth_invalidated';
    return undefined;
  }
  if (message.startsWith('codex_system_error')) return 'system_error';
  if (message.startsWith('codex_control_plane_unresponsive')) return 'control_plane_unresponsive';
  if (message.startsWith('codex_protocol_desync')) return 'protocol_desync';
  if (message.includes('idle for')) return 'idle_timeout';
  return undefined;
}

/**
 * Only these terminal classifications can be recovered by changing Codex
 * OAuth identities. Keep this predicate central so a new classification
 * cannot accidentally fall through to the host's cross-provider fallback.
 */
export function isCodexOAuthRotationEligible(classification: string | undefined): boolean {
  return (
    classification === 'quota' ||
    classification === 'overloaded' ||
    classification === 'system_error' ||
    classification === 'auth_invalidated'
  );
}

// ── Child-agent (multi_agent) quota exhaustion ──

/**
 * Upstream's inter-agent completion framing, as emitted by codex-rs
 * `session_prefix.rs::format_inter_agent_completion_message` when a spawned
 * child agent's turn ends in `AgentStatus::Errored`. Both literals below are
 * verbatim from the installed codex 0.151.0 binary.
 *
 * WHY THE FRAMING IS MANDATORY, AND WHY CODEX_USAGE_LIMIT_RE ALONE IS NOT
 * ENOUGH: CODEX_USAGE_LIMIT_RE is safe today only because every caller
 * applies it to a STRUCTURED error object (a thrown app-server Error, or a
 * `codexErrorInfo` payload). The child-agent failure has no structured
 * carrier at all — upstream forwards it to the PARENT as ordinary injected
 * conversation prose and deliberately does NOT fail the parent's turn. So the
 * only place to see it is free text, and free text is exactly where that
 * regex stops being a signal: "purchase more credits" / "hit your usage
 * limit" are phrases an agent can legitimately WRITE. An agent working on
 * this very file would trip a prose-only matcher and kill its own live turn
 * plus rotate a perfectly healthy credential slot.
 *
 * The guard is therefore a conjunction of three independent conditions
 * (see `detectCodexChildAgentQuotaFailure`):
 *   1. the item text opens a line with upstream's "Agent errored:" prefix,
 *   2. it carries upstream's verbatim turn-failed sentence, and
 *   3. the error body matches CODEX_USAGE_LIMIT_RE.
 * i.e. "a child agent reported a terminal error AND that error is a quota
 * error" — never "this text mentions a usage limit".
 *
 * Residual, knowingly accepted: prose that reproduces the WHOLE framed
 * message verbatim, starting at a line boundary, still matches. The cost of
 * that is one turn aborted and replayed on the next credential slot; the cost
 * of relaxing the conjunction is silent rotation storms on ordinary agent
 * chatter. Line-start anchoring (rather than whole-string) is deliberate:
 * app-server versions may prefix the item with an agent path/nickname, and a
 * missed detection costs the pre-fix behavior.
 */
export const CODEX_CHILD_AGENT_ERROR_FRAMING_RE = /^[\s>*_`[\]()-]*Agent errored:/m;

/**
 * The fixed sentence upstream appends after the child's error text. Verbatim
 * from codex 0.151.0; it is the half of the framing that free prose is most
 * unlikely to reproduce, so it does the heavy lifting of the false-positive
 * guard. Matched case-insensitively with flexible inner whitespace so a
 * re-wrap in transport cannot break detection, and tolerating either
 * apostrophe for the same reason QUOTA regexes elsewhere do.
 */
export const CODEX_CHILD_AGENT_TURN_FAILED_RE =
  /This\s+agent['’]s\s+turn\s+failed\.\s+If\s+you\s+still\s+need\s+this\s+agent,\s+use\s+the\s+available\s+collaboration\s+tools\s+to\s+give\s+it\s+another\s+task\./i;

/**
 * Flatten an app-server ThreadItem (typed `unknown` — the protocol is pinned
 * but the payload shape varies by item type and app-server version) to text
 * the framing/quota matchers can run over.
 *
 * Covers both subagent surfaces the child-agent failure can arrive on:
 *   - `multi_agent_v2`: the injected inter-agent completion message, which
 *     lands as an ordinary conversation item (`text`).
 *   - `multi_agent` v1: the child's error text inside the collaboration
 *     tool's own result (`functionCallOutput.output`, `result`, `content`).
 * Both flags are `stable=true` on codex 0.151.0 and which one is exercised is
 * install-dependent, so both are scanned — the framing conjunction is what
 * makes that safe rather than reckless.
 *
 * Never throws; depth-capped so a cyclic or pathological payload cannot spin.
 */
export function extractCodexThreadItemText(value: unknown, depth = 0): string {
  if (value == null || depth > 4) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const entry of value) {
      const part = extractCodexThreadItemText(entry, depth + 1);
      if (part) parts.push(part);
    }
    return parts.join('\n');
  }
  if (typeof value !== 'object') return '';

  const o = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['text', 'output', 'result', 'content', 'message', 'error'] as const) {
    if (o[key] === undefined) continue;
    const part = extractCodexThreadItemText(o[key], depth + 1);
    if (part) parts.push(part);
  }
  return parts.join('\n');
}

/**
 * Detect a spawned child agent reporting a QUOTA failure, on either subagent
 * surface. Returns the terminal error message to attribute to the parent
 * turn, or null.
 *
 * This exists because the parent turn never learns about it any other way:
 * `turnState.error` / `turnState.errorKind` are populated only from the
 * coordinator's OWN `turn/completed`+`turn/failed` payloads, and upstream
 * explicitly leaves the parent turn running and unmarked when a child errors.
 * Without this, `classifyCodexError` never sees a quota error,
 * `isCodexOAuthRotationEligible` is never consulted, no rotation happens, and
 * the coordinator is left holding literal "purchase more credits" prose it
 * can misread as an instruction to the user.
 *
 * The caller routes a hit into the EXISTING rotation path by setting
 * `turnState.error` + `errorKind = 'UsageLimitExceeded'`, exactly as if the
 * parent's own turn had failed that way. No new rotation logic.
 *
 * Never throws — a malformed item is not a reason to lose a turn.
 */
export function detectCodexChildAgentQuotaFailure(item: unknown): string | null {
  try {
    if (!item || typeof item !== 'object') return null;
    const text = extractCodexThreadItemText(item);
    if (!text) return null;
    // Conjunction, in cheapest-first order. All three must hold; see the
    // comment on CODEX_CHILD_AGENT_ERROR_FRAMING_RE for why any two of them
    // would be an unsafe matcher.
    if (!CODEX_CHILD_AGENT_ERROR_FRAMING_RE.test(text)) return null;
    if (!CODEX_CHILD_AGENT_TURN_FAILED_RE.test(text)) return null;
    if (!CODEX_USAGE_LIMIT_RE.test(text)) return null;
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    return `codex_child_agent_quota_exhausted: ${snippet}`;
  } catch {
    return null;
  }
}

export function buildCodexRecoveryPrompt(): string {
  return [
    "The prior turn's Codex control plane stopped responding and was restarted.",
    'Continue the same user request from the persisted thread state.',
    'Inspect completed work before acting and do not repeat completed external side effects.',
    'If the prior turn completed before the disconnect, return its result instead of redoing it.',
  ].join(' ');
}

/**
 * Decide how one logical user turn crosses an app-server restart. A resumed
 * thread already contains the original request, so repeat only the recovery
 * instruction and retain its replay guards. A fresh thread has no such
 * context, so it must receive the original request and start with fresh
 * thread-scoped dedupe state.
 */
export function resolveCodexRestartTransition({
  previousThreadId,
  nextThreadId,
  originalText,
  initYielded,
}: {
  previousThreadId: string | undefined;
  nextThreadId: string | undefined;
  originalText: string;
  initYielded: boolean;
}): { attemptText: string; initYielded: boolean; resetThreadDedupe: boolean } {
  if (nextThreadId === previousThreadId) {
    return {
      attemptText: buildCodexRecoveryPrompt(),
      initYielded,
      resetThreadDedupe: false,
    };
  }
  return {
    attemptText: originalText,
    initYielded: false,
    resetThreadDedupe: true,
  };
}

/**
 * Walk `${codexHome}/sessions/` for the rollout `.jsonl` whose filename
 * embeds the given thread UUID. Codex's path layout is
 * `sessions/YYYY/MM/DD/rollout-<ISO>-<threadId>.jsonl`. Returns absolute
 * path or null if nothing matches.
 *
 * Tolerates UUIDs in any case and missing date subdirs. Walks at most 3
 * levels deep (year/month/day) so a corrupted sessions tree can't lock the
 * search; returns the first match (multiple rollouts per thread aren't
 * expected in this codex version).
 */
export function findRolloutFile(threadId: string, codexHome: string): string | null {
  const sessionsRoot = path.join(codexHome, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;
  const needle = threadId.toLowerCase();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: sessionsRoot, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < 3) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.endsWith('.jsonl')) continue;
      if (entry.toLowerCase().includes(needle)) return full;
    }
  }
  return null;
}

/**
 * Copy a rollout `.jsonl` from one CODEX_HOME's sessions tree to another,
 * preserving the date subdirectory layout. The destination path mirrors the
 * source's path relative to its sessions/ root (so `sessions/2026/05/21/...`
 * lands at the same subpath under the fallback home).
 *
 * Idempotent: overwrites the destination if it exists. Creates parent dirs.
 * Returns the destination path on success, null on failure.
 *
 * Important: copying mid-turn is safe because Codex's writer appends
 * line-by-line and fsyncs per record. The destination won't capture any
 * records written after the copy starts, but those records belong to the
 * failed turn anyway (the rotation routine will replay the user input
 * against the new app-server, generating a fresh assistant response).
 */
export function copyRolloutToFallback(srcRollout: string, srcCodexHome: string, dstCodexHome: string): string | null {
  const srcSessionsRoot = path.join(srcCodexHome, 'sessions');
  const rel = path.relative(srcSessionsRoot, srcRollout);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const dstPath = path.join(dstCodexHome, 'sessions', rel);
  try {
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.copyFileSync(srcRollout, dstPath);
    return dstPath;
  } catch {
    return null;
  }
}

/**
 * Mirror the named-subagent role definitions (`<primary>/agents`) into a rotated
 * CODEX_HOME. The agents/ tree is bind-mounted ONLY at the primary home, so a
 * fallback home reached on OAuth rotation has no role TOMLs and would silently
 * lose every named subagent role (architecture-advisor, code-review-specialist,
 * …) — the exact layer the agents/ mount surfaces. Copy (not symlink): the
 * fallback home is RW and Codex reads roles from `$CODEX_HOME/agents/`. The
 * destination is an exact snapshot: retired roles must not survive a later
 * mirror, and removing the primary tree clears a stale fallback tree. No-op
 * only when src==dst or neither tree exists. (codex #126)
 */
export function mirrorCodexAgentsToHome(primaryCodexHome: string, targetCodexHome: string): boolean {
  if (primaryCodexHome === targetCodexHome) return false;
  const src = path.join(primaryCodexHome, 'agents');
  const dst = path.join(targetCodexHome, 'agents');
  const srcExists = fs.lstatSync(src, { throwIfNoEntry: false }) !== undefined;
  const dstExists = fs.lstatSync(dst, { throwIfNoEntry: false }) !== undefined;
  if (!srcExists && !dstExists) return false;
  try {
    if (dstExists) fs.rmSync(dst, { recursive: true, force: true });
    if (!srcExists) return true;
    fs.cpSync(src, dst, { recursive: true });
    return true;
  } catch (e) {
    console.error(
      `[codex-provider] failed to mirror agents/ ${src} → ${dst}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

export function refreshCodexAuthFromHost(activeCodexHome: string, hostCodexHome: string | undefined): boolean {
  if (!hostCodexHome) return false;

  const src = path.join(hostCodexHome, 'auth.json');
  const dst = path.join(activeCodexHome, 'auth.json');
  if (path.resolve(src) === path.resolve(dst)) return false;

  try {
    if (!fs.existsSync(src)) return false;
    const srcAuth = fs.readFileSync(src);
    let dstAuth: Buffer | null = null;
    try {
      dstAuth = fs.readFileSync(dst);
    } catch {
      dstAuth = null;
    }
    if (dstAuth && Buffer.compare(srcAuth, dstAuth) === 0) return false;

    fs.mkdirSync(activeCodexHome, { recursive: true });
    const tmp = path.join(activeCodexHome, `.auth.json.refresh-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmp, srcAuth, { mode: 0o600 });
    fs.renameSync(tmp, dst);
    return true;
  } catch (e) {
    console.error(
      `[codex-provider] failed to refresh auth.json from host: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/**
 * Locate the freshest rollout for `threadId` across multiple CODEX_HOMEs.
 *
 * Why this exists: after an in-session rotation, the rollout file diverges
 * across homes. Primary holds the pre-rotation history; the fallback holds
 * the newer post-rotation history. When the container later dies (host-sweep
 * absolute-ceiling, idle timeout) and a fresh container spawns for the same
 * thread, `nextFallback` resets to 0 and `thread/resume` reads from primary
 * — finding the STALE pre-rotation rollout. Post-rotation turns are
 * stranded on the fallback; if primary is still rate-limited, rotation
 * fires again and the *stale* primary rollout overwrites the *newer*
 * fallback rollout, destroying history.
 *
 * The fix: at thread/resume time, scan all CODEX_HOMEs for rollout files
 * matching this threadId and pick the freshest. Selection key is
 * `(mtimeMs DESC, size DESC)` — mtime alone is fragile because the
 * rotation's `copyFileSync` can leave two homes with nearly-identical
 * mtimes; size as a tiebreaker prefers the one with more appended turns
 * (codex rollouts are append-only line-by-line).
 *
 * Returns null when no home contains the threadId. Skips homes whose
 * sessions tree is missing entirely (fresh fallback dirs that haven't
 * been written to yet).
 */
export interface RolloutCandidate {
  home: string;
  path: string;
  mtimeMs: number;
  size: number;
}

export function findNewestRolloutAcrossHomes(threadId: string, codexHomes: readonly string[]): RolloutCandidate | null {
  const needle = threadId.toLowerCase();
  let best: RolloutCandidate | null = null;
  for (const home of codexHomes) {
    const sessionsRoot = path.join(home, 'sessions');
    if (!fs.existsSync(sessionsRoot)) continue;
    const stack: Array<{ dir: string; depth: number }> = [{ dir: sessionsRoot, depth: 0 }];
    while (stack.length > 0) {
      const { dir, depth } = stack.pop()!;
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          if (depth < 3) stack.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (!entry.endsWith('.jsonl')) continue;
        if (!entry.toLowerCase().includes(needle)) continue;
        if (best === null || stat.mtimeMs > best.mtimeMs || (stat.mtimeMs === best.mtimeMs && stat.size > best.size)) {
          best = { home, path: full, mtimeMs: stat.mtimeMs, size: stat.size };
        }
      }
    }
  }
  return best;
}

export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly mcpServers: Record<string, CodexMcpServer>;
  private readonly model: string;
  private readonly stickyConfig: z.infer<typeof codexConfigSchema>;
  private memorySessionHook?: MemorySessionHookRegistration;

  /**
   * Ordered fallback CODEX_HOME paths from the `CODEX_FALLBACK_HOMES` env
   * (colon-joined). Host's container-runner mounts each fallback `~/.codex*`
   * dir at `/home/node/.codex-fallback-N/` and forwards the env var. Used
   * by the rotation routine in `gen()` to walk through alternate OAuth
   * identities on `UsageLimitExceeded` / `ServerOverloaded` / coarse
   * `systemError`. Cursor persists for the provider instance lifetime —
   * once we've rotated to slot N, slot N+1 is the next target even across
   * `query()` calls.
   */
  readonly fallbackHomes: readonly string[];
  private readonly primaryCodexHome: string;
  private readonly primaryHostCodexHome: string | undefined;
  private nextFallback = 0;

  constructor(options: ProviderOptions = {}) {
    // Native-first MCP wiring:
    // - stdio stays stdio, with proxy/CA env injected for child MCP processes.
    // - Streamable HTTP stays native Codex HTTP (url in config.toml).
    // - the old stdio bridge is only an explicit compatibility fallback.
    // - legacy SSE is rejected at config parse time and defensively here.
    const mcpServers: Record<string, CodexMcpServer> = {};
    const useHttpBridgeFallback = process.env.NANOCLAW_CODEX_MCP_HTTP_BRIDGE_FALLBACK === '1';
    for (const [name, cfg] of Object.entries(options.mcpServers ?? {})) {
      if (cfg && (cfg.type === undefined || cfg.type === 'stdio') && 'command' in cfg) {
        mcpServers[name] = {
          type: 'stdio',
          command: cfg.command,
          args: cfg.args,
          env: augmentWithProxyEnv(cfg.env ?? {}),
          ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
        };
      } else if (cfg?.type === 'http') {
        if (useHttpBridgeFallback) {
          const baseEnv: Record<string, string> = { REMOTE_MCP_NAME: name };
          // The full validated header map, not just Authorization — a server
          // wired with X-Api-Version or a custom OneCLI-managed placeholder
          // header had every header past Authorization silently dropped by
          // the bridge, which is a different set than the one the CLI,
          // template, and approval flows validated and reported success on.
          if (cfg.headers && Object.keys(cfg.headers).length > 0) {
            baseEnv.REMOTE_MCP_HEADERS = JSON.stringify(cfg.headers);
          }
          mcpServers[name] = {
            type: 'stdio',
            command: 'bun',
            args: ['/app/src/remote-mcp-bridge.ts', cfg.url],
            env: augmentWithProxyEnv(baseEnv),
          };
        } else {
          mcpServers[name] = {
            type: 'http',
            url: cfg.url,
            ...(cfg.headers ? { headers: cfg.headers } : {}),
          };
        }
      } else if (cfg?.type === 'sse') {
        throw new Error(`MCP server "${name}" uses deprecated SSE transport. Use type: "http" instead.`);
      }
    }
    this.mcpServers = mcpServers;

    // `providerConfig` describes the PRIMARY provider, so under a spawn-time
    // provider fallback the runner deliberately empties it (see
    // `parseRawConfig` in config.ts — codex's `reasoning_effort` key is a
    // fatal boot error under claude's strict schema). The fallback's own
    // declared model/effort travel on `options.model`/`options.effort`
    // instead, so fold them in here or they are lost and the container runs
    // codex's built-in defaults.
    //
    // Guarded by `=== undefined` so this is a strict no-op on the PRIMARY
    // path: config.ts already copies the resolved codex model/effort INTO
    // providerConfig there, and it draws them from the same chain that feeds
    // `options.model`/`options.effort` — a declared providerConfig always
    // wins. Values are validated first because the schema is strict and an
    // out-of-vocabulary value (a claude model id from a mis-declared
    // `providerFallback`) would throw at boot instead of degrading.
    const rawSticky: Record<string, unknown> = { ...(options.providerConfig ?? {}) };
    if (rawSticky.model === undefined && options.model !== undefined) {
      if (CODEX_MODEL_RE.test(options.model)) rawSticky.model = options.model;
      else console.error(`[codex-provider] Ignoring non-codex config model "${options.model}"`);
    }
    if (rawSticky.reasoning_effort === undefined && options.effort !== undefined) {
      if (CODEX_EFFORT_VALUES.has(options.effort)) rawSticky.reasoning_effort = options.effort;
      else console.error(`[codex-provider] Ignoring non-codex config effort "${options.effort}"`);
    }
    // Defensive re-parse (R8): catches hand-edited container.json or self-mod
    // mutations on startup before they reach codex.
    this.stickyConfig = codexConfigSchema.parse(rawSticky);

    // Model precedence: stickyConfig (per-agent providerConfig, or the
    // declared provider fallback's model folded in above) > CODEX_MODEL env
    // (host default) > built-in default.
    // TRIAL 2026-09-07 (one week, operator-requested): default is gpt-6-astra
    // at `low`. The vendor's claim is that Astra on low matches Sol on high in
    // output while costing roughly half per task on token efficiency. This
    // install is rate-limit-bound rather than dollar-bound, so the number that
    // decides it is limit consumption, not price. Revert = restore
    // 'gpt-5.6-sol' here and 'high' in codexConfigSchema below.
    this.model = this.stickyConfig.model ?? (options.env?.CODEX_MODEL as string | undefined) ?? 'gpt-6-astra';

    // Fallback OAuth identities. Empty when CODEX_FALLBACK_HOMES is unset
    // (the host didn't mount any fallbacks). Read from process.env rather
    // than options.env because options.env is filtered for SDK consumption
    // — the host-side container-runner passes the var via `-e`, and Codex
    // doesn't have an env-allowlist filter for the app-server side.
    const fallbackEnv = process.env.CODEX_FALLBACK_HOMES ?? '';
    this.fallbackHomes = Object.freeze(
      fallbackEnv
        .split(':')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    this.primaryCodexHome = process.env.CODEX_HOME ?? '/home/node/.codex';
    this.primaryHostCodexHome = process.env.CODEX_PRIMARY_HOST_HOME;
    if (this.fallbackHomes.length > 0) {
      console.error(
        `[codex-provider] Loaded ${this.fallbackHomes.length} Codex OAuth fallback(s): ${this.fallbackHomes.join(', ')}`,
      );
    }
  }

  /**
   * Advance the rotation cursor and return the next fallback CODEX_HOME, or
   * null when slots are exhausted. Position persists for the provider's
   * lifetime (matches the Claude provider's `rotateApiKey` contract).
   *
   * Exported as a method so the gen() body and unit tests can both drive it.
   */
  rotateCodexHome(): string | null {
    if (this.nextFallback >= this.fallbackHomes.length) return null;
    return this.fallbackHomes[this.nextFallback++];
  }

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_THREAD_RE.test(msg);
  }

  /**
   * Codex reports an exhausted account two ways: as a structured
   * `UsageLimitExceeded` on the event path, and as a plain thrown Error
   * carrying the CLI's own sentence on the query path ("You've hit your usage
   * limit … try again at <date>"). Both mean the same thing to the caller, so
   * match either — the app-server owns this wording, and a missed match only
   * costs the old behavior (a visible error) rather than a wrong one.
   */
  isQuotaExhausted(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return CODEX_USAGE_LIMIT_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('Codex memory session hook was not registered');
    const pending: string[] = [];
    // Steering RPCs that have been issued but not settled. A steer that
    // rejects falls back to `pending`, and that rejection is asynchronous — it
    // can land after the poll-loop has already sampled `hasQueuedWork` at the
    // current turn's `result`. Counting the in-flight RPC keeps the signal
    // true across that window; `sendCodexRequest` bounds it at 60s, and the
    // catch below queues BEFORE the decrement, so the signal never dips.
    let steersInFlight = 0;
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const kick = (): void => {
      waiting?.();
    };

    // Mid-turn input plumbing: when the agent is mid-turn we steer the
    // active turn instead of queueing the message. `runOneTurn` updates
    // `currentTurnId` on turn/started + clears it on turn/completed.
    const turnTracker: { server: AppServer | null; threadId: string | null; currentTurnId: string | null } = {
      server: null,
      threadId: null,
      currentTurnId: null,
    };

    pending.push(input.prompt);

    const self = this;

    // -m/-e flag overrides for this query (validated; invalid values fall
    // back to configured defaults — see resolveQueryModel/resolveQueryEffort).
    const effectiveModel = resolveQueryModel(input.model, this.model);
    const effectiveConfig = resolveQueryEffort(input.effort, this.stickyConfig);
    const effectiveFast = input.fast === true;
    // What this query's turns actually run at, for the turn_usage ledger.
    // `reasoning_effort` is what reaches the app-server as
    // `-c model_reasoning_effort`; the requested value is the raw `-e` before
    // resolveQueryEffort validated it, so a `-e` outside Codex's vocabulary
    // (silently ignored, staying on the sticky default) is visible as a
    // divergence rather than looking like it took effect. Codex reports one
    // usage entry per turn, so there is no per-model attribution to make —
    // see providers/turn-effort.ts.
    const turnEffort = {
      model: effectiveModel,
      effective: effectiveConfig.reasoning_effort,
      requested: input.effort ?? this.stickyConfig.reasoning_effort,
    };

    async function* gen(): AsyncGenerator<ProviderEvent> {
      // One app-server per query invocation. The poll-loop keeps a single
      // query active per batch of pending messages and ends it on idle, so
      // spawn-per-query matches that cadence naturally.
      writeCodexMcpConfigToml(self.mcpServers);
      writeCodexHooksJson();
      let server = spawnCodexAppServer(createCodexConfigOverrides(effectiveConfig, effectiveFast));
      turnTracker.server = server;
      attachCodexAutoApproval(server);

      let threadId: string | undefined = input.continuation;
      let initYielded = false;

      // Current CODEX_HOME. Tracked locally so the rotation routine can
      // pass it into findRolloutFile (the rollout to copy lives in the home
      // we're rotating AWAY from). Falls back to the conventional path when
      // process.env.CODEX_HOME is unset — the codex CLI uses the same default.
      let currentCodexHome = process.env.CODEX_HOME ?? self.primaryCodexHome;
      let primaryAuthRefreshAttempted = false;

      try {
        await initializeCodexAppServer(server);

        // Codex preserves base instructions across native compaction. The
        // lifecycle seam adds trusted static memory handling/write guidance;
        // canonical bytes arrive per turn only in paired untrusted recall.
        const memoryContext = memoryContextForSessionStart('startup');
        const lifecycleInstructions = [input.systemContext?.instructions, memoryContext].filter(Boolean).join('\n\n');
        const threadParams = {
          model: effectiveModel,
          cwd: input.cwd,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          personality: 'friendly',
          baseInstructions: composeBaseInstructions(
            lifecycleInstructions,
            effectiveConfig.max_concurrent_threads_per_session,
          ),
        };

        // Cross-container rollout repair. When a prior session rotated to a
        // fallback and that container later died, the fallback holds the
        // newest rollout — but the fresh container starts with
        // currentCodexHome=primary (the rotation cursor resets per-instance).
        // Without this pass, thread/resume would read the STALE pre-rotation
        // rollout from primary; if rotation fires again here, the in-session
        // rotation copy would write that stale rollout OVER the newer
        // fallback rollout, destroying history.
        //
        // Cost: ~4ms with current sessions-tree scale (151 files), zero when
        // no fallbacks are configured. The fast-path skip is what makes this
        // free for the 99% of installs not using OAuth fallback.
        if (threadId && self.fallbackHomes.length > 0) {
          const candidate = findNewestRolloutAcrossHomes(threadId, [currentCodexHome, ...self.fallbackHomes]);
          if (candidate && candidate.home !== currentCodexHome) {
            const copied = copyRolloutToFallback(candidate.path, candidate.home, currentCodexHome);
            if (copied) {
              console.error(
                `[codex-provider] Pre-resume rollout repair: copied newer rollout from ${candidate.home} → ${currentCodexHome} (mtime=${candidate.mtimeMs} size=${candidate.size})`,
              );
            }
          }
        }

        threadId = await startOrResumeCodexThread(server, threadId, threadParams);
        turnTracker.threadId = threadId ?? null;

        while (!aborted) {
          while (pending.length === 0 && !ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
            waiting = null;
          }
          if (aborted) return;
          if (pending.length === 0 && ended) return;

          const text = pending.shift()!;
          let attemptText = text;
          let controlPlaneRecoveryAttempts = 0;
          // TURN BOUNDARY for cost attribution. One `text` off `pending` is one
          // logical turn, and the rotation loop below can run runOneTurn several
          // times for it, so the usage accumulator is created HERE — not inside
          // runOneTurn (which drops every request made before a retry) and not
          // outside this shift (which would re-book earlier turns' spend and
          // recreate the cumulative-carry bug this replaced).
          //
          // It is created once and NEVER replaced. Every attempt this loop makes
          // — same-thread recovery and fresh-thread retry alike — bills real
          // tokens to the provider, so all of them belong to this turn's total.
          // The fresh-thread paths reset only the thread-scoped dedupe state; see
          // resetCodexTurnAccumulatorThread.
          const turnAccum = createCodexTurnAccumulator();

          // Restart loop. Each recovery branch has its own monotonic cap:
          // one control-plane replacement, one primary-auth refresh, and
          // each fallback home once. Do not add a shared attempt counter:
          // it can exhaust before a capped branch gets to surface its final
          // error, silently ending a logical user turn.
          let rotateAndRetry = true;
          while (rotateAndRetry) {
            rotateAndRetry = false;

            // One turn = one channel of streaming events. Each notification
            // from the app-server yields an `activity` first (so the
            // poll-loop's idle timer stays honest) and then, where relevant,
            // an init / result / progress event.
            //
            // We inspect each event while re-yielding it. Confirmed control-
            // plane failures are recovered here by interrupting when possible,
            // replacing only app-server, resuming the persisted thread, and
            // continuing once. Other hard errors still return from gen() so
            // its finally tears down the per-query app-server cleanly.
            //
            // EXCEPTION: when the error's classification matches a
            // rotation-eligible kind AND we have a fallback CODEX_HOME
            // available, transparently swap identity and retry instead of
            // surfacing the error.
            for await (const ev of runOneTurn(
              server,
              threadId!,
              attemptText,
              effectiveModel,
              input.cwd,
              () => initYielded,
              () => {
                initYielded = true;
              },
              turnTracker,
              codexTurnHealthConfigFromEnv(),
              controlPlaneRecoveryAttempts,
              turnAccum,
            )) {
              if (ev.type === 'error' && ev.retryable === false) {
                const controlPlaneFailure =
                  ev.classification === 'control_plane_unresponsive' || ev.classification === 'protocol_desync';
                if (controlPlaneFailure && controlPlaneRecoveryAttempts < CODEX_CONTROL_PLANE_RECOVERY_MAX) {
                  controlPlaneRecoveryAttempts++;
                  persistCodexProviderHealth({
                    status: 'recovering',
                    lastEventAt: new Date().toISOString(),
                    lastProbeAt: new Date().toISOString(),
                    probeFailures:
                      ev.classification === 'control_plane_unresponsive' ? CODEX_HEALTH_PROBE_FAILURE_LIMIT : 0,
                    recoveryAttempts: controlPlaneRecoveryAttempts,
                    failureReason: ev.message,
                  });
                  yield {
                    type: 'progress',
                    message: formatBlockquoteLabel(
                      '↻',
                      `Codex control plane ${ev.classification === 'protocol_desync' ? 'lost turn state' : 'stopped responding'}; ` +
                        `restarting app-server and resuming this task`,
                    ),
                  };

                  // A responsive but inconsistent server gets a graceful
                  // interrupt. An unresponsive server already failed three
                  // bounded probes, so waiting on another RPC only delays
                  // recovery; replace it directly.
                  if (ev.classification === 'protocol_desync' && turnTracker.threadId && turnTracker.currentTurnId) {
                    try {
                      await interruptCodexTurn(
                        server,
                        { threadId: turnTracker.threadId, turnId: turnTracker.currentTurnId },
                        CODEX_INTERRUPT_TIMEOUT_MS,
                      );
                    } catch (err) {
                      console.error(
                        `[codex-provider] Graceful turn interrupt failed before control-plane recovery: ` +
                          `${err instanceof Error ? err.message : String(err)}`,
                      );
                    }
                  }

                  turnTracker.server = null;
                  turnTracker.threadId = null;
                  turnTracker.currentTurnId = null;
                  killCodexAppServer(server);

                  writeCodexMcpConfigToml(self.mcpServers);
                  writeCodexHooksJson();
                  server = spawnCodexAppServer(createCodexConfigOverrides(effectiveConfig, effectiveFast));
                  turnTracker.server = server;
                  attachCodexAutoApproval(server);
                  await initializeCodexAppServer(server);

                  const previousThreadId: string | undefined = threadId;
                  threadId = await startOrResumeCodexThread(server, threadId, threadParams);
                  turnTracker.threadId = threadId ?? null;
                  const transition = resolveCodexRestartTransition({
                    previousThreadId,
                    nextThreadId: threadId,
                    originalText: text,
                    initYielded,
                  });
                  attemptText = transition.attemptText;
                  initYielded = transition.initYielded;
                  if (transition.resetThreadDedupe) {
                    resetCodexTurnAccumulatorThread(turnAccum);
                  }

                  rotateAndRetry = true;
                  break;
                }
                const eligible = isCodexOAuthRotationEligible(ev.classification);
                const canRefreshPrimaryAuth =
                  (ev.classification === 'system_error' || ev.classification === 'auth_invalidated') &&
                  !primaryAuthRefreshAttempted &&
                  currentCodexHome === self.primaryCodexHome &&
                  refreshCodexAuthFromHost(currentCodexHome, self.primaryHostCodexHome);
                if (canRefreshPrimaryAuth) {
                  primaryAuthRefreshAttempted = true;
                  yield {
                    type: 'progress',
                    message: formatBlockquoteLabel(
                      '↻',
                      `Codex auth refreshed from host copy after ${
                        ev.classification === 'auth_invalidated' ? 'authentication failure' : 'system error'
                      }; restarting app-server and retrying turn`,
                    ),
                  };

                  turnTracker.server = null;
                  turnTracker.threadId = null;
                  turnTracker.currentTurnId = null;
                  killCodexAppServer(server);

                  writeCodexMcpConfigToml(self.mcpServers);
                  writeCodexHooksJson();

                  server = spawnCodexAppServer(createCodexConfigOverrides(effectiveConfig, effectiveFast));
                  turnTracker.server = server;
                  attachCodexAutoApproval(server);
                  await initializeCodexAppServer(server);

                  const previousThreadId: string | undefined = threadId;
                  threadId = await startOrResumeCodexThread(server, threadId, threadParams);
                  turnTracker.threadId = threadId ?? null;
                  const transition = resolveCodexRestartTransition({
                    previousThreadId,
                    nextThreadId: threadId,
                    originalText: text,
                    initYielded,
                  });
                  attemptText = transition.attemptText;
                  initYielded = transition.initYielded;
                  if (transition.resetThreadDedupe) {
                    resetCodexTurnAccumulatorThread(turnAccum);
                  }

                  rotateAndRetry = true;
                  break;
                }
                if (eligible && self.nextFallback < self.fallbackHomes.length) {
                  const nextHome = self.rotateCodexHome();
                  if (nextHome) {
                    // Best-effort: copy the active rollout into the new
                    // CODEX_HOME's sessions tree so thread/resume reconstructs
                    // history inline. If the rollout doesn't exist yet (first
                    // turn) or the copy fails, the new app-server falls back
                    // to a fresh thread via STALE_THREAD_RE in
                    // startOrResumeCodexThread — conversation context is lost
                    // but the turn still completes.
                    let rolloutCopied = false;
                    if (threadId) {
                      const src = findRolloutFile(threadId, currentCodexHome);
                      if (src) {
                        const dst = copyRolloutToFallback(src, currentCodexHome, nextHome);
                        rolloutCopied = dst !== null;
                      }
                    }

                    // Visible status — better than swallowing the rotation
                    // silently. Uses progress so it flows through the same
                    // edit-in-place surface as the thinking labels.
                    yield {
                      type: 'progress',
                      message: formatBlockquoteLabel(
                        '↻',
                        `Codex OAuth rotating (${ev.classification}) → fallback ${self.nextFallback}/${self.fallbackHomes.length}` +
                          (rolloutCopied ? ' (history preserved)' : ' (history reset)'),
                      ),
                    };

                    // Tear down the wedged app-server, switch identity,
                    // spawn fresh. CODEX_HOME on process.env is what the
                    // app-server reads at spawn.
                    turnTracker.server = null;
                    turnTracker.threadId = null;
                    turnTracker.currentTurnId = null;
                    killCodexAppServer(server);
                    process.env.CODEX_HOME = nextHome;
                    currentCodexHome = nextHome;

                    // config.toml / hooks.json / agents/ all live under CODEX_HOME,
                    // so the new dir needs all three. The writers honor CODEX_HOME
                    // (just switched above), so regenerating config + the guard hooks
                    // lands them in the fallback home — without this the rotated
                    // app-server runs UNGUARDED. agents/ is bind-mounted only at the
                    // primary, so mirror the role definitions across explicitly. (codex #126)
                    writeCodexMcpConfigToml(self.mcpServers);
                    writeCodexHooksJson();
                    mirrorCodexAgentsToHome(self.primaryCodexHome, nextHome);

                    server = spawnCodexAppServer(createCodexConfigOverrides(effectiveConfig, effectiveFast));
                    turnTracker.server = server;
                    attachCodexAutoApproval(server);
                    await initializeCodexAppServer(server);

                    // Re-resume the thread on the new identity. If the
                    // rollout copy succeeded, threadId stays the same and
                    // history continues. If it didn't, startOrResume falls
                    // back to a fresh thread via STALE_THREAD_RE and
                    // returns a new id — re-emit init so the poll loop
                    // updates its continuation.
                    const previousThreadId: string | undefined = threadId;
                    threadId = await startOrResumeCodexThread(server, threadId, threadParams);
                    turnTracker.threadId = threadId ?? null;
                    const transition = resolveCodexRestartTransition({
                      previousThreadId,
                      nextThreadId: threadId,
                      originalText: text,
                      initYielded,
                    });
                    attemptText = transition.attemptText;
                    initYielded = transition.initYielded;
                    if (transition.resetThreadDedupe) {
                      resetCodexTurnAccumulatorThread(turnAccum);
                    }

                    rotateAndRetry = true;
                    break; // exit for-await; the outer rotation while re-runs
                  }
                }
                // Not eligible OR no fallback slots — original behavior:
                // surface the error and end the query.
                yield ev;
                return;
              }
              // Stamp the effort this query is running at onto the turn's
              // usage. Done here rather than in runOneTurn because this is
              // where the resolved config lives; runOneTurn only ever sees a
              // model string.
              yield ev.type === 'result' ? { ...ev, usage: attachTurnEffort(ev.usage, turnEffort) } : ev;
            }
          }
        }
      } finally {
        turnTracker.server = null;
        turnTracker.threadId = null;
        turnTracker.currentTurnId = null;
        killCodexAppServer(server);
      }
    }

    return {
      push: (message: string) => {
        // If a turn is in flight, steer it instead of queueing — the agent's
        // response can then reference the late-arriving content. Falls back
        // to queueing on RPC error (e.g. the turn just ended between our
        // check and the call) and on missing handles.
        if (turnTracker.server && turnTracker.threadId && turnTracker.currentTurnId) {
          const expectedTurnId = turnTracker.currentTurnId;
          steersInFlight += 1;
          void steerCodexTurn(turnTracker.server, {
            threadId: turnTracker.threadId,
            expectedTurnId,
            inputText: message,
          })
            .catch(() => {
              pending.push(message);
              kick();
            })
            // Runs after the catch above, so `pending` already holds the
            // fallback by the time the counter drops.
            .finally(() => {
              steersInFlight -= 1;
            });
          return;
        }
        pending.push(message);
        kick();
      },
      // Steering keeps the push inside the running turn, but the fallbacks
      // above queue it as a separate future turn — same shape as opencode.
      // An unsettled steer counts too: its rejection queues asynchronously,
      // after the poll-loop may already have sampled this. Reported so the
      // poll-loop doesn't publish idle in the gap before a queued turn
      // starts. See AgentQuery.hasQueuedWork.
      hasQueuedWork: () => pending.length > 0 || steersInFlight > 0,
      end: () => {
        ended = true;
        kick();
      },
      abort: () => {
        aborted = true;
        kick();
      },
      events: gen(),
    };
  }
}

// Per-turn totals summed across ONE logical turn. Owned by the caller so it outlives a
// single runOneTurn attempt — see the LIFETIME note inside runOneTurn.
export type CodexTurnAccumulator = {
  seen: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  // `item/completed` count — the turn's step proxy. Same struct as the token
  // counters on purpose: both are per-turn totals with the same lifetime, so
  // one reset can't be remembered and the other forgotten.
  steps: number;
  // Item ids already counted into `steps`. Same replay exposure as the token
  // counters: a resumed app-server that re-emits `item/completed` for items
  // the pre-crash attempt already counted would inflate `steps`, and `steps`
  // is the denominator of output_per_step.
  countedItemIds: Set<string>;
  // Serialized previous `tokenUsage` payload — the duplicate-emission guard.
  // See the `thread/tokenUsage/updated` handler.
  lastUsageKey: string | null;
};

export function createCodexTurnAccumulator(): CodexTurnAccumulator {
  return {
    seen: false,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    steps: 0,
    countedItemIds: new Set(),
    lastUsageKey: null,
  };
}

/**
 * A fresh-thread retry keeps the turn's billed totals and drops only the state
 * that belonged to the thread that went away.
 *
 * The totals carry because the failed attempt's tokens were genuinely billed by
 * the provider. They are never added twice — the fresh attempt's requests are
 * distinct requests — so clearing them here does not prevent a double-count, it
 * silently discards real spend.
 *
 * Both dedupe guards DO reset, because each keys on a value the new thread
 * re-issues from scratch:
 *  - `lastUsageKey` is the adjacent-duplicate guard. A fresh thread's first
 *    payload is `{last: X, total: X}` — exactly the shape the failed attempt's
 *    FIRST payload had, and the fresh attempt re-sends the same prompt, so those
 *    counts can match byte-for-byte. A carried key would suppress a genuine
 *    request rather than a repeat.
 *  - `countedItemIds` holds server-assigned ids from a thread that no longer
 *    exists. A fresh app-server may reuse them, which would undercount `steps` —
 *    the denominator of output_per_step.
 *
 * The same-thread recovery path resets NEITHER: there the resumed app-server
 * really can replay records the pre-crash attempt already counted, which is the
 * exposure both guards exist for.
 */
export function resetCodexTurnAccumulatorThread(accum: CodexTurnAccumulator): void {
  accum.countedItemIds.clear();
  accum.lastUsageKey = null;
}

// ── Per-turn event pump ─────────────────────────────────────────────────────
// Pulled out because the gen() loop above reads cleaner with it extracted,
// and because it's a natural seam for future unit tests that drive it with
// a fake notification stream.

export async function* runOneTurn(
  server: AppServer,
  threadId: string,
  inputText: string,
  model: string,
  cwd: string,
  hasInit: () => boolean,
  markInit: () => void,
  turnTracker?: { currentTurnId: string | null },
  healthConfig: CodexTurnHealthConfig = codexTurnHealthConfigFromEnv(),
  recoveryAttempts = 0,
  turnAccum: CodexTurnAccumulator = createCodexTurnAccumulator(),
): AsyncGenerator<ProviderEvent> {
  // Mutable refs via object properties — TS can't track closure assignments
  // for narrowing, but property access keeps the declared type visible.
  //
  // `errorKind` carries Codex's structured `codexErrorInfo.type` enum
  // (e.g. `UsageLimitExceeded`, `ServerOverloaded`, `Unauthorized`,
  // `ContextWindowExceeded`) when present on a `turn/completed: failed`
  // payload. Used by callers to decide whether an error is rotation-eligible
  // (quota-flavored) vs terminal (auth/context).
  const turnState: { error: Error | null; errorKind: string | null } = { error: null, errorKind: null };
  let resultText = '';
  let turnDone = false;
  // Set when a SPAWNED CHILD agent's turn died on a quota error. Kept out of
  // `turnState` until the turn actually ends because `completeTurn` /
  // `finishForLivenessFailure` both overwrite `turnState.error` on their own
  // terminal paths — this failure has to survive those, since it is the one
  // that says "this credential slot is spent" and therefore the one the
  // rotation path needs to see. Applied to `turnState` at the single point
  // where the classification is read. See detectCodexChildAgentQuotaFailure.
  let childAgentQuotaError: string | null = null;
  // Per-turn cost attribution (Fleet Hardening Phase 0.1 follow-up): Codex's
  // app-server protocol has no single "API round-trip count" field the way
  // the Claude SDK's num_turns does. `item/completed` — one per tool call,
  // command execution, reasoning block, or agent message the turn produced —
  // is the closest available proxy: not a literal HTTP request count, but the
  // best signal this protocol exposes rather than a guess. It lives on the
  // same accumulator as the token counters — see LIFETIME below.
  //
  // Fleet Hardening Phase 0.1 (see TurnUsageInfo). `thread/tokenUsage/updated`
  // fires once per MODEL REQUEST and carries both `last` (that one request)
  // and `total` (the THREAD's running total). A turn makes as many requests as
  // it takes tool-calling round trips, so `last` on its own is NOT the turn —
  // recording only the final one undercounted codex by ~1-2 orders of
  // magnitude. Summing `last` across the turn is.
  //
  // Reporting `total` and deltaing it downstream (what turn-usage.ts's
  // toTurnDelta does for Claude) would be WRONG here, because codex's counter
  // is not process-local: the thread is persisted and a respawned container
  // resumes it, so the fresh app-server replays a carried-forward `total`
  // against an empty in-memory baseline (turn-usage.ts's memo is a module
  // global) — the whole pre-restart thread history books as one turn, and the
  // reset check cannot catch it because the value went UP, not down. Summing
  // per-request `last` depends on nothing outside this turn, so a respawn
  // mid-thread costs at most the requests already made before the kill.
  // Verified against codex 0.145.0's rollout log: consecutive `total`
  // differences equal each record's own `last`.
  //
  // No cost field exists on this protocol (ChatGPT-plan billing, not
  // per-token pricing) — cost_usd stays NULL for codex. `seen` (rather than
  // "are the counters still zero") keeps a genuine all-zero turn distinct from
  // a turn the app-server never reported usage for, which stays a NULL-token
  // row so the gap remains visible. Object-property refs (not bare `let`s) for
  // the same reason as `turnState` above — TS can't track closure assignments
  // for narrowing, but property access keeps the declared type visible.
  //
  // LIFETIME: the accumulator is owned by the CALLER (see gen()), not declared
  // here, because ONE logical turn can span several runOneTurn invocations —
  // the outer retry loop re-invokes this generator on a same-thread recovery,
  // and the model requests made before that crash belong to the same turn.
  // Codex can deliver reasoning two ways: streaming `item/reasoning/…` deltas
  // when enabled by the app-server, or finalized reasoning ThreadItems via
  // item/completed. Streamed item IDs are tracked so lifecycle fallback
  // payloads do not duplicate already-forwarded summaries.
  let reasoningBuffer = '';
  const reasoningItemsWithDeltas = new Set<string>();
  const emittedReasoningItemIds = new Set<string>();
  const emittedImageKeys = new Set<string>();
  const emittedCollaborationItemIds = new Set<string>();

  // Buffered event queue so we can `yield` across the async notification
  // callback. Each notification pushes zero or more ProviderEvents; the
  // generator drains the buffer.
  const buffer: ProviderEvent[] = [];
  let waker: (() => void) | null = null;
  const kick = (): void => {
    waker?.();
    waker = null;
  };

  const flushReasoning = (): void => {
    if (!reasoningBuffer.trim()) {
      reasoningBuffer = '';
      return;
    }
    buffer.push({ type: 'progress', message: formatBlockquoteLabel('💭', truncate(reasoningBuffer)) });
    reasoningBuffer = '';
  };

  const emitCompletedReasoningItem = (item: ReasoningThreadItem | undefined): void => {
    const text = extractReasoningItemText(item);
    if (!text || !thinkingForwardingEnabled()) return;

    const itemId = typeof item?.id === 'string' ? item.id : undefined;
    if (itemId && (reasoningItemsWithDeltas.has(itemId) || emittedReasoningItemIds.has(itemId))) return;

    buffer.push({ type: 'progress', message: formatBlockquoteLabel('💭', truncate(text)) });
    if (itemId) emittedReasoningItemIds.add(itemId);
  };

  const emitGeneratedFile = (filePath: string, key: string): void => {
    if (emittedImageKeys.has(key)) return;
    emittedImageKeys.add(key);
    buffer.push({ type: 'file', path: filePath });
  };

  const emitCollaborationProgress = (item: unknown): void => {
    const message = formatCodexCollaborationProgress(item, emittedCollaborationItemIds);
    if (message) buffer.push({ type: 'progress', message });
  };

  const liveness = new CodexTurnLiveness({
    probeFailureLimit: healthConfig.probeFailureLimit,
    inactiveSnapshotLimit: healthConfig.inactiveSnapshotLimit,
  });
  type CompletedThreadItem =
    | ({ id?: unknown; type?: string; text?: string } & ReasoningThreadItem & ImageGenerationThreadItem)
    | undefined;

  /**
   * Upstream does NOT fail the parent turn when a spawned child agent errors
   * — it injects the child's error into the parent as prose and lets the
   * parent keep going. On a quota error that means the parent runs on against
   * a spent credential slot, and nothing in `turnState` ever tells the
   * rotation path why. End the turn here instead, attributed as the parent's
   * own quota failure, so `classifyCodexError` →
   * `isCodexOAuthRotationEligible` → `rotateCodexHome` + app-server respawn
   * runs unchanged. First detection wins; later items cannot downgrade it.
   */
  const noteChildAgentQuotaFailure = (item: unknown): void => {
    if (childAgentQuotaError) return;
    const detected = detectCodexChildAgentQuotaFailure(item);
    if (!detected) return;
    childAgentQuotaError = detected;
    console.error(`[codex-provider] ${detected}`);
    buffer.push({
      type: 'progress',
      message: formatBlockquoteLabel('↻', 'A Codex subagent exhausted this account; rotating credentials and retrying'),
    });
    // Ending the turn is what actually stops the burn: the app-server is torn
    // down by the rotation path in gen(), which is this provider's equivalent
    // of interrupting the in-flight query.
    if (!turnDone) {
      turnDone = true;
      kick();
    }
  };

  // Codex may deliver completed ThreadItems live, only in turn/completed, or
  // both. Keep all user-visible restoration and liveness bookkeeping here so
  // those delivery paths remain observationally equivalent.
  const reduceCompletedThreadItem = (item: CompletedThreadItem): void => {
    liveness.noteItemCompleted(item);

    // Count each item once per turn. The id-less case still counts — there is
    // nothing to dedupe on, and dropping it would undercount.
    const stepItemId = typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : '';
    if (!stepItemId || !turnAccum.countedItemIds.has(stepItemId)) {
      turnAccum.steps++;
      if (stepItemId) turnAccum.countedItemIds.add(stepItemId);
    }
    emitCollaborationProgress(item);
    noteChildAgentQuotaFailure(item);
    if (item?.type === 'agentMessage' && item.text) resultText = item.text;
    if (item?.type === 'reasoning') emitCompletedReasoningItem(item);
    const generatedImagePath = extractImageGenerationPath(item);
    if (generatedImagePath) {
      emitGeneratedFile(generatedImagePath, imageGenerationKey(item, `path:${generatedImagePath}`));
    }
  };
  const isTerminalThreadItemPayload = (item: unknown): boolean => {
    if (!item || typeof item !== 'object') return false;
    const { status, type } = item as { status?: unknown; type?: unknown };
    // A completed-turn snapshot can still explicitly report a blocking item
    // as in progress. Preserve that signal for liveness recovery instead of
    // treating it as a completed item just because it appeared in the payload.
    if (status === 'inProgress') return false;
    if (isCodexTerminalTurnItem(item)) return true;
    // Assistant/reasoning items have no status in current Codex snapshots;
    // their presence in an authoritative completed turn is terminal output.
    return status === undefined && (type === 'agentMessage' || type === 'reasoning');
  };
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let healthProbeInFlight = false;
  let lastProbeAt: string | null = null;
  let providerRecoveryRequested = false;
  let turnCompletionInFlight = false;
  let noticeForLastNotificationAtMs: number | null = null;
  let lastMethod = '<turn-start>';

  const persistHealth = (status: ProviderHealthState['status'], failureReason: string | null = null): void => {
    const snapshot = liveness.snapshot();
    persistCodexProviderHealth({
      status,
      lastEventAt: new Date(snapshot.lastNotificationAtMs).toISOString(),
      lastProbeAt,
      probeFailures: snapshot.consecutiveProbeFailures,
      recoveryAttempts,
      failureReason,
    });
  };

  const finishForLivenessFailure = (
    classification: 'control_plane_unresponsive' | 'protocol_desync',
    reason: string,
  ): void => {
    if (turnDone) return;
    const prefix =
      classification === 'control_plane_unresponsive' ? 'codex_control_plane_unresponsive' : 'codex_protocol_desync';
    console.error(
      `[codex-provider] health watchdog requested recovery ` +
        `(classification=${classification}, last notification=${lastMethod}, model=${model}): ${reason}`,
    );
    buffer.push({
      type: 'progress',
      message: formatBlockquoteLabel('↻', 'Codex control plane became unhealthy; preparing an app-server restart'),
    });
    providerRecoveryRequested = true;
    persistHealth('failed', reason);
    turnState.error = new Error(`${prefix}: ${reason}`);
    turnDone = true;
    kick();
  };

  const runHealthProbe = async (): Promise<void> => {
    if (turnDone || healthProbeInFlight) return;
    const before = liveness.snapshot();
    if (Date.now() - before.lastNotificationAtMs < healthConfig.quietMs) return;

    healthProbeInFlight = true;
    const probeStartedAtMs = Date.now();
    try {
      const raw = await probeCodexThreadHealth(server, threadId, healthConfig.timeoutMs);
      if (turnDone) return;
      lastProbeAt = new Date().toISOString();
      const decision = liveness.noteProbeSuccess({
        rootStatus: normalizeCodexThreadStatus(raw.rootStatus),
        descendantStatuses: raw.descendantStatuses.map(normalizeCodexThreadStatus),
      });

      // A successful control-plane round trip is real liveness even when the
      // model/tool emitted no user-visible event. The poll-loop converts this
      // activity event into the host heartbeat file touch.
      buffer.push({ type: 'activity' });
      if (decision.kind === 'recover') {
        finishForLivenessFailure(decision.classification, decision.reason);
      } else if (decision.kind === 'suspect') {
        persistHealth('suspect', decision.reason);
      } else {
        persistHealth('healthy');
        const quietForMs = Date.now() - liveness.snapshot().lastNotificationAtMs;
        if (
          quietForMs >= healthConfig.stillWorkingNoticeMs &&
          noticeForLastNotificationAtMs !== liveness.snapshot().lastNotificationAtMs
        ) {
          noticeForLastNotificationAtMs = liveness.snapshot().lastNotificationAtMs;
          buffer.push({
            type: 'progress',
            message: formatBlockquoteLabel(
              '⏳',
              'Codex is still active; its control plane is responding while the current work remains quiet',
            ),
          });
        }
      }
    } catch (err) {
      if (turnDone) return;
      // A notification arriving while the probe was pending proves the
      // control plane is alive; do not count a raced request timeout.
      if (liveness.snapshot().lastNotificationAtMs > probeStartedAtMs) {
        liveness.noteProbeSuccess({ rootStatus: 'unknown', descendantStatuses: [] });
        return;
      }
      const reason = err instanceof Error ? err.message : String(err);
      lastProbeAt = new Date().toISOString();
      const decision = liveness.noteProbeFailure(reason);
      if (decision.kind === 'recover') {
        finishForLivenessFailure(decision.classification, decision.reason);
      } else if (decision.kind === 'suspect') {
        persistHealth('suspect', decision.reason);
      }
    } finally {
      healthProbeInFlight = false;
      kick();
    }
  };

  const completeTurn = async (rawParams: Record<string, unknown>): Promise<void> => {
    const p = rawParams as {
      status?: string;
      error?: { message?: string; codexErrorInfo?: { type?: string } };
      turn?: {
        id?: string;
        status?: string;
        items?: unknown[];
        itemsView?: string;
        error?: { message?: string; codexErrorInfo?: { type?: string } } | null;
      };
    };
    let completedTurn = p.turn;
    const initialStatus = completedTurn?.status ?? p.status;

    // Current Codex app-server can guarantee turn/completed while omitting
    // turn.items under notification backpressure. It can also explicitly mark
    // a non-empty payload as `itemsView: summary`, which is not authoritative.
    // Match the official `codex exec` recovery and extend it to the protocol's
    // explicit partial-view marker before deciding that a locally open
    // execution item was abandoned.
    const completedTurnId = completedTurn?.id ?? turnTracker?.currentTurnId ?? null;
    const items = completedTurn?.items;
    const hasExplicitNonFullItemsView = completedTurn?.itemsView !== undefined && completedTurn.itemsView !== 'full';
    if (
      initialStatus === 'completed' &&
      (hasExplicitNonFullItemsView ||
        (liveness.hasOpenBlockingItems() && (!Array.isArray(items) || items.length === 0))) &&
      completedTurnId
    ) {
      try {
        const backfilled = await readCodexTurnSnapshotWithRetry(
          server,
          threadId,
          completedTurnId,
          healthConfig.timeoutMs,
        );
        completedTurn = {
          ...completedTurn,
          ...backfilled,
          id: completedTurnId,
          status: typeof backfilled.status === 'string' ? backfilled.status : completedTurn?.status,
          items: Array.isArray(backfilled.items) ? backfilled.items : completedTurn?.items,
          itemsView: typeof backfilled.itemsView === 'string' ? backfilled.itemsView : completedTurn?.itemsView,
        };
      } catch (err) {
        console.error(
          `[codex-provider] Failed to backfill completed turn ${completedTurnId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const snapshotItemsAreAuthoritative = completedTurn?.itemsView === undefined || completedTurn.itemsView === 'full';
    if (snapshotItemsAreAuthoritative && Array.isArray(completedTurn?.items)) {
      for (const item of completedTurn.items) {
        // Scanned unconditionally, ahead of the terminality gate: the injected
        // inter-agent completion message is not necessarily an
        // agentMessage/reasoning item, so `isTerminalThreadItemPayload` can
        // legitimately reject the one item that carries the child's failure.
        noteChildAgentQuotaFailure(item);
        if (isTerminalThreadItemPayload(item)) reduceCompletedThreadItem(item as CompletedThreadItem);
      }
    }

    const status = completedTurn?.status ?? p.status;
    const error = completedTurn?.error ?? p.error;
    const turnEndDecision = liveness.noteTurnEnded(completedTurn);
    if (status === 'failed' || error) {
      const kind = error?.codexErrorInfo?.type;
      turnState.error = new Error(error?.message || 'Turn failed');
      if (typeof kind === 'string') turnState.errorKind = kind;
    } else if (status === 'interrupted') {
      // Interruption is an explicit terminal state, not evidence that the
      // app-server lost execution lifecycle state.
      turnState.error = new Error('Turn interrupted');
    } else if (turnEndDecision.kind === 'recover') {
      if (turnTracker) turnTracker.currentTurnId = null;
      finishForLivenessFailure(turnEndDecision.classification, turnEndDecision.reason);
      return;
    }

    flushReasoning();
    if (turnTracker) turnTracker.currentTurnId = null;
    turnDone = true;
    kick();
  };

  const handler = (n: JsonRpcNotification): void => {
    const method = n.method;
    const params = n.params;
    lastMethod = method;
    const isActiveTurnNotification = isCodexNotificationForActiveTurn(
      method,
      params,
      threadId,
      turnTracker?.currentTurnId ?? null,
    );

    if (!isActiveTurnNotification) {
      // Child/older-turn traffic still proves the shared app-server control
      // plane is responsive, but it must never mutate the root turn's item
      // tracker, result text, error, or completion state.
      liveness.noteNotification();
    } else if (method === 'item/started') {
      liveness.noteItemStarted(params.item);
    } else if (method === 'turn/failed') {
      liveness.noteTurnEnded(params.turn);
    } else {
      liveness.noteNotification();
    }

    // Every inbound notification counts as activity for the poll-loop's
    // idle timer — yield before any event-specific translation so even
    // long tool executions keep the loop awake.
    buffer.push({ type: 'activity' });

    if (!isActiveTurnNotification) {
      kick();
      return;
    }

    if (method === 'turn/completed') {
      if (!turnCompletionInFlight) {
        turnCompletionInFlight = true;
        void completeTurn(params);
      }
      return;
    }

    switch (method) {
      case 'thread/started': {
        const thread = params.thread as { id?: string } | undefined;
        if (thread?.id && !hasInit()) {
          markInit();
          buffer.push({ type: 'init', continuation: thread.id });
        }
        break;
      }
      case 'turn/started': {
        const tid = (params as { turnId?: string }).turnId ?? (params as { turn?: { id?: string } }).turn?.id;
        if (turnTracker && typeof tid === 'string') turnTracker.currentTurnId = tid;
        break;
      }
      case 'item/agentMessage/delta': {
        const delta = params.delta as string;
        if (delta) resultText += delta;
        break;
      }
      case 'thread/tokenUsage/updated': {
        // See turnAccum above — `last` is ONE model request and this
        // notification fires per request, so the sum of every `last` seen
        // between turn/started and turn/completed IS this turn's usage.
        // `total` is deliberately ignored: it is thread-scoped and survives
        // container respawns, which no in-process baseline can subtract.
        const usage = (params as { tokenUsage?: Record<string, unknown> }).tokenUsage;
        const last = (params as { tokenUsage?: { last?: CodexTokenUsageBreakdown } }).tokenUsage?.last;

        // Duplicate-emission guard. Codex re-emits this notification with a
        // byte-identical payload: over 209 local rollouts (305,129 records)
        // 4,630 adjacent pairs carried an identical running counter AND an
        // identical `last`, which summing `last` double-counts — measured at
        // 2.88% of input tokens fleet-wide, 1.48x on the worst session. (The
        // old `total`-delta reading was immune because a repeat is a zero
        // delta; the sum is not, which is why the guard has to be explicit.)
        //
        // The key is the whole `tokenUsage` object rather than the running
        // counter alone, because that is exactly the shape measured as
        // repeating, and because it keeps this a duplicate KEY and never a
        // token VALUE — the running counter stays unusable as a number here
        // (it is thread-scoped and survives respawns; see the accumulator
        // note above and the guard test in codex.recovery-integration.test.ts).
        //
        // No false-positive risk when the payload carries the running
        // counter: a genuine second request always advances it, so an
        // unchanged payload cannot be a distinct request. When it does NOT
        // carry one there is no monotonic evidence, so the guard stands down
        // rather than risk dropping a real request.
        const usageKey = usage && 'total' in usage ? JSON.stringify(usage) : null;
        const isRepeat = usageKey !== null && usageKey === turnAccum.lastUsageKey;
        turnAccum.lastUsageKey = usageKey;

        if (last && !isRepeat) {
          turnAccum.seen = true;
          turnAccum.inputTokens += last.inputTokens ?? 0;
          turnAccum.outputTokens += last.outputTokens ?? 0;
          turnAccum.cachedInputTokens += last.cachedInputTokens ?? 0;
          turnAccum.cacheWriteInputTokens += last.cacheWriteInputTokens ?? 0;
        }
        break;
      }
      case 'item/started': {
        // Surface both the legacy collab tool-call shape and Codex 0.144.1's
        // native sub-agent lifecycle events. Some app-server versions also
        // repeat ThreadItems at completion; the required item ID dedupes them.
        emitCollaborationProgress(params.item);
        // Cheap second look at the start of an item's life: some app-server
        // versions carry an injected item's full text on item/started, and
        // catching it there saves a round trip on the spent slot.
        noteChildAgentQuotaFailure(params.item);
        break;
      }
      case 'item/completed': {
        reduceCompletedThreadItem(params.item as CompletedThreadItem);
        break;
      }
      case 'rawResponseItem/completed': {
        const item = params.item as RawImageGenerationResponseItem | undefined;
        const generatedImagePath = materializeRawImageGeneration(item);
        if (generatedImagePath) {
          emitGeneratedFile(generatedImagePath, imageGenerationKey(item, `path:${generatedImagePath}`));
        }
        break;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        // Codex emits one of these (per `show_raw_agent_reasoning` config —
        // default false → summary deltas). Accumulate until a section
        // break or turn end flushes as a 💭 thinking label, mirroring
        // Claude's thinking-block UX. Suppressed when NANOCLAW_HIDE_THINKING=1.
        const itemId = (params as { itemId?: unknown }).itemId;
        if (typeof itemId === 'string') {
          reasoningItemsWithDeltas.add(itemId);
          if (emittedReasoningItemIds.has(itemId)) break;
        }
        const delta = params.delta as string;
        if (delta && thinkingForwardingEnabled()) reasoningBuffer += delta;
        break;
      }
      case 'item/reasoning/summaryPartAdded': {
        const itemId = (params as { itemId?: unknown }).itemId;
        if (typeof itemId === 'string') reasoningItemsWithDeltas.add(itemId);
        // Codex finalized a reasoning summary section. Emit whatever we
        // accumulated so the user sees thinking updates as they happen,
        // not just one giant label at turn end.
        flushReasoning();
        break;
      }
      case 'turn/failed': {
        const e = params.error as { message?: string; codexErrorInfo?: { type?: string } } | undefined;
        turnState.error = new Error(e?.message || 'Turn failed');
        const kind = e?.codexErrorInfo?.type;
        if (typeof kind === 'string') turnState.errorKind = kind;
        if (turnTracker) turnTracker.currentTurnId = null;
        turnDone = true;
        break;
      }
      case 'thread/status/changed': {
        // Codex's thread/status/changed payload shape varies by app-server
        // version. Some versions emit params.status as a plain string;
        // others emit a structured object (e.g. { state: 'thinking',
        // detail: '...' }, or { type: 'systemError' }). Extract the most
        // useful human-readable label; never let template coercion produce
        // "[object Object]".
        //
        // Drop the trivial "active" / "idle" labels — they fire on every
        // turn-state flip, so the chat-side status message (which the host
        // delivers as edit-in-place) ends up overwriting the 💭 thinking
        // labels emitted from `item/reasoning/…` with "status: active". The
        // Claude provider hit the analogous problem with tool_use labels
        // overwriting thinking and resolved it the same way (claude.ts:54).
        // Anything more semantic that codex might emit (compacting,
        // loading skills, etc.) still gets forwarded.
        const raw = params.status;
        let label: string | null = null;
        if (typeof raw === 'string') {
          label = raw;
        } else if (raw && typeof raw === 'object') {
          const obj = raw as Record<string, unknown>;
          const candidate = obj.label ?? obj.state ?? obj.status ?? obj.kind ?? obj.type ?? obj.message ?? obj.text;
          label = typeof candidate === 'string' ? candidate : JSON.stringify(raw);
        }
        // `systemError` is a thread-fatal state — Codex stops processing the
        // turn but the follow-up `turn/completed: failed` is unreliable
        // across app-server versions (observed wedge in 0.130.0: 30-min idle
        // until host-sweep ceiling killed the container). End the turn here
        // so the caller can react instead of waiting for a notification that
        // may never come. errorKind stays null because thread/status/changed
        // carries no structured detail — rotation logic should treat that as
        // "unknown, conservative-rotate" rather than "definitely auth/context".
        if (label === 'systemError') {
          turnState.error = new Error('codex_system_error: thread entered systemError state');
          if (turnTracker) turnTracker.currentTurnId = null;
          turnDone = true;
          break;
        }
        if (label && label !== 'active' && label !== 'idle') {
          buffer.push({ type: 'progress', message: `status: ${label}` });
        }
        break;
      }
      default:
        // Silently handle the many `item/…` notifications — they already
        // contributed an activity event above.
        break;
    }

    kick();
  };

  server.notificationHandlers.push(handler);

  // Publish the entire Codex turn as host-visible work. Successful protocol
  // probes refresh the heartbeat, so the one-hour value is now only the host's
  // catastrophic fallback if this in-container recovery loop itself stops.
  try {
    setContainerToolInFlight('CodexItem', CODEX_IN_FLIGHT_ITEM_TIMEOUT_MS);
  } catch (err) {
    console.error('[codex-provider] Failed to update host in-flight state:', err);
  }
  persistHealth('active');
  healthTimer = setInterval(() => {
    void runHealthProbe();
  }, healthConfig.intervalMs);

  try {
    // If we yield init before turn/start, the poll-loop stores
    // continuation early and survives a mid-turn crash.
    if (!hasInit()) {
      markInit();
      buffer.push({ type: 'init', continuation: threadId });
    }

    const startedTurnId = await startCodexTurn(server, { threadId, inputText, model, cwd });
    if (turnTracker && startedTurnId) turnTracker.currentTurnId = startedTurnId;

    while (true) {
      while (buffer.length > 0) {
        const ev = buffer.shift()!;
        yield ev;
      }
      if (turnDone) break;
      await new Promise<void>((resolve) => {
        waker = resolve;
      });
      waker = null;
    }

    while (buffer.length > 0) yield buffer.shift()!;

    // A child agent's quota failure is the parent turn's failure too — the
    // slot it is running on is spent. Attribute it exactly as a structured
    // `UsageLimitExceeded` on this turn so the existing classification and
    // rotation path below needs no special case. Deliberately overrides an
    // already-set `turnState.error`: whatever else the turn reported, the
    // spent credential is the actionable cause and the only one whose
    // recovery (rotate + replay) is correct.
    if (childAgentQuotaError) {
      turnState.error = new Error(childAgentQuotaError);
      turnState.errorKind = 'UsageLimitExceeded';
    }

    if (turnState.error) {
      // Map the structured CodexErrorInfo type to a ProviderEvent
      // `classification` so callers (CodexProvider.gen rotation) can decide
      // whether to rotate OAuth identities. Unknown → omit classification.
      // The `system_error` value below covers the coarse-systemError path
      // where thread/status/changed fired but no follow-up turn/completed
      // carried structured detail (observed wedge in codex-cli 0.130.0).
      // Control-plane classifications are intercepted by CodexProvider.gen,
      // which replaces only app-server and resumes this persisted thread.
      // retryable stays false: this is NOT the SDK-internal-retry signal (that
      // path keeps the stream open) — the turn is dead and must be re-run via
      // the catch path. See classifyCodexError.
      const classification = classifyCodexError(turnState.error.message, turnState.errorKind);
      yield {
        type: 'error',
        message: turnState.error.message,
        retryable: false,
        ...(classification ? { classification } : {}),
      };
      return;
    }

    yield {
      type: 'result',
      text: resultText || null,
      // This turn's own usage already — the sum of every model request it
      // made. NOT routed through turn-usage.ts's cumulative delta path.
      usage: turnAccum.seen
        ? {
            model,
            inputTokens: turnAccum.inputTokens,
            outputTokens: turnAccum.outputTokens,
            cacheReadTokens: turnAccum.cachedInputTokens,
            cacheWriteTokens: turnAccum.cacheWriteInputTokens,
            costUsd: null,
          }
        : undefined,
      steps: turnAccum.steps > 0 ? turnAccum.steps : null,
    };
  } finally {
    try {
      clearContainerToolInFlight();
    } catch (err) {
      console.error('[codex-provider] Failed to clear host in-flight state:', err);
    }
    if (healthTimer !== null) clearInterval(healthTimer);
    if (!providerRecoveryRequested) {
      persistHealth(turnState.error ? 'failed' : 'idle', turnState.error?.message ?? null);
    }
    const idx = server.notificationHandlers.indexOf(handler);
    if (idx >= 0) server.notificationHandlers.splice(idx, 1);
  }
}

registerProvider('codex', (opts) => new CodexProvider(opts));
