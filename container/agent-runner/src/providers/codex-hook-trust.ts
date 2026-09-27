/**
 * Codex ≥0.154 never dispatches a hook without a matching `[hooks.state."<key>"] trusted_hash` and fails open
 * silently, so these entries keep the container guard chain live. Under app-server the only bypass is the
 * per-request `params.config.bypass_hook_trust` (the top-level spelling and the process flag are silently ignored);
 * entries are used instead because the bypass trusts every hook in the home. Neither an accepted param nor a
 * `hooks/list` status proves a hook ran: only the handler actually firing does.
 *
 * Hash: sha256 of the compact, key-sorted JSON of `{ event_name, matcher?, hooks: [<normalized handler>] }`, with
 * every `None` field omitted because codex builds it through TOML, which has no null.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { type CodexHookListEntry, escapeTomlBasicStringBody } from './codex-app-server.js';

/** All twelve of codex 0.154.0's `HOOK_EVENT_NAMES`: a missing event leaves its handlers untrusted. */
export type CodexHookEvent =
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'Interrupt';

/** The same snake_case spelling goes into the hash and the state key; a mismatch matches nothing. */
const EVENT_KEYS: Record<CodexHookEvent, string> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  Stop: 'stop',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  Interrupt: 'interrupt',
};

export function isCodexHookEvent(name: string): name is CodexHookEvent {
  return Object.prototype.hasOwnProperty.call(EVENT_KEYS, name);
}

export function codexHookEventKey(event: CodexHookEvent): string {
  return EVENT_KEYS[event];
}

/** Codex nulls the matcher for every other event before hashing, so a declared matcher there must not be hashed. */
const MATCHER_EVENTS = new Set<CodexHookEvent>([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
]);

const DEFAULT_TIMEOUT_SEC = 600;
const SESSION_END_DEFAULT_TIMEOUT_SEC = 1;
const SESSION_END_MAX_TIMEOUT_SEC = 3;
/** A limit equal to the default is normalized away before hashing. */
const DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT = 2500;
export function codexHookEventUsesMatcher(event: CodexHookEvent): boolean {
  return MATCHER_EVENTS.has(event);
}

/** The only events whose handlers may carry `additionalContextLimit` at all. */
const ADDITIONAL_CONTEXT_EVENTS = new Set<CodexHookEvent>([
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'UserPromptSubmit',
  'SubagentStart',
]);

// codex 0.154.0 hashes a JSON number's source text (`1.0` ≠ `1`, `1e3` ≠ `1000`), which `JSON.parse` discards, so
// hooks files are parsed with a reviver that boxes each number with its literal. A plain number falls back to
// `String`, exact only when the literal was already in JS spelling.

const RAW_NUMBER = Symbol.for('nanoclaw.codexHookTrust.rawNumber');

interface BoxedNumber {
  [RAW_NUMBER]: string;
  valueOf(): number;
}

function boxNumber(value: number, source: string): BoxedNumber {
  return { [RAW_NUMBER]: source, valueOf: () => value };
}

function isBoxedNumber(value: unknown): value is BoxedNumber {
  return typeof value === 'object' && value !== null && typeof (value as BoxedNumber)[RAW_NUMBER] === 'string';
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (isBoxedNumber(value)) return value.valueOf();
  return null;
}

function numberSource(value: number | BoxedNumber): string {
  return isBoxedNumber(value) ? value[RAW_NUMBER] : String(value);
}

/** Falls back to a plain parse where the reviver gets no `source`, losing exactness for non-JS-spelled literals. */
export function parseHooksJsonPreservingNumbers(text: string): unknown {
  return JSON.parse(text, function reviver(this: unknown, _key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === 'number' && typeof context?.source === 'string') return boxNumber(value, context.source);
    return value;
  });
}

interface CodexCommandHookHandler {
  type: 'command';
  command: string;
  commandWindows?: string | null;
  timeout?: number | BoxedNumber | null;
  async?: boolean;
  statusMessage?: string | null;
  additionalContextLimit?: number | BoxedNumber | null;
}

