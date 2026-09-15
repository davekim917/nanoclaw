/**
 * Codex hook TRUST entries for the generated container `config.toml`.
 *
 * Codex ≥0.154 will not RUN a hook it does not trust. `hooks/list` reports
 * `trustStatus: "untrusted"` for every hook whose identity hash has no
 * matching `[hooks.state."<key>"] trusted_hash` entry in `config.toml`, and
 * the handler is simply never dispatched — the discovery loop only pushes a
 * handler when `trust_status` is `Managed | Trusted`
 * (codex-rs `hooks/src/engine/discovery.rs:664-716`). There is no bypass flag
 * on `codex app-server`, no RPC to grant trust, and a `-c hooks.state...`
 * override does not take.
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

/** Quote a state key as a TOML basic string (keys carry `/`, `:`, `@`, `.`). */
function tomlQuotedKey(key: string): string {
  const escaped = key
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
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
 * | manifest `hooks` | file present        | loaded |
 * |------------------|---------------------|--------|
 * | `./hooks/d.json` | `hooks/d.json`      | yes    |
 * | `./hooks/d.json` | `hooks/hooks.json`  | NO — a declaration REPLACES the default |
 * | absent           | `hooks/hooks.json`  | yes    |
 * | absent           | `hooks/other.json`  | no     |
 *
 * So the default is a fallback, never an addition — emitting both would write
 * a trust row keyed on a file Codex never reads. `.codex-plugin/plugin.json`
 * wins over `.claude-plugin/plugin.json` (Codex accepts Claude-first
 * manifests — see `readCodexMarketplaceName` in `../codex-companion-setup.ts`).
 */
export function declaredPluginHookFiles(pluginDir: string): string[] {
  for (const manifestRel of [path.join('.codex-plugin', 'plugin.json'), path.join('.claude-plugin', 'plugin.json')]) {
    const manifest = readJson(path.join(pluginDir, manifestRel));
    if (!manifest) continue;
    const raw = manifest.hooks;
    const candidates = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
    const files = candidates
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      // The state key carries the path as declared minus a `./` prefix —
      // `hooks/workflow-hooks.json`, not `./hooks/workflow-hooks.json`.
      .map((value) => value.replace(/^\.\//, '').replace(/^\/+/, ''));
    if (files.length > 0) return files;
  }
  // No declaration anywhere → the conventional file, if the plugin ships one.
  return fs.existsSync(path.join(pluginDir, DEFAULT_PLUGIN_HOOKS_FILE)) ? [DEFAULT_PLUGIN_HOOKS_FILE] : [];
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
