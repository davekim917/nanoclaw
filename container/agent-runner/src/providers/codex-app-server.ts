/**
 * Codex app-server JSON-RPC transport primitives.
 *
 * Communicates with `codex app-server` over stdio. This module is just the
 * plumbing — spawn the process, send requests, dispatch responses and
 * notifications. Higher-level semantics (threads, turns, event translation)
 * live in codex.ts.
 *
 * Kept separate so the transport can be unit-tested without pulling in the
 * full provider and so any future Codex tooling (e.g. a CLI for manual
 * debugging) can reuse the same primitives.
 */
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

function log(msg: string): void {
  console.error(`[codex-app-server] ${msg}`);
}

const INIT_TIMEOUT_MS = 30_000;

const CODEX_INITIALIZE_CAPABILITIES = {
  // Required for thread/list.ancestorThreadId, which lets the liveness probe
  // see work delegated below a quiet root thread.
  experimentalApi: true,
  // `optOutNotificationMethods` is a suppression list, not an allow-list.
  // Keep it empty so high-volume streams such as item/agentMessage/delta and
  // item/reasoning/* remain eligible for delivery on this connection.
  optOutNotificationMethods: [],
};

/**
 * Errors from `thread/resume` that indicate the thread ID is unusable —
 * typically because the app-server has no memory of it (thread transcript
 * was deleted, server was wiped, ID is from a different codex version).
 * Only errors matching this pattern trigger silent fallback to a fresh
 * thread; everything else bubbles up so the caller can decide what to do.
 *
 * Shared with `codex.ts`'s `isSessionInvalid` to keep the two detection
 * paths in sync.
 */
export const STALE_THREAD_RE = /thread\s+not\s+found|unknown\s+thread|thread[_\s]id|no such thread/i;

/**
 * Escape a string for emission inside a TOML basic string (double-quoted).
 * Handles `"` and `\`. Rejects newlines: basic strings can't contain raw
 * newlines, and silently converting them to `\n` would mask misconfiguration
 * (e.g. a secret pasted with a trailing newline). Multiline strings are
 * unsupported for `config.toml` use here.
 */
export function tomlBasicString(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(
      `MCP config value contains newline (not supported in config.toml): ${JSON.stringify(value.slice(0, 40))}${value.length > 40 ? '…' : ''}`,
    );
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlInlineStringMap(map: Record<string, string>): string {
  return `{ ${Object.entries(map)
    .map(([key, value]) => `${tomlBasicString(key)} = ${tomlBasicString(value)}`)
    .join(', ')} }`;
}

// ── JSON-RPC types ──────────────────────────────────────────────────────────

let nextRequestId = 1;

interface JsonRpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcServerRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

function makeRequest(method: string, params: Record<string, unknown>): JsonRpcRequest {
  return { id: nextRequestId++, method, params };
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg);
}

function isServerRequest(msg: JsonRpcMessage): msg is JsonRpcServerRequest {
  return 'id' in msg && 'method' in msg;
}

// ── App-server handle ───────────────────────────────────────────────────────

export interface AppServer {
  process: ChildProcess;
  readline: ReadlineInterface;
  pending: Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>;
  notificationHandlers: ((n: JsonRpcNotification) => void)[];
  serverRequestHandlers: ((r: JsonRpcServerRequest) => void)[];
}

export function spawnCodexAppServer(configOverrides: string[] = []): AppServer {
  const args = ['app-server', '--listen', 'stdio://'];
  for (const override of configOverrides) args.push('-c', override);

  log(`Spawning: codex ${args.join(' ')}`);
  const proc = spawn('codex', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const rl = createInterface({ input: proc.stdout! });

  const server: AppServer = {
    process: proc,
    readline: rl,
    pending: new Map(),
    notificationHandlers: [],
    serverRequestHandlers: [],
  };

  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log(`[stderr] ${text}`);
  });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`[parse-error] ${line.slice(0, 200)}`);
      return;
    }

    if (isResponse(msg)) {
      const handler = server.pending.get(msg.id);
      if (handler) {
        server.pending.delete(msg.id);
        handler.resolve(msg);
      }
    } else if (isServerRequest(msg)) {
      for (const h of server.serverRequestHandlers) h(msg);
    } else if ('method' in msg) {
      for (const h of server.notificationHandlers) h(msg as JsonRpcNotification);
    }
  });

  proc.on('error', (err) => {
    log(`[process-error] ${err.message}`);
    for (const [, handler] of server.pending) handler.reject(err);
    server.pending.clear();
  });

  proc.on('exit', (code, signal) => {
    log(`[exit] code=${code} signal=${signal}`);
    const err = new Error(`Codex app-server exited: code=${code} signal=${signal}`);
    for (const [, handler] of server.pending) handler.reject(err);
    server.pending.clear();
  });

  return server;
}