interface CodexMcpToolHookHandler {
  type: 'mcp_tool';
  server: string;
  tool: string;
  input?: Record<string, unknown>;
  timeout?: number | BoxedNumber | null;
  statusMessage?: string | null;
}

export type CodexHookHandler = CodexCommandHookHandler | CodexMcpToolHookHandler;

interface CodexHookGroup {
  matcher?: string | null;
  hooks?: unknown[];
}

export interface CodexHookTrustEntry {
  key: string;
  hash: string;
}

/**
 * Integers past 2^53 get no trust entry rather than a rounded hash; the spawn-time `hooks/list` check then reports
 * the handler by name. Throwing instead would let one third-party plugin take a container down.
 */
function hashableInteger(value: unknown): boolean {
  const numeric = numberValue(value);
  if (numeric === null || !Number.isSafeInteger(numeric)) return false;
  // A literal that does not round-trip through the parsed value is one JSON.parse rounded.
  if (isBoxedNumber(value) && value[RAW_NUMBER] !== String(numeric)) return false;
  return true;
}

function normalizeTimeout(event: CodexHookEvent, timeout: number | BoxedNumber | null | undefined): number {
  const declared = numberValue(timeout);
  if (event === 'SessionEnd' || event === 'Interrupt') {
    const raw = declared ?? SESSION_END_DEFAULT_TIMEOUT_SEC;
    return Math.min(Math.max(raw, 1), SESSION_END_MAX_TIMEOUT_SEC);
  }
  return Math.max(declared ?? DEFAULT_TIMEOUT_SEC, 1);
}

/**
 * PRESENCE is everything: `command` is raw (before `${PLUGIN_ROOT}` expansion), `command_windows` never appears,
 * `timeout` and `async` always do, and `statusMessage`/`additionalContextLimit` only when set (the limit only on
 * ADDITIONAL_CONTEXT_EVENTS and when it differs from the default).
 */
function normalizeCommandHandler(
  event: CodexHookEvent,
  handler: CodexCommandHookHandler,
): Record<string, unknown> | null {
  if (handler.timeout !== undefined && handler.timeout !== null && !hashableInteger(handler.timeout)) return null;
  const normalized: Record<string, unknown> = {
    type: 'command',
    command: handler.command,
    timeout: normalizeTimeout(event, handler.timeout),
    async: handler.async === true,
  };
  if (handler.statusMessage !== undefined && handler.statusMessage !== null) {
    normalized.statusMessage = handler.statusMessage;
  }
  const limit = handler.additionalContextLimit;
  if (limit !== undefined && limit !== null && ADDITIONAL_CONTEXT_EVENTS.has(event)) {
    if (!hashableInteger(limit)) return null;
    const value = numberValue(limit)!;
    if (value !== DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT) normalized.additionalContextLimit = value;
  }
  return normalized;
}

/**
 * codex 0.154.0 hashes a number inside `mcp_tool` `input` as a TOML table
 * `{ "$serde_json::private::Number" = "<literal>" }` (serde_json's private token leaks through the TOML
 * conversion); strings and booleans hash as themselves.
 */
const SERDE_JSON_PRIVATE_NUMBER = '$serde_json::private::Number';

/**
 * The literal codex stores (measured on 0.154.0): fraction and trailing zeros survive, an unsigned exponent gains
 * `+`, `E` is lowercased, and an integer `-0` becomes `0` (a float `-0.0` does not). BigInt keeps integers exact.
 */
function normalizeNumberLiteral(source: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?)(\d+))?$/.exec(source);
  if (!match) return null;
  const [, sign, integer, fraction, exponentSign, exponentDigits] = match;
  if (fraction === undefined && exponentDigits === undefined) return String(BigInt(`${sign}${integer}`));
  const exponent = exponentDigits === undefined ? '' : `e${exponentSign || '+'}${exponentDigits}`;
  return `${sign}${integer}${fraction === undefined ? '' : `.${fraction}`}${exponent}`;
}

