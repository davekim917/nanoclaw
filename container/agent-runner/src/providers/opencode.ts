import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import { memoryContextForSessionStart, type MemorySessionHookRegistration } from '../memory/session-hook.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';
import { buildSecretEnvVarList, MCP_HEADER_ONLY_SECRET_VARS } from './secret-env.js';
import { shouldPostInfraWarning } from '../db/session-state.js';
import { MANAGED_GIT_OPENCODE_PLUGIN_PATH } from '../managed-git-guard.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
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
function opencodeAuthProviders(): string[] {
  if (cachedAuthProviders !== null) return cachedAuthProviders;
  try {
    const raw = fs.readFileSync('/opencode-xdg/opencode/auth.json', 'utf-8');
    const auth = JSON.parse(raw) as Record<string, unknown>;
    cachedAuthProviders = auth && typeof auth === 'object' ? Object.keys(auth) : [];
  } catch {
    // Missing file or unparseable → no native creds.
    cachedAuthProviders = [];
  }
  return cachedAuthProviders;
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
    // /workspace/agent. Without this, the child inherits the Dockerfile WORKDIR
    // (/workspace/group), which is empty in our layout — Claude provider already
    // passes input.cwd; this brings OpenCode to parity. Caller falls back to
    // process.cwd() if input.cwd was undefined.
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
  if (!opencodeAuthHasCredential(provider)) sdkOptions.apiKey = 'placeholder';

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

function runtimeConfigKey(options: ProviderOptions, cwd: string | undefined, turn: OpenCodeTurnOverrides): string {
  const effort = turn.effort ?? process.env.OPENCODE_EFFORT;
  const effectiveModel = turn.model ?? process.env.OPENCODE_MODEL;
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    providers: opencodeAuthProviders(),
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
        // Fleet Hardening Phase 0.1 (see TurnUsageInfo). AssistantMessage
        // carries cumulative cost/tokens as of that update; message.updated
        // fires repeatedly as the message streams, so the last write for a
        // given id wins and is the final total by the time session.idle ends
        // the turn.
        const assistantUsageById = new Map<
          string,
          {
            modelID?: string;
            providerID?: string;
            cost?: number;
            tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
          }
        >();
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
        const assistantUsage = lastAssistantMessageId ? assistantUsageById.get(lastAssistantMessageId) : undefined;
        yield {
          type: 'result',
          text: resultText,
          usage: assistantUsage
            ? {
                model:
                  assistantUsage.providerID && assistantUsage.modelID
                    ? `${assistantUsage.providerID}/${assistantUsage.modelID}`
                    : (assistantUsage.modelID ?? null),
                inputTokens: assistantUsage.tokens?.input ?? null,
                outputTokens: assistantUsage.tokens?.output ?? null,
                cacheReadTokens: assistantUsage.tokens?.cache?.read ?? null,
                cacheWriteTokens: assistantUsage.tokens?.cache?.write ?? null,
                costUsd: typeof assistantUsage.cost === 'number' ? assistantUsage.cost : null,
              }
            : undefined,
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