export function sendCodexRequest(
  server: AppServer,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<JsonRpcResponse> {
  const req = makeRequest(method, params);
  const line = JSON.stringify(req) + '\n';

  return new Promise<JsonRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.pending.delete(req.id);
      reject(new Error(`Timeout waiting for ${method} response (${timeoutMs}ms)`));
    }, timeoutMs);

    server.pending.set(req.id, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });

    try {
      server.process.stdin!.write(line);
    } catch (err) {
      clearTimeout(timer);
      server.pending.delete(req.id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function sendCodexResponse(server: AppServer, id: number, result: unknown): void {
  const line = JSON.stringify({ id, result }) + '\n';
  try {
    server.process.stdin!.write(line);
  } catch (err) {
    log(`[send-error] Failed to send response for id=${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function killCodexAppServer(server: AppServer): void {
  try {
    server.readline.close();
    server.process.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

// ── Auto-approval ───────────────────────────────────────────────────────────
// The container sandbox is already the security boundary; inside it, Codex's
// own approval prompts would just block every tool call on a user that isn't
// watching. Accept everything and let sandbox limits do the enforcement.

export function attachCodexAutoApproval(server: AppServer): void {
  server.serverRequestHandlers.push((req) => {
    const method = req.method;
    log(`[approval] ${method}`);

    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        sendCodexResponse(server, req.id, { decision: 'accept' });
        break;
      case 'item/permissions/requestApproval':
        sendCodexResponse(server, req.id, {
          permissions: { fileSystem: { read: ['/'], write: ['/'] }, network: { enabled: true } },
          scope: 'session',
        });
        break;
      case 'applyPatchApproval':
      case 'execCommandApproval':
        sendCodexResponse(server, req.id, { decision: 'approved' });
        break;
      case 'item/tool/call': {
        const toolName = (req.params as { tool?: string }).tool || 'unknown';
        log(`[approval] Unexpected dynamic tool call: ${toolName}`);
        sendCodexResponse(server, req.id, {
          success: false,
          contentItems: [{ type: 'inputText', text: `Tool "${toolName}" is not available. Use MCP tools instead.` }],
        });
        break;
      }
      case 'item/tool/requestUserInput':
      case 'mcpServer/elicitation/request':
        sendCodexResponse(server, req.id, { input: null });
        break;
      default:
        log(`[approval] Unknown method ${method}, generic accept`);
        sendCodexResponse(server, req.id, { decision: 'accept' });
        break;
    }
  });
}

// ── High-level helpers ──────────────────────────────────────────────────────

export async function initializeCodexAppServer(server: AppServer): Promise<void> {
  log('Sending initialize…');
  const resp = await sendCodexRequest(
    server,
    'initialize',
    {
      clientInfo: { name: 'nanoclaw', version: '1.0.0' },
      capabilities: CODEX_INITIALIZE_CAPABILITIES,
    },
    INIT_TIMEOUT_MS,
  );
  if (resp.error) throw new Error(`Initialize failed: ${resp.error.message}`);
  log('Initialize successful');
}

export interface ThreadParams {
  model: string;
  cwd: string;
  sandbox?: string;
  approvalPolicy?: string;
  personality?: string;
  baseInstructions?: string;
}

/**
 * Start or resume a Codex thread. If `threadId` is provided, attempts
 * `thread/resume` first and falls back to a fresh `thread/start` on failure
 * (stale thread IDs commonly outlive containers). Returns the active thread
 * ID either way.
 */
export async function startOrResumeCodexThread(
  server: AppServer,
  threadId: string | undefined,
  params: ThreadParams,
): Promise<string> {
  if (threadId) {
    log(`Resuming thread: ${threadId}`);
    const resp = await sendCodexRequest(server, 'thread/resume', {
      threadId,
      ...(params as unknown as Record<string, unknown>),
    });
    if (!resp.error) {
      log(`Thread resumed: ${threadId}`);
      return threadId;
    }
    // Only fall through to fresh-thread on recognized stale-thread errors.
    // Auth, version, or transient failures would otherwise silently discard
    // session state — fail loud instead so the caller can retry or surface.
    if (!STALE_THREAD_RE.test(resp.error.message)) {
      throw new Error(`thread/resume failed: ${resp.error.message}`);
    }
    log(`Stale thread ${threadId}; starting fresh thread.`);
  }

  log('Starting new thread…');
  const resp = await sendCodexRequest(server, 'thread/start', {
    ...(params as unknown as Record<string, unknown>),
  });
  if (resp.error) throw new Error(`thread/start failed: ${resp.error.message}`);

  const result = resp.result as { thread?: { id?: string } } | undefined;
  const newThreadId = result?.thread?.id;
  if (!newThreadId) throw new Error('thread/start response missing thread ID');
  log(`New thread: ${newThreadId}`);
  return newThreadId;
}

export interface TurnParams {
  threadId: string;
  inputText: string;
  model?: string;
  cwd?: string;
}

export async function startCodexTurn(server: AppServer, params: TurnParams): Promise<void> {
  const resp = await sendCodexRequest(server, 'turn/start', {
    threadId: params.threadId,
    input: [{ type: 'text', text: params.inputText }],
    model: params.model,
    cwd: params.cwd,
  });
  if (resp.error) throw new Error(`turn/start failed: ${resp.error.message}`);
}

export interface CodexThreadHealthProbe {
  rootStatus: unknown;
  descendantStatuses: unknown[];
}

/**
 * Non-mutating control-plane probe for a running turn. A successful response
 * proves the app-server JSON-RPC loop is responsive even when the model or a
 * tool has emitted no notifications. Descendants are included because an
 * Ultra root may be idle-looking while delegated agents remain active.
 */
export async function probeCodexThreadHealth(
  server: AppServer,
  threadId: string,
  timeoutMs: number,
): Promise<CodexThreadHealthProbe> {
  const rootResponse = await sendCodexRequest(server, 'thread/read', { threadId, includeTurns: false }, timeoutMs);
  if (rootResponse.error) throw new Error(`thread/read health probe failed: ${rootResponse.error.message}`);

  const rootResult = rootResponse.result as { thread?: { status?: unknown } } | undefined;
  if (!rootResult?.thread) throw new Error('thread/read health probe response missing thread');

  const descendantsResponse = await sendCodexRequest(
    server,
    'thread/list',
    { ancestorThreadId: threadId, limit: 100 },
    timeoutMs,
  );
  if (descendantsResponse.error) {
    throw new Error(`thread/list descendant health probe failed: ${descendantsResponse.error.message}`);
  }
  const descendantsResult = descendantsResponse.result as
    | { data?: Array<{ status?: unknown }>; threads?: Array<{ status?: unknown }> }
    | undefined;
  const descendants = descendantsResult?.data ?? descendantsResult?.threads ?? [];

  return {
    rootStatus: rootResult.thread.status,
    descendantStatuses: descendants.map((thread) => thread.status),
  };
}

/** Best-effort graceful cancellation before replacing a responsive server. */
export async function interruptCodexTurn(
  server: AppServer,
  params: { threadId: string; turnId: string },
  timeoutMs = 5_000,
): Promise<void> {
  const response = await sendCodexRequest(server, 'turn/interrupt', params, timeoutMs);
  if (response.error) throw new Error(`turn/interrupt failed: ${response.error.message}`);
}

/**
 * Append text input to a turn that is currently in flight. Codex's app-server
 * routes the new input to the running turn (rather than queuing it for the
 * next turn), so the agent's response can reference late-arriving content
 * without ending the turn first.
 *
 * `expectedTurnId` is a precondition the server checks — if it doesn't match
 * the active turn, the request fails. The caller has to pass the turnId
 * observed from a prior `turn/started` notification.
 *
 * Throws on RPC error so the caller can fall back to queuing the message
 * for the next turn (e.g. if the active turn has just ended).
 */
export async function steerCodexTurn(
  server: AppServer,
  params: { threadId: string; expectedTurnId: string; inputText: string },
): Promise<{ turnId: string }> {
  const resp = await sendCodexRequest(server, 'turn/steer', {
    threadId: params.threadId,
    expectedTurnId: params.expectedTurnId,
    input: [{ type: 'text', text: params.inputText }],
  });
  if (resp.error) throw new Error(`turn/steer failed: ${resp.error.message}`);
  const turnId = (resp.result as { turnId?: string } | undefined)?.turnId;
  if (!turnId) throw new Error('turn/steer returned no turnId');
  return { turnId };
}

// ── MCP config.toml ─────────────────────────────────────────────────────────
// Codex discovers MCP servers by reading ~/.codex/config.toml at startup.
// We rewrite it on every spawn from whatever mcpServers the agent-runner
// passes in, so the container's config reflects the current host wiring.

export type CodexMcpServer = CodexStdioMcpServer | CodexHttpMcpServer;

export interface CodexStdioMcpServer {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CodexHttpMcpServer {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

function stripExistingMcpServers(toml: string): string {
  const out: string[] = [];
  let inMcpBlock = false;
  for (const line of toml.split('\n')) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      inMcpBlock = header[1].trim().startsWith('mcp_servers.');
      if (inMcpBlock) continue;
    }
    if (!inMcpBlock) out.push(line);
  }
  return out.join('\n').trimEnd();
}

export function writeCodexMcpConfigToml(servers: Record<string, CodexMcpServer>): void {
  // Honor CODEX_HOME so a rotated home (OAuth fallback) gets its own regenerated
  // config — otherwise the rotated app-server reads stale config from the wrong
  // dir. CODEX_HOME == $HOME/.codex on initial spawn, so this is a no-op there. (codex #126)
  const codexConfigDir = process.env.CODEX_HOME || path.join(process.env.HOME || '/home/node', '.codex');
  fs.mkdirSync(codexConfigDir, { recursive: true });
  const configTomlPath = path.join(codexConfigDir, 'config.toml');

  let base = '';
  try {
    base = stripExistingMcpServers(fs.readFileSync(configTomlPath, 'utf-8'));
  } catch {
    base = '';
  }

  const lines: string[] = base ? [base, '', '# --- nanoclaw runtime MCP servers ---', ''] : [];
  for (const [name, config] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);
    if (config.type === 'http') {
      lines.push(`url = ${tomlBasicString(config.url)}`);
      if (config.headers && Object.keys(config.headers).length > 0) {
        lines.push(`http_headers = ${tomlInlineStringMap(config.headers)}`);
      }
    } else {
      lines.push('type = "stdio"');
      lines.push(`command = ${tomlBasicString(config.command)}`);
      if (config.args && config.args.length > 0) {
        const argsStr = config.args.map(tomlBasicString).join(', ');
        lines.push(`args = [${argsStr}]`);
      }
      if (config.env && Object.keys(config.env).length > 0) {
        lines.push(`[mcp_servers.${name}.env]`);
        for (const [key, value] of Object.entries(config.env)) {
          lines.push(`${key} = ${tomlBasicString(value)}`);
        }
      }
    }
    lines.push('');
  }

  fs.writeFileSync(configTomlPath, lines.join('\n'));
  log(`Wrote MCP config.toml (${Object.keys(servers).length} server(s))`);
}

// ── hooks.json (NanoClaw guardrails + Graphify source capture) ─────────────
// Codex app-server reads ~/.codex/hooks.json at session start and fires
// shell-command hooks on PreToolUse / PostToolUse / etc. We point each
// event at `bun /app/src/codex-hooks/cli.ts <event>` which dispatches to
// the same hook decisions the Claude provider uses as SDK callbacks
// (see ../codex-hooks/runner.ts).

/**
 * Build the hooks.json content (in-memory). Split out from the filesystem
 * write so tests can assert on the structure without depending on `fs`
 * mocks set by sibling test files.
 */
export function buildCodexHooksJson(opts?: { emailGateTimeoutSec?: number }): {
  hooks: {
    PreToolUse: { hooks: { type: 'command'; command: string; timeout: number }[] }[];
    PostToolUse: { hooks: { type: 'command'; command: string; timeout: number }[] }[];
  };
} {
  const cliPath = '/app/src/codex-hooks/cli.ts';
  const preTimeoutSec = opts?.emailGateTimeoutSec ?? 3600;
  return {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            {
              type: 'command' as const,
              command: `bun ${cliPath} PreToolUse`,
              timeout: preTimeoutSec,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            {
              type: 'command' as const,
              command: `bun ${cliPath} PostToolUse`,
              timeout: 30,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Generate `~/.codex/hooks.json` for the current container. Mirrors the
 * Claude SDK hooks block in `claude.ts` for PreToolUse / PostToolUse
 * coverage. Email-gate is on the PreToolUse chain — its 60-minute admin
 * approval wait requires a long timeout (`emailGateTimeoutSec`), so this
 * event gets the longest timeout in the file.
 */
export function writeCodexHooksJson(opts?: { emailGateTimeoutSec?: number }): void {
  // Honor CODEX_HOME (see writeCodexMcpConfigToml): hooks.json is the destructive-
  // guard wiring, so a rotated fallback home MUST get the regenerated hooks or the
  // guard silently stops firing after an OAuth rotation. (codex #126)
  const codexConfigDir = process.env.CODEX_HOME || path.join(process.env.HOME || '/home/node', '.codex');
  fs.mkdirSync(codexConfigDir, { recursive: true });
  const hooksJsonPath = path.join(codexConfigDir, 'hooks.json');
  const hooks = buildCodexHooksJson(opts);
  fs.writeFileSync(hooksJsonPath, JSON.stringify(hooks, null, 2));
  log(`Wrote hooks.json (PreToolUse timeout=${hooks.hooks.PreToolUse[0].hooks[0].timeout}s)`);
}

/**
 * Build the `-c key=value` overrides passed to `codex app-server`. The
 * `stickyConfig` argument is the validated per-agent provider config slice
 * (see `codexConfigSchema` in `./codex.ts`). When set, `reasoning_effort`
 * propagates as `model_reasoning_effort=<value>` — Codex's native config key.
 *
 * The `model` field is NOT applied here because thread/start carries it as a
 * first-class JSON-RPC parameter; emitting it via `-c model=...` would
 * shadow but not improve precedence.
 */
export function createCodexConfigOverrides(
  stickyConfig?: {
    reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    max_concurrent_threads_per_session?: number;
  },
  fast = false,
): string[] {
  // `features.goals=true` enables Codex's goals feature for every container
  // agent — same always-on pattern as `features.use_linux_sandbox_bwrap`.
  //
  // `features.steer=true` enables the `turn/steer` RPC path so mid-stream
  // follow-up messages inject into the active turn instead of being queued
  // for the next one. Without it, our codex provider's `push()` calls
  // `steerCodexTurn` (an RPC the app-server then rejects), the catch path
  // re-queues the message via `pending.push`, and the operator's
  // mid-stream "steer left" effectively waits for the current turn to
  // finish — observed during Bo-codex's 5.5-min response to a mid-turn
  // @-mention from Dave (session sess-1779235256589, May 2026). The Codex
  // CLI defaults this off; Dave's local Codex CLI sets it in
  // `[features] steer = true`. Containerized installs need the same toggle.
  //
  // Using the `-c` CLI override (rather than persisting in config.toml)
  // because writeCodexMcpConfigToml regenerates the config file per-spawn
  // and CLI overrides take precedence either way; keeping the toggle here
  // means it survives a config.toml rewrite and doesn't need a [features]
  // block injected into the writer.
  const overrides = [
    'features.use_linux_sandbox_bwrap=false',
    'features.goals=true',
    'features.steer=true',
    'features.fast_mode=true',
    // Bound native collaboration at the app-server boundary. Each Codex
    // subagent owns a full MCP subprocess tree, so an inherited host setting
    // that permits an unbounded/high worker count can exhaust the container's
    // PID cgroup and surface as a misleading protocol-desync error.
    'features.multi_agent_v2=true',
    `features.multi_agent_v2.max_concurrent_threads_per_session=${
      stickyConfig?.max_concurrent_threads_per_session ?? DEFAULT_CODEX_MAX_CONCURRENT_THREADS_PER_SESSION
    }`,
    // Memories: writing AND reading. `[memories]` is Codex CLI's own
    // session-summary store (separate from NanoClaw's Graphify retrieval, which is
    // host-side). `generate_memories=true` writes summaries on turn boundaries;
    // `use_memories=true` makes the next-turn prompt include them. Operator
    // parity with Dave's local Codex CLI config — both default false upstream.
    'memories.generate_memories=true',
    'memories.use_memories=true',
  ];
  if (stickyConfig?.reasoning_effort) {
    overrides.push(`model_reasoning_effort="${stickyConfig.reasoning_effort}"`);
  }
  if (fast) {
    overrides.push('service_tier="fast"');
  }
  // Force reasoning-summary notifications on. Without this, gpt-5.x runs in
  // xhigh effort still produce zero `item/reasoning/summaryTextDelta` events
  // — verified empirically via per-method debug logging. "detailed" gives
  // the richest stream; "auto" was insufficient even with high effort.
  // Container chat-UX surfaces these as 💭 thinking labels (see codex.ts
  // runOneTurn's item/reasoning/* cases).
  overrides.push('model_reasoning_summary="detailed"');
  return overrides;
}

// The coordinator consumes one slot, leaving six worker slots by default.
// Six is the minimum required by the deep-security workflow while remaining
// comfortably inside the install-wide 1024 PID ceiling for the MCP-heavy
// production groups observed during the July 2026 incident. Operators can
// override this per group through providerConfig when a workload warrants it.
export const DEFAULT_CODEX_MAX_CONCURRENT_THREADS_PER_SESSION = 7;