function encodeMcpToolInputValue(value: unknown): unknown | null {
  if (typeof value === 'number' || isBoxedNumber(value)) {
    const numeric = numberValue(value)!;
    if (!Number.isFinite(numeric)) return null;
    // A plain number past 2^53 is already rounded, so refuse it; a boxed one carries its exact literal.
    if (!isBoxedNumber(value) && Number.isInteger(numeric) && !Number.isSafeInteger(numeric)) return null;
    const literal = normalizeNumberLiteral(numberSource(value as number | BoxedNumber));
    if (literal === null) return null;
    return { [SERDE_JSON_PRIVATE_NUMBER]: literal };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const encoded = encodeMcpToolInputValue(item);
      if (encoded === null && item !== null) return null;
      out.push(encoded);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const encoded = encodeMcpToolInputValue(item);
      if (encoded === null && item !== null) return null;
      out[key] = encoded;
    }
    return out;
  }
  return value;
}

/**
 * `input` has no `skip_serializing_if`, so an omitted `input` hashes as an empty table. The McpTool variant has no
 * `async` or `additionalContextLimit`.
 */
function normalizeMcpToolHandler(
  event: CodexHookEvent,
  handler: CodexMcpToolHookHandler,
): Record<string, unknown> | null {
  if (handler.timeout !== undefined && handler.timeout !== null && !hashableInteger(handler.timeout)) return null;
  const rawInput = handler.input && typeof handler.input === 'object' ? handler.input : {};
  const input = encodeMcpToolInputValue(rawInput);
  if (input === null) return null;
  const normalized: Record<string, unknown> = {
    type: 'mcp_tool',
    server: handler.server,
    tool: handler.tool,
    input,
    timeout: normalizeTimeout(event, handler.timeout),
  };
  if (handler.statusMessage !== undefined && handler.statusMessage !== null) {
    normalized.statusMessage = handler.statusMessage;
  }
  return normalized;
}

/**
 * `null` when codex would not load the handler (`prompt`/`agent`, `mcp_tool` on SessionEnd) or an integer cannot be
 * hashed exactly. A skipped handler still consumes its index in codex's key numbering.
 */
