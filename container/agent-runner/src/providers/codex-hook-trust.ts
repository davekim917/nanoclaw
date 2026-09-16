/**
 * Codex hook TRUST entries for the generated container `config.toml`.
 *
 * Codex ≥0.154 will not RUN a hook it does not trust. `hooks/list` reports
 * `trustStatus: "untrusted"` for every hook whose identity hash has no
 * matching `[hooks.state."<key>"] trusted_hash` entry in `config.toml`, and
 * the handler is simply never dispatched — the discovery loop only pushes a
 * handler when `trust_status` is `Managed | Trusted`
 * (codex-rs `hooks/src/engine/discovery.rs:664-716`). There is no RPC to grant
 * trust, and a `-c hooks.state...` override does not take.
 *
 * A flag that LOOKS like a bypass exists, and an earlier revision of this
 * comment wrongly said there was none: `--dangerously-bypass-hook-trust`
 * ("Run enabled hooks without requiring persisted hook trust for this
 * invocation"), a global option and also an option of `codex exec`.
 * `codex app-server --dangerously-bypass-hook-trust` is rejected outright.
 *
 * It does not work for this path, which was MEASURED rather than assumed
 * before choosing (full table on PR #827). With no trust entry, a PreToolUse
 * handler did not fire under app-server with the global flag, under any of
 * four spellings and placements of a `bypassHookTrust` request override,
 * under both together, or under `codex exec` with the flag in either
 * position — while the same handler, same home, same probe, DID fire as soon
 * as an entry from this module was written. So these entries are not a
 * preference over the flag; they are the only mechanism observed to dispatch
 * the guard chain under app-server, which is the only path containers use.
 *
 * Two traps, recorded because each yields a false pass: the app-server
 * silently accepts unknown params, so an override being "accepted" on
 * `thread/start` is no evidence it exists; and `hooks/list` still reports
 * `untrusted` with the flag set, so it cannot be the oracle either. The
 * oracle has to be whether the handler actually ran. Why the flag is inert
 * here is #838, and nothing in this file depends on the answer.
 *
 * That makes this file load-bearing for the container guard chain: NanoClaw
 * generates `hooks.json` (`buildCodexHooksJson` in `./codex-app-server.ts`)
 * carrying the PreToolUse/PostToolUse destructive-action guard, and without a
 * matching trust entry the guard silently never fires. Hooks failing OPEN and
 * SILENTLY is the whole reason the entries are computed here rather than left
 * to an interactive trust prompt no container can answer.
 *
 * The hash is a fingerprint of the NORMALIZED hook identity, not of the file
 * bytes (codex-rs `hooks/src/engine/discovery.rs:742-791` → `hook_hash`,
 * `config/src/fingerprint.rs:53-84` → `version_for_toml`):
 *
 *   sha256(compact, recursively key-sorted JSON of
 *     { event_name, matcher?, hooks: [ <normalized handler> ] })
 *
 * The Rust side builds that value through `TomlValue::try_from`, which is why
 * every `None` field disappears from the hashed document — TOML has no null.
 * `normalizeCommandHandler` below reproduces exactly that set of omissions.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { type CodexHookListEntry, escapeTomlBasicStringBody } from './codex-app-server.js';

/**
 * hooks.json event keys, in the PascalCase spelling Codex reads.
 *
 * All twelve of codex 0.154.0's `HOOK_EVENT_NAMES` (`hooks/src/lib.rs`).
 * `PermissionRequest` was missing and its handlers therefore got no trust entry
 * at all — they loaded and reported `untrusted`, which is this module's silent
 * failure reached by omission rather than by a wrong hash.
 */
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

/**
 * PascalCase hooks.json key → the snake_case `event_name` that goes into the
 * hashed identity AND into the state key (`hook_event_key_label`). Both halves
 * use the same spelling; a mismatch produces a well-formed entry that matches
 * nothing.
 */
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

