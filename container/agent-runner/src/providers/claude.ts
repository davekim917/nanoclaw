import fs from 'fs';
import path from 'path';

import {
  query as sdkQuery,
  type HookCallback,
  type PreCompactHookInput,
  type PreToolUseHookInput,
  type SdkPluginConfig,
} from '@anthropic-ai/claude-agent-sdk';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { autoCommitDirtyWorktrees } from '../worktree-autosave.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

/**
 * Derive a short human-friendly progress label from an assistant message
 * that contains a tool_use block. Returns null if the message has no
 * tool_use (agent is just emitting text), so the caller skips emitting
 * progress for those.
 */
function deriveToolProgressLabel(message: unknown): string | null {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
    if (b.type !== 'tool_use') continue;
    const name = b.name ?? 'tool';
    const input = b.input ?? {};
    switch (name) {
      case 'Bash': {
        const cmd = typeof input.command === 'string' ? input.command.split('\n')[0].slice(0, 60) : '';
        return cmd ? `Running: ${cmd}` : 'Running command';
      }
      case 'Read':
      case 'Glob':
        return `Reading files`;
      case 'Grep':
        return `Searching`;
      case 'Edit':
      case 'Write':
      case 'NotebookEdit':
        return `Editing files`;
      case 'WebSearch':
        return `Web search`;
      case 'WebFetch':
        return `Fetching web page`;
      case 'TodoWrite':
        return `Planning`;
      case 'Task':
        return `Delegating subtask`;
      case 'ToolSearch':
        return `Looking up tools`;
      case 'Skill':
        return `Invoking skill`;
      default:
        if (name.startsWith('mcp__')) {
          const parts = name.split('__');
          return `Using ${parts[parts.length - 1] ?? name}`;
        }
        return `Using ${name}`;
    }
  }
  return null;
}

// Deferred SDK builtins that would sidestep nanoclaw's own scheduling.
// Scheduling goes through mcp__nanoclaw__schedule_task so that tasks are
// durable across sessions/restarts and gated by our pre-task script hook.
const SDK_DISALLOWED_TOOLS = ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup'];

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
        const text = typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text);
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
  const dateStr = now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const { transcript_path: transcriptPath, session_id: sessionId } = preCompact;

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

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);
      if (messages.length === 0) return {};

      // Try to get summary from sessions index
      let summary: string | undefined;
      const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
      if (fs.existsSync(indexPath)) {
        try {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          summary = index.entries?.find((e: { sessionId: string; summary?: string }) => e.sessionId === sessionId)?.summary;
        } catch {
          /* ignore */
        }
      }

      const name = summary
        ? summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
        : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

      const conversationsDir = '/workspace/agent/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });
      const filename = `${new Date().toISOString().split('T')[0]}-${name}.md`;
      fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));
      log(`Archived conversation to ${filename}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };
}

// ── Bash secret sanitization hook ──

// ANTHROPIC_API_KEY and its _N fallback variants (_2, _5, ...).
const ANTHROPIC_KEY_RE = /^ANTHROPIC_API_KEY(_\d+)?$/;
const ANTHROPIC_FALLBACK_RE = /^ANTHROPIC_API_KEY_(\d+)$/;

// Retryable upstream errors. v1's list — see
// container/agent-runner/src/index.ts:470-478.
const RETRYABLE_ERROR_RE = /429|rate[\s_-]?limit|overloaded|upstream_error|External provider returned/i;

// Secrets the SDK needs for API auth but that Bash subprocesses must not see.
// Built lazily inside the hook so late-bound env additions are covered.
//
// NANOCLAW_GH_TOKEN / GH_TOKEN / GITHUB_TOKEN are deliberately NOT in this
// list. Stripping them would break the very thing the URL-scoped credential
// helper is trying to enable: git invokes its helper via a subprocess that
// inherits the Bash env, and the helper reads NANOCLAW_GH_TOKEN from there
// to hand back to git. An agent that wants to exfiltrate the token can
// `printenv` it — the mitigation is at the URL-scoped helper (token is
// useless outside the allowlisted orgs) and at auth-level controls on
// GitHub's side, not at the bash-env boundary.
function buildSecretEnvVarList(): string[] {
  return [
    ...Object.keys(process.env).filter((k) => ANTHROPIC_KEY_RE.test(k)),
    'CLAUDE_CODE_OAUTH_TOKEN',
    'GMAIL_OAUTH_PATH',
    'GMAIL_CREDENTIALS_PATH',
  ];
}

function createSanitizeBashHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};
    const vars = buildSecretEnvVarList();
    if (vars.length === 0) return {};
    const unsetPrefix = `unset ${vars.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(pre.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
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

// ── Self-approval block ──
// The bootstrap/plugins/workflow plugin's block-destructive hook gates
// destructive filesystem ops behind a file-based approval at
// `.claude-destructive-gate`. This hook prevents the agent from bypassing
// that gate by writing the approval file itself via Bash (`touch
// .claude-destructive-gate`, `echo … > .claude-destructive-gate`, etc.).
// Admin approval must come through the chat channel, not the agent's own
// filesystem writes. v1 `createSelfApprovalBlockHook` equivalent.
const SELF_APPROVAL_RE = /\.claude-destructive-gate/;

function createSelfApprovalBlockHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};
    if (SELF_APPROVAL_RE.test(command)) {
      return denyBash(
        'Self-approval of destructive operation gates is not allowed. Approval must come from the user via the chat channel, not by writing .claude-destructive-gate yourself.',
      );
    }
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
const SNOWFLAKE_CONNECTOR_EXEC_RE = /\bpython[23]?\b.*\bsnowflake[._]connector\b/i;

function createBlockSnowflakeConnectorHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};
    if (SNOWFLAKE_CONNECTOR_EXEC_RE.test(command)) {
      return denyBash(
        'Direct use of Python snowflake.connector is blocked. Use `snow sql` for ad-hoc queries. If `snow` isn\'t working, report the error rather than falling back to the Python connector.',
      );
    }
    return {};
  };
}

