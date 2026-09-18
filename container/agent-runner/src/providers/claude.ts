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
import { TIMEZONE, formatLocalStamp } from '../timezone.js';
import { shimCwd } from './cwd-shim.js';
import { parseSlotUsageSurvey, surveyEntryToUsageResponse, SLOT_USAGE_SURVEY_ENV } from './claude-slot-usage.js';
import { attachTurnEffort } from './turn-effort.js';
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

// Per D9 / D7 / A6: the runtime schema is compiler-checked against the SDK.
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
}

/**
 * The SDK reports `resetsAt` as either epoch seconds or epoch ms (observed
 * both); normalize to the project's ISO-8601 UTC storage convention.
 */
function resetsAtIso(resetsAt: number | undefined): string | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null;
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  return new Date(ms).toISOString();
}

/**
 * SDK rate-limit events are telemetry unless the SDK explicitly rejects the
 * request. Rejected credit exhaustion is quota; other rejected windows are
 * transient rate limits and retain their reset metadata.
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
 * Structured `/usage` response — the plan-utilization PULL.
 *
 * `rate_limit_event` above is EVENT-GATED: the SDK emits it only when there
 * is something to warn about, so utilization readings existed only for
 * accounts already past ~84%. Measured live 2026-08-25: one agent group had
 * 29 readings (0.84 -> 0.96) and every other group, including the heaviest,
 * had zero. No baseline, no trajectory. This control request answers for
 * every window on every account regardless of utilization.
 *
 * Typed structurally rather than imported from the SDK: the method is
 * explicitly experimental and the shape is documented as unstable, and a
 * removed type export would break `bun run typecheck` on an otherwise fine
 * SDK bump. Only the fields read below are declared.
 */
interface SdkUsageWindow {
  /** Percentage 0-100 (NOT the 0-1 fraction rate_limit_event reports). */
  utilization?: number | null;
  resets_at?: string | null;
}
interface SdkUsageResponse {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: Record<string, SdkUsageWindow | null | undefined> | null;
}

/**
 * Operator-declared lane for an OAuth slot, from `CLAUDE_CODE_OAUTH_LANES`
 * (`"1:agentic-primary,3:shared-dev"` — slot number, then label).
 *
 * Which slots are reserved for agents and which are shared with a human's
 * interactive login is INSTALL POLICY, not a fact about this code, so it is
 * declared in the operator's `.env` and never hardcoded here. An undeclared
 * slot returns null, which means "undeclared" — not "agentic".
 *
 * ponytail: parsed per call on a two-entry string, at most once per turn.
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

const USAGE_CONTROL_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

/**
 * Feature-detect the experimental usage control request, bound to its query.
 *
 * NEVER call this method by name without the check. The SDK's own doc comment
 * says the name WILL change when the API stabilizes, and
 * `container/agent-runner` is a read-only bind mount that deploys on the next
 * container respawn with NO build step — so a rename does not fail at build
 * time, it throws inside every live container on the fleet. Absent method =>
 * null => capture silently degrades to the `rate_limit_event` path, which is
 * exactly today's behavior.
 */
export function planUsagePuller(q: unknown): (() => Promise<SdkUsageResponse>) | null {
  const fn = (q as Record<string, unknown> | null | undefined)?.[USAGE_CONTROL_METHOD];
  return typeof fn === 'function' ? () => (fn as () => Promise<SdkUsageResponse>).call(q) : null;
}

/**
 * Translate one `/usage` response into sample rows.
 *
 * `rate_limits_available: false` (API key, Bedrock, Vertex, or a missing
 * profile scope) is a NORMAL answer, not an error — it yields one row with
 * `available: false` so "plan limits do not apply here" is recorded as a
 * fact. Never sampling at all yields no row. Collapsing those two states is
 * the absent-vs-empty bug class; keep them apart.
 *
 * A window the plan omits or reports as null is skipped rather than written
 * as a null reading. If that leaves nothing, one `available: true` row with
 * no window still records that the pull happened.
 *
 * Every pull row whose `utilization` is NULL says WHY in `status` — the
 * column that already exists to explain a row. Without it the three states
 * are indistinguishable to anyone reading the table who does not already
 * know what `available` means: they all look like a missing number.
 */
export function usageResponseToSamples(res: SdkUsageResponse, who: AccountIdentity): RateLimitSample[] {
  const base = {
    source: 'usage_pull' as const,
    ...who,
    subscriptionType: res.subscription_type ?? null,
    status: null,
  };
  if (res.rate_limits_available !== true || !res.rate_limits) {
    return [
      { ...base, available: false, limitType: null, utilization: null, resetsAt: null, status: 'not_applicable' },
    ];
  }
  const rows: RateLimitSample[] = [];
  for (const [limitType, w] of Object.entries(res.rate_limits)) {
    if (!w || typeof w.utilization !== 'number') continue;
    rows.push({
      ...base,
      available: true,
      limitType,
      // 0-100 here, 0-1 in storage (matching turn_usage.rate_limit_utilization
      // and rate_limit_event). Normalize at the seam, once.
      utilization: w.utilization / 100,
      resetsAt: w.resets_at ?? null,
    });
  }
  if (rows.length === 0) {
    return [{ ...base, available: true, limitType: null, utilization: null, resetsAt: null, status: 'no_window' }];
  }
  return rows;
}

/**
 * One pull per session per interval. The call is a network round-trip to the
 * claude.ai usage endpoint, so doing it every turn would put telemetry on the
 * hot path; utilization does not move meaningfully faster than this anyway.
 * Module scope IS per-session scope — one container serves exactly one session.
 */
const USAGE_PULL_MIN_INTERVAL_MS = 5 * 60_000;

/**
 * Deadline for one pull. The throttle above bounds how OFTEN we call; it says
 * nothing about how LONG a call takes, and those are different failure modes —
 * the one that bites is a call that neither resolves nor rejects.
 *
 * The SDK imposes no deadline of its own. Verified in sdk.mjs: `Query.request`
 * stores the resolver in `pendingControlResponses` keyed by request id and
 * settles ONLY when a matching control response arrives, or when the transport
 * closes and sweeps every pending entry. There is no timer anywhere on that
 * path. So an unanswered `get_usage` leaks a pending promise and a map entry
 * for the container's whole life.
 *
 * 10s is generous for a telemetry round-trip and far below the 5-minute
 * throttle, so a permanently hung endpoint can never accumulate more than one
 * in-flight pull.
 */
const USAGE_PULL_TIMEOUT_MS = 10_000;

let lastUsagePullAt = 0;
let warnedNoUsagePuller = false;
let usagePullTimeoutMs = USAGE_PULL_TIMEOUT_MS;

/**
 * Reject `p` if it has not settled within `ms`. A timed-out pull is NOT
 * SAMPLED — no row is written, exactly as for a transport error, and still
 * distinct from the `available: false` row that means "plan limits do not
 * apply here". Three states: sampled, not applicable, not sampled.
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`usage pull exceeded ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Test-only: clear the pull throttle between cases. `timeoutMs` shortens the
 * deadline so the hang path is testable without a 10s wait.
 */
export function _resetUsagePullThrottleForTesting(timeoutMs: number = USAGE_PULL_TIMEOUT_MS): void {
  lastUsagePullAt = 0;
  warnedNoUsagePuller = false;
  usagePullTimeoutMs = timeoutMs;
}

/**
 * Sample plan utilization, throttled. Fire-and-forget on purpose: a slow or
 * failed usage call must never delay or fail the turn it was sampled from —
 * this is telemetry, not correctness.
 */
function samplePlanUsage(q: unknown, who: AccountIdentity, now = Date.now()): void {
  if (now - lastUsagePullAt < USAGE_PULL_MIN_INTERVAL_MS) return;
  const pull = planUsagePuller(q);
  if (!pull) {
    // Log once, or an SDK rename silently reverts the fleet to event-only
    // capture and nobody notices for weeks.
    if (!warnedNoUsagePuller) {
      warnedNoUsagePuller = true;
      log(`SDK exposes no ${USAGE_CONTROL_METHOD}() — rate-limit capture falls back to rate_limit_event only`);
    }
    return;
  }
  // Advance BEFORE awaiting so a slow pull can't let a second one stack up.
  lastUsagePullAt = now;
  void withDeadline(pull(), usagePullTimeoutMs)
    .then((res) => recordRateLimitSamples(usageResponseToSamples(res, who)))
    .catch((err) => log(`rate-limit usage pull failed (telemetry only): ${err instanceof Error ? err.message : err}`));
}

/** Max chars per thinking label. Bumped from 500 — thinking prose is usually
 * multi-paragraph and the aggressive cap was cutting off useful reasoning. */
const LABEL_MAX = 2000;

/** Env gate: set NANOCLAW_HIDE_THINKING=1 to suppress thinking-block forwarding. */
function thinkingForwardingEnabled(): boolean {
  const v = process.env.NANOCLAW_HIDE_THINKING;
  return !v || v === '0' || v.toLowerCase() === 'false';
}

function truncate(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= LABEL_MAX) return trimmed;
  return trimmed.slice(0, LABEL_MAX - 1).replace(/\s+\S*$/, '') + '…';
}

/**
 * Derive ordered progress labels from an assistant message. Only thinking
 * blocks are forwarded — tool_use labels were dropped because the post-then-
 * edit chat UX shows one progress message at a time, so a tool_use label
 * emitted immediately after thinking would overwrite the reasoning text
 * within a second. Users wanted to read the thinking; the tool action is
 * implied by the context.
 *
 * Secret scrubbing happens host-side in delivery.ts (scrubSecrets catches
 * Bearer tokens, vendor-prefix keys, registered .env values) — the
 * container emits raw text and trusts the outbound filter.
 *
 * NANOCLAW_HIDE_THINKING=1 suppresses all progress forwarding.
 */
/**
 * Format a status label as a blockquote with a leading emoji. Prefixes
 * every line with `> ` so it renders as a blockquote — indented with a
 * vertical accent bar on Slack and Discord, visually distinct from a
 * real agent response. The orphan is deleted on final-chat delivery, so
 * it only ever lives mid-turn; blockquote reads more naturally than
 * monospace for live prose.
 */
function formatBlockquoteLabel(emoji: string, prose: string): string {
  const lines = prose.split('\n');
  lines[0] = `${emoji} ${lines[0]}`;
  return lines.map((line) => `> ${line}`).join('\n');
}

const TASK_NOTIFICATION_EMOJI: Record<string, string> = {
  completed: '✅',
  failed: '❌',
  stopped: '⏹',
};

/**
 * Tool names that launch a subagent, newest first.
 *
 * The tool is called **`Agent`** on this SDK — `sdk-tools.d.ts` declares
 * `AgentInput` (with `subagent_type` / `run_in_background`) and has no
 * `TaskInput` at all; `Task` is the OLD name, and the `Task*` types that do
 * still exist (`TaskCreateInput`, `TaskGetInput`, `TaskStopInput`,
 * `TaskOutputInput`) are the unrelated task-management tools. `Task` is kept
 * here only so an older CLI still classifies; do NOT drop it, and do NOT
 * assume either name is the live one.
 */
export const SUBAGENT_TOOL_NAMES = ['Agent', 'Task'] as const;

/**
 * Hook matcher covering every subagent tool name.
 *
 * Matcher semantics, verified against the installed CLI (2.1.258) rather than
 * assumed: a matcher of the plain-list shape `/^[a-zA-Z0-9_|]+$/` is split on
 * `|` and compared to the tool name by EXACT membership; only a matcher that
 * fails that shape test is compiled as an (unanchored) `new RegExp`. So
 * `'Agent|Task'` matches exactly those two tools and cannot leak onto
 * `TaskOutput` / `TaskStop` / `TaskCreate` the way an unanchored `Task` regex
 * would. The CLI's own config help states the same contract: "The matcher is
 * a string: a tool name ("Bash"), pipe-separated list ("Edit|Write"), or empty
 * to match all." (`HookCallbackMatcher.matcher?: string`, sdk.d.ts:867.)
 */
export const SUBAGENT_TOOL_MATCHER = SUBAGENT_TOOL_NAMES.join('|');

