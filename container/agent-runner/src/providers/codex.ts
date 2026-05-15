/**
 * OpenAI Codex provider — wraps `codex app-server` via JSON-RPC.
 *
 * Unlike the (deprecated) @openai/codex-sdk approach, the app-server
 * protocol exposes proper session/stream semantics, native compaction, and
 * stable MCP config via ~/.codex/config.toml — which is the same mechanism
 * the standalone codex CLI uses, so the container and host share one
 * provider-integration story.
 *
 * Codex turns don't accept mid-turn input. Follow-up `push()` messages are
 * queued and drained after the current turn completes (same pattern as the
 * opencode provider — see poll-loop for why that's correct: the poll-loop
 * only pushes once it has new pending messages, and we only drain between
 * turns, so no message is dropped).
 */
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { registerProvider, registerProviderConfigSchema } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import {
  type AppServer,
  type CodexMcpServer,
  type JsonRpcNotification,
  STALE_THREAD_RE,
  attachCodexAutoApproval,
  createCodexConfigOverrides,
  initializeCodexAppServer,
  killCodexAppServer,
  spawnCodexAppServer,
  startCodexTurn,
  startOrResumeCodexThread,
  steerCodexTurn,
  writeCodexHooksJson,
  writeCodexMcpConfigToml,
} from './codex-app-server.js';

/** Hard ceiling for a single turn. Guards against app-server wedging. */
const TURN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Lookup tables for translating Codex's `collabAgentToolCall` tool names
 * into human-readable progress labels. See the schema
 * `definitions/CollabAgentTool` in `codex_app_server_protocol.schemas.json`.
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

// ── Provider config schema ──────────────────────────────────────────────────
// Mirrors the `claudeConfigSchema` pattern but with Codex-native vocabulary:
// `reasoning_effort` instead of Claude's `effort`. Enum mirrors the
// `ReasoningEffort` definition exposed by `codex app-server generate-json-schema`
// (none | minimal | low | medium | high | xhigh) — gpt-5.2-codex and gpt-5.5
// both support xhigh per OpenAI's model docs.
//
// Default is `xhigh` for the production model (gpt-5.5); operators can dial
// down per-agent via container.json when cost/latency matters more than
// reasoning depth.
//
// Sticky-only: `model` and `reasoning_effort` are applied at thread-start /
// codex-spawn time and persist for the session. Per-turn overrides for these
// fields are not currently exposed by Codex's `thread/start` shape.
export const codexConfigSchema = z.strictObject({
  model: z.string().min(1).optional(),
  reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional().default('xhigh'),
});

registerProviderConfigSchema('codex', codexConfigSchema);

// ── System-prompt assembly ──────────────────────────────────────────────────
// Codex's app-server doesn't expand Claude Code's `@-import` syntax in
// CLAUDE.md, and doesn't auto-load CLAUDE.local.md from the working dir the
// way Claude Code does. Left alone, the agent sees only the raw import
// directives as literal text and none of the composed content — no shared
// CLAUDE.md, no module fragments, no per-group memory. We resolve both here
// so Codex (and any other non-Claude provider) gets the same effective
// system prompt the Claude provider gets natively.

/**
 * Inline `@<path>` import directives (line-anchored) with the contents of
 * the referenced file, resolved relative to `baseDir`. Recurses so imports
 * within imported files expand too. Cycles and missing files are silently
 * dropped (replaced with empty text) rather than left as raw `@path` lines,
 * which would confuse the model.
 */
export function resolveClaudeImports(content: string, baseDir: string, seen: Set<string> = new Set()): string {
  return content.replace(/^@(\S+)\s*$/gm, (_match, importPath: string) => {
    try {
      const resolved = path.resolve(baseDir, importPath);
      if (seen.has(resolved)) return '';
      if (!fs.existsSync(resolved)) return '';
      const nextSeen = new Set(seen);
      nextSeen.add(resolved);
      const imported = fs.readFileSync(resolved, 'utf-8');
      return resolveClaudeImports(imported, path.dirname(resolved), nextSeen);
    } catch {
      return '';
    }
  });
}

function readAgentAndGlobalClaudeMd(): string | undefined {
  // Per-group CLAUDE.md is responsible for pulling in the global instructions
  // if the group wants them (the default scaffold starts with
  // `@./.claude-global.md` which resolveClaudeImports inlines). Appending
  // `/workspace/global/CLAUDE.md` explicitly here would double-inline the
  // global content for any non-main group, wasting context tokens and
  // risking contradictory instructions. Groups that don't import global
  // intentionally don't get it — same as Claude-backed agents.
  const groupDir = '/workspace/agent';
  const groupPath = `${groupDir}/CLAUDE.md`;
  const localPath = `${groupDir}/CLAUDE.local.md`;
  const parts: string[] = [];

  if (fs.existsSync(groupPath)) {
    parts.push(resolveClaudeImports(fs.readFileSync(groupPath, 'utf-8'), groupDir));
  }
  if (fs.existsSync(localPath)) {
    parts.push(resolveClaudeImports(fs.readFileSync(localPath, 'utf-8'), groupDir));
  }

  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
}

