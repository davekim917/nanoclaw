import * as fs from 'fs';
import { taskListEnabled } from '../task-list.js';
import { spawn, type ChildProcess } from 'child_process';
import { pathToFileURL } from 'url';

import { createOpencodeClient, type FilePartInput, type OpencodeClient } from '@opencode-ai/sdk';
// The root client has no `.question` surface in 1.18.23: list/reply/reject exist only on the `/v2` client, which
// talks to the same server.
import { createOpencodeClient as createOpencodeQuestionClient } from '@opencode-ai/sdk/v2';

import { memoryContextForSessionStart, type MemorySessionHookRegistration } from '../memory/session-hook.js';
import { appendActiveRuntimeContext } from '../runtime-context.js';
import { recordContextTokens } from '../turn-status.js';

/**
 * `input`, `cache.read` and `cache.write` are disjoint for every upstream, OpenAI included (OpenCode's getUsage
 * subtracts cache from input), so occupancy is their sum. Re-check getUsage on any OPENCODE_VERSION bump: if it stops
 * subtracting, this double-counts. 0 means "no reading" and leaves the previous one standing.
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
import { loadExcludedPlugins } from '../excluded-plugins.js';
import { isExcludedPluginPath, type ExcludedPlugins } from '../plugin-exclusions.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

/** Fallback for adapters that report no `mimeType`; audio/video mirror the host's `TYPE_TO_EXT`. */
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
 * Audio/video only when declared (closed by default), resolved through `resolveModelCapabilities` so this and the
 * config writer cannot disagree. Images and PDFs always forward: a rejection is visible, a withheld file is not.
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

/** Exported and structurally typed, so the `typeof` guards stop a raw channel object from throwing mid-query. */
function attachmentMime(att: PromptAttachment): string | undefined {
  if (typeof att.mime === 'string' && att.mime) return att.mime;
  const name = (typeof att.path === 'string' ? att.path : '') || (typeof att.filename === 'string' ? att.filename : '');
  const dot = name.lastIndexOf('.');
  return dot < 0 ? undefined : ATTACHMENT_MIME_BY_EXT[name.slice(dot).toLowerCase()];
}

/**
 * `file://` URLs, not data: URIs: the OpenCode server shares this filesystem and base64-encodes them itself. A model
 * OpenCode does not know declares no input modalities and drops every non-text part unless
 * OPENCODE_MODEL_INPUT_MODALITIES is set. Skipped media is still described in the prompt text.
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

/** Follow-up pushes go through here too: most real messages arrive as pushes, so media must travel that path. */
export function buildPromptParts(
  text: string,
  attachments?: PromptAttachment[],
  opts: { effectiveModel?: string; env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean } = {},
): Array<{ type: 'text'; text: string } | FilePartInput> {
  return [{ type: 'text', text }, ...buildAttachmentFileParts(attachments, opts)];
}

/**
 * Enumerated rather than `permission: 'allow'` so `question` is a deterministic `deny`: a headless container cannot
 * answer it and the session wedges. Every other key stays `allow`, so the destructive-action plugin remains the only
 * guard. Values must be `allow`/`deny` only: an invalid action fails the whole spawn. Undocumented categories are
 * omitted on purpose, so unlisted and future keys keep OpenCode's defaults rather than an implicit allow.
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

export type OpenCodeAssistantUsage = {
  modelID?: string;
  providerID?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
};

/**
 * Per-message values are per-response, not cumulative, so a turn's usage is the sum over its messages. `model` comes
 * from the last message; `undefined` for no messages records a coverage gap rather than a fabricated zero.
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

/** A native credential must not get the `apiKey: 'placeholder'` override, which would clobber the OAuth token. */
function opencodeAuthHasCredential(provider: string): boolean {
  return opencodeAuthProviders().includes(provider);
}

// Memoized: auth.json is copied once at spawn and never written in-container, and this is on the per-turn hot path.
let cachedAuthProviders: string[] | null = null;

/** Mirrors OpenCode 1.18.23's Auth.Info union: a malformed record must not be treated as native auth. */
function isOpenCodeAuthRecord(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // Untrimmed, like OpenCode's Schema.String, but zero-length credentials are refused.
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
    cachedAuthProviders = [];
  }
  return cachedAuthProviders;
}

export function _resetOpenCodeAuthCacheForTesting(): void {
  cachedAuthProviders = null;
}

export function _setOpenCodeAuthProvidersForTesting(providers: string[]): void {
  cachedAuthProviders = [...providers];
}

function splitModelSlug(slug: string): { providerID: string; modelID: string } | null {
  const i = slug.indexOf('/');
  if (i <= 0 || i >= slug.length - 1) return null;
  return { providerID: slug.slice(0, i), modelID: slug.slice(i + 1) };
}

