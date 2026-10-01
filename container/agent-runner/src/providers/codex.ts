/**
 * Follow-up `push()` messages steer the active turn via `turn/steer`, queuing only when no turn is in flight or the
 * steer races turn completion.
 */
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

import { z } from 'zod';

import { memoryContextForSessionStart, type MemorySessionHookRegistration } from '../memory/session-hook.js';
import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/container-state.js';
import { appendActiveRuntimeContext } from '../runtime-context.js';
import { setProviderHealthState, type ProviderHealthState } from '../modules/mailbox/index.js';
import { formatCredentialRotationNotice } from '../credential-rotation-notice.js';
import { CODEX_MODEL_RE, isCodexFamilyName, resolveCodexFamily } from './model-vocabulary.js';
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
  interruptCodexTurn,
  CODEX_INIT_TIMEOUT_MS,
  killCodexAppServer,
  probeCodexThreadHealth,
  readCodexTurnSnapshot,
  startCodexAppServer,
  startCodexTurn,
  startOrResumeCodexThread,
  steerCodexTurn,
  resolveCodexConfigDir,
  writeCodexMcpConfigToml,
  readCodexSubagentThreads,
} from './codex-app-server.js';
// Hooks AND their trust entries: Codex >=0.154 never runs an untrusted hook.
import { verifyCodexHookTrust, writeCodexHooksAndTrust } from '../codex-companion-setup.js';
import { CodexTurnLiveness, isCodexTerminalTurnItem, normalizeCodexThreadStatus } from './codex-liveness.js';
import { CodexRateLimitTracker } from './codex-rate-limit-tracker.js';
import type { CodexRateLimitPark } from './codex-rate-limits.js';
import { attachTurnEffort } from './turn-effort.js';
import { formatBlockquoteLabel, thinkingForwardingEnabled, truncate } from './thinking-labels.js';
import { recordContextTokens, recordSubagent } from '../turn-status.js';

/**
 * Idle is measured from the last notification, not turn start: a quiet turn can be legitimate for hours. Once quiet,
 * non-mutating probes decide, and only repeated control-plane failures or impossible inactive snapshots replace the
 * app-server.
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

/** Codex 0.144.1 can surface one action as both the legacy `collabAgentToolCall` and the `subAgentActivity` shape. */
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

/** Both shapes carry the originating call ID, so the per-turn set dedupes them without hiding distinct actions. */
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

  // Every lifecycle notification but thread/started carries threadId; one without it must not mutate the turn.
  if (params.threadId !== threadId) return false;

  const turn = params.turn;
  const nestedTurnId =
    turn && typeof turn === 'object' && typeof (turn as Record<string, unknown>).id === 'string'
      ? ((turn as Record<string, unknown>).id as string)
      : null;
  const notificationTurnId = typeof params.turnId === 'string' ? params.turnId : nestedTurnId;

  // A turn id must be PRESENT only on turn/, item/ and rawResponseItem/ notifications.
  const requiresTurnId =
    method.startsWith('turn/') || method.startsWith('item/') || method.startsWith('rawResponseItem/');
  if (requiresTurnId && !notificationTurnId) return false;

  // MATCHING applies to any notification naming a turn: thread/tokenUsage/updated carries turnId too, and a stale one
  // would inflate this turn's usage. Presence is not required here, or a build omitting it would meter zero.
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

/** Shape of both `tokenUsage.last` and `.total`, verified against codex 0.145.0's generated types. */
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
  // Summaries are the user-facing surface; content is a fallback for builds that finalize raw text.
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

// Sticky-only: `model` applies at thread-start, `reasoning_effort` and the collaboration cap at app-server spawn.
/**
 * The only Codex fleet defaults, shared by the schema default and the constructor so an unpinned native group and a
 * Claude → Codex fallback resolve identically. Keep equal to the `sol` family target (`CODEX_FAMILY_DEFAULTS`,
 * src/flag-parser.ts); setup/lib/codex-model-min-cli.test.ts fails when they differ.
 */
export const DEFAULT_CODEX_MODEL = 'gpt-6.1-sol';
export const DEFAULT_CODEX_EFFORT = 'high' as const;

