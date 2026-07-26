import fs from 'fs';
import os from 'os';
import path from 'path';

import { z } from 'zod';
import {
  query as sdkQuery,
  type EffortLevel,
  type HookCallback,
  type PreCompactHookInput,
  type PreToolUseHookInput,
  type SdkPluginConfig,
} from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import { TIMEZONE, formatLocalStamp } from '../timezone.js';
import { registerProvider, registerProviderConfigSchema } from './provider-registry.js';
import { buildSecretEnvVarList, MCP_HEADER_ONLY_SECRET_VARS } from './secret-env.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { autoCommitDirtyWorktrees } from '../worktree-autosave.js';
import {
  createMemoryCaptureWebFetchHook,
  createMemoryCaptureBashHook,
  createMemoryCaptureMcpHook,
} from '../mcp-tools/memory-capture.js';

// Per D9 / D7 / A6: 5-value enum matching EffortLevel at
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:462
// (low | medium | high | xhigh | max). Keep in sync with SDK.
export const claudeConfigSchema = z.strictObject({
  model: z.string().min(1).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
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
 * SDK rate-limit events are telemetry unless the SDK explicitly rejects the
 * request. Rejected credit exhaustion is quota; other rejected windows are
 * transient rate limits and retain their reset metadata.
 */
export function classifyRateLimitEvent(
  info: SdkRateLimitInfo | undefined,
): { message: string; classification: 'rate_limit' | 'quota' } | null {
  if (info?.status !== 'rejected') return null;
  const outOfCredits = info.errorCode === 'credits_required' || info.overageDisabledReason === 'out_of_credits';
  let detail = '';
  if (typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)) {
    const ms = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
    detail = ` (resets ${new Date(ms).toISOString()})`;
  }
  const window = info.rateLimitType ? ` [${info.rateLimitType}]` : '';
  return {
    message: `${outOfCredits ? 'Out of credits' : 'Rate limit'}${window}${detail}`,
    classification: outOfCredits ? 'quota' : 'rate_limit',
  };
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
 * The SDK fires `task_notification` for two very different things: real
 * subagent (Task) completions AND auto-backgrounded Bash commands. For a
 * backgrounded Bash task the `summary` is the *raw command text* (env-var
 * unsets, pipelines, python heredocs) — internal noise that leaked into user
 * channels as "> ✅ <command>" and stranded there whenever the command
 * settled after the turn's real reply. Forward completion lines only for
 * genuine subagent work; a known non-Task tool (Bash) is suppressed. An
 * unknown/absent tool_use_id means a planned task not tied to a single tool —
 * forward it (the case the feature was built for).
 */
export function shouldForwardTaskNotification(toolName: string | undefined): boolean {
  return toolName === undefined || toolName === 'Task';
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

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
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

    // Compaction is about to drop the older transcript from context, so
    // pin any uncommitted worktree edits to git FIRST. Without this, the
    // agent can lose its memory of having made the edits and subsequently
    // re-do or undo work that's still in the filesystem but absent from
    // its compacted context. Runs before transcript archiving so even a
    // crash during the archive step keeps the safety commits.
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

// ── Bash secret sanitization hook ──

// ANTHROPIC_API_KEY _N fallback variants (_2, _5, ...). The base-name match
// (ANTHROPIC_KEY_RE) lives in secret-env.ts with the Bash-sanitize list.
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
const RETRYABLE_ERROR_RE = /429|rate[\s_-]?limit|overloaded|upstream_error|External provider returned|subscription_quota_exhausted|subscription_access_disabled/i;

// Claude Max subscription quota exhaustion. The Agent SDK delivers this
// as a plain result-text string rather than a thrown error or a
// `rate_limit_event` system message, so neither the catch-block rotation
// nor the in-stream rate_limit_event path triggers. Detect the text and
// re-throw to engage rotation.
//
// Three distinct surfacings, all handled here:
//   - weekly/extra cap: "You're out of extra usage · resets …"
//   - 5-hour session-window cap: "You've hit your session limit · resets …"
//   - org/credit spend cap: "You've hit your org's monthly spend limit ·
//     ask your admin to raise it at claude.ai/settings/usage" (first seen
//     2026-06-11, ahead of the June-15 Agent SDK credit change; surfaces
//     with "org" wording even on individual subscription accounts)
// Each new wording has broken rotation once before being added: the
// session-window form wasn't matched by the original usage-only regex, and
// the org-spend form wasn't matched by the enumerated-qualifier form — in
// both cases rotation silently failed and the dead-stop quota message was
// dispatched to the user instead of advancing to the next OAuth fallback.
//
// Strict-anchored on the "You're/You've …" sentence opener to avoid
// false-positives on agent prose that mentions "usage" or "limit" in passing.
// The qualifier between "your" and "limit" is a repeated word-class rather
// than an enumerated list so the next wording variant ("daily token limit",
// "org's annual spend limit", …) can't silently re-break rotation; it is
// deliberately scoped to quota-ish words so "you've hit your retry limit"
// style prose still doesn't match.
// The apostrophe class tolerates both straight (U+0027, what the SDK emits
// today) and curly (U+2019) so a typographic change upstream can't silently
// re-break rotation.
export const QUOTA_RESULT_RE =
  /^\s*You['’]?(re|ve) (out of (extra |daily |weekly )?usage|(hit|reached) your ((org['’]?s |team['’]?s |account['’]?s |session |usage |weekly |daily |monthly |annual |spend(ing)? |token |credit )*)limit)\b/i;