function composeBaseInstructions(promptAddendum: string | undefined): string | undefined {
  const claudeMd = readAgentAndGlobalClaudeMd();
  const pieces = [claudeMd, promptAddendum].filter((s): s is string => Boolean(s));
  return pieces.length > 0 ? pieces.join('\n\n---\n\n') : undefined;
}

// ── Provider ────────────────────────────────────────────────────────────────

export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly mcpServers: Record<string, CodexMcpServer>;
  private readonly model: string;
  private readonly stickyConfig: z.infer<typeof codexConfigSchema>;

  constructor(options: ProviderOptions = {}) {
    // Codex only supports stdio MCP servers. Filter out any http/sse entries.
    const stdioOnly: Record<string, CodexMcpServer> = {};
    for (const [name, cfg] of Object.entries(options.mcpServers ?? {})) {
      if (cfg && (cfg.type === undefined || cfg.type === 'stdio') && 'command' in cfg) {
        stdioOnly[name] = { command: cfg.command, args: cfg.args, env: cfg.env };
      }
    }
    this.mcpServers = stdioOnly;

    // Defensive re-parse (R8): catches hand-edited container.json or self-mod
    // mutations on startup before they reach codex.
    this.stickyConfig = codexConfigSchema.parse(options.providerConfig ?? {});

    // Model precedence: stickyConfig (per-agent) > CODEX_MODEL env (host
    // default) > built-in default.
    this.model =
      this.stickyConfig.model ??
      (options.env?.CODEX_MODEL as string | undefined) ??
      'gpt-5.5';
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_THREAD_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [];
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

    async function* gen(): AsyncGenerator<ProviderEvent> {
      // One app-server per query invocation. The poll-loop keeps a single
      // query active per batch of pending messages and ends it on idle, so
      // spawn-per-query matches that cadence naturally.
      writeCodexMcpConfigToml(self.mcpServers);
      writeCodexHooksJson();
      const server = spawnCodexAppServer(createCodexConfigOverrides(self.stickyConfig));
      turnTracker.server = server;
      attachCodexAutoApproval(server);

      let threadId: string | undefined = input.continuation;
      let initYielded = false;

      try {
        await initializeCodexAppServer(server);

        const threadParams = {
          model: self.model,
          cwd: input.cwd,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          personality: 'friendly',
          baseInstructions: composeBaseInstructions(input.systemContext?.instructions),
        };

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

          // One turn = one channel of streaming events. Each notification
          // from the app-server yields an `activity` first (so the
          // poll-loop's idle timer stays honest) and then, where relevant,
          // an init / result / progress event.
          yield* runOneTurn(
            server,
            threadId!,
            text,
            self.model,
            input.cwd,
            () => initYielded,
            () => {
              initYielded = true;
            },
            turnTracker,
          );
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
          void steerCodexTurn(turnTracker.server, {
            threadId: turnTracker.threadId,
            expectedTurnId,
            inputText: message,
          }).catch(() => {
            pending.push(message);
            kick();
          });
          return;
        }
        pending.push(message);
        kick();
      },
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

// ── Per-turn event pump ─────────────────────────────────────────────────────
// Pulled out because the gen() loop above reads cleaner with it extracted,
// and because it's a natural seam for future unit tests that drive it with
// a fake notification stream.

async function* runOneTurn(
  server: AppServer,
  threadId: string,
  inputText: string,
  model: string,
  cwd: string,
  hasInit: () => boolean,
  markInit: () => void,
  turnTracker?: { currentTurnId: string | null },
): AsyncGenerator<ProviderEvent> {
  // Mutable refs via object properties — TS can't track closure assignments
  // for narrowing, but property access keeps the declared type visible.
  const turnState: { error: Error | null } = { error: null };
  let resultText = '';
  let turnDone = false;
  // Accumulates reasoning text deltas (raw or summary) between section
  // breaks; flushed as a 💭 progress label on summaryPartAdded or
  // turn/completed. See the case handlers below for details.
  let reasoningBuffer = '';

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

  const handler = (n: JsonRpcNotification): void => {
    const method = n.method;
    const params = n.params;

    // Every inbound notification counts as activity for the poll-loop's
    // idle timer — yield before any event-specific translation so even
    // long tool executions keep the loop awake.
    buffer.push({ type: 'activity' });

    // TEMP DEBUG: log every method + relevant payload to diagnose missing
    // reasoning events.
    if (method.includes('reasoning') || method.startsWith('item/') || method === 'turn/started' || method === 'turn/completed') {
      let extra = '';
      if (method === 'item/started' || method === 'item/completed') {
        const item = (params as { item?: { type?: string; text?: string } }).item;
        const txtPreview = typeof item?.text === 'string' ? item.text.slice(0, 80) : undefined;
        extra = ` item.type=${item?.type ?? '?'}` + (txtPreview ? ` text="${txtPreview}"` : '');
      }
      // eslint-disable-next-line no-console
      console.error(`[codex-debug] method=${method}${extra}`);
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
        const tid = (params as { turnId?: string }).turnId
          ?? ((params as { turn?: { id?: string } }).turn?.id);
        if (turnTracker && typeof tid === 'string') turnTracker.currentTurnId = tid;
        break;
      }
      case 'item/agentMessage/delta': {
        const delta = params.delta as string;
        if (delta) resultText += delta;
        break;
      }
      case 'item/started': {
        // Surface subagent activity (spawn/wait/close) as progress events
        // so the dashboard + Slack status messages show the same kind of
        // signal Claude sessions emit via parent_tool_use_id rendering.
        // Codex shape (per codex_app_server_protocol schema):
        //   { type: 'collabAgentToolCall', tool: <spawnAgent|sendInput|
        //     resumeAgent|wait|closeAgent>, senderThreadId, receiverThreadIds }
        const item = params.item as
          | {
              type?: string;
              tool?: 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent';
              receiverThreadIds?: string[];
            }
          | undefined;
        if (item?.type === 'collabAgentToolCall' && item.tool) {
          const emoji = COLLAB_TOOL_EMOJI[item.tool] ?? '🔧';
          const verb = COLLAB_TOOL_VERB[item.tool] ?? item.tool;
          const recv = item.receiverThreadIds?.length
            ? ` (${item.receiverThreadIds.length} agent${item.receiverThreadIds.length === 1 ? '' : 's'})`
            : '';
          buffer.push({ type: 'progress', message: `${emoji} subagent: ${verb}${recv}` });
        }
        break;
      }
      case 'item/completed': {
        const item = params.item as { type?: string; text?: string } | undefined;
        if (item?.type === 'agentMessage' && item.text) resultText = item.text;
        break;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        // Codex emits one of these (per `show_raw_agent_reasoning` config —
        // default false → summary deltas). Accumulate until a section
        // break or turn end flushes as a 💭 thinking label, mirroring
        // Claude's thinking-block UX. Suppressed when NANOCLAW_HIDE_THINKING=1.
        const delta = params.delta as string;
        if (delta && thinkingForwardingEnabled()) reasoningBuffer += delta;
        break;
      }
      case 'item/reasoning/summaryPartAdded':
        // Codex finalized a reasoning summary section. Emit whatever we
        // accumulated so the user sees thinking updates as they happen,
        // not just one giant label at turn end.
        flushReasoning();
        break;
      case 'turn/completed':
        flushReasoning();
        if (turnTracker) turnTracker.currentTurnId = null;
        turnDone = true;
        break;
      case 'turn/failed': {
        const e = params.error as { message?: string } | undefined;
        turnState.error = new Error(e?.message || 'Turn failed');
        if (turnTracker) turnTracker.currentTurnId = null;
        turnDone = true;
        break;
      }
      case 'thread/status/changed': {
        // Codex's thread/status/changed payload shape varies by app-server
        // version. Some versions emit params.status as a plain string;
        // others emit a structured object (e.g. { state: 'thinking',
        // detail: '...' }). Extract the most useful human-readable label;
        // never let template coercion produce "[object Object]".
        //
        // Drop the trivial "active" / "idle" labels — they fire on every
        // turn-state flip, so the chat-side status message (which the host
        // delivers as edit-in-place) ends up overwriting the 💭 thinking
        // labels emitted from item/reasoning/* with "status: active". The
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
          const candidate =
            obj.label ?? obj.state ?? obj.status ?? obj.kind ?? obj.type ?? obj.message ?? obj.text;
          label = typeof candidate === 'string' ? candidate : JSON.stringify(raw);
        }
        if (label && label !== 'active' && label !== 'idle') {
          buffer.push({ type: 'progress', message: `status: ${label}` });
        }
        break;
      }
      default:
        // Silently handle the many item/* notifications — they already
        // contributed an activity event above.
        break;
    }

    kick();
  };

  server.notificationHandlers.push(handler);

  const timer = setTimeout(() => {
    turnState.error = new Error(`Turn timed out after ${TURN_TIMEOUT_MS}ms`);
    turnDone = true;
    kick();
  }, TURN_TIMEOUT_MS);

  try {
    // If we yield init before turn/start, the poll-loop stores
    // continuation early and survives a mid-turn crash.
    if (!hasInit()) {
      markInit();
      buffer.push({ type: 'init', continuation: threadId });
    }

    await startCodexTurn(server, { threadId, inputText, model, cwd });

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

    if (turnState.error) {
      yield { type: 'error', message: turnState.error.message, retryable: false };
      return;
    }

    yield { type: 'result', text: resultText || null };
  } finally {
    clearTimeout(timer);
    const idx = server.notificationHandlers.indexOf(handler);
    if (idx >= 0) server.notificationHandlers.splice(idx, 1);
  }
}

registerProvider('codex', (opts) => new CodexProvider(opts));
