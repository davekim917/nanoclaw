import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import {
  query as sdkQuery,
  type EffortLevel,
  type HookCallback,
  type PostToolUseHookInput,
  type PreCompactHookInput,
  type PreToolUseHookInput,
  type SDKResultError,
  type SDKResultSuccess,
  type SdkPluginConfig,
} from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/container-state.js';
import { loadExcludedPlugins } from '../excluded-plugins.js';
import { isExcludedPluginPath, type ExcludedPlugins } from '../plugin-exclusions.js';
import { recordRateLimitSamples, type AccountIdentity, type RateLimitSample } from '../modules/mailbox/index.js';
import { getCredentialSlot, setCredentialSlot } from '../modules/mailbox/session-state.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import { appendActiveRuntimeContext } from '../runtime-context.js';
import { recordContextTokens, recordServedModel, recordSubagent } from '../turn-status.js';

/**
 * Tokens occupying the context window. Anthropic's three prompt counters are DISJOINT (`input_tokens` is only the
 * uncached remainder), so occupancy is their SUM; in codex.ts cached is a subset of input and must not be added.
 * Returns 0 when nothing is usable, which `recordContextTokens` ignores.
 */
export function claudeContextOccupancy(
  usage:
    | {
        input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      }
    | null
    | undefined,
): number {
  if (!usage) return 0;
  const count = (value: number | null | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
}
import { TIMEZONE, formatLocalStamp } from '../timezone.js';
import { CLAUDE_FAMILY_ALIAS_ENV } from './model-vocabulary.js';
import { shimCwd } from './cwd-shim.js';
import { attachTurnEffort } from './turn-effort.js';
import { formatBlockquoteLabel, thinkingForwardingEnabled, truncate } from './thinking-labels.js';
import { registerProvider, registerProviderConfigSchema } from './provider-registry.js';
import { MCP_HEADER_ONLY_SECRET_VARS } from './secret-env.js';
import {
  QUOTA_EMBEDDED_RE,
  QUOTA_RESULT_RE,
  SUBSCRIPTION_BLOCKED_EMBEDDED_RE,
  SUBSCRIPTION_BLOCKED_RE,
} from './claude-review-classification.js';
export {
  QUOTA_EMBEDDED_RE,
  QUOTA_RESULT_RE,
  SUBSCRIPTION_BLOCKED_EMBEDDED_RE,
  SUBSCRIPTION_BLOCKED_RE,
} from './claude-review-classification.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
  TurnUsageInfo,
} from './types.js';
import { autoCommitDirtyWorktrees } from '../worktree-autosave.js';
import { createManagedGitMaintenanceHook } from '../managed-git-guard.js';
import { transcriptContainsUserText } from './claude-transcript-prompt.js';

export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly EffortLevel[];
type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];
type ExactUnion<Left, Right> = [Exclude<Left, Right>, Exclude<Right, Left>] extends [never, never] ? true : false;
type ClaudeEffortLevelsMatchSdk = ExactUnion<ClaudeEffortLevel, EffortLevel>;
const claudeEffortLevelsMatchSdk: ClaudeEffortLevelsMatchSdk = true;
void claudeEffortLevelsMatchSdk;

export const claudeConfigSchema = z.strictObject({
  model: z.string().min(1).optional(),
  effort: z.enum(CLAUDE_EFFORT_LEVELS).optional(),
});

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

export interface SdkRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  errorCode?: string;
  overageDisabledReason?: string;
  /** SDK-internal: read only through `unifiedWindowsToSamples`, which feature-detects the shape. */
  unifiedWindows?: unknown;
}

/**
 * The SDK reports `resetsAt` in epoch seconds or epoch ms (observed both).
 */
function resetsAtIso(resetsAt: number | undefined): string | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null;
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  return new Date(ms).toISOString();
}

/**
 * Rate-limit events are telemetry unless the SDK explicitly rejects the request.
 */
export function classifyRateLimitEvent(
  info: SdkRateLimitInfo | undefined,
): { message: string; classification: 'rate_limit' | 'quota' } | null {
  if (info?.status !== 'rejected') return null;
  const outOfCredits = info.errorCode === 'credits_required' || info.overageDisabledReason === 'out_of_credits';
  const iso = resetsAtIso(info.resetsAt);
  const detail = iso ? ` (resets ${iso})` : '';
  const window = info.rateLimitType ? ` [${info.rateLimitType}]` : '';
  return {
    message: `${outOfCredits ? 'Out of credits' : 'Rate limit'}${window}${detail}`,
    classification: outOfCredits ? 'quota' : 'rate_limit',
  };
}

/**
 * Plan utilization per window, parsed by the CLI from the rate-limit headers of calls it already makes.
 *
 * Do not reintroduce a `/api/oauth/usage` pull (SDK `get_usage`): ring slots are scoped `user:inference` only, the
 * endpoint needs `user:profile`, and its 403s drain the per-token limiter into a ~1h 429.
 *
 * The field is SDK-internal and can change without notice: anything malformed yields no row, never a throw.
 * `utilization` is a 0-1 fraction that can exceed 1; `resetsAt` is epoch seconds.
 */
export function unifiedWindowsToSamples(windows: unknown, who: AccountIdentity): RateLimitSample[] {
  if (typeof windows !== 'object' || windows === null || Array.isArray(windows)) return [];
  const rows: RateLimitSample[] = [];
  for (const [limitType, window] of Object.entries(windows as Record<string, unknown>)) {
    if (typeof window !== 'object' || window === null) continue;
    const { utilization, resetsAt } = window as { utilization?: unknown; resetsAt?: unknown };
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) continue;
    rows.push({
      source: 'rate_limit_headers',
      ...who,
      subscriptionType: null,
      available: true,
      limitType,
      utilization,
      resetsAt: typeof resetsAt === 'number' ? resetsAtIso(resetsAt) : null,
      status: null,
    });
  }
  return rows;
}

let warnedNoUnifiedWindows = false;

export function _resetUnifiedWindowsWarningForTesting(): void {
  warnedNoUnifiedWindows = false;
}

/** Never throws: an SDK shape change must not fail the turn. */
export function rateLimitEventToSamples(info: SdkRateLimitInfo | undefined, who: AccountIdentity): RateLimitSample[] {
  const rows: RateLimitSample[] = [
    {
      source: 'rate_limit_event',
      ...who,
      subscriptionType: null,
      available: true,
      limitType: info?.rateLimitType ?? null,
      utilization: info?.utilization ?? null,
      resetsAt: resetsAtIso(info?.resetsAt),
      status: info?.status ?? null,
    },
  ];
  let windows: RateLimitSample[] = [];
  try {
    windows = unifiedWindowsToSamples(info?.unifiedWindows, who);
  } catch (err) {
    log(`unifiedWindows unreadable (top-level row only): ${err instanceof Error ? err.message : String(err)}`);
  }
  // Only an OAuth session carries windows (always absent for API-key, Bedrock and Vertex).
  if (windows.length === 0 && who.account !== null && !warnedNoUnifiedWindows) {
    warnedNoUnifiedWindows = true;
    log('rate_limit_event carried no usable unifiedWindows — recording the top-level reading only');
  }
  return rows.concat(windows);
}

/**
 * Operator-declared lane for an OAuth slot, from `CLAUDE_CODE_OAUTH_LANES` (`"1:agentic-primary,3:shared-dev"`).
 * Install policy, so never hardcoded here; null means "undeclared", not "agentic".
 */
export function laneForSlot(declaration: string | undefined, slotName: string | null): string | null {
  if (!declaration || !slotName) return null;
  const slot = slotName === 'CLAUDE_CODE_OAUTH_TOKEN' ? '1' : (OAUTH_FALLBACK_RE.exec(slotName)?.[1] ?? null);
  if (!slot) return null;
  for (const entry of declaration.split(',')) {
    const [n, ...rest] = entry.split(':');
    if (n.trim() === slot && rest.length > 0) return rest.join(':').trim() || null;
  }
  return null;
}

let sdkQueryOverride: typeof sdkQuery | null = null;

/** Test-only. A seam rather than `mock.module`, which Bun cannot undo across files. */
export function _setSdkQueryForTesting(impl?: typeof sdkQuery): void {
  sdkQueryOverride = impl ?? null;
}

const TASK_NOTIFICATION_EMOJI: Record<string, string> = {
  completed: '✅',
  failed: '❌',
  stopped: '⏹',
};

/**
 * The tool is `Agent` on this SDK; `Task` is the old name, kept so an older CLI still classifies. Drop neither.
 */
export const SUBAGENT_TOOL_NAMES = ['Agent', 'Task'] as const;

/**
 * The CLI matches a plain `A|B` list by EXACT name (only other shapes compile as an unanchored regex), so this
 * cannot leak onto `TaskOutput` / `TaskStop` / `TaskCreate`.
 */
export const SUBAGENT_TOOL_MATCHER = SUBAGENT_TOOL_NAMES.join('|');

/**
 * `task_notification` also fires for auto-backgrounded Bash, whose summary is the raw command text: forward only
 * subagent work. An absent tool name is a planned task not tied to one tool, so it is forwarded.
 */
export function shouldForwardTaskNotification(toolName: string | undefined): boolean {
  return toolName === undefined || (SUBAGENT_TOOL_NAMES as readonly string[]).includes(toolName);
}

export function deriveProgressLabels(message: unknown): string[] {
  if (!message || typeof message !== 'object') return [];
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  if (!thinkingForwardingEnabled()) return [];
  const labels: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; thinking?: unknown };
    if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim().length > 0) {
      labels.push(formatBlockquoteLabel('💭', truncate(b.thinking)));
    }
  }
  return labels;
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via `ncl tasks`.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
export const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'DesignSync',
  'ReportFindings',
];

