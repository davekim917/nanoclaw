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

// ── Per-query model/effort overrides (-m/-e flags) ──────────────────────────
// The poll-loop delivers host-parsed flag values via QueryInput.model/.effort
// (turn override → sticky, resolved in applyFlagBatch). Both are validated
// here before they reach the app-server: session_state can carry values from
// before the host's flag vocabulary became provider-aware (observed live
// 2026-06-10: sticky_model=claude-fable-5[1m] on a codex session), and a
// claude id at thread/start would fail every turn of the session.

/** Mirrors CODEX_VALID_MODEL_RE in the host's flag-parser (separate package trees). */
export const CODEX_MODEL_RE = /^gpt-[a-z0-9][a-z0-9.-]*$/;

const CODEX_EFFORT_VALUES: ReadonlySet<string> = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

type CodexStickyConfig = z.infer<typeof codexConfigSchema>;

/** Flag-requested model if it's codex-shaped, else the configured fallback. */
export function resolveQueryModel(requested: string | undefined, fallback: string): string {
  if (!requested) return fallback;
  if (CODEX_MODEL_RE.test(requested)) return requested;
  console.error(`[codex-provider] Ignoring non-codex model override "${requested}" — staying on ${fallback}`);
  return fallback;
}

/**
 * Sticky config with the flag-requested effort folded in (when valid for
 * codex's reasoning_effort enum). Returned object feeds
 * createCodexConfigOverrides at app-server spawn — one server per query, so
 * a per-query effort lands as `-c model_reasoning_effort` naturally.
 */
export function resolveQueryEffort(requested: string | undefined, sticky: CodexStickyConfig): CodexStickyConfig {
  if (!requested) return sticky;
  if (CODEX_EFFORT_VALUES.has(requested)) {
    return { ...sticky, reasoning_effort: requested as CodexStickyConfig['reasoning_effort'] };
  }
  console.error(
    `[codex-provider] Ignoring non-codex effort override "${requested}" — staying on ${sticky.reasoning_effort}`,
  );
  return sticky;
}

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

/**
 * Container env vars that need to reach every MCP subprocess for outbound
 * HTTPS to work through OneCLI's substitution proxy + CA. Order matters
 * only in that comments and key membership do; if the host has the var
 * set in process.env, it gets forwarded; if not, the slot is omitted.
 *
 * Categories:
 *   - HTTPS_PROXY / HTTP_PROXY / NO_PROXY (and lowercase): routes
 *     outbound HTTP through the OneCLI gateway. Without these, remote
 *     MCP calls bypass OneCLI and outbound auth substitution fails.
 *   - NODE_USE_ENV_PROXY: makes Node 22+ fetch honor HTTPS_PROXY without
 *     explicit ProxyAgent setup. Required because remote-mcp-bridge uses
 *     undici's fetch which only honors env-proxy when this flag is set.
 *   - NODE_EXTRA_CA_CERTS + the CA-bundle siblings: lets the MCP
 *     subprocess trust OneCLI's mitm CA. Without these, outbound TLS to
 *     the gateway fails with CERT_HAS_EXPIRED / SELF_SIGNED_CERT.
 */
const MCP_PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'PIP_CERT',
  'AWS_CA_BUNDLE',
  'DENO_CERT',
  'GIT_SSL_CAINFO',
] as const;

/**
 * Copy the proxy + CA env vars from `process.env` into `baseEnv` if they're
 * not already set. Existing keys in `baseEnv` (e.g. an MCP that intentionally
 * overrides a proxy setting) win. Returns a new object — never mutates the
 * input.
 */