interface OpenCodeTurnOverrides {
  model?: string;
  effort?: string;
}

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
 * A poisoned session accepts the prompt and idles at step 0, silently, every turn. Only a resumed session counts:
 * a fresh one that stays dry is a model miss, and recovering it would double the spend.
 */
export function isEmptyOpenCodeResume(opts: { resumedExistingSession: boolean; sawAssistantWork: boolean }): boolean {
  return opts.resumedExistingSession && !opts.sawAssistantWork;
}

/** Spliced verbatim into STALE_SESSION_RE, so it must stay free of regex metacharacters. */
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
 * Strips only MCP_HEADER_ONLY_SECRET_VARS (the set Claude strips too); data-tool secrets and ANTHROPIC_API_KEY /
 * CLAUDE_CODE_OAUTH_TOKEN are kept on purpose (see secret-env.ts). An `anthropic/*` model still needs an auth.json
 * record; which credential OpenCode prefers when both exist is unverified.
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
    // OS-assigned port, parsed back from the "listening on" line, so two servers cannot collide.
    const port = 0;
    // cwd is the agent workspace so OpenCode's file/shell tools default there, not to the Dockerfile WORKDIR.
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      env: buildOpencodeServerEnv(process.env, config),
      cwd: cwd ?? process.cwd(),
    });

    const id = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    // Startup-only listeners, removed on resolve so post-startup chatter does not accumulate in memory.
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
            // Keep draining after detaching the listeners, or a full pipe blocks the child.
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

// No AGENTS.md push here: OpenCode auto-loads it from its cwd, so a second copy would duplicate it every turn.
// `systemInstructions` has no other path into OpenCode, so that wrap stays.
function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  return out;
}

/**
 * Sends `reasoning_effort` only (`thinking.budgetTokens` 400s on non-Anthropic upstreams). `max` passes through so
 * a model without it fails loudly; `xhigh`/`minimal` map to the nearest level; unset → null (inject nothing).
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

/** Anything outside OpenCode's accepted set makes it reject the whole config. */
const MODEL_INPUT_MODALITIES = ['text', 'audio', 'image', 'video', 'pdf'] as const;

/**
 * Bare positive integers only: blank would become 0 (silently disabling compaction) and "64k" NaN (an unparseable
 * config). Invalid input is treated as unset.
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
 * A registry-unknown model has `limit.context` 0, which silently disables compaction. Both values are required:
 * OpenCode's schema rejects a `limit` without `output`, taking every MCP server and the guard plugin down with it.
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
 * The declarations describe exactly one model, OPENCODE_MODEL; every consumer must check this before applying them.
 * Compared as full slugs: `openrouter/shared` and `nvidia/shared` are different models.
 */
export function declarationsApplyToModel(
  effectiveModel: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = env.OPENCODE_MODEL?.trim().toLowerCase();
  if (!configured) return false;
  const effective = effectiveModel?.trim().toLowerCase();
  if (!effective) return true;
  return effective === configured;
}

/** The single seam for both the config writer and the attachment forwarder, so the two cannot disagree. */
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
  // The model also goes per-prompt, so a switch without effort needs no respawn. Effort exists only as per-model
  // config options, so runtimeConfigKey includes the model whenever effort is active and effort follows the model.
  const model = turn.model ?? process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;
  const defaultSplit = model ? splitModelSlug(model) : null;
  const provider = defaultSplit?.providerID ?? process.env.OPENCODE_PROVIDER ?? 'anthropic';

  // Enable every credentialed provider: per-prompt body.model resolves only against enabled_providers.
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

  const defaultModelId = defaultSplit?.modelID;
  const smallModelId = smallModel ? (splitModelSlug(smallModel)?.modelID ?? smallModel) : undefined;
  const modelsToRegister = [defaultModelId, smallModelId]
    .filter((mid): mid is string => Boolean(mid))
    .filter((mid, i, a) => a.indexOf(mid) === i);
  // Declarations attach only when the effective model is the configured OPENCODE_MODEL (a matching `-m` included).
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

  // The placeholder is only for the OneCLI-proxy path; with an auth.json credential it would clobber the real token.
  const sdkOptions: Record<string, unknown> = {};
  // Never synthesized for anthropic: its auth.json record (checked above) would be clobbered.
  if (provider !== 'anthropic' && !opencodeAuthHasCredential(provider)) sdkOptions.apiKey = 'placeholder';

  const providerConfig = {
    ...(Object.keys(sdkOptions).length > 0 ? { options: sdkOptions } : {}),
    ...modelsBlock,
  };
  const providerOptions: Record<string, unknown> =
    Object.keys(providerConfig).length > 0 ? { [provider]: providerConfig } : {};

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  // OpenCode auto-approves every tool call, so this plugin's `tool.execute.before` throw is the only
  // destructive-action guard. An absent plugin refuses the spawn (the sweep retries) rather than running
  // unguarded; OPENCODE_ALLOW_UNGUARDED=1 is a dev-only escape hatch.
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
    // With the live task list on, `update_task_list` is the one checklist:
    // OpenCode's own todowrite would be a second, invisible one.
    permission: taskListEnabled() ? { ...OPENCODE_PERMISSIONS, todowrite: 'deny' } : OPENCODE_PERMISSIONS,
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    mcp,
    // Both unconditional: the managed-Git guard (agent bash only; MCP and host Git run outside it) has no opt-out,
    // and with the opt-out and no bootstrap mount OpenCode ignores only the missing second path.
    plugin: [MANAGED_GIT_OPENCODE_PLUGIN_PATH, GUARD_PLUGIN, ...commentRulePlugins()],
  };
}

