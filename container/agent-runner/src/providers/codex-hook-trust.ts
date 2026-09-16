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

/** hooks.json event keys, in the PascalCase spelling Codex reads. */
export type CodexHookEvent =
  | 'PreToolUse'
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

export interface CodexHookGroup {
  matcher?: string | null;
  hooks?: unknown[];
}

/** One `[hooks.state."<key>"]` row. */
export interface CodexHookTrustEntry {
  key: string;
  hash: string;
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
function normalizeCommandHandler(event: CodexHookEvent, handler: CodexCommandHookHandler): Record<string, unknown> {
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
  if (typeof limit === 'number' && ADDITIONAL_CONTEXT_EVENTS.has(event) && limit !== DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT) {
    normalized.additionalContextLimit = limit;
  }
  return normalized;
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
 * Trust hash for ONE handler under ONE event. `matcher` is included only when
 * the group declares one (`Option<String>` → absent from the TOML document).
 */
export function codexHookTrustHash(
  event: CodexHookEvent,
  handler: CodexCommandHookHandler,
  matcher?: string | null,
): string {
  const identity: Record<string, unknown> = {
    event_name: EVENT_KEYS[event],
    hooks: [normalizeCommandHandler(event, handler)],
  };
  if (matcher !== undefined && matcher !== null) identity.matcher = matcher;
  const serialized = JSON.stringify(canonicalize(identity));
  const hex = crypto.createHash('sha256').update(Buffer.from(serialized)).digest('hex');
  return `sha256:${hex}`;
}

/**
 * Walk a hooks-file `hooks` block and emit one trust entry per handler.
 *
 * `keySource` is the prefix Codex builds the state key from: the ABSOLUTE
 * hooks.json path for a file hook, or `<plugin>@<marketplace>:<relative path>`
 * for a plugin hook (`discovery.rs:271-290`, `hook_key`). The suffix is
 * `:<event_key>:<groupIndex>:<handlerIndex>` — indices are positions in the
 * file as written, so this walk must not filter or reorder groups.
 *
 * Non-command handlers (`mcp_tool`, `agent`) are skipped: their identity
 * shape differs and NanoClaw generates none.
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
        const handler = rawHandler as CodexCommandHookHandler;
        if (!handler || handler.type !== 'command' || typeof handler.command !== 'string') return;
        if (!handler.command.trim()) return;
        entries.push({
          key: `${keySource}:${EVENT_KEYS[eventName]}:${groupIndex}:${handlerIndex}`,
          hash: codexHookTrustHash(eventName, handler, group?.matcher),
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

export function renderCodexHookTrustBlock(entries: readonly CodexHookTrustEntry[]): string {
  if (entries.length === 0) return '';
  const lines = [HOOK_TRUST_MARKER, ''];
  // Deterministic order, and last-writer-wins on a duplicate key so the block
  // can never emit the same table twice (codex rejects a duplicate table).
  const deduped = new Map<string, string>();
  for (const entry of entries) deduped.set(entry.key, entry.hash);
  for (const key of [...deduped.keys()].sort()) {
    lines.push(`[hooks.state.${tomlQuotedKey(key)}]`);
    lines.push(`trusted_hash = "${deduped.get(key)}"`);
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
export function declaredPluginHookFiles(pluginDir: string): string[] {
  const conventional = (): string[] =>
    fs.existsSync(path.join(pluginDir, DEFAULT_PLUGIN_HOOKS_FILE)) ? [DEFAULT_PLUGIN_HOOKS_FILE] : [];
  const manifest = readJson(path.join(pluginDir, '.codex-plugin', 'plugin.json'));
  if (!manifest) return conventional();
  const raw = manifest.hooks;
  const candidates = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  const files = candidates
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    // The state key carries the path as declared minus a `./` prefix —
    // `hooks/workflow-hooks.json`, not `./hooks/workflow-hooks.json`.
    .map((value) => value.replace(/^\.\//, '').replace(/^\/+/, ''));
  return files.length > 0 ? files : conventional();
}

/** Trust entries for every hook Codex will load for this plugin. */
export function collectPluginHookTrustEntries(source: CodexPluginHookSource): CodexHookTrustEntry[] {
  const entries: CodexHookTrustEntry[] = [];
  for (const rel of declaredPluginHookFiles(source.dir)) {
    const parsed = readJson(path.join(source.dir, rel));
    if (!parsed) continue;
    entries.push(...collectCodexHookTrustEntries(`${source.pluginId}:${rel}`, parsed.hooks as Record<string, unknown>));
  }
  return entries;
}
