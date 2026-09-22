import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { pathToFileURL } from 'url';

import { createOpencodeClient, type FilePartInput, type OpencodeClient } from '@opencode-ai/sdk';
// The root client carries no `.question` surface in 1.18.23 (verified against
// the installed `dist/gen/sdk.gen.d.ts`: no Question class at all). list/reply/
// reject for the interactive `question` tool exist only on the `/v2` subpath
// client, which talks to the SAME server on plain `/question` routes. Imported
// separately so the session/event client above is untouched.
import { createOpencodeClient as createOpencodeQuestionClient } from '@opencode-ai/sdk/v2';

import { memoryContextForSessionStart, type MemorySessionHookRegistration } from '../memory/session-hook.js';
import { appendActiveRuntimeContext } from '../runtime-context.js';
import { recordContextTokens } from '../turn-status.js';

/**
 * Tokens occupying the context window, from one assistant message's `tokens`.
 *
 * OPENCODE FOLLOWS ANTHROPIC'S CONVENTION, NOT OPENAI'S — `input` and
 * `cache.read` are DISJOINT, so occupancy is their sum plus any cache write.
 * The measurement in `sumOpenCodeTurnUsage`'s header settles it rather than
 * leaving it to inference: over one real session the per-message `input`
 * summed to 325,382 while `cache.read` summed to 1,927,040, which is
 * impossible if the cached figure were a subset of the input one.
 *
 * Contrast providers/codex.ts, where cached input IS a subset and this same
 * sum would double-count the cached prefix.
 *
 * Returns 0 when there is nothing usable, which `recordContextTokens` ignores
 * — a message with no token report leaves the previous reading standing
 * rather than zeroing the display.
 */
export function openCodeContextOccupancy(
  tokens: { input?: number; output?: number; cache?: { read?: number; write?: number } } | undefined,
): number {
  if (!tokens) return 0;
  const count = (value: number | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return count(tokens.input) + count(tokens.cache?.read) + count(tokens.cache?.write);
}
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  ProviderEvent,
  ProviderOptions,
  PromptAttachment,
  QueryInput,
  TurnUsageInfo,
} from './types.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';
import { attachTurnEffort } from './turn-effort.js';
import { MCP_HEADER_ONLY_SECRET_VARS } from './secret-env.js';
import { shouldPostInfraWarning } from '../modules/mailbox/index.js';
import { MANAGED_GIT_OPENCODE_PLUGIN_PATH } from '../managed-git-guard.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

/**
 * Extension → MIME fallback, for adapters that report no `mimeType`. The audio
 * and video entries mirror the host's own `TYPE_TO_EXT` mapping, which is what
 * names a Telegram voice note `.ogg` and an animation `.mp4` in the first place.
 */
const ATTACHMENT_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/**
 * Which media a turn may hand over as a file part.
 *
 * Images and PDFs are unconditional — the long-standing behavior and the
 * channels' common case. Audio and video ride the SAME declaration that opens
 * OpenCode's own gate for them, resolved through `resolveModelCapabilities` so
 * this and the config writer cannot disagree about whether the declarations
 * apply to the model actually running.
 *
 * Closed by default: the env var is unset unless an operator sets it, and an
 * undeclared modality is one OpenCode substitutes a "does not support
 * <modality> input" error for anyway, so forwarding it would only inflate the
 * request.
 */
export function forwardableAttachmentMime(
  mime: string,
  effectiveModel?: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (mime.startsWith('image/') || mime === 'application/pdf') return true;
  const declared = resolveModelCapabilities(effectiveModel, env).modalities?.input ?? [];
  if (mime.startsWith('audio/')) return declared.includes('audio');
  if (mime.startsWith('video/')) return declared.includes('video');
  return false;
}

/**
 * `PromptAttachment` declares string fields and `extractAttachments` normalizes
 * them, but this function is exported and structurally typed, so the `typeof`
 * guards are the second half of that contract rather than a duplicate of it: a
 * caller that hands over a channel-supplied object directly gets the
 * extension fallback instead of a TypeError that would abort the whole query.
 */
function attachmentMime(att: PromptAttachment): string | undefined {
  if (typeof att.mime === 'string' && att.mime) return att.mime;
  const name = (typeof att.path === 'string' ? att.path : '') || (typeof att.filename === 'string' ? att.filename : '');
  const dot = name.lastIndexOf('.');
  return dot < 0 ? undefined : ATTACHMENT_MIME_BY_EXT[name.slice(dot).toLowerCase()];
}

/**
 * Turn a turn's attachments into OpenCode file parts, so the model sees the
 * media itself rather than only the `[image: cat.png — saved to …]` line the
 * formatter already renders into the prompt text.
 *
 * The URL is a `file://` path, NOT a data: URI, deliberately: OpenCode resolves
 * a file: part server-side, reading the file and re-emitting it as a base64
 * data URI for any mime that is neither text/plain nor a directory. The server
 * shares this container's filesystem, so base64-ing here would only duplicate
 * that work and inflate the request body.
 *
 * What may be forwarded is `forwardableAttachmentMime`: images and PDFs always,
 * audio and video when the group declared those modalities. PDFs go through
 * even though a given backend may reject them, since the alternative is
 * silently withholding a document the user did send. Anything skipped is still
 * described in the prompt text, so it is never lost — just not handed over as
 * media.
 *
 * NOTE: a model OpenCode's registry does not know declares no input modalities,
 * and OpenCode then drops every non-text part it is handed. Declaring
 * OPENCODE_MODEL_INPUT_MODALITIES is what opens that gate — see
 * resolveModelModalities.
 *
 * `exists` is injectable so tests can drive resolvability without touching disk.
 */
