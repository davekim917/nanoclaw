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
import crypto from 'crypto';
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

/**
 * Idle watchdog for a single turn. Guards against codex-app-server wedging.
 *
 * Previously this was a wall-clock timer from turn start (`TURN_TIMEOUT_MS
 * = 300_000`). That cut off every legitimate long turn — `xhigh` reasoning
 * with multi-step tool work routinely runs past 5 min while emitting
 * reasoning deltas every 1–10s. Wall-clock can't tell "thinking hard" from
 * "wedged"; idle-from-last-notification can.
 *
 * The handler at runOneTurn resets the timer on every JSON-RPC
 * notification (including `thread/status/changed` and `item/reasoning/*`
 * deltas, which fire continuously during real work). 120s of total silence
 * with no events arriving = the app-server is wedged at the JSON-RPC
 * layer. Caught faster than the old 5-min wall-clock for real wedges; the
 * old false-positives on long reasoning chains go away.
 *
 * Long-tool suppression: long-running tool calls (e.g. multi-minute Bash
 * tests, `hex project run --timeout 30m`) emit one `item/started` then
 * run silently until `item/completed`. The handler tracks an
 * `inFlightItems` counter from those events and suppresses the watchdog
 * while > 0 — long silence during a known-active tool is not a wedge.
 * Backstop for a tool that truly hangs forever: host-sweep's 30-min
 * ABSOLUTE_CEILING_MS (host-sweep.ts:163, same place that extends its
 * own ceiling for declared Bash timeouts).
 */
const TURN_IDLE_TIMEOUT_MS = 120 * 1000;

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
    // Codex only supports stdio MCP servers. Native stdio entries pass through;
    // hosted HTTP MCPs are exposed through the local stdio bridge. SSE entries
    // stay filtered because remote-mcp-bridge speaks Streamable HTTP, not SSE.
    const stdioOnly: Record<string, CodexMcpServer> = {};
    for (const [name, cfg] of Object.entries(options.mcpServers ?? {})) {
      if (cfg && (cfg.type === undefined || cfg.type === 'stdio') && 'command' in cfg) {
        stdioOnly[name] = { command: cfg.command, args: cfg.args, env: cfg.env };
      } else if (cfg?.type === 'http') {
        const env: Record<string, string> = { REMOTE_MCP_NAME: name };
        const authorization = cfg.headers?.Authorization ?? cfg.headers?.authorization;
        if (authorization) env.REMOTE_MCP_AUTHORIZATION = authorization;
        stdioOnly[name] = {
          command: 'bun',
          args: ['/app/src/remote-mcp-bridge.ts', cfg.url],
          env,
        };
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
          //
          // We inspect each event while re-yielding it: on a `retryable:false`
          // error (e.g. TURN_TIMEOUT_MS) the codex app-server is wedged
          // server-side — there's no turn-cancel RPC, only turn/start and
          // turn/steer, so the next startCodexTurn would either block or
          // immediately re-time-out. Return from gen() so the outer finally
          // (line ~373) calls killCodexAppServer and the next poll-loop
          // iteration spawns a fresh app-server within seconds. Without
          // this, every subsequent turn dies the same way until host-sweep
          // reaps the whole container at its 30-min ABSOLUTE_CEILING_MS.
          for await (const ev of runOneTurn(
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
          )) {
            yield ev;
            if (ev.type === 'error' && ev.retryable === false) {
              return;
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
  // Codex can deliver reasoning two ways: streaming item/reasoning/* deltas
  // when enabled by the app-server, or finalized reasoning ThreadItems via
  // item/completed. Streamed item IDs are tracked so lifecycle fallback
  // payloads do not duplicate already-forwarded summaries.
  let reasoningBuffer = '';
  const reasoningItemsWithDeltas = new Set<string>();
  const emittedReasoningItemIds = new Set<string>();
  const emittedImageKeys = new Set<string>();

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

  // Idle watchdog: armed below, reset on every notification when no
  // tool item is in flight. See TURN_IDLE_TIMEOUT_MS comment block for
  // design notes.
  //
  // Tool-aware suppression: codex emits item/started for every tool /
  // reasoning / agent-message item and pairs it with item/completed. A
  // long-running Bash call (think `go test ./...` or `hex project run
  // --timeout 30m`) emits start, then runs silently for minutes, then
  // emits complete. While the inflight count is > 0, long notification
  // silence is expected — suppress the watchdog. Mirrors host-sweep's
  // declared-Bash extension at host-sweep.ts:163. If a tool call truly
  // hangs forever, host-sweep's 30-min ABSOLUTE_CEILING_MS is the
  // backstop.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlightItems = 0;

  const resetIdleTimer = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (inFlightItems > 0) return;
    idleTimer = setTimeout(() => {
      turnState.error = new Error(`Codex turn idle for ${TURN_IDLE_TIMEOUT_MS}ms (no notifications)`);
      turnDone = true;
      kick();
    }, TURN_IDLE_TIMEOUT_MS);
  };

  const handler = (n: JsonRpcNotification): void => {
    const method = n.method;
    const params = n.params;

    // Adjust the tool-in-flight count BEFORE resetting the idle timer,
    // so the reset logic sees the new count and skips re-arming while a
    // tool is running. Codex pairs item/started ↔ item/completed for
    // every item type (tool calls, reasoning, agentMessage). On
    // turn/completed and turn/failed we also clear the count — covers
    // the rare case of an orphan start with no matching completion.
    if (method === 'item/started') {
      inFlightItems++;
    } else if (method === 'item/completed') {
      inFlightItems = Math.max(0, inFlightItems - 1);
    } else if (method === 'turn/completed' || method === 'turn/failed') {
      inFlightItems = 0;
    }

    // Reset the idle watchdog on every notification — even ones we don't
    // translate to a ProviderEvent. The app-server emitting ANYTHING
    // means it's alive; only total silence is a wedge signal.
    resetIdleTimer();

    // Every inbound notification counts as activity for the poll-loop's
    // idle timer — yield before any event-specific translation so even
    // long tool executions keep the loop awake.
    buffer.push({ type: 'activity' });

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
        const item = params.item as ({ type?: string; text?: string } & ReasoningThreadItem & ImageGenerationThreadItem) | undefined;
        if (item?.type === 'agentMessage' && item.text) resultText = item.text;
        if (item?.type === 'reasoning') emitCompletedReasoningItem(item);
        const generatedImagePath = extractImageGenerationPath(item);
        if (generatedImagePath) {
          emitGeneratedFile(generatedImagePath, imageGenerationKey(item, `path:${generatedImagePath}`));
        }
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

  // Arm the idle watchdog before turn/start dispatches — there's a small
  // window where startCodexTurn could hang at the JSON-RPC layer with no
  // notifications ever arriving. The timer will be reset by the first
  // real notification (typically thread/started or turn/started).
  resetIdleTimer();

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
    if (idleTimer !== null) clearTimeout(idleTimer);
    const idx = server.notificationHandlers.indexOf(handler);
    if (idx >= 0) server.notificationHandlers.splice(idx, 1);
  }
}

registerProvider('codex', (opts) => new CodexProvider(opts));