const COMMENT_RULE_PLUGIN_DIR = 'bootstrap/plugins/comment-rule';
const COMMENT_RULE_PLUGIN = `/workspace/plugins/${COMMENT_RULE_PLUGIN_DIR}/hooks/opencode-comment-rule.mjs`;

export function commentRulePlugins(excluded?: ExcludedPlugins): string[] {
  if (!fs.existsSync(COMMENT_RULE_PLUGIN)) return [];
  return isExcludedPluginPath(COMMENT_RULE_PLUGIN_DIR, excluded ?? loadExcludedPlugins()) ? [] : [COMMENT_RULE_PLUGIN];
}

/** `question.reply` takes flat `{ requestID, answers }` in 1.18.23; `question.list` spans every session. */
export interface QuestionClient {
  question: {
    reply(params: { requestID: string; answers: string[][] }): Promise<{ data?: unknown; error?: unknown }>;
    list(): Promise<{ data?: Array<{ id: string; sessionID?: string; questions?: unknown[] }>; error?: unknown }>;
  };
}

/** Steers the model to decide itself or use `ask_user_question`, which actually reaches the human. */
export const QUESTION_STEERING_TEXT =
  'Interactive questions are not available in this environment. Decide autonomously based on your best judgment, or use the ask_user_question MCP tool to ask the human through the chat channel.';

/** One custom answer per sub-question. Never throws: a failed auto-answer must not take the session down. */
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

/** A hung list()/reply() must block neither runtime startup nor the turn's event loop. */
const QUESTION_TIMEOUT_MS = 10_000;

/**
 * Always answer, whichever session asked: one OpenCode server is shared by every session, so a pending question
 * wedges all of them. `question: 'deny'` should prevent this but must not be the only defense.
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

/** Drains questions pending before the event subscription existed (a race, or a prior server instance). */
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

/** The timer is always cleared so a fast path cannot leave it holding the process alive. */
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
    // A direct-native route changes the child env: crossing it respawns, a same-route model switch must not.
    nativeDirect: shouldBypassOpenCodeProxy(effectiveModel, authProviders),
    // Effort lives in the server config, so changing it respawns; an unresumable respawn self-heals via the recap.
    effort,
    // The model is per-prompt (no respawn) except while effort is active, since effort is registered on the model.
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
    // Killed in `finally` if init throws between spawn and the sharedRuntime handoff, or every retry leaks a server.
    let orphanProc: ChildProcess | undefined;
    try {
      if (sharedRuntime) {
        destroySharedRuntime();
      }
      const config = buildOpenCodeConfig(options, turn);
      const { url, proc } = await spawnOpencodeServer(config, cwd);
      orphanProc = proc;
      const client = createOpencodeClient({ baseUrl: url, ...(cwd ? { directory: cwd } : {}) });
      const questionClient = createOpencodeQuestionClient({ baseUrl: url }) as unknown as QuestionClient;
      const sub = await client.event.subscribe();
      const stream = sub.stream as AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
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
      orphanProc = undefined;
      return sharedRuntime;
    } finally {
      if (orphanProc) {
        try {
          orphanProc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
      // Cleared on failure too, or every later turn replays the cached rejection instead of re-running init.
      sharedInit = null;
    }
  })();

  return sharedInit;
}

