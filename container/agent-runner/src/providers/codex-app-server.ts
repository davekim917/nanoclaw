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

export const CODEX_INIT_TIMEOUT_MS = 30_000;
const INIT_ATTEMPTS = 2;

class CodexRequestTimeoutError extends Error {}

const CODEX_INITIALIZE_CAPABILITIES = {
  // Required for thread/list.ancestorThreadId, which lets the liveness probe
  // see work delegated below a quiet root thread.
  experimentalApi: true,
  // A suppression list, not an allow-list: keep it empty so high-volume delta streams stay deliverable.
  optOutNotificationMethods: [],
};

/** Only these errors fall back to a fresh thread; shared with codex.ts's `isSessionInvalid`. */
export const STALE_THREAD_RE = /thread\s+not\s+found|unknown\s+thread|thread[_\s]id|no such thread/i;

/** Rejects newlines, which in an MCP value are misconfiguration (e.g. a secret with a trailing newline). */
function tomlBasicString(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(
      `MCP config value contains newline (not supported in config.toml): ${JSON.stringify(value.slice(0, 40))}${value.length > 40 ? '…' : ''}`,
    );
  }
  return `"${escapeTomlBasicStringBody(value)}"`;
}

/**
 * The only TOML basic-string escaper here, and it never refuses (keys come from paths, not authors). Every C0/DEL
 * byte must be escaped: codex answers one raw control byte with "using defaults" and silently drops every table.
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
 * Names are operator/agent-supplied and unvalidated, so anything outside TOML's bare-key grammar is quoted; a `.`,
 * `]` or quote could otherwise nest or open an `[mcp_servers.*]` table the approval card never showed.
 */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlBasicString(name);
}

function tomlInlineStringMap(map: Record<string, string>): string {
  return `{ ${Object.entries(map)
    .map(([key, value]) => `${tomlBasicString(key)} = ${tomlBasicString(value)}`)
    .join(', ')} }`;
}

let nextRequestId = 1;

interface JsonRpcRequest {
  id: number;
  method: string;
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
 * No params means no `params` key at all (not null, not {}): methods whose params deserialize as unit accept only
 * that shape.
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

export interface AppServer {
  process: ChildProcess;
  readline: ReadlineInterface;
  pending: Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>;
  notificationHandlers: ((n: JsonRpcNotification) => void)[];
  serverRequestHandlers: ((r: JsonRpcServerRequest) => void)[];
}

function spawnCodexAppServer(configOverrides: string[] = []): AppServer {
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
      reject(new CodexRequestTimeoutError(`Timeout waiting for ${method} response (${timeoutMs}ms)`));
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

// The container sandbox is the security boundary; Codex's own approval prompts would block on an absent user.
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

async function initializeCodexAppServer(server: AppServer, timeoutMs: number): Promise<void> {
  log('Sending initialize…');
  const resp = await sendCodexRequest(
    server,
    'initialize',
    {
      clientInfo: { name: 'nanoclaw', version: '1.0.0' },
      capabilities: CODEX_INITIALIZE_CAPABILITIES,
    },
    timeoutMs,
  );
  if (resp.error) throw new Error(`Initialize failed: ${resp.error.message}`);
  log('Initialize successful');
}

/**
 * Spawns and initializes an app-server. An unanswered `initialize` gets one fresh process before the failure
 * surfaces: the host answers that failure by moving the whole agent group to its fallback provider. `onSpawn`
 * runs for every process, before its first request. `onRetry` is the caller's liveness signal: the host kills a
 * container whose claimed message shows no sign of life for a minute, and a retried start can take that long
 * before the first provider event.
 */
export async function startCodexAppServer(
  configOverrides: string[],
  onSpawn: (server: AppServer) => void,
  onRetry: () => void,
  initTimeoutMs: number = CODEX_INIT_TIMEOUT_MS,
): Promise<AppServer> {
  for (let attempt = 1; ; attempt++) {
    const server = spawnCodexAppServer(configOverrides);
    onSpawn(server);
    try {
      await initializeCodexAppServer(server, initTimeoutMs);
      return server;
    } catch (err) {
      killCodexAppServer(server);
      if (attempt >= INIT_ATTEMPTS || !(err instanceof CodexRequestTimeoutError)) throw err;
      log(`initialize unanswered after ${initTimeoutMs}ms — starting a fresh app-server (attempt ${attempt + 1})`);
      onRetry();
    }
  }
}

export interface ThreadParams {
  model: string;
  cwd: string;
  sandbox?: string;
  approvalPolicy?: string;
  personality?: string;
  baseInstructions?: string;
}

/** Falls back to `thread/start` only on a recognized stale-thread error (thread IDs commonly outlive containers). */
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
    // Any other resume failure throws: a silent fresh thread would discard session state.
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

/** Non-mutating; descendants are included because a root can look idle while delegated agents are active. */
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

export interface CodexSubagentThread {
  id: string;
  model: string | null;
  effort: string | null;
}

/**
 * `model`/`effort` are the thread's configured values, not per-turn telemetry (Codex's protocol says so).
 * Returns [] rather than throwing: a failed roster must never fail the turn.
 */
export async function readCodexSubagentThreads(
  server: AppServer,
  threadId: string,
  timeoutMs: number,
): Promise<CodexSubagentThread[]> {
  try {
    const response = await sendCodexRequest(
      server,
      'thread/list',
      { ancestorThreadId: threadId, limit: 100 },
      timeoutMs,
    );
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
        // snake_case on the wire, camelCase in some app-server builds: read both.
        effort: text(thread.reasoning_effort) ?? text(thread.reasoningEffort),
      }))
      .filter((thread) => thread.id !== '');
  } catch {
    return [];
  }
}