export const codexConfigSchema = z.strictObject({
  model: z.string().min(1).optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional().default(DEFAULT_CODEX_EFFORT),
  max_concurrent_threads_per_session: z
    .number()
    .int()
    .positive()
    .optional()
    .default(DEFAULT_CODEX_MAX_CONCURRENT_THREADS_PER_SESSION),
});

registerProviderConfigSchema('codex', codexConfigSchema);

// Validated before reaching the app-server: stale sticky state can carry a claude id, which would fail every turn
// at thread/start.

/** Mirrors the host flag-parser's CODEX_VALID_MODEL_RE (separate package trees). */
export { CODEX_MODEL_RE };

const CODEX_EFFORT_VALUES: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

type CodexStickyConfig = z.infer<typeof codexConfigSchema>;

export function resolveQueryModel(requested: string | undefined, fallback: string): string {
  if (!requested) return fallback;
  requested = resolveCodexFamily(requested);
  if (CODEX_MODEL_RE.test(requested)) return requested;
  console.error(`[codex-provider] Ignoring non-codex model override "${requested}" — staying on ${fallback}`);
  return fallback;
}

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

// Group instructions reach Codex only through the auto-loaded AGENTS.md; folding CLAUDE.md in here would duplicate
// them every turn.
function composeBaseInstructions(promptAddendum: string | undefined, maxConcurrentThreadsPerSession: number): string {
  const lifecycle = buildCodexSubagentLifecycleInstructions(maxConcurrentThreadsPerSession);
  const pieces = [promptAddendum, lifecycle].filter((s): s is string => Boolean(s));
  return pieces.join('\n\n---\n\n');
}

/** Forwarded to every MCP subprocess: without them remote MCP calls bypass OneCLI or fail on its mitm CA. */
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

/** Keys already in `baseEnv` win (an MCP may override a proxy deliberately). */
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

// A rollout file is self-contained (no account binding), so OAuth fallback preserves context by copying it into the
// new CODEX_HOME before respawning.

/** Account-scoped kinds only: other terminal kinds must not consume a fallback account. */
const ROTATABLE_CODEX_ERROR_KINDS: ReadonlySet<string> = new Set([
  'UsageLimitExceeded',
  'ServerOverloaded',
  'Unauthorized',
]);

/** Anchored on stable phrases: the full message embeds a per-account reset date and billing URL. */
const CODEX_USAGE_LIMIT_RE = /hit your usage limit|usage limit reached|purchase more credits/i;

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

/** Central on purpose: a new classification must not fall through to the host's cross-provider fallback. */
export function isCodexOAuthRotationEligible(classification: string | undefined): boolean {
  return (
    classification === 'quota' ||
    classification === 'overloaded' ||
    classification === 'system_error' ||
    classification === 'auth_invalidated'
  );
}

/**
 * A child agent's quota failure reaches the parent only as injected prose, where CODEX_USAGE_LIMIT_RE alone would
 * fire on an agent merely writing those words. Detection therefore requires this framing (line-start, since versions
 * may prefix a nickname), the turn-failed sentence and the quota phrase together. Literals are verbatim from 0.151.0.
 * Accepted residual: prose reproducing the whole framed error at a line start still rotates a healthy turn.
 */