/**
 * The SDK fires `task_notification` for two very different things: real
 * subagent (Agent, formerly Task) completions AND auto-backgrounded Bash
 * commands. For a backgrounded Bash task the `summary` is the *raw command
 * text* (env-var unsets, pipelines, python heredocs) — internal noise that
 * leaked into user channels as "> ✅ <command>" and stranded there whenever
 * the command settled after the turn's real reply. Forward completion lines
 * only for genuine subagent work; a known non-subagent tool (Bash) is
 * suppressed. An unknown/absent tool_use_id means a planned task not tied to a
 * single tool — forward it (the case the feature was built for).
 *
 * Accepting `Agent` is load-bearing, not defensive: this SDK names the tool
 * `Agent`, so while this checked `'Task'` alone every real subagent's
 * notification was silently suppressed.
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

// No explicit `allowedTools` list is set. The SDK's `allowedTools` is
// "auto-allow without a permission prompt" (not an include-filter). Since
// we already run with `permissionMode: 'bypassPermissions'` +
// `allowDangerouslySkipPermissions: true`, every tool that the SDK
// surfaces is auto-allowed — enumerating them added zero protection and
// created a silent-regression risk: when the SDK added a new built-in
// (Task, TaskOutput, TeamCreate, ScheduleWakeup, etc.) and we forgot
// to append it here, the tool's user-visible command prompt would
// surface despite bypassPermissions — inconsistent UX. Omitting the
// enumeration keeps the surface open-by-default and relies on
// `disallowedTools` above for explicit blocks. v1 reached the same
// conclusion (src/agent-runner/index.ts:1056-1077 comment).

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
  /**
   * Every uuid this stream stamped on a prompt. The CLI echoes a consumed
   * prompt's uuid on the result of the turn that answered it
   * (`user_message_uuid`/`user_message_uuids` on SDKResultSuccess and
   * SDKResultError in sdk.d.ts) and echoes none on a turn it started itself.
   * Matching against this set, rather than accepting any echoed id, ignores
   * ids the CLI mints for its own queued work.
   */
  readonly stamped = new Set<string>();
  /**
   * Stamped prompts no result has echoed yet: accepted, not yet answered. The
   * CLI can answer a turn it started itself while one of these is still
   * queued behind it, so this, not the turn count, says whether work is
   * queued. An echo clears an id; so does `settle()` at idle.
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

  /** A result arrived: clear the prompts it echoed and return them. */
  answer(echoed: string[]): string[] {
    const answered = [...new Set(echoed)].filter((id) => this.stamped.has(id));
    for (const id of answered) this.outstanding.delete(id);
    this.settleable = new Set(this.outstanding);
    return answered;
  }

  /**
   * The CLI went idle: a prompt still outstanding since the last result was
   * consumed with no echo. The CLI does not go idle between queued turns, so
   * nothing it has yet to run is settled here. A prompt pushed after that
   * result is left alone too, since this idle may predate its arrival.
   *
   * The snapshot is taken when the runner READS a result, not when the CLI
   * produced it, so a prompt pushed in the milliseconds between can still be
   * settled at an idle that predates it and credited with that result.
   * Leaving recent pushes out instead would strand a prompt that really was
   * consumed with no echo: nothing would ever clear it, and the turn level
   * would stay up until the ceiling. One misattributed record in that race is
   * the cheaper failure.
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
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
export const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
export const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
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

    // The compatibility autosave is deliberately non-mutating. Topic
    // siblings share HEAD/index, so PreCompact must never stage or commit a
    // sibling's partial work; the persistent dirty worktree is the recovery
    // artifact.
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

// ── Credential rotation patterns ──

// ANTHROPIC_API_KEY _N fallback variants (_2, _5, ...). The base-name match
// (ANTHROPIC_KEY_RE) lives in secret-env.ts.
const ANTHROPIC_FALLBACK_RE = /^ANTHROPIC_API_KEY_(\d+)$/;

// CLAUDE_CODE_OAUTH_TOKEN (Claude Max subscription) _N fallback variants.
// Parallel rotation list to API-key fallbacks — when the host operates on
// OAuth (no ANTHROPIC_API_KEY), retryable errors advance through these.
const OAUTH_FALLBACK_RE = /^CLAUDE_CODE_OAUTH_TOKEN_(\d+)$/;

// Retryable upstream errors. v1's list — see
// container/agent-runner/src/index.ts:470-478.
// `subscription_quota_exhausted` is our own marker (see QUOTA_RESULT_RE
// below) — when the SDK returns the Claude Max quota message as a
// normal result text instead of throwing, we re-throw with this prefix
// so the existing rotation+retry path picks it up.
const RETRYABLE_ERROR_RE =
  /429|rate[\s_-]?limit|overloaded|upstream_error|External provider returned|subscription_quota_exhausted|subscription_access_disabled/i;

// Result-text quota/access classification is SDK-free and shared with the
// constrained cross-model review launcher. Keeping one classifier prevents a
// new Claude wording from healing native rotation while silently blocking it
// for review calls (or the reverse).

// Poisoned continuation: the SDK surfaces the thinking-signature 400 as plain
// result text ("API Error: 400 ... Invalid `signature` in `thinking` block"),
// not a thrown error — same delivery quirk as QUOTA_RESULT_RE above, so the
// catch-block isSessionInvalid path never fires on its own. Detect and
// re-throw; the message keeps the original text so STALE_SESSION_RE matches
// and poll-loop's stale-session branch clears the continuation and retries
// with a recap. See STALE_SESSION_RE for how continuations get poisoned.
export const POISONED_CONTINUATION_RE = /invalid `?signature`? in `?thinking`? block/i;

// Transient server-side rate limit / overload (HTTP 429/529). After the Claude
// binary exhausts its OWN internal api_retry attempts, it renders the failure
// as the turn's RESULT TEXT (not a thrown error, not a rate_limit_event) via
// `Ml({content, error:"rate_limit"})`:
//   "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited"
//   "API Error: Request rejected (429) · …"
// Without interception the poll-loop dispatches this 88-char string to the
// user's channel as the agent's answer and ends the turn silently — the user
// then has to re-prompt (Operator, 2026-06-26: "extremely disrupting" on long
// tasks). Throw with a distinct `transient_overload:` marker so poll-loop's
// catch retries the SAME prompt+continuation with backoff. Rotation is the
// WRONG cure here — "not your usage limit" means the credential is fine, the
// server is busy; another key hits the same overloaded server.
//
// Anchored on the rendered "API Error:" prefix + the specific server-limit
// phrase so an agent quoting these words in prose can't trip it (a normal
// result is the agent's own text, never prefixed "API Error:").
//
// Same single-source body/anchored/embedded split as QUOTA_PATTERN_BODY, for
// the same reason: the subagent classifier needs the EMBEDDED form (a
// subagent's transient overload arrives wrapped in the CLI's
// "Agent terminated early due to an API error: …" template, so the prefix is
// no longer at position 0), while the top-level result path keeps the
// anchored form. Two hand-maintained copies would drift, and the drift is
// silent in the worst direction: a transient overload misread as quota
// exhaustion burns a credential slot rotating away from a server that is
// merely busy.
const TRANSIENT_OVERLOAD_PATTERN_BODY =
  'API Error:\\s*(?:Server is temporarily limiting requests|Request rejected \\(429\\))';

export const TRANSIENT_OVERLOAD_RESULT_RE = new RegExp(`^${TRANSIENT_OVERLOAD_PATTERN_BODY}`, 'i');

/** Unanchored twin of TRANSIENT_OVERLOAD_RESULT_RE — see QUOTA_EMBEDDED_RE. */
export const TRANSIENT_OVERLOAD_EMBEDDED_RE = new RegExp(TRANSIENT_OVERLOAD_PATTERN_BODY, 'i');

// ── Subagent quota exhaustion (PostToolUse: Task) ──

/**
 * What the parent agent sees in place of a quota-exhausted subagent's output.
 *
 * Two hard requirements:
 *  - It must NOT match QUOTA_EMBEDDED_RE / SUBSCRIPTION_BLOCKED_EMBEDDED_RE.
 *    The hook rewrites the tool output it just matched on; text that
 *    re-matched would make every replayed turn look quota-exhausted again.
 *    The self-match guard lives in claude.subagentQuota.test.ts.
 *  - It must not repeat the SDK's "ask your admin to raise it at
 *    claude.ai/settings/usage" remediation. The bug this whole path fixes is
 *    the parent reading that sentence as an instruction and telling the user
 *    to go raise their org limits — which is neither true nor actionable when
 *    the real fix is rotating to the next credential slot.
 */
export const SUBAGENT_QUOTA_REPLACEMENT_TEXT =
  '[nanoclaw] The subagent was aborted before it produced any result: the credential slot ' +
  'it was running on stopped serving requests. The parent turn is being aborted and replayed ' +
  'automatically on the next credential slot. This is infrastructure, not a task outcome — do ' +
  'not report it as a finding, do not act on anything the subagent returned, and do not ask ' +
  'anyone to change an account, billing, or plan setting.';

/**
 * Flatten a PostToolUse `tool_response` (typed `unknown`) to text we can run
 * the quota regexes over. The Agent tool's (formerly Task) result is normally
 * an array of content blocks, but the field is untyped by contract — a string, a bare
 * object, or something unexpected are all legal. Never throws; depth-capped so
 * a cyclic structure can't spin.
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

// ── Tier 2: the CLI's structured termination template ──
//
// Tier 1 (QUOTA_EMBEDDED_RE / SUBSCRIPTION_BLOCKED_EMBEDDED_RE) enumerates
// PROSE, and prose is not a stable contract: four times now a new Anthropic
// wording has slipped past it and silently killed rotation (see the incident
// list on QUOTA_PATTERN_BODY). Tier 2 stops guessing at the sentence and keys
// off the wrapper the CLI puts around EVERY subagent API death instead.
//
// Verified against the claude 2.1.259 binary. `AgentApiErrorTerminationError`
// is constructed as `Agent terminated early due to an API error: ${body}`,
// where `body` is the model's own error prose followed by a parenthesized
// field list assembled from `error`, `apiErrorStatus`, `requestId` and the
// model name and joined with ", ":
//
//   Agent "<desc>" failed: Agent terminated early due to an API error: <prose>
//   (error type rate_limit, HTTP 429, request id req_…, model sent to the API: …)
//
// The prose slot changes; the wrapper and the field list do not. Both subagent
// surfaces carry it — a synchronous Agent tool_result and an async
// task_notification summary — so one pair of patterns covers both.
//
// `error type rate_limit, HTTP 429` is the credential-side signal. It is NOT
// sufficient on its own: a TRANSIENT server overload also renders as
// error type rate_limit / HTTP 429, and rotating away from a busy server is
// the wrong cure (see TRANSIENT_OVERLOAD_RESULT_RE). The transient exclusion
// in classifySubagentQuotaText is therefore load-bearing, not belt-and-braces.

/** The CLI wrapper around any subagent that died on an API error. */
export const AGENT_API_ERROR_TERMINATION_RE = /Agent terminated early due to an API error/i;

/**
 * The parenthesized field list's rate-limited opening. Whitespace is flexible
 * because the field list is a `join(', ')` whose spacing is not a contract;
 * the field ORDER is (`error`, `apiErrorStatus`), and `error` is only omitted
 * when the API returned no error kind at all — in which case there is nothing
 * to classify anyway.
 */
