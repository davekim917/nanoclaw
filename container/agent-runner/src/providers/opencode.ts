import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import { memoryContextForSessionStart, type MemorySessionHookRegistration } from '../memory/session-hook.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput, TurnUsageInfo } from './types.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';
import { buildSecretEnvVarList, MCP_HEADER_ONLY_SECRET_VARS } from './secret-env.js';
import { shouldPostInfraWarning } from '../db/session-state.js';
import { MANAGED_GIT_OPENCODE_PLUGIN_PATH } from '../managed-git-guard.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

/** The fields we read off OpenCode's AssistantMessage (`message.updated`). */
export type OpenCodeAssistantUsage = {
  modelID?: string;
  providerID?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
};

/**
 * One turn's usage = the SUM over every assistant message the turn produced.
 *
 * Undercount fix (2026-08-25): the result event used to carry only the LAST
 * assistant message's usage while `steps` counted them all, so a multi-step
 * turn was billed as its final response — live `turn_usage` had opencode at
 * 8.2 steps/turn but 104 output tokens/turn against Claude's 2,597.
 *
 * Per-message values are per-response, NOT cumulative. Verified against
 * OpenCode's own store (`opencode.db` in the container's XDG data dir): the
 * `session` row's tokens_input / tokens_output / tokens_cache_read equal the
 * SUM over that session's assistant messages exactly (325,382 / 7,477 /
 * 1,927,040 across 19 messages), while the last message alone reports
 * 1,507 / 303 / 142,912. Per-message output is also non-monotonic
 * (22, 25, 70, 85, 50, ... 1,186), which a running total could not be.
 *
 * `model` comes from the LAST message — that is the turn's own model, and a
 * sum has no single one. `undefined` for an empty set, so a turn that
 * produced no assistant message records a coverage-gap row rather than a
 * fabricated zero.
 */
export function sumOpenCodeTurnUsage(
  messages: OpenCodeAssistantUsage[],
  last: OpenCodeAssistantUsage | undefined,
): TurnUsageInfo | undefined {
  if (messages.length === 0) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  for (const m of messages) {
    inputTokens += m.tokens?.input ?? 0;
    outputTokens += m.tokens?.output ?? 0;
    cacheReadTokens += m.tokens?.cache?.read ?? 0;
    cacheWriteTokens += m.tokens?.cache?.write ?? 0;
    costUsd += typeof m.cost === 'number' ? m.cost : 0;
  }
  return {
    model: last?.providerID && last.modelID ? `${last.providerID}/${last.modelID}` : (last?.modelID ?? null),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
  };
}

/**
 * True when the mounted OAuth auth.json carries a credential for `provider`.
 * In that case the SDK resolves the token natively (XDG_DATA_HOME) and we must
 * NOT inject the `apiKey: 'placeholder'` override — that would clobber the real
 * OAuth token and break auth.
 *
 * Covers BOTH opencode OAuth keys that live in the same auth.json — `opencode`
 * (Zen, /zen/v1) and `opencode-go` (Go subscription, /zen/go/v1) — plus any
 * other provider whose cred is present (e.g. `nvidia`). Static OneCLI-proxied
 * API-key providers (deepseek/openrouter/zen-via-paste-key) are absent from
 * auth.json, so they correctly fall through to the placeholder path.
 *
 * The previous check hardcoded `provider === 'opencode'`, so `opencode-go`
 * (whose cred IS in the mounted auth.json) wrongly got the placeholder and
 * every Go-subscription sibling failed with "Invalid API key" / "Model not
 * found".
 */
function opencodeAuthHasCredential(provider: string): boolean {
  return opencodeAuthProviders().includes(provider);
}

/**
 * Every provider with a credential in the mounted auth.json (e.g.
 * `opencode-go`, `opencode` (Zen), `nvidia`). We enable ALL of them in the
 * session config so the agent can switch to any go/zen/nvidia model per-prompt
 * within one session (see buildOpenCodeConfig) — not just the one provider its
 * default model belongs to. Static for the container lifetime (auth.json is
 * copied once at spawn), so it doesn't churn the shared-runtime config key.
 */
// Memoized at module scope: auth.json is copied once at spawn and never written
// from inside the container, so the provider set is fixed for the container
// lifetime. Without this the file was read + JSON-parsed 1-3× per turn on the
// hot path (runtimeConfigKey, buildOpenCodeConfig, and opencodeAuthHasCredential
// all call this).
let cachedAuthProviders: string[] | null = null;