// Org-level Claude Code access block, e.g. "Your organization has disabled
// Claude subscription access for Claude Code · Use an Anthropic API key
// instead, or ask your admin to enable access" (first seen 2026-06-11 on a
// fallback account, surfaced mid-rotation after the primary's spend-limit
// exhaustion). Same delivery quirk as QUOTA_RESULT_RE — plain result text,
// not a thrown error — and the same remediation: the credential is unusable,
// so throw to advance rotation to the next OAuth fallback. Distinct marker
// (`subscription_access_disabled`) so logs distinguish a blocked account
// from an exhausted one. Anchored on the "Your <org-word> has disabled
// Claude … access" sentence opener; requires "Claude" + "access" so agent
// prose about other things an org disabled can't match.
export const SUBSCRIPTION_BLOCKED_RE =
  /^\s*Your (organization|org|team|admin|account) has disabled Claude( Code)?( subscription)? access\b/i;

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
// then has to re-prompt (Dave, 2026-06-26: "extremely disrupting" on long
// tasks). Throw with a distinct `transient_overload:` marker so poll-loop's
// catch retries the SAME prompt+continuation with backoff. Rotation is the
// WRONG cure here — "not your usage limit" means the credential is fine, the
// server is busy; another key hits the same overloaded server.
//
// Anchored on the rendered "API Error:" prefix + the specific server-limit
// phrase so an agent quoting these words in prose can't trip it (a normal
// result is the agent's own text, never prefixed "API Error:").
export const TRANSIENT_OVERLOAD_RESULT_RE =
  /^API Error:\s*(?:Server is temporarily limiting requests|Request rejected \(429\))/i;

// buildSecretEnvVarList (the Bash-sanitize unset list) lives in secret-env.ts —
// an SDK-free module so sibling adapters can import the same single-source list.

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

export function createSanitizeBashHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};
    const vars = buildSecretEnvVarList();
    const unsetPrefix = vars.length > 0 ? `unset ${vars.join(' ')} 2>/dev/null; ` : '';
    const wrapCodexStdin = CODEX_EXEC_RE.test(command) && !ALREADY_DEVNULL_STDIN_RE.test(command);

    let rewritten = unsetPrefix + command;
    if (wrapCodexStdin) rewritten = `{ ${rewritten} ; } </dev/null`;
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
  'Direct use of Python snowflake.connector is blocked. Use `snow sql` for ad-hoc queries. If `snow` isn\'t working, report the error rather than falling back to the Python connector.';

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
  const raw =
    (payload as { raw?: unknown })?.raw ??
    (payload as { message?: { raw?: unknown } })?.message?.raw;
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
    _emailGateEvaluators[corePath] =
      typeof core.evaluateEmailSend === 'function' ? core.evaluateEmailSend : null;
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
  // gate. Keep in sync with email-gate-core.ts evaluateEmailSend (QA codex #4/#5).
  if (emailBypassIsRealArgvToken(command)) return { action: 'allow' };

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
  const credsMatch = command.match(
    /GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=\S*?\/accounts\/([\w.-]+)\.json/,
  );
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

