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

import { writeCodexConfigToml } from './codex-config-file.js';
import {
  CODEX_RATE_LIMITS_READ_METHOD,
  type CodexRateLimitsReadResponse,
  parseCodexRateLimitsReadResponse,
} from './codex-rate-limits.js';

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
 * Handles `"`, `\` and the C0/DEL control range. Rejects newlines: basic
 * strings can't contain raw newlines, and silently converting them to `\n`
 * would mask misconfiguration (e.g. a secret pasted with a trailing newline).
 * Multiline strings are unsupported for `config.toml` use here.
 *
 * Every other control character IS escaped rather than rejected: TOML forbids
 * raw C0 controls and DEL inside basic strings, so one stray invisible byte in
 * an MCP env value or header made codex reject the whole config file — which
 * drops EVERY MCP server for that group, not just the offending one.
 * (upstream 05860324c)
 */
export function tomlBasicString(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(
      `MCP config value contains newline (not supported in config.toml): ${JSON.stringify(value.slice(0, 40))}${value.length > 40 ? '…' : ''}`,
    );
  }
  return `"${escapeTomlBasicStringBody(value)}"`;
}

/**
 * The escaping half of {@link tomlBasicString}, without its newline refusal —
 * the one place this repo escapes a TOML basic string, so a second caller
 * cannot ship a partial ruleset of its own.
 *
 * `tomlBasicString` REFUSES a newline because one inside an MCP env value or
 * header is misconfiguration worth surfacing (a secret pasted with a trailing
 * newline). A TOML KEY is different: it is derived from a path this process was
 * handed rather than authored, so refusing would turn one oddly-named plugin
 * file into a spawn that never happens. Keys escape everything and always
 * produce a parsable table header.
 *
 * Escaping the whole C0/DEL range is the load-bearing part either way, and the
 * reason is the tolerant reader on the other side: codex answers one raw
 * control byte anywhere in config.toml with "Invalid configuration; using
 * defaults" and then starts anyway, so a stray byte fails neither the write nor
 * the launch — it silently drops EVERY table in the file. (upstream 05860324c
 * for the MCP half; `docs/review-notes/822.md` registers the class.)
 */
export function escapeTomlBasicStringBody(value: string): string {
  // The control-char replace must stay LAST: an earlier pass would double the
  // backslash it emits into a literal `\\uXXXX`.
  return (
    value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
  );
}

/**
 * Emit a TOML key, quoting anything that is not a bare key.
 *
 * MCP server names and env keys are operator- (and, through the
 * `add_mcp_server` approval flow, agent-) supplied, and nothing on the host
 * validates their charset — `validateMcpServers` only rejects the deprecated
 * SSE transport. `[A-Za-z0-9_-]+` is exactly TOML's bare-key grammar, so an
 * ordinary name stays byte-identical and anything else is quoted. A name with
 * a dot would otherwise nest itself under a sibling table, and a name with a
 * `]` or a quote could close the header and open its own `[mcp_servers.*]`
 * table carrying a command the approval card never showed. Bare and quoted
 * forms name the same table. (upstream 2e97ab046)
 */
export function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlBasicString(name);
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
  /** Absent when the method takes no params — see `makeRequest`. */
  params?: Record<string, unknown>;
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

/**
 * `params` omitted (not `null`, not `{}`) when the caller passes none: the key
 * is left off the object so `JSON.stringify` writes no `"params"` at all. A
 * method whose params the server deserializes as unit accepts that shape on
 * every codex version we run (see `readCodexAccountRateLimits`).
 */
function makeRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  const id = nextRequestId++;
  return params === undefined ? { id, method } : { id, method, params };
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
  params: Record<string, unknown> | undefined,
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

export async function startCodexTurn(server: AppServer, params: TurnParams): Promise<string | null> {
  const resp = await sendCodexRequest(server, 'turn/start', {
    threadId: params.threadId,
    input: [{ type: 'text', text: params.inputText }],
    model: params.model,
    cwd: params.cwd,
  });
  if (resp.error) throw new Error(`turn/start failed: ${resp.error.message}`);
  const result = resp.result as { turn?: { id?: unknown } } | undefined;
  return typeof result?.turn?.id === 'string' ? result.turn.id : null;
}

export interface CodexThreadHealthProbe {
  rootStatus: unknown;
  descendantStatuses: unknown[];
}

export async function readCodexTurnSnapshot(
  server: AppServer,
  threadId: string,
  turnId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const response = await sendCodexRequest(server, 'thread/read', { threadId, includeTurns: true }, timeoutMs);
  if (response.error) throw new Error(`thread/read turn backfill failed: ${response.error.message}`);

  const result = response.result as { thread?: { turns?: unknown } } | undefined;
  const turns = result?.thread?.turns;
  if (!Array.isArray(turns)) throw new Error('thread/read turn backfill response missing turns');

  const turn = turns.find(
    (candidate): candidate is Record<string, unknown> =>
      !!candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).id === turnId,
  );
  if (!turn) throw new Error(`thread/read turn backfill response missing turn ${turnId}`);
  return turn;
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

/** One subagent thread, as the status subtext needs it. */
export interface CodexSubagentThread {
  id: string;
  model: string | null;
  effort: string | null;
}

/**
 * List the child threads a turn's subagents ran in, with the model and effort
 * each was configured with.
 *
 * Codex models a subagent as its own THREAD — `SubAgentActivityItem` carries
 * only `{id, kind, agent_thread_id, agent_path}`, and the model/effort live on
 * the thread record it points at. `thread/list` with `ancestorThreadId` is the
 * same non-mutating call the liveness probe already makes; this one keeps the
 * fields that probe discards.
 *
 * HONEST LABEL: `model` and `reasoning_effort` are the thread's CONFIGURED
 * values. Codex's own protocol comment calls them "current configured … when
 * loaded, otherwise the latest persisted", and says explicitly: "This is not
 * per-turn execution telemetry." So this answers "what was this worker set to
 * run at" — what the Codex desktop app shows when you click a subagent — and
 * not "what did each of its requests observably use". Claude's side of this
 * feature reads an observed model; the difference is real and is why the two
 * capture sites do not share a helper.
 *
 * Returns [] rather than throwing: a roster is decoration, and a failed list
 * must never take down the turn that was about to report its own success.
 */
export async function readCodexSubagentThreads(
  server: AppServer,
  threadId: string,
  timeoutMs: number,
): Promise<CodexSubagentThread[]> {
  try {
    const response = await sendCodexRequest(server, 'thread/list', { ancestorThreadId: threadId, limit: 100 }, timeoutMs);
    if (response.error) return [];
    const result = response.result as
      | { data?: Array<Record<string, unknown>>; threads?: Array<Record<string, unknown>> }
      | undefined;
    const threads = result?.data ?? result?.threads ?? [];
    const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
    return threads
      .map((thread) => ({
        id: text(thread.id) ?? '',
        model: text(thread.model),
        // snake_case on the wire; the generated TS schema camelCases it, and
        // which one arrives depends on the app-server build, so read both.
        effort: text(thread.reasoning_effort) ?? text(thread.reasoningEffort),
      }))
      .filter((thread) => thread.id !== '');
  } catch {
    return [];
  }
}

/**
 * Pull the account's rate-limit snapshot — the Codex counterpart of Claude's
 * `/usage` control request (providers/claude.ts `planUsagePuller`).
 *
 * **Sent with NO `params` at all**, and that stays true across pin moves. The
 * shape originally shipped as `{ excludeResetCreditDetails: true }`, written
 * against the HOST's codex-cli 0.154.0, whose generated schema defines
 * `GetAccountRateLimitsParams` and marks the request's `params` optional. The
 * container was then pinned to 0.153.4, where `account/rateLimits/read`
 * deserializes its params as unit, so that map was refused at the JSON-RPC
 * boundary before any account lookup:
 *   `Invalid request: invalid type: map, expected unit`
 * — which is what production logged for every bind-time read (#817). Omitting
 * `params` is valid on both: unit on 0.153.4, absent-and-optional on 0.154.0
 * (verified by issuing the real RPC against both binaries).
 *
 * The container's `ARG CODEX_VERSION` (`container/Dockerfile:41`) is now
 * **0.154.0** too, so the params map would be accepted again — and it is still
 * deliberately NOT sent. `excludeResetCreditDetails: true` only skipped a
 * second reset-credit lookup we never read, so re-adding it would buy nothing
 * and re-couple this call to one codex version; the no-params shape is the one
 * both old and new binaries accept, and it is what the next pin move should
 * keep. Do not "fix" it back.
 *
 * Throws on an RPC error or a malformed result; the caller treats a failed read
 * as NOT SAMPLED (no row, no park) and logs it — telemetry must never fail a
 * turn. That is why this failed silently for a full deploy:
 * `CodexRateLimitTracker.read()` writes its `usage_pull` sample inside the same
 * `try` (`codex-rate-limit-tracker.ts:232`, caught at `:235`), so a throw here
 * costs every pull row while the push path (`account/rateLimits/updated`,
 * `onNotification` at `:261`) keeps writing and the sample table looks alive.
 */
export async function readCodexAccountRateLimits(
  server: AppServer,
  timeoutMs: number,
): Promise<CodexRateLimitsReadResponse> {
  const resp = await sendCodexRequest(server, CODEX_RATE_LIMITS_READ_METHOD, undefined, timeoutMs);
  if (resp.error) throw new Error(`${CODEX_RATE_LIMITS_READ_METHOD} failed: ${resp.error.message}`);
  const parsed = parseCodexRateLimitsReadResponse(resp.result);
  if (!parsed) throw new Error(`${CODEX_RATE_LIMITS_READ_METHOD} response missing rateLimits`);
  return parsed;
}

// ── hooks/list ──────────────────────────────────────────────────────────────

/**
 * One handler as `hooks/list` reports it. Fields are those codex 0.154.0
 * actually emits, measured against a scratch `CODEX_HOME`; everything is
 * optional because this is a foreign wire shape and a pin move may drop or
 * rename a field. The three the trust check reads — `key`, `enabled`,
 * `trustStatus` — are exactly the three codex's own dispatch predicate reads
 * (`hooks/src/engine/discovery.rs:713-718`: `enabled && (bypass_hook_trust ||
 * trust_status is Managed | Trusted)`).
 */
export interface CodexHookListEntry {
  key?: string;
  eventName?: string;
  handlerType?: string;
  command?: string;
  sourcePath?: string;
  /** `"user"` for a hooks.json in the home, `"plugin"` for a registered plugin. */
  source?: string;
  pluginId?: string | null;
  enabled?: boolean;
  isManaged?: boolean;
  currentHash?: string;
  /** `"trusted" | "managed" | "modified" | "untrusted"` on 0.154.0. */
  trustStatus?: string;
}

export interface CodexHookListResult {
  entries: CodexHookListEntry[];
  /** Per-source diagnostics codex attaches to the listing, flattened. */
  warnings: string[];
  errors: string[];
}

export const CODEX_HOOKS_LIST_METHOD = 'hooks/list';

/**
 * Read back every hook the app-server actually loaded, with its trust status.
 *
 * **`params` is `{}`, not omitted.** Measured on 0.154.0: sending the request
 * with no `params` member is refused at the JSON-RPC boundary with
 * `Invalid request: missing field \`params\`` — the opposite of
 * `account/rateLimits/read` above, whose params deserialize as unit. Do not
 * "harmonize" the two.
 *
 * The result is `{ data: [ { cwd, hooks: [...], warnings, errors } ] }` — one
 * group per cwd, because project-local hook files are discovered per working
 * directory. Every group's handlers are flattened into one list; the caller
 * scopes by `sourcePath`.
 */