/**
 * Match OpenCode 1.18.23's Auth.Info union before trusting an auth.json key.
 *
 * The CLI filters invalid records during its own auth load. NanoClaw must do
 * the same before deciding to bypass OneCLI or omit the placeholder API key;
 * treating a merely object-shaped record as native auth sends malformed creds
 * down the direct path and turns a startup guard into a late request failure.
 */
function isOpenCodeAuthRecord(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // OpenCode 1.18.23 uses Schema.String without trimming. Keep whitespace
  // semantics compatible while refusing zero-length credentials that cannot authenticate.
  const isNonEmptyString = (credential: unknown): credential is string =>
    typeof credential === 'string' && credential.length > 0;
  const isStringRecord = (metadata: unknown): metadata is Record<string, string> =>
    metadata !== null &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    Object.values(metadata).every((item) => typeof item === 'string');

  if (record.type === 'oauth') {
    return (
      isNonEmptyString(record.access) &&
      isNonEmptyString(record.refresh) &&
      Number.isInteger(record.expires) &&
      (record.expires as number) >= 0 &&
      (record.accountId === undefined || typeof record.accountId === 'string') &&
      (record.enterpriseUrl === undefined || typeof record.enterpriseUrl === 'string')
    );
  }
  if (record.type === 'api') {
    return isNonEmptyString(record.key) && (record.metadata === undefined || isStringRecord(record.metadata));
  }
  return record.type === 'wellknown' && isNonEmptyString(record.key) && isNonEmptyString(record.token);
}

export function parseOpenCodeAuthProviders(raw: string): string[] {
  try {
    const auth = JSON.parse(raw) as unknown;
    return auth && typeof auth === 'object' && !Array.isArray(auth)
      ? Object.entries(auth)
          .filter(([, record]) => isOpenCodeAuthRecord(record))
          .map(([provider]) => provider)
      : [];
  } catch {
    return [];
  }
}

function opencodeAuthProviders(): string[] {
  if (cachedAuthProviders !== null) return cachedAuthProviders;
  try {
    const raw = fs.readFileSync('/opencode-xdg/opencode/auth.json', 'utf-8');
    cachedAuthProviders = parseOpenCodeAuthProviders(raw);
  } catch {
    // Missing file or unparseable → no native creds.
    cachedAuthProviders = [];
  }
  return cachedAuthProviders;
}

/** Reset the immutable auth-file cache between hermetic unit-test cases. */
export function _resetOpenCodeAuthCacheForTesting(): void {
  cachedAuthProviders = null;
}

export function _setOpenCodeAuthProvidersForTesting(providers: string[]): void {
  cachedAuthProviders = [...providers];
}

/** Split a `<provider>/<id…>` slug into the SDK's per-prompt model shape. */
function splitModelSlug(slug: string): { providerID: string; modelID: string } | null {
  const i = slug.indexOf('/');
  if (i <= 0 || i >= slug.length - 1) return null;
  return { providerID: slug.slice(0, i), modelID: slug.slice(i + 1) };
}

/** Per-turn model/effort overrides flowing in from QueryInput (the `-m`/`-e` flags). */
interface OpenCodeTurnOverrides {
  model?: string;
  effort?: string;
}

/** Native OpenCode subscriptions must bypass OneCLI only for an exact auth match. */
export function shouldBypassOpenCodeProxy(model: string | undefined, authProviders: readonly string[]): boolean {
  const provider = model ? splitModelSlug(model)?.providerID : undefined;
  return (provider === 'opencode' || provider === 'opencode-go') && authProviders.includes(provider);
}

function mergeNoProxy(current: string | undefined, addition: string): string {
  const parts = new Set(
    (current ?? '')
      .split(/[\s,]+/)
      .map((part) => part.trim())
      .filter(Boolean),
  );
  parts.add(addition);
  return [...parts].join(',');
}

const SESSION_STATUS_RETRY_ERROR_AFTER = 3;

/** Stale / dead OpenCode session heuristics (complement Claude-centric host patterns). */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|NotFoundError|connection reset|ECONNRESET|404|event timeout/i;

