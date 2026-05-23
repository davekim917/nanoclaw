import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

const SESSION_STATUS_RETRY_ERROR_AFTER = 3;

/** Stale / dead OpenCode session heuristics (complement Claude-centric host patterns). */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|NotFoundError|connection reset|ECONNRESET|404|event timeout/i;

function spawnOpencodeServer(
  config: Record<string, unknown>,
  cwd: string | undefined,
  timeoutMs = 10_000,
): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const hostname = '127.0.0.1';
    // Port 0 = OS-assigned. We already parse the actual port from the
    // "opencode server listening on URL" line, so a fixed port wasn't needed
    // — and hardcoding 4096 would collide if anything ever spawned a second
    // `opencode serve` in the same container (e.g. a future in-container
    // subagent dispatch path). Today only one server per container, but
    // robustness costs nothing.
    const port = 0;
    // Spawn `opencode serve` with cwd=input.cwd so OpenCode's file/shell tools
    // (read, edit, bash) default to the mounted agent workspace at
    // /workspace/agent. Without this, the child inherits the Dockerfile WORKDIR
    // (/workspace/group), which is empty in our layout — Claude provider already
    // passes input.cwd; this brings OpenCode to parity. Caller falls back to
    // process.cwd() if input.cwd was undefined.
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      cwd: cwd ?? process.cwd(),
    });

    const id = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    // Startup-only buffer + listeners. We unregister them on resolve so that
    // post-startup chatter doesn't accumulate in a closure for the entire
    // session lifetime (the OpenCode CLI is occasionally chatty to stdout).
    let output = '';
    let settled = false;
    const onStdout = (chunk: Buffer): void => {
      if (settled) return;
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            settled = true;
            clearTimeout(id);
            proc.stdout?.off('data', onStdout);
            proc.stderr?.off('data', onStderr);
            // Resume but drain to /dev/null so the pipe doesn't fill and block
            // the child. `resume()` after detaching listeners means data is
            // consumed and discarded.
            proc.stdout?.resume();
            proc.stderr?.resume();
            resolve({ url: match[1], proc });
            return;
          }
        }
      }
    };
    const onStderr = (chunk: Buffer): void => {
      if (settled) return;
      output += chunk.toString();
    };
    proc.stdout?.on('data', onStdout);
    proc.stderr?.on('data', onStderr);
    proc.on('exit', (code) => {
      if (settled) return;
      clearTimeout(id);
      let msg = `OpenCode server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });
    proc.on('error', (err) => {
      if (settled) return;
      clearTimeout(id);
      reject(err);
    });
  });
}

function pickGroupInstructions(groupDir: string): string | null {
  // Prefer AGENTS.md (flattened by composeGroupClaudeMd with @-imports resolved
  // inline — the same content Codex consumes). Fall back to CLAUDE.md only
  // when AGENTS.md is absent; that path drops to a stub of literal @-imports
  // that OpenCode would not expand, leaving the agent with no instructions.
  const agents = `${groupDir}/AGENTS.md`;
  const claude = `${groupDir}/CLAUDE.md`;
  if (fs.existsSync(agents)) return agents;
  if (fs.existsSync(claude)) return claude;
  return null;
}

// Memoized at module scope: AGENTS.md is static for the container lifetime
// (composed once at spawn by host-side composeGroupClaudeMd; not regenerated
// mid-session). Previously read on every turn — multi-KB synchronous file
// reads twice per prompt. Now read once, reused for every push().
let cachedAgentInstructions: string | undefined | null = null;

function readAgentInstructionsForPrompt(): string | undefined {
  if (cachedAgentInstructions !== null) return cachedAgentInstructions;
  let content = '';
  const groupSrc = pickGroupInstructions('/workspace/agent');
  if (groupSrc) content += fs.readFileSync(groupSrc, 'utf-8');
  const isMain = process.env.NANOCLAW_IS_MAIN === '1';
  if (!isMain) {
    const globalSrc = pickGroupInstructions('/workspace/global');
    if (globalSrc) {
      if (content) content += '\n\n---\n\n';
      content += fs.readFileSync(globalSrc, 'utf-8');
    }
  }
  cachedAgentInstructions = content || undefined;
  return cachedAgentInstructions;
}

function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  const agentMd = readAgentInstructionsForPrompt();
  if (agentMd) {
    out = `<system>\n${agentMd}\n</system>\n\n${out}`;
  }
  return out;
}

function buildOpenCodeConfig(options: ProviderOptions): Record<string, unknown> {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const model = process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;

  const providerModelId = model ? model.replace(new RegExp(`^${provider}/`), '') : undefined;
  const providerSmallModelId = smallModel ? smallModel.replace(new RegExp(`^${provider}/`), '') : undefined;
  const modelsToRegister = [providerModelId, providerSmallModelId]
    .filter(Boolean)
    .filter((mid, i, a) => a.indexOf(mid as string) === i);

  // For the `opencode` provider specifically, prefer the SDK's native
  // auth.json resolution (XDG_DATA_HOME) when an auth.json exists. The
  // `apiKey: 'placeholder'` override below is for the OneCLI-proxy path used
  // by static API-key providers (deepseek/openrouter/zen-via-paste-key). When
  // OAuth-issued auth.json is mounted, that override would replace the real
  // token with the placeholder and break auth.
  const opencodeAuthAvailable =
    provider === 'opencode' && fs.existsSync('/opencode-xdg/opencode/auth.json');

  // OPENCODE_EFFORT controls upstream reasoning effort. Sent as
  // `reasoning_effort` only — the `thinking.budgetTokens` field is
  // Anthropic-specific and 400s on most non-Anthropic upstreams (Kimi, GLM,
  // DeepSeek). User-supplied values are clamped to the portable intersection
  // accepted by all common upstreams: `low | medium | high`. Out-of-range
  // values like `xhigh` (OpenAI extension) or `max` (DeepSeek extension) are
  // mapped to `high` for portability; native xhigh/max requires per-model
  // overrides that aren't wired here yet.
  //
  // Unset / 'default' = inject nothing. Most thinking-capable models in the
  // OpenCode Go catalog (Kimi, GLM, DeepSeek auto-max, Qwen, MiniMax, MiMo)
  // already do their highest reasoning by default in agent contexts.
  const rawEffort = (process.env.OPENCODE_EFFORT || '').trim().toLowerCase();
  const effortClampMap: Record<string, string> = {
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'high',
    max: 'high',
  };
  const effortValue = effortClampMap[rawEffort] || null;
  const modelOptions = effortValue ? { reasoningEffort: effortValue } : null;

  const modelsBlock =
    modelsToRegister.length > 0
      ? {
          models: Object.fromEntries(
            modelsToRegister.map((mid) => [
              mid,
              {
                id: mid,
                name: mid,
                tool_call: true,
                ...(modelOptions ? { options: modelOptions } : {}),
              },
            ]),
          ),
        }
      : {};

  // SDK options block:
  //   - apiKey: only injected for the OneCLI-proxy path (non-OAuth providers).
  //     When auth.json is mounted, the SDK reads it natively and we MUST NOT
  //     override or it'd send 'placeholder' as the Bearer token.
  //   - baseURL: NOT set. OpenCode's provider registry routes based on the
  //     cred-key in auth.json (`opencode-go` → /zen/go/v1, `opencode` →
  //     /zen/v1, `nvidia` → NVIDIA's endpoint, etc.) — no manual override
  //     needed. Earlier code took an OPENCODE_BASE_URL env var as a hack
  //     to force Go billing; that's now unnecessary and was removed
  //     2026-05-23 alongside the host-side passthrough.
  const sdkOptions: Record<string, unknown> = {};
  if (!opencodeAuthAvailable) sdkOptions.apiKey = 'placeholder';

  const providerOptions: Record<string, unknown> =
    provider === 'anthropic'
      ? {}
      : {
          [provider]: {
            ...(Object.keys(sdkOptions).length > 0 ? { options: sdkOptions } : {}),
            ...modelsBlock,
          },
        };

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: [provider],
    permission: 'allow',
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    mcp,
  };
}

type SharedRuntime = {
  proc: ChildProcess;
  client: OpencodeClient;
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  streamRelease: () => void;
};

let sharedRuntime: SharedRuntime | null = null;
let sharedConfigKey: string | null = null;
let sharedInit: Promise<SharedRuntime> | null = null;

function runtimeConfigKey(options: ProviderOptions, cwd: string | undefined): string {
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    op: process.env.OPENCODE_PROVIDER,
    effort: process.env.OPENCODE_EFFORT,
    cwd: cwd ?? null,
  });
}

async function ensureSharedRuntime(options: ProviderOptions, cwd: string | undefined): Promise<SharedRuntime> {
  const key = runtimeConfigKey(options, cwd);
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  sharedInit = (async () => {
    if (sharedRuntime) {
      destroySharedRuntime();
    }
    const config = buildOpenCodeConfig(options);
    const { url, proc } = await spawnOpencodeServer(config, cwd);
    // Also pass `directory` to the SDK client — opencode uses it as a hint
    // for project-context features (project root, file paths in completions).
    const client = createOpencodeClient({ baseUrl: url, ...(cwd ? { directory: cwd } : {}) });
    const sub = await client.event.subscribe();
    const stream = sub.stream as AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
    sharedRuntime = {
      proc,
      client,
      stream,
      streamRelease: () => {
        void stream.return?.(undefined);
      },
    };
    sharedConfigKey = key;
    sharedInit = null;
    return sharedRuntime;
  })();

  return sharedInit;
}

export function destroySharedRuntime(): void {
  if (sharedRuntime) {
    try {
      sharedRuntime.streamRelease();
    } catch {
      /* ignore */
    }
    try {
      sharedRuntime.proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    sharedRuntime = null;
    sharedConfigKey = null;
  }
  sharedInit = null;
}

function sessionErrorMessage(props: { error?: unknown }): string {
  const err = props.error as { data?: { message?: string } } | undefined;
  if (err && typeof err === 'object' && err.data && typeof err.data.message === 'string') {
    return err.data.message;
  }
  return JSON.stringify(props.error) || 'OpenCode session error';
}

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeSessionId: string | undefined;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (input.continuation) {
      this.activeSessionId = input.continuation;
    } else {
      this.activeSessionId = undefined;
    }

    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    const systemInstructions = input.systemContext?.instructions;
    pending.push(wrapPromptWithContext(input.prompt, systemInstructions));

    const kick = (): void => {
      waiting?.();
    };

    const self = this;
    const queryCwd = input.cwd;
    const IDLE_TIMEOUT_MS = 90_000;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      const rt = await ensureSharedRuntime(self.options, queryCwd);
      const { client, stream } = rt;

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
        let sessionId = self.activeSessionId;

        if (!sessionId) {
          const created = await client.session.create();
          if (created.error) {
            throw new Error(`OpenCode: failed to create session: ${JSON.stringify(created.error)}`);
          }
          sessionId = created.data?.id;
          if (!sessionId) throw new Error('OpenCode: failed to create session (no id)');
          self.activeSessionId = sessionId;
        }

        if (!initYielded) {
          yield { type: 'init', continuation: sessionId };
          initYielded = true;
        }

        const promptRes = await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: 'text', text }] },
        });
        if (promptRes.error) {
          self.activeSessionId = undefined;
          throw new Error(`OpenCode promptAsync: ${JSON.stringify(promptRes.error)}`);
        }

        // Key by part.id (TextPart.id is unique per part, per SDK types).
        // Multiple text parts can share a single messageID — prose before /
        // after tool use are two parts of the same assistant message — and
        // previously keying by messageID overwrote earlier parts.
        const partTextById = new Map<string, { messageID: string; text: string }>();
        const roleByMessageId = new Map<string, string>();
        let lastEventAt = Date.now();
        let eventTimedOut = false;
        const timeoutCheck = setInterval(() => {
          if (Date.now() - lastEventAt > IDLE_TIMEOUT_MS) {
            log(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms) — clearing session ${sessionId}`);
            eventTimedOut = true;
            self.activeSessionId = undefined;
            destroySharedRuntime();
            kick();
          }
        }, 5000);

        try {
          turn: while (true) {
            if (aborted) return;
            if (eventTimedOut) {
              throw new Error(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms)`);
            }

            const { value: ev, done } = await stream.next();
            if (done) {
              throw new Error('OpenCode SSE stream ended unexpectedly');
            }

            // Heartbeats prove the SSE connection is alive but carry no content.
            // Reset the idle timer so a long-thinking subagent (verified
            // empirically: Kimi K2.6 can think silently for 5-7min mid-turn
            // while dispatching parallel subagents) doesn't trip the 90s
            // false-positive timeout. Skip the `activity` yield to avoid
            // flooding the consumer with no-op events.
            if (!ev?.type || ev.type === 'server.connected') continue;
            if (ev.type === 'server.heartbeat') {
              lastEventAt = Date.now();
              continue;
            }

            lastEventAt = Date.now();
            yield { type: 'activity' };

            switch (ev.type) {
              case 'message.updated': {
                const info = ev.properties.info as { id?: string; role?: string } | undefined;
                if (info?.id && info?.role) {
                  roleByMessageId.set(info.id, info.role);
                }
                break;
              }
              case 'message.part.updated': {
                const part = ev.properties.part as
                  | { id?: string; type?: string; messageID?: string; text?: string }
                  | undefined;
                if (part?.type === 'text' && part.id && part.messageID && part.text) {
                  partTextById.set(part.id, { messageID: part.messageID, text: part.text });
                }
                break;
              }
              case 'permission.updated': {
                const perm = ev.properties as { id?: string; sessionID?: string };
                if (perm.sessionID === sessionId && perm.id) {
                  try {
                    await client.postSessionIdPermissionsPermissionId({
                      path: { id: sessionId, permissionID: perm.id },
                      body: { response: 'always' },
                    });
                  } catch (err) {
                    log(`Failed to auto-reply permission: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                break;
              }
              case 'session.status': {
                const props = ev.properties as {
                  sessionID?: string;
                  status?: { type?: string; attempt?: number; message?: string };
                };
                if (props.sessionID !== sessionId) break;
                const st = props.status;
                if (
                  st?.type === 'retry' &&
                  typeof st.attempt === 'number' &&
                  st.attempt >= SESSION_STATUS_RETRY_ERROR_AFTER &&
                  st.message
                ) {
                  self.activeSessionId = undefined;
                  throw new Error(`OpenCode retry limit (${st.attempt}): ${st.message}`);
                }
                break;
              }
              case 'session.error': {
                const props = ev.properties as { sessionID?: string; error?: unknown };
                if (props.sessionID === sessionId || props.sessionID === undefined) {
                  self.activeSessionId = undefined;
                  throw new Error(sessionErrorMessage(props));
                }
                break;
              }
              case 'session.idle': {
                const sid = (ev.properties as { sessionID?: string }).sessionID;
                if (sid === sessionId) {
                  break turn;
                }
                break;
              }
              default:
                break;
            }
          }
        } finally {
          clearInterval(timeoutCheck);
        }

        // Collect all text parts for the LAST assistant message in arrival order
        // and concatenate. Single-message responses with tool use emit multiple
        // text parts (prose before tool call, prose after tool call) that share
        // the same messageID; we want the full assistant response, not just the
        // last part. Map iteration preserves insertion order, so iterating
        // partTextById.values() gives parts in the order OpenCode emitted them.
        let lastAssistantMessageId: string | undefined;
        for (const [msgId, role] of roleByMessageId) {
          if (role === 'assistant') lastAssistantMessageId = msgId;
        }
        let resultText = '';
        if (lastAssistantMessageId) {
          const texts: string[] = [];
          for (const { messageID, text } of partTextById.values()) {
            if (messageID === lastAssistantMessageId) texts.push(text);
          }
          resultText = texts.join('');
        }
        yield { type: 'result', text: resultText || null };
      }
    }

    return {
      push: (message: string) => {
        pending.push(wrapPromptWithContext(message, systemInstructions));
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        this.activeSessionId = undefined;
        kick();
        destroySharedRuntime();
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