// No `allowedTools`: it means auto-allow, not an include-filter, and bypassPermissions already allows every tool,
// so a list only risked prompts for newly added SDK tools. `disallowedTools` above is the explicit block list.

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
  uuid: ReturnType<typeof randomUUID>;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;
  /** Every uuid stamped here; matching echoes against it ignores ids the CLI mints for its own queued work. */
  readonly stamped = new Set<string>();
  /**
   * Stamped prompts no result has echoed yet. The CLI can answer a turn it started itself while one of these is
   * still queued, so this, not the turn count, says whether work is queued.
   */
  readonly outstanding = new Set<string>();
  /** Outstanding as of the last result: the only ids `settle()` may clear. */
  private settleable = new Set<string>();

  push(text: string): string {
    const uuid = randomUUID();
    this.stamped.add(uuid);
    this.outstanding.add(uuid);
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
      uuid,
    });
    this.waiting?.();
    return uuid;
  }

  answer(echoed: string[]): string[] {
    const answered = [...new Set(echoed)].filter((id) => this.stamped.has(id));
    for (const id of answered) this.outstanding.delete(id);
    this.settleable = new Set(this.outstanding);
    return answered;
  }

  /**
   * The CLI went idle: a prompt outstanding since the last result was consumed with no echo (the CLI never idles
   * between queued turns). The snapshot is taken when the runner READS a result, so a push in that window can be
   * misattributed; excluding it instead would strand a truly unechoed prompt until the ceiling.
   */
  settle(): string[] {
    const settled = [...this.settleable].filter((id) => this.outstanding.has(id));
    for (const id of settled) this.outstanding.delete(id);
    this.settleable.clear();
    return settled;
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * Tool calls in flight, keyed by `tool_use_id`: with PARALLEL tools only identity tells which call finished, and
 * clearing on any PostToolUse erased a still-running Bash's state, collapsing the host's ceiling. The published row
 * is the WIDEST declared timeout in flight, so a short Read inside a long Bash cannot narrow it.
 *
 * A call denied by another PreToolUse hook never reaches PostToolUse and leaks; that only widens the host's
 * patience, and the map resets at query creation and on every `result`.
 */
const toolsInFlight = new Map<
  string,
  { tool: string; declaredTimeoutMs: number | null; startedAt: number; mainThread: boolean }
>();

/**
 * `tool_use_id` of the call the row currently describes: null = row cleared,
 * undefined = unknown (never written, or the last write failed).
 */
let publishedToolUseId: string | null | undefined;

function publishToolInFlight(): void {
  let widestId: string | null = null;
  let widest: { tool: string; declaredTimeoutMs: number | null } | null = null;
  for (const [id, entry] of toolsInFlight) {
    if (widest === null || (entry.declaredTimeoutMs ?? 0) > (widest.declaredTimeoutMs ?? 0)) {
      widest = entry;
      widestId = id;
    }
  }
  // Write only when the DESCRIBED CALL changes: every write stamps `tool_started_at = now`, which the host reads as
  // that tool's start (ceiling follow-up, wake dedupe key, stall display, claim forgiveness). Re-publishing the same
  // long Bash when a parallel call starts would make a wedged tool look fresh and re-key its recovery.
  if (widestId === publishedToolUseId) return;
  try {
    if (widest === null) clearContainerToolInFlight();
    else setContainerToolInFlight(widest.tool, widest.declaredTimeoutMs);
    publishedToolUseId = widestId;
  } catch (err) {
    publishedToolUseId = undefined;
    log(`Tool in-flight: failed to write container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const BACKGROUNDABLE_TOOLS: readonly string[] = ['Bash', ...SUBAGENT_TOOL_NAMES];

/**
 * Main-thread Bash and subagent calls in flight: the calls `Query.backgroundTasks` can detach. A subagent's own calls
 * are left out, because detaching one does not unblock the main thread, which is waiting on the subagent.
 */
export function backgroundableToolsInFlight(): { id: string; tool: string; startedAt: number }[] {
  const calls: { id: string; tool: string; startedAt: number }[] = [];
  for (const [id, entry] of toolsInFlight) {
    if (id && entry.mainThread && BACKGROUNDABLE_TOOLS.includes(entry.tool)) {
      calls.push({ id, tool: entry.tool, startedAt: entry.startedAt });
    }
  }
  return calls;
}

export function resetToolInFlightTracking(): void {
  if (toolsInFlight.size === 0) return;
  toolsInFlight.clear();
  publishToolInFlight();
}

/** The CLI's Bash cap when `BASH_MAX_TIMEOUT_MS` is unset (the Bash tool schema documents "max 600000"). */
const CLAUDE_CODE_DEFAULT_BASH_MAX_TIMEOUT_MS = 600_000;

/**
 * The declared Bash timeout the host may trust, clamped to the cap the CLI enforces: the host widens its ceiling and
 * claim tolerance by the published value unbounded, so an absurd declaration plus a wedged CLI would hold off both
 * kills long after the Bash died. Anything not a positive finite number is null (host defaults).
 */
export function clampDeclaredBashTimeoutMs(declared: unknown): number | null {
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) return null;
  const envCap = Number(process.env.BASH_MAX_TIMEOUT_MS);
  const cap = Number.isFinite(envCap) && envCap > 0 ? envCap : CLAUDE_CODE_DEFAULT_BASH_MAX_TIMEOUT_MS;
  return Math.min(declared, cap);
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 *
 * MUST stay registered in the claude provider's `PreToolUse` table: it is the only writer of `container_state`'s
 * tool fields, and without it the host kills every claude container at the 30-minute ceiling regardless of the
 * declared Bash timeout. Upstream merges have dropped the registration before; the registration test guards it.
 */
export const preToolUseHook: HookCallback = async (input) => {
  const i = input as {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_use_id?: string;
    agent_id?: string;
  };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  // `tool_input.timeout` is in ms.
  const declaredTimeoutMs = toolName === 'Bash' ? clampDeclaredBashTimeoutMs(i.tool_input?.timeout) : null;
  toolsInFlight.set(i.tool_use_id ?? '', {
    tool: toolName,
    declaredTimeoutMs,
    startedAt: Date.now(),
    mainThread: i.agent_id === undefined,
  });
  publishToolInFlight();
  return { continue: true };
};

/**
 * Clears only the call that finished. A missing `tool_use_id` clears everything, so an SDK that stops supplying it
 * degrades to a cleared row rather than a stuck one.
 */
export const postToolUseHook: HookCallback = async (input) => {
  const id = (input as { tool_use_id?: string })?.tool_use_id;
  if (typeof id === 'string' && id.length > 0) toolsInFlight.delete(id);
  else toolsInFlight.clear();
  publishToolInFlight();
  return { continue: true };
};

/**
 * Read a Claude transcript .jsonl, render a markdown summary, and drop it into
 * the agent's `conversations/` folder so context survives a compaction or a
 * session rotation. Best-effort: returns false (and logs) on any failure.
 */
function archiveTranscriptFile(
  transcriptPath: string | undefined,
  sessionId: string | undefined,
  assistantName?: string,
): boolean {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log('No transcript found for archiving');
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);
    if (messages.length === 0) return false;

    // Try to get summary from sessions index
    let summary: string | undefined;
    const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
    if (fs.existsSync(indexPath)) {
      try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        summary = index.entries?.find(
          (e: { sessionId: string; summary?: string }) => e.sessionId === sessionId,
        )?.summary;
      } catch {
        /* ignore */
      }
    }

    const name = summary
      ? summary
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 50)
      : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

    const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });
    // Local calendar date — the fallback `name` above already uses local
    // hours, and the agent navigates conversations/ by these date prefixes.
    const filename = `${formatLocalStamp(new Date(), TIMEZONE).slice(0, 10)}-${name}.md`;
    fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));
    log(`Archived conversation to ${filename}`);
    return true;
  } catch (err) {
    log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;

    // Deliberately non-mutating: topic siblings share HEAD/index, so PreCompact must never stage or commit a
    // sibling's partial work.
    try {
      const autosave = await autoCommitDirtyWorktrees('pre-compact');
      if (autosave.committed.length > 0 || autosave.failed.length > 0) {
        log(
          `autosave (pre-compact): committed=[${autosave.committed.join(',')}] failed=[${autosave.failed.join(',')}]`,
        );
      }
    } catch (err) {
      log(`autosave (pre-compact) threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    archiveTranscriptFile(preCompact.transcript_path, preCompact.session_id, assistantName);
    return {};
  };
}

const ANTHROPIC_FALLBACK_RE = /^ANTHROPIC_API_KEY_(\d+)$/;

const OAUTH_FALLBACK_RE = /^CLAUDE_CODE_OAUTH_TOKEN_(\d+)$/;

// `subscription_quota_exhausted` / `subscription_access_disabled` are our own markers: a quota or access failure
// the SDK returns as result text is re-thrown with them so the rotation+retry path picks it up.
const RETRYABLE_ERROR_RE =
  /429|rate[\s_-]?limit|overloaded|upstream_error|External provider returned|subscription_quota_exhausted|subscription_access_disabled/i;

// The SDK surfaces the thinking-signature 400 as result text, not a thrown error, so isSessionInvalid never fires on
// its own. Re-thrown with the original text so STALE_SESSION_RE matches and the continuation is cleared.
export const POISONED_CONTINUATION_RE = /invalid `?signature`? in `?thinking`? block/i;

// After the CLI exhausts its own retries, a 429/529 renders as the turn's RESULT TEXT; uncaught, it is delivered as
// the agent's answer. It is re-thrown as `transient_overload:` so poll-loop retries the same prompt with backoff.
// Never rotate on it: "not your usage limit" means the credential is fine and the server is busy.
// Anchored on the rendered "API Error:" prefix so an agent quoting the words in prose can't trip it; the embedded
// twin serves subagent errors wrapped in the CLI's termination template. One body for both, since drift that
// misreads an overload as quota burns a credential slot.
const TRANSIENT_OVERLOAD_PATTERN_BODY =
  'API Error:\\s*(?:Server is temporarily limiting requests|Request rejected \\(429\\))';

export const TRANSIENT_OVERLOAD_RESULT_RE = new RegExp(`^${TRANSIENT_OVERLOAD_PATTERN_BODY}`, 'i');

export const TRANSIENT_OVERLOAD_EMBEDDED_RE = new RegExp(TRANSIENT_OVERLOAD_PATTERN_BODY, 'i');

/**
 * What the parent sees in place of a quota-exhausted subagent's output. It must NOT match QUOTA_EMBEDDED_RE /
 * SUBSCRIPTION_BLOCKED_EMBEDDED_RE (a re-match makes every replayed turn look exhausted again), and must not repeat
 * the SDK's "ask your admin to raise it" remediation, which the parent would relay to the user.
 */
export const SUBAGENT_QUOTA_REPLACEMENT_TEXT =
  '[nanoclaw] The subagent was aborted before it produced any result: the credential slot ' +
  'it was running on stopped serving requests. The parent turn is being aborted and replayed ' +
  'automatically on the next credential slot. This is infrastructure, not a task outcome — do ' +
  'not report it as a finding, do not act on anything the subagent returned, and do not ask ' +
  'anyone to change an account, billing, or plan setting.';

/**
 * Flattens an untyped PostToolUse `tool_response` for the quota regexes. Never throws; depth-capped so a cyclic
 * structure can't spin.
 */
function stringifyToolResponse(response: unknown, depth = 0): string {
  if (response == null || depth > 4) return '';
  if (typeof response === 'string') return response;
  if (typeof response === 'number' || typeof response === 'boolean') return String(response);
  if (Array.isArray(response)) return response.map((entry) => stringifyToolResponse(entry, depth + 1)).join('\n');
  if (typeof response === 'object') {
    const o = response as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof o.text === 'string') parts.push(o.text);
    if (o.content !== undefined) parts.push(stringifyToolResponse(o.content, depth + 1));
    if (parts.length > 0) return parts.join('\n');
    try {
      return JSON.stringify(response) ?? '';
    } catch {
      return '';
    }
  }
  return '';
}

// Tier 2: tier 1 matches PROSE, and new Anthropic wordings have repeatedly slipped past it and silently killed
// rotation. Tier 2 keys off the CLI's wrapper around EVERY subagent API death (verified against claude 2.1.259):
//   Agent "<desc>" failed: Agent terminated early due to an API error: <prose>
//   (error type rate_limit, HTTP 429, request id req_…, model sent to the API: …)
// `error type rate_limit, HTTP 429` alone is NOT sufficient: a transient server overload renders the same, so the
// transient exclusion in classifySubagentQuotaText is load-bearing.

export const AGENT_API_ERROR_TERMINATION_RE = /Agent terminated early due to an API error/i;

/**
 * Whitespace is flexible because the field list's `join(', ')` spacing is not a contract.
 */
export const AGENT_API_RATE_LIMIT_SUFFIX_RE = /\(\s*error\s+type\s+rate_limit\s*,\s*HTTP\s+429\b/i;

export type SubagentQuotaMarker = 'subscription_quota_exhausted' | 'subscription_access_disabled';

/**
 * The one classifier both subagent surfaces run (a sync tool_response and an async task_notification summary):
 * two hand-maintained copies would drift silently.
 */
export function classifySubagentQuotaText(text: string): SubagentQuotaMarker | null {
  if (!text) return null;
  // Tier 1 first: only it can tell an org access block from quota exhaustion.
  if (QUOTA_EMBEDDED_RE.test(text)) return 'subscription_quota_exhausted';
  if (SUBSCRIPTION_BLOCKED_EMBEDDED_RE.test(text)) return 'subscription_access_disabled';
  // Excluding the transient-overload forms keeps tier 2 from rotating away from a merely busy server.
  if (
    AGENT_API_ERROR_TERMINATION_RE.test(text) &&
    AGENT_API_RATE_LIMIT_SUFFIX_RE.test(text) &&
    !TRANSIENT_OVERLOAD_EMBEDDED_RE.test(text)
  ) {
    return 'subscription_quota_exhausted';
  }
  return null;
}

function quotaSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Returns the `<marker>: <snippet>` throw message when an ASYNC subagent died on quota, else null.
 *
 * The async twin of createSubagentQuotaHook: an async launch's tool_result is just "Async agent launched…", and the
 * CLI folds the later failure notification back in as a user message that auto-continues the turn, so without this
 * the parent runs on with a dead subagent and never rotates. `status === 'failed'` is strict: a completed or stopped
 * subagent whose summary merely QUOTES the quota string is a report, not an outage.
 */
export function subagentQuotaFromTaskNotification(
  tn: { summary?: string; status?: string },
  toolName: string | undefined,
): string | null {
  if (tn.status !== 'failed') return null;
  if (!shouldForwardTaskNotification(toolName)) return null;
  const summary = typeof tn.summary === 'string' ? tn.summary : '';
  const marker = classifySubagentQuotaText(summary);
  if (!marker) return null;
  return `${marker}: ${quotaSnippet(summary)}`;
}

/**
 * PostToolUse on the subagent tools: a subagent's quota failure returns as a tool_result inside the parent's running
 * turn, never a top-level result, so the parent would read "…ask your admin to raise it…" as an instruction.
 * The credential is fixed for the query's life, so recovery means interrupting the query and letting poll-loop's
 * rotation replay the turn. The output rewrite covers an interrupt that races the next model request.
 */
export function createSubagentQuotaHook(options: {
  /** Called once per detection with the full `<marker>: <text>` throw message. */
  onDetect: (markedMessage: string) => void;
  interrupt: () => Promise<unknown>;
}): HookCallback {
  return async (input) => {
    try {
      const i = input as PostToolUseHookInput;
      const text = stringifyToolResponse(i.tool_response);
      if (!text) return { continue: true };

      const marker = classifySubagentQuotaText(text);
      // No match: return NO rewrite. An identity rewrite races sibling PostToolUse hooks last-write-wins and could
      // clobber a real redaction.
      if (!marker) return { continue: true };

      const snippet = quotaSnippet(text);
      log(`Subagent hit ${marker} — interrupting turn so poll-loop can rotate: ${snippet}`);
      options.onDetect(`${marker}: ${snippet}`);

      try {
        void options.interrupt()?.catch?.((err: unknown) => {
          log(`Subagent quota interrupt failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      } catch (err) {
        log(`Subagent quota interrupt threw: ${err instanceof Error ? err.message : String(err)}`);
      }

      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedToolOutput: SUBAGENT_QUOTA_REPLACEMENT_TEXT,
        },
      };
    } catch (err) {
      log(`Subagent quota hook failed: ${err instanceof Error ? err.message : String(err)}`);
      return { continue: true };
    }
  };
}

// Every CLAUDE Bash command gets /dev/null on stdin: the Claude Code Bash tool's fd 0 is a unix socket never
// written or closed, so any program reading stdin (`codex exec`, `snow sql` with an empty `--query`) blocks forever.
// Unconditional, because detecting such programs kept missing cases.
// `exec </dev/null` is a PREFIX with no closing token, so a heredoc without terminator or a trailing `\` cannot
// swallow it (a brace group broke both). Per-command redirects still override it, and it runs in the same shell,
// so `cd`/`export` persist; the harness passes the command in argv, so closing fd 0 cannot cut the harness off.
const STDIN_PREFIX = 'exec </dev/null\n';

export function wrapDevNullStdin(command: string): string {
  return command.startsWith(STDIN_PREFIX) ? command : `${STDIN_PREFIX}${command}`;
}

// Two concurrent jest runs OOM-kill the container however each is configured (worker sizing bounds one run, not a
// sibling). `flock -n` refuses rather than queues: a waiting suite would die at the idle ceiling anyway.
// OOM-killed workers surface as ordinary test failures, so the oom_kill delta is reported to mark results void.
const JEST_RE = /(?:^|[\s;&|(])(?:npx\s+)?jest\b|\bnpm\s+(?:run\s+)?test\b|\byarn\s+(?:run\s+)?test\b/;
const ALREADY_FLOCKED_RE = /\bflock\b/;
const JEST_LOCK = '/tmp/.nanoclaw-jest.lock';

export function wrapJestSerialized(command: string): string {
  // Without cgroup v2's counter the reads are empty and the delta is skipped.
  const oomRead = `$(awk '/^oom_kill /{print $2}' /sys/fs/cgroup/memory.events 2>/dev/null)`;
  return [
    `__nc_oom0=${oomRead};`,
    `flock -n -E 126 ${JEST_LOCK} bash -c ${JSON.stringify(command)};`,
    '__nc_rc=$?;',
    `__nc_oom1=${oomRead};`,
    // `-E 126`: flock's default conflict exit (1) is also jest's ordinary failure code.
    'if [ "$__nc_rc" = 126 ]; then',
    '  echo "REFUSED: another jest run holds this container\'s test lock. Two concurrent suites OOM-kill the container regardless of worker settings. Wait for it, or kill it, then retry." >&2;',
    'fi;',
    'if [ -n "$__nc_oom0" ] && [ -n "$__nc_oom1" ] && [ "$__nc_oom1" -gt "$__nc_oom0" ]; then',
    '  echo "WARNING: $((__nc_oom1 - __nc_oom0)) worker(s) were OOM-killed during this run — treat the results as VOID, not as test failures. Run a narrower suite." >&2;',
    'fi;',
    'exit $__nc_rc',
  ].join(' ');
}

/**
 * Rewrites a Bash command before it runs: the jest serialization lock, and only with `closeStdin` the /dev/null
 * stdin prefix.
 *
 * INVARIANT: the stdin prefix is a transport detail no guard may ever see (the email gate fails closed on `<` and
 * newlines). On the Claude SDK this hook, with `closeStdin`, must be the ONLY Bash PreToolUse hook returning
 * `updatedInput`: the tier's hooks run concurrently on the same input and the last `updatedInput` to complete wins,
 * so a second emitter would race it. Codex (runPreToolUseChain) runs it without `closeStdin`, first, and applies no
 * prefix at all; that asymmetry is deliberate.
 */
export function createBashCommandRewriteHook(opts: { closeStdin?: boolean } = {}): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};

    let rewritten = command;
    if (JEST_RE.test(command) && !ALREADY_FLOCKED_RE.test(command)) {
      rewritten = wrapJestSerialized(rewritten);
    }
    // The prefix goes outermost so jest's inner `bash -c` inherits /dev/null too.
    if (opts.closeStdin) rewritten = wrapDevNullStdin(rewritten);
    if (rewritten === command) return {};

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(pre.tool_input as Record<string, unknown>),
          command: rewritten,
        },
      },
    };
  };
}

export const TASK_LIST_TOOL_NAME = 'mcp__nanoclaw__update_task_list';

/**
 * A subagent shares the nanoclaw MCP server and could rewrite its parent's live task list. The SDK sets `agent_id`
 * only on hook calls made inside a subagent, never on the main thread, even under `--agent`.
 */
export function createSubagentTaskListDenyHook(): HookCallback {
  return async (input) => {
    const agentId = (input as { agent_id?: unknown }).agent_id;
    if (typeof agentId !== 'string' || agentId.length === 0) return { continue: true };
    const reason =
      'The live task list belongs to the main agent. Do not call update_task_list from a subagent; report your progress and results in your final response instead.';
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: reason,
      },
    };
  };
}

function denyBash(reason: string) {
  return {
    systemMessage: reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

// The advisory bash guards delegate to pure evaluators in the shared guard core. The inline regexes are a
// fail-CLOSED fallback for when the mount is absent, and must reproduce the core's verdict.
type CommandEvaluator = (command: string) => { action: 'allow' | 'block'; reason?: string };

// Resolved per call so a test's override is seen even after an earlier default-path miss was cached.
const DEFAULT_GUARD_CORE_PATH =
  '/workspace/plugins/bootstrap/plugins/workflow-agents/hooks/guards/block-destructive-core.ts';
function guardCorePath(): string {
  return process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE || DEFAULT_GUARD_CORE_PATH;
}

// Keyed by path so an override swap re-imports. undefined = not yet attempted, null = unavailable.
const _coreEvaluators: Record<string, CommandEvaluator | null | undefined> = {};

/**
 * Returns null (memoized) when the core can't be imported or the export isn't a function; callers MUST then fall
 * back to their inline fail-closed policy.
 */
async function loadCoreEvaluator(exportName: string): Promise<CommandEvaluator | null> {
  const corePath = guardCorePath();
  const key = `${corePath}::${exportName}`;
  if (_coreEvaluators[key] !== undefined) return _coreEvaluators[key]!;
  try {
    const core = (await import(corePath)) as Record<string, unknown>;
    const fn = core[exportName];
    _coreEvaluators[key] = typeof fn === 'function' ? (fn as CommandEvaluator) : null;
  } catch {
    _coreEvaluators[key] = null;
  }
  return _coreEvaluators[key]!;
}

// Blocks the agent from approving its own destructive op by writing `.claude-destructive-gate` via Bash: approval
// must come from the user through the chat channel.
const SELF_APPROVAL_RE = /\.claude-destructive-gate/;
const SELF_APPROVAL_BLOCK_MSG =
  'Self-approval of destructive operation gates is not allowed. Approval must come from the user via the chat channel, not by writing .claude-destructive-gate yourself.';

export function createSelfApprovalBlockHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};

    const evaluator = await loadCoreEvaluator('evaluateSelfApproval');
    if (evaluator) {
      try {
        const verdict = evaluator(command);
        // Fail-closed: anything that isn't an explicit `allow` is a block.
        if (verdict?.action !== 'allow') return denyBash(verdict?.reason ?? SELF_APPROVAL_BLOCK_MSG);
        return {};
      } catch {
        // evaluator threw — fall through to the inline fallback.
      }
    }

    if (SELF_APPROVAL_RE.test(command)) return denyBash(SELF_APPROVAL_BLOCK_MSG);
    return {};
  };
}

// ADVISORY, not a security boundary: `snow` is gated by destructive-operation controls and the Python connector
// bypasses them, so direct python use of it is blocked. Base64, heredocs or script files still evade the regex.
const SNOWFLAKE_CONNECTOR_EXEC_RE = /\bpython[23]?\b.*\bsnowflake[._]connector\b/i;
const SNOWFLAKE_CONNECTOR_BLOCK_MSG =
  "Direct use of Python snowflake.connector is blocked. Use `snow sql` for ad-hoc queries. If `snow` isn't working, report the error rather than falling back to the Python connector.";

export function createBlockSnowflakeConnectorHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};

    const evaluator = await loadCoreEvaluator('evaluateSnowflakeConnector');
    if (evaluator) {
      try {
        const verdict = evaluator(command);
        // Fail-closed: anything that isn't an explicit `allow` is a block.
        if (verdict?.action !== 'allow') return denyBash(verdict?.reason ?? SNOWFLAKE_CONNECTOR_BLOCK_MSG);
        return {};
      } catch {
        // evaluator threw — fall through to the inline fallback.
      }
    }

    if (SNOWFLAKE_CONNECTOR_EXEC_RE.test(command)) return denyBash(SNOWFLAKE_CONNECTOR_BLOCK_MSG);
    return {};
  };
}

// The codex companion (/codex:* skills) forces an OS sandbox that cannot initialize under nested Docker, so it hangs;
// `codex exec --yolo` is the working in-container path. Lives here, not in the codex plugin, so a plugin-repo merge
// can't clobber it.
const CODEX_COMPANION_RE = /codex-companion(\.mjs)?\b/;
const CODEX_COMPANION_BLOCK_MSG =
  'The /codex:* plugin skills (codex-companion.mjs) hang under nested Docker — their app-server forces an OS sandbox that cannot initialize in-container. Use `codex exec --yolo "<prompt>"` directly instead (no inner sandbox; the container is already the isolation boundary). It supports everything the skills do, including image generation.';

export function createBlockCodexCompanionHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};
    if (CODEX_COMPANION_RE.test(command)) return denyBash(CODEX_COMPANION_BLOCK_MSG);
    return {};
  };
}

// Email gate: agent-initiated Gmail sends via the gws CLI need admin approval before they run. The helper verbs
// (+send/+reply/+reply-all/+forward) and the raw `users (messages|drafts) send` form send identically, so both are
// gated; creating a draft is not. Direct REST, SDK and SMTP sends are out of reach at this layer (only the egress
// proxy could catch them). The approval wait is up to 60 minutes and must match host-side BASH_GATE_TIMEOUT_MS.
export const GWS_EMAIL_SEND_RE =
  /\bgws\s+gmail\s+(?:\+(?:send|reply|reply-all|forward)|users\s+(?:messages|drafts)\s+send)\b/;
/** Inline mirror of email-gate-core.ts (the fail-closed fallback cannot import it); keep in sync. */
const EMAIL_BYPASS_FLAGS = new Set(['--dry-run', '--draft', '--help', '-h']);
// `#` and newlines included: the bypass check runs on the WHOLE command, so a `--dry-run\n<real send>` decoy must
// fail closed rather than read the decoy's flag as real argv. Mirrors the core's SHELL_METACHAR_RE.
const EMAIL_SHELL_METACHAR_RE = /[<>|;&$`(){}#\n\r]/;

// A sentinel, not a space, preserves bash word concatenation: `--body 'x'--dry-run` is one word with no real flag.
const EMAIL_QUOTED_SPAN_SENTINEL = '\x00';
const EMAIL_LEADING_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * A bypass flag counts only as a real argv token of a SIMPLE, DIRECT gws command, in option position. Quoted spans
 * are stripped, and any unbalanced quote, unquoted backslash or shell metacharacter fails closed, so the remaining
 * tokens equal bash's argv words. Mirrors the core's bypassFlagIsRealArgvToken; every step only makes bypass less
 * likely.
 */
function emailBypassIsRealArgvToken(gwsSegment: string): boolean {
  // Command substitution still runs inside expanding quotes (`"…"`, `$"…"`), so `$(` or a backtick there refuses
  // the bypass before the sentinel hides it. Bare `$VAR` is only expansion, so `--body "cost is $5"` still bypasses.
  const safeStripped = gwsSegment
    .replace(/\$'(?:[^'\\]|\\.)*'/g, EMAIL_QUOTED_SPAN_SENTINEL)
    .replace(/'[^']*'/g, EMAIL_QUOTED_SPAN_SENTINEL);
  const expandingQuoteRe = /\$?"((?:[^"\\]|\\.)*)"/g;
  for (let m = expandingQuoteRe.exec(safeStripped); m !== null; m = expandingQuoteRe.exec(safeStripped)) {
    if (m[1].includes('$(') || m[1].includes('`')) return false; // command substitution in expanding quotes → don't bypass
  }
  const unquoted = safeStripped
    .replace(/\$"(?:[^"\\]|\\.)*"/g, EMAIL_QUOTED_SPAN_SENTINEL)
    .replace(/"(?:[^"\\]|\\.)*"/g, EMAIL_QUOTED_SPAN_SENTINEL);
  if (unquoted.includes("'") || unquoted.includes('"')) return false;
  if (unquoted.includes('\\')) return false; // unquoted backslash escape → don't bypass
  if (EMAIL_SHELL_METACHAR_RE.test(unquoted)) return false;
  const tokens = unquoted.split(/[ \t\n]+/).filter((t) => t.length > 0); // bash IFS, not JS \s
  let i = 0;
  while (i < tokens.length && EMAIL_LEADING_ASSIGNMENT_RE.test(tokens[i])) i++; // skip VAR=value
  if (tokens[i] !== 'gws') return false; // direct gws invocation only, no wrapper
  for (let j = i + 1; j < tokens.length; j++) {
    if (!EMAIL_BYPASS_FLAGS.has(tokens[j])) continue;
    const prev = tokens[j - 1];
    const prevConsumesValue = prev.startsWith('-') && !prev.includes('='); // bare -x/--opt eats next word
    if (!prevConsumesValue) return true;
  }
  return false;
}

// Read-only help probe: optional exports, one direct gws call, then only `2>&1 | head -N`. The argv verifier still
// proves help is a real gws option.
const EMAIL_SAFE_HELP_PROBE_RE =
  /^(?:export\s+(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|<>\x60$(){}#'"]+)(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s;&|<>\x60$(){}#'"]+)*\s+&&\s+)?((?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|<>\x60$(){}#'"]+\s+)*gws\s+gmail\s+(?:\+(?:send|reply|reply-all|forward)|users\s+(?:messages|drafts)\s+send)(?:\s+[^\s;&|<>\x60$(){}#'"]+)*)\s+2>&1\s*\|\s*head\s+-\d+\s*$/;

function emailSafeHelpProbeIsReadOnly(command: string): boolean {
  const match = command.match(EMAIL_SAFE_HELP_PROBE_RE);
  if (!match) return false;
  const gwsSegment = match[1];
  return /(?:^|[ \t])(?:--help|-h)(?:$|[ \t])/.test(gwsSegment) && emailBypassIsRealArgvToken(gwsSegment);
}

/** Envelope of the raw-API `--json '{"raw":"<base64url>"}'` form, for the approval card; {} on any failure. */
export function envelopeFromJsonRaw(segment: string): {
  to?: string;
  from?: string;
  subject?: string;
  cc?: string;
  bcc?: string;
} {
  const m = segment.match(/--json\s+(['"])((?:(?!\1).)*)\1/);
  if (!m) return {};
  let payload: unknown;
  try {
    payload = JSON.parse(m[2]);
  } catch {
    return {};
  }
  const raw = (payload as { raw?: unknown })?.raw ?? (payload as { message?: { raw?: unknown } })?.message?.raw;
  if (typeof raw !== 'string') return {};
  let decoded: string;
  try {
    let b = raw.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    decoded = Buffer.from(b, 'base64').toString('utf-8');
  } catch {
    return {};
  }
  const blankIdx = decoded.search(/\r?\n\r?\n/);
  const headerBlock = blankIdx === -1 ? decoded : decoded.slice(0, blankIdx);
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const out: { to?: string; from?: string; subject?: string; cc?: string; bcc?: string } = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const hm = line.match(/^([A-Za-z-]+)\s*:\s*(.+)$/);
    if (!hm) continue;
    const k = hm[1].toLowerCase();
    if (k === 'to') out.to = hm[2].trim();
    else if (k === 'from') out.from = hm[2].trim();
    else if (k === 'subject') out.subject = hm[2].trim();
    else if (k === 'cc') out.cc = hm[2].trim();
    else if (k === 'bcc') out.bcc = hm[2].trim();
  }
  return out;
}

// Mirrors email-gate-core.ts EmailGateVerdict.
type EmailGateVerdict = { action: 'allow' | 'gate'; label?: string; summary?: string; reason?: string };
type EmailGateEvaluator = (command: string, env: { isScheduledTask: boolean }) => EmailGateVerdict;

const DEFAULT_EMAIL_GATE_CORE_PATH =
  '/workspace/plugins/bootstrap/plugins/workflow-agents/hooks/guards/email-gate-core.ts';
function emailGateCorePath(): string {
  return process.env.NANOCLAW_EMAIL_GATE_CORE || DEFAULT_EMAIL_GATE_CORE_PATH;
}
// Memo keyed by resolved path so an override swap re-imports.
const _emailGateEvaluators: Record<string, EmailGateEvaluator | null | undefined> = {};

async function loadEmailGateEvaluator(): Promise<EmailGateEvaluator | null> {
  const corePath = emailGateCorePath();
  if (_emailGateEvaluators[corePath] !== undefined) return _emailGateEvaluators[corePath]!;
  try {
    const core = (await import(corePath)) as { evaluateEmailSend?: EmailGateEvaluator };
    _emailGateEvaluators[corePath] = typeof core.evaluateEmailSend === 'function' ? core.evaluateEmailSend : null;
  } catch {
    _emailGateEvaluators[corePath] = null;
  }
  return _emailGateEvaluators[corePath]!;
}

/**
 * Inline fail-CLOSED fallback for when the core can't be imported: a verbatim port of email-gate-core.ts's policy so
 * it can never drift OPEN. Keep in sync with the core.
 */
function evaluateEmailSendInline(command: string, env: { isScheduledTask: boolean }): EmailGateVerdict {
  if (!command || !GWS_EMAIL_SEND_RE.test(command)) return { action: 'allow' };

  // Bypass only when the WHOLE command is one simple send with a real bypass flag: checking the whole command makes
  // a `: gws gmail +send --dry-run; <real send>` decoy hit the metacharacter check, even with an obfuscated send.
  // The bounded read-only help probe is the only shell-operator exception.
  if (emailSafeHelpProbeIsReadOnly(command) || emailBypassIsRealArgvToken(command)) return { action: 'allow' };

  // Scheduled tasks bypass so automated email reports aren't gated on every run.
  if (env.isScheduledTask) return { action: 'allow' };

  // Card fields come from the WHOLE command: in a decoy chain the real send may sit in a segment GWS_EMAIL_SEND_RE
  // misses. The card is best-effort; the gate has already fired.
  const gwsSegment = command;

  // Helper-verb sends carry the envelope as flags; raw-API sends as base64url RFC 822 inside `--json`.
  const matchFlag = (flag: string): string | undefined => {
    const quoted = gwsSegment.match(new RegExp(`${flag}\\s+['"]([^'"]+)['"]`));
    if (quoted) return quoted[1];
    const bare = gwsSegment.match(new RegExp(`${flag}\\s+(\\S+)`));
    return bare?.[1];
  };
  const flagTo = matchFlag('--to');
  const envelope = !flagTo ? envelopeFromJsonRaw(gwsSegment) : {};
  const to = flagTo ?? envelope.to ?? 'unknown recipient';
  const subject = matchFlag('--subject') ?? envelope.subject ?? '';
  const body = matchFlag('--body') ?? '';
  const cc = matchFlag('--cc') ?? envelope.cc;
  const bcc = matchFlag('--bcc') ?? envelope.bcc;
  const isHtml = /\s--html(?:\s|$)/.test(gwsSegment);
  // The sending identity is the credentials file's slug: /home/node/.config/gws/accounts/<slug>.json.
  const credsMatch = command.match(/GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=\S*?\/accounts\/([\w.-]+)\.json/);
  const fromAccount = credsMatch?.[1] ?? 'default';
  // Only the four helper verbs: a looser `\+\w+` matched `+ABC` inside a raw-form base64 payload.
  const action = gwsSegment.match(/\+(send|reply|reply-all|forward)\b/)?.[1] ?? 'send';
  const label = subject ? `Email ${action} to ${to}: "${subject}"` : `Email ${action} to ${to}`;

  // No `command` field: the host's card then shows no shell noise; the raw command stays in the tool-call log.
  const lines: string[] = [`*From:* ${fromAccount}`, `*To:* ${to}`];
  if (cc) lines.push(`*Cc:* ${cc}`);
  if (bcc) lines.push(`*Bcc:* ${bcc}`);
  if (subject) lines.push(`*Subject:* ${subject}`);
  if (body) {
    const bodyPreview = body.length > 400 ? body.slice(0, 400) + '…' : body;
    lines.push('', isHtml ? '*Body* (HTML):' : '*Body:*', `> ${bodyPreview.replace(/\n/g, '\n> ')}`);
  }
  const summary = lines.join('\n');

  return { action: 'gate', label, summary };
}

/** The core verdict carries no bare verb, so it is re-derived the way the core does. */
function emailActionVerb(command: string): string {
  const segments = command.split(/[;&|]\s*|\s*&&\s*|\s*\|\|\s*|\n/);
  const gwsSegment = segments.find((s) => GWS_EMAIL_SEND_RE.test(s)) ?? command;
  return gwsSegment.match(/\+(send|reply|reply-all|forward)\b/)?.[1] ?? 'send';
}

/** A core verdict is trusted only with a known action, so a malformed return can't fall through to allow. */
function isWellFormedEmailVerdict(v: unknown): v is EmailGateVerdict {
  const a = (v as { action?: unknown } | null | undefined)?.action;
  return a === 'allow' || a === 'gate';
}

export function createEmailGateHook(opts?: {
  /**
   * Join the shared one-card-per-tool-call claim. Set ONLY by the in-tree Codex chain, which knows the plugin
   * adapter gates the same tool call.
   */
  sharedApprovalClaim?: boolean;
}): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};

    const evalCommand = command;

    const isScheduledTask = process.env.NANOCLAW_IS_SCHEDULED_TASK === '1';
    const coreEvaluator = await loadEmailGateEvaluator();
    let verdict: EmailGateVerdict;
    if (coreEvaluator) {
      try {
        const v = coreEvaluator(evalCommand, { isScheduledTask });
        // A malformed core verdict is untrusted: without the shape check `{}` or `{action:'bogus'}` would ALLOW a
        // real send unapproved.
        verdict = isWellFormedEmailVerdict(v) ? v : evaluateEmailSendInline(evalCommand, { isScheduledTask });
      } catch {
        verdict = evaluateEmailSendInline(evalCommand, { isScheduledTask });
      }
    } else {
      verdict = evaluateEmailSendInline(evalCommand, { isScheduledTask });
    }

    if (verdict.action !== 'gate') return {};

    const action = emailActionVerb(evalCommand);
    const label = verdict.label ?? `Email ${action}`;
    const summary = verdict.summary ?? '';

    // Dynamic imports avoid a circular import with the DB module graph during provider init.
    const { writeMessageOut } = await import('../db/messages-out.js');
    const { getSessionRouting } = await import('../db/session-routing.js');
    const { awaitDeliveryAck } = await import('../db/delivery-acks.js');

    // Share ONE card with the peer guard gating this same tool call. Opt-in (see `GateClaimApi`): never armed on the
    // Claude path, where no peer exists.
    const claimApi = opts?.sharedApprovalClaim ? await loadGateClaimApi() : null;
    const toolUseId = (pre as { tool_use_id?: unknown }).tool_use_id;
    // Keyed on the tool call and gate, NOT the command: this hook gates the SANITIZED command while the plugin
    // adapter gates the raw one, so a command-keyed claim would give each its own card.
    const claimKey =
      claimApi && typeof toolUseId === 'string' && toolUseId
        ? claimApi.gateClaimKey(toolUseId, 'request_bash_gate')
        : null;
    if (claimKey && claimApi) {
      const claim = claimApi.claimGateRequest(claimKey);
      if (!claim.owner && claim.requestId && !claimApi.gateRequestAlreadyDecided(claim.requestId)) {
        // A peer staged this card: wait on ITS decision so the human answers once.
        const peerAck = await awaitDeliveryAck(claim.requestId, 60 * 60 * 1000);
        if (!peerAck) {
          return denyBash(
            `Email ${action} blocked: timed out waiting for admin approval. Do not retry — ask the user.`,
          );
        }
        if (peerAck.status === 'delivered') return {};
        return denyBash(
          `Email ${action} blocked: ${peerAck.error ?? 'admin declined'}. Do not retry — acknowledge briefly.`,
        );
      }
      // We own the claim, or nobody published in time: stage below. Two cards beats no gate.
    }

    // A throw anywhere after the claim is taken must release it, or the peer waits out the full publish window for
    // a card that will never exist.
    let requestId: string;
    try {
      const routing = getSessionRouting();
      requestId = `gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await writeMessageOut({
        id: requestId,
        kind: 'system',
        platform_id: routing?.platform_id ?? null,
        channel_type: routing?.channel_type ?? null,
        thread_id: routing?.thread_id ?? null,
        content: JSON.stringify({
          action: 'request_bash_gate',
          requestId,
          label,
          summary,
          // The host previews a bounded head+tail and keeps the full command in the approval record.
          command: evalCommand,
        }),
      });
    } catch (err) {
      if (claimKey && claimApi) claimApi.abandonGateClaim(claimKey);
      throw err;
    }
    if (claimKey && claimApi) claimApi.publishGateClaim(claimKey, requestId);

    const ack = await awaitDeliveryAck(requestId, 60 * 60 * 1000);
    if (!ack) {
      return denyBash(`Email ${action} blocked: timed out waiting for admin approval. Do not retry — ask the user.`);
    }
    if (ack.status === 'delivered') {
      return {};
    }
    return denyBash(`Email ${action} blocked: ${ack.error ?? 'admin declined'}. Do not retry — acknowledge briefly.`);
  };
}

// One approval card per tool call (Codex only): in a Codex container this hook and the plugin's `codex-guard.ts`
// both run concurrently on every tool call with the same `tool_use_id`, and both reach the email gate.
// OPT-IN is load-bearing: the Claude SDK also supplies `tool_use_id`, but there this hook is the only gate, so a
// claim could only cost a wait and another agent-writable file. Only `codex-hooks/runner.ts` passes
// `sharedApprovalClaim`. A core without the claim exports degrades to two cards, never a skipped gate.

interface GateClaimApi {
  gateClaimKey: (toolUseId: string, action: string) => string;
  claimGateRequest: (key: string) => { owner: boolean; requestId?: string | null };
  publishGateClaim: (key: string, requestId: string) => void;
  abandonGateClaim: (key: string) => void;
  /**
   * Makes the claim safe to read: the claim dir is agent-writable /tmp, so an ALREADY-decided requestId is a replayed
   * past approval, not a live peer. Required; a core without it disables the claim. DECIDED is `delivered` or
   * `failed`, never `pending`, which is the state a loser should wait on.
   */
  gateRequestAlreadyDecided: (requestId: string) => boolean;
}

let _gateClaimApi: GateClaimApi | null | undefined;

async function loadGateClaimApi(): Promise<GateClaimApi | null> {
  if (_gateClaimApi !== undefined) return _gateClaimApi;
  try {
    const core = (await import(guardCorePath())) as Record<string, unknown>;
    const ok =
      typeof core.gateClaimKey === 'function' &&
      typeof core.claimGateRequest === 'function' &&
      typeof core.publishGateClaim === 'function' &&
      typeof core.abandonGateClaim === 'function' &&
      typeof core.gateRequestAlreadyDecided === 'function';
    _gateClaimApi = ok ? (core as unknown as GateClaimApi) : null;
  } catch {
    _gateClaimApi = null;
  }
  return _gateClaimApi;
}

export function resetGateClaimApiForTest(): void {
  _gateClaimApi = undefined;
}

// ADVISORY git-clone nudge, not a security boundary (the agent already has RW to managed dirs): agents must use the
// create_worktree / clone_repo MCP tools. The whole command is rejected when it mentions a managed dir anywhere
// alongside `git clone`, since `git clone … /tmp/x && mv /tmp/x /workspace/agent/…` defeated a per-segment check.
// Known residual bypasses are documented in the core.
const GIT_CLONE_RE = /\bgit\s+clone\b/;
const MANAGED_DIR_RE = /\/workspace\/(?:agent|worktrees|workgroup|global|extra|thread|plugins)\b/;
const GIT_CLONE_BLOCK_MSG =
  'Ad-hoc `git clone` into a managed dir (/workspace/{agent,worktrees,workgroup,...}) is blocked. Use the `create_worktree` MCP tool for an existing repo, or `clone_repo` to add a new one. If the clone is ephemeral, keep the entire command within /tmp.';

export function createBlockGitCloneHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};

    const evaluator = await loadCoreEvaluator('evaluateGitCloneDestination');
    if (evaluator) {
      try {
        const verdict = evaluator(command);
        // Fail-closed: anything that isn't an explicit `allow` is a block.
        if (verdict?.action !== 'allow') return denyBash(verdict?.reason ?? GIT_CLONE_BLOCK_MSG);
        return {};
      } catch {
        // evaluator threw — fall through to the inline fallback.
      }
    }

    if (!GIT_CLONE_RE.test(command)) return {};
    if (MANAGED_DIR_RE.test(command)) return denyBash(GIT_CLONE_BLOCK_MSG);
    return {};
  };
}

// Header-only MCP secrets must never reach the SDK's child-process env.
const SDK_ENV_DENYLIST: ReadonlySet<string> = new Set(MCP_HEADER_ONLY_SECRET_VARS);

function filterSdkEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (SDK_ENV_DENYLIST.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Without passing plugins to the SDK, their hooks.json never loads even when the plugins dir is mounted. */
export interface PluginDiscovery {
  plugins: SdkPluginConfig[];
  preToolUseGuards: string[];
}

/**
 * `nanoclaw-plugin.json` is deliberately separate from Claude's plugin manifest: an explicit integration contract
 * rather than undocumented manifest extension fields.
 *
 * `excludePlugins` is honoured here against the relative path assembled from this walk's own `readdirSync` names,
 * never a `realpath`. Dropping a sub-plugin removes it from `plugins:`, which also drops its hooks and guards.
 */
export function discoverPlugins(
  pluginsRoot = process.env.CLAUDE_PLUGINS_ROOT || '/workspace/plugins',
  excluded: ExcludedPlugins = loadExcludedPlugins(),
): PluginDiscovery {
  if (!fs.existsSync(pluginsRoot)) return { plugins: [], preToolUseGuards: [] };
  const plugins: SdkPluginConfig[] = [];
  const preToolUseGuards = new Set<string>();
  const hasManifest = (p: string) => fs.existsSync(path.join(p, '.claude-plugin', 'plugin.json'));
  const addPlugin = (pluginPath: string): void => {
    plugins.push({ type: 'local', path: pluginPath });
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(pluginPath, 'nanoclaw-plugin.json'), 'utf8')) as {
        preToolUseGuards?: unknown;
      };
      if (Array.isArray(raw.preToolUseGuards)) {
        for (const guard of raw.preToolUseGuards) {
          if (typeof guard === 'string') preToolUseGuards.add(guard);
        }
      }
    } catch {
      // A plugin without the optional declaration remains a normal SDK plugin.
    }
  };
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(pluginsRoot);
  } catch {
    return { plugins: [], preToolUseGuards: [] };
  }
  for (const entry of entries) {
    const repoPath = path.join(pluginsRoot, entry);
    if (isExcludedPluginPath(entry, excluded)) continue;
    try {
      if (!fs.statSync(repoPath).isDirectory()) continue;
    } catch {
      continue;
    }
    if (hasManifest(repoPath)) {
      addPlugin(repoPath);
      continue;
    }
    let subs: string[] = [];
    try {
      subs = fs.readdirSync(repoPath);
    } catch {
      continue;
    }
    for (const sub of subs) {
      const subPath = path.join(repoPath, sub);
      const subRel = `${entry}/${sub}`;
      if (isExcludedPluginPath(subRel, excluded)) continue;
      try {
        if (!fs.statSync(subPath).isDirectory()) continue;
      } catch {
        continue;
      }
      if (hasManifest(subPath)) {
        addPlugin(subPath);
        continue;
      }
      // `<repo>/deprecated/` holds retired plugins; host skill discovery skips them too.
      if (sub === 'deprecated') continue;
      let sub2s: string[] = [];
      try {
        sub2s = fs.readdirSync(subPath);
      } catch {
        continue;
      }
      for (const sub2 of sub2s) {
        const sub2Path = path.join(subPath, sub2);
        if (isExcludedPluginPath(`${subRel}/${sub2}`, excluded)) continue;
        try {
          if (!fs.statSync(sub2Path).isDirectory()) continue;
        } catch {
          continue;
        }
        if (hasManifest(sub2Path)) {
          addPlugin(sub2Path);
        }
      }
    }
  }
  return { plugins, preToolUseGuards: [...preToolUseGuards] };
}

/**
 * Past this many transcript bytes a cold container can't reload the .jsonl before the host's 30-min idle ceiling,
 * so the session is dropped and started clean.
 */
function transcriptRotateBytes(): number {
  return Number(process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES) || 12 * 1024 * 1024;
}

/** Measured from the transcript's first entry; a non-positive value disables the age check. */
function transcriptRotateAgeMs(): number {
  const raw = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  if (raw === undefined || raw.trim() === '') return 14 * 86_400_000;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 14 * 86_400_000;
  return days > 0 ? days * 86_400_000 : Infinity;
}

function claudeProjectsDir(): string {
  return path.join(claudeConfigDir(), 'projects');
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
}

function writeMemorySessionHook(hook: MemorySessionHookRegistration): void {
  // Container-only: outside a container $HOME/.claude is a developer's own config, and a hook pointing at a module
  // that isn't there breaks every host session on startup. The module ships only in the image, so check it exists.
  if (!fs.existsSync(hook.modulePath)) {
    console.warn(
      `[memory] refusing to register the session hook: ${hook.modulePath} does not exist. ` +
        'This code is container-only; writing here would corrupt a host config.',
    );
    return;
  }

  const configDir = claudeConfigDir();
  const settingsFile = path.join(configDir, 'settings.json');
  fs.mkdirSync(configDir, { recursive: true });

  const parsed: unknown = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) : {};
  if (!isRecord(parsed)) throw new Error(`${settingsFile} must contain a JSON object`);

  const hooks = parsed.hooks === undefined ? {} : parsed.hooks;
  if (!isRecord(hooks)) throw new Error(`${settingsFile} hooks must be a JSON object`);

  const sessionStart = hooks.SessionStart === undefined ? [] : hooks.SessionStart;
  if (!Array.isArray(sessionStart)) throw new Error(`${settingsFile} hooks.SessionStart must be an array`);

  const memoryCommands = new Set([hook.command, ...hook.legacyCommands]);
  const nextSessionStart = sessionStart
    .map((entry) => removeMemoryCommands(entry, memoryCommands))
    .filter((entry) => entry !== undefined);
  nextSessionStart.push({
    matcher: hook.sources.join('|'),
    hooks: [{ type: 'command', command: hook.command, timeout: 10 }],
  });

  hooks.SessionStart = nextSessionStart;
  parsed.hooks = hooks;
  fs.writeFileSync(settingsFile, JSON.stringify(parsed, null, 2) + '\n');
}

function removeMemoryCommands(value: unknown, commands: ReadonlySet<string>): unknown {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return value;
  const hooks = value.hooks.filter((hook) => {
    if (!isRecord(hook)) return true;
    return typeof hook.command !== 'string' || !commands.has(hook.command);
  });
  return hooks.length > 0 ? { ...value, hooks } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Scans project dirs for `<sessionId>.jsonl` rather than reproducing the SDK's mangled-cwd dir naming (session ids
 * are UUIDs, so this is unambiguous).
 */
function findTranscriptPath(sessionId: string): string | null {
  const projects = claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The WHOLE first line must be read: a truncated JSON prefix never parses (first entries run to ~100KB), and a null
 * here silently disables age-based rotation. A longer line logs and skips the age check.
 */
const TRANSCRIPT_FIRST_LINE_MAX_BYTES = 1024 * 1024;

/** Epoch-ms of the first transcript entry, or null if unreadable. */
function transcriptStartMs(transcriptPath: string): number | null {
  try {
    let firstLine: string;
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      // +1 so a filled buffer means the line is genuinely LONGER than the cap.
      const buf = Buffer.alloc(TRANSCRIPT_FIRST_LINE_MAX_BYTES + 1);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const nl = buf.indexOf(0x0a);
      const end = nl >= 0 && nl < n ? nl : n;
      if (end === n && n === buf.length) {
        log(`Transcript first line exceeds ${buf.length}B — age-based rotation skipped for ${transcriptPath}`);
        return null;
      }
      firstLine = buf.toString('utf-8', 0, end);
    } finally {
      fs.closeSync(fd);
    }
    const ts = (JSON.parse(firstLine) as { timestamp?: string } | null)?.timestamp;
    const ms = ts ? Date.parse(ts) : NaN;
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/** Auto-compact window in tokens; operator-overridable via CLAUDE_CODE_AUTO_COMPACT_WINDOW. */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';

/**
 * Opus runs only in its 1M-context form here. The CLI grants the 1M window only when the id literally carries
 * `[1m]`; a bare opus id under proxy auth collapses to 200k and force-compacts long sessions. Mirrors
 * `ensureOpus1mSuffix` in src/flag-parser.ts; a no-op for aliases and ids already carrying a suffix.
 */
function ensureOpus1mSuffix(model: string): string {
  // Fable shares the opus 1M-only policy; both span single- and two-segment version ids. Keep in sync with
  // src/flag-parser.ts ensureOpus1mSuffix.
  return /^claude-(?:opus-\d+(?:-\d+)?|fable-\d+(?:-\d+)?)$/i.test(model) ? `${model}[1m]` : model;
}

/**
 * The concrete id a bare alias runs as, which is what `modelUsage` is keyed by: a bare alias compared against those
 * keys matches nothing, recording NULL effort. `ensureOpus1mSuffix` is reapplied because the keys carry the suffix.
 * An alias with no env answer is returned unchanged and simply won't match (under-claims, never guesses).
 */
function canonicalUsageModel(model: string | undefined, env: Record<string, string | undefined>): string | undefined {
  if (!model) return model;
  const key = CLAUDE_FAMILY_ALIAS_ENV[model.toLowerCase()];
  if (!key) return model; // already a concrete id
  const resolved = env[key];
  return resolved ? ensureOpus1mSuffix(resolved) : model;
}

/**
 * Per-family default effort, applied only when nothing upstream (-e, group config, NANOCLAW_EFFORT_OVERRIDE) chose
 * one. The values are operator policy; haiku gets none because it has no effort control at the API.
 */
function defaultEffortForModel(model: string | undefined): string | undefined {
  if (!model) return 'high';
  const m = model.toLowerCase();
  if (m === 'opus' || m.startsWith('claude-opus-')) return 'high';
  if (m === 'sonnet' || m.startsWith('claude-sonnet-')) return 'high';
  if (m === 'fable' || m.startsWith('claude-fable-')) return 'medium';
  if (m === 'haiku' || m.startsWith('claude-haiku-')) return undefined;
  return 'high';
}

/**
 * Provider-side safety net: model/effort mismatches arrive from layers that never see both (a model-blind
 * NANOCLAW_EFFORT_OVERRIDE, a sticky -e with a later -m), and an unsupported value would 400 at the API. Keep the
 * support sets consistent with MODEL_EFFORT_SUPPORT in src/flag-parser.ts (not importable from this package).
 */
function clampEffortForModel(model: string | undefined, effort: string | undefined): string | undefined {
  if (!effort) return effort;
  const m = (model ?? '').toLowerCase();
  if (m === 'haiku' || m.startsWith('claude-haiku-')) return defaultEffortForModel(model);
  // Every non-haiku model this install runs supports the full effort surface.
  return effort;
}

/**
 * Claude Code's error text when a resumed session can't be found. An invalid thinking signature (the continuation
 * was signed by a different serving upstream after an auth-path change) is treated the same: reset and start fresh.
 */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|invalid `?signature`? in `?thinking`? block/i;

/**
 * Distinct from STALE_SESSION_RE: prompt-too-long needs a cleared continuation PLUS an in-turn retry on a fresh
 * session, otherwise the same message fails on the next poll too.
 */
const PROMPT_TOO_LONG_RE = /prompt is too long|prompt_too_long|maximum context length|context[_ ]length.*exceed/i;

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private readonly stickyConfig: z.infer<typeof claudeConfigSchema>;

  /**
   * API-key fallbacks (ANTHROPIC_API_KEY_N, sorted by N). Populated only under a non-Anthropic routing proxy
   * (ANTHROPIC_BASE_URL); under OneCLI the proxy picks the key and this stays empty.
   */
  private fallbackKeys: Array<{ name: string; value: string }>;
  private nextFallback = 0;

  /**
   * OAuth fallback tokens (CLAUDE_CODE_OAUTH_TOKEN_N). If ANTHROPIC_API_KEY is also set, API-key rotation is used
   * instead: it is the only credential the SDK uses then.
   */
  private fallbackOauth: Array<{ name: string; value: string }>;
  // Circular ring [primary, ...fallbacks]: wrapping back to the primary means a transient blip can't strand the
  // container on a worse credential. Position is sticky across turns; the per-turn cycle budget resets each turn.
  private oauthRing: Array<{ name: string; value: string }> = [];
  private oauthRingPos = 0;
  private oauthRotationsThisCycle = 0;
  private memorySessionHook?: MemorySessionHookRegistration;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    // The SDK's stdio MCP config has no cwd field (checked against 0.3.197), so cwd-bearing servers go through
    // cwd-shim.ts rather than silently starting in the container's default cwd.
    this.mcpServers = Object.fromEntries(
      Object.entries(options.mcpServers ?? {}).map(([name, server]) => [name, shimCwd(server)]),
    );
    this.additionalDirectories = options.additionalDirectories;
    // The CLI emits `session_state_changed` (running/idle) only when asked.
    // Idle is what settles a prompt whose echo was dropped; see MessageStream.
    this.env = filterSdkEnv({
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
    });
    this.stickyConfig = claudeConfigSchema.parse(options.providerConfig ?? {});
    this.fallbackKeys = Object.entries(this.env)
      .filter(([k, v]) => ANTHROPIC_FALLBACK_RE.test(k) && typeof v === 'string' && v.length > 0)
      .sort(([a], [b]) => {
        const na = Number(a.match(ANTHROPIC_FALLBACK_RE)![1]);
        const nb = Number(b.match(ANTHROPIC_FALLBACK_RE)![1]);
        return na - nb;
      })
      .map(([k, v]) => ({ name: k, value: v as string }));
    if (this.fallbackKeys.length > 0) {
      log(
        `Loaded ${this.fallbackKeys.length} ANTHROPIC_API_KEY fallback(s): ${this.fallbackKeys.map((k) => k.name).join(', ')}`,
      );
    }
    this.fallbackOauth = Object.entries(this.env)
      .filter(([k, v]) => OAUTH_FALLBACK_RE.test(k) && typeof v === 'string' && v.length > 0)
      .sort(([a], [b]) => {
        const na = Number(a.match(OAUTH_FALLBACK_RE)![1]);
        const nb = Number(b.match(OAUTH_FALLBACK_RE)![1]);
        return na - nb;
      })
      .map(([k, v]) => ({ name: k, value: v as string }));
    if (this.fallbackOauth.length > 0) {
      log(
        `Loaded ${this.fallbackOauth.length} CLAUDE_CODE_OAUTH_TOKEN fallback(s): ${this.fallbackOauth.map((k) => k.name).join(', ')}`,
      );
    }
    // Deduped by value so a token in two slots isn't visited twice. The host already strips OneCLI's `placeholder`
    // sentinel; guarded again so it never enters the ring as a usable credential.
    const ringPrimary = this.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (ringPrimary && ringPrimary !== 'placeholder') {
      const seenRing = new Set<string>();
      for (const entry of [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: ringPrimary }, ...this.fallbackOauth]) {
        if (seenRing.has(entry.value)) continue;
        seenRing.add(entry.value);
        this.oauthRing.push(entry);
      }
    }
  }

  /**
   * Restores the ring position a previous container of this session rotated onto, so a respawn doesn't burn a
   * rejected turn on the primary. Position only; the token value comes from env.
   *
   * Never called from the constructor or `query()`: `getCredentialSlot` opens the outbound session DB directly, so a
   * provider built in a unit test would create a session DB at the production path. The runner entrypoint calls it
   * once, after the mailbox has started. Best-effort: a read failure is logged and ignored. Plan utilization never
   * reorders the ring; slot order is the operator's priority.
   */
  restorePersistedCredentialSlot(): void {
    let persisted: string | undefined;
    try {
      persisted = getCredentialSlot('claude');
    } catch (err) {
      log(`Could not read persisted credential slot: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!persisted) return;

    const ringIndex = this.oauthRing.findIndex((entry) => entry.name === persisted);
    if (ringIndex !== -1) {
      this.oauthRingPos = ringIndex;
      const active = this.oauthRing[ringIndex];
      this.env.CLAUDE_CODE_OAUTH_TOKEN = active.value;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = active.value;
      log(`Resumed credential slot ${active.name} (ring ${ringIndex + 1}/${this.oauthRing.length}) from session state`);
      return;
    }

    // Deliberately no ANTHROPIC_API_KEY_N branch: that pool is forward-only (`nextFallback` never wraps), so a
    // restored position could only advance past the end and the primary would never be eligible again. A respawn is
    // that pool's only reset, so it is never persisted.

    // A slot no longer in the pool (env changed since it was written): stay on the primary.
    log(`Persisted credential slot "${persisted}" is not in the current pool — ignoring, staying on primary`);
  }

  /** Best-effort persist; never throws — a respawn just re-derives via rotation. */
  private persistCredentialSlot(slotName: string): void {
    try {
      setCredentialSlot('claude', slotName);
    } catch (err) {
      log(`Failed to persist credential slot: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    writeMemorySessionHook(hook);
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  isContextTooLong(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return PROMPT_TOO_LONG_RE.test(msg);
  }

  isRetryable(err: unknown): boolean {
    const classification =
      typeof err === 'object' && err !== null && 'classification' in err
        ? (err as { classification?: unknown }).classification
        : undefined;
    if (classification === 'quota' || classification === 'rate_limit') return true;
    const msg = err instanceof Error ? err.message : String(err);
    return RETRYABLE_ERROR_RE.test(msg);
  }

  isTransientOverload(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.startsWith('transient_overload:');
  }

  transcriptHasPrompt(continuation: string | undefined, prompt: string, sinceMs: number): boolean {
    if (!continuation) return false;
    const transcriptPath = findTranscriptPath(continuation);
    return transcriptPath !== null && transcriptContainsUserText(transcriptPath, prompt, sinceMs);
  }

  /** The CLI authenticates with the OAuth ring only when no API key is set; a set key wins. */
  private usingOauth(): boolean {
    return !this.env.ANTHROPIC_API_KEY && Boolean(this.env.CLAUDE_CODE_OAUTH_TOKEN);
  }

  rotateApiKey(): { rotated: boolean; slot?: string; position?: number; ringSize?: number } {
    if (this.usingOauth()) {
      // Circular, giving up only once every OTHER credential was tried this cycle, so a healed primary is reachable
      // again on a later turn. Rotations are mirrored to process.env so Bash subprocesses (`claude -p`) and other
      // in-process callers sign with the active slot.
      if (this.oauthRing.length <= 1) return { rotated: false };
      if (this.oauthRotationsThisCycle >= this.oauthRing.length - 1) return { rotated: false };
      this.oauthRingPos = (this.oauthRingPos + 1) % this.oauthRing.length;
      this.oauthRotationsThisCycle++;
      const next = this.oauthRing[this.oauthRingPos];
      this.env.CLAUDE_CODE_OAUTH_TOKEN = next.value;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = next.value;
      log(
        `Rotated CLAUDE_CODE_OAUTH_TOKEN → ${next.name} ` +
          `(ring ${this.oauthRingPos + 1}/${this.oauthRing.length}, cycle ${this.oauthRotationsThisCycle}/${this.oauthRing.length - 1})`,
      );
      this.persistCredentialSlot(next.name);
      return { rotated: true, slot: next.name, position: this.oauthRingPos + 1, ringSize: this.oauthRing.length };
    }
    if (this.nextFallback >= this.fallbackKeys.length) return { rotated: false };
    const next = this.fallbackKeys[this.nextFallback++];
    if (this.env.ANTHROPIC_API_KEY === next.value) {
      // The base key already equals this fallback: skip to the next.
      return this.rotateApiKey();
    }
    this.env.ANTHROPIC_API_KEY = next.value;
    process.env.ANTHROPIC_API_KEY = next.value;
    log(`Rotated ANTHROPIC_API_KEY → ${next.name} (${this.nextFallback}/${this.fallbackKeys.length})`);
    // Never persisted: see restorePersistedCredentialSlot on the forward-only pool.
    return { rotated: true, slot: next.name, position: this.nextFallback + 1, ringSize: this.fallbackKeys.length + 1 };
  }

  /**
   * Called at the start of every turn so a since-healed credential (e.g. a reset 5-hour cap) is reachable again.
   * The API-key pool stays forward-only.
   */
  resetRotationCycle(): void {
    this.oauthRotationsThisCycle = 0;
  }

  maybeRotateContinuation(continuation: string): string | null {
    const transcriptPath = findTranscriptPath(continuation);
    if (!transcriptPath) return null;

    let size: number;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      return null;
    }

    const maxBytes = transcriptRotateBytes();
    const startMs = transcriptStartMs(transcriptPath);
    const ageMs = startMs === null ? 0 : Date.now() - startMs;
    const maxAgeMs = transcriptRotateAgeMs();

    let reason: string | null = null;
    if (size > maxBytes) {
      reason = `transcript ${(size / 1_048_576).toFixed(1)}MB > ${(maxBytes / 1_048_576).toFixed(0)}MB cap`;
    } else if (startMs !== null && ageMs > maxAgeMs) {
      reason = `transcript ${(ageMs / 86_400_000).toFixed(1)}d old > ${(maxAgeMs / 86_400_000).toFixed(0)}d cap`;
    }
    if (!reason) return null;

    // Preserve a readable summary, then move the heavy .jsonl out of the
    // resume path so the SDK starts a fresh session and the disk is reclaimed.
    archiveTranscriptFile(transcriptPath, continuation, this.assistantName);
    try {
      fs.renameSync(transcriptPath, `${transcriptPath}.rotated-${Date.now()}`);
    } catch (err) {
      log(`Failed to move rotated transcript aside: ${err instanceof Error ? err.message : String(err)}`);
    }
    return reason;
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('Claude memory session hook was not registered');
    const stream = new MessageStream();
    const initialPromptId = stream.push(input.prompt);
    // Set by the first `session_state_changed`. Until the CLI proves it emits idle, report no queued work, so a CLI
    // without the events cannot pin a turn.
    let sessionStateSeen = false;
    // Live background tasks from `background_tasks_changed`, a level signal with REPLACE semantics (swap the set per
    // payload, never pair start/finish). Ambient entries are excluded, as the SDK asks.
    const liveBackgroundTasks = new Set<string>();
    // `hasBackgroundWork`'s hold. Latched: released only at the CLI's idle with the set empty, never at the
    // membership change that empties it, because between that drain and the idle (or the follow-up turn's `init`)
    // the work is not over. The CLI withholds idle only for background subagents; for other task types (backgrounded
    // Bash, monitors, …) idle arrives with them still live and never comes again, so `idleSeenWithHold` lets their
    // drain release the hold. That evidence covers only `idleCoveredTasks`: a task joining afterwards drops it.
    let backgroundHold = false;
    // Top-level assistant text not yet known to be mid-turn or final (see ProviderEvent `interim_text`).
    let pendingAssistantText: string | null = null;
    let idleSeenWithHold = false;
    let idleCoveredTasks = new Set<string>();

    // Per-turn input wins over sticky config, then the CONCRETE id the host resolved for this group
    // (NANOCLAW_CLAUDE_MODEL). ANTHROPIC_DEFAULT_OPUS_MODEL is the `opus` ALIAS answer, read here only as a fallback
    // for containers from a host predating NANOCLAW_CLAUDE_MODEL; never make the alias carry the group's model again
    // (every `model: opus` subagent would silently run it). Never undefined: the CLI would fall back to its own
    // built-in model, ignoring the configured chain. A concrete id also keeps defaultEffortForModel answering for the
    // model that actually runs. Bare opus gets `[1m]` (see ensureOpus1mSuffix).
    const rawModel =
      input.model ??
      this.stickyConfig.model ??
      process.env.NANOCLAW_CLAUDE_MODEL ??
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ??
      'opus';
    const model = rawModel ? ensureOpus1mSuffix(rawModel) : rawModel;
    // Effort precedence: -e (turn/sticky) → group providerConfig → NANOCLAW_EFFORT_OVERRIDE (set by the host only
    // when a channel or group default is configured) → family default.
    const requestedEffort =
      input.effort ?? this.stickyConfig.effort ?? process.env.NANOCLAW_EFFORT_OVERRIDE ?? defaultEffortForModel(model);
    // Clamp: an effort the model doesn't support would 400 at the API.
    const effort = clampEffortForModel(model, requestedEffort);
    const instructions = appendActiveRuntimeContext(input.systemContext?.instructions, {
      provider: 'claude',
      model: model ?? 'claude:cli-default',
      effort: effort ?? null,
    });
    // ultracode is a session flag applied via the SDK control request below, not an effort value; effort is already
    // forced to xhigh when it is set.
    const ultracode = input.ultracode === true;
    // The only runtime record of the requested model+effort: the CLI never logs the request body.
    log(
      `query: model=${model ?? '(cli default)'} effort=${effort ?? '(none)'}` +
        `${effort !== requestedEffort ? ` (clamped from ${requestedEffort ?? '(none)'})` : ''}` +
        `${ultracode ? ' ultracode' : ''}`,
    );

    // Discovered per query so hot-mounted plugins load without a container restart.
    const pluginDiscovery = discoverPlugins();
    const plugins = pluginDiscovery.plugins;
    const pluginOwnsBashEmailGate = pluginDiscovery.preToolUseGuards.includes('bash-email');
    if (plugins.length > 0) {
      log(`Loaded ${plugins.length} plugin(s): ${plugins.map((p) => path.basename(p.path)).join(', ')}`);
    }
    if (pluginOwnsBashEmailGate) {
      log('Delegating Bash email approval gate to loaded plugin');
    }

    // Leave CLAUDE_CODE_SUBAGENT_MODEL unset: a concrete value outranks frontmatter model selection, pinning every
    // subagent to the group model. Never rewrite a family alias to the group's model here: family words are install
    // constants, and the model in force travels as the SDK's own `model` option.
    const perQueryEnv: Record<string, string | undefined> = { ...this.env };

    // The ring slot is fixed for the query's life (the CLI subprocess starts with this env), so it is captured here,
    // not at sample time; utilization is per account, and unlabelled samples would blend accounts. When an API key is
    // also set the CLI uses it, so samples belong to no slot.
    const usingOauth = this.usingOauth();
    const oauthSlot = usingOauth ? (this.oauthRing[this.oauthRingPos]?.name ?? null) : null;
    // Scoped per-group tokens reuse the global pool's `_N` names, so identity is the PAIR (credentialSet, account).
    const who: AccountIdentity = {
      account: oauthSlot,
      credentialSet: usingOauth ? (process.env.NANOCLAW_OAUTH_CREDENTIAL_SET ?? null) : null,
      lane: laneForSlot(process.env.CLAUDE_CODE_OAUTH_LANES, oauthSlot),
    };

    // Set when a SUBAGENT hits quota (sync PostToolUse hook or async task_notification). The credential is fixed for
    // the query's life, so detection interrupts the query and translateEvents throws this into poll-loop's rotation
    // catch.
    let subagentQuotaError: string | null = null;

    // Passed as `options.abortController` so abort() really tears the CLI child down: stdin EOF alone was not
    // reliably observed, and an abandoned query could keep burning an exhausted credential after the replay moved on.
    const queryAbortController = new AbortController();

    // Outer bound on the `toolsInFlight` leak: a fresh query has no tool running.
    resetToolInFlightTracking();

    const sdkResult = (sdkQueryOverride ?? sdkQuery)({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        model: model,
        abortController: queryAbortController,
        ...(effort ? { effort: effort as EffortLevel } : {}),
        // `display: 'summarized'` makes thinking text visible; the default is empty text plus signature.
        thinking: { type: 'adaptive', display: 'summarized' },
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions }
          : undefined,
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: perQueryEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user', 'local'],
        mcpServers: this.mcpServers,
        plugins: plugins.length > 0 ? plugins : undefined,
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              // List position does NOT order execution: these run concurrently on the original input. The rewrite must
              // stay the ONLY hook returning updatedInput (see createBashCommandRewriteHook).
              hooks: [
                createManagedGitMaintenanceHook(),
                createSelfApprovalBlockHook(),
                createBlockSnowflakeConnectorHook(),
                createBlockGitCloneHook(),
                createBlockCodexCompanionHook(),
                ...(pluginOwnsBashEmailGate ? [] : [createEmailGateHook()]),
                createBashCommandRewriteHook({ closeStdin: true }),
              ],
            },
            // NO MATCHER, deliberately: `preToolUseHook` records `container_state` for EVERY tool and enforces
            // SDK_DISALLOWED_TOOLS, which no Bash matcher would reach.
            // DO NOT DROP THIS ENTRY IN A MERGE RESOLUTION; claude.preToolUse-registration.test.ts asserts it is here.
            { hooks: [preToolUseHook] },
            { matcher: TASK_LIST_TOOL_NAME, hooks: [createSubagentTaskListDenyHook()] },
          ],
          PostToolUse: [
            { hooks: [postToolUseHook] },
            // A sync subagent's quota exhaustion arrives only as a tool_result inside this turn, so this hook is the
            // only place to see it (async ones land on task_notification in translateEvents).
            {
              matcher: SUBAGENT_TOOL_MATCHER,
              hooks: [
                createSubagentQuotaHook({
                  onDetect: (marked) => {
                    if (!subagentQuotaError) subagentQuotaError = marked;
                  },
                  interrupt: () => sdkResult.interrupt(),
                }),
              ],
            },
          ],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;
    const backgroundScheduled = new Set<string>();
    // SDKResultMessage.modelUsage resets for each query(), even when resuming
    // the same session (SDK sdk.d.ts, SDKResultSuccess.modelUsage contract).
    const usageCounterScope = randomUUID();

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      type ResultModelUsage = {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
        costUSD?: number;
      };
      function extractUsage(m: {
        usage?: {
          input_tokens?: number | null;
          output_tokens?: number | null;
          cache_creation_input_tokens?: number | null;
          cache_read_input_tokens?: number | null;
        };
        total_cost_usd?: number;
        modelUsage?: Record<string, ResultModelUsage>;
      }): TurnUsageInfo | TurnUsageInfo[] {
        const modelEntries = m.modelUsage ? Object.entries(m.modelUsage) : [];
        // modelUsage carries its own per-model tokens (children included) while result.usage covers only the main
        // loop, so model count must never switch the accounting source.
        if (modelEntries.length > 0) {
          return modelEntries.map(([model, u]) => ({
            accounting: { kind: 'cumulative' as const, scope: usageCounterScope },
            model,
            inputTokens: u.inputTokens ?? null,
            outputTokens: u.outputTokens ?? null,
            cacheReadTokens: u.cacheReadInputTokens ?? null,
            cacheWriteTokens: u.cacheCreationInputTokens ?? null,
            costUsd: typeof u.costUSD === 'number' ? u.costUSD : null,
          }));
        }
        return {
          // Per-turn MAIN LOOP only, excluding child calls: never combine it with cumulative total_cost_usd or
          // subtract another turn from it.
          accounting: { kind: 'per-turn' },
          model: null,
          inputTokens: m.usage?.input_tokens ?? null,
          outputTokens: m.usage?.output_tokens ?? null,
          cacheReadTokens: m.usage?.cache_read_input_tokens ?? null,
          cacheWriteTokens: m.usage?.cache_creation_input_tokens ?? null,
          costUsd: null,
        };
      }
      let messageCount = 0;
      let lastToolProgressAt = 0;
      const TOOL_PROGRESS_MIN_INTERVAL_MS = 1500;

      // Lets task_notification tell a real subagent from an auto-backgrounded Bash. Turn-scoped and bounded by tool
      // calls, so no eviction.
      const toolNameById = new Map<string, string>();

      // Latest `rate_limit_event` since the last result; cleared after each result so a turn with none reports NULL
      // rather than a stale reading.
      let lastRateLimitInfo: SdkRateLimitInfo | undefined;

      // ultracode is a flag SETTING, settable only through the apply_flag_settings control request. Non-fatal: a CLI
      // that doesn't honor it continues at the already-set xhigh effort.
      if (ultracode) {
        try {
          await sdkResult.applyFlagSettings({ ultracode: true });
          log('ultracode enabled for session (xhigh + standing dynamic-workflow orchestration)');
        } catch (err) {
          log(
            `applyFlagSettings(ultracode) failed — continuing without: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // An intentional abort() surfaces as an error thrown by the iterator itself, not as a message. The catch
      // swallows ONLY that, keyed on the `aborted` flag rather than the error's shape; every deliberate throw in the
      // loop fires before `aborted` is set and still propagates.
      try {
        for await (const message of sdkResult) {
          if (aborted) return;
          // Thrown here because a subagent's quota failure never reaches the result-branch throws below.
          if (subagentQuotaError) throw new Error(subagentQuotaError);
          messageCount++;

          yield { type: 'activity' };

          if (message.type === 'system' && message.subtype === 'init') {
            yield { type: 'init', continuation: message.session_id };
          } else if (message.type === 'result') {
            pendingAssistantText = null;
            // Inner bound on the `toolsInFlight` leak: a turn with a result has no FOREGROUND tool left running.
            resetToolInFlightTracking();
            // Error subtypes carry their message in `errors[]`, not `result`; surface either so a billing or quota
            // notice reaches the user.
            const m = message as {
              result?: string;
              is_error?: boolean;
              errors?: string[];
              // Typed from the SDK so a bump that drops the echo fails typecheck
              // instead of silently making every result unprompted.
              user_message_uuid?: (SDKResultSuccess | SDKResultError)['user_message_uuid'];
              user_message_uuids?: (SDKResultSuccess | SDKResultError)['user_message_uuids'];
              usage?: {
                input_tokens?: number | null;
                output_tokens?: number | null;
                cache_creation_input_tokens?: number | null;
                cache_read_input_tokens?: number | null;
              };
              total_cost_usd?: number;
              modelUsage?: Record<string, ResultModelUsage>;
              // The SDK's own round-trip count for the turn: the `steps` signal.
              num_turns?: number;
            };
            const text = m.result ?? (m.errors && m.errors.length > 0 ? m.errors.join('\n') : null);
            // Retry-path guards run FIRST: they turn error text into a throw so poll-loop retries instead of posting
            // the raw error to the user's channel.
            if (text && QUOTA_RESULT_RE.test(text)) {
              throw new Error(`subscription_quota_exhausted: ${text}`);
            }
            if (text && SUBSCRIPTION_BLOCKED_RE.test(text)) {
              // Same rotation path as quota exhaustion; a distinct marker for diagnosability.
              throw new Error(`subscription_access_disabled: ${text}`);
            }
            if (text && POISONED_CONTINUATION_RE.test(text)) {
              // The same history would fail every future turn; poll-loop's isSessionInvalid branch clears it.
              throw new Error(text);
            }
            if (text && TRANSIENT_OVERLOAD_RESULT_RE.test(text)) {
              throw new Error(`transient_overload: ${text}`);
            }
            const effortHeldAllTurn = effortTransitionsThisTurn === 0;
            // Cleared BEFORE the yield: poll-loop applies settings while the generator is suspended there, so a later
            // reset would wipe transitions belonging to the NEXT turn.
            effortTransitionsThisTurn = 0;
            yield {
              type: 'result',
              text,
              isError: m.is_error === true,
              // Cleared from the outstanding set before the yield, so hasQueuedWork is truthful at this result.
              answeredPrompts: stream.answer([
                ...(m.user_message_uuids ?? []),
                ...(m.user_message_uuid ? [m.user_message_uuid] : []),
              ]),
              // Only the `activeModel` entry gets effort; see providers/turn-effort.ts.
              usage: attachTurnEffort(extractUsage(m), {
                model: activeUsageModel,
                // Unequal means the effort moved mid-turn, so neither half describes the aggregate: NULL both.
                effective: effortHeldAllTurn ? activeEffort : null,
                requested: effortHeldAllTurn ? activeRequestedEffort : null,
              }),
              steps: typeof m.num_turns === 'number' ? m.num_turns : null,
              rateLimit: lastRateLimitInfo
                ? {
                    type: lastRateLimitInfo.rateLimitType ?? null,
                    utilization: lastRateLimitInfo.utilization ?? null,
                    resetsAt: resetsAtIso(lastRateLimitInfo.resetsAt),
                  }
                : null,
            };
            lastRateLimitInfo = undefined; // scoped to the turn that just closed
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
            yield { type: 'error', message: 'API retry', retryable: true };
          } else if (message.type === 'rate_limit_event') {
            const info = (message as { rate_limit_info?: SdkRateLimitInfo }).rate_limit_info;
            lastRateLimitInfo = info; // held for the `result` that closes this turn
            recordRateLimitSamples(rateLimitEventToSamples(info, who));
            const blocked = classifyRateLimitEvent(info);
            if (!blocked) {
              if (info?.status === 'allowed_warning') {
                log(
                  `rate-limit warning: ${info.rateLimitType ?? 'window'} at ${
                    info.utilization != null ? `${Math.round(info.utilization * 100)}%` : 'high'
                  } utilization`,
                );
              }
            } else {
              yield {
                type: 'error',
                message: blocked.message,
                retryable: false,
                classification: blocked.classification,
              };
            }
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
            const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
            const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
            // Not a `result`: a synthetic result without a <message> block triggers the re-send nudge and the agent
            // duplicates its previous message.
            log(`Context compacted${detail}.`);
            yield { type: 'activity' };
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
            const tn = message as { summary?: string; status?: string; tool_use_id?: string };
            const toolName = tn.tool_use_id ? toolNameById.get(tn.tool_use_id) : undefined;
            // An ASYNC subagent's quota death lands here, not on the PostToolUse hook.
            const asyncQuotaError = subagentQuotaFromTaskNotification(tn, toolName);
            if (asyncQuotaError) {
              if (!subagentQuotaError) subagentQuotaError = asyncQuotaError;
              const split = asyncQuotaError.indexOf(': ');
              log(
                `Subagent hit ${asyncQuotaError.slice(0, split)} — interrupting turn so poll-loop can rotate: ` +
                  asyncQuotaError.slice(split + 2),
              );
              // Yield the label BEFORE throwing: the throw unwinds straight to poll-loop, so this is the last chance
              // to tell the user why the turn restarted.
              yield {
                type: 'progress',
                message: formatBlockquoteLabel('↻', "subagent hit the credential slot's limit — rotating and retrying"),
              };
              try {
                void sdkResult.interrupt()?.catch?.((err: unknown) => {
                  log(`Subagent quota interrupt failed: ${err instanceof Error ? err.message : String(err)}`);
                });
              } catch (err) {
                log(`Subagent quota interrupt threw: ${err instanceof Error ? err.message : String(err)}`);
              }
              // Thrown directly: an interrupted stream may never emit another message.
              throw new Error(subagentQuotaError);
            }
            if (shouldForwardTaskNotification(toolName)) {
              const summary = tn.summary || 'Task notification';
              const emoji = (tn.status && TASK_NOTIFICATION_EMOJI[tn.status]) || '🔧';
              yield { type: 'progress', message: formatBlockquoteLabel(emoji, summary) };
            }
          } else if (
            message.type === 'system' &&
            (message as { subtype?: string }).subtype === 'background_tasks_changed'
          ) {
            const payload = message as { tasks?: { task_id?: string; ambient?: boolean; task_type?: string }[] };
            liveBackgroundTasks.clear();
            for (const t of Array.isArray(payload.tasks) ? payload.tasks : []) {
              if (t && typeof t.task_id === 'string' && t.ambient !== true) liveBackgroundTasks.add(t.task_id);
            }
            if (liveBackgroundTasks.size > 0) backgroundHold = true;
            if (idleSeenWithHold) {
              for (const id of liveBackgroundTasks) {
                if (!idleCoveredTasks.has(id)) {
                  // Evidence and its scope go together: drop both.
                  idleSeenWithHold = false;
                  idleCoveredTasks = new Set();
                  break;
                }
              }
            }
            const releasedAtDrain = liveBackgroundTasks.size === 0 && idleSeenWithHold;
            if (releasedAtDrain) {
              // The CLI already went idle over these tasks and no idle follows this drain, so this is the release.
              backgroundHold = false;
              idleSeenWithHold = false;
              idleCoveredTasks = new Set();
            }
            log(
              `Background tasks: ${liveBackgroundTasks.size} live` +
                (releasedAtDrain ? ' (hold released at drain)' : backgroundHold ? ' (hold)' : ''),
            );
            if (releasedAtDrain) yield { type: 'background_work', live: 0 };
          } else if (
            message.type === 'system' &&
            (message as { subtype?: string }).subtype === 'session_state_changed'
          ) {
            sessionStateSeen = true;
            if ((message as { state?: string }).state === 'idle') {
              const unansweredPrompts = stream.settle();
              if (unansweredPrompts.length > 0) yield { type: 'settled', unansweredPrompts };
              // Report the background level HERE, not at the membership change: the CLI withholds idle while
              // background agents run (CLI 2.1.272), so `live: 0` at idle confirms no follow-up turn is coming.
              if (liveBackgroundTasks.size === 0) backgroundHold = false;
              else if (backgroundHold) {
                idleSeenWithHold = true;
                idleCoveredTasks = new Set(liveBackgroundTasks);
              }
              yield { type: 'background_work', live: liveBackgroundTasks.size };
            }
          } else if (message.type === 'assistant') {
            const blocks = (message as { message?: { content?: unknown } }).message?.content;
            // A subagent's assistant messages ride this stream too; only the parent speaks to people.
            const topLevel = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id == null;
            // Top-level only: a subagent's usage measures ITS context window, not ours.
            if (topLevel) {
              recordContextTokens(claudeContextOccupancy(message.message?.usage));
              // What actually answered, not what was asked for: `opus` stays an alias until the API serves it.
              recordServedModel(message.message?.model);
            } else {
              // A subagent frame: which worker ran and on which model, both OBSERVED. Effort is not on the frame and
              // stays null rather than parsed from a type name like `worker-xhigh`. Keyed by parent_tool_use_id, so a
              // worker streaming many frames counts once.
              const key = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
              if (key) {
                recordSubagent(key, {
                  type: (message as { subagent_type?: string }).subagent_type ?? null,
                  model: message.message?.model ?? null,
                });
              }
            }
            if (Array.isArray(blocks)) {
              let sawToolUse = false;
              for (const block of blocks) {
                const b = block as { type?: string; id?: string; name?: string; text?: unknown };
                if (b.type === 'tool_use' && b.id && b.name) toolNameById.set(b.id, b.name);
                if (!topLevel) continue;
                // Text is mid-turn only once a tool call follows it, possibly in a later message. Text still pending
                // at `result` is the final text the result carries, so it is never emitted twice.
                if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
                  pendingAssistantText = pendingAssistantText ? `${pendingAssistantText}\n${b.text}` : b.text;
                } else if (b.type === 'tool_use') {
                  sawToolUse = true;
                }
              }
              // A message that calls a tool is not the turn's last, so ALL buffered text is mid-turn, including text
              // after the tool_use block.
              if (sawToolUse && pendingAssistantText) {
                const text = pendingAssistantText;
                pendingAssistantText = null;
                yield { type: 'interim_text', text };
              }
            }
            // The label group shares one throttle window; it is not a per-label rate limit.
            const labels = deriveProgressLabels(message);
            if (labels.length > 0) {
              const now = Date.now();
              if (now - lastToolProgressAt >= TOOL_PROGRESS_MIN_INTERVAL_MS) {
                for (const label of labels) {
                  yield { type: 'progress', message: label };
                }
                lastToolProgressAt = now;
              }
            }
          }
        }
      } catch (err) {
        if (aborted) return;
        throw err;
      }
      // Second, load-bearing gate: `interrupt()` may end the stream with no further message, so the top-of-loop check
      // never runs again and the turn would complete silently with a dead subagent.
      if (subagentQuotaError) throw new Error(subagentQuotaError);
      log(`Query completed after ${messageCount} SDK messages`);
    }

    // Updated by applySettings so an effort-only change clamps against the model actually in effect.
    let activeModel = model;
    // Same for effort, which `result` stamps onto usage. `activeRequestedEffort` is the PRE-clamp value, which tells a
    // Haiku turn ("high configured, none sent") apart from one never configured.
    let activeEffort = effort;
    let activeRequestedEffort = requestedEffort;
    // How many times the effort MOVED during the current turn; any movement makes that turn's usage unattributable
    // (NULL). The SDK merges a follow-up pushed mid-turn into that turn's single `result`, and comparing endpoints
    // misses high → low → high. Cleared only at `result`: whether a push starts or merges into a turn is unknowable
    // at push time. A change BETWEEN turns therefore also NULLs the next turn; declining to answer is safe, a
    // confidently wrong effort is not.
    let effortTransitionsThisTurn = 0;
    // Separate from activeModel, which must stay in the form setModel/clampEffortForModel expect; attribution can only
    // compare canonical ids (see canonicalUsageModel).
    let activeUsageModel = canonicalUsageModel(model, perQueryEnv);

    return {
      push: (msg) => stream.push(msg),
      initialPromptId,
      // Holds the turn level while a prompt is unanswered, until its echo or the CLI's idle; there is no runner-side
      // timer, and the 30-minute ceiling stays the bound.
      hasQueuedWork: () => sessionStateSeen && stream.outstanding.size > 0,
      // Background agents outlive their launching turn and report back into this stream; holding busy while any are
      // live keeps the task reaper off the container (see backgroundHold). Gated on sessionStateSeen: the release
      // arrives only behind CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, so a CLI without it must not pin a container.
      hasBackgroundWork: () => sessionStateSeen && backgroundHold,
      backgroundForegroundTools: (minAgeMs) => {
        const calls = backgroundableToolsInFlight();
        for (const { id, tool, startedAt } of calls) {
          if (backgroundScheduled.has(id)) continue;
          backgroundScheduled.add(id);
          const timer = setTimeout(
            () => {
              if (aborted || !toolsInFlight.has(id)) return;
              const failed = (err: unknown) =>
                log(`backgroundTasks(${tool} ${id}) failed: ${err instanceof Error ? err.message : String(err)}`);
              try {
                sdkResult.backgroundTasks(id).then((moved) => {
                  log(
                    moved
                      ? `Moved ${tool} ${id} to the background so a waiting message is read now`
                      : `backgroundTasks(${tool} ${id}) matched no foreground task`,
                  );
                }, failed);
              } catch (err) {
                failed(err);
              }
            },
            Math.max(0, startedAt + minAgeMs - Date.now()),
          );
          timer.unref?.();
        }
        return calls.length;
      },
      end: () => stream.end(),
      events: translateEvents(),
      // The SDK installs systemPrompt at query creation and has no control request to replace it.
      requiresRestartForRuntimeContext: true,
      // A getter so creation and a mid-stream retarget cannot report different models.
      get resolvedModel() {
        return activeModel;
      },
      // The effort that actually RAN, after precedence and clamp. Status must read this: `querySettings.effort` holds
      // user intent only.
      get resolvedEffort() {
        return activeEffort ?? null;
      },
      abort: () => {
        aborted = true;
        stream.end();
        // Idempotent: aborting an already-aborted controller is a documented no-op.
        queryAbortController.abort();
      },
      // Re-runs query()'s effort chain so a model switch without -e lands on the new model's family default.
      applySettings: async (s) => {
        // `s.model === undefined` means LEAVE THE LIVE MODEL UNCHANGED: a flagless mid-turn message resolves to it,
        // and reinterpreting it would drag a one-shot `-m1` turn off its model mid-answer. To retarget, pass the model
        // explicitly. Effort, by contrast, is recomputed for the model in force on every call.
        const newModel = s.model ? ensureOpus1mSuffix(s.model) : undefined;
        if (newModel && newModel !== activeModel) {
          await sdkResult.setModel(newModel);
          activeModel = newModel;
          // A live `-m sonnet` arrives as a bare alias too, so re-resolve the attribution target.
          activeUsageModel = canonicalUsageModel(newModel, perQueryEnv);
        }
        const requested =
          s.effort ??
          this.stickyConfig.effort ??
          process.env.NANOCLAW_EFFORT_OVERRIDE ??
          defaultEffortForModel(activeModel);
        const clamped = clampEffortForModel(activeModel, requested);
        if (clamped === 'max') {
          // Settings.effortLevel has no 'max': throw so the poll-loop reopens the query, where effort accepts max.
          throw new Error("effortLevel control cannot express 'max'");
        }
        const settings: { effortLevel: 'low' | 'medium' | 'high' | 'xhigh' | null; ultracode?: boolean } = {
          effortLevel: (clamped as 'low' | 'medium' | 'high' | 'xhigh' | undefined) ?? null,
        };
        if (s.ultracode !== undefined) settings.ultracode = s.ultracode;
        await sdkResult.applyFlagSettings(settings);
        // Only AFTER the control request lands, so a throw leaves the trackers describing what is really in effect.
        // Counted only when the value MOVES: model-only changes call this too.
        if (clamped !== activeEffort || requested !== activeRequestedEffort) effortTransitionsThisTurn++;
        activeEffort = clamped;
        activeRequestedEffort = requested;
        log(
          `applySettings (live): model=${activeModel} effort=${clamped ?? '(none)'}` +
            `${s.ultracode !== undefined ? ` ultracode=${s.ultracode}` : ''}`,
        );
      },
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
registerProviderConfigSchema('claude', claudeConfigSchema);