/**
 * Build the env handed to the `opencode serve` child, stripping the auth secrets
 * named by buildSecretEnvVarList() (the SINGLE SOURCE shared with the Claude
 * provider — see secret-env.ts). OpenCode authenticates via auth.json / XDG
 * (opencodeAuthProviders reads /opencode-xdg/opencode/auth.json), NOT
 * process.env, so removing these is safe and never breaks model auth.
 *
 * This INTENTIONALLY includes ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN
 * (codex #126 F3). An `anthropic/*` OpenCode model must authenticate via
 * auth.json like every other provider — NOT via the host's Anthropic creds
 * leaking through process.env. Forwarding the host's Claude-subscription OAuth
 * token to OpenCode's model traffic is exactly the leak this strip prevents
 * (and OpenCode 1.3+ can't use that subscription token anyway).
 *
 * The Claude provider unsets the same vars per-Bash-command (createSanitizeBashHook).
 * OpenCode has no equivalent per-tool hook on its bash path, so we strip once at
 * the server level — broader than Claude's per-command unset, but the outcome is
 * identical: every shell subprocess opencode spawns (bash tool, MCP stdio
 * children) inherits a secret-free env. We keep OPENCODE_CONFIG_CONTENT and all
 * non-secret vars (PATH, HOME, NANOCLAW_*, OPENCODE_*) intact.
 *
 * Pure + exported so it can be unit-tested without actually spawning a process.
 */
export function buildOpencodeServerEnv(baseEnv: NodeJS.ProcessEnv, config: Record<string, unknown>): NodeJS.ProcessEnv {
  // Strip the env-derived auth list PLUS the MCP/header-only secrets Claude also
  // strips (filterSdkEnv) — env-hygiene parity so opencode's bash/MCP children
  // can't printenv Exa/Braintrust/Granola. Data-tool secrets (SNOWFLAKE_PASSWORD,
  // DBT_*, OPENAI_API_KEY, …) are deliberately KEPT, matching Claude. (codex #126)
  const secretVars = new Set([...buildSecretEnvVarList(), ...MCP_HEADER_ONLY_SECRET_VARS]);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (secretVars.has(k)) continue;
    env[k] = v;
  }
  const model = typeof config.model === 'string' ? config.model : baseEnv.OPENCODE_MODEL;
  if (shouldBypassOpenCodeProxy(model, opencodeAuthProviders())) {
    env.NO_PROXY = mergeNoProxy(env.NO_PROXY, 'opencode.ai');
    env.no_proxy = mergeNoProxy(env.no_proxy, 'opencode.ai');
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  return env;
}

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
    // /workspace/agent. Without this the child would just inherit the
    // Dockerfile WORKDIR rather than the session's mounted workspace — Claude
    // provider already passes input.cwd; this brings OpenCode to parity.
    // Caller falls back to process.cwd() if input.cwd was undefined.
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      // Auth secrets (ANTHROPIC_API_KEY*, CLAUDE_CODE_OAUTH_TOKEN*, GMAIL_*) are
      // stripped from the child env here — OpenCode auths via auth.json/XDG, not
      // process.env, so they're never needed and an unguarded `bash` tool would
      // otherwise be able to printenv them. See buildOpencodeServerEnv.
      env: buildOpencodeServerEnv(process.env, config),
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

// AGENTS.md/CLAUDE.md instructions no longer get pushed onto the prompt here.
// `opencode serve` is spawned with cwd=/workspace/agent (see
// spawnOpencodeServer) and OpenCode natively auto-loads AGENTS.md/CLAUDE.md
// from its cwd into every session — verified empirically against 1.18.9 serve
// mode (a sentinel placed only in the cwd's AGENTS.md was answered with zero
// prompt wrapping). The removed `readAgentInstructionsForPrompt` (formerly
// called from here) sent the same AGENTS.md content a SECOND time on every
// turn, plus a `/workspace/global` half that was already dead:
// `groups/global/` was deleted by the v2 migration (migrateGroupsToClaudeLocal),
// so that mount never fires and every group's own AGENTS.md already carries
// the shared base + CLAUDE.local.md via composeGroupClaudeMd. No reach
// regression — just dedup, same shape as the Codex per-turn duplication fix.
// `systemInstructions` below is unrelated dynamic per-turn content (tone
// profile, capability note, live destinations addendum — built in index.ts,
// never present in AGENTS.md) with no other delivery path into OpenCode, so
// that wrap stays.
function wrapPromptWithContext(text: string, systemInstructions?: string, currentModel?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  // Tell the agent which model it is ACTUALLY running on this turn. OpenCode
  // doesn't surface this to the model, so without it the agent guesses its own
  // identity and gets it wrong after a `-m`/change_model switch (reporting the
  // old model and making the switch look like it failed). Outermost block so
  // it's prominent. `currentModel` is the effective per-turn slug.
  if (currentModel) {
    out =
      `<system>\nYou are currently running on model \`${currentModel}\`. ` +
      `If asked which model or provider you are, answer with exactly this — do not guess from earlier context.\n</system>\n\n${out}`;
  }
  return out;
}