export function buildAttachmentFileParts(
  attachments: PromptAttachment[] | undefined,
  opts: { effectiveModel?: string; env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean } = {},
): FilePartInput[] {
  const exists = opts.exists ?? fs.existsSync;
  const parts: FilePartInput[] = [];
  for (const att of attachments ?? []) {
    const mime = attachmentMime(att);
    if (!mime) continue;
    if (!forwardableAttachmentMime(mime, opts.effectiveModel, opts.env)) continue;
    if (typeof att.path !== 'string' || !att.path || !exists(att.path)) {
      const label =
        (typeof att.filename === 'string' && att.filename) ||
        (typeof att.path === 'string' && att.path) ||
        (typeof att.url === 'string' && att.url) ||
        'unnamed';
      log(`Attachment has no readable local file, not sent as media: ${label}`);
      continue;
    }
    parts.push({
      type: 'file',
      mime,
      filename: typeof att.filename === 'string' ? att.filename : undefined,
      url: pathToFileURL(att.path).href,
    });
  }
  return parts;
}

/**
 * The prompt body for one turn: the text the formatter produced, plus any media
 * that came with it. Both the opening prompt and every follow-up push go
 * through here — OpenCode holds one query open per session, so in practice most
 * real messages arrive as pushes, and media has to travel on that path too.
 */
export function buildPromptParts(
  text: string,
  attachments?: PromptAttachment[],
  opts: { effectiveModel?: string; env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean } = {},
): Array<{ type: 'text'; text: string } | FilePartInput> {
  return [{ type: 'text', text }, ...buildAttachmentFileParts(attachments, opts)];
}

/**
 * Every permission category OpenCode 1.18.x knows about, read off the CLI's own
 * built-in documentation ("Known permission keys: read, edit, glob, grep, list,
 * bash, task, external_directory, todowrite, question, webfetch, websearch,
 * lsp, doom_loop, skill"), all set to `allow` EXCEPT `question`.
 *
 * The provider used to emit the top-level string shorthand `permission: 'allow'`.
 * That leaves `question` — OpenCode's built-in interactive multi-choice tool —
 * to whatever OpenCode's own default/config merge resolves it to, and upstream
 * observed that resolution land on BOTH `question -> deny *` and
 * `question -> allow *` for one session. Whichever rule wins last, `allow`
 * sometimes does, and a headless container has nobody to answer an interactive
 * question: the tool call never returns and the session is wedged forever.
 * Enumerating the categories makes `question` a single deterministic `deny`
 * that cannot contradict itself.
 *
 * GUARD PARITY IS UNCHANGED. Every other category keeps the exact
 * "allow everything" behavior the string shorthand produced, so the
 * fail-closed destructive-action plugin below is still the ONLY thing standing
 * between the agent and a destructive command — the same contract, the same
 * classifier, the same `tool.execute.before` throw.
 *
 * The list deliberately omits a category OpenCode does not document (upstream's
 * `codesearch`, absent from 1.18.x's key list). Verified live against 1.18.18:
 * an unknown KEY is tolerated rather than rejected, so upstream's extra one is
 * inert here — but it also buys nothing, and declaring it pre-commits us to
 * whatever semantics a later version gives it. An invalid ACTION, by contrast,
 * IS rejected ("Expected PermissionActionConfig") and takes the whole spawn
 * down, which is why every value here is only ever `allow` or `deny`. A
 * category OpenCode adds after this list was written is likewise absent, and
 * resolves to OpenCode's own default rather than to `allow`.
 */
export const OPENCODE_PERMISSIONS: Record<string, string> = {
  read: 'allow',
  edit: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  bash: 'allow',
  task: 'allow',
  external_directory: 'allow',
  todowrite: 'allow',
  question: 'deny',
  webfetch: 'allow',
  websearch: 'allow',
  lsp: 'allow',
  doom_loop: 'allow',
  skill: 'allow',
};

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

/**
 * Is this turn a dead continuation the runner should recover from?
 *
 * Codex's `startOrResumeCodexThread` starts a fresh thread when `thread/resume`
 * reports the id gone. OpenCode's equivalent failure is quieter: a poisoned
 * session accepts `promptAsync`, emits `session.idle` at step 0 having produced
 * no assistant work, and the runner treats that as a finished turn — silence,
 * every turn, forever.
 *
 * Only a RESUME counts. A brand-new session that stays dry is a model or tools
 * miss, not a dead continuation, and recovering it would double the spend for
 * the same silence. "Work" is deliberately wide (a part of any type, a provider
 * error on the assistant record, a permission, a question, a compaction) so a
 * turn that did something and merely said nothing is never discarded.
 *
 * There is no once-per-query latch because the recovery does not happen here:
 * the provider raises a stale-session error and the poll-loop retries with
 * `continuation: undefined`, so the replacement query has nothing to resume and
 * structurally cannot reach this branch again.
 */
export function isEmptyOpenCodeResume(opts: { resumedExistingSession: boolean; sawAssistantWork: boolean }): boolean {
  return opts.resumedExistingSession && !opts.sawAssistantWork;
}