// ── Email gate ──
// Intercept `gws gmail +send|reply|reply-all|forward` and require admin
// approval before the command runs. Scheduled-task contexts bypass
// (automated email workflows shouldn't prompt every time). --dry-run /
// --draft also bypass since nothing actually sends.
//
// Approval round-trip uses the existing send_file delivery-ack surface:
// write a system action with action='request_bash_gate' to outbound.db;
// host's bash-gate module calls requestApproval and writes the decision
// back to inbound.db's `delivered` table; we poll it via
// awaitDeliveryAck. Up to 30 minutes.
const GWS_EMAIL_SEND_RE = /\bgws\s+gmail\s+\+(?:send|reply|reply-all|forward)\b/;
// `(?:\s|$)` anchor prevents `--dry-run=false` from matching. The prior
// `\b` alone was satisfied by `=`, which turned the guard into a trivial
// bypass: `gws gmail +send --dry-run=false --to attacker@…` skipped the
// approval while still sending.
const EMAIL_BYPASS_RE = /\s--(?:dry-run|draft)(?:\s|$)/;

function createEmailGateHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command || !GWS_EMAIL_SEND_RE.test(command)) return {};

    // Bypass on --dry-run / --draft, but only in the segment containing
    // the gws command — a later bypass flag in a piped cleanup step must
    // not silently suppress the gate for the sending command.
    const segments = command.split(/[;&|]\s*|\s*&&\s*|\s*\|\|\s*|\n/);
    const gwsSegment = segments.find((s) => GWS_EMAIL_SEND_RE.test(s)) ?? command;
    if (EMAIL_BYPASS_RE.test(gwsSegment)) return {};

    // Scheduled tasks intentionally bypass — v1 also did this so
    // automated email reports aren't prompted every run.
    if (process.env.NANOCLAW_IS_SCHEDULED_TASK === '1') return {};

    const toMatch = gwsSegment.match(/--to\s+['"]?([^\s'"]+)/);
    const subjectMatch =
      gwsSegment.match(/--subject\s+['"]([^'"]+)['"]/) ?? gwsSegment.match(/--subject\s+(\S+)/);
    const to = toMatch?.[1] ?? 'unknown recipient';
    const subject = subjectMatch?.[1] ?? '';
    const action = command.match(/\+(\w[\w-]*)/)?.[1] ?? 'send';
    const label = subject ? `Email ${action} to ${to}: "${subject}"` : `Email ${action} to ${to}`;

    // Dynamic imports to avoid any risk of circular-import with the DB
    // module graph during provider init.
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
        summary: `Approve email ${action}?`,
        command: command.slice(0, 500),
      }),
    });

    const ack = await awaitDeliveryAck(requestId, 30 * 60 * 1000);
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
const GIT_CLONE_RE = /\bgit\s+clone\b/;
const MANAGED_DIR_RE = /\/workspace\/(?:agent|worktrees|global|extra|thread|plugins)\b/;