/**
 * Normalize a raw effort string to an opencode reasoning_effort level.
 * `reasoning_effort` is sent alone — the `thinking.budgetTokens` field is
 * Anthropic-specific and 400s on non-Anthropic upstreams. OpenCode's own
 * levels are `low | medium | high | max`; `max` is passed through (it's a real
 * variant some models support, e.g. DeepSeek V4 — a model that doesn't support
 * it will 400 loudly rather than us silently downgrading and making `max`
 * unreachable). `xhigh` (an OpenAI/codex term, not an opencode level) and
 * `minimal` map to the nearest opencode level. Unset / 'default' → null (inject
 * nothing; most thinking-capable models already run their highest by default).
 * The host flag-parser (OPENCODE_VOCAB) restricts `-e` to low|medium|high|max;
 * this is the second line of defense for the env/DB path.
 */
function clampOpenCodeEffort(raw: string | undefined): string | null {
  const effortClampMap: Record<string, string> = {
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'high',
    max: 'max',
  };
  return effortClampMap[(raw || '').trim().toLowerCase()] || null;
}

export function buildOpenCodeConfig(
  options: ProviderOptions,
  turn: OpenCodeTurnOverrides = {},
): Record<string, unknown> {
  // EFFECTIVE model = per-turn `-m` override → env default (host sets
  // OPENCODE_MODEL from the DB default; see src/providers/opencode.ts). It is
  // also passed PER-PROMPT via body.model in query(), so a model switch with NO
  // effort active needs no respawn (runtimeConfigKey omits the model then).
  // Effort is per-model `options` in the opencode config (no per-prompt effort
  // field exists), so it is registered HERE against the effective model — and
  // runtimeConfigKey includes the effective model whenever effort is active, so
  // a `-m`+`-e` switch rebuilds the runtime and the effort follows the chosen
  // model (otherwise the override model would run at its native effort while the
  // router had already acknowledged the requested effort).
  const model = turn.model ?? process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;
  const defaultSplit = model ? splitModelSlug(model) : null;
  const provider = defaultSplit?.providerID ?? process.env.OPENCODE_PROVIDER ?? 'anthropic';

  // Enable EVERY credentialed provider so the agent can `-m`-switch to any
  // go/zen/nvidia model within one session (per-prompt body.model resolves
  // against enabled_providers). Falls back to the single default provider when
  // auth.json is absent (e.g. OneCLI-proxy static-key groups).
  const authProviders = opencodeAuthProviders();
  if (provider === 'anthropic' && !authProviders.includes('anthropic')) {
    throw new Error(
      `OpenCode model ${model ?? '<unset>'} requires a valid top-level anthropic record in ` +
        `/opencode-xdg/opencode/auth.json; environment credentials are intentionally unavailable.`,
    );
  }
  const enabledProviders =
    authProviders.length > 0
      ? Array.from(new Set([...authProviders, ...(provider !== 'anthropic' ? [provider] : [])]))
      : [provider];

  const effortValue = clampOpenCodeEffort(turn.effort ?? process.env.OPENCODE_EFFORT);
  const modelOptions = effortValue ? { reasoningEffort: effortValue } : null;

  // Register the EFFECTIVE model (default or `-m` override) under its provider
  // with tool_call forced on + the resolved effort, so effort follows the model
  // actually in use. body.model (query()) sends this same model per-prompt, so
  // the registered options apply to it. A model switch while effort is active
  // rebuilds the runtime (runtimeConfigKey), re-registering effort on the new
  // model; with no effort active nothing is registered and the switch is
  // respawn-free.
  const defaultModelId = defaultSplit?.modelID;
  const smallModelId = smallModel ? (splitModelSlug(smallModel)?.modelID ?? smallModel) : undefined;
  const modelsToRegister = [defaultModelId, smallModelId]
    .filter((mid): mid is string => Boolean(mid))
    .filter((mid, i, a) => a.indexOf(mid) === i);
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
                ...(mid === defaultModelId && modelOptions ? { options: modelOptions } : {}),
              },
            ]),
          ),
        }
      : {};

  // apiKey placeholder is only for the OneCLI-proxy path (default provider NOT
  // in auth.json — deepseek/openrouter/zen-via-paste-key). When the cred is in
  // auth.json the SDK reads it natively and the placeholder would clobber the
  // real Bearer token. baseURL is NOT set: opencode's provider registry routes
  // by the auth.json cred-key + model prefix (opencode-go → /zen/go/v1,
  // opencode → /zen/v1, nvidia → NVIDIA), so no manual override is needed.
  const sdkOptions: Record<string, unknown> = {};
  // Anthropic credentials must never be synthesized here: the host strips its
  // Claude subscription secrets from the OpenCode child. The per-model block
  // is independent, though — it carries the effective model's effort options.
  if (provider !== 'anthropic' && !opencodeAuthHasCredential(provider)) sdkOptions.apiKey = 'placeholder';

  const providerConfig = {
    ...(Object.keys(sdkOptions).length > 0 ? { options: sdkOptions } : {}),
    ...modelsBlock,
  };
  const providerOptions: Record<string, unknown> =
    Object.keys(providerConfig).length > 0 ? { [provider]: providerConfig } : {};

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  // NanoClaw guard plugins: the in-tree managed-Git maintenance boundary plus
  // the Bootstrap destructive-action gate, at parity with the
  // Claude Code `block-destructive` hook via a shared decision core. OpenCode
  // auto-approves every tool call
  // (`permission: 'allow'` + permission auto-reply), so this plugin's
  // `tool.execute.before` throw is the ONLY guardrail standing between the agent
  // and a destructive command. The plugin is mounted read-only from the
  // bootstrap plugin at /workspace/plugins/bootstrap.
  //
  // FAIL-CLOSED: if the plugin is absent (e.g. a group excludes the bootstrap
  // plugin), we REFUSE to build a config — returning one with `permission:
  // 'allow'` but no guard would run an unguarded prod agent with auto-approve on
  // every tool call. Throwing aborts the spawn; the sweep retries, and the
  // operator sees the failure rather than a silently-unguarded agent. The old
  // behavior here was warn-and-continue, which is exactly the silent gap this
  // closes. Set OPENCODE_ALLOW_UNGUARDED=1 to opt out (dev-only escape hatch,
  // default-closed) — e.g. local experimentation without the bootstrap mount.
  const GUARD_PLUGIN = '/workspace/plugins/bootstrap/plugins/workflow/hooks/guards/opencode-guard.ts';
  const guardAvailable = fs.existsSync(GUARD_PLUGIN);
  const allowUnguarded = process.env.OPENCODE_ALLOW_UNGUARDED === '1';
  if (!guardAvailable && !allowUnguarded) {
    throw new Error(
      `OpenCode destructive-action guard plugin not found at ${GUARD_PLUGIN} — refusing to spawn an unguarded agent ` +
        `(permission:'allow' auto-approves every tool call). Mount the bootstrap plugin, or set ` +
        `OPENCODE_ALLOW_UNGUARDED=1 to override (dev-only).`,
    );
  }
  if (!guardAvailable && allowUnguarded) {
    log(
      `WARNING: guard plugin absent at ${GUARD_PLUGIN} but OPENCODE_ALLOW_UNGUARDED=1 — ` +
        `running opencode WITHOUT the destructive-action gate (explicit opt-out)`,
    );
  }

  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: enabledProviders,
    permission: 'allow',
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    mcp,
    // Both entries are unconditional. The first-party managed-Git guard lives
    // in the read-only /app/src mount and has no opt-out; MCP and host Git
    // operations bypass it because they execute outside the agent bash tool.
    // The fail-closed check above owns Bootstrap guard availability. In the
    // explicit opt-out + absent case OpenCode ignores only that missing second
    // path while the managed-Git guard remains active.
    plugin: [MANAGED_GIT_OPENCODE_PLUGIN_PATH, GUARD_PLUGIN],
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