/**
 * The events whose `matcher` survives into the hashed identity — codex's
 * `HOOK_EVENT_NAMES_WITH_MATCHERS` (`hooks/src/lib.rs`), applied by
 * `matcher_pattern_for_event` (`hooks/src/events/common.rs:112-128`) BEFORE
 * `hook_hash` sees the group.
 *
 * For `UserPromptSubmit`, `Stop` and `Interrupt` codex replaces the declared
 * matcher with `None`, so hashing the declared value produces a well-formed
 * entry that matches nothing: codex reports the handler `modified` and never
 * dispatches it. Measured on a real 0.154.0 — a `Stop` hook with a matcher
 * received this module's old hash while codex had normalized the matcher away.
 */
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

/** Default hook timeout for every event except SessionEnd/Interrupt. */
const DEFAULT_TIMEOUT_SEC = 600;
/** SessionEnd/Interrupt get their own (much shorter) default and a hard cap. */
const SESSION_END_DEFAULT_TIMEOUT_SEC = 1;
const SESSION_END_MAX_TIMEOUT_SEC = 3;
/**
 * `additionalContextLimit` equal to the default is normalized away before
 * hashing (`discovery.rs:556-557`), so an explicit 2500 and an absent value
 * hash identically.
 */
const DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT = 2500;
/** Whether a declared matcher reaches the hash for this event. */
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

/** A `"type": "command"` handler as it appears in a hooks.json group. */
export interface CodexCommandHookHandler {
  type: 'command';
  command: string;
  commandWindows?: string | null;
  timeout?: number | null;
  async?: boolean;
  statusMessage?: string | null;
  additionalContextLimit?: number | null;
}

/**
 * A `"type": "mcp_tool"` handler (`HookHandlerConfig::McpTool`,
 * codex-rs `config/src/hook_config.rs:186-196`).
 *
 * `input` carries `#[serde(default)]` and NO `skip_serializing_if`, so unlike
 * the `Option` fields it is present in the hashed document even when empty.
 */
export interface CodexMcpToolHookHandler {
  type: 'mcp_tool';
  server: string;
  tool: string;
  input?: Record<string, unknown>;
  timeout?: number | null;
  statusMessage?: string | null;
}

export type CodexHookHandler = CodexCommandHookHandler | CodexMcpToolHookHandler;

export interface CodexHookGroup {
  matcher?: string | null;
  hooks?: unknown[];
}

/** One `[hooks.state."<key>"]` row. */
export interface CodexHookTrustEntry {
  key: string;
  hash: string;
}

/**
 * Is this a value we can hash EXACTLY as codex received it?
 *
 * `timeout` is a `u64` and `additionalContextLimit` a `usize` on the Rust side,
 * and codex retains the declared integer before hashing. `JSON.parse` rounds
 * anything past 2^53, so a declaration of `9007199254740993` reaches this module
 * as `9007199254740992` and the digests diverge — the handler loads, reads back
 * `untrusted`, and is silently never dispatched.
 *
 * So a value outside the safe-integer range is REFUSED rather than hashed
 * rounded: the handler simply gets no trust entry. That is the same end state as
 * a wrong hash, but it is reached deliberately and it is visible — the spawn-time
 * `hooks/list` check reports an undispatchable plugin handler by name. Throwing
 * instead would take a container down over one absurd value in one third-party
 * plugin, which is the over-broad-guard class this repo has been bitten by.
 */
function hashableInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function normalizeTimeout(event: CodexHookEvent, timeout: number | null | undefined): number {
  if (event === 'SessionEnd' || event === 'Interrupt') {
    const raw = typeof timeout === 'number' ? timeout : SESSION_END_DEFAULT_TIMEOUT_SEC;
    return Math.min(Math.max(raw, 1), SESSION_END_MAX_TIMEOUT_SEC);
  }
  return Math.max(typeof timeout === 'number' ? timeout : DEFAULT_TIMEOUT_SEC, 1);
}