function createBlockGitCloneHook(): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const command = (pre.tool_input as { command?: string })?.command;
    if (!command) return {};
    if (!GIT_CLONE_RE.test(command)) return {};
    if (MANAGED_DIR_RE.test(command)) {
      return denyBash(
        '`git clone` with any reference to /workspace/{agent,worktrees,...} is blocked. Use the `create_worktree` MCP tool for a managed worktree under /workspace/worktrees/<repo>, or `clone_repo` to add a repo to the agent group. If the clone is ephemeral, keep the entire command within /tmp.',
      );
    }
    // Allow pure /tmp-only clones (tool installs, scratch builds).
    return {};
  };
}

// ── SDK env denylist ──

// These secrets are either rotating short-lived tokens (Granola) or
// HTTP-header-only auth values (Exa, Braintrust MCP). They are intentionally
// passed as MCP server headers at registration time, not as Bash-visible env.
// Forwarding them into the SDK's child-process env defeats that isolation.
const SDK_ENV_DENYLIST: ReadonlySet<string> = new Set([
  'GRANOLA_ACCESS_TOKEN',
  'EXA_API_KEY',
  'BRAINTRUST_API_KEY',
]);

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
        if (hasManifest(sub2Path)) plugins.push({ type: 'local', path: sub2Path });
      }
    }
  }
  return plugins;
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = '165000';

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

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

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.env = filterSdkEnv({
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    });
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
    const msg = err instanceof Error ? err.message : String(err);
    return RETRYABLE_ERROR_RE.test(msg);
  }

  /**
   * Advance ANTHROPIC_API_KEY to the next fallback in the configured list.
   * Position persists for the container lifetime — once key N fires a
   * retryable error, key N+1 stays active for all subsequent queries. We
   * don't walk backwards; re-starting the container is the reset. Returns
   * false when no more fallbacks remain (caller should surface the error
   * to the user).
   */
  rotateApiKey(): boolean {
    if (this.nextFallback >= this.fallbackKeys.length) return false;
    const next = this.fallbackKeys[this.nextFallback++];
    if (this.env.ANTHROPIC_API_KEY === next.value) {
      // Already rotated to this one (e.g. base key already matched a
      // fallback by coincidence). Try the next one instead.
      return this.rotateApiKey();
    }
    this.env.ANTHROPIC_API_KEY = next.value;
    log(`Rotated ANTHROPIC_API_KEY → ${next.name} (${this.nextFallback}/${this.fallbackKeys.length})`);
    return true;
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    // Discover plugins each query so hot-mounted plugin drops are picked up
    // without a container restart. Cheap (just fs.readdir under
    // /workspace/plugins); if it grows expensive, hoist to constructor.
    const plugins = discoverPlugins();
    if (plugins.length > 0) {
      log(`Loaded ${plugins.length} plugin(s): ${plugins.map((p) => path.basename(p.path)).join(', ')}`);
    }

    // Effort level rides in env (SDK surfaces it via settings, not query
    // options). CLAUDE_CODE_SUBAGENT_MODEL propagates the same model to
    // subagents so teams/sub-queries don't silently downgrade.
    const perQueryEnv: Record<string, string | undefined> = { ...this.env };
    if (input.effort) {
      perQueryEnv.CLAUDE_CODE_USE_EFFORT = input.effort;
      perQueryEnv.CLAUDE_CODE_EFFORT_LEVEL = input.effort;
    }
    if (input.model) {
      perQueryEnv.CLAUDE_CODE_SUBAGENT_MODEL = input.model;
    }

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        model: input.model,
        systemPrompt: instructions ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions } : undefined,
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: perQueryEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
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
                createEmailGateHook(),
              ],
            },
          ],
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

      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        // Yield activity for every SDK event so the poll loop knows the agent is working
        yield { type: 'activity' };

        if (message.type === 'system' && message.subtype === 'init') {
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'result') {
          const text = 'result' in message ? (message as { result?: string }).result ?? null : null;
          yield { type: 'result', text };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'rate_limit_event') {
          yield { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
          const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
          yield { type: 'result', text: `Context compacted${detail}.` };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          const tn = message as { summary?: string };
          yield { type: 'progress', message: tn.summary || 'Task notification' };
        } else if (message.type === 'assistant') {
          // Fallback progress: SDK task_notification only fires for
          // multi-step planned tasks, so simple turns (single tool call,
          // direct answers) never get a status line. Derive a short label
          // from the first tool_use block on each assistant turn.
          const now = Date.now();
          if (now - lastToolProgressAt >= TOOL_PROGRESS_MIN_INTERVAL_MS) {
            const label = deriveToolProgressLabel(message);
            if (label) {
              yield { type: 'progress', message: label };
              lastToolProgressAt = now;
            }
          }
        }
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