export async function listCodexHooks(server: AppServer, timeoutMs = 15_000): Promise<CodexHookListResult> {
  const resp = await sendCodexRequest(server, CODEX_HOOKS_LIST_METHOD, {}, timeoutMs);
  if (resp.error) throw new Error(`${CODEX_HOOKS_LIST_METHOD} failed: ${resp.error.message}`);
  const result = resp.result as { data?: unknown } | undefined;
  const groups = result?.data;
  if (!Array.isArray(groups)) throw new Error(`${CODEX_HOOKS_LIST_METHOD} response missing data array`);

  const entries: CodexHookListEntry[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const rawGroup of groups) {
    const group = (rawGroup ?? {}) as { hooks?: unknown; warnings?: unknown; errors?: unknown };
    if (Array.isArray(group.hooks)) {
      for (const hook of group.hooks) {
        if (hook && typeof hook === 'object') entries.push(hook as CodexHookListEntry);
      }
    }
    if (Array.isArray(group.warnings)) warnings.push(...group.warnings.map((w) => String(w)));
    if (Array.isArray(group.errors)) errors.push(...group.errors.map((e) => String(e)));
  }
  return { entries, warnings, errors };
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
  /**
   * Working directory for the server process. Codex's stdio MCP transport
   * takes this natively. Absolute by the time it reaches here.
   */
  cwd?: string;
}