/**
 * The handler shape that actually gets hashed. Field order is irrelevant (the
 * canonicalizer sorts keys); PRESENCE is everything.
 *
 * - `command` is the RAW string, before `${PLUGIN_ROOT}` expansion: the Rust
 *   side clones `command` into the hashed config and only then folds the env
 *   substitutions into a separate copy (`discovery.rs:562-577`).
 * - `command_windows` is resolved into `command` on non-Windows and then set
 *   to `None`, so it never appears.
 * - `timeout` is always present (`Some(timeout_sec)`), normalized.
 * - `async` is a plain `bool`, so it is ALWAYS present — `false` included.
 * - `statusMessage` / `additionalContextLimit` are `Option`s: present only
 *   when set (and, for the limit, only on the five events that can emit
 *   additional context and only when it differs from the default).
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
    if (limit !== DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT) normalized.additionalContextLimit = limit;
  }
  return normalized;
}

/**
 * serde_json's PRIVATE number token, which codex 0.154.0 leaks into the hash.
 *
 * `input` is a `serde_json::Map`, and the identity is hashed by converting the
 * whole document to a `toml::Value` first. serde_json's `Number` serializes
 * itself as a one-field struct with this magic key whenever the target
 * serializer is not serde_json, and toml's does not special-case it — so a
 * number inside `input` becomes a TOML TABLE `{ "$serde_json::private::Number" =
 * "1" }` and reaches `canonical_json` in that shape.
 *
 * Not a guess. Measured against the real binary, five values in one run: `0`,
 * `1`, `2` and `1.5` under key `a`, plus `1` under key `b`, all five digests
 * reproduced exactly by this encoding and by nothing else tried (a plain JSON
 * number, `1.0`, a string, an array, a nested table, and a TOML-rendered string
 * were each ruled out). Strings and booleans inside `input` are NOT affected and
 * hash as themselves — which is why this gap hid: the obvious fixture uses a
 * string.
 */
const SERDE_JSON_PRIVATE_NUMBER = '$serde_json::private::Number';

/**
 * Re-encode an `input` value the way codex's toml round-trip does.
 *
 * Returns `null` when the value cannot be hashed exactly — an integer past
 * `Number.MAX_SAFE_INTEGER`, which `JSON.parse` has already rounded by the time
 * this module sees it (same hazard as `timeout`; see `hashableInteger`).
 * Non-integer numbers are serialized with `String`, which is the shortest
 * round-trip form and matches serde_json for every value a plugin realistically
 * declares.
 */
function encodeMcpToolInputValue(value: unknown): unknown | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) return null;
    return { [SERDE_JSON_PRIVATE_NUMBER]: String(value) };
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
 * The `mcp_tool` counterpart. Same `Option`-disappears rule, one difference
 * worth naming: `input` is a plain map with `#[serde(default)]` and no
 * `skip_serializing_if`, so it is ALWAYS in the hashed document — an omitted
 * `input` hashes as an empty table, not as an absent field.
 *
 * `async` and `additionalContextLimit` never appear: the McpTool variant has
 * neither field (`config/src/hook_config.rs:186-196`).
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
 * Normalize whichever handler variant this is, or `null` when codex would not
 * load it at all (`prompt` and `agent` are recorded as unsupported and skipped,
 * `mcp_tool` on `SessionEnd` likewise — `discovery.rs`), or when a declared
 * integer cannot be hashed exactly.
 *
 * A skipped handler still CONSUMES its index: codex enumerates the whole group
 * and `continue`s, so the key of every later handler depends on it
 * (`append_matcher_groups`, `discovery.rs:502-655`).
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

/** Recursively sort object keys — `canonical_json` in `fingerprint.rs:67-84`. */
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