/** Stale / dead OpenCode session heuristics (complement Claude-centric host patterns). */
/**
 * Marker in the error a dead continuation raises. Matched by STALE_SESSION_RE
 * below, so the runner classifies it as a stale session and runs its ONE
 * recovery path — the same one a pruned transcript takes.
 *
 * Keep it regex-literal: it is spliced into that alternation verbatim, so a
 * metacharacter added here silently changes what the whole pattern matches.
 * `opencode.empty-resume.test.ts` asserts the marker still classifies.
 */
export const EMPTY_RESUME_ERROR = 'resumed OpenCode session produced no assistant work';

const STALE_SESSION_RE = new RegExp(
  [
    'no conversation found',
    'ENOENT.*\\.jsonl',
    'session.*not found',
    'NotFoundError',
    'connection reset',
    'ECONNRESET',
    '404',
    'event timeout',
    EMPTY_RESUME_ERROR,
  ].join('|'),
  'i',
);

/**
 * Build the env handed to the `opencode serve` child, stripping the MCP
 * header-only secrets (MCP_HEADER_ONLY_SECRET_VARS — the SINGLE SOURCE shared
 * with the Claude provider, see secret-env.ts) so opencode's bash tool and MCP
 * stdio children can't printenv Exa/Braintrust/Granola. That is the
 * cross-provider env-hygiene parity bar (Claude strips the same set via
 * filterSdkEnv). Data-tool secrets (SNOWFLAKE_PASSWORD, DBT_*, OPENAI_API_KEY,
 * …) are deliberately KEPT, matching Claude. (codex #126)
 *
 * ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN used to be stripped here too
 * (codex #126 F3). They no longer are: a container's shell inherits the
 * credential the container runs on, so an agent in an OpenCode session can run
 * `claude -p` headless the way it can already run `opencode run` and
 * `codex exec` — see secret-env.ts's header for the model.
 *
 * CONSEQUENCE, stated rather than hidden: an OpenCode session whose model is
 * `anthropic/*` now sees those vars in its server env. It still FAILS CLOSED
 * unless auth.json carries an anthropic record (buildOpenCodeConfig throws
 * otherwise), so env alone cannot run such a model. When both an auth.json
 * record and an env credential exist, which one OpenCode prefers is UNVERIFIED
 * against the pinned binary — the only env value that would matter there is an
 * ANTHROPIC_API_KEY (OneCLI's `placeholder`, or a real key under
 * ANTHROPIC_BASE_URL). Every other provider (opencode/opencode-go/nvidia via
 * auth.json, deepseek/openrouter via the OneCLI proxy placeholder) is
 * unaffected — their credentials were never in this list. We keep
 * OPENCODE_CONFIG_CONTENT and all non-secret vars (PATH, HOME, NANOCLAW_*,
 * OPENCODE_*) intact.
 *
 * Pure + exported so it can be unit-tested without actually spawning a process.
 */
export function buildOpencodeServerEnv(baseEnv: NodeJS.ProcessEnv, config: Record<string, unknown>): NodeJS.ProcessEnv {
  const secretVars = new Set<string>(MCP_HEADER_ONLY_SECRET_VARS);
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
      // Child env: see buildOpencodeServerEnv for what is (and is no longer)
      // stripped.
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
// `groups/global/` was deleted by the v2 migration, so that mount never fires
// and every group's own AGENTS.md already carries the standing instructions +
// shared base via composeGroupClaudeMd. No reach
// regression — just dedup, same shape as the Codex per-turn duplication fix.
// `systemInstructions` below combines the trusted resolved runtime identity,
// static memory guidance, and dynamic per-turn content (tone profile,
// capability note, live destinations addendum — built in index.ts). Those
// inputs have no other delivery path into OpenCode, so that wrap stays.
function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
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

/**
 * The input modalities OpenCode's config schema accepts on a model entry
 * (`modalities.input`, opencode 1.18.x). Anything outside this set makes
 * OpenCode reject the whole config, so operator input is validated against it
 * rather than passed through.
 */
const MODEL_INPUT_MODALITIES = ['text', 'audio', 'image', 'video', 'pdf'] as const;

/**
 * A limit env var must be a bare positive integer (a token count). Units
 * ("64k"), blank strings, zero and negatives are rejected rather than coerced:
 * `Number()` would turn blank into 0 — which is exactly the silent
 * compaction-disabling value this whole feature exists to avoid — and "64k"
 * into NaN, whose emitted config is unparseable JSON that stops OpenCode
 * booting. Invalid input is treated as unset.
 */
export function parseLimitEnv(varName: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) {
    log(`Ignoring invalid ${varName}: "${raw}"`);
    return undefined;
  }
  return Number(trimmed);
}

/**
 * The `limit` block for the main model entry, or undefined.
 *
 * OpenCode auto-compacts a session once tokens reach `limit.context` minus the
 * max output tokens. A registry-unknown custom model resolves `limit.context`
 * to 0, which silently disables compaction and kills long sessions against a
 * fixed-window backend. Declaring the limit is the only way to switch it back on.
 *
 * BOTH values are required, which is where this departs from upstream (which
 * emits `context` alone when no output limit is set). opencode 1.18.x's own
 * config schema is `limit: optional(Struct({context: Finite, input:
 * optional(Finite), output: Finite}))` — read out of the shipped binary — so a
 * `limit` carrying only `context` fails validation and takes the entire config
 * down with it, dropping every MCP server and the guard plugin along with the
 * limit. Absent or half-set env vars emit no `limit` key and behavior is
 * unchanged.
 */