export function augmentWithProxyEnv(baseEnv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...baseEnv };
  for (const key of MCP_PROXY_ENV_KEYS) {
    if (out[key] !== undefined) continue;
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

// ── Codex OAuth fallback (rollout-copy rotation) ───────────────────────────
// Codex stores per-thread state in `${CODEX_HOME}/sessions/YYYY/MM/DD/
// rollout-<ISO>-<threadId>.jsonl`. The file is self-contained: the codex
// app-server reconstructs full history from it and sends the inline message
// list to the responses API on resume — no `previous_response_id`, no
// account-binding (verified via openai/codex docs + empirical inspection of
// a real rollout's payload). So OAuth fallback can preserve conversation
// context by copying the rollout into the new CODEX_HOME's sessions tree
// before respawning the app-server.

/**
 * `codexErrorInfo.type` values that should trigger OAuth fallback rotation.
 * Both are quota-flavored — distinct from `Unauthorized` / `BadRequest` /
 * `ContextWindowExceeded` etc., which are terminal regardless of which
 * identity is used. Source: openai/codex `CodexErrorInfo` enum + the TUI's
 * `app_server_rate_limit_error_kind` rate-limit classifier.
 */
const ROTATABLE_CODEX_ERROR_KINDS: ReadonlySet<string> = new Set([
  'UsageLimitExceeded',
  'ServerOverloaded',
]);

/**
 * Walk `${codexHome}/sessions/` for the rollout `.jsonl` whose filename
 * embeds the given thread UUID. Codex's path layout is
 * `sessions/YYYY/MM/DD/rollout-<ISO>-<threadId>.jsonl`. Returns absolute
 * path or null if nothing matches.
 *
 * Tolerates UUIDs in any case and missing date subdirs. Walks at most 3
 * levels deep (year/month/day) so a corrupted sessions tree can't lock the
 * search; returns the first match (multiple rollouts per thread aren't
 * expected in this codex version).
 */
export function findRolloutFile(threadId: string, codexHome: string): string | null {
  const sessionsRoot = path.join(codexHome, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;
  const needle = threadId.toLowerCase();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: sessionsRoot, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < 3) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.endsWith('.jsonl')) continue;
      if (entry.toLowerCase().includes(needle)) return full;
    }
  }
  return null;
}

/**
 * Copy a rollout `.jsonl` from one CODEX_HOME's sessions tree to another,
 * preserving the date subdirectory layout. The destination path mirrors the
 * source's path relative to its sessions/ root (so `sessions/2026/05/21/...`
 * lands at the same subpath under the fallback home).
 *
 * Idempotent: overwrites the destination if it exists. Creates parent dirs.
 * Returns the destination path on success, null on failure.
 *
 * Important: copying mid-turn is safe because Codex's writer appends
 * line-by-line and fsyncs per record. The destination won't capture any
 * records written after the copy starts, but those records belong to the
 * failed turn anyway (the rotation routine will replay the user input
 * against the new app-server, generating a fresh assistant response).
 */
export function copyRolloutToFallback(
  srcRollout: string,
  srcCodexHome: string,
  dstCodexHome: string,
): string | null {
  const srcSessionsRoot = path.join(srcCodexHome, 'sessions');
  const rel = path.relative(srcSessionsRoot, srcRollout);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const dstPath = path.join(dstCodexHome, 'sessions', rel);
  try {
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.copyFileSync(srcRollout, dstPath);
    return dstPath;
  } catch {
    return null;
  }
}

/**
 * Mirror the named-subagent role definitions (`<primary>/agents`) into a rotated
 * CODEX_HOME. The agents/ tree is bind-mounted ONLY at the primary home, so a
 * fallback home reached on OAuth rotation has no role TOMLs and would silently
 * lose every named subagent role (architecture-advisor, code-review-specialist,
 * …) — the exact layer the agents/ mount surfaces. Copy (not symlink): the
 * fallback home is RW and Codex reads roles from `$CODEX_HOME/agents/`. No-op
 * when src==dst or the primary has no agents/ tree. (codex #126)
 */