/**
 * Trust hash for ONE handler under ONE event, or `null` when codex would not
 * load the handler (see `normalizeHandler`).
 *
 * `matcher` is included only when the group declares one AND the event keeps it:
 * codex runs `matcher_pattern_for_event` before `hook_hash`, so a matcher on
 * `UserPromptSubmit`, `Stop` or `Interrupt` is `None` by the time the identity
 * is built. Beyond that it is an `Option<String>`, which disappears from the
 * TOML document when absent.
 */
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
 * Walk a hooks-file `hooks` block and emit one trust entry per handler codex
 * will load.
 *
 * `keySource` is the prefix Codex builds the state key from: the ABSOLUTE
 * hooks.json path for a file hook, or `<plugin>@<marketplace>:<relative path>`
 * for a plugin hook (`hook_key`, `hooks/src/lib.rs:113-123`). The suffix is
 * `:<event_key>:<groupIndex>:<handlerIndex>`.
 *
 * INDICES ARE POSITIONS IN THE FILE AS WRITTEN, including handlers codex
 * refuses to load: `append_matcher_groups` enumerates the whole group and
 * `continue`s past a `prompt`/`agent`/malformed entry, so skipping one here
 * without consuming its index would shift the key of every handler after it.
 * This walk must therefore never filter or reorder — it emits nothing for a
 * handler it cannot hash and moves on.
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
 * Quote a state key as a TOML basic string (keys carry `/`, `:`, `@`, `.`).
 *
 * Through the SHARED encoder, never a second local one. A state key embeds the
 * plugin's own relative hook filename, and codex 0.154.0 accepts a plugin whose
 * manifest declares a name carrying any legal Linux byte — a form feed
 * included. TOML forbids raw C0/DEL inside a basic string, and codex answers
 * one such byte with "Invalid configuration; using defaults" and then starts
 * anyway: `hooks/list` returns nothing, and the PreToolUse/PostToolUse guard
 * chain this whole module exists to make live disappears along with the
 * plugin's hook. So an escape set that stops at `\t` is not a cosmetic gap — it
 * is a plugin-supplied input that silently removes the destructive-action
 * guard, which is `docs/review-notes/822.md`'s registered
 * `unescaped interpolation` class exactly.
 */
function tomlQuotedKey(key: string): string {
  return `"${escapeTomlBasicStringBody(key)}"`;
}

export const HOOK_TRUST_MARKER = '# --- nanoclaw hook trust ---';

/**
 * Deterministic order, and last-writer-wins on a duplicate key so the block can
 * never emit the same table twice (codex rejects a duplicate table).
 */