export function runtimeConfigKey(
  options: ProviderOptions,
  cwd: string | undefined,
  turn: OpenCodeTurnOverrides,
): string {
  const effort = turn.effort ?? process.env.OPENCODE_EFFORT;
  const effectiveModel = turn.model ?? process.env.OPENCODE_MODEL;
  const authProviders = opencodeAuthProviders();
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    providers: authProviders,
    // A direct-native route changes the child process environment. Crossings
    // must respawn; model switches that stay on the same route must not.
    nativeDirect: shouldBypassOpenCodeProxy(effectiveModel, authProviders),
    // Per-turn `-e` IS in the key: effort lives in the server config, so
    // changing it rebuilds the runtime. A respawn that can't resume the prior
    // session self-heals via the poll-loop's stale-session recap path.
    effort,
    // The `-m` model is normally applied per-prompt (body.model) with NO respawn
    // (continuity preserved). The ONE exception: when effort is active it is
    // registered ON the effective model (buildOpenCodeConfig), so a model switch
    // must rebuild to move the effort onto the new model. Include the model in
    // the key only then — otherwise effort-less switches stay respawn-free.
    effortModel: clampOpenCodeEffort(effort) ? effectiveModel : null,
    cwd: cwd ?? null,
  });
}

async function ensureSharedRuntime(
  options: ProviderOptions,
  cwd: string | undefined,
  turn: OpenCodeTurnOverrides,
): Promise<SharedRuntime> {
  const key = runtimeConfigKey(options, cwd, turn);
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  sharedInit = (async () => {
    // Tracks the spawned `opencode serve` child until sharedRuntime takes
    // ownership. If init throws AFTER spawnOpencodeServer returns a LIVE proc but
    // BEFORE the sharedRuntime assignment (e.g. client.event.subscribe() rejects),
    // destroySharedRuntime() can't see this proc — so the finally kills it here.
    // Without this, every retry leaks another orphaned server process. (codex #126
    // F5 follow-up)
    let orphanProc: ChildProcess | undefined;
    try {
      if (sharedRuntime) {
        destroySharedRuntime();
      }
      const config = buildOpenCodeConfig(options, turn);
      const { url, proc } = await spawnOpencodeServer(config, cwd);
      orphanProc = proc;
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
      orphanProc = undefined; // ownership transferred to sharedRuntime
      return sharedRuntime;
    } finally {
      // Kill a spawned-but-unowned server before clearing the in-flight promise.
      // On the success path orphanProc was reset to undefined above; it is set
      // here only if init threw between spawn and the sharedRuntime assignment.
      if (orphanProc) {
        try {
          orphanProc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
      // Clear the in-flight promise on BOTH success and failure. On success the
      // result is cached in sharedRuntime (line 450 short-circuits next time); on
      // failure (e.g. buildOpenCodeConfig throws because the guard plugin isn't
      // mounted yet, or before OPENCODE_ALLOW_UNGUARDED is set) clearing lets a
      // later turn RE-RUN init instead of replaying the cached rejection forever.
      // The poll loop survives per-turn errors, so without this the container is
      // stuck unguarded-broken for its whole life. (codex #126 F5)
      sharedInit = null;
    }
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
  private memorySessionHook?: MemorySessionHookRegistration;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    this.memorySessionHook = hook;
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('OpenCode memory session hook was not registered');
    if (input.continuation) {
      this.activeSessionId = input.continuation;
    } else {
      this.activeSessionId = undefined;
    }

    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    // Per-turn `-m`/`-e` (resolved by the poll-loop from sticky + turn flags).
    // `effort` rebuilds the runtime config (it lives server-side); `model` is
    // applied per-prompt via body.model below so a switch needs no respawn and
    // keeps session continuity. The effective model = turn override → env
    // default (host sets OPENCODE_MODEL from the DB default). effectiveModel is
    // also injected into the prompt (wrapPromptWithContext) so the agent knows
    // which model it's actually on.
    const turn: OpenCodeTurnOverrides = { model: input.model, effort: input.effort };
    const effectiveModel = input.model ?? process.env.OPENCODE_MODEL;
    const promptModel = effectiveModel ? splitModelSlug(effectiveModel) : null;

    // OpenCode has no session-start hook API. Its native prompt lifecycle
    // carries trusted static memory handling/write guidance on every prompt;
    // canonical bytes arrive per turn only in paired untrusted recall.
    const memoryContext = memoryContextForSessionStart('startup');
    const systemInstructions = [input.systemContext?.instructions, memoryContext].filter(Boolean).join('\n\n');
    pending.push(wrapPromptWithContext(input.prompt, systemInstructions, effectiveModel));

    const kick = (): void => {
      waiting?.();
    };

    const self = this;
    const queryCwd = input.cwd;
    const IDLE_TIMEOUT_MS = 90_000;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      const rt = await ensureSharedRuntime(self.options, queryCwd, turn);
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
          // body.model carries the per-turn `-m` model (provider/id split). When
          // unset (no override + no env default) opencode uses the session/server
          // default. Switching models mid-session is just a different body.model
          // on the next prompt — no server respawn.
          body: { parts: [{ type: 'text', text }], ...(promptModel ? { model: promptModel } : {}) },
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
        // Fleet Hardening Phase 0.1 (see TurnUsageInfo). One AssistantMessage
        // = one LLM response, and its tokens/cost are ITS OWN, not a running
        // total across the turn's messages. `message.updated` fires
        // repeatedly as a single message streams, so the last write for a
        // given id wins and is that message's final figure by the time
        // session.idle ends the turn — but the turn's usage is the SUM over
        // every id in this map, which is what the result event reports.
        const assistantUsageById = new Map<string, OpenCodeAssistantUsage>();
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
                const info = ev.properties.info as
                  | {
                      id?: string;
                      role?: string;
                      modelID?: string;
                      providerID?: string;
                      cost?: number;
                      tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
                    }
                  | undefined;
                if (info?.id && info?.role) {
                  roleByMessageId.set(info.id, info.role);
                  if (info.role === 'assistant') assistantUsageById.set(info.id, info);
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
        // Empty-turn fallback: the turn completed (session.idle, no error) but
        // produced no text — the model emitted only reasoning/whitespace. Without
        // this the poll-loop delivers nothing and the user sees silence (observed
        // with free-tier nvidia models degenerating). Surface a visible, actionable
        // message instead of dead air.
        if (!resultText.trim()) {
          const m = effectiveModel ?? 'the current model';
          const warningText =
            `⚠️ \`${m}\` returned an empty response this turn (no text generated). ` +
            `Some models/providers do this under load — try again, or switch with \`-m <provider/model>\`.`;
          log(`Empty assistant response (model=${m}) — surfacing fallback instead of silent no-reply`);
          // Dedupe the CHANNEL POST only — the log line above always fires.
          // A flapping model can hit this every turn; without the gate the
          // same verbatim warning spams the channel repeatedly (observed 3x
          // in one night). Suppressed repeats leave resultText empty, which
          // poll-loop's dispatch treats as a quiet no-text turn.
          if (shouldPostInfraWarning(warningText)) {
            resultText = warningText;
          }
        }
        // Per-turn cost attribution (Fleet Hardening Phase 0.1 follow-up):
        // OpenCode's SSE stream has no round-trip counter either. Each
        // distinct assistant message id is one LLM response (a tool call
        // triggers a fresh assistant message for the follow-up), so counting
        // them is the closest available proxy — not a literal HTTP request
        // count, but the best signal this protocol exposes.
        //
        // Counted off assistantUsageById, the SAME map the usage sum below
        // reads, so the two can never disagree — steps=N and a sum over some
        // other N' messages is exactly the inconsistency this whole fix is
        // about. (It's populated under the identical `role === 'assistant'`
        // condition as roleByMessageId, so this is the same number, sourced
        // where it can't drift.)
        const stepCount = assistantUsageById.size;
        // Summed over that same per-turn map — see sumOpenCodeTurnUsage for
        // why (and for the evidence that these are per-response, not
        // cumulative). Subagent responses are included in both, since those
        // are real spend.
        yield {
          type: 'result',
          text: resultText,
          steps: stepCount > 0 ? stepCount : null,
          usage: sumOpenCodeTurnUsage(
            [...assistantUsageById.values()],
            lastAssistantMessageId ? assistantUsageById.get(lastAssistantMessageId) : undefined,
          ),
        };
      }
    }

    return {
      push: (message: string) => {
        pending.push(wrapPromptWithContext(message, systemInstructions, effectiveModel));
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