function normalizeHandler(event: CodexHookEvent, handler: CodexHookHandler): Record<string, unknown> | null {
  if (handler.type === 'command') {
    return typeof handler.command === 'string' && handler.command.trim() ? normalizeCommandHandler(event, handler) : null;
  }
  if (handler.type === 'mcp_tool') {
    if (event === 'SessionEnd') return null;
    const { server, tool } = handler;
    if (typeof server !== 'string' || !server.trim() || typeof tool !== 'string' || !tool.trim()) return null;
    return normalizeMcpToolHandler(event, handler);
  }
  return null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function codexHookTrustHash(
  event: CodexHookEvent,
  handler: CodexHookHandler,
  matcher?: string | null,
): string | null {
  const normalized = normalizeHandler(event, handler);
  if (!normalized) return null;
  const identity: Record<string, unknown> = {
    event_name: EVENT_KEYS[event],
    hooks: [normalized],
  };
  if (matcher !== undefined && matcher !== null && MATCHER_EVENTS.has(event)) identity.matcher = matcher;
  const serialized = JSON.stringify(canonicalize(identity));
  const hex = crypto.createHash('sha256').update(Buffer.from(serialized)).digest('hex');
  return `sha256:${hex}`;
}

/**
 * Key: `<keySource>:<event_key>:<groupIndex>:<handlerIndex>`, keySource being the absolute hooks.json path or
 * `<plugin>@<marketplace>:<relative path>`. Indices are file positions including handlers codex refuses, so this
 * walk must never filter or reorder.
 */
export function collectCodexHookTrustEntries(
  keySource: string,
  hooksBlock: Record<string, unknown> | undefined,
): CodexHookTrustEntry[] {
  const entries: CodexHookTrustEntry[] = [];
  if (!hooksBlock || typeof hooksBlock !== 'object') return entries;
  for (const [eventName, rawGroups] of Object.entries(hooksBlock)) {
    if (!isCodexHookEvent(eventName) || !Array.isArray(rawGroups)) continue;
    rawGroups.forEach((rawGroup, groupIndex) => {
      const group = rawGroup as CodexHookGroup;
      const handlers = Array.isArray(group?.hooks) ? group.hooks : [];
      handlers.forEach((rawHandler, handlerIndex) => {
        const handler = rawHandler as CodexHookHandler;
        if (!handler || typeof handler !== 'object') return;
        const hash = codexHookTrustHash(eventName, handler, group?.matcher);
        if (!hash) return;
        entries.push({
          key: `${keySource}:${EVENT_KEYS[eventName]}:${groupIndex}:${handlerIndex}`,
          hash,
        });
      });
    });
  }
  return entries;
}

/**
 * Must use the shared escaper: one raw control byte in a plugin's hook filename makes codex drop the whole config,
 * guard chain included.
 */
function tomlQuotedKey(key: string): string {
  return `"${escapeTomlBasicStringBody(key)}"`;
}

export const HOOK_TRUST_MARKER = '# --- nanoclaw hook trust ---';

/** Sorted, last-writer-wins on a duplicate key: codex rejects a duplicate table. */
function dedupeTrustEntries(entries: readonly CodexHookTrustEntry[]): Map<string, string> {
  const deduped = new Map<string, string>();
  for (const entry of entries) deduped.set(entry.key, entry.hash);
  return new Map([...deduped.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * What a post-write read-back must assert. Hashes alone are wrong both ways: identical handlers share one hash
 * across keys, and the dedupe drops a duplicate key's second hash.
 */
export function codexHookTrustTables(entries: readonly CodexHookTrustEntry[]): string[] {
  return [...dedupeTrustEntries(entries)].map(
    ([key, hash]) => `[hooks.state.${tomlQuotedKey(key)}]\ntrusted_hash = "${hash}"`,
  );
}

export function renderCodexHookTrustBlock(entries: readonly CodexHookTrustEntry[]): string {
  if (entries.length === 0) return '';
  const lines = [HOOK_TRUST_MARKER, ''];
  for (const table of codexHookTrustTables(entries)) {
    lines.push(...table.split('\n'));
    lines.push('');
  }
  return lines.join('\n');
}

/** Local copy of `parseTomlTableHeader` from `./codex-app-server.ts`, to avoid an import cycle. */
function tableHeader(line: string): string | null {
  const match = line.match(/^\s*\[(.+)\]\s*$/);
  return match ? match[1].trim() : null;
}

function stripHookTrust(toml: string): string {
  const out: string[] = [];
  let inTrustBlock = false;
  for (const line of toml.split('\n')) {
    if (line.trim() === HOOK_TRUST_MARKER) continue;
    const header = tableHeader(line);
    if (header !== null) {
      inTrustBlock = header === 'hooks.state' || header.startsWith('hooks.state.');
      if (inTrustBlock) continue;
    }
    if (!inTrustBlock) out.push(line);
  }
  const collapsed = out.filter((line, i) => line !== '' || out[i - 1] !== '');
  return collapsed.join('\n').trimEnd();
}

/**
 * Rewrites rather than merges: every container config.toml is generated, and a hook whose command changed must stop
 * being trusted under its old hash.
 */
export function mergeCodexHookTrustIntoToml(toml: string, entries: readonly CodexHookTrustEntry[]): string {
  const base = stripHookTrust(toml);
  const block = renderCodexHookTrustBlock(entries);
  if (!block) return base ? `${base}\n` : '';
  return [base, '', block].filter((part, i) => i !== 0 || part).join('\n');
}

// An offline hash only agrees with itself and codex drift shows up only as silence, so the entries are also
// checked against the running binary.

/**
 * Needs both `enabled` and trusted/managed: an `enabled = false` state row leaves a handler trusted but
 * undispatched.
 */
export function isCodexHookDispatchable(entry: CodexHookListEntry): boolean {
  const status = (entry.trustStatus ?? '').toLowerCase();
  return entry.enabled === true && (status === 'trusted' || status === 'managed');
}

export interface CodexHookTrustProblem {
  key: string;
  trustStatus: string;
  enabled: boolean;
  /** `null` for a hooks.json handler, `<plugin>@<marketplace>` for a plugin's. */
  pluginId: string | null;
  /** `hooks/list` discovers hook files per cwd, so a non-generated row is not necessarily a plugin's. */
  source: string | null;
  reason: 'missing' | 'not-dispatchable';
}

export interface CodexHookTrustVerdict {
  /** Fatal: generated handlers (the guard chain) missing from `hooks/list` or undispatchable. */
  generated: CodexHookTrustProblem[];
  /** Reported, not fatal: one odd third-party plugin must not take a container down. */
  plugin: CodexHookTrustProblem[];
  generatedOk: string[];
}

function toTrustProblem(
  entry: CodexHookListEntry,
  key: string,
  reason: CodexHookTrustProblem['reason'],
): CodexHookTrustProblem {
  return {
    key,
    trustStatus: entry.trustStatus ?? 'absent',
    enabled: entry.enabled === true,
    pluginId: typeof entry.pluginId === 'string' ? entry.pluginId : null,
    source: typeof entry.source === 'string' ? entry.source : null,
    reason,
  };
}

/** Walks the expected keys, so an empty listing (hooks off, file unread) fails rather than passing. */
export function classifyCodexHookList(
  listed: readonly CodexHookListEntry[],
  expectedGeneratedKeys: readonly string[],
): CodexHookTrustVerdict {
  const byKey = new Map<string, CodexHookListEntry>();
  for (const entry of listed) {
    if (typeof entry.key === 'string') byKey.set(entry.key, entry);
  }

  const expected = new Set(expectedGeneratedKeys);
  const generated: CodexHookTrustProblem[] = [];
  const generatedOk: string[] = [];
  for (const key of expected) {
    const entry = byKey.get(key);
    if (!entry) {
      generated.push({
        key,
        trustStatus: 'absent',
        enabled: false,
        pluginId: null,
        source: null,
        reason: 'missing',
      });
    } else if (!isCodexHookDispatchable(entry)) {
      generated.push(toTrustProblem(entry, key, 'not-dispatchable'));
    } else {
      generatedOk.push(key);
    }
  }

  const plugin: CodexHookTrustProblem[] = [];
  for (const [key, entry] of byKey) {
    if (expected.has(key)) continue;
    if (!isCodexHookDispatchable(entry)) plugin.push(toTrustProblem(entry, key, 'not-dispatchable'));
  }

  return { generated, plugin, generatedOk };
}

export function formatCodexHookTrustProblem(problem: CodexHookTrustProblem): string {
  const who = problem.pluginId ? ` plugin=${problem.pluginId}` : problem.source ? ` source=${problem.source}` : '';
  return `${problem.key} (${problem.reason}, trustStatus=${problem.trustStatus}, enabled=${problem.enabled}${who})`;
}

// Plugin hooks are trusted: the mount is operator-curated and read-only, and the Claude provider already runs
// these same hooks unconditionally.

/** `<plugin>@<marketplace>` — the `plugin_id.as_key()` half of a plugin key. */
export interface CodexPluginHookSource {
  pluginId: string;
  dir: string;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = parseHooksJsonPreservingNumbers(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Also the `source_relative_path` half of the state key. */
const DEFAULT_PLUGIN_HOOKS_FILE = 'hooks/hooks.json';

/**
 * `null` where codex discards the declaration: empty, not `./`-prefixed, any `..` component, or absolute. The file
 * read keeps `\\` literally (POSIX) while the key replaces it with `/`, as codex does.
 */
export function resolveDeclaredPluginHookPath(declared: unknown): { readPath: string; keySuffix: string } | null {
  if (typeof declared !== 'string' || declared.length === 0) return null;
  if (!declared.startsWith('./')) return null;
  const relative = declared.slice(2);
  if (!relative) return null;
  // POSIX rules: in a Linux container codex splits on `/` alone, so `\` is an ordinary filename byte.
  if (relative.split('/').some((component) => component === '..')) return null;
  if (relative.startsWith('/')) return null;
  return { readPath: relative, keySuffix: relative.replace(/\\/g, '/') };
}

export interface CodexPluginHookBlock {
  /** A relative file path, or `plugin.json#hooks[<index>]` for an inline manifest block. */
  keySuffix: string;
  hooks: Record<string, unknown> | undefined;
}

/**
 * Mirrors codex 0.154.0's `resolve_manifest_hooks`: a path or path array (invalid entries dropped), an inline
 * object or object array (keyed `plugin.json#hooks[i]`), else the conventional file, which is a fallback only when
 * nothing resolves. Only `.codex-plugin/plugin.json` is read; a `hooks` field in the Claude manifest is ignored.
 */
export function resolvePluginHookBlocks(pluginDir: string): CodexPluginHookBlock[] {
  const readFileBlock = (resolved: { readPath: string; keySuffix: string }): CodexPluginHookBlock | null => {
    const parsed = readJson(path.join(pluginDir, resolved.readPath));
    const hooks = parsed?.hooks;
    // codex drops a file whose `hooks` is absent or empty before recording a source, so it yields no key.
    if (!hooks || typeof hooks !== 'object' || Object.keys(hooks).length === 0) return null;
    return { keySuffix: resolved.keySuffix, hooks: hooks as Record<string, unknown> };
  };
  const conventional = (): CodexPluginHookBlock[] => {
    if (!fs.existsSync(path.join(pluginDir, DEFAULT_PLUGIN_HOOKS_FILE))) return [];
    const block = readFileBlock({ readPath: DEFAULT_PLUGIN_HOOKS_FILE, keySuffix: DEFAULT_PLUGIN_HOOKS_FILE });
    return block ? [block] : [];
  };

  const manifest = readJson(path.join(pluginDir, '.codex-plugin', 'plugin.json'));
  const raw = manifest?.hooks;

  // Untagged serde enum tried in order Path → Paths → Inline → InlineList → Invalid, so a mixed array such as
  // `["./a.json", { … }]` is Invalid and loads the conventional file.
  const isHooksFile = (entry: unknown): boolean => entry !== null && typeof entry === 'object' && !Array.isArray(entry);
  const inlineEntries: unknown[] | null =
    isHooksFile(raw) && !('length' in (raw as object))
      ? [raw]
      : Array.isArray(raw) && raw.length > 0 && raw.every(isHooksFile)
        ? raw
        : null;
  if (inlineEntries) {
    // `{}` and `{"hooks":{}}` are valid inline declarations that load nothing, so there is no fallback.
    const blocks: CodexPluginHookBlock[] = [];
    inlineEntries.forEach((entry, index) => {
      const hooks = (entry as { hooks?: unknown }).hooks;
      if (!hooks || typeof hooks !== 'object' || Object.keys(hooks).length === 0) return;
      blocks.push({ keySuffix: `plugin.json#hooks[${index}]`, hooks: hooks as Record<string, unknown> });
    });
    return blocks;
  }

  const declared = typeof raw === 'string' ? [raw] : Array.isArray(raw) && raw.every((e) => typeof e === 'string') ? raw : null;
  if (declared === null) return conventional();
  const resolved = declared
    .map(resolveDeclaredPluginHookPath)
    .filter((entry): entry is { readPath: string; keySuffix: string } => entry !== null);
  if (resolved.length === 0) return conventional();
  return resolved.map(readFileBlock).filter((block): block is CodexPluginHookBlock => block !== null);
}

/** Inline declarations have no file and are omitted. */
export function declaredPluginHookFiles(pluginDir: string): string[] {
  return resolvePluginHookBlocks(pluginDir)
    .map((block) => block.keySuffix)
    .filter((suffix) => !suffix.startsWith('plugin.json#'));
}

export function collectPluginHookTrustEntries(source: CodexPluginHookSource): CodexHookTrustEntry[] {
  const entries: CodexHookTrustEntry[] = [];
  for (const block of resolvePluginHookBlocks(source.dir)) {
    entries.push(...collectCodexHookTrustEntries(`${source.pluginId}:${block.keySuffix}`, block.hooks));
  }
  return entries;
}