function dedupeTrustEntries(entries: readonly CodexHookTrustEntry[]): Map<string, string> {
  const deduped = new Map<string, string>();
  for (const entry of entries) deduped.set(entry.key, entry.hash);
  return new Map([...deduped.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The exact two-line table each trust entry renders as.
 *
 * This is what a post-write read-back must look for, and it is derived from the
 * SAME dedupe as the renderer so the two cannot disagree. Asserting on the hash
 * alone would be wrong in both directions: two identical handlers under
 * different keys share one hash, so a committed file that lost one of their
 * tables would still pass; and a duplicate key carrying a different hash is
 * dropped by the dedupe above, so its hash would be reported missing from a
 * file that is in fact correct.
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

/**
 * Parse a TOML table header. Local copy of `parseTomlTableHeader` from
 * `./codex-app-server.ts` (same greedy grammar, same reason) so this module
 * has no import cycle with the file that calls it.
 */
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
 * Replace the `[hooks.state.*]` tables in `toml` with exactly `entries`.
 *
 * NanoClaw OWNS hook trust in a container: every config.toml a container reads
 * is generated (`buildContainerCodexConfig` host-side,
 * `CONTAINER_CODEX_CONFIG_BASE` container-side), so there is no operator-
 * curated trust state to preserve, and rewriting rather than merging is what
 * makes a hook whose command changed stop being trusted under its old hash.
 */
export function mergeCodexHookTrustIntoToml(toml: string, entries: readonly CodexHookTrustEntry[]): string {
  const base = stripHookTrust(toml);
  const block = renderCodexHookTrustBlock(entries);
  if (!block) return base ? `${base}\n` : '';
  return [base, '', block].filter((part, i) => i !== 0 || part).join('\n');
}

// ── runtime verification (hooks/list) ──────────────────────────────────────
// Everything above computes what SHOULD be trusted, offline. An offline hash
// asserting itself proves only that this file agrees with this file — and every
// way the reproduction can drift (a codex normalization change, an uncovered
// hook shape, a rewrite that drops the entries) produces the same silence: the
// handler loads, reports `untrusted`, is never dispatched, and the app-server
// starts anyway. So the entries are also CHECKED against the running binary.

/**
 * Codex dispatches a handler only when `enabled && trust_status ∈ {Managed,
 * Trusted}` (`hooks/src/engine/discovery.rs:713-718`; `bypass_hook_trust` is
 * the third disjunct and is inert on this path — see this file's header). Both
 * halves matter: a `[hooks.state."<key>"] enabled = false` row leaves a handler
 * `trusted` and still undispatched (`hook_enabled`, `discovery.rs:813-815`).
 */
export function isCodexHookDispatchable(entry: CodexHookListEntry): boolean {
  const status = (entry.trustStatus ?? '').toLowerCase();
  return entry.enabled === true && (status === 'trusted' || status === 'managed');
}

/** One handler that loaded but will never fire, with why. */
export interface CodexHookTrustProblem {
  key: string;
  trustStatus: string;
  enabled: boolean;
  /** `null` for a hooks.json handler, `<plugin>@<marketplace>` for a plugin's. */
  pluginId: string | null;
  /**
   * The listing's own `source` word — `"plugin"`, `"user"`, or whatever codex
   * labels a project-local `.codex/hooks.json` with. Carried so the log does
   * not call a project-local hook a plugin: `hooks/list` discovers hook files
   * PER CWD, so the non-generated rows are not all plugin rows.
   */
  source: string | null;
  reason: 'missing' | 'not-dispatchable';
}

export interface CodexHookTrustVerdict {
  /**
   * Handlers NanoClaw generated that will not fire — a key that never appeared
   * in `hooks/list` at all (`missing`: the file was not loaded, or the whole
   * hooks feature is off) or one that appeared undispatchable. FATAL: this is
   * the destructive-action guard chain.
   */
  generated: CodexHookTrustProblem[];
  /**
   * Every OTHER handler that will not fire — a mounted plugin's, or a
   * project-local hook file codex discovered under the cwd. REPORTED, not fatal:
   * one oddly-shaped third-party plugin must not take a container down, and the
   * guard core does not depend on any plugin being mounted.
   */
  plugin: CodexHookTrustProblem[];
  /** Generated handlers confirmed dispatchable. */
  generatedOk: string[];
}

// Named away from `describe` on purpose: this file sits next to its bun:test
// suite, and shadowing that global in a grep is a needless trap.
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

/**
 * Compare what `hooks/list` reports against the entries this module wrote.
 *
 * `expectedGeneratedKeys` is the key set from `collectCodexHookTrustEntries`
 * over the generated `hooks.json` — so a handler that vanished from the listing
 * entirely is caught, not just one reporting the wrong status. That is the case
 * a "scan the listing for untrusted rows" check silently passes: with the hooks
 * feature off or the file unread, the listing is EMPTY and every row in it is
 * fine.
 *
 * Plugin rows are whatever else the listing carries. They are classified on the
 * same predicate and returned separately for the caller to log.
 */
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

// ── plugin hooks ───────────────────────────────────────────────────────────
// `/workspace/plugins` is an operator-curated, read-only mount, and the Claude
// provider already runs these same plugins' hooks unconditionally through the
// SDK (`claude.ts` hook pass-through). Leaving them untrusted under Codex is
// therefore not a security posture, just a provider asymmetry — it is why the
// workflow-agents Codex guard and the SessionStart role installer are inert in
// Codex containers today. So NanoClaw trusts them, on the same terms.

/** `<plugin>@<marketplace>` — the `plugin_id.as_key()` half of a plugin key. */
export interface CodexPluginHookSource {
  pluginId: string;
  /** Plugin root on disk, used only to read the declared hooks file. */
  dir: string;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Conventional hooks file Codex loads when a plugin's manifest declares none.
 * The path is also the `source_relative_path` half of the state key.
 */
const DEFAULT_PLUGIN_HOOKS_FILE = 'hooks/hooks.json';

/**
 * Relative hooks-file paths Codex will load for a plugin.
 *
 * Verified against codex-cli 0.154.0 by registering fixture plugins into a
 * scratch CODEX_HOME and reading `hooks/list`:
 *
 * | `.codex-plugin` `hooks` | `.claude-plugin` `hooks` | files present            | loaded             |
 * |-------------------------|--------------------------|--------------------------|--------------------|
 * | `./hooks/d.json`        | —                        | `hooks/d.json`           | `hooks/d.json`     |
 * | `./hooks/d.json`        | —                        | + `hooks/hooks.json`     | `hooks/d.json` only — a declaration REPLACES the default |
 * | absent                  | —                        | `hooks/hooks.json`       | `hooks/hooks.json` |
 * | absent                  | —                        | `hooks/other.json`       | nothing            |
 * | absent                  | `./hooks/d.json`         | `hooks/d.json`           | **nothing**        |
 * | absent                  | `./hooks/d.json`         | + `hooks/hooks.json`     | `hooks/hooks.json` |
 *
 * Two rules, both measured, and the second is the one that is easy to get
 * wrong. The default is a FALLBACK, never an addition — emitting both would
 * write a trust row keyed on a file Codex never reads. And the selecting
 * manifest is `.codex-plugin/plugin.json` ALONE: a `hooks` field in
 * `.claude-plugin/plugin.json` is not read at all, so a plugin whose Codex
 * manifest omits `hooks` takes the conventional fallback even when the Claude
 * manifest declares something else. (The Claude-first acceptance that does
 * exist is for MARKETPLACE manifests — `readCodexMarketplaceName` in
 * `../codex-companion-setup.ts` — not for a plugin's own hooks declaration.)
 *
 * The last two rows are live in this tree: `wwbd@davekim917-bootstrap` ships
 * `hooks/wwbd-hooks.json` declared only in its Claude manifest and no
 * conventional file, and Codex 0.154.0 reports zero hooks for it. Reading the
 * Claude manifest here would key a trust row on that file — harmless in
 * itself, but it would state as covered a hook Codex never loads. Every
 * registerable plugin has a `.codex-plugin/plugin.json` by construction
 * (`readCodexPluginEntryName` is what admits it, for repo roots and monorepo
 * sub-plugins alike), so reading only that manifest loses no plugin.
 */
/**
 * Resolve one declared `hooks` path the way codex's manifest loader does, or
 * `null` when codex would DISCARD it (`resolve_manifest_path`,
 * `core-plugins/src/manifest.rs:597-649`).
 *
 * Four refusals, all of them silent warnings on the codex side:
 *   - empty;
 *   - not prefixed `./` — codex requires it, and this module used to accept a
 *     bare `hooks/x.json`, keying a trust row on a file codex never reads while
 *     suppressing the conventional-file fallback it DOES read;
 *   - a `..` component anywhere — rejected before loading, so a manifest
 *     declaring `../../elsewhere.json` made this module read and hash a file
 *     outside the plugin directory for a key codex never asks about;
 *   - absolute.
 *
 * Returns the path as codex records it in the state key: the declaration minus
 * its `./`, backslashes normalized to `/`.
 */
export function resolveDeclaredPluginHookPath(declared: unknown): string | null {
  if (typeof declared !== 'string' || declared.length === 0) return null;
  if (!declared.startsWith('./')) return null;
  const relative = declared.slice(2);
  if (!relative) return null;
  if (relative.split(/[\\/]/).some((component) => component === '..')) return null;
  if (relative.startsWith('/') || relative.startsWith('\\')) return null;
  return relative.replace(/\\/g, '/');
}

/** One hooks block codex will load for a plugin, with the key-source suffix it uses. */
export interface CodexPluginHookBlock {
  /**
   * The `source_relative_path` half of the state key: a relative file path, or
   * `plugin.json#hooks[<index>]` for a hooks block declared INLINE in the
   * manifest (`load_plugin_hooks`, `core-plugins/src/loader.rs:1191-1243`).
   */
  keySuffix: string;
  /** The `hooks` object itself — from the file, or from the manifest inline. */
  hooks: Record<string, unknown> | undefined;
}

/**
 * Every hooks block codex 0.154.0 will load for this plugin, in its own order.
 *
 * Reproduces `resolve_manifest_hooks` (`core-plugins/src/manifest.rs:413-444`)
 * feeding `load_plugin_hooks` (`core-plugins/src/loader.rs:1191-1243`). The
 * manifest `hooks` field accepts FOUR shapes, and this module previously handled
 * two:
 *
 * | declaration              | loaded                                    |
 * |--------------------------|-------------------------------------------|
 * | `"./a.json"`             | `a.json`                                  |
 * | `["./a.json", "bad"]`    | `a.json` — invalid entries are dropped, the rest stand |
 * | `["bad"]`, `[]`          | NOTHING resolves → the conventional file  |
 * | `{ "hooks": { … } }`     | inline, keyed `plugin.json#hooks[0]`      |
 * | `[{ … }, { … }]`         | inline, keyed `plugin.json#hooks[0]`, `[1]` |
 * | absent, or not one of those | the conventional `hooks/hooks.json`    |
 *
 * The fallback is a FALLBACK, never an addition: a declaration that resolves to
 * anything replaces it. An inline entry whose own `hooks` is empty is skipped
 * but still CONSUMES its index, so a later entry's key depends on it.
 *
 * The selecting manifest is `.codex-plugin/plugin.json` ALONE. A `hooks` field
 * in `.claude-plugin/plugin.json` is not read at all, so a plugin whose Codex
 * manifest omits `hooks` takes the conventional fallback even when the Claude
 * manifest declares something else — measured on 0.154.0, and live in this tree
 * (`wwbd@davekim917-bootstrap` ships `hooks/wwbd-hooks.json` declared only in
 * its Claude manifest and codex reports zero hooks for it).
 */
export function resolvePluginHookBlocks(pluginDir: string): CodexPluginHookBlock[] {
  const readFileBlock = (rel: string): CodexPluginHookBlock | null => {
    const parsed = readJson(path.join(pluginDir, rel));
    const hooks = parsed?.hooks;
    // codex drops a file whose `hooks` is absent or empty before recording a
    // source, so no key is ever derived from it.
    if (!hooks || typeof hooks !== 'object' || Object.keys(hooks).length === 0) return null;
    return { keySuffix: rel, hooks: hooks as Record<string, unknown> };
  };
  const conventional = (): CodexPluginHookBlock[] => {
    if (!fs.existsSync(path.join(pluginDir, DEFAULT_PLUGIN_HOOKS_FILE))) return [];
    const block = readFileBlock(DEFAULT_PLUGIN_HOOKS_FILE);
    return block ? [block] : [];
  };

  const manifest = readJson(path.join(pluginDir, '.codex-plugin', 'plugin.json'));
  const raw = manifest?.hooks;

  // Inline object, or a list of inline objects. Checked BEFORE the string forms
  // because an array can be either, and only its element type tells them apart —
  // the same order codex's untagged enum tries.
  const inlineEntries: unknown[] | null =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? [raw]
      : Array.isArray(raw) && raw.some((entry) => entry !== null && typeof entry === 'object')
        ? raw
        : null;
  if (inlineEntries) {
    const blocks: CodexPluginHookBlock[] = [];
    inlineEntries.forEach((entry, index) => {
      const hooks = (entry as { hooks?: unknown } | null)?.hooks;
      if (!hooks || typeof hooks !== 'object' || Object.keys(hooks).length === 0) return;
      blocks.push({ keySuffix: `plugin.json#hooks[${index}]`, hooks: hooks as Record<string, unknown> });
    });
    return blocks.length > 0 ? blocks : conventional();
  }

  const declared = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  const resolved = declared
    .map(resolveDeclaredPluginHookPath)
    .filter((rel): rel is string => rel !== null);
  if (resolved.length === 0) return conventional();
  return resolved.map(readFileBlock).filter((block): block is CodexPluginHookBlock => block !== null);
}

/**
 * The relative hooks-FILE paths codex will load for this plugin.
 *
 * A narrower view of {@link resolvePluginHookBlocks}, kept because a file path
 * is what an operator can go and look at; an inline declaration has none and is
 * omitted here by construction.
 */
export function declaredPluginHookFiles(pluginDir: string): string[] {
  return resolvePluginHookBlocks(pluginDir)
    .map((block) => block.keySuffix)
    .filter((suffix) => !suffix.startsWith('plugin.json#'));
}

/** Trust entries for every hook Codex will load for this plugin. */
export function collectPluginHookTrustEntries(source: CodexPluginHookSource): CodexHookTrustEntry[] {
  const entries: CodexHookTrustEntry[] = [];
  for (const block of resolvePluginHookBlocks(source.dir)) {
    entries.push(...collectCodexHookTrustEntries(`${source.pluginId}:${block.keySuffix}`, block.hooks));
  }
  return entries;
}