export const AGENT_API_RATE_LIMIT_SUFFIX_RE = /\(\s*error\s+type\s+rate_limit\s*,\s*HTTP\s+429\b/i;

/** Marker a subagent-quota detection throws under, consumed by poll-loop's rotation catch. */
export type SubagentQuotaMarker = 'subscription_quota_exhausted' | 'subscription_access_disabled';

/**
 * The one classifier both subagent-quota detection sites run.
 *
 * A subagent's quota death reaches the parent turn on TWO different surfaces
 * depending on how it was launched: a synchronous Agent call carries the prose
 * in its `tool_response` (the PostToolUse hook below), while an ASYNC subagent
 * returns "Async agent launched successfully…" immediately and reports its
 * death later as a `system`/`task_notification` summary. Same wording, two
 * seams — so the decision lives here once, for the same reason the pattern
 * bodies above are single-source: two hand-maintained copies drift, and the
 * drift is silent (one surface keeps rotating, the other stops).
 */
export function classifySubagentQuotaText(text: string): SubagentQuotaMarker | null {
  if (!text) return null;
  // Tier 1 — known prose. Runs first because it is the only tier that can tell
  // an org access block apart from a quota exhaustion.
  if (QUOTA_EMBEDDED_RE.test(text)) return 'subscription_quota_exhausted';
  if (SUBSCRIPTION_BLOCKED_EMBEDDED_RE.test(text)) return 'subscription_access_disabled';
  // Tier 2 — the CLI's structured termination template, for a wording tier 1
  // has never seen. Excluding the transient-overload forms is what keeps this
  // from rotating away from a merely busy server.
  if (
    AGENT_API_ERROR_TERMINATION_RE.test(text) &&
    AGENT_API_RATE_LIMIT_SUFFIX_RE.test(text) &&
    !TRANSIENT_OVERLOAD_EMBEDDED_RE.test(text)
  ) {
    return 'subscription_quota_exhausted';
  }
  return null;
}

/** Collapse whitespace and cap at the length the throw message carries. */
function quotaSnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Decide whether a `system`/`task_notification` message is an ASYNC subagent
 * that died on the credential slot's quota. Returns the `<marker>: <snippet>`
 * throw message, or null to leave the notification alone.
 *
 * This is the async twin of createSubagentQuotaHook. An agent that launches a
 * subagent asynchronously gets an `Agent` `tool_result` of just "Async agent
 * launched successfully…" — nothing for the PostToolUse hook to match on. The
 * failure arrives later as this notification (verbatim, 2026-09-02 03:17 UTC:
 * `status: failed`, summary `Agent "…" failed: Agent terminated early due to
 * an API error: You've hit your session limit · resets 12am …`), which the CLI
 * also folds back into the session as a `<task-notification>` user message
 * that auto-continues the turn — so without this, the parent runs on with a
 * dead subagent and no rotation ever happens.
 *
 * Three conditions, all required:
 *  - `status === 'failed'` — strict. The SDK's vocabulary is exactly
 *    'completed' | 'failed' | 'stopped' (SDKTaskNotificationMessage in
 *    sdk.d.ts), and a completed/stopped subagent whose summary merely QUOTES
 *    the quota string is a report, not an outage. This is the false-positive
 *    framing the synchronous surface has no equivalent of.
 *  - a real subagent, not a backgrounded Bash command whose summary is raw
 *    command text — same classification the forwarding path uses.
 *  - the shared classifier matches the summary.
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
 * PostToolUse hook matched on the subagent tool — `Agent` on this SDK,
 * formerly `Task`, hence SUBAGENT_TOOL_MATCHER covering both: catch Claude Max
 * quota exhaustion (or an org access block) that a SUBAGENT hit.
 *
 * A subagent's quota failure never becomes a top-level `type:'result'` — it
 * comes back as a tool_result inside the parent's still-running turn, so the
 * result-branch throws below never fire, no rotation happens, and the parent
 * reads "…ask your admin to raise it…" as an instruction.
 *
 * Rotation cannot happen mid-flight (the CLI subprocess is started with this
 * query's env, so the credential is fixed for the query's life — see the
 * comment on `oauthSlot` in query()). Recovery therefore requires aborting the
 * query and letting poll-loop's existing rotation/retry machinery replay the
 * turn. So this hook does two things: it records the detection for
 * translateEvents to throw on, and it interrupts the query so the turn
 * actually stops instead of running on with a dead subagent.
 *
 * The rewrite is belt-and-braces: if the abort races the next model request,
 * the misleading prose still never enters the parent's context.
 */
export function createSubagentQuotaHook(options: {
  /** Called once per detection with the full `<marker>: <text>` throw message. */
  onDetect: (markedMessage: string) => void;
  /** Aborts the in-flight query (i.e. `sdkResult.interrupt`). */
  interrupt: () => Promise<unknown>;
}): HookCallback {
  return async (input) => {
    try {
      const i = input as PostToolUseHookInput;
      const text = stringifyToolResponse(i.tool_response);
      if (!text) return { continue: true };

      const marker = classifySubagentQuotaText(text);
      // No match: return NO rewrite at all. An identity rewrite here would
      // race sibling PostToolUse hooks last-write-wins and could clobber a
      // real redaction (sdk.d.ts, PostToolUseHookSpecificOutput).
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

// Credential model for container shells: secret-env.ts (SDK-free).

// `codex exec` reads stdin IN ADDITION to the prompt arg — codex's own help:
// "If stdin is piped and a prompt is also provided, stdin is appended as a
// <stdin> block". The agent's Bash tool leaves stdin open (a pipe with no EOF),
// so codex blocks forever on that read, gets killed at the turn timeout, and
// its block-buffered output is lost — surfacing as "codex exec hangs, zero
// output" (2026-06-27; my own earlier `docker exec` tests EOF'd stdin and
// masked it). Wrapping the command group's stdin to /dev/null gives codex an
// immediate EOF so it runs with just the prompt. An explicit `< file` on codex,
// or a `… | codex` pipe, still wins (inner/pipe redirect binds closer), so
// deliberate piped input is preserved; only the unused-open-stdin hang changes.
const CODEX_EXEC_RE = /\bcodex\s+exec\b/;
const ALREADY_DEVNULL_STDIN_RE = /<\s*\/dev\/null\b/;

// Two concurrent jest runs will OOM-kill this container no matter how each one
// is configured. On 2026-08-09 one agent had two background suites going and
// its container was OOM-killed 109 times in a single session; two siblings hit
// 46 and 36. Worker sizing (XZO PR #691) bounds ONE run to fit the cgroup, but
// a run cannot see a sibling process, so the multiplication survives it.
//
// The invariant is "one jest at a time in this container", and the mechanical
// form of that is a lock on the resource, not a rule about intent. `flock -n`
// fails immediately rather than queueing: a second suite that waits would sit
// there burning the turn and then die at the idle ceiling anyway, so refusing
// with a message the agent can act on is strictly better.
//
// Deliberately NOT a "did you pass a path filter" check. That polices intent,
// is trivially lawyered (`--testPathPattern .`), and misses the actual failure —
// two *small* suites at once OOM just as dead as one big one.
//
// The oom_kill delta is the other half. Killed workers surface to jest as
// ordinary test failures, so an OOM-shredded run reads as "93 tests failed" and
// an agent chases phantom assertions — the same fail-open shape as every other
// silent failure this fleet has hit. Reporting the delta turns that into a
// visible "results void".
const JEST_RE = /(?:^|[\s;&|(])(?:npx\s+)?jest\b|\bnpm\s+(?:run\s+)?test\b|\byarn\s+(?:run\s+)?test\b/;
const ALREADY_FLOCKED_RE = /\bflock\b/;
const JEST_LOCK = '/tmp/.nanoclaw-jest.lock';

/** Serialise jest and report any OOM kills the run took. Exported for tests. */
export function wrapJestSerialized(command: string): string {
  // cgroup v2 exposes the counter; when it is absent (v1, or no cgroupfs) the
  // reads yield empty and the delta is simply skipped rather than failing.
  const oomRead = `$(awk '/^oom_kill /{print $2}' /sys/fs/cgroup/memory.events 2>/dev/null)`;
  return [
    `__nc_oom0=${oomRead};`,
    `flock -n -E 126 ${JEST_LOCK} bash -c ${JSON.stringify(command)};`,
    '__nc_rc=$?;',
    `__nc_oom1=${oomRead};`,
    // `-E 126` because flock's DEFAULT conflict exit is 1 — the same code jest
    // returns for ordinary test failures, which would make a refused run and a
    // red suite indistinguishable. 126 is otherwise unused here.
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
 * Rewrites a Bash command before it runs: `/dev/null` stdin for `codex exec`
 * (CODEX_EXEC_RE) and the jest serialization lock (wrapJestSerialized). No
 * `unset <secrets>` prefix any more — see secret-env.ts's header.
 */
export function createBashCommandRewriteHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};
    const wrapCodexStdin = CODEX_EXEC_RE.test(command) && !ALREADY_DEVNULL_STDIN_RE.test(command);

    let rewritten = command;
    if (wrapCodexStdin) rewritten = `{ ${rewritten} ; } </dev/null`;
    // After the codex wrap, so a `codex exec` that itself runs jest keeps its
    // /dev/null stdin.
    if (JEST_RE.test(command) && !ALREADY_FLOCKED_RE.test(command)) {
      rewritten = wrapJestSerialized(rewritten);
    }
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

// ── Shared block-destructive-core evaluator loader ──
// The advisory bash guards (self-approval, snowflake-connector, git-clone) all
// delegate to PURE evaluators in the shared guard core (block-destructive-core.ts),
// the same module the OpenCode plugin and the Codex runner consume. Each adapter
// dynamic-imports it from the mounted bootstrap plugin (bun caches the module).
// The inline regexes below are a fail-CLOSED FALLBACK only, used when the mount
// is absent (e.g. unit tests, a plugin-less install). Single source of truth =
// the core; the fallbacks reproduce its verdict and must stay in sync.
type CommandEvaluator = (command: string) => { action: 'allow' | 'block'; reason?: string };

// Default container path to the mounted bootstrap guard core. Overridable via
// NANOCLAW_DESTRUCTIVE_GUARD_CORE (same env var the Codex runner uses) so unit
// tests can point at a fixture core. Resolved fresh per call so a test that sets
// the override sees it even after an earlier default-path attempt cached a miss.
const DEFAULT_GUARD_CORE_PATH =
  '/workspace/plugins/bootstrap/plugins/workflow-agents/hooks/guards/block-destructive-core.ts';
function guardCorePath(): string {
  return process.env.NANOCLAW_DESTRUCTIVE_GUARD_CORE || DEFAULT_GUARD_CORE_PATH;
}

// Memo keyed by `<resolvedPath>::<exportName>`: undefined = not yet attempted,
// null = unavailable/mistyped. Keying on the path means an override swap (tests)
// re-imports instead of returning a stale verdict for a different core.
const _coreEvaluators: Record<string, CommandEvaluator | null | undefined> = {};

/**
 * Dynamic-import a named pure evaluator from the shared guard core and validate
 * it is a function. Returns null (memoized) when the core can't be imported or
 * the export is missing / not a function — callers MUST then fall back to their
 * inline fail-closed policy.
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

// ── Self-approval block ──
// The bootstrap/plugins/workflow plugin's block-destructive hook gates
// destructive filesystem ops behind a file-based approval at
// `.claude-destructive-gate`. This hook prevents the agent from bypassing
// that gate by writing the approval file itself via Bash (`touch
// .claude-destructive-gate`, `echo … > .claude-destructive-gate`, etc.).
// Admin approval must come through the chat channel, not the agent's own
// filesystem writes. v1 `createSelfApprovalBlockHook` equivalent.
// Delegates to the shared core's evaluateSelfApproval; the inline regex is the
// fail-closed fallback when the core is unavailable.
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

    // Fallback: shared core unavailable/threw — apply the inline policy, fail-closed.
    if (SELF_APPROVAL_RE.test(command)) return denyBash(SELF_APPROVAL_BLOCK_MSG);
    return {};
  };
}

// ── Block ad-hoc Python snowflake.connector ──
// `snow` CLI is gated by destructive-operation controls (and scoped
// credential mounts); the Python connector bypasses those. Only blocks
// direct python execution — grep, echo, pip install, and existing
// scripts that happen to contain the string are unaffected.
//
// This is ADVISORY, not a security boundary. The regex is bypassable
// with base64-decoded source, heredocs, script files, or point-version
// binaries (python3.11). The real mitigation is only mounting Snowflake
// credentials when the snow CLI is actually invoked — a larger arch
// change. In the current model the hook nudges the agent toward `snow
// sql` for normal cases and raises the friction for unintended paths.
// Delegates to the shared core's evaluateSnowflakeConnector; the inline regex
// is the fail-closed fallback when the core is unavailable.
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

    // Fallback: shared core unavailable/threw — apply the inline policy, fail-closed.
    if (SNOWFLAKE_CONNECTOR_EXEC_RE.test(command)) return denyBash(SNOWFLAKE_CONNECTOR_BLOCK_MSG);
    return {};
  };
}

// ── Block the codex companion (/codex:* skills) in-container ──
// `/codex:rescue` and `/codex:review` both run `node …/codex-companion.mjs`,
// whose runAppServerTurn hardcodes a read-only/workspace-write OS sandbox.
// That sandbox cannot create its landlock/seccomp namespaces under nested
// Docker, so codex hangs at sandbox init — observed 2026-06-27: a turn frozen
// ~14s in with no output for 12+ min, misread as "the codex runtime is
// wedged" (it isn't — `codex exec --yolo` round-trips in ~13s and generates
// images fine). The container is already the isolation boundary; the correct
// in-container path is `codex exec --yolo` (danger-full-access, no inner
// sandbox). Block the companion with a redirect so the agent fast-fails to the
// working path instead of hanging. Lives here in NanoClaw (not the codex
// plugin) so a plugin-repo merge can't clobber it.
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

// ── Email gate ──
// Intercept agent-initiated outbound Gmail sends and require admin approval
// before the command runs. Two surfaces matter, both via the gws CLI:
//   1. Helper verbs:   gws gmail +send | +reply | +reply-all | +forward
//   2. Raw API form:   gws gmail users (messages|drafts) send …
// The raw form takes the same code path as the helper verbs and produces an
// identical send — an earlier version of this hook only matched (1), and an
// agent reaching for the raw API surface bypassed the gate entirely.
//
// Drafts are intentionally NOT gated when only being created
// (`gws gmail users drafts create`) — drafts never deliver until separately
// sent. The helper-verb `--draft` flag and `--dry-run` likewise bypass.
//
// Out of scope (cannot be caught at this layer reliably):
//   • Direct REST calls (curl/wget to gmail.googleapis.com).
//   • Python/Node SDK calls (`users.messages().send()`, nodemailer, etc.).
//   • SMTP CLIs (sendmail, swaks, msmtp) — none ship in the container image,
//     and `install_packages` is itself admin-gated.
//   • eval / alias / variable-indirection / base64-decoded subshells.
// The only sound place to catch all of those is the egress proxy. OneCLI
// 1.x's gateway only supports `block`/`rate_limit` rule actions today; when
// it grows an `approve` action this hook should become a UX-fast-path on top
// of the gateway rule rather than the source of truth.
//
// Approval round-trip uses the existing send_file delivery-ack surface:
// write a system action with action='request_bash_gate' to outbound.db;
// host's bash-gate module calls requestApproval and writes the decision
// back to inbound.db's `delivered` table; we poll it via
// awaitDeliveryAck. Up to 60 minutes (must match host-side BASH_GATE_TIMEOUT_MS).
export const GWS_EMAIL_SEND_RE =
  /\bgws\s+gmail\s+(?:\+(?:send|reply|reply-all|forward)|users\s+(?:messages|drafts)\s+send)\b/;
/** Inline mirror of email-gate-core.ts (this is the fail-closed FALLBACK, so it
 *  can't import the core). Keep in sync with the SoT. QA codex-#2/#3/#4. */
const EMAIL_BYPASS_FLAGS = new Set(['--dry-run', '--draft', '--help', '-h']);
// Includes `#` (comment: `… --body x # --dry-run` drops the flag at runtime) and
// the NEWLINE separator `\n\r` — the bypass check runs on the WHOLE command, so a
// `--dry-run\n<real send>` decoy must fail closed here (else `\s+` token-splitting
// treats the newline as whitespace and the decoy's --dry-run reads as real argv
// while bash runs the second line). Mirrors the SoT SHELL_METACHAR_RE.
// QA codex re-pass #4 (comment) + #5 (newline decoy).
const EMAIL_SHELL_METACHAR_RE = /[<>|;&$`(){}#\n\r]/;

/** A bypass flag (--dry-run/--draft/--help/-h) is honored only as a real argv
 *  token in a SIMPLE gws command: strip quoted content in all four bash quote
 *  forms (ANSI-C `$'…'` and locale `$"…"` first, then plain `'…'`/`"…"`,
 *  escape-aware), fail closed on unbalanced quotes, on any unquoted BACKSLASH
 *  (a shell escape — `--body \ --dry-run` joins `\ ` into the body so gws gets no
 *  real flag), OR any unquoted shell metacharacter (redirects / pipes /
 *  expansions / grouping / comments / newlines can divert the token from gws's
 *  argv while the mail still sends), then split on bash IFS (space/tab/newline,
 *  not JS \s) and match a whole flag token. After these rejections the tokens
 *  EXACTLY equal bash's argv words. Mirrors the SoT bypassFlagIsRealArgvToken.
 *  QA codex re-pass #1 (subshell) + #3 (redirection) + #4 (comment, ANSI-C)
 *  + #5 (newline) + #6 (backslash / non-IFS whitespace). */
// Non-IFS, non-flag, non-metachar placeholder for a stripped quoted span. Using
// a sentinel (not a space) keeps bash word-concatenation: `--body 'x'--dry-run`
// joins to one word `x--dry-run` (no real flag), so the replacement must keep it
// one token — a space would manufacture a bogus --dry-run (codex #7). Mirrors SoT.
const EMAIL_QUOTED_SPAN_SENTINEL = '\x00';
const EMAIL_LEADING_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Mirrors SoT bypassFlagIsRealArgvToken: quote→sentinel, reject quote/backslash/
 *  metachar, then bind to a DIRECT gws invocation (skip VAR=value, require first
 *  word `gws` so a wrapper like `exec -a --dry-run gws …` can't swallow the flag —
 *  codex #8) and honor a bypass flag only in OPTION position (not as a prior bare
 *  option's value). Fail-closed: every step only makes bypass LESS likely. */
function emailBypassIsRealArgvToken(gwsSegment: string): boolean {
  // Strip NON-expanding quotes first (single + ANSI-C $'…' — no expansion), then
  // fail closed on a `$(`/backtick inside an EXPANDING span ("…" / locale $"…"):
  // bash still runs COMMAND SUBSTITUTION there, so `--dry-run --body "$(gws …
  // +send --to victim)"` would shell out a REAL send before the no-op flag — the
  // NUL-strip would otherwise hide it from the metachar check. Inspect the span
  // CONTENT (capture group) so the locale `$` prefix isn't counted. Only command
  // substitution executes — bare `$VAR`/`$5` is parameter expansion, so a legit
  // `--body "cost is $5"` must still bypass. Mirrors SoT. (codex #126 P1)
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
  if (unquoted.includes('\\')) return false; // unquoted backslash escape → don't bypass (codex #6)
  if (EMAIL_SHELL_METACHAR_RE.test(unquoted)) return false;
  const tokens = unquoted.split(/[ \t\n]+/).filter((t) => t.length > 0); // bash IFS, not JS \s
  let i = 0;
  while (i < tokens.length && EMAIL_LEADING_ASSIGNMENT_RE.test(tokens[i])) i++; // skip VAR=value
  if (tokens[i] !== 'gws') return false; // direct gws invocation only, no wrapper (codex #8)
  for (let j = i + 1; j < tokens.length; j++) {
    if (!EMAIL_BYPASS_FLAGS.has(tokens[j])) continue;
    const prev = tokens[j - 1];
    const prevConsumesValue = prev.startsWith('-') && !prev.includes('='); // bare -x/--opt eats next word
    if (!prevConsumesValue) return true;
  }
  return false;
}

// Narrow read-only help form: optional export assignments, one direct gws
// invocation, then only stderr-to-stdout plus a bounded head reader. The
// regular argv verifier still proves help is a real gws option.
const EMAIL_SAFE_HELP_PROBE_RE =
  /^(?:export\s+(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|<>\x60$(){}#'"]+)(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s;&|<>\x60$(){}#'"]+)*\s+&&\s+)?((?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|<>\x60$(){}#'"]+\s+)*gws\s+gmail\s+(?:\+(?:send|reply|reply-all|forward)|users\s+(?:messages|drafts)\s+send)(?:\s+[^\s;&|<>\x60$(){}#'"]+)*)\s+2>&1\s*\|\s*head\s+-\d+\s*$/;

function emailSafeHelpProbeIsReadOnly(command: string): boolean {
  const match = command.match(EMAIL_SAFE_HELP_PROBE_RE);
  if (!match) return false;
  const gwsSegment = match[1];
  return /(?:^|[ \t])(?:--help|-h)(?:$|[ \t])/.test(gwsSegment) && emailBypassIsRealArgvToken(gwsSegment);
}

/**
 * Decode the RFC 822 envelope from `--json '{"raw":"<base64url>"}'` so the
 * approval card shows real recipient/subject when the agent uses the raw API
 * form. Returns {} on any failure — caller falls back to "unknown recipient".
 */
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

// Email-gate verdict shape (mirrors email-gate-core.ts EmailGateVerdict). PURE.
type EmailGateVerdict = { action: 'allow' | 'gate'; label?: string; summary?: string; reason?: string };
type EmailGateEvaluator = (command: string, env: { isScheduledTask: boolean }) => EmailGateVerdict;

// Default container path to the vendored email-gate core. Overridable via
// NANOCLAW_EMAIL_GATE_CORE for unit tests (mirrors the guard-core override).
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
 * Inline fail-CLOSED fallback that reproduces evaluateEmailSend's decision +
 * card-build when the shared core can't be imported (unit tests, plugin-less
 * install). Verbatim port of the policy in email-gate-core.ts so the fallback
 * can never drift OPEN relative to the core. Keep in sync with the core.
 */
function evaluateEmailSendInline(command: string, env: { isScheduledTask: boolean }): EmailGateVerdict {
  if (!command || !GWS_EMAIL_SEND_RE.test(command)) return { action: 'allow' };

  // Bypass ONLY when the WHOLE command is a single, simple send carrying a real
  // bypass flag — no shell separators, no metacharacters, no second command.
  // Checking the whole command (not a per-segment slice) collapses the decoy
  // class: `: gws gmail +send --dry-run; <real send>` contains a `;`, so the
  // metacharacter check refuses the bypass and the gate fires — whether the real
  // send is regex-visible OR obfuscated (`+se''nd`). A determined adversary can
  // still evade DETECTION at the shell layer (egress proxy is the sound boundary
  // — see email-gate-core.ts header), but no bypass-flag decoy rides past the
  // gate. The only shell-operator exception is the bounded read-only help
  // probe above. Keep in sync with email-gate-core.ts evaluateEmailSend.
  if (emailSafeHelpProbeIsReadOnly(command) || emailBypassIsRealArgvToken(command)) return { action: 'allow' };

  // Scheduled tasks intentionally bypass — v1 also did this so
  // automated email reports aren't prompted every run.
  if (env.isScheduledTask) return { action: 'allow' };

  // Card fields are extracted from the WHOLE command: in a decoy chain the real
  // send (and its recipient) may live in a segment that doesn't cleanly match
  // GWS_EMAIL_SEND_RE (obfuscated verb), so a per-segment pick can miss it. The
  // gate has already fired; the card is best-effort (raw command is in the
  // tool-call log). Mirrors email-gate-core.ts.
  const gwsSegment = command;

  // Parse the email envelope so the card shows structured fields
  // instead of raw shell. Each matcher handles both --flag 'quoted'
  // and --flag unquoted. Helper-verb sends carry envelope as flags;
  // raw-API sends carry it as base64url RFC 822 inside `--json '{"raw":…}'`.
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
  // Parse the sending identity from GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE.
  // Path convention: /home/node/.config/gws/accounts/<slug>.json.
  // The slug is the human-facing account name the user configured.
  const credsMatch = command.match(/GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=\S*?\/accounts\/([\w.-]+)\.json/);
  const fromAccount = credsMatch?.[1] ?? 'default';
  // Anchor to the four allowed helper verbs only — the prior `\+(\w[\w-]*)`
  // could capture spurious `+ABC` substrings from a base64 payload in the
  // raw-API form. Falls back to "send" for the raw form (which has no +verb).
  const action = gwsSegment.match(/\+(send|reply|reply-all|forward)\b/)?.[1] ?? 'send';
  const label = subject ? `Email ${action} to ${to}: "${subject}"` : `Email ${action} to ${to}`;

  // No `command` field on the payload → host's buildCardBody skips
  // its code-block branch entirely. Full raw command is still in the
  // SDK tool-call log for audit; we just don't surface shell noise
  // to the approver.
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

/** Derive the email verb for user-facing deny wording ("Email reply blocked: …").
 *  The core verdict carries only label/summary, not the bare verb, so re-derive
 *  it here the same way the core does. */
function emailActionVerb(command: string): string {
  const segments = command.split(/[;&|]\s*|\s*&&\s*|\s*\|\|\s*|\n/);
  const gwsSegment = segments.find((s) => GWS_EMAIL_SEND_RE.test(s)) ?? command;
  return gwsSegment.match(/\+(send|reply|reply-all|forward)\b/)?.[1] ?? 'send';
}

/** A dynamically-imported core verdict is trusted only when its action is a
 *  known value. Mirrors the codex-runner wellFormedVerdict guard so a malformed
 *  email-core return can't fall through to allow. */
function isWellFormedEmailVerdict(v: unknown): v is EmailGateVerdict {
  const a = (v as { action?: unknown } | null | undefined)?.action;
  return a === 'allow' || a === 'gate';
}

export function createEmailGateHook(opts?: {
  /**
   * Join the shared one-card-per-tool-call claim. Set ONLY by the in-tree Codex
   * chain, which knows the plugin adapter is gating the same tool call. See the
   * comment above `GateClaimApi`.
   */
  sharedApprovalClaim?: boolean;
}): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};

    // The rewrite hook no longer prepends an `unset …;` prefix (codex #126 F1
    // is moot), so the gate evaluates exactly what the agent wrote.
    const evalCommand = command;

    // Verdict (allow vs gate + pre-built card) comes from the shared core's
    // evaluateEmailSend; the inline evaluator is the fail-CLOSED fallback when
    // the core can't be imported. The faithful policy (scheduled bypasses,
    // interactive gates, --dry-run/--draft bypass) lives in the core.
    const isScheduledTask = process.env.NANOCLAW_IS_SCHEDULED_TASK === '1';
    const coreEvaluator = await loadEmailGateEvaluator();
    let verdict: EmailGateVerdict;
    if (coreEvaluator) {
      try {
        const v = coreEvaluator(evalCommand, { isScheduledTask });
        // A dynamically-imported core can return a malformed verdict (bad shape /
        // unknown action). Anything that isn't a well-formed allow|gate is
        // untrusted → fall back to the inline fail-CLOSED evaluator. Without this,
        // `{action:'bogus'}` / `{}` would hit the non-'gate' branch below and ALLOW
        // a real send unapproved. (codex #126 F2 — mirrors the codex-runner
        // verdict-shape guard.)
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

    // Approval round-trip — UNCHANGED from the pre-core implementation: write a
    // request_bash_gate system action to outbound.db and block on the host's
    // decision via awaitDeliveryAck (60 min, matches host BASH_GATE_TIMEOUT_MS).
    // Dynamic imports avoid any risk of circular-import with the DB module graph
    // during provider init.
    const { writeMessageOut } = await import('../db/messages-out.js');
    const { getSessionRouting } = await import('../db/session-routing.js');
    const { awaitDeliveryAck } = await import('../db/delivery-acks.js');

    // Share ONE card with the peer guard gating this same tool call. Opt-in per
    // the comment on `GateClaimApi`: never armed on the Claude path, where no
    // peer exists.
    const claimApi = opts?.sharedApprovalClaim ? await loadGateClaimApi() : null;
    const toolUseId = (pre as { tool_use_id?: unknown }).tool_use_id;
    // Keyed on the tool call and the gate, NOT the command: this hook gates the
    // SANITIZED command while the plugin adapter gates the raw one (codex hands
    // every handler one `input_json`, built before any of them runs), so a
    // command-keyed claim would give each its own card again.
    const claimKey =
      claimApi && typeof toolUseId === 'string' && toolUseId
        ? claimApi.gateClaimKey(toolUseId, 'request_bash_gate')
        : null;
    if (claimKey && claimApi) {
      const claim = claimApi.claimGateRequest(claimKey);
      if (!claim.owner && claim.requestId && !claimApi.gateRequestAlreadyDecided(claim.requestId)) {
        // A peer staged this exact card. Wait on ITS decision so the human
        // answers once and both guards honour that one answer.
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
      // We own the claim, or nobody published in time. Both stage below; the
      // second is the fail-closed fallback — two cards beats no gate.
    }

    // Everything from the routing lookup on is inside the try: a throw ANYWHERE
    // after the claim is taken has to release it, or the peer waits out the full
    // publish window for a card that will never exist.
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
          // The host renders a bounded head+tail preview and retains the full
          // command in the approval record. Approvers need enough context to
          // make a real decision, even when this fallback owns the gate.
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

// ── One approval card per tool call (Codex only) ──
// In a Codex container this hook and the plugin's `codex-guard.ts` BOTH run on
// every tool call — concurrently, with the same `tool_use_id` (codex-rs 0.154.0
// `hooks/src/engine/dispatcher.rs` pushes every matched handler onto a
// `FuturesUnordered`; measured 0.7 ms apart) — and both reach the outbound-email
// gate. Without a claim, one gated send raises TWO approval cards for one
// command.
//
// OPT-IN, and that is load-bearing. `tool_use_id` is a REQUIRED field of the
// Claude SDK's PreToolUse input too, so keying on its presence would arm the
// claim on the Claude path as well — where this hook is the only gate and no
// peer will ever publish, so the claim could only ever cost (a wait, and one
// more agent-writable file the gate would read). Only `codex-hooks/runner.ts`
// passes `sharedApprovalClaim`, and only because it knows a peer guard exists.
//
// The claim lives in the SHARED guard core so this staging path and the core's
// `runGateRequest` agree on the key and the directory; a core from an older
// container image has none of these exports and the behaviour is exactly as it
// was — two cards, never a skipped gate.

interface GateClaimApi {
  gateClaimKey: (toolUseId: string, action: string) => string;
  claimGateRequest: (key: string) => { owner: boolean; requestId?: string | null };
  publishGateClaim: (key: string, requestId: string) => void;
  abandonGateClaim: (key: string) => void;
  /**
   * The check that makes the claim safe to read at all. The claim directory is
   * under /tmp, which an agent can write to, so a published requestId that has
   * ALREADY been decided is not a live peer — it is a past approval being
   * replayed at a different command. Required, not optional: a core without it
   * disables the claim entirely (two cards), which is the safe default.
   *
   * DECIDED is `delivered` or `failed`, never `pending`. The host writes a
   * `pending` row the moment it posts the card, so `pending` is precisely the
   * state a loser should wait on — the same reading `awaitDeliveryAck` uses
   * (`../db/delivery-acks.ts`).
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

/** Test seam: drop the memoized claim API so a swapped core path is re-read. */
export function resetGateClaimApiForTest(): void {
  _gateClaimApi = undefined;
}

// ── Block ad-hoc `git clone` outside /tmp ──
// Agents must use create_worktree / clone_repo MCP tools to land a repo
// inside the managed worktree tree. Direct `git clone` into
// /workspace/agent or /workspace/worktrees skips the managed-worktree
// path (auto-commit safety, credential scoping, index registration).
//
// Earlier we only rejected clones whose destination-arg wasn't /tmp/,
// which was trivially bypassable: `git clone … /tmp/x && mv /tmp/x
// /workspace/agent/stolen` passed because the clone segment targeted
// /tmp and the move happened as a separate shell segment. This hook
// now rejects the entire command if it mentions a managed-dir path
// ANYWHERE alongside `git clone`, regardless of segment order. False
// positives (e.g. `git clone /tmp/x && echo /workspace/agent exists`)
// are acceptable — the agent can rephrase.
// ADVISORY git-clone nudge (not a security boundary — the agent already has RW
// to managed dirs). Single source of truth is the shared guard core
// (block-destructive-core.ts), the same module the OpenCode plugin and the Codex
// runner consume. We dynamic-import it from the mounted bootstrap plugin (bun
// caches the module). The inline regexes are a fail-CLOSED FALLBACK only, used
// when the mount is absent (e.g. unit tests). KNOWN residual bypasses (bare
// `git clone <url>` into cwd=/workspace/agent, `git -C`, renamed binary,
// symlink) are documented in the core; this guard catches literal-managed-path
// forms and steers agents to clone_repo/create_worktree.
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

    // Fallback: shared core unavailable/threw — apply the inline policy, fail-closed.
    if (!GIT_CLONE_RE.test(command)) return {};
    if (MANAGED_DIR_RE.test(command)) return denyBash(GIT_CLONE_BLOCK_MSG);
    // Allow pure /tmp-only clones (tool installs, scratch builds).
    return {};
  };
}

// ── SDK env denylist ──

// These secrets are either rotating short-lived tokens (Granola) or
// HTTP-header-only auth values (Exa, Braintrust MCP). They are intentionally
// passed as MCP server headers at registration time, not as Bash-visible env.
// Forwarding them into the SDK's child-process env defeats that isolation.
// Single source shared with the OpenCode provider (secret-env.ts) so the two
// providers' env-hygiene can't drift apart. (codex #126)
const SDK_ENV_DENYLIST: ReadonlySet<string> = new Set(MCP_HEADER_ONLY_SECRET_VARS);

function filterSdkEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (SDK_ENV_DENYLIST.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// ── Plugin discovery ──

/**
 * Walk /workspace/plugins/<repo>/(<sub>/(<sub2>/)?).claude-plugin/plugin.json
 * and return them as SDK `plugins:` entries. Without this pass-through, the
 * SDK doesn't load plugin-declared hooks (hooks.json) even if the plugins
 * directory is mounted and CLAUDE_PLUGINS_ROOT is set. Mirrors v1
 * `container/agent-runner/src/index.ts:discoverPlugins`.
 */
export interface PluginDiscovery {
  plugins: SdkPluginConfig[];
  preToolUseGuards: string[];
}

/**
 * Discover Claude plugins and their optional NanoClaw guard capabilities.
 *
 * `nanoclaw-plugin.json` is deliberately separate from Claude's plugin
 * manifest: it is an explicit host/plugin integration contract without
 * relying on undocumented Claude-manifest extension fields.
 *
 * `excludePlugins` is honoured HERE, in the namespace where these paths
 * resolve, against the relative path this walk assembles from its own
 * `readdirSync` names — never a `realpath` or a host-side prediction of it
 * (`../plugin-exclusions.ts`). A top-level entry never reaches this walk at all
 * (the host omits it from the mount, `src/container-runner.ts`); a sub-plugin
 * entry does, and dropping it here removes the plugin from the SDK `plugins:`
 * list, which is what carries its hooks — its SessionStart hook and any
 * `preToolUseGuards` it declares go with it.
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
// ── Continuation rotation (cold-resume guard) ──

/**
 * Resume cost is dominated by transcript size. Past this many bytes a fresh
 * cold container can't reload the .jsonl before the host's 30-min idle ceiling
 * fires, so the session is dropped and started clean. Operator-overridable.
 */
function transcriptRotateBytes(): number {
  return Number(process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES) || 12 * 1024 * 1024;
}

/**
 * Secondary age trigger, measured from the transcript's first entry. 0 (or a
 * non-positive value) disables the age check; size alone then governs.
 */
function transcriptRotateAgeMs(): number {
  const raw = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  if (raw === undefined || raw.trim() === '') return 14 * 86_400_000;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 14 * 86_400_000;
  // Explicit non-positive override disables the age check; size alone governs.
  return days > 0 ? days * 86_400_000 : Infinity;
}

function claudeProjectsDir(): string {
  return path.join(claudeConfigDir(), 'projects');
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
}

function writeMemorySessionHook(hook: MemorySessionHookRegistration): void {
  // `claudeConfigDir()` falls back to $HOME/.claude when CLAUDE_CONFIG_DIR is
  // unset, and containers rely on that fallback resolving to /home/node/.claude.
  // Run this same code on the host — a test, a script, anything importing this
  // module outside a container — and the fallback resolves to the developer's own
  // ~/.claude instead, registering a SessionStart hook whose module does not exist
  // there. Every host session then errors on startup. That has happened twice.
  //
  // The module the hook runs ships only in the container image, so its presence is
  // a direct check of the invariant that actually matters: never register a hook
  // pointing at a module that isn't there.
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
 * Locate the .jsonl backing a session id. The SDK names project dirs by a
 * mangled cwd; rather than reproduce that convention we scan project dirs for
 * `<sessionId>.jsonl` (session ids are UUIDs, so this is unambiguous).
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
 * Read has to cover the WHOLE first line — it is one JSON object, and a
 * truncated prefix never parses. The old 4KB buffer returned null for 66% of
 * live transcripts (2693 sampled; the host's `[Trusted runtime capability
 * state]` entry alone runs ~16KB, and the first `"timestamp"` key sits as deep
 * as 12KB in), which silently disabled the age half of
 * `maybeRotateContinuation`: only the size cap ever fired, so long-lived task
 * sessions resumed 17+ day transcripts against a 14-day cap.
 *
 * ponytail: one bounded read, no chunk loop. 1 MiB is ~10x the largest first
 * line observed across those 2693 transcripts (105,694 bytes). A longer one
 * logs and skips the age check instead of failing silently — make this a
 * grow-until-newline loop if that log ever shows up.
 */
const TRANSCRIPT_FIRST_LINE_MAX_BYTES = 1024 * 1024;

/** Epoch-ms of the first transcript entry, or null if unreadable. */
function transcriptStartMs(transcriptPath: string): number | null {
  try {
    let firstLine: string;
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      // +1 so a filled buffer means the line is genuinely LONGER than the cap.
      // At exactly the cap with no trailing newline the old sizing read
      // `n === buf.length` and cried truncation on a complete line.
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

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 *
 * Operator override: set CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env to
 * raise or lower the threshold without editing source — useful when running
 * with a 1M-context model variant or when emergency-tuning a deployment.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';

/**
 * Opus is only supported in its 1M-context form in this fork. Auto-append
 * `[1m]` to a bare `claude-opus-X-Y` id before it reaches the SDK as the
 * mainLoopModel. Load-bearing for the auto-compact window: the CLI grants the
 * 1M window deterministically only when the model id literally carries `[1m]`
 * (`PG(model) = /\[1m\]/.test(model)`). A bare opus id falls back to a gate
 * (`firstParty && ANTHROPIC_BASE_URL===api.anthropic.com`) that is false under
 * proxy auth, collapsing the window to 200k and force-compacting long sessions.
 * Mirrors the host-side `ensureOpus1mSuffix` in src/flag-parser.ts. No-op for
 * aliases (`opus`), non-opus ids, or ids that already carry a `[Nm]` suffix.
 */
function ensureOpus1mSuffix(model: string): string {
  // Fable shares the opus 1M-only policy and now spans both version schemes
  // too: claude-fable-5 (single-digit) and claude-fable-5-1 (two-segment).
  // Opus itself spans both version schemes: claude-opus-4-8 and claude-opus-5.
  // Keep in sync with src/flag-parser.ts ensureOpus1mSuffix.
  return /^claude-(?:opus-\d+(?:-\d+)?|fable-\d+(?:-\d+)?)$/i.test(model) ? `${model}[1m]` : model;
}

/**
 * The env var the CLI expands each bare family alias through. It is read
 * here only in the alias → concrete id direction (`canonicalUsageModel`); the
 * send path pins nothing into `perQueryEnv` any more, because a family word
 * means the same model in every group.
 *
 * The host resolves every alias once at spawn and injects the answers here
 * (`claudeSpawnEnv` in src/claude-spawn-defaults.ts, forwarded by
 * src/group-init.ts), so reading these is reading the host's own resolution
 * rather than mirroring its vocabulary. That matters: src/flag-parser.ts owns
 * the alias table and is NOT importable from this Bun package, so a second
 * copy here would be free to drift.
 */
const FAMILY_ALIAS_ENV: Record<string, string> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

/**
 * The concrete model id a bare alias will actually run as — what `modelUsage`
 * will be keyed by, and therefore the only form that can be compared against
 * it.
 *
 * Attribution bug this fixes: the model we hand the SDK is often a BARE ALIAS
 * (`sonnet` from an unpinned scheduled-task wake in poll-loop.ts, or from a
 * live `-m sonnet`), while `modelUsage` comes back keyed by the canonical id
 * the CLI expanded it to (`claude-sonnet-5`). An exact comparison between the
 * two matched nothing, so every row of a multi-model turn recorded NULL effort
 * even though the turn demonstrably ran at one — a NULL that reads as "effort
 * was never configured" for a turn where it was configured AND applied, which
 * is the exact failure this column exists to prevent.
 *
 * Resolving through the CLI's own alias env is what keeps both sides in the
 * same vocabulary. `ensureOpus1mSuffix` is reapplied because the comparison
 * target carries the suffix (live: 2,924 rows keyed `claude-opus-5[1m]`); it
 * is idempotent, so a host that already injected the suffixed id is unchanged.
 *
 * An alias with no env answer (unit tests, a host too old, the `default`
 * alias, which no family env resolves) is returned unchanged: it will simply
 * fail to match and the row stays NULL. That under-claims, which is the
 * intended direction — never a guess.
 */
function canonicalUsageModel(model: string | undefined, env: Record<string, string | undefined>): string | undefined {
  if (!model) return model;
  const key = FAMILY_ALIAS_ENV[model.toLowerCase()];
  if (!key) return model; // already a concrete id
  const resolved = env[key];
  return resolved ? ensureOpus1mSuffix(resolved) : model;
}

/**
 * Per-model-family default effort, applied only when nothing upstream chose
 * one (-e flag, group provider config, operator NANOCLAW_EFFORT_OVERRIDE).
 *
 *   opus → high — operator decision 2026-07-27, aligned with the GPT 5.6 SOL
 *           default for cross-provider parity, and reaffirmed 2026-09-16 when
 *           Opus became the model an UNPINNED group runs (DEFAULT_OPUS_MODEL
 *           in src/claude-spawn-defaults.ts): the fleet baseline is Opus at
 *           `high`, not a quieter tier chosen because it is now the default.
 *           Applies to the bare `opus` alias and every concrete claude-opus-*
 *           id; this install only runs Opus 5+ (opus 4.8 and below are no
 *           longer used). Operators dial down or up per group, per channel or
 *           per turn via -e / NANOCLAW_EFFORT_OVERRIDE.
 *   fable → medium — keep Fable's default at medium; operators can dial up
 *           via -e or NANOCLAW_EFFORT_OVERRIDE when a task warrants it.
 *   sonnet → xhigh — Sonnet 5 (the bare `sonnet` alias) defaults to xhigh, the
 *           recommended setting for coding/agentic work; fleet decision.
 *           (This fork only runs Sonnet 5.)
 *   haiku → undefined — no effort control at the API level.
 *
 * `-e <level>` (turn or sticky) always wins over all of these — subject to
 * clampEffortForModel below.
 */
function defaultEffortForModel(model: string | undefined): string | undefined {
  if (!model) return 'high';
  const m = model.toLowerCase();
  // Opus 5+ only — every opus id (and the bare alias, which resolves to
  // DEFAULT_OPUS_MODEL via ANTHROPIC_DEFAULT_OPUS_MODEL) defaults to
  // `high`. Pre-5 opus ids are no longer used in this install; if one ever
  // appears, it falls through to the same `high` default rather than 400 on
  // the unsupported `xhigh` of older opus generations.
  if (m === 'opus' || m.startsWith('claude-opus-')) return 'high';
  // Sonnet 5 (the bare `sonnet` alias resolves to it) defaults to xhigh.
  if (m === 'sonnet' || m.startsWith('claude-sonnet-')) return 'xhigh';
  if (m.startsWith('claude-fable-')) return 'medium';
  if (m === 'haiku' || m.startsWith('claude-haiku-')) return undefined;
  return 'high';
}

/**
 * Effort support per model family — the provider-side safety net. Mismatches
 * can reach here from layers that never see model and effort together:
 * an operator NANOCLAW_EFFORT_OVERRIDE (single value, model-blind), a sticky
 * `-e xhigh` followed by `-m1 sonnet` on a later turn (flag-parser only
 * cross-validates -m/-e when they arrive in the same message), or a group
 * container.json effort paired with a per-turn model switch. An unsupported
 * value would 400 at the API, so clamp to the family default instead.
 * Keep the support sets consistent with MODEL_EFFORT_SUPPORT in
 * src/flag-parser.ts (host tree — not importable from this Bun package).
 */
function clampEffortForModel(model: string | undefined, effort: string | undefined): string | undefined {
  if (!effort) return effort;
  const m = (model ?? '').toLowerCase();
  if (m === 'haiku' || m.startsWith('claude-haiku-')) return defaultEffortForModel(model);
  // All non-haiku models (opus 5+, sonnet 5, fable) support the full effort
  // surface. Pre-5 opus ids are no longer used in this install.
  return effort;
}

// ── Provider ──

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
// `Invalid signature in thinking block`: the stored continuation replays
// thinking blocks signed by a different serving upstream (observed in the
// 2026-06-09 auth-flip drill — turns produced under a custom ANTHROPIC_BASE_URL
// proxy fail signature validation when replayed to api.anthropic.com, and vice
// versa is possible). The history is unusable under the current auth path, so
// treat it like a stale session: reset the continuation and start fresh.
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|invalid `?signature`? in `?thinking`? block/i;

/**
 * Prompt-too-long detection. Matches the text variations Anthropic has
 * used across SDK versions when the cumulative session prompt exceeds
 * the model's context window. Distinct from STALE_SESSION_RE because the
 * recovery strategy differs: stale-session just needs a cleared
 * continuation; prompt-too-long needs that PLUS an in-turn retry with a
 * fresh session, otherwise the same message fails on the next poll too.
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
   * Ordered fallback API keys from ANTHROPIC_API_KEY_N env vars (sorted by
   * N). Used when an upstream error suggests the current key is blocked
   * and rotation would help. Only populated when the user has configured
   * a non-Anthropic routing proxy via ANTHROPIC_BASE_URL; under the
   * default OneCLI path, key selection happens at the proxy and this
   * array stays empty.
   */
  private fallbackKeys: Array<{ name: string; value: string }>;
  private nextFallback = 0;

  /**
   * Parallel fallback list for OAuth (Claude Max subscription) tokens.
   * Host forwards CLAUDE_CODE_OAUTH_TOKEN + CLAUDE_CODE_OAUTH_TOKEN_N and
   * adds api.anthropic.com to NO_PROXY so OneCLI's proxy doesn't substitute
   * the token mid-flight. Rotation is keyed on OAuth being the active auth
   * path — if ANTHROPIC_API_KEY is also set we prefer API-key rotation
   * (it's the only thing the SDK actually uses in that case).
   */
  private fallbackOauth: Array<{ name: string; value: string }>;
  // Circular OAuth rotation ring: [primary, ...numbered fallbacks], deduped by
  // value. rotateApiKey advances around it and wraps back to the primary, so a
  // transient blip on one credential can't strand the container on a worse one
  // for its whole life. Position is sticky across turns; the per-turn cycle
  // budget (oauthRotationsThisCycle) is reset by resetRotationCycle each turn.
  // (Incident 2026-06-25: a non-scoped group's single promoted fallback was a
  // spend-capped account, and forward-only rotation could never escape it.)
  private oauthRing: Array<{ name: string; value: string }> = [];
  private oauthRingPos = 0;
  private oauthRotationsThisCycle = 0;
  private memorySessionHook?: MemorySessionHookRegistration;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    // The Agent SDK's McpStdioServerConfig has no cwd field (checked against
    // 0.3.197) — shim any cwd-bearing stdio server through cwd-shim.ts so a
    // plugin server that declares one launches in the right directory instead
    // of silently starting at the container's default cwd.
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
    // Build the circular OAuth rotation ring: primary + numbered fallbacks,
    // deduped by value so a token that appears in two slots isn't visited
    // twice. The primary occupies position 0; rotateApiKey wraps past the last
    // fallback back to it.
    // Host-side container-runner already strips OneCLI's "placeholder"
    // sentinel before forwarding; guard defensively anyway so a stray
    // placeholder never enters the ring as a usable credential.
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
   * Restore the credential slot a previous instance of this container last
   * rotated onto, so a respawn doesn't burn a rejected turn on the primary
   * before replaying its way back to the credential that's actually healthy.
   * Position only, never the token value — the value already lives in
   * `oauthRing` from env.
   *
   * NOT called from the constructor, and not from `query()` either: it reads
   * session state, and `getCredentialSlot` opens the outbound session DB
   * directly (`mailbox/sqlite/connection.ts:76-89` — it does not go through
   * the mailbox registry, so "no mailbox registered" is not a guard). A
   * constructor that touched the DB would make every unit test that builds
   * a provider create a session DB at the production path. The runner
   * entrypoint calls this exactly once, after the mailbox has started
   * (`index.ts:97`) and the provider is built (`index.ts:308`); tests call it
   * explicitly when they want the restore.
   *
   * OAuth ring ONLY — see the comment below where the `ANTHROPIC_API_KEY_N`
   * lookup used to be for why the forward-only fallback pool is deliberately
   * excluded: only the circular ring's wrap guarantees every slot stays
   * reachable after a restore, so only it is safe to persist across a
   * respawn.
   *
   * Best-effort: no persisted slot (fresh install, first-ever rotation)
   * falls through to the default primary silently, and a session-DB read
   * failure is logged and ignored — a respawn must never fail to boot over a
   * position hint it can re-derive by rotating.
   *
   * This is the only thing that moves the ring at boot. Plan utilization never
   * does (`recordSlotUsageSurvey` only records it): slot order is the
   * operator's numbered priority, operator decision 2026-09-16.
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

    // Deliberately no ANTHROPIC_API_KEY_N fallback branch here: `fallbackKeys`
    // is forward-only/exhaust-once (`nextFallback` never wraps — see
    // `rotateApiKey` below), unlike the circular OAuth ring above. Restoring a
    // persisted position onto a forward-only pool can only ever advance the
    // cursor, never reopen it — so a respawn after the LAST fallback also
    // failed would restore straight past the end and the primary would never
    // become eligible again, whereas an unpersisted respawn today resets to
    // the primary and gives the whole pool another chance. A container
    // respawn is that pool's only reset by design; persisting across it would
    // turn a recoverable dead end into a permanent one. `persistCredentialSlot`
    // is therefore never called from the API-key branch of `rotateApiKey`
    // either — see that method.

    // Named a slot that's no longer present (env changed since the value was
    // written) — ignore and stay on the primary. Log once so a stale slot
    // never rotting silently is at least visible.
    log(`Persisted credential slot "${persisted}" is not in the current pool — ignoring, staying on primary`);
  }

  /**
   * Record the host's plan-utilization survey (`NANOCLAW_SLOT_USAGE_SURVEY`,
   * `src/slot-usage-survey.ts`) as one `usage_pull` sample row per ring slot
   * per window, so idle slots stay visible in `rate_limit_samples`.
   *
   * Telemetry ONLY: it never moves the ring. Slots are used in numbered order
   * (`CLAUDE_CODE_OAUTH_TOKEN`, `_2`, `_3`, …) and advance only on a wall via
   * `rotateApiKey` — the operator's priority, decided 2026-09-16, reversing
   * quota-burn 0.6's most-used-first pick (#811/#821).
   *
   * Makes no network call; a missing, unparseable or stale survey records
   * nothing. Never throws — this must not stop a container from booting.
   */
  recordSlotUsageSurvey(deps: { now?: number; maxAgeMs?: number } = {}): void {
    const usingOauth = !this.env.ANTHROPIC_API_KEY && this.oauthRing.length > 0;
    if (!usingOauth) return;
    const credentialSet = process.env.NANOCLAW_OAUTH_CREDENTIAL_SET ?? null;
    try {
      const survey = parseSlotUsageSurvey(process.env[SLOT_USAGE_SURVEY_ENV], {
        now: deps.now ?? Date.now(),
        maxAgeMs: deps.maxAgeMs,
      });
      if (survey.problem) log(`Slot usage survey unusable (nothing recorded): ${survey.problem}`);
      if (survey.staleSlots.length > 0) {
        log(`Slot usage survey too old to use for: ${survey.staleSlots.join(', ')}`);
      }
      for (const slot of this.oauthRing) {
        const entry = survey.fresh[slot.name];
        if (!entry) continue;
        const who: AccountIdentity = {
          account: slot.name,
          credentialSet,
          lane: laneForSlot(process.env.CLAUDE_CODE_OAUTH_LANES, slot.name),
        };
        recordRateLimitSamples(usageResponseToSamples(surveyEntryToUsageResponse(entry), who));
      }
    } catch (err) {
      log(`Slot usage survey recording aborted: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  /**
   * Advance the active Anthropic credential to the next fallback. Prefers
   * OAuth rotation (Claude Max) when OAuth is the active auth path — that
   * is, when CLAUDE_CODE_OAUTH_TOKEN is set and ANTHROPIC_API_KEY is not.
   * Otherwise rotates ANTHROPIC_API_KEY through its _N fallbacks. Returns
   * `rotated: false` when no more fallbacks of either kind remain.
   *
   * The stored continuation is preserved on every rotation. The SDK's
   * `resume:` loads conversation history from a local `.jsonl` file
   * (`~/.claude/projects/<hash>/<session>.jsonl`), and the Anthropic API
   * has no server-side session object that's account-bound — the next
   * turn just replays the prior messages under whichever token signs the
   * request. Same shape as `/login`-mid-session in interactive Claude Code.
   *
   * Position persists for the container lifetime — once slot N fires a
   * retryable error, slot N+1 stays active for all subsequent queries. On
   * the circular OAuth ring it also survives a container respawn: the slot
   * NAME is persisted to session state here and restored by the runner
   * entrypoint (`restorePersistedCredentialSlot`). The forward-only
   * `ANTHROPIC_API_KEY_N` pool is different: nothing is persisted, and a
   * respawn is its only reset — see the comment in that branch below.
   *
   * Process-wide propagation: rotations are mirrored to `process.env` so
   * other in-process consumers that issue direct Anthropic calls — future
   * MCP tools, anything reading process.env — pick up the active credential without their own
   * rotation logic. Safe because (a) container code reads env fresh at
   * call time (no module-load captures), (b) Bash subprocesses inherit
   * the same rotated value, so a `claude -p` an agent launches signs with
   * the active slot rather than a stale one, and
   * (c) host-side container-runner.ts adds api.anthropic.com to NO_PROXY
   * and re-injects the real token values, so direct callers bypass the
   * OneCLI proxy and use process.env directly.
   */
  rotateApiKey(): { rotated: boolean; slot?: string; position?: number; ringSize?: number } {
    const usingOauth = !this.env.ANTHROPIC_API_KEY && Boolean(this.env.CLAUDE_CODE_OAUTH_TOKEN);
    if (usingOauth) {
      // Circular: advance around the ring (wrapping past the last fallback
      // back to the primary). Give up only once we've visited every OTHER
      // credential this cycle — so a transient failure on the current token
      // can recover via any healthy peer, and a since-healed primary is
      // reachable again on a later turn. The cycle budget is reset per turn
      // by resetRotationCycle. (Incident 2026-06-25.)
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
      // Already rotated to this one (e.g. base key already matched a
      // fallback by coincidence). Try the next one instead.
      return this.rotateApiKey();
    }
    this.env.ANTHROPIC_API_KEY = next.value;
    process.env.ANTHROPIC_API_KEY = next.value;
    log(`Rotated ANTHROPIC_API_KEY → ${next.name} (${this.nextFallback}/${this.fallbackKeys.length})`);
    // No persistCredentialSlot() here — see the comment on the ANTHROPIC_API_KEY_N
    // branch in restorePersistedCredentialSlot for why this forward-only pool
    // deliberately does not persist across a respawn.
    return { rotated: true, slot: next.name, position: this.nextFallback + 1, ringSize: this.fallbackKeys.length + 1 };
  }

  /**
   * Reset the per-turn OAuth rotation cycle budget. Called once at the start
   * of every turn so a fresh full pass around the ring is available — the
   * active position stays sticky, but a credential that has since healed
   * (e.g. a 5-hour session cap that reset) becomes reachable again. The
   * ANTHROPIC_API_KEY fallback path is intentionally untouched: it remains
   * forward-only / exhaust-once, and is never active alongside OAuth.
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
    // Set by the first `session_state_changed`: proof this CLI emits the idle
    // that ends every wait on an outstanding prompt. Until then, report no
    // queued work, as before, so a CLI without the events cannot pin a turn.
    let sessionStateSeen = false;
    // Live background tasks as the CLI last reported them
    // (`background_tasks_changed`, sdk.d.ts: a level signal with REPLACE
    // semantics — swap the set for each payload, never pair start/finish
    // bookends, so a missed bookend cannot wedge a stale indicator). Per CLI
    // process, so per query: nothing is emitted at startup and this starts
    // empty. Ambient entries (live-update watchers, skip_transcript tasks) are
    // not work and are excluded, as the SDK asks.
    const liveBackgroundTasks = new Set<string>();
    // The hold `hasBackgroundWork` reports. Latched: raised by the first
    // non-empty level report, released ONLY at the CLI's idle with the set
    // empty — never at the membership change that empties it. Between that
    // drain and the idle (or the `init` of the follow-up turn the CLI starts
    // on completion) the set is empty but the work is not over, and every
    // consumer of the predicate — the poll-loop's lowering at `result`, its
    // restart gate for a settings change — would otherwise act in that gap.
    // The invariant lives here so no consumer has to know about it.
    //
    // The CLI gates its idle on a NARROWER set than it reports: background
    // subagents (`local_agent`) withhold idle, but a backgrounded Bash
    // (`local_bash`), a dream, a parked MCP task, a long-running remote
    // agent, and a monitor with no timeout do not (CLI 2.1.272, its idle
    // predicate excludes those types by name). For those, idle arrives with
    // the set still non-empty and no second idle ever comes, so "release at
    // idle with the set empty" alone would pin the hold for the rest of the
    // query. `idleSeenWithHold` records that the CLI has shown it will not
    // withhold idle for what is left; from then on the membership change
    // that empties the set releases the hold and reports it, which for those
    // types is the same protection they had before this hold existed (none
    // past their completion; a completion-started follow-up turn's `init`
    // re-raises the level itself).
    // `idleSeenWithHold` is evidence about the tasks that were live at that
    // idle, not about the query: a gating task (a subagent) joining the set
    // afterwards withholds idle again, and releasing at ITS drain would
    // reopen the drain→follow-up gap. `idleCoveredTasks` is the set the idle
    // vouched for; any membership change that adds an id outside it drops
    // the evidence, and the release waits for the next idle.
    let backgroundHold = false;
    // Top-level assistant text not yet known to be mid-turn or final — see the
    // `assistant` branch and ProviderEvent `interim_text`.
    let pendingAssistantText: string | null = null;
    let idleSeenWithHold = false;
    let idleCoveredTasks = new Set<string>();

    // Per-turn input takes precedence over sticky config (A3).
    // Normalize bare opus → [1m] so the CLI's auto-compact window stays at 1M
    // regardless of auth path (see ensureOpus1mSuffix).
    //
    // Final fallback is the CONCRETE id the host already resolved for this
    // spawn's group (channel wiring → container.json → the install default),
    // read from NANOCLAW_CLAUDE_MODEL (`claudeSpawnEnv` in
    // src/claude-spawn-defaults.ts).
    //
    // That used to be read from ANTHROPIC_DEFAULT_OPUS_MODEL, which the host
    // set to the same resolved id. It is the SDK's `opus` ALIAS answer, so
    // sharing it meant the word "opus" — in a subagent's frontmatter, in the
    // `"model": "opus"` pin group-init writes into every group's
    // settings.json — resolved to whatever the group ran; once the unpinned
    // default moved to Sonnet, every one of those silently ran Sonnet 5. The
    // alias now carries the install's Opus constant and the group's model
    // travels in its own variable. Never read the alias var for THIS chain
    // again; reading it below in `canonicalUsageModel` is the opposite
    // direction (alias → id) and is correct.
    //
    // Never undefined: with model undefined the CLI uses its own
    // built-in default — whatever Opus was current at the pinned binary's
    // release (2.1.156 → opus-4-7, observed live 2026-06-09) — silently
    // ignoring the configured chain (channel default → container.json →
    // DEFAULT_OPUS_MODEL). ANTHROPIC_DEFAULT_OPUS_MODEL is kept as the next
    // fallback for the ROLLING case only — a container spawned by a host that
    // predates NANOCLAW_CLAUDE_MODEL, where that var still holds the group's
    // resolved id — and the bare alias is the last resort for spawns that
    // carry no env at all (unit tests).
    //
    // Reading the concrete id here rather than the alias is what makes the
    // effort default below correct. `defaultEffortForModel` is the ONLY place
    // a family default is chosen, and it sits at the point the model is
    // finally picked — but with `rawModel` set to the literal string 'opus' it
    // was answering for Opus no matter which model the alias resolved to. A
    // group pinned to Sonnet got Opus's `high` instead of Sonnet's `xhigh`; a
    // group pinned to Haiku, which supports no effort at all, got `high` on
    // every turn. The host cannot fix that from its side: absence of
    // NANOCLAW_EFFORT_OVERRIDE means "the container decides", and there is no
    // env value that means "explicitly no effort".
    //
    // `stickyConfig.model` still wins over this, unchanged — a per-agent
    // providerConfig is more specific than the group's default model.
    const rawModel =
      input.model ??
      this.stickyConfig.model ??
      process.env.NANOCLAW_CLAUDE_MODEL ??
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ??
      'opus';
    const model = rawModel ? ensureOpus1mSuffix(rawModel) : rawModel;
    // Effort precedence: -e flag (turn/sticky, arrives as input.effort) →
    // group container.json provider config → operator override env
    // (NANOCLAW_EFFORT_OVERRIDE, injected by the host only when a channel or
    // group default is explicitly configured) → per-model-family default.
    const requestedEffort =
      input.effort ?? this.stickyConfig.effort ?? process.env.NANOCLAW_EFFORT_OVERRIDE ?? defaultEffortForModel(model);
    // Safety clamp: drop to the family default when the resolved effort is
    // unsupported by the resolved model (would 400 at the API otherwise).
    const effort = clampEffortForModel(model, requestedEffort);
    const instructions = appendActiveRuntimeContext(input.systemContext?.instructions, {
      provider: 'claude',
      model: model ?? 'claude:cli-default',
      effort: effort ?? null,
    });
    // ultracode is a session flag (xhigh + standing dynamic-workflow
    // orchestration), NOT an effort value — applied via the SDK control
    // request below. Effort is already forced to xhigh upstream when set.
    const ultracode = input.ultracode === true;
    // Boundary instrumentation: the resolved model+effort per turn. This is
    // the ONLY runtime surface that shows what we asked for — the CLI never
    // logs the request body and OAuth traffic has no proxy dashboard.
    // Verify via `docker logs <container>` while it's alive.
    log(
      `query: model=${model ?? '(cli default)'} effort=${effort ?? '(none)'}` +
        `${effort !== requestedEffort ? ` (clamped from ${requestedEffort ?? '(none)'})` : ''}` +
        `${ultracode ? ' ultracode' : ''}`,
    );

    // Discover plugins each query so hot-mounted plugin drops are picked up
    // without a container restart. Cheap (just fs.readdir under
    // /workspace/plugins); if it grows expensive, hoist to constructor.
    const pluginDiscovery = discoverPlugins();
    const plugins = pluginDiscovery.plugins;
    const pluginOwnsBashEmailGate = pluginDiscovery.preToolUseGuards.includes('bash-email');
    if (plugins.length > 0) {
      log(`Loaded ${plugins.length} plugin(s): ${plugins.map((p) => path.basename(p.path)).join(', ')}`);
    }
    if (pluginOwnsBashEmailGate) {
      log('Delegating Bash email approval gate to loaded plugin');
    }

    // Leave CLAUDE_CODE_SUBAGENT_MODEL unset: a concrete value outranks
    // per-invocation and frontmatter model selection, pinning every subagent
    // to the group model; subagents without an explicit model already inherit
    // the main model. The family env vars only resolve matching bare aliases
    // (docs: code.claude.com/docs/en/sub-agents.md), and they arrive here from
    // the spawn env (`claudeSpawnEnv`) carrying install-wide constants.
    //
    // This used to REWRITE the resolved model's own family alias to that model
    // for the query — the last place the group's model still redefined a
    // family word. It made the fix above true only at the docker boundary: a
    // group pinned to a non-current opus (say `opus48`) had `opus` rewritten
    // back to claude-opus-4-8[1m] here, so its `model: opus` subagents ran the
    // group's pin rather than the install's Opus (PR #839 review r1 P2). The
    // family words are install constants in every layer now; the model in
    // force travels as the SDK's own `model` option, which is set from
    // `model` directly and needs no alias.
    const perQueryEnv: Record<string, string | undefined> = { ...this.env };

    // Which OAuth ring slot this query runs on. Rate-limit utilization is an
    // ACCOUNT property, and rotation means one container can burn through
    // four of them — unlabelled samples would blend four series into one
    // meaningless line. Captured here, not read at sample time: the CLI
    // subprocess is started with this query's env, so the slot is fixed for
    // the life of the query even if the ring advances afterwards.
    const oauthSlot = this.oauthRing[this.oauthRingPos]?.name ?? null;
    // The slot name alone is ambiguous: scoped per-group tokens are forwarded
    // under the same `_N` names as the global pool, so identity is the PAIR
    // (credentialSet, account). `lane` is operator-declared install policy.
    const who: AccountIdentity = {
      account: oauthSlot,
      credentialSet: process.env.NANOCLAW_OAUTH_CREDENTIAL_SET ?? null,
      lane: laneForSlot(process.env.CLAUDE_CODE_OAUTH_LANES, oauthSlot),
    };

    // Set when a SUBAGENT hits the Claude Max quota — by the PostToolUse
    // subagent-tool hook for a synchronous one, or by the task_notification
    // branch for an async one. Both write here.
    //
    // Rotation can't happen mid-query — the credential is fixed for this
    // query's life (see `oauthSlot` above) — so the detection interrupts the
    // query and translateEvents throws this, landing in poll-loop's existing
    // rotation/retry catch exactly like the result-branch throws below.
    let subagentQuotaError: string | null = null;

    // Owns the CLI subprocess's lifetime. Without this, `abort()` below only
    // set a flag and ended the input stream — the SDK's own graceful-close
    // path runs on stdin EOF, but nothing forced it, so an abandoned query
    // (e.g. one interrupted by a credential rotation) could keep its CLI
    // child running on the exhausted credential and burn another 429 minutes
    // after the replay was already healthy on a different one. Passing this
    // as `options.abortController` gives the SDK an immediate, unambiguous
    // signal to tear the process down (stdin EOF → short grace window →
    // kill) instead of relying on the async generator being abandoned by its
    // consumer, which the SDK's own cleanup does not reliably observe.
    const queryAbortController = new AbortController();

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        model: model,
        abortController: queryAbortController,
        ...(effort ? { effort: effort as EffortLevel } : {}),
        // `display: 'summarized'` makes thinking text visible in content
        // blocks; default is empty-text + signature only.
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
              // Order matters: the command rewrite runs first so the later
              // block hooks and the email gate all evaluate the same
              // command text. Block hooks return deny if they match.
              hooks: [
                createBashCommandRewriteHook(),
                createManagedGitMaintenanceHook(),
                createSelfApprovalBlockHook(),
                createBlockSnowflakeConnectorHook(),
                createBlockGitCloneHook(),
                createBlockCodexCompanionHook(),
                ...(pluginOwnsBashEmailGate ? [] : [createEmailGateHook()]),
              ],
            },
          ],
          PostToolUse: [
            { hooks: [postToolUseHook] },
            // A synchronous subagent's quota exhaustion arrives as a
            // tool_result inside this still-running turn, never as a top-level
            // result — this hook is the only place it can be seen. (An ASYNC
            // subagent's does not reach here at all; that one lands on the
            // task_notification branch in translateEvents.) The subagent tool
            // is not matched by any other rewriting hook, so there's no
            // rewrite collision.
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

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      // Fleet Hardening Phase 0.1 (see TurnUsageInfo). Both SDKResultSuccess
      // and SDKResultError carry usage/total_cost_usd/modelUsage — the
      // existing narrow-cast pattern below (`m = message as {...}`) already
      // sidesteps the subtype union for `result`/`is_error`; this reuses it.
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
        // modelUsage is keyed by model and carries its own per-model
        // tokens/cost — a turn spanning multiple models (Opus parent +
        // Sonnet subagents) gets one attributed row per model instead of
        // being collapsed under a NULL model (Fleet Hardening Phase 0.1
        // follow-up: this used to hide $718/$393 of daily spend).
        if (modelEntries.length > 1) {
          return modelEntries.map(([model, u]) => ({
            model,
            inputTokens: u.inputTokens ?? null,
            outputTokens: u.outputTokens ?? null,
            cacheReadTokens: u.cacheReadInputTokens ?? null,
            cacheWriteTokens: u.cacheCreationInputTokens ?? null,
            costUsd: typeof u.costUSD === 'number' ? u.costUSD : null,
          }));
        }
        return {
          model: modelEntries.length === 1 ? modelEntries[0][0] : null,
          inputTokens: m.usage?.input_tokens ?? null,
          outputTokens: m.usage?.output_tokens ?? null,
          cacheReadTokens: m.usage?.cache_read_input_tokens ?? null,
          cacheWriteTokens: m.usage?.cache_creation_input_tokens ?? null,
          costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null,
        };
      }
      let messageCount = 0;
      // Throttle tool-call progress so every Bash/Grep doesn't spam status
      // updates. One tool-call-derived progress per ~1.5s is enough to show
      // "it's alive and doing something."
      let lastToolProgressAt = 0;
      const TOOL_PROGRESS_MIN_INTERVAL_MS = 1500;

      // tool_use_id → tool name, so task_notification can tell a real subagent
      // (Task) completion from an auto-backgrounded Bash command whose summary
      // is raw command text. Turn-scoped, bounded by tool calls — no eviction.
      const toolNameById = new Map<string, string>();

      // Per-turn cost attribution (rate-limit persistence): the most recent
      // `rate_limit_event` observed since the last `result`. "What share of
      // our weekly allowance have we burned" is otherwise undiscoverable —
      // this is the one place the SDK reports it. Cleared after each result
      // so a turn with NO fresh rate_limit_event reports NULL rather than a
      // stale reading from an earlier turn.
      let lastRateLimitInfo: SdkRateLimitInfo | undefined;

      // Enable ultracode for the session before consuming the stream. It's a
      // flag SETTING (not an effort value, not read from settings.json), so the
      // SDK's apply_flag_settings control request is the only programmatic
      // lever — available because we run in streaming-input mode. Non-fatal:
      // if the underlying CLI build doesn't honor it, log and continue at the
      // already-set xhigh effort rather than failing the turn.
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

      // An intentional abort() tears the CLI subprocess down via
      // queryAbortController, and the SDK surfaces that teardown as a thrown
      // "aborted"-classified error out of the async iterator itself — not
      // as a message the loop body ever sees, so the `if (aborted) return;`
      // guard inside the loop can't catch it. The try/catch below swallows
      // ONLY that case (checked via the `aborted` flag, not the error's
      // shape, so it can't misclassify a real SDK error as an intentional
      // teardown); every other error — including every deliberate throw
      // inside the loop below, all of which fire before `aborted` is ever
      // set — still propagates unchanged.
      try {
        for await (const message of sdkResult) {
          if (aborted) return;
          // A subagent hit the credential slot's quota (PostToolUse hook).
          // Throw here so poll-loop's catch rotates the OAuth ring and replays
          // the turn — identical to the result-branch throws below, which a
          // subagent failure never reaches.
          if (subagentQuotaError) throw new Error(subagentQuotaError);
          messageCount++;

          // Yield activity for every SDK event so the poll loop knows the agent is working
          yield { type: 'activity' };

          if (message.type === 'system' && message.subtype === 'init') {
            yield { type: 'init', continuation: message.session_id };
          } else if (message.type === 'result') {
            pendingAssistantText = null;
            // `result` text exists only on subtype:"success"; error subtypes
            // (e.g. a non-retryable 403 billing_error) carry their message in
            // `errors[]` instead. Surface either so the poll-loop can deliver a
            // billing/quota notice to the user rather than dropping the turn.
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
              // Per-turn cost attribution (Fleet Hardening Phase 0.1 follow-up):
              // the SDK's own count of assistant/tool round-trips this turn made
              // — the most authoritative `steps` signal of the three providers,
              // since it comes straight from the harness rather than being
              // inferred from the event stream.
              num_turns?: number;
            };
            const text = m.result ?? (m.errors && m.errors.length > 0 ? m.errors.join('\n') : null);
            // Retry-path guards run FIRST — these turn error text into a throw so
            // poll-loop's rotation / recap / backoff machinery retries instead of
            // posting the raw error to the user's channel.
            if (text && QUOTA_RESULT_RE.test(text)) {
              // Throw so poll-loop's catch path can rotate to the next OAuth
              // fallback and retry instead of dispatching the quota message
              // to the user.
              throw new Error(`subscription_quota_exhausted: ${text}`);
            }
            if (text && SUBSCRIPTION_BLOCKED_RE.test(text)) {
              // Org-disabled account: same rotation path as quota exhaustion,
              // distinct marker for diagnosability.
              throw new Error(`subscription_access_disabled: ${text}`);
            }
            if (text && POISONED_CONTINUATION_RE.test(text)) {
              // Throw so poll-loop's isSessionInvalid branch clears the
              // poisoned continuation and retries with a recap instead of
              // dispatching the raw 400 to the user (and dead-stopping the
              // session — the same history would fail every future turn).
              throw new Error(text);
            }
            if (text && TRANSIENT_OVERLOAD_RESULT_RE.test(text)) {
              // Throw so poll-loop's transient-overload branch backs off and
              // retries the same prompt instead of posting the rate-limit error
              // to the user's channel as the agent's reply.
              throw new Error(`transient_overload: ${text}`);
            }
            const effortHeldAllTurn = effortTransitionsThisTurn === 0;
            // Cleared BEFORE the yield, not after. The generator suspends at the
            // yield below and poll-loop does its applySettings/push during that
            // suspension, so a reset placed after it would wipe transitions that
            // belong to the NEXT turn — the same erasure, one frame later.
            effortTransitionsThisTurn = 0;
            yield {
              type: 'result',
              text,
              isError: m.is_error === true,
              // The runner's prompts this turn consumed, as echoed. Cleared from
              // the outstanding set before the yield, so hasQueuedWork is
              // already truthful when poll-loop reads it at this result.
              answeredPrompts: stream.answer([
                ...(m.user_message_uuids ?? []),
                ...(m.user_message_uuid ? [m.user_message_uuid] : []),
              ]),
              // Effort is a request parameter — no API bills it back, so it is
              // stamped on here rather than read out of `modelUsage`. On a
              // multi-model turn only the entry for `activeModel` gets it; the
              // subagent entries stay NULL because we never set their effort.
              // See providers/turn-effort.ts.
              usage: attachTurnEffort(extractUsage(m), {
                model: activeUsageModel,
                // Unequal = the effort moved mid-turn, so no single value
                // describes this aggregate. NULL both halves: `requested` is
                // just as ambiguous as `effective` once the turn straddles a
                // change, and a half-labelled row invites the same wrong read.
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
            // Throttled, fire-and-forget: samples plan utilization for THIS
            // account whether or not the SDK had anything to warn about.
            samplePlanUsage(sdkResult, who);
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
            yield { type: 'error', message: 'API retry', retryable: true };
          } else if (message.type === 'rate_limit_event') {
            const info = (message as { rate_limit_info?: SdkRateLimitInfo }).rate_limit_info;
            lastRateLimitInfo = info; // held for the `result` that closes this turn
            // Kept alongside the pull, not replaced by it: the event carries a
            // `status` (allowed_warning / rejected) the pull has no field for,
            // and it is the fallback when the experimental pull is unavailable.
            // `source` on the row says which path produced it.
            recordRateLimitSamples([
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
            ]);
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
            // Not a `result`: the poll loop treats result text as the agent's turn
            // output — a synthetic "Context compacted." result has no <message>
            // block, so it triggers the "response was not delivered — please
            // re-send" nudge and the agent duplicates its previous message.
            // Compaction is bookkeeping: log it, count it as activity only.
            log(`Context compacted${detail}.`);
            yield { type: 'activity' };
          } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
            const tn = message as { summary?: string; status?: string; tool_use_id?: string };
            const toolName = tn.tool_use_id ? toolNameById.get(tn.tool_use_id) : undefined;
            // An ASYNC subagent's quota death lands HERE, not on the
            // PostToolUse subagent-tool hook — its tool_result was just "Async agent
            // launched successfully…", with nothing to match. The CLI folds this
            // notification back in as a `<task-notification>` user message that
            // auto-continues the turn, so left alone the parent runs on with a
            // dead subagent and the credential ring never rotates.
            const asyncQuotaError = subagentQuotaFromTaskNotification(tn, toolName);
            if (asyncQuotaError) {
              if (!subagentQuotaError) subagentQuotaError = asyncQuotaError;
              const split = asyncQuotaError.indexOf(': ');
              log(
                `Subagent hit ${asyncQuotaError.slice(0, split)} — interrupting turn so poll-loop can rotate: ` +
                  asyncQuotaError.slice(split + 2),
              );
              // Yield the label BEFORE throwing: the throw unwinds straight to
              // poll-loop's rotation catch, so this is the last chance to tell
              // the user why their turn restarted.
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
              // Throw directly rather than waiting for the loop-top check: an
              // interrupted stream may never emit another message.
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
                  // Evidence and its scope go together: a snapshot without the
                  // flag is a dropped window nothing may consult.
                  idleSeenWithHold = false;
                  idleCoveredTasks = new Set();
                  break;
                }
              }
            }
            const releasedAtDrain = liveBackgroundTasks.size === 0 && idleSeenWithHold;
            if (releasedAtDrain) {
              // The CLI already went idle over these tasks: no idle will follow
              // this drain, so this is the release (see idleSeenWithHold).
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
              // Report the background level HERE, not at the membership change:
              // on this CLI idle is withheld while background agents run and
              // fires only once the bg-agent loop exits (sdk.d.ts on
              // SDKSessionStateChangedMessage; CLI 2.1.272 changelog — headless
              // sessions stopped reporting idle with agents still running,
              // CLAUDE_CODE_BG_TASKS_REPORT_RUNNING defaults on). So `live: 0`
              // at idle is the CLI confirming no follow-up turn is coming, and
              // the poll-loop can lower the level it held for that work without
              // opening a gap before a completion-started turn's `init`. The
              // hold releases here for the same reason — or, for task types
              // the CLI does not gate idle on, at the drain that follows an
              // idle like this one (idleSeenWithHold).
              if (liveBackgroundTasks.size === 0) backgroundHold = false;
              else if (backgroundHold) {
                idleSeenWithHold = true;
                idleCoveredTasks = new Set(liveBackgroundTasks);
              }
              yield { type: 'background_work', live: liveBackgroundTasks.size };
            }
          } else if (message.type === 'assistant') {
            // Record tool_use id → name so a later task_notification can be
            // classified (Agent/Task subagent vs backgrounded Bash). See
            // shouldForwardTaskNotification.
            const blocks = (message as { message?: { content?: unknown } }).message?.content;
            // A subagent's assistant messages ride this stream too, tagged with
            // the tool call that spawned them; only the parent speaks to people.
            const topLevel = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id == null;
            if (Array.isArray(blocks)) {
              let sawToolUse = false;
              for (const block of blocks) {
                const b = block as { type?: string; id?: string; name?: string; text?: unknown };
                if (b.type === 'tool_use' && b.id && b.name) toolNameById.set(b.id, b.name);
                if (!topLevel) continue;
                // Text is only known to be mid-turn once a tool call follows it
                // (the CLI emits blocks as separate messages, so "follows" spans
                // messages). Text still pending at `result` is the final text,
                // which the result carries — dropped there, never emitted twice.
                if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
                  pendingAssistantText = pendingAssistantText ? `${pendingAssistantText}\n${b.text}` : b.text;
                } else if (b.type === 'tool_use') {
                  sawToolUse = true;
                }
              }
              // A message that calls a tool is not the turn's last, so ALL the
              // text buffered so far is mid-turn — text placed after the
              // tool_use block in the same message included.
              if (sawToolUse && pendingAssistantText) {
                const text = pendingAssistantText;
                pendingAssistantText = null;
                yield { type: 'interim_text', text };
              }
            }
            // SDK task_notification only fires for multi-step planned tasks, so
            // simple turns (single tool call, direct answers) never get a
            // status line. Derive labels from thinking + tool_use blocks on
            // each assistant turn. Thinking forwarding gives the user visibility
            // into the reasoning process; the tool_use label shows what the
            // agent chose to do next. Both honor TOOL_PROGRESS_MIN_INTERVAL_MS
            // across the whole label group — throttling is a per-turn floor,
            // not a per-label rate limit.
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
      // Second gate, and the load-bearing one: `interrupt()` may end the
      // stream without emitting a further message, in which case the
      // top-of-loop check above never runs again and the turn would complete
      // normally — dead subagent, no rotation, silently. Re-check after the
      // loop so the throw is guaranteed regardless of how the SDK winds the
      // interrupted stream down.
      if (subagentQuotaError) throw new Error(subagentQuotaError);
      log(`Query completed after ${messageCount} SDK messages`);
    }

    // Tracks the model the live query is currently on — updated by
    // applySettings so a later effort-only change clamps against the
    // model actually in effect, not the one the query started with.
    let activeModel = model;
    // Same idea for effort, and for the same reason turn_usage needs it: a
    // mid-stream `-e` lands through applySettings, so the value resolved at
    // query() time stops describing the turns that follow it. `translateEvents`
    // reads these when it stamps a `result` event's usage — see
    // providers/turn-effort.ts. `activeRequestedEffort` is the PRE-clamp value,
    // which is what makes a Haiku turn ("high was configured, none was sent")
    // distinguishable from one that was never configured at all.
    let activeEffort = effort;
    let activeRequestedEffort = requestedEffort;
    // Effort in force when the CURRENT turn began, and whether a new turn is
    // about to start.
    //
    // A follow-up that arrives while a turn is still executing does NOT open a
    // new query: poll-loop.ts calls applySettings and then pushes it into the
    // same stream (see its `liveSettingsChanged` branch), and the SDK merges
    // both inputs into one eventual `result`. That result's usage therefore
    // covers work done under the OLD effort and the new one — or, if the
    // control request raced completion, entirely under the old one. Stamping
    // the aggregate with whichever value happened to be current at `result`
    // reports tokens under an effort they did not all run at, and
    // `usage summary --by effort` would carry that straight through.
    //
    // Snapshot-and-compare instead: equal at `result` means one setting
    // covered the whole turn, unequal means the turn is not attributable and
    // records NULL. Same discipline as the model side — never a
    // plausible-looking wrong value.
    //
    // Re-snapshotted at the first message of the NEXT turn rather than at
    // `result`, because settings also change BETWEEN turns (the ordinary
    // path: no turn in flight, applySettings, then push). Snapshotting at
    // `result` would capture the pre-change value and wrongly mark that next,
    // entirely-clean turn as mixed.
    // How many times the effort actually MOVED during the current turn.
    //
    // Endpoint comparison is not enough: a turn admitting two follow-ups can
    // go high -> low -> high and land back where it started, and comparing
    // only the ends calls that constant while part of the turn ran at `low`.
    // Counting transitions is indifferent to where the value lands, so any
    // movement at all makes the turn unattributable.
    //
    // Delimited by the SDK's own `result` events and NOTHING else. Cleared
    // where a turn demonstrably ends (see the `result` branch), never by an
    // external signal.
    //
    // Two earlier shapes put the reset on the input side and both were wrong,
    // in opposite directions. The first SDK message leaves a gap: once a
    // prompt is pushed the CLI may already have issued the request under the
    // old effort while no message has been emitted yet. The push itself is
    // worse, because it is not a boundary at all — poll-loop pushes a
    // follow-up INTO a running turn and the SDK merges it into that turn's
    // single `result`, so resetting there erased exactly the mid-turn
    // transitions this counter exists to catch. Whether a push starts a turn
    // or merges into one is not knowable at push time, by the provider or by
    // anyone else, so the input side cannot answer this question and is no
    // longer asked to.
    //
    // The cost is deliberate: a change made BETWEEN turns also counts, so that
    // turn records NULL even though it arguably ran wholly under the new
    // value. That is the invariant holding — never emit a non-NULL effort you
    // cannot PROVE governed the whole turn — and the timing of a between-turns
    // change relative to the CLI picking up the prompt is precisely what
    // cannot be proven from here. NULL means "not attributable"; declining to
    // answer is always safe, and a confidently wrong value never is.
    let effortTransitionsThisTurn = 0;
    // The canonical id `modelUsage` will be keyed by. Tracked SEPARATELY from
    // activeModel rather than replacing it: activeModel must stay in the form
    // the SDK expects for setModel/clampEffortForModel, while attribution can
    // only compare canonical ids. See canonicalUsageModel.
    let activeUsageModel = canonicalUsageModel(model, perQueryEnv);

    return {
      push: (msg) => stream.push(msg),
      initialPromptId,
      // Holds the turn level while a prompt is unanswered. The hold ends at the
      // prompt's echo or at the CLI's idle; there is no runner-side timer. On
      // this CLI (2.1.272) idle is withheld while background agents run
      // (CLAUDE_CODE_BG_TASKS_REPORT_RUNNING defaults on — verified in the
      // binary's changelog), so a dropped echo during background work holds
      // the level for that work's duration, which is also what
      // hasBackgroundWork below wants; the 30-minute ceiling stays the bound.
      hasQueuedWork: () => sessionStateSeen && stream.outstanding.size > 0,
      // Background agents outlive the turn that launched them; the CLI reports
      // them back into this same stream when they finish (task_notification,
      // then a turn it starts itself). Holding the busy level while any are
      // live is what keeps the task reaper off a container whose parent turn
      // ended on a `wait`. Latched until the CLI's idle — see backgroundHold
      // and AgentQuery.hasBackgroundWork.
      // Gated on sessionStateSeen like hasQueuedWork above: the raise comes
      // from a message the CLI always emits, the release from one it emits
      // only behind CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS — a CLI that has
      // not shown the latter must not be able to pin a container.
      hasBackgroundWork: () => sessionStateSeen && backgroundHold,
      end: () => stream.end(),
      events: translateEvents(),
      // The SDK installs systemPrompt at query creation and exposes no control
      // request to replace it. The poll-loop waits for an idle boundary before
      // a live model/effort change opens a fresh authoritative query.
      requiresRestartForRuntimeContext: true,
      // Live view of `activeModel`, which is the resolved creation model and
      // is reassigned by applySettings. A getter rather than a snapshot so
      // creation and mid-stream retarget cannot report different things.
      get resolvedModel() {
        return activeModel;
      },
      abort: () => {
        aborted = true;
        stream.end();
        // Idempotent: AbortController#abort() on an already-aborted
        // controller is a documented no-op, so a caller that ends up
        // calling abort() more than once for the same query (e.g. both the
        // poll-loop's error-path abort at poll-loop.ts:808 and a config.signal listener firing)
        // never double-tears-down.
        queryAbortController.abort();
      },
      // In-flight -m/-e: same conversation, same stream — the SDK control
      // requests mirror interactive Claude Code's /model. Re-runs the same
      // effort resolution chain as query() so a model switch without an
      // explicit -e lands on the new model's family default (e.g. -m fable
      // mid-turn → fable@medium, not fable@inherited-xhigh).
      applySettings: async (s) => {
        // `s.model === undefined` means LEAVE THE LIVE MODEL UNCHANGED, and
        // that is not an inconsistency with query creation — it is what every
        // caller on this path means. A flagless message arriving mid-turn
        // resolves to `undefined` from `applyFlagBatch` simply because nobody
        // asked for a model; a turn opened with a one-shot `-m1` override
        // would then be dragged off it mid-answer.
        //
        // This was briefly "resolve absence to the group default", to serve a
        // scheduled-task suppression on this path. That caller has since been
        // reverted (see the follow-up issue in CHANGELOG) and the reading went
        // with it. The rule worth keeping: a future attempt to retarget a live
        // model must not do it by REINTERPRETING `undefined`, because this
        // seam is shared with ordinary chat, which legitimately means
        // "unchanged" by it. Pass the model you want explicitly instead.
        //
        // (The effort branch below does resolve its own absence. That is not
        // the same case: effort has no "leave alone" caller here — it is
        // recomputed for the model in force on every call.)
        const newModel = s.model ? ensureOpus1mSuffix(s.model) : undefined;
        if (newModel && newModel !== activeModel) {
          await sdkResult.setModel(newModel);
          activeModel = newModel;
          // A live `-m sonnet` lands here as a bare alias too, so the
          // attribution target has to be re-resolved alongside it.
          activeUsageModel = canonicalUsageModel(newModel, perQueryEnv);
        }
        const requested =
          s.effort ??
          this.stickyConfig.effort ??
          process.env.NANOCLAW_EFFORT_OVERRIDE ??
          defaultEffortForModel(activeModel);
        const clamped = clampEffortForModel(activeModel, requested);
        if (clamped === 'max') {
          // Settings.effortLevel has no 'max' — signal the poll-loop to
          // fall back to reopening the query (where effort is a creation
          // option that does accept max).
          throw new Error("effortLevel control cannot express 'max'");
        }
        const settings: { effortLevel: 'low' | 'medium' | 'high' | 'xhigh' | null; ultracode?: boolean } = {
          effortLevel: (clamped as 'low' | 'medium' | 'high' | 'xhigh' | undefined) ?? null,
        };
        if (s.ultracode !== undefined) settings.ultracode = s.ultracode;
        await sdkResult.applyFlagSettings(settings);
        // Only AFTER the control request lands — the 'max' throw above and any
        // SDK failure must leave the trackers describing what is really in
        // effect, or turn_usage would record an effort the API never saw.
        //
        // Counted only when the value actually MOVES: poll-loop calls this for
        // a model-only change too, and one that resolves to the same effort
        // introduces no ambiguity to account for.
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