export function mirrorCodexAgentsToHome(primaryCodexHome: string, targetCodexHome: string): boolean {
  if (primaryCodexHome === targetCodexHome) return false;
  const src = path.join(primaryCodexHome, 'agents');
  if (!fs.existsSync(src)) return false;
  const dst = path.join(targetCodexHome, 'agents');
  try {
    fs.cpSync(src, dst, { recursive: true });
    return true;
  } catch (e) {
    console.error(
      `[codex-provider] failed to mirror agents/ ${src} → ${dst}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

export function refreshCodexAuthFromHost(activeCodexHome: string, hostCodexHome: string | undefined): boolean {
  if (!hostCodexHome) return false;

  const src = path.join(hostCodexHome, 'auth.json');
  const dst = path.join(activeCodexHome, 'auth.json');
  if (path.resolve(src) === path.resolve(dst)) return false;

  try {
    if (!fs.existsSync(src)) return false;
    const srcAuth = fs.readFileSync(src);
    let dstAuth: Buffer | null = null;
    try {
      dstAuth = fs.readFileSync(dst);
    } catch {
      dstAuth = null;
    }
    if (dstAuth && Buffer.compare(srcAuth, dstAuth) === 0) return false;

    fs.mkdirSync(activeCodexHome, { recursive: true });
    const tmp = path.join(activeCodexHome, `.auth.json.refresh-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmp, srcAuth, { mode: 0o600 });
    fs.renameSync(tmp, dst);
    return true;
  } catch (e) {
    console.error(
      `[codex-provider] failed to refresh auth.json from host: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/**
 * Locate the freshest rollout for `threadId` across multiple CODEX_HOMEs.
 *
 * Why this exists: after an in-session rotation, the rollout file diverges
 * across homes. Primary holds the pre-rotation history; the fallback holds
 * the newer post-rotation history. When the container later dies (host-sweep
 * absolute-ceiling, idle timeout) and a fresh container spawns for the same
 * thread, `nextFallback` resets to 0 and `thread/resume` reads from primary
 * — finding the STALE pre-rotation rollout. Post-rotation turns are
 * stranded on the fallback; if primary is still rate-limited, rotation
 * fires again and the *stale* primary rollout overwrites the *newer*
 * fallback rollout, destroying history.
 *
 * The fix: at thread/resume time, scan all CODEX_HOMEs for rollout files
 * matching this threadId and pick the freshest. Selection key is
 * `(mtimeMs DESC, size DESC)` — mtime alone is fragile because the
 * rotation's `copyFileSync` can leave two homes with nearly-identical
 * mtimes; size as a tiebreaker prefers the one with more appended turns
 * (codex rollouts are append-only line-by-line).
 *
 * Returns null when no home contains the threadId. Skips homes whose
 * sessions tree is missing entirely (fresh fallback dirs that haven't
 * been written to yet).
 */
export interface RolloutCandidate {
  home: string;
  path: string;
  mtimeMs: number;
  size: number;
}

export function findNewestRolloutAcrossHomes(
  threadId: string,
  codexHomes: readonly string[],
): RolloutCandidate | null {
  const needle = threadId.toLowerCase();
  let best: RolloutCandidate | null = null;
  for (const home of codexHomes) {
    const sessionsRoot = path.join(home, 'sessions');
    if (!fs.existsSync(sessionsRoot)) continue;
    const stack: Array<{ dir: string; depth: number }> = [{ dir: sessionsRoot, depth: 0 }];
    while (stack.length > 0) {
      const { dir, depth } = stack.pop()!;
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          if (depth < 3) stack.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (!entry.endsWith('.jsonl')) continue;
        if (!entry.toLowerCase().includes(needle)) continue;
        if (
          best === null ||
          stat.mtimeMs > best.mtimeMs ||
          (stat.mtimeMs === best.mtimeMs && stat.size > best.size)
        ) {
          best = { home, path: full, mtimeMs: stat.mtimeMs, size: stat.size };
        }
      }
    }
  }
  return best;
}

export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly mcpServers: Record<string, CodexMcpServer>;
  private readonly model: string;
  private readonly stickyConfig: z.infer<typeof codexConfigSchema>;

  /**
   * Ordered fallback CODEX_HOME paths from the `CODEX_FALLBACK_HOMES` env
   * (colon-joined). Host's container-runner mounts each fallback `~/.codex*`
   * dir at `/home/node/.codex-fallback-N/` and forwards the env var. Used
   * by the rotation routine in `gen()` to walk through alternate OAuth
   * identities on `UsageLimitExceeded` / `ServerOverloaded` / coarse
   * `systemError`. Cursor persists for the provider instance lifetime —
   * once we've rotated to slot N, slot N+1 is the next target even across
   * `query()` calls.
   */
  readonly fallbackHomes: readonly string[];
  private nextFallback = 0;

  constructor(options: ProviderOptions = {}) {
    // Native-first MCP wiring:
    // - stdio stays stdio, with proxy/CA env injected for child MCP processes.
    // - Streamable HTTP stays native Codex HTTP (url in config.toml).
    // - the old stdio bridge is only an explicit compatibility fallback.
    // - legacy SSE is rejected at config parse time and defensively here.
    const mcpServers: Record<string, CodexMcpServer> = {};
    const useHttpBridgeFallback = process.env.NANOCLAW_CODEX_MCP_HTTP_BRIDGE_FALLBACK === '1';
    for (const [name, cfg] of Object.entries(options.mcpServers ?? {})) {
      if (cfg && (cfg.type === undefined || cfg.type === 'stdio') && 'command' in cfg) {
        mcpServers[name] = {
          type: 'stdio',
          command: cfg.command,
          args: cfg.args,
          env: augmentWithProxyEnv(cfg.env ?? {}),
        };
      } else if (cfg?.type === 'http') {
        if (useHttpBridgeFallback) {
          const baseEnv: Record<string, string> = { REMOTE_MCP_NAME: name };
          const authorization = cfg.headers?.Authorization ?? cfg.headers?.authorization;
          if (authorization) baseEnv.REMOTE_MCP_AUTHORIZATION = authorization;
          mcpServers[name] = {
            type: 'stdio',
            command: 'bun',
            args: ['/app/src/remote-mcp-bridge.ts', cfg.url],
            env: augmentWithProxyEnv(baseEnv),
          };
        } else {
          mcpServers[name] = {
            type: 'http',
            url: cfg.url,
            ...(cfg.headers ? { headers: cfg.headers } : {}),
          };
        }
      } else if (cfg?.type === 'sse') {
        throw new Error(`MCP server "${name}" uses deprecated SSE transport. Use type: "http" instead.`);
      }
    }
    this.mcpServers = mcpServers;

    // Defensive re-parse (R8): catches hand-edited container.json or self-mod
    // mutations on startup before they reach codex.
    this.stickyConfig = codexConfigSchema.parse(options.providerConfig ?? {});

    // Model precedence: stickyConfig (per-agent) > CODEX_MODEL env (host
    // default) > built-in default.
    this.model =
      this.stickyConfig.model ??
      (options.env?.CODEX_MODEL as string | undefined) ??
      'gpt-5.5';

    // Fallback OAuth identities. Empty when CODEX_FALLBACK_HOMES is unset
    // (the host didn't mount any fallbacks). Read from process.env rather
    // than options.env because options.env is filtered for SDK consumption
    // — the host-side container-runner passes the var via `-e`, and Codex
    // doesn't have an env-allowlist filter for the app-server side.
    const fallbackEnv = process.env.CODEX_FALLBACK_HOMES ?? '';
    this.fallbackHomes = Object.freeze(
      fallbackEnv
        .split(':')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    if (this.fallbackHomes.length > 0) {
      console.error(
        `[codex-provider] Loaded ${this.fallbackHomes.length} Codex OAuth fallback(s): ${this.fallbackHomes.join(', ')}`,
      );
    }
  }

  /**
   * Advance the rotation cursor and return the next fallback CODEX_HOME, or
   * null when slots are exhausted. Position persists for the provider's
   * lifetime (matches the Claude provider's `rotateApiKey` contract).
   *
   * Exported as a method so the gen() body and unit tests can both drive it.
   */
  rotateCodexHome(): string | null {
    if (this.nextFallback >= this.fallbackHomes.length) return null;
    return this.fallbackHomes[this.nextFallback++];
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

    // -m/-e flag overrides for this query (validated; invalid values fall
    // back to configured defaults — see resolveQueryModel/resolveQueryEffort).
    const effectiveModel = resolveQueryModel(input.model, this.model);
    const effectiveConfig = resolveQueryEffort(input.effort, this.stickyConfig);

    async function* gen(): AsyncGenerator<ProviderEvent> {
      // One app-server per query invocation. The poll-loop keeps a single
      // query active per batch of pending messages and ends it on idle, so
      // spawn-per-query matches that cadence naturally.
      writeCodexMcpConfigToml(self.mcpServers);
      writeCodexHooksJson();
      let server = spawnCodexAppServer(createCodexConfigOverrides(effectiveConfig));
      turnTracker.server = server;
      attachCodexAutoApproval(server);

      let threadId: string | undefined = input.continuation;
      let initYielded = false;

      // Current CODEX_HOME. Tracked locally so the rotation routine can
      // pass it into findRolloutFile (the rollout to copy lives in the home
      // we're rotating AWAY from). Falls back to the conventional path when
      // process.env.CODEX_HOME is unset — the codex CLI uses the same default.
      let currentCodexHome = process.env.CODEX_HOME ?? '/home/node/.codex';
      // Stable reference to the PRIMARY home — the only one with the bind-mounted
      // agents/ tree. Captured before any rotation reassigns currentCodexHome, so
      // the rotation routine can mirror the role definitions into a fallback. (codex #126)
      const primaryCodexHome = currentCodexHome;
      const primaryHostCodexHome = process.env.CODEX_PRIMARY_HOST_HOME;
      let primaryAuthRefreshAttempted = false;

      try {
        await initializeCodexAppServer(server);

        const threadParams = {
          model: effectiveModel,
          cwd: input.cwd,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
          personality: 'friendly',
          baseInstructions: composeBaseInstructions(input.systemContext?.instructions),
        };

        // Cross-container rollout repair. When a prior session rotated to a
        // fallback and that container later died, the fallback holds the
        // newest rollout — but the fresh container starts with
        // currentCodexHome=primary (the rotation cursor resets per-instance).
        // Without this pass, thread/resume would read the STALE pre-rotation
        // rollout from primary; if rotation fires again here, the in-session
        // rotation copy would write that stale rollout OVER the newer
        // fallback rollout, destroying history.
        //
        // Cost: ~4ms with current sessions-tree scale (151 files), zero when
        // no fallbacks are configured. The fast-path skip is what makes this
        // free for the 99% of installs not using OAuth fallback.
        if (threadId && self.fallbackHomes.length > 0) {
          const candidate = findNewestRolloutAcrossHomes(threadId, [
            currentCodexHome,
            ...self.fallbackHomes,
          ]);
          if (candidate && candidate.home !== currentCodexHome) {
            const copied = copyRolloutToFallback(candidate.path, candidate.home, currentCodexHome);
            if (copied) {
              console.error(
                `[codex-provider] Pre-resume rollout repair: copied newer rollout from ${candidate.home} → ${currentCodexHome} (mtime=${candidate.mtimeMs} size=${candidate.size})`,
              );
            }
          }
        }

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

          // Rotation loop. Each iteration runs the same `text` against the
          // current app-server; on a rotation-eligible error with fallback
          // slots remaining, we copy the rollout, kill the server, switch
          // CODEX_HOME, spawn a fresh server, re-resume the thread, and
          // re-run the same input. Up to (1 + fallbackHomes.length)
          // attempts so an exhausted rotation falls through to surface the
          // error instead of looping.
          let attemptsRemaining = self.fallbackHomes.length + 1;
          let rotateAndRetry = true;
          while (rotateAndRetry && attemptsRemaining-- > 0) {
            rotateAndRetry = false;

            // One turn = one channel of streaming events. Each notification
            // from the app-server yields an `activity` first (so the
            // poll-loop's idle timer stays honest) and then, where relevant,
            // an init / result / progress event.
            //
            // We inspect each event while re-yielding it: on a
            // `retryable:false` error (e.g. TURN_IDLE_TIMEOUT_MS) the codex
            // app-server is wedged server-side — there's no turn-cancel RPC,
            // only turn/start and turn/steer, so the next startCodexTurn
            // would either block or immediately re-time-out. Return from
            // gen() so the outer finally calls killCodexAppServer and the
            // next poll-loop iteration spawns a fresh app-server within
            // seconds. Without this, every subsequent turn dies the same
            // way until host-sweep reaps the whole container at its 30-min
            // ABSOLUTE_CEILING_MS.
            //
            // EXCEPTION: when the error's classification matches a
            // rotation-eligible kind AND we have a fallback CODEX_HOME
            // available, transparently swap identity and retry instead of
            // surfacing the error.
            for await (const ev of runOneTurn(
              server,
              threadId!,
              text,
              effectiveModel,
              input.cwd,
              () => initYielded,
              () => {
                initYielded = true;
              },
              turnTracker,
            )) {
              if (ev.type === 'error' && ev.retryable === false) {
                const eligible =
                  ev.classification === 'quota' ||
                  ev.classification === 'overloaded' ||
                  ev.classification === 'system_error';
                const canRefreshPrimaryAuth =
                  ev.classification === 'system_error' &&
                  !primaryAuthRefreshAttempted &&
                  currentCodexHome === primaryCodexHome &&
                  refreshCodexAuthFromHost(currentCodexHome, primaryHostCodexHome);
                if (canRefreshPrimaryAuth) {
                  primaryAuthRefreshAttempted = true;
                  yield {
                    type: 'progress',
                    message: formatBlockquoteLabel(
                      '↻',
                      'Codex auth refreshed from host copy after system error; restarting app-server and retrying turn',
                    ),
                  };

                  turnTracker.server = null;
                  turnTracker.threadId = null;
                  turnTracker.currentTurnId = null;
                  killCodexAppServer(server);

                  writeCodexMcpConfigToml(self.mcpServers);
                  writeCodexHooksJson();

                  server = spawnCodexAppServer(createCodexConfigOverrides(effectiveConfig));
                  turnTracker.server = server;
                  attachCodexAutoApproval(server);
                  await initializeCodexAppServer(server);

                  const previousThreadId: string | undefined = threadId;
                  threadId = await startOrResumeCodexThread(server, threadId, threadParams);
                  turnTracker.threadId = threadId ?? null;
                  if (threadId !== previousThreadId) {
                    initYielded = false;
                  }

                  rotateAndRetry = true;
                  break;
                }
                if (eligible && self.nextFallback < self.fallbackHomes.length) {
                  const nextHome = self.rotateCodexHome();
                  if (nextHome) {
                    // Best-effort: copy the active rollout into the new
                    // CODEX_HOME's sessions tree so thread/resume reconstructs
                    // history inline. If the rollout doesn't exist yet (first
                    // turn) or the copy fails, the new app-server falls back
                    // to a fresh thread via STALE_THREAD_RE in
                    // startOrResumeCodexThread — conversation context is lost
                    // but the turn still completes.
                    let rolloutCopied = false;
                    if (threadId) {
                      const src = findRolloutFile(threadId, currentCodexHome);
                      if (src) {
                        const dst = copyRolloutToFallback(src, currentCodexHome, nextHome);
                        rolloutCopied = dst !== null;
                      }
                    }

                    // Visible status — better than swallowing the rotation
                    // silently. Uses progress so it flows through the same
                    // edit-in-place surface as the thinking labels.
                    yield {
                      type: 'progress',
                      message: formatBlockquoteLabel(
                        '↻',
                        `Codex OAuth rotating (${ev.classification}) → fallback ${self.nextFallback}/${self.fallbackHomes.length}` +
                          (rolloutCopied ? ' (history preserved)' : ' (history reset)'),
                      ),
                    };

                    // Tear down the wedged app-server, switch identity,
                    // spawn fresh. CODEX_HOME on process.env is what the
                    // app-server reads at spawn.
                    turnTracker.server = null;
                    turnTracker.threadId = null;
                    turnTracker.currentTurnId = null;
                    killCodexAppServer(server);
                    process.env.CODEX_HOME = nextHome;
                    currentCodexHome = nextHome;

                    // config.toml / hooks.json / agents/ all live under CODEX_HOME,
                    // so the new dir needs all three. The writers honor CODEX_HOME
                    // (just switched above), so regenerating config + the guard hooks
                    // lands them in the fallback home — without this the rotated
                    // app-server runs UNGUARDED. agents/ is bind-mounted only at the
                    // primary, so mirror the role definitions across explicitly. (codex #126)
                    writeCodexMcpConfigToml(self.mcpServers);
                    writeCodexHooksJson();
                    mirrorCodexAgentsToHome(primaryCodexHome, nextHome);

                    server = spawnCodexAppServer(createCodexConfigOverrides(effectiveConfig));
                    turnTracker.server = server;
                    attachCodexAutoApproval(server);
                    await initializeCodexAppServer(server);

                    // Re-resume the thread on the new identity. If the
                    // rollout copy succeeded, threadId stays the same and
                    // history continues. If it didn't, startOrResume falls
                    // back to a fresh thread via STALE_THREAD_RE and
                    // returns a new id — re-emit init so the poll loop
                    // updates its continuation.
                    const previousThreadId: string | undefined = threadId;
                    threadId = await startOrResumeCodexThread(server, threadId, threadParams);
                    turnTracker.threadId = threadId ?? null;
                    if (threadId !== previousThreadId) {
                      initYielded = false;
                    }

                    rotateAndRetry = true;
                    break; // exit for-await; the outer rotation while re-runs
                  }
                }
                // Not eligible OR no fallback slots — original behavior:
                // surface the error and end the query.
                yield ev;
                return;
              }
              yield ev;
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
  //
  // `errorKind` carries Codex's structured `codexErrorInfo.type` enum
  // (e.g. `UsageLimitExceeded`, `ServerOverloaded`, `Unauthorized`,
  // `ContextWindowExceeded`) when present on a `turn/completed: failed`
  // payload. Used by callers to decide whether an error is rotation-eligible
  // (quota-flavored) vs terminal (auth/context).
  const turnState: { error: Error | null; errorKind: string | null } = { error: null, errorKind: null };
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
      case 'turn/completed': {
        // Codex's `turn/completed` is overloaded: it fires for both successful
        // and failed turns. A failed turn carries `status: 'failed'` and an
        // `error` object with `message`, `codexErrorInfo` (structured enum:
        // UsageLimitExceeded | ServerOverloaded | ContextWindowExceeded |
        // Unauthorized | BadRequest | ...), and optional `additionalDetails`.
        // Treating every `turn/completed` as success made rate-limit hangs
        // invisible — the agent yielded an empty result and the poll loop
        // looped back into the same systemError.
        const p = params as {
          status?: string;
          error?: { message?: string; codexErrorInfo?: { type?: string } };
        };
        if (p.status === 'failed' || p.error) {
          const kind = p.error?.codexErrorInfo?.type;
          turnState.error = new Error(p.error?.message || 'Turn failed');
          if (typeof kind === 'string') turnState.errorKind = kind;
        }
        flushReasoning();
        if (turnTracker) turnTracker.currentTurnId = null;
        turnDone = true;
        break;
      }
      case 'turn/failed': {
        const e = params.error as { message?: string; codexErrorInfo?: { type?: string } } | undefined;
        turnState.error = new Error(e?.message || 'Turn failed');
        const kind = e?.codexErrorInfo?.type;
        if (typeof kind === 'string') turnState.errorKind = kind;
        if (turnTracker) turnTracker.currentTurnId = null;
        turnDone = true;
        break;
      }
      case 'thread/status/changed': {
        // Codex's thread/status/changed payload shape varies by app-server
        // version. Some versions emit params.status as a plain string;
        // others emit a structured object (e.g. { state: 'thinking',
        // detail: '...' }, or { type: 'systemError' }). Extract the most
        // useful human-readable label; never let template coercion produce
        // "[object Object]".
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
        // `systemError` is a thread-fatal state — Codex stops processing the
        // turn but the follow-up `turn/completed: failed` is unreliable
        // across app-server versions (observed wedge in 0.130.0: 30-min idle
        // until host-sweep ceiling killed the container). End the turn here
        // so the caller can react instead of waiting for a notification that
        // may never come. errorKind stays null because thread/status/changed
        // carries no structured detail — rotation logic should treat that as
        // "unknown, conservative-rotate" rather than "definitely auth/context".
        if (label === 'systemError') {
          turnState.error = new Error('codex_system_error: thread entered systemError state');
          if (turnTracker) turnTracker.currentTurnId = null;
          turnDone = true;
          break;
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
      // Map the structured CodexErrorInfo type to a ProviderEvent
      // `classification` so callers (CodexProvider.gen rotation) can decide
      // whether to rotate OAuth identities. Unknown → omit classification.
      // The `system_error` value below covers the coarse-systemError path
      // where thread/status/changed fired but no follow-up turn/completed
      // carried structured detail (observed wedge in codex-cli 0.130.0).
      let classification: string | undefined;
      if (turnState.errorKind && ROTATABLE_CODEX_ERROR_KINDS.has(turnState.errorKind)) {
        if (turnState.errorKind === 'UsageLimitExceeded') classification = 'quota';
        else if (turnState.errorKind === 'ServerOverloaded') classification = 'overloaded';
      } else if (turnState.error.message.startsWith('codex_system_error')) {
        classification = 'system_error';
      }
      yield {
        type: 'error',
        message: turnState.error.message,
        retryable: false,
        ...(classification ? { classification } : {}),
      };
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