/**
 * Sent with NO `params`: codex 0.153.4 deserializes them as unit and refuses a map while 0.154.0 accepts absence,
 * so this is the one shape both accept. Do not re-add `excludeResetCreditDetails`.
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

/** Foreign wire shape (measured on 0.154.0): every field is optional because a pin move may drop or rename one. */
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
  warnings: string[];
  errors: string[];
}

export const CODEX_HOOKS_LIST_METHOD = 'hooks/list';

/**
 * `params` must be `{}`, not omitted: 0.154.0 refuses a missing `params` here, the opposite of
 * `account/rateLimits/read`. Groups are per cwd and flattened; the caller scopes by `sourcePath`.
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

export async function interruptCodexTurn(
  server: AppServer,
  params: { threadId: string; turnId: string },
  timeoutMs = 5_000,
): Promise<void> {
  const response = await sendCodexRequest(server, 'turn/interrupt', params, timeoutMs);
  if (response.error) throw new Error(`turn/interrupt failed: ${response.error.message}`);
}

/**
 * `expectedTurnId` must match the active turn or the server refuses; the caller queues for the next turn on a
 * throw.
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

export type CodexMcpServer = CodexStdioMcpServer | CodexHttpMcpServer;

export interface CodexStdioMcpServer {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Absolute by the time it reaches here. */
  cwd?: string;
}