export const CODEX_CHILD_AGENT_ERROR_FRAMING_RE = /^[\s>*_`[\]()-]*Agent errored:/m;

/** Case-insensitive, flexible whitespace, either apostrophe: transport re-wrapping must not break detection. */
export const CODEX_CHILD_AGENT_TURN_FAILED_RE =
  /This\s+agent['’]s\s+turn\s+failed\.\s+If\s+you\s+still\s+need\s+this\s+agent,\s+use\s+the\s+available\s+collaboration\s+tools\s+to\s+give\s+it\s+another\s+task\./i;

/** Scans multi_agent_v2 conversation text and v1 tool-result fields; depth-capped so a cyclic payload cannot spin. */
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
 * Otherwise the parent never learns: upstream leaves its turn running and unmarked when a child errors. Never throws.
 */
export function detectCodexChildAgentQuotaFailure(item: unknown): string | null {
  try {
    if (!item || typeof item !== 'object') return null;
    const text = extractCodexThreadItemText(item);
    if (!text) return null;
    // All three must hold; any two would be an unsafe matcher.
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

/** A resumed thread already holds the request, so it gets only the recovery prompt; a fresh one needs the original. */
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

/** Depth-capped at year/month/day so a corrupted sessions tree cannot lock the search; returns the first match. */
export function findRolloutFile(threadId: string, codexHome: string): string | null {
  for (const rollout of rolloutFilesFor(threadId, codexHome)) return rollout.path;
  return null;
}

function* rolloutFilesFor(threadId: string, codexHome: string): Generator<{ path: string; stat: fs.Stats }> {
  const sessionsRoot = path.join(codexHome, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return;
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
      if (entry.toLowerCase().includes(needle)) yield { path: full, stat };
    }
  }
}

/**
 * Mirrors the date subpath under the target's sessions/. Copying mid-turn misses the failed attempt's later
 * records, which is fine: rotation replays that attempt on the new server.
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

/** agents/ is mounted only at the primary home; the copy is an exact snapshot so retired roles do not survive. */
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
 * After a rotation the fallback holds newer history than the primary, and a respawn starts on the primary: resuming
 * there and rotating again would overwrite the newer rollout. Ordered by (mtimeMs DESC, size DESC); size breaks the
 * near-tie a rotation copy leaves.
 */
export interface RolloutCandidate {
  home: string;
  path: string;
  mtimeMs: number;
  size: number;
}

export function findNewestRolloutAcrossHomes(threadId: string, codexHomes: readonly string[]): RolloutCandidate | null {
  let best: RolloutCandidate | null = null;
  for (const home of codexHomes) {
    for (const { path: full, stat } of rolloutFilesFor(threadId, home)) {
      if (best === null || stat.mtimeMs > best.mtimeMs || (stat.mtimeMs === best.mtimeMs && stat.size > best.size)) {
        best = { home, path: full, mtimeMs: stat.mtimeMs, size: stat.size };
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
   * Walked as a ring with the primary. `process.env.CODEX_HOME` is the active home, so a container stays on the last
   * account that worked.
   */
  readonly fallbackHomes: readonly string[];
  private readonly primaryCodexHome: string;
  /** The host's start hint, consumed by the first query; later queries keep whatever home the last one left. */
  private pendingStartHome: string | null;
  private readonly primaryHostCodexHome: string | undefined;

  constructor(options: ProviderOptions = {}) {
    // The stdio bridge for HTTP servers is an explicit compatibility fallback only; SSE is rejected.
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
          // The full header map, not just Authorization: the bridge must carry every header the approval validated.
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

    // Under a spawn-time provider fallback the runner empties `providerConfig` (it describes the primary), so the
    // fallback's model/effort arrive on `options` and are folded in here. `=== undefined` keeps this a no-op on the
    // primary path; values are validated first because the strict schema would otherwise throw at boot.
    const rawSticky: Record<string, unknown> = { ...(options.providerConfig ?? {}) };
    // A family alias (`sol`) anywhere in the chain resolves here, before the
    // strict schema and the `gpt-*` guard see it.
    if (typeof rawSticky.model === 'string') {
      rawSticky.model = resolveCodexFamily(rawSticky.model);
      // Unresolved only when an older host sent no alias map; never hand the app-server a bare family word.
      if (isCodexFamilyName(rawSticky.model as string)) {
        console.error(`[codex-provider] Ignoring unresolved Codex family alias "${rawSticky.model}"`);
        delete rawSticky.model;
      }
    }
    if (rawSticky.model === undefined && options.model !== undefined) {
      const model = resolveCodexFamily(options.model);
      if (CODEX_MODEL_RE.test(model)) rawSticky.model = model;
      else console.error(`[codex-provider] Ignoring non-codex config model "${options.model}"`);
    }
    if (rawSticky.reasoning_effort === undefined && options.effort !== undefined) {
      if (CODEX_EFFORT_VALUES.has(options.effort)) rawSticky.reasoning_effort = options.effort;
      else console.error(`[codex-provider] Ignoring non-codex config effort "${options.effort}"`);
    }
    this.stickyConfig = codexConfigSchema.parse(rawSticky);

    const envDefault = options.env?.CODEX_MODEL as string | undefined;
    const hostDefault = envDefault ? resolveCodexFamily(envDefault) : undefined;
    this.model =
      this.stickyConfig.model ??
      (hostDefault && !isCodexFamilyName(hostDefault) ? hostDefault : undefined) ??
      DEFAULT_CODEX_MODEL;

    // Read from process.env: options.env is filtered for SDK consumption and would drop it.
    const fallbackEnv = process.env.CODEX_FALLBACK_HOMES ?? '';
    this.fallbackHomes = Object.freeze(
      fallbackEnv
        .split(':')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    this.primaryCodexHome = resolveCodexConfigDir();
    this.primaryHostCodexHome = process.env.CODEX_PRIMARY_HOST_HOME;
    const startHome = process.env.CODEX_START_HOME;
    this.pendingStartHome = startHome && this.fallbackHomes.includes(startHome) ? startHome : null;
    if (this.fallbackHomes.length > 0) {
      console.error(
        `[codex-provider] Loaded ${this.fallbackHomes.length} Codex OAuth fallback(s): ${this.fallbackHomes.join(', ')}`,
      );
    }
  }

  get codexHomeRing(): readonly string[] {
    return [this.primaryCodexHome, ...this.fallbackHomes];
  }

  /**
   * Circular, skipping every home in `tried` (per turn), so a recovered primary is retried; null once all were tried.
   * Nothing persists here: `process.env.CODEX_HOME` carries the active home, and a respawn starts on the primary
   * unless the host names another home in `CODEX_START_HOME`.
   */
  rotateCodexHome(current: string, tried: ReadonlySet<string>): string | null {
    const ring = this.codexHomeRing;
    const start = Math.max(0, ring.indexOf(current));
    for (let step = 1; step <= ring.length; step++) {
      const candidate = ring[(start + step) % ring.length];
      if (!tried.has(candidate)) return candidate;
    }
    return null;
  }

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_THREAD_RE.test(msg);
  }

  /**
   * Matches both the structured event-path kind and the query path's thrown sentence; a miss only costs a visible
   * error.
   */
  isQuotaExhausted(err: unknown): boolean {
    // A ProviderEventError classified `quota` (including the pre-turn park) is a spent account whatever its wording.
    if (err && typeof err === 'object' && (err as { classification?: unknown }).classification === 'quota') {
      return true;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return CODEX_USAGE_LIMIT_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('Codex memory session hook was not registered');
    const pending: string[] = [];
    // A rejected steer falls back to `pending` asynchronously, possibly after `hasQueuedWork` was sampled; counting
    // in-flight steers (bounded at 60s, decremented only after queuing) keeps that signal true across the gap.
    let steersInFlight = 0;
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const kick = (): void => {
      waiting?.();
    };

    const turnTracker: { server: AppServer | null; threadId: string | null; currentTurnId: string | null } = {
      server: null,
      threadId: null,
      currentTurnId: null,
    };

    pending.push(input.prompt);

    const self = this;

    const effectiveModel = resolveQueryModel(input.model, this.model);
    const effectiveConfig = resolveQueryEffort(input.effort, this.stickyConfig);
    const effectiveFast = input.fast === true;
    const runtimeInstructions = appendActiveRuntimeContext(input.systemContext?.instructions, {
      provider: 'codex',
      model: effectiveModel,
      effort: effectiveConfig.reasoning_effort,
    });
    // `requested` is the raw `-e` before validation, so an ignored out-of-vocabulary effort shows as a divergence.
    const turnEffort = {
      model: effectiveModel,
      effective: effectiveConfig.reasoning_effort,
      requested: input.effort ?? this.stickyConfig.reasoning_effort,
    };

    async function* gen(): AsyncGenerator<ProviderEvent> {
      if (self.pendingStartHome) {
        console.error(
          `[codex-provider] Starting on ${self.pendingStartHome}: the host marked earlier accounts at quota`,
        );
        process.env.CODEX_HOME = self.pendingStartHome;
        mirrorCodexAgentsToHome(self.primaryCodexHome, self.pendingStartHome);
        self.pendingStartHome = null;
      }
      writeCodexMcpConfigToml(self.mcpServers);
      writeCodexHooksAndTrust();
      const startAppServer = async (): Promise<AppServer> => {
        try {
          return await startCodexAppServer(
            createCodexConfigOverrides(effectiveConfig, effectiveFast),
            (spawned) => {
              turnTracker.server = spawned;
              attachCodexAutoApproval(spawned);
            },
            positiveEnvMs('CODEX_INIT_TIMEOUT_MS', CODEX_INIT_TIMEOUT_MS),
          );
        } catch (err) {
          turnTracker.server = null;
          throw err;
        }
      };
      let server = await startAppServer();
      const rateLimits = new CodexRateLimitTracker();

      let threadId: string | undefined = input.continuation;
      let initYielded = false;

      // The rotation routine copies the rollout from the home it is rotating away from.
      let currentCodexHome = resolveCodexConfigDir();
      let primaryAuthRefreshAttempted = false;

      try {
        // Fail closed on a guard chain that loaded but would never fire, on every spawn.
        await verifyCodexHookTrust(server, currentCodexHome);
        await rateLimits.bind(server, currentCodexHome);

        // Base instructions survive Codex's native compaction, so the static memory guidance rides there.
        const memoryContext = memoryContextForSessionStart('startup');
        const lifecycleInstructions = [runtimeInstructions, memoryContext].filter(Boolean).join('\n\n');
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

        // A fresh container may start on a different home than the one holding the thread's newest history;
        // resuming the stale rollout and rotating again would overwrite it.
        if (threadId && self.fallbackHomes.length > 0) {
          const candidate = findNewestRolloutAcrossHomes(threadId, self.codexHomeRing);
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
          // One `text` may take several attempts (recoveries, rotations), all billed to this turn, so the accumulator
          // is created here once and never replaced; a fresh thread resets only its dedupe state.
          const turnAccum = createCodexTurnAccumulator();
          // Per turn, not per query (later turns are pushed into the same query): each account is tried at most once
          // per turn, which keeps the rotation loop finite.
          const triedHomes = new Set<string>([currentCodexHome]);
          // Read only once the ring is exhausted; null when an account stated no reset.
          const slotResets: Array<string | null> = [];

          // Each recovery branch has its own cap; a shared counter could exhaust before a capped branch surfaces its
          // error, silently ending the user's turn.
          const restartAppServer = async (nextHome?: string): Promise<void> => {
            // The app-server reads CODEX_HOME from process.env at spawn.
            turnTracker.server = null;
            turnTracker.threadId = null;
            turnTracker.currentTurnId = null;
            killCodexAppServer(server);
            if (nextHome) {
              process.env.CODEX_HOME = nextHome;
              currentCodexHome = nextHome;
            }

            // A new home needs config, the guard hooks (or the rotated server runs unguarded) and the agents/ roles,
            // which are mounted only at the primary.
            writeCodexMcpConfigToml(self.mcpServers);
            writeCodexHooksAndTrust();
            if (nextHome) mirrorCodexAgentsToHome(self.primaryCodexHome, nextHome);

            server = await startAppServer();
            // The guard chain must be proven live in the (possibly new) home.
            await verifyCodexHookTrust(server, currentCodexHome);
            await rateLimits.bind(server, currentCodexHome);

            // A fresh thread gets a new id: re-emit init so the poll-loop updates its continuation.
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
          };

          let rotateAndRetry = true;
          while (rotateAndRetry) {
            rotateAndRetry = false;

            // A pre-turn park replaces the turn with a synthetic `quota` error so the branches below rotate to a
            // fallback or surface it for the host to park. A failed rate-limit read leaves the snapshot empty and
            // never parks.
            await rateLimits.refreshIfStale();
            const preTurnPark = rateLimits.parkDecision();
            if (preTurnPark) console.error(`[codex-provider] pre-turn park: ${preTurnPark.message}`);
            const turnEvents: AsyncIterable<ProviderEvent> = preTurnPark
              ? parkedTurnEvents(preTurnPark)
              : runOneTurn(
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
                );
            for await (const ev of turnEvents) {
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

                  // An unresponsive server already failed its probes, so only a desynced one gets an interrupt first.
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

                  await restartAppServer();
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

                  await restartAppServer();
                  rotateAndRetry = true;
                  break;
                }
                if (eligible) slotResets.push(ev.resetAt ?? null);
                const nextHome = eligible ? self.rotateCodexHome(currentCodexHome, triedHomes) : null;
                if (nextHome) {
                  triedHomes.add(nextHome);
                  const position = self.codexHomeRing.indexOf(nextHome) + 1;
                  const ringSize = self.codexHomeRing.length;
                  // Best-effort: without the rollout the new server starts a fresh thread and history is lost.
                  let rolloutCopied = false;
                  if (threadId) {
                    const src = findRolloutFile(threadId, currentCodexHome);
                    if (src) {
                      const dst = copyRolloutToFallback(src, currentCodexHome, nextHome);
                      rolloutCopied = dst !== null;
                    }
                  }

                  if (ev.classification === 'quota') yield { type: 'codex_account_exhausted', home: currentCodexHome };
                  yield {
                    type: 'progress',
                    message: formatBlockquoteLabel(
                      '↻',
                      `Codex OAuth rotating (${ev.classification}) → account ${position}/${ringSize}` +
                        (rolloutCopied ? ' (history preserved)' : ' (history reset)'),
                    ),
                  };

                  await restartAppServer(nextHome);
                  // Only this branch means the prior credential hit its limit: tell the thread, so it does not read
                  // its own earlier "rate limited" narrative as describing this attempt.
                  attemptText += '\n\n' + formatCredentialRotationNotice({ position, ringSize });

                  rotateAndRetry = true;
                  break;
                }
                // Ring exhausted: report the earliest stated reset, so the provider returns with its first account.
                // Gated on `eligible`: an ineligible error after a rotation has not tried the rest of the ring.
                if (eligible && triedHomes.size > 1) {
                  yield {
                    ...ev,
                    resetAt: earliestCodexSlotReset(slotResets),
                    message: `${ev.message} — all ${triedHomes.size} Codex accounts tried this turn`,
                  };
                } else {
                  yield ev;
                }
                return;
              }
              // Stamped here because this is where the resolved effort config lives.
              yield ev.type === 'result'
                ? { ...ev, usage: attachTurnEffort(ev.usage, turnEffort), rateLimit: rateLimits.turnRateLimit() }
                : ev;
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
      resolvedModel: effectiveModel,
      // The effort the app-server was configured with, not the requested `-e`.
      resolvedEffort: effectiveConfig.reasoning_effort ?? null,
      push: (message: string) => {
        // Steer an in-flight turn; queue on RPC error (the turn may have just ended) or missing handles.
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
      // A fallback queues a separate future turn and an unsettled steer's rejection queues asynchronously, so both
      // count, or the poll-loop publishes idle in the gap.
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

// Owned by the caller: one logical turn spans several runOneTurn attempts.
export type CodexTurnAccumulator = {
  seen: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  // On the same struct as the tokens so the two cannot be reset separately.
  steps: number;
  // A resumed app-server can re-emit item/completed for items already counted, inflating the output_per_step
  // denominator.
  countedItemIds: Set<string>;
  // Duplicate-emission guard; see the `thread/tokenUsage/updated` handler.
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
 * A fresh-thread retry keeps the billed totals (the failed attempt's tokens were real spend) and resets both dedupe
 * guards, which key on values the new thread re-issues. Same-thread recovery resets neither: a resumed app-server
 * can replay records already counted.
 */
export function resetCodexTurnAccumulatorThread(accum: CodexTurnAccumulator): void {
  accum.countedItemIds.clear();
  accum.lastUsageKey = null;
}

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
  // `errorKind` is Codex's structured `codexErrorInfo.type`, which decides rotation eligibility.
  const turnState: { error: Error | null; errorKind: string | null } = { error: null, errorKind: null };
  let resultText = '';
  let turnDone = false;
  // Kept out of `turnState` until the turn ends: completeTurn and finishForLivenessFailure overwrite
  // `turnState.error`, and this is the failure the rotation path must see.
  let childAgentQuotaError: string | null = null;
  // Usage sums per-request `last` from `thread/tokenUsage/updated`, never `total`: the thread is persisted, so a
  // respawned app-server replays a carried-forward `total` and the prior history would book as one turn. `seen`
  // keeps a genuine all-zero turn distinct from an unreported one. No cost field exists (plan billing), so cost_usd
  // stays NULL; `item/completed` count is the closest proxy for round trips.
  //
  // Reasoning arrives as streamed deltas or as completed items; streamed ids are tracked so items do not duplicate.
  let reasoningBuffer = '';
  const reasoningItemsWithDeltas = new Set<string>();
  const emittedReasoningItemIds = new Set<string>();
  const emittedImageKeys = new Set<string>();
  const emittedCollaborationItemIds = new Set<string>();

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

  // Read the roster as soon as a child appears, not at turn end: with outcome reporting the reply goes out mid-turn,
  // stamped from the snapshot at that moment. Reads coalesce and are never awaited on the stream path.
  const subagentThreadIds = new Set<string>();
  let rosterRead: Promise<void> | null = null;
  let rosterReadAgain = false;
  // A read still in flight after an error-path end must not write into the next turn's roster; not awaited in
  // `finally` because against a dead server that adds a full request timeout.
  let rosterTurnOver = false;
  const enrichRoster = (): void => {
    if (rosterRead) {
      rosterReadAgain = true;
      return;
    }
    rosterRead = (async () => {
      do {
        rosterReadAgain = false;
        const threads = await readCodexSubagentThreads(server, threadId, CODEX_HEALTH_PROBE_TIMEOUT_MS);
        if (rosterTurnOver) return;
        for (const thread of threads) {
          if (subagentThreadIds.has(thread.id)) {
            recordSubagent(thread.id, { model: thread.model, effort: thread.effort });
          }
        }
      } while (rosterReadAgain && !rosterTurnOver);
    })().finally(() => {
      rosterRead = null;
    });
  };
  const emitCollaborationProgress = (item: unknown): void => {
    const message = formatCodexCollaborationProgress(item, emittedCollaborationItemIds);
    if (message) buffer.push({ type: 'progress', message });
    if (item && typeof item === 'object') {
      const activity = item as {
        type?: unknown;
        agentThreadId?: unknown;
        agent_thread_id?: unknown;
        agentPath?: unknown;
      };
      if (activity.type === 'subAgentActivity') {
        // camelCase or snake_case depending on the app-server build: read both.
        const id = activity.agentThreadId ?? activity.agent_thread_id;
        if (typeof id === 'string' && id) {
          const firstSighting = !subagentThreadIds.has(id);
          subagentThreadIds.add(id);
          // Record the path now so a turn whose thread list fails still reports that it delegated.
          recordSubagent(id, { type: typeof activity.agentPath === 'string' ? activity.agentPath : null });
          // One read per child, not per activity item: a worker emits many.
          if (firstSighting) enrichRoster();
        }
      }
    }
  };

  const liveness = new CodexTurnLiveness({
    probeFailureLimit: healthConfig.probeFailureLimit,
    inactiveSnapshotLimit: healthConfig.inactiveSnapshotLimit,
  });
  type CompletedThreadItem =
    | ({ id?: unknown; type?: string; text?: string } & ReasoningThreadItem & ImageGenerationThreadItem)
    | undefined;

  /**
   * Upstream does not fail the parent turn when a child errors, so a child quota failure ends the turn here as the
   * parent's own, routing it through the unchanged rotation path. First detection wins.
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
    // Ending the turn is what stops the burn: the rotation path tears the app-server down.
    if (!turnDone) {
      turnDone = true;
      kick();
    }
  };

  // Items may arrive live, only in turn/completed, or both; all bookkeeping lives here so the paths stay equivalent.
  const reduceCompletedThreadItem = (item: CompletedThreadItem): void => {
    liveness.noteItemCompleted(item);

    // Id-less items still count: there is nothing to dedupe on.
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
    // An explicit inProgress in a completed-turn snapshot is kept for liveness recovery.
    if (status === 'inProgress') return false;
    if (isCodexTerminalTurnItem(item)) return true;
    // Statusless agentMessage/reasoning items in a completed turn are terminal output.
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

      // A successful round trip is liveness even with no visible event; the poll-loop turns it into a heartbeat.
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
      // A notification during the probe proves liveness; do not count a raced request timeout.
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

    // turn.items can be omitted under backpressure or marked a non-full `itemsView`; backfill (as `codex exec` does)
    // before concluding an open execution item was abandoned.
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
        // Scanned before the terminality gate: the item carrying a child's failure may not be a terminal item type.
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
      // An explicit terminal state, not evidence of lost lifecycle state.
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
      // Other turns' traffic proves liveness but must never mutate this turn's state.
      liveness.noteNotification();
    } else if (method === 'item/started') {
      liveness.noteItemStarted(params.item);
    } else if (method === 'turn/failed') {
      liveness.noteTurnEnded(params.turn);
    } else {
      liveness.noteNotification();
    }

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
        const usage = (params as { tokenUsage?: Record<string, unknown> }).tokenUsage;
        const last = (params as { tokenUsage?: { last?: CodexTokenUsageBreakdown } }).tokenUsage?.last;

        // Codex re-emits byte-identical usage payloads (measured ~2.9% of input tokens), which summing `last` would
        // double-count. Only a payload carrying the running counter can be judged a repeat; without it the guard
        // stands down rather than drop a real request.
        const usageKey = usage && 'total' in usage ? JSON.stringify(usage) : null;
        const isRepeat = usageKey !== null && usageKey === turnAccum.lastUsageKey;
        turnAccum.lastUsageKey = usageKey;

        // Codex's own occupancy is `last.totalTokens`: `cached_input_tokens` is a SUBSET of input here, so summing
        // them would double-count. Latest-wins, so a repeated payload needs no guard.
        if (last) recordContextTokens(last.totalTokens);

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
        emitCollaborationProgress(params.item);
        // A child's quota failure can already be visible on item/started; catching it here saves a round trip.
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
        // Flush per section so thinking streams rather than arriving as one label at turn end.
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
        // Payload shape varies by version (string or object). `active`/`idle` are dropped: they would overwrite the
        // 💭 thinking labels in the edit-in-place status message.
        const raw = params.status;
        let label: string | null = null;
        if (typeof raw === 'string') {
          label = raw;
        } else if (raw && typeof raw === 'object') {
          const obj = raw as Record<string, unknown>;
          const candidate = obj.label ?? obj.state ?? obj.status ?? obj.kind ?? obj.type ?? obj.message ?? obj.text;
          label = typeof candidate === 'string' ? candidate : JSON.stringify(raw);
        }
        // systemError is thread-fatal and the follow-up turn/completed is unreliable, so end the turn here rather
        // than wait for the host ceiling. It carries no structured detail, so errorKind stays null.
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
        break;
    }

    kick();
  };

  server.notificationHandlers.push(handler);

  // One hour is only the host's fallback if this in-container recovery loop itself stops.
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
    // Yield init before turn/start so the continuation is stored before a mid-turn crash.
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

    // Overrides any other error: the spent credential is the actionable cause, and rotate + replay the right fix.
    if (childAgentQuotaError) {
      turnState.error = new Error(childAgentQuotaError);
      turnState.errorKind = 'UsageLimitExceeded';
    }

    if (turnState.error) {
      // retryable is false: the turn is dead and must re-run through the catch path.
      const classification = classifyCodexError(turnState.error.message, turnState.errorKind);
      yield {
        type: 'error',
        message: turnState.error.message,
        retryable: false,
        ...(classification ? { classification } : {}),
      };
      return;
    }

    // Backstop: re-read once so a child not yet listable at spawn is still enriched; skipped when nothing delegated.
    if (rosterRead) await rosterRead;
    if (subagentThreadIds.size > 0 && threadId) {
      for (const thread of await readCodexSubagentThreads(server, threadId, CODEX_HEALTH_PROBE_TIMEOUT_MS)) {
        if (subagentThreadIds.has(thread.id)) {
          recordSubagent(thread.id, { model: thread.model, effort: thread.effort });
        }
      }
    }

    yield {
      type: 'result',
      text: resultText || null,
      // Already this turn's own usage: not routed through turn-usage.ts's cumulative delta path.
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
    rosterTurnOver = true;
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

/** `resetAt` is a measured reset, which the host honours as the park end instead of clamping to backoff. */
export async function* parkedTurnEvents(park: CodexRateLimitPark): AsyncGenerator<ProviderEvent> {
  yield {
    type: 'error',
    message: park.message,
    retryable: false,
    classification: 'quota',
    resetAt: park.resetsAt,
  };
}

/** Null when any failed account stated no reset: the host's bounded backoff beats another account's date. */
export function earliestCodexSlotReset(resets: ReadonlyArray<string | null>): string | null {
  if (resets.length === 0) return null;
  let earliest: { iso: string; ms: number } | null = null;
  for (const iso of resets) {
    const ms = iso === null ? Number.NaN : Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    if (earliest === null || ms < earliest.ms) earliest = { iso: iso as string, ms };
  }
  return earliest?.iso ?? null;
}

registerProvider('codex', (opts) => new CodexProvider(opts));