export interface CodexHttpMcpServer {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

const MCP_MARKER = '# --- nanoclaw runtime MCP servers ---';

/**
 * Parse a TOML table header line, returning the table name or null.
 *
 * Sole owner of "is this line a table header" for every config.toml scanner in
 * the tree — this file's MCP stripper and codex-companion-setup's plugin
 * stripper both call it, because one of them getting the grammar wrong is how
 * a block goes unrecognized.
 *
 * `.+` is greedy on purpose: the closing bracket is the LAST `]` on the line,
 * not the first. A quoted key segment may legally contain `]` — which is
 * exactly what `tomlKey` now emits for a hostile server name — and a negated
 * class stops at the inner bracket, fails the end anchor, and reports "not a
 * header" for a line that is one. Both scanners then mis-handle the block: the
 * MCP stripper keeps the stale table as base config and the next spawn appends
 * a duplicate table, which codex refuses outright; the plugin stripper leaves
 * its flag stale and silently drops the following lines from the base config.
 */
export function parseTomlTableHeader(line: string): string | null {
  const match = line.match(/^\s*\[(.+)\]\s*$/);
  return match ? match[1].trim() : null;
}

function stripExistingMcpServers(toml: string): string {
  const out: string[] = [];
  let inMcpBlock = false;
  for (const line of toml.split('\n')) {
    if (line.trim() === MCP_MARKER) continue;
    const header = parseTomlTableHeader(line);
    if (header !== null) {
      inMcpBlock = header.startsWith('mcp_servers.');
      if (inMcpBlock) continue;
    }
    if (!inMcpBlock) out.push(line);
  }
  // Collapse blank-line runs left behind by the removed marker/blocks.
  const collapsed = out.filter((line, i) => line !== '' || out[i - 1] !== '');
  return collapsed.join('\n').trimEnd();
}

/**
 * Render the MCP half of a config.toml over an existing base.
 *
 * Split out from the write so the rendering is testable without a filesystem,
 * and so the write itself is one call to the shared durable primitive.
 */
export function renderCodexMcpConfigToml(existing: string, servers: Record<string, CodexMcpServer>): string {
  const base = stripExistingMcpServers(existing);
  const lines: string[] = base ? [base, '', MCP_MARKER, ''] : [];
  for (const [name, config] of Object.entries(servers)) {
    const tomlName = tomlKey(name);
    lines.push(`[mcp_servers.${tomlName}]`);
    if (config.type === 'http') {
      lines.push(`url = ${tomlBasicString(config.url)}`);
      if (config.headers && Object.keys(config.headers).length > 0) {
        lines.push(`http_headers = ${tomlInlineStringMap(config.headers)}`);
      }
    } else {
      lines.push('type = "stdio"');
      lines.push(`command = ${tomlBasicString(config.command)}`);
      // Codex launches the stdio server here natively. Must stay ABOVE the
      // `[mcp_servers.*.env]` sub-table header or TOML re-parents it into the
      // env table. (upstream 5e15069da)
      if (config.cwd) {
        lines.push(`cwd = ${tomlBasicString(config.cwd)}`);
      }
      if (config.args && config.args.length > 0) {
        const argsStr = config.args.map(tomlBasicString).join(', ');
        lines.push(`args = [${argsStr}]`);
      }
      if (config.env && Object.keys(config.env).length > 0) {
        lines.push(`[mcp_servers.${tomlName}.env]`);
        for (const [key, value] of Object.entries(config.env)) {
          lines.push(`${tomlKey(key)} = ${tomlBasicString(value)}`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Resolve the container's Codex config directory.
 *
 * Honors CODEX_HOME so a rotated home (OAuth fallback) gets its own regenerated
 * config — otherwise the rotated app-server reads stale config from the wrong
 * dir. CODEX_HOME == $HOME/.codex on initial spawn, so this is a no-op there.
 * (codex #126)
 */
export function resolveCodexConfigDir(): string {
  return process.env.CODEX_HOME || path.join(process.env.HOME || '/home/node', '.codex');
}

/**
 * Rewrite the MCP tables in the container's `config.toml`.
 *
 * THROWS when the existing file cannot be read or the new one cannot be
 * committed, and that is the fix this function exists for. It used to read
 * under `catch { base = '' }`: a config.toml that is unreadable but writable
 * (mode `0200`) was read as empty and the file then TRUNCATED to MCP tables
 * only — dropping the `[hooks.state.*]` trust rows and the `[plugins.*]` /
 * `[marketplaces.*]` tables. This runs immediately BEFORE `writeCodexHooksAndTrust`
 * on every spawn (`./codex.ts`), so it got there first: the trust writer's own
 * read guard aborted that query, but the damage was already on disk, and the
 * next query happily wrote valid trust rows over a base that had lost
 * everything else. See `./codex-config-file.ts`.
 */
export function writeCodexMcpConfigToml(servers: Record<string, CodexMcpServer>): void {
  const configTomlPath = path.join(resolveCodexConfigDir(), 'config.toml');
  writeCodexConfigToml(configTomlPath, (existing) => renderCodexMcpConfigToml(existing, servers));
  log(`Wrote MCP config.toml (${Object.keys(servers).length} server(s))`);
}

// ── hooks.json (NanoClaw guardrails + source capture) ──────────────────────
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
 *
 * Writing the file is only half the wiring: Codex will not RUN an untrusted
 * hook, so the resolved home ALSO needs matching `[hooks.state.*]` entries in
 * its config.toml. Returning the directory is what lets the caller
 * (`writeCodexHooksAndTrust` in ../codex-companion-setup.ts) key those entries
 * on the home this call actually wrote to, including after an OAuth-fallback
 * rotation.
 */
export function writeCodexHooksJson(opts?: { emailGateTimeoutSec?: number; codexHome?: string }): string {
  // Honor CODEX_HOME (see resolveCodexConfigDir): hooks.json is the destructive-
  // guard wiring, so a rotated fallback home MUST get the regenerated hooks or the
  // guard silently stops firing after an OAuth rotation. An explicit codexHome
  // lets peer-mode `codex exec` receive the same in-tree hook before CODEX_HOME
  // is switched to its synthesized runtime directory. (codex #126)
  //
  // Through the SAME resolver as the config writer, deliberately. This used to
  // read `process.env.CODEX_HOME ?? …` while the config writer read
  // `process.env.CODEX_HOME || …`, so `CODEX_HOME=""` sent config.toml to
  // `$HOME/.codex` and hooks.json to the relative path `hooks.json` — trust
  // entries keyed on a file the app-server would never load, which is this
  // module's silent-inert failure reached through a typo in one env var.
  const codexConfigDir = opts?.codexHome ?? resolveCodexConfigDir();
  fs.mkdirSync(codexConfigDir, { recursive: true });
  const hooksJsonPath = path.join(codexConfigDir, 'hooks.json');
  const hooks = buildCodexHooksJson(opts);
  fs.writeFileSync(hooksJsonPath, JSON.stringify(hooks, null, 2));
  log(`Wrote hooks.json (PreToolUse timeout=${hooks.hooks.PreToolUse[0].hooks[0].timeout}s)`);
  return codexConfigDir;
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
  // CLI overrides survive per-spawn config rewrites and fallback-home rotation.
  // Steering is built into turn/steer; its former feature toggle was removed.
  const overrides = [
    'features.use_linux_sandbox_bwrap=false',
    'features.goals=true',
    // Raises Codex's silent-truncation ceiling for the group AGENTS.md — the
    // 32KB default (`project_doc_max_bytes`) truncated whole behavioral
    // sections in production (4,131 logged incidents). 262144 = 256KB, ~8x
    // the largest current doc. Keep src/codex-project-doc-cap.ts's warn
    // threshold numerically in sync with this value.
    'project_doc_max_bytes=262144',
    // Preserve the container context limits if a rotated OAuth fallback home
    // has not retained its generated config.toml.
    'model_context_window=400000',
    'model_auto_compact_token_limit=360000',
    'features.fast_mode=false',
    // Bound native collaboration at the app-server boundary. Each Codex
    // subagent owns a full MCP subprocess tree, so an inherited host setting
    // that permits an unbounded/high worker count can exhaust the container's
    // PID cgroup and surface as a misleading protocol-desync error.
    'features.multi_agent=true',
    `agents.max_concurrent_threads_per_session=${
      stickyConfig?.max_concurrent_threads_per_session ?? DEFAULT_CODEX_MAX_CONCURRENT_THREADS_PER_SESSION
    }`,
    // The canonical Markdown memory tree is the sole retrieval layer. Codex's
    // opaque summary store is disabled; canonical memory bytes enter through
    // paired untrusted recall. The provider lifecycle carries trusted static
    // guidance only.
    'memories.generate_memories=false',
    'memories.use_memories=false',
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

// The native cap counts spawned agents, excluding the primary thread. Four is
// the install default (was 15; lowered for quota — docs/specs/quota-burn/plan.md
// §0.4); operators can override it per group through providerConfig when a
// workload warrants it. This constant is what actually binds: it is passed as a
// `-c agents.max_concurrent_threads_per_session=` override at app-server spawn
// (createCodexConfigOverrides above), which beats the generated config.toml.
export const DEFAULT_CODEX_MAX_CONCURRENT_THREADS_PER_SESSION = 5;