export function resolveModelLimit(
  env: NodeJS.ProcessEnv = process.env,
): { context: number; output: number } | undefined {
  const context = parseLimitEnv('OPENCODE_MODEL_CONTEXT_LIMIT', env.OPENCODE_MODEL_CONTEXT_LIMIT);
  const output = parseLimitEnv('OPENCODE_MODEL_OUTPUT_LIMIT', env.OPENCODE_MODEL_OUTPUT_LIMIT);
  if (context === undefined && output === undefined) return undefined;
  if (context === undefined || output === undefined) {
    log(
      'Ignoring model limit declaration: opencode requires BOTH OPENCODE_MODEL_CONTEXT_LIMIT and ' +
        'OPENCODE_MODEL_OUTPUT_LIMIT to be valid positive integers',
    );
    return undefined;
  }
  return { context, output };
}

/**
 * The `modalities` block for the main model entry, or undefined.
 *
 * OpenCode drops every non-text file part whose modality the model does not
 * declare, substituting an "this model does not support <modality> input"
 * error, and a registry-unknown custom model declares nothing. So an image can
 * reach the session store and never reach the model. Declaring the modalities
 * is the only thing that opens that gate; `attachment` is a registry/UI flag
 * rather than a pipeline gate, but it is set alongside so the entry stays
 * internally consistent. Absent the env var, no capability keys are emitted.
 */
/**
 * Do the capability env vars describe the model this turn is actually running?
 *
 * THE invariant these declarations live under, in one predicate. They describe
 * exactly ONE model — the group's configured default, `OPENCODE_MODEL`, which is
 * the model the operator measured when they wrote the vars. Every consumer must
 * ask this before applying any of them, and enforcing it per call site is what
 * produced two rounds of review findings, one per site.
 *
 * Compared as FULL slugs, provider and model id together. `openrouter/shared`
 * and `nvidia/shared` are different models that happen to share an id, so an
 * id-only comparison silently applies one model's context window and media
 * support to the other. Slugs are trimmed and lower-cased; a value carrying no
 * provider prefix only matches an equally prefix-less configured model, since
 * there is nothing to compare a provider against.
 */
export function declarationsApplyToModel(
  effectiveModel: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = env.OPENCODE_MODEL?.trim().toLowerCase();
  if (!configured) return false;
  // No per-turn override resolved: the turn runs the configured model.
  const effective = effectiveModel?.trim().toLowerCase();
  if (!effective) return true;
  return effective === configured;
}

/**
 * The capability declarations that apply to `effectiveModel`, or nothing.
 *
 * The single seam every consumer routes through — the config writer, which
 * attaches `limit`/`modalities` to a model entry, and the attachment forwarder,
 * which decides whether audio and video may be handed over. Both used to make
 * this call themselves, and they disagreed: the writer checked identity (by
 * model id only), the forwarder did not check at all.
 */