function destroySharedRuntime(): void {
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

/** Reported when no model is named and the server picks one we are never told: a named unknown, not an absence. */
export const OPENCODE_NATIVE_DEFAULT_MODEL = 'opencode:server-default';

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private readonly runtime?: OpenCodeRuntimeDeps;
  private activeSessionId: string | undefined;
  private memorySessionHook?: MemorySessionHookRegistration;

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

    const pending: Array<{
      text: string;
      attachments?: PromptAttachment[];
      /** Set only on an opening turn that resumed a continuation; its presence licenses the empty-resume check. */
      replayPrompt?: string;
    }> = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    const turn: OpenCodeTurnOverrides = { model: input.model, effort: input.effort };
    const effectiveModel = input.model ?? process.env.OPENCODE_MODEL;
    // `requested` keeps the raw string so an `xhigh`->`high` remap or an unknown level shows as a divergence.
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

    // OpenCode has no session-start hook, so memory guidance rides on every prompt.
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
            body: {
              parts: buildPromptParts(turnText, turnAttachments, { effectiveModel }),
              ...(promptModel ? { model: promptModel } : {}),
            },
          });
          if (promptRes.error) {
            self.activeSessionId = undefined;
            throw new Error(`OpenCode promptAsync: ${JSON.stringify(promptRes.error)}`);
          }

          // Keyed by part id: several text parts can share one messageID (prose before and after a tool call).
          const partTextById = new Map<string, { messageID: string; text: string }>();
          const roleByMessageId = new Map<string, string>();
          // Any part type counts as work (a tool call has no text): this separates a live session from a poisoned one.
          const partMessageIds = new Set<string>();
          // Lets the work check narrow to this turn's session while the usage sum stays wide.
          const sessionByMessageId = new Map<string, string>();
          // `message.updated` fires repeatedly for the same record, so latch the
          // error rather than reading only the last event.
          const erroredMessageIds = new Set<string>();
          // Set only by signals with no message record of their own (permissions, questions, compaction).
          let sawAssistantWork = false;
          // `message.updated` re-fires as a message streams: the last write per id is its final figure, and the
          // turn's usage sums every id.
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

              // Heartbeats reset the idle timer (a model can think silently for minutes) but yield no activity event.
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
                  // Not filtered by sessionID: subagent responses are real spend and belong in the usage sum.
                  if (info?.id && info?.role) {
                    roleByMessageId.set(info.id, info.role);
                    if (info.sessionID) sessionByMessageId.set(info.id, info.sessionID);
                    if (info.error) erroredMessageIds.add(info.id);
                    if (info.role === 'assistant') assistantUsageById.set(info.id, info);
                    // Occupancy IS filtered to this session: a subagent's window says nothing about ours.
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
                  // Answered regardless of session: one unanswered question wedges the whole shared server.
                  const req = ev.properties as { id?: string; sessionID?: string; questions?: unknown[] };
                  if (req.sessionID === turnSessionId) sawAssistantWork = true;
                  await handleQuestionAsked(questionClient, req);
                  break;
                }
                case 'session.compacted': {
                  // Compaction on this session is work, so a compaction-only turn does not read as a dead resume.
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

          // All text parts of the last assistant message, in arrival order (Map keeps insertion order).
          let lastAssistantMessageId: string | undefined;
          for (const [msgId, role] of roleByMessageId) {
            if (role !== 'assistant') continue;
            lastAssistantMessageId = msgId;
            // The record alone proves nothing (OpenCode opens it at turn start): work is a part or a provider error.
            // Only this session's messages count; an unknown owner fails safe toward keeping the session.
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
          // One assistant message per LLM response; counted off the same map the usage sum reads, so they agree.
          const stepCount = assistantUsageById.size;
          const usage = sumOpenCodeTurnUsage(
            [...assistantUsageById.values()],
            lastAssistantMessageId ? assistantUsageById.get(lastAssistantMessageId) : undefined,
          );
          return { resultText, sawAssistantWork, stepCount, usage };
        }

        const outcome = yield* runTurn(sessionId, text, attachments);
        if (aborted) return;

        // Raised, not replayed inline: the poll-loop's stale-session path clears the continuation and retries with
        // a recap, which an inline replay would skip. That retry has no continuation, so it cannot land here again.
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

        // A text-less turn (reasoning or whitespace only) surfaces a warning instead of silence.
        let resultText = outcome.resultText;
        if (!resultText.trim()) {
          const m = effectiveModel ?? 'the current model';
          const warningText =
            `⚠️ \`${m}\` returned an empty response this turn (no text generated). ` +
            `Some models/providers do this under load — try again, or switch with \`-m <provider/model>\`.`;
          log(`Empty assistant response (model=${m}) — surfacing fallback instead of silent no-reply`);
          // Dedupe only the channel post: a flapping model would otherwise repeat the same warning every turn.
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
      // A known unknown, not an absence: the server picked a model and never said which.
      resolvedModel: effectiveModel ?? OPENCODE_NATIVE_DEFAULT_MODEL,
      // Post-clamp; null is real: OpenCode then injects no reasoning_effort at all.
      resolvedEffort: clampOpenCodeEffort(turn.effort ?? process.env.OPENCODE_EFFORT),
      push: (message: string, attachments?: PromptAttachment[]) => {
        pending.push({
          text: wrapPromptWithContext(message, systemInstructions),
          attachments,
        });
        kick();
      },
      // No mid-turn merge: a follow-up pushed during a turn is still queued when that turn's `result` fires, so
      // the poll-loop keeps `provider_executing` raised across the gap.
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