export interface CodexHttpMcpServer {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

const MCP_MARKER = '# --- nanoclaw runtime MCP servers ---';

/**
 * Shared by every config.toml scanner. `.+` is greedy on purpose: a quoted key may contain `]` (tomlKey emits one
 * for a hostile name), and a match that stopped at the first `]` would miss the header and leave a duplicate table.
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
  const collapsed = out.filter((line, i) => line !== '' || out[i - 1] !== '');
  return collapsed.join('\n').trimEnd();
}

const NANOCLAW_MCP_SERVER = 'nanoclaw';

export function renderCodexMcpConfigToml(existing: string, servers: Record<string, CodexMcpServer>): string {
  const base = stripExistingMcpServers(existing);
  const lines: string[] = base ? [base, '', MCP_MARKER, ''] : [];
  for (const [name, config] of Object.entries(servers)) {
    const rendered = renderCodexMcpServer(name, config);
    // Fail thread start or resume loudly when the built-in server (send_message, scheduling, every NanoClaw tool)
    // cannot start, rather than run a turn that cannot act. Other servers stay optional, and so does the peer-mode
    // companion's copy of this server.
    if (name === NANOCLAW_MCP_SERVER) rendered.splice(1, 0, 'required = true');
    lines.push(...rendered, '');
  }
  return lines.join('\n');
}

export function renderCodexMcpServer(name: string, config: CodexMcpServer): string[] {
  const tomlName = tomlKey(name);
  const lines = [`[mcp_servers.${tomlName}]`];
  if (config.type === 'http') {
    lines.push(`url = ${tomlBasicString(config.url)}`);
    if (config.headers && Object.keys(config.headers).length > 0) {
      lines.push(`http_headers = ${tomlInlineStringMap(config.headers)}`);
    }
    return lines;
  }
  lines.push('type = "stdio"');
  lines.push(`command = ${tomlBasicString(config.command)}`);
  // Must stay above the `[mcp_servers.*.env]` sub-table header or TOML re-parents it into the env table.
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
  return lines;
}

/** Honors CODEX_HOME so a rotated OAuth-fallback home gets its own regenerated config. */
export function resolveCodexConfigDir(): string {
  return process.env.CODEX_HOME || path.join(process.env.HOME || '/home/node', '.codex');
}

/** Throws on an unreadable base rather than truncating the file to MCP tables only (see ./codex-config-file.ts). */
export function writeCodexMcpConfigToml(servers: Record<string, CodexMcpServer>): void {
  const configTomlPath = path.join(resolveCodexConfigDir(), 'config.toml');
  writeCodexConfigToml(configTomlPath, (existing) => renderCodexMcpConfigToml(existing, servers));
  log(`Wrote MCP config.toml (${Object.keys(servers).length} server(s))`);
}

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
 * The PreToolUse email gate waits up to 60 minutes for approval, hence its long timeout. The caller keys the
 * `[hooks.state.*]` trust entries on the returned directory, since Codex will not run an untrusted hook.
 */
export function writeCodexHooksJson(opts?: { emailGateTimeoutSec?: number; codexHome?: string }): string {
  // Same resolver as the config writer: a rotated home must get the hooks too, or the guard silently stops firing.
  // An explicit codexHome lets peer-mode `codex exec` get the hook before CODEX_HOME is switched.
  const codexConfigDir = opts?.codexHome ?? resolveCodexConfigDir();
  fs.mkdirSync(codexConfigDir, { recursive: true });
  const hooksJsonPath = path.join(codexConfigDir, 'hooks.json');
  const hooks = buildCodexHooksJson(opts);
  fs.writeFileSync(hooksJsonPath, JSON.stringify(hooks, null, 2));
  log(`Wrote hooks.json (PreToolUse timeout=${hooks.hooks.PreToolUse[0].hooks[0].timeout}s)`);
  return codexConfigDir;
}

/** `model` is not emitted here: thread/start carries it as a first-class parameter. */
export function createCodexConfigOverrides(
  stickyConfig?: {
    reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    max_concurrent_threads_per_session?: number;
  },
  fast = false,
): string[] {
  // CLI overrides survive per-spawn config rewrites and fallback-home rotation.
  const overrides = [
    // Since Codex 0.147.0 MCP servers get about a second before a turn, which then runs without the tools of any
    // server still starting. Each query spawns a fresh app-server, so every server starts cold; 0 waits for each
    // one up to its own startup timeout.
    'mcp_optional_startup_grace_ms=0',
    'features.use_linux_sandbox_bwrap=false',
    'features.goals=true',
    // 256KB: the 32KB default silently truncated the group AGENTS.md. Keep src/codex-project-doc-cap.ts's warn
    // threshold in sync with this value.
    'project_doc_max_bytes=262144',
    // Also set here in case a rotated OAuth fallback home lost its generated config.toml.
    'model_context_window=400000',
    'model_auto_compact_token_limit=360000',
    'features.fast_mode=false',
    // Each subagent owns a full MCP subprocess tree: an unbounded worker count exhausts the PID cgroup and
    // surfaces as a misleading protocol-desync error.
    'features.multi_agent=true',
    `agents.max_concurrent_threads_per_session=${
      stickyConfig?.max_concurrent_threads_per_session ?? DEFAULT_CODEX_MAX_CONCURRENT_THREADS_PER_SESSION
    }`,
    // The Markdown memory tree is the sole retrieval layer, so Codex's own memory store stays off.
    'memories.generate_memories=false',
    'memories.use_memories=false',
  ];
  if (stickyConfig?.reasoning_effort) {
    overrides.push(`model_reasoning_effort="${stickyConfig.reasoning_effort}"`);
  }
  if (fast) {
    overrides.push('service_tier="fast"');
  }
  // Without "detailed", gpt-5.x emits no reasoning-summary deltas even at xhigh effort ("auto" was insufficient).
  overrides.push('model_reasoning_summary="detailed"');
  return overrides;
}

// Counts spawned agents, excluding the primary thread. Passed as a `-c` override, which beats the generated
// config.toml.
export const DEFAULT_CODEX_MAX_CONCURRENT_THREADS_PER_SESSION = 5;