export function createEmailGateHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};

    // createSanitizeBashHook runs EARLIER in this chain and rewrites the command
    // to `unset <secret-vars> 2>/dev/null; <original>` (updatedInput). Strip that
    // EXACT, reconstructed prefix before evaluating, so a legit `--dry-run`/`--help`
    // probe isn't gated by the injected `unset …;` — the whole-command bypass would
    // otherwise read `unset` as the first word + a `;` metachar and refuse the
    // bypass. Only the precise sanitizer prefix is stripped (reconstructed from the
    // same buildSecretEnvVarList), never an arbitrary `unset` (which could hide a
    // `$( … )` send), so it can't smuggle a real send past the gate. (codex #126 F1)
    const sanitizeVars = buildSecretEnvVarList();
    const sanitizePrefix = sanitizeVars.length ? `unset ${sanitizeVars.join(' ')} 2>/dev/null; ` : '';
    const evalCommand =
      sanitizePrefix && command.startsWith(sanitizePrefix) ? command.slice(sanitizePrefix.length) : command;

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

    const routing = getSessionRouting();
    const requestId = `gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeMessageOut({
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
        // Empty command → host omits the raw-bash code block in the card.
        // The command is still captured by the SDK's tool-call history
        // and log stream, so we keep audit coverage without showing noise.
        command: '',
      }),
    });

    const ack = await awaitDeliveryAck(requestId, 60 * 60 * 1000);
    if (!ack) {
      return denyBash(`Email ${action} blocked: timed out waiting for admin approval. Do not retry — ask the user.`);
    }
    if (ack.status === 'delivered') {
      return {};
    }
    return denyBash(
      `Email ${action} blocked: ${ack.error ?? 'admin declined'}. Do not retry — acknowledge briefly.`,
    );
  };
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
function discoverPlugins(): SdkPluginConfig[] {
  const pluginsRoot = process.env.CLAUDE_PLUGINS_ROOT || '/workspace/plugins';
  if (!fs.existsSync(pluginsRoot)) return [];
  const plugins: SdkPluginConfig[] = [];
  const hasManifest = (p: string) => fs.existsSync(path.join(p, '.claude-plugin', 'plugin.json'));
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(pluginsRoot);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const repoPath = path.join(pluginsRoot, entry);
    try {
      if (!fs.statSync(repoPath).isDirectory()) continue;
    } catch {
      continue;
    }
    if (hasManifest(repoPath)) {
      plugins.push({ type: 'local', path: repoPath });
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
      try {
        if (!fs.statSync(subPath).isDirectory()) continue;
      } catch {
        continue;
      }
      if (hasManifest(subPath)) {
        plugins.push({ type: 'local', path: subPath });
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
        try {
          if (!fs.statSync(sub2Path).isDirectory()) continue;
        } catch {
          continue;
        }
        if (hasManifest(sub2Path)) {
          plugins.push({ type: 'local', path: sub2Path });
        }
      }
    }
  }
  return plugins;
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

/** Epoch-ms of the first transcript entry, or null if unreadable. */
function transcriptStartMs(transcriptPath: string): number | null {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.toString('utf-8', 0, n).split('\n', 1)[0];
      const ts = JSON.parse(firstLine)?.timestamp;
      const ms = ts ? Date.parse(ts) : NaN;
      return Number.isNaN(ms) ? null : ms;
    } finally {
      fs.closeSync(fd);
    }
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
  // Fable shares the opus 1M-only policy (single-digit version: claude-fable-5).
  // Opus itself now spans both version schemes: claude-opus-4-8 and claude-opus-5.
  // Keep in sync with src/flag-parser.ts ensureOpus1mSuffix.
  return /^claude-(?:opus-\d+(?:-\d+)?|fable-\d+)$/i.test(model) ? `${model}[1m]` : model;
}

/**
 * Per-model-family default effort, applied only when nothing upstream chose
 * one (-e flag, group provider config, operator NANOCLAW_EFFORT_OVERRIDE).
 *
 *   opus 4.7+ → xhigh — the recommended starting point for coding/agentic
 *           work per the effort docs; deliberate fleet default (operator
 *           decision 2026-06-10). Opus 4.6 caps at high (no xhigh support).
 *   fable → high  — fable's docs recommend `high` as the default starting
 *           point; lower levels "often exceed xhigh performance on prior
 *           models", and fable bills 2x Opus ($10/$50 per MTok).
 *   sonnet → xhigh — Sonnet 5 (the bare `sonnet` alias) defaults to xhigh, the
 *           recommended setting for coding/agentic work; fleet decision,
 *           mirrors opus 4.7+. (This fork only runs Sonnet 5.)
 *   haiku → undefined — no effort control at the API level.
 *
 * `-e <level>` (turn or sticky) always wins over all of these — subject to
 * clampEffortForModel below.
 */
function defaultEffortForModel(model: string | undefined): string | undefined {
  if (!model) return 'high';
  const m = model.toLowerCase();
  if (m === 'opus' || m.startsWith('claude-opus-')) {
    // 4.6 and earlier have no xhigh (xhigh shipped with 4.7).
    return /^claude-opus-4-[0-6]\b/.test(m) ? 'high' : 'xhigh';
  }
  // Sonnet 5 (the bare `sonnet` alias resolves to it) defaults to xhigh.
  if (m === 'sonnet' || m.startsWith('claude-sonnet-')) return 'xhigh';
  if (m.startsWith('claude-fable-')) return 'high';
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
  const supported = (() => {
    if (m === 'haiku' || m.startsWith('claude-haiku-')) return new Set<string>();
    if (/^claude-opus-4-[0-6]\b/.test(m)) return new Set(['low', 'medium', 'high', 'max']);
    // opus 4.7+, sonnet 5 + bare `sonnet`/`opus` aliases, fable, unknown future
    // models: full surface (incl. xhigh).
    return new Set(['low', 'medium', 'high', 'xhigh', 'max']);
  })();
  if (supported.has(effort)) return effort;
  return defaultEffortForModel(model);
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
  private model?: string;
  private effort?: string;
  private memorySessionHook?: MemorySessionHookRegistration;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.env = filterSdkEnv({ ...(options.env ?? {}), CLAUDE_CODE_AUTO_COMPACT_WINDOW });
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
      log(`Loaded ${this.fallbackKeys.length} ANTHROPIC_API_KEY fallback(s): ${this.fallbackKeys.map((k) => k.name).join(', ')}`);
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
      log(`Loaded ${this.fallbackOauth.length} CLAUDE_CODE_OAUTH_TOKEN fallback(s): ${this.fallbackOauth.map((k) => k.name).join(', ')}`);
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
    this.model = options.model;
    this.effort = options.effort;
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
   * retryable error, slot N+1 stays active for all subsequent queries.
   * Restarting the container is the only reset.
   *
   * Process-wide propagation: rotations are mirrored to `process.env` so
   * other in-process consumers that issue direct Anthropic calls — the
   * thread-search Haiku rerank, future MCP tools, anything reading
   * process.env — pick up the active credential without their own
   * rotation logic. Safe because (a) container code reads env fresh at
   * call time (no module-load captures), (b) the bash sanitize hook
   * filters by key name not value so its scrub list is unchanged, and
   * (c) host-side container-runner.ts adds api.anthropic.com to NO_PROXY
   * and re-injects the real token values, so direct callers bypass the
   * OneCLI proxy and use process.env directly.
   */
  rotateApiKey(): { rotated: boolean } {
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
      return { rotated: true };
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
    return { rotated: true };
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
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    // Per-turn input takes precedence over sticky config (A3).
    // Normalize bare opus → [1m] so the CLI's auto-compact window stays at 1M
    // regardless of auth path (see ensureOpus1mSuffix).
    //
    // Final fallback is the `opus` ALIAS, never undefined: with model
    // undefined the CLI uses its own built-in default — which for a pinned
    // binary is whatever Opus was current at its release (2.1.156 → opus-4-7,
    // observed live 2026-06-09), silently ignoring the configured
    // ANTHROPIC_DEFAULT_OPUS_MODEL chain (channel default → container.json →
    // DEFAULT_OPUS_MODEL). The bare alias forces resolution through that env
    // var, making the documented precedence the real behavior.
    const rawModel = input.model ?? this.stickyConfig.model ?? 'opus';
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
    const plugins = discoverPlugins();
    if (plugins.length > 0) {
      log(`Loaded ${plugins.length} plugin(s): ${plugins.map((p) => path.basename(p.path)).join(', ')}`);
    }

    // Leave CLAUDE_CODE_SUBAGENT_MODEL unset: a concrete value outranks
    // per-invocation and frontmatter model selection, pinning every subagent
    // to the group model; subagents without an explicit model already inherit
    // the main model. The family env vars below only resolve matching bare
    // aliases (docs: code.claude.com/docs/en/sub-agents.md).
    const perQueryEnv: Record<string, string | undefined> = { ...this.env };
    if (model) {
      // Guard: a bare alias here would create an alias→alias loop in the SDK.
      if (!/^(opus|sonnet|haiku|default)$/i.test(model)) {
        const family = /^claude-(opus|sonnet|haiku)-/i.exec(model)?.[1]?.toLowerCase();
        if (family === 'opus') perQueryEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
        if (family === 'sonnet') perQueryEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
        if (family === 'haiku') perQueryEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      }
    }

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        model: model,
        ...(effort ? { effort: effort as EffortLevel } : {}),
        // `display: 'summarized'` makes thinking text visible in content
        // blocks; default is empty-text + signature only.
        thinking: { type: 'adaptive', display: 'summarized' },
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions } : undefined,
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
              // Order matters: sanitize runs first so blocked commands
              // also get the unset prefix stripped from logs. Block
              // hooks run after and return deny if they match.
              hooks: [
                createSanitizeBashHook(),
                createSelfApprovalBlockHook(),
                createBlockSnowflakeConnectorHook(),
                createBlockGitCloneHook(),
                createBlockCodexCompanionHook(),
                createEmailGateHook(),
              ],
            },
          ],
          PostToolUse: [
            { hooks: [postToolUseHook] },
            // Capture intentionally fetched knowledge into sources/inbox.
            // Graphify watches the workgroup source tree and indexes these
            // files for autonomous Graphify discovery without an opt-in flag.
            { matcher: 'WebFetch', hooks: [createMemoryCaptureWebFetchHook()] },
            { matcher: 'Bash', hooks: [createMemoryCaptureBashHook()] },
            // mcp__.* matches every MCP tool call; the hook itself dispatches
            // through its allowlist and ignores non-durable results.
            { matcher: 'mcp__.*', hooks: [createMemoryCaptureMcpHook()] },
          ],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
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
          log(`applyFlagSettings(ultracode) failed — continuing without: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        // Yield activity for every SDK event so the poll loop knows the agent is working
        yield { type: 'activity' };

        if (message.type === 'system' && message.subtype === 'init') {
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'result') {
          // `result` text exists only on subtype:"success"; error subtypes
          // (e.g. a non-retryable 403 billing_error) carry their message in
          // `errors[]` instead. Surface either so the poll-loop can deliver a
          // billing/quota notice to the user rather than dropping the turn.
          const m = message as { result?: string; is_error?: boolean; errors?: string[] };
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
          yield { type: 'result', text, isError: m.is_error === true };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'rate_limit_event') {
          const info = (message as { rate_limit_info?: SdkRateLimitInfo }).rate_limit_info;
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
            yield { type: 'error', message: blocked.message, retryable: false, classification: blocked.classification };
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
          if (shouldForwardTaskNotification(toolName)) {
            const summary = tn.summary || 'Task notification';
            const emoji = (tn.status && TASK_NOTIFICATION_EMOJI[tn.status]) || '🔧';
            yield { type: 'progress', message: formatBlockquoteLabel(emoji, summary) };
          }
        } else if (message.type === 'assistant') {
          // Record tool_use id → name so a later task_notification can be
          // classified (Task subagent vs backgrounded Bash). See
          // shouldForwardTaskNotification.
          const blocks = (message as { message?: { content?: unknown } }).message?.content;
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              const b = block as { type?: string; id?: string; name?: string };
              if (b.type === 'tool_use' && b.id && b.name) toolNameById.set(b.id, b.name);
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
      log(`Query completed after ${messageCount} SDK messages`);
    }

    // Tracks the model the live query is currently on — updated by
    // applySettings so a later effort-only change clamps against the
    // model actually in effect, not the one the query started with.
    let activeModel = model;

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
      // In-flight -m/-e: same conversation, same stream — the SDK control
      // requests mirror interactive Claude Code's /model. Re-runs the same
      // effort resolution chain as query() so a model switch without an
      // explicit -e lands on the new model's family default (e.g. -m fable
      // mid-turn → fable@high, not fable@inherited-xhigh).
      applySettings: async (s) => {
        const newModel = s.model ? ensureOpus1mSuffix(s.model) : undefined;
        if (newModel && newModel !== activeModel) {
          await sdkResult.setModel(newModel);
          activeModel = newModel;
        }
        const requested =
          s.effort ?? this.stickyConfig.effort ?? process.env.NANOCLAW_EFFORT_OVERRIDE ?? defaultEffortForModel(activeModel);
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
        log(
          `applySettings (live): model=${activeModel ?? '(unchanged)'} effort=${clamped ?? '(none)'}` +
            `${s.ultracode !== undefined ? ` ultracode=${s.ultracode}` : ''}`,
        );
      },
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
registerProviderConfigSchema('claude', claudeConfigSchema);