export function resolveModelCapabilities(
  effectiveModel: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { limit?: { context: number; output: number }; modalities?: { input: string[]; output: string[] } } {
  if (!declarationsApplyToModel(effectiveModel, env)) return {};
  const limit = resolveModelLimit(env);
  const modalities = resolveModelModalities(env);
  return { ...(limit ? { limit } : {}), ...(modalities ? { modalities } : {}) };
}

export function resolveModelModalities(
  env: NodeJS.ProcessEnv = process.env,
): { input: string[]; output: string[] } | undefined {
  const requested = (env.OPENCODE_MODEL_INPUT_MODALITIES ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .filter((entry, i, a) => a.indexOf(entry) === i)
    .filter((entry) => {
      if ((MODEL_INPUT_MODALITIES as readonly string[]).includes(entry)) return true;
      log(`Ignoring unknown OPENCODE_MODEL_INPUT_MODALITIES entry: ${entry}`);
      return false;
    })
    .filter((entry) => entry !== 'text');
  if (requested.length === 0) return undefined;
  return { input: ['text', ...requested], output: ['text'] };
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
        `/opencode-xdg/opencode/auth.json; an env credential alone does not enable this provider.`,
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
  // limit / modalities describe ONE model — see resolveModelCapabilities, which
  // owns that decision for every consumer. Applied to the EFFECTIVE model's
  // entry, and empty unless that model IS the configured one, so a per-turn
  // `-m` or a change_model gets a bare entry and resolves through OpenCode's own
  // undeclared-model default (the same treatment OPENCODE_SMALL_MODEL gets — the
  // env vars name no small-model equivalent either).
  const { limit: modelLimit, modalities: modelModalities } = resolveModelCapabilities(model);
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
                ...(mid === defaultModelId && modelLimit ? { limit: modelLimit } : {}),
                ...(mid === defaultModelId && modelModalities ? { attachment: true, modalities: modelModalities } : {}),
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
  // Anthropic credentials are never synthesized here: an `anthropic/*` model
  // requires an auth.json record (checked above) and a placeholder would
  // clobber it. The per-model block is independent, though — it carries the
  // effective model's effort options.
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
  // (OPENCODE_PERMISSIONS allows every category + permission auto-reply), so this plugin's
  // `tool.execute.before` throw is the ONLY guardrail standing between the agent
  // and a destructive command. The plugin is mounted read-only from the
  // bootstrap plugin at /workspace/plugins/bootstrap.
  //
  // FAIL-CLOSED: if the plugin is absent (e.g. a group excludes the bootstrap
  // plugin), we REFUSE to build a config — returning one that allows every
  // permission category but has no guard would run an unguarded prod agent with
  // auto-approve on every tool call. Throwing aborts the spawn; the sweep retries, and the
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
        `(every permission category is allowed, so tool calls are auto-approved). Mount the bootstrap plugin, or set ` +
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
    permission: OPENCODE_PERMISSIONS,
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

/**
 * Minimal shape of the `/v2` SDK surface this module needs for question
 * handling — narrowed so tests can pass a fake without constructing the real
 * `@opencode-ai/sdk/v2` client. `question.reply` takes flat parameters
 * (`{ requestID, answers }`) in 1.18.23, and `question.list` returns every
 * pending request across sessions.
 */
export interface QuestionClient {
  question: {
    reply(params: { requestID: string; answers: string[][] }): Promise<{ data?: unknown; error?: unknown }>;
    list(): Promise<{ data?: Array<{ id: string; sessionID?: string; questions?: unknown[] }>; error?: unknown }>;
  };
}

/**
 * Steers the model rather than just silently declining: nothing in this
 * container can answer an interactive question, so tell it to decide on its own
 * or fall back to nanoclaw's own blocking MCP tool (`ask_user_question`), which
 * actually reaches the human through the chat channel instead of OpenCode's
 * headless-dead-end question tool.
 */
export const QUESTION_STEERING_TEXT =
  'Interactive questions are not available in this environment. Decide autonomously based on your best judgment, or use the ask_user_question MCP tool to ask the human through the chat channel.';

/**
 * Answer one pending question request with the steering text, one custom answer
 * per sub-question (OpenCode's `question` tool accepts free text that is not one
 * of the offered option labels). Never throws — a failed auto-answer must not
 * take the session down any harder than the question already threatened to.
 */
export async function autoAnswerQuestion(
  questionClient: QuestionClient,
  req: { id?: string; questions?: unknown[] },
): Promise<void> {
  if (!req.id) return;
  const count = Array.isArray(req.questions) && req.questions.length > 0 ? req.questions.length : 1;
  try {
    const res = await questionClient.question.reply({
      requestID: req.id,
      answers: Array.from({ length: count }, () => [QUESTION_STEERING_TEXT]),
    });
    if (res.error) {
      log(`Failed to auto-answer question ${req.id}: ${JSON.stringify(res.error)}`);
    }
  } catch (err) {
    log(`Failed to auto-answer question ${req.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Fail-open budget shared by both question paths. A hung `list()`/`reply()`
 * round-trip must block neither runtime startup nor the turn that is waiting on
 * the event loop, so each await races a timer and logs one line on expiry.
 */
const QUESTION_TIMEOUT_MS = 10_000;

/**
 * Handle a `question.asked` SSE event: always answer it, whichever session
 * raised it. `question: 'deny'` in OPENCODE_PERMISSIONS should stop the tool
 * from ever firing, but this is the real fix for the wedge — one OpenCode server
 * is shared across every session on this runtime, so a pending question wedges
 * the whole server, not only the session that asked. A config regression, or an
 * OpenCode path that raises the event before consulting permission, must never
 * be able to leave a question unanswered.
 *
 * Called inline from the turn's event loop, hence the timeout: a `reply()` that
 * never resolves would stall the turn, not just startup.
 */
export async function handleQuestionAsked(
  questionClient: QuestionClient,
  req: { id?: string; sessionID?: string; questions?: unknown[] },
  timeoutMs = QUESTION_TIMEOUT_MS,
): Promise<void> {
  log(`Auto-answering question ${req.id ?? '(no id)'} (sessionID=${req.sessionID ?? 'unknown'})`);
  await raceWithTimeout(autoAnswerQuestion(questionClient, req), timeoutMs, () =>
    log(`Timed out after ${timeoutMs}ms auto-answering question ${req.id ?? '(no id)'}; continuing`),
  );
}

/**
 * Defensive belt: drain any question requests already pending when a shared
 * runtime comes up (one that raced the event subscription, or survived a prior
 * server instance) so none of them sits there wedging future turns before the
 * event-driven handler ever sees it. Fail-open — the `question.asked` handler
 * still answers later if a slow round-trip eventually completes.
 */
export async function drainPendingQuestions(
  questionClient: QuestionClient,
  timeoutMs = QUESTION_TIMEOUT_MS,
): Promise<void> {
  const drain = (async () => {
    try {
      const res = await questionClient.question.list();
      if (res.error) {
        log(`Failed to list pending questions: ${JSON.stringify(res.error)}`);
        return;
      }
      for (const req of res.data ?? []) {
        await autoAnswerQuestion(questionClient, req);
      }
    } catch (err) {
      log(`Failed to list pending questions: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  await raceWithTimeout(drain, timeoutMs, () =>
    log(`Timed out after ${timeoutMs}ms draining pending questions; continuing startup`),
  );
}

/**
 * Await `work`, giving up after `timeoutMs`. The timer is always cleared so a
 * fast path cannot leave it holding the process alive or firing into a promise
 * nobody races anymore.
 */
async function raceWithTimeout(work: Promise<unknown>, timeoutMs: number, onTimeout: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });
  try {
    if (await Promise.race([work.then(() => false as const), timedOut])) onTimeout();
  } finally {
    clearTimeout(timer);
  }
}

type SharedRuntime = {
  proc: ChildProcess;
  client: OpencodeClient;
  questionClient: QuestionClient;
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
      const questionClient = createOpencodeQuestionClient({ baseUrl: url }) as unknown as QuestionClient;
      const sub = await client.event.subscribe();
      const stream = sub.stream as AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
      // Belt-and-suspenders drain before this runtime serves any turn — see
      // drainPendingQuestions. Bounded, so a hung round-trip cannot block spawn.
      await drainPendingQuestions(questionClient);
      sharedRuntime = {
        proc,
        client,
        questionClient,
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

/**
 * Narrow runtime surface so a test can drive `query()` without spawning
 * `opencode serve`. Production passes nothing and goes through
 * `ensureSharedRuntime`; only the shape this module actually calls is declared.
 */
export interface OpenCodeRuntimeHandle {
  client: {
    session: {
      create(): Promise<{ data?: { id?: string }; error?: unknown }>;
      promptAsync(params: {
        path: { id: string };
        body: {
          parts: Array<{ type: 'text'; text: string } | FilePartInput>;
          model?: { providerID: string; modelID: string };
        };
      }): Promise<{ error?: unknown }>;
    };
    postSessionIdPermissionsPermissionId(params: {
      path: { id: string; permissionID: string };
      body: { response: 'once' | 'always' | 'reject' };
    }): Promise<unknown>;
  };
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  questionClient: QuestionClient;
}

export interface OpenCodeRuntimeDeps {
  getRuntime(
    options: ProviderOptions,
    cwd: string | undefined,
    turn: OpenCodeTurnOverrides,
  ): Promise<OpenCodeRuntimeHandle>;
}

/**
 * Reported when neither the turn nor OPENCODE_MODEL names a model and the
 * server picks one we are never told. A named unknown, not an absence — see
 * `AgentQuery.resolvedModel`.
 */
export const OPENCODE_NATIVE_DEFAULT_MODEL = 'opencode:server-default';

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private readonly runtime?: OpenCodeRuntimeDeps;
  private activeSessionId: string | undefined;
  private memorySessionHook?: MemorySessionHookRegistration;

  // `runtime` is a test seam only. The registration below passes nothing, so
  // every production spawn goes through ensureSharedRuntime unchanged.
  constructor(options: ProviderOptions = {}, runtime?: OpenCodeRuntimeDeps) {
    this.options = options;
    this.runtime = runtime;
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

    // Each queued turn carries its own media, so a photo sent as a follow-up
    // reaches the model as a file part rather than only as prose.
    const pending: Array<{
      text: string;
      attachments?: PromptAttachment[];
      /**
       * The UNWRAPPED prompt, set only on an opening turn that resumed a
       * persisted continuation. Its presence is what licenses the empty-resume
       * fallback; its value is what the replay re-composes from, so the
       * replacement session gets the prompt shape a first-time session would
       * have got instead of a second <system> block stacked on the first.
       */
      replayPrompt?: string;
    }> = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    // Per-turn `-m`/`-e` (resolved by the poll-loop from sticky + turn flags).
    // `effort` rebuilds the runtime config (it lives server-side); `model` is
    // applied per-prompt via body.model below so a switch needs no respawn and
    // keeps session continuity. The effective model = turn override → env
    // default (host sets OPENCODE_MODEL from the DB default). The resolved
    // model and effort are injected into a trusted runtime block below so the
    // agent knows what this turn is actually running on.
    const turn: OpenCodeTurnOverrides = { model: input.model, effort: input.effort };
    const effectiveModel = input.model ?? process.env.OPENCODE_MODEL;
    // What this query's turns actually run at, for the turn_usage ledger.
    // `clampOpenCodeEffort` is the value that reaches the server config (null
    // when it deliberately registers nothing); the raw string is what the
    // resolution chain produced, so an `xhigh`->`high` remap or an
    // unrecognized level is visible as a divergence instead of vanishing.
    // OpenCode reports one summed usage entry per turn, so there is no
    // per-model attribution to make — see providers/turn-effort.ts.
    const rawTurnEffort = turn.effort ?? process.env.OPENCODE_EFFORT;
    const turnEffort = {
      model: effectiveModel,
      effective: clampOpenCodeEffort(rawTurnEffort),
      requested: rawTurnEffort,
    };
    const runtimeInstructions = appendActiveRuntimeContext(input.systemContext?.instructions, {
      provider: 'opencode',
      model: effectiveModel ?? OPENCODE_NATIVE_DEFAULT_MODEL,
      effort: turnEffort.effective,
    });
    const promptModel = effectiveModel ? splitModelSlug(effectiveModel) : null;

    // OpenCode has no session-start hook API. Its native prompt lifecycle
    // carries trusted static memory handling/write guidance on every prompt;
    // canonical bytes arrive per turn only in paired untrusted recall.
    const memoryContext = memoryContextForSessionStart('startup');
    const systemInstructions = [runtimeInstructions, memoryContext].filter(Boolean).join('\n\n');
    pending.push({
      text: wrapPromptWithContext(input.prompt, systemInstructions),
      attachments: input.attachments,
      replayPrompt: input.continuation ? input.prompt : undefined,
    });

    const kick = (): void => {
      waiting?.();
    };

    const self = this;
    const queryCwd = input.cwd;
    const IDLE_TIMEOUT_MS = 90_000;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      const rt: OpenCodeRuntimeHandle = self.runtime
        ? await self.runtime.getRuntime(self.options, queryCwd, turn)
        : await ensureSharedRuntime(self.options, queryCwd, turn);
      const { client, stream, questionClient } = rt;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const { text, attachments, replayPrompt } = pending.shift()!;
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

        /**
         * Run one prompt to `session.idle` on `turnSessionId`, yielding the
         * turn's provider events and returning what the turn produced.
         *
         * Extracted so the empty-resume fallback below can run a SECOND turn on
         * a fresh session with the same machinery. Everything inside is the
         * turn body as it stood before, plus the `sawAssistantWork` tracking
         * that fallback needs.
         */
        async function* runTurn(
          turnSessionId: string,
          turnText: string,
          turnAttachments: typeof attachments,
        ): AsyncGenerator<
          ProviderEvent,
          {
            resultText: string;
            sawAssistantWork: boolean;
            stepCount: number;
            usage: ReturnType<typeof sumOpenCodeTurnUsage>;
          }
        > {
          const promptRes = await client.session.promptAsync({
            path: { id: turnSessionId },
            // body.model carries the per-turn `-m` model (provider/id split). When
            // unset (no override + no env default) opencode uses the session/server
            // default. Switching models mid-session is just a different body.model
            // on the next prompt — no server respawn.
            body: {
              parts: buildPromptParts(turnText, turnAttachments, { effectiveModel }),
              ...(promptModel ? { model: promptModel } : {}),
            },
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
          // Every message that produced at least one part of ANY type. A tool
          // call is work even though it carries no text, so this is wider than
          // partTextById on purpose — it is what separates a live session from a
          // poisoned one below.
          const partMessageIds = new Set<string>();
          // messageID → the session that owns it, so the work determination
          // below can narrow to this turn while the usage sum stays wide.
          const sessionByMessageId = new Map<string, string>();
          // `message.updated` fires repeatedly for the same record, so latch the
          // error rather than reading only the last event.
          const erroredMessageIds = new Set<string>();
          // Set only by signals that have no message record of their own
          // (permissions, questions, compaction). Message-derived work is
          // decided once, after the turn, in the loop below.
          let sawAssistantWork = false;
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
              log(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms) — clearing session ${turnSessionId}`);
              eventTimedOut = true;
              self.activeSessionId = undefined;
              destroySharedRuntime();
              kick();
            }
          }, 5000);

          try {
            turn: while (true) {
              if (aborted) return { resultText: '', sawAssistantWork, stepCount: 0, usage: undefined };
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
                        sessionID?: string;
                        error?: unknown;
                        modelID?: string;
                        providerID?: string;
                        cost?: number;
                        tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
                      }
                    | undefined;
                  // NOT filtered by sessionID. Subagent responses arrive under
                  // their own session and are real spend, so they belong in the
                  // usage sum — see sumOpenCodeTurnUsage. The session is
                  // recorded instead, and only the work determination below
                  // narrows to this turn's session.
                  if (info?.id && info?.role) {
                    roleByMessageId.set(info.id, info.role);
                    if (info.sessionID) sessionByMessageId.set(info.id, info.sessionID);
                    if (info.error) erroredMessageIds.add(info.id);
                    if (info.role === 'assistant') assistantUsageById.set(info.id, info);
                    // Context occupancy for the status subtext. Unlike the
                    // usage sum above this IS filtered to the turn's own
                    // session: a subagent runs in its own session with its own
                    // window, and its prompt size says nothing about ours.
                    //
                    // OpenCode follows Anthropic's convention, not OpenAI's —
                    // `tokens.input` and `tokens.cache.read` are DISJOINT, so
                    // occupancy is their sum. The measurement in
                    // sumOpenCodeTurnUsage's header settles it: over one
                    // session the per-message `input` summed to 325,382 while
                    // `cache.read` summed to 1,927,040, which is impossible if
                    // the cached figure were a subset of the input one.
                    //
                    // Latest-wins, and `message.updated` re-fires as a message
                    // streams, so the value converges on that message's final
                    // reading with no dedupe needed.
                    if (info.role === 'assistant' && info.sessionID === turnSessionId) {
                      recordContextTokens(openCodeContextOccupancy(info.tokens));
                    }
                  }
                  break;
                }
                case 'message.part.updated': {
                  const part = ev.properties.part as
                    | { id?: string; type?: string; messageID?: string; sessionID?: string; text?: string }
                    | undefined;
                  // Also unfiltered, for the same reason: a part belongs to a
                  // message, and which turn that message counts toward is
                  // decided from sessionByMessageId below.
                  if (part?.messageID) partMessageIds.add(part.messageID);
                  if (part?.type === 'text' && part.id && part.messageID && part.text) {
                    partTextById.set(part.id, { messageID: part.messageID, text: part.text });
                  }
                  break;
                }
                case 'permission.updated': {
                  const perm = ev.properties as { id?: string; sessionID?: string };
                  if (perm.sessionID === turnSessionId && perm.id) {
                    sawAssistantWork = true;
                    try {
                      await client.postSessionIdPermissionsPermissionId({
                        path: { id: turnSessionId, permissionID: perm.id },
                        body: { response: 'always' },
                      });
                    } catch (err) {
                      log(`Failed to auto-reply permission: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }
                  break;
                }
                case 'question.asked': {
                  // Answered regardless of sessionID: the OpenCode server is
                  // shared across sessions and ONE unanswered question wedges the
                  // whole server, so this must not filter by turn.
                  const req = ev.properties as { id?: string; sessionID?: string; questions?: unknown[] };
                  if (req.sessionID === turnSessionId) sawAssistantWork = true;
                  await handleQuestionAsked(questionClient, req);
                  break;
                }
                case 'session.compacted': {
                  // Not surfaced as a provider event (the poll-loop's compaction
                  // reminder is Claude/Codex-side), but a compaction on THIS
                  // session is real work — counting it stops a
                  // compaction-only turn from reading as a dead continuation.
                  if ((ev.properties as { sessionID?: string }).sessionID === turnSessionId) sawAssistantWork = true;
                  break;
                }
                case 'session.status': {
                  const props = ev.properties as {
                    sessionID?: string;
                    status?: { type?: string; attempt?: number; message?: string };
                  };
                  if (props.sessionID !== turnSessionId) break;
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
                  if (props.sessionID === turnSessionId || props.sessionID === undefined) {
                    self.activeSessionId = undefined;
                    throw new Error(sessionErrorMessage(props));
                  }
                  break;
                }
                case 'session.idle': {
                  const sid = (ev.properties as { sessionID?: string }).sessionID;
                  if (sid === turnSessionId) {
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
            if (role !== 'assistant') continue;
            lastAssistantMessageId = msgId;
            // The bare envelope is the quiet-idle signature. OpenCode opens the
            // assistant record when the turn starts, so the record existing
            // proves nothing on its own. Work means it produced at least one
            // part — or that it carries a provider error, which marks a LIVE
            // session whose turn failed: replaying that on a fresh session would
            // discard the history and bury the error.
            // Narrowed to THIS turn's session (an id whose session the stream
            // never reported counts, so an SDK that omits it fails safe toward
            // keeping the session). A subagent's own messages are spend, not
            // proof this continuation is alive — but the parent's tool call
            // that launched it is a part on a message of this session, so a
            // turn that only dispatched a subagent still reads as work.
            const owner = sessionByMessageId.get(msgId);
            if (owner !== undefined && owner !== turnSessionId) continue;
            if (partMessageIds.has(msgId) || erroredMessageIds.has(msgId)) sawAssistantWork = true;
          }
          let resultText = '';
          if (lastAssistantMessageId) {
            const texts: string[] = [];
            for (const { messageID, text } of partTextById.values()) {
              if (messageID === lastAssistantMessageId) texts.push(text);
            }
            resultText = texts.join('');
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
          const usage = sumOpenCodeTurnUsage(
            [...assistantUsageById.values()],
            lastAssistantMessageId ? assistantUsageById.get(lastAssistantMessageId) : undefined,
          );
          return { resultText, sawAssistantWork, stepCount, usage };
        }

        const outcome = yield* runTurn(sessionId, text, attachments);
        if (aborted) return;

        // Empty-resume recovery. A poisoned continuation accepts promptAsync,
        // emits session.idle having produced nothing, and would otherwise be
        // reported as a finished, silent turn — every turn, forever.
        //
        // Recovery is RAISED, not performed here. Upstream creates a fresh
        // session inline and replays the prompt into it, because upstream's
        // runner has no recovery path of its own. This one does: the poll-loop's
        // stale-session branch clears the continuation, resets the provider
        // context, re-arms the memory bootstrap, and retries with a recap built
        // from the per-session DB. Replaying inline would skip all four — most
        // visibly the recap, so "continue with that plan" would be retried on a
        // session that has never heard of the plan. Raising a
        // stale-session-shaped error routes this into the one recovery the
        // runner already owns, and that retry carries `continuation: undefined`,
        // so the replacement query cannot reach this branch again.
        if (
          isEmptyOpenCodeResume({
            resumedExistingSession: replayPrompt !== undefined,
            sawAssistantWork: outcome.sawAssistantWork,
          })
        ) {
          log(`Empty resume on ${sessionId} — raising as a stale session so the runner recovers with a recap.`);
          self.activeSessionId = undefined;
          throw new Error(`${EMPTY_RESUME_ERROR} (session ${sessionId})`);
        }

        // Empty-turn fallback: the turn completed (session.idle, no error) but
        // produced no text — the model emitted only reasoning/whitespace. Without
        // this the poll-loop delivers nothing and the user sees silence (observed
        // with free-tier nvidia models degenerating). Surface a visible, actionable
        // message instead of dead air.
        //
        // Applied to the FINAL outcome, after the empty-resume fallback above, so
        // a resume that was retried on a fresh session cannot post this warning
        // for the dead turn AND then answer normally.
        let resultText = outcome.resultText;
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
        yield {
          type: 'result',
          text: resultText,
          steps: outcome.stepCount > 0 ? outcome.stepCount : null,
          usage: attachTurnEffort(outcome.usage, turnEffort),
        };
      }
    }

    return {
      // OpenCode picks the model server-side when neither the turn nor
      // OPENCODE_MODEL names one, and the client is never told which. That is
      // a real known-unknown, so it is reported as one rather than as absence
      // — the ledger must be able to say "ran on opencode's own default" and
      // have that mean something different from "nobody recorded a model".
      resolvedModel: effectiveModel ?? OPENCODE_NATIVE_DEFAULT_MODEL,
      push: (message: string, attachments?: PromptAttachment[]) => {
        pending.push({
          text: wrapPromptWithContext(message, systemInstructions),
          attachments,
        });
        kick();
      },
      // OpenCode has no mid-turn merge: `push` above always appends, and the
      // generator dequeues only between turns, so a follow-up pushed while a
      // turn is running is still sitting here when that turn's `result` fires.
      // The poll-loop reads this to keep `provider_executing` raised across
      // that gap instead of publishing idle to the host's task reaper.
      hasQueuedWork: () => pending.length > 0,
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
