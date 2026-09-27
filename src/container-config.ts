/**
 * Container config types and access layer.
 *
 * `groups/<folder>/container.json` is the source of truth except `agentGroupId`/`groupName`, which spawn overwrites
 * from the DB. The `container_configs` row mirrors only the operational scalars (`configFromDb` reconstructs ONLY
 * those), so never write the file from DB state alone: that would silently drop every file-only field.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, TIMEZONE } from './config.js';
import { validateContainerResources, type ContainerResources } from './container-resources.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  getContainerConfig,
  resolveProviderName,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from './db/container-configs.js';
import { withFileLock } from './file-lock.js';
import { log } from './log.js';
import { validateExcludePlugins } from './plugin-exclusions.js';
import { TOKEN_SHAPE_PATTERNS } from './secret-scrubber.js';
import { isIanaTimezone } from './timezone.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

/**
 * Container-side path where a group's stamped plugins are mounted read-only.
 * Lockstep: create-agent.ts records `pluginRoot` under this prefix and
 * container-runner.ts mounts groups/<folder>/plugins here.
 */
export const CONTAINER_PLUGINS_DIR = '/workspace/agent/plugins';

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig | SseMcpServerConfig;

/** SSE is rejected by `parseMcpServerConfig`, so this is a clean two-way union. */
export type ParsedMcpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

interface StdioMcpServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Working directory in the Agent Plugins fixed forms (./p, ${PLUGIN_ROOT}[/p],
   * ${PLUGIN_DATA}[/p]). For plugin servers the agent-runner (plugin-mcp.ts)
   * resolves it to an absolute container path; providers consume it natively
   * (codex) or via a launch shim (cwd-shim.ts). Without a pluginRoot there is
   * nothing to resolve against, so `validateMcpServers` strips it (the only layer that does).
   */
  cwd?: string;
  /**
   * Container-side plugin root (e.g. /workspace/agent/plugins/<name>), set at
   * stamp time for servers that arrived in a plugin. Internal — never part of
   * CLI input. The agent-runner expands ${PLUGIN_ROOT}/${PLUGIN_DATA} against
   * it and injects both env vars when building the provider's server map.
   */
  pluginRoot?: string;
  /**
   * Name of the plugin that stamped this server. Ownership marker: plugin-owned
   * servers reject CLI/self-mod edits and are swapped wholesale on restamp
   * (`ncl groups create --template`). Never CLI input, and never written to container.json (it would flow into
   * every provider's server map); ownership is read from the `container_configs.mcp_servers` projection.
   */
  plugin?: string;
  instructions?: string;
  /** Capability-snapshot label (default: the name, capitalized). Host-only: stripped before reaching a container. */
  displayName?: string;
  /** Capability-list line (default: a generic transport line). Host-only, unlike always-in-context `instructions`. */
  description?: string;
}

interface HttpMcpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  /** See StdioMcpServerConfig.plugin — same ownership marker. */
  plugin?: string;
  // Optional always-in-context guidance; host imports into composed CLAUDE.md.
  instructions?: string;
  /** See StdioMcpServerConfig.displayName. */
  displayName?: string;
  /** See StdioMcpServerConfig.description. */
  description?: string;
}

interface SseMcpServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  // Optional always-in-context guidance; host imports into composed CLAUDE.md.
  instructions?: string;
  /** See StdioMcpServerConfig.displayName. Present for shape symmetry only —
   * `validateMcpServers` refuses an SSE entry before it can be read. */
  displayName?: string;
  /** See StdioMcpServerConfig.description. Present for shape symmetry only. */
  description?: string;
}

/**
 * Query keys that name a credential: word-bounded after camelCase splitting, plus the noun as a SUFFIX of the
 * whole key to catch `apikey`/`accesskey`. Deliberate cost: `monkey`/`turnkey` are refused; a false negative
 * would write a credential to container.json.
 */
const CREDENTIAL_NOUNS = 'o?auth(orization)?|token|key|secret|passw(or)?d|pwd|credentials?|bearer|jwt|sig(nature)?';
const SECRET_QUERY_WORD_RE = new RegExp(`(^|[_.-])(${CREDENTIAL_NOUNS})([_.-]|$)`, 'i');
const SECRET_QUERY_SUFFIX_RE = new RegExp(`(${CREDENTIAL_NOUNS})$`, 'i');

/** camelCase → snake_case before matching, so `authToken` hits the word list. */
const CAMEL_SPLIT_RE = /([a-z0-9])([A-Z])/g;

function isCredentialQueryKey(key: string): boolean {
  const normalized = key.replace(CAMEL_SPLIT_RE, '$1_$2');
  return SECRET_QUERY_WORD_RE.test(normalized) || SECRET_QUERY_SUFFIX_RE.test(normalized);
}

/**
 * Server names and env keys end up in provider config writers that emit
 * formats with structural syntax (TOML headers, `mcp__<name>__<tool>` prefixes), so the charset is allowlisted at
 * every entry point.
 */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * These pass the charset but break plain-object assignment: `__proto__`/`constructor`/`prototype` hit inherited
 * properties (the server silently vanishes), and a `nanoclaw` entry would replace the runner's built-in server.
 */
const RESERVED_MCP_SERVER_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'nanoclaw']);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The Agent Plugins fixed cwd shapes: ./p, ${PLUGIN_ROOT}[/p], ${PLUGIN_DATA}[/p].
const CWD_FORM_RE = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;

/** The owning plugin's name when a stored MCP server entry was stamped from a plugin. */
export function mcpServerPluginOwner(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const plugin = (entry as Record<string, unknown>).plugin;
  return typeof plugin === 'string' && plugin !== '' ? plugin : undefined;
}

/**
 * The ONE refusal for every `mcpServers[name]` write path (CLI and self-mod apply), so a plugin-stamped entry and
 * its provenance marker cannot be overwritten.
 */
export function assertMcpServerNotPluginOwned(entry: unknown, name: string, folder: string): void {
  const owner = mcpServerPluginOwner(entry);
  if (!owner) return;
  throw new Error(
    `MCP server "${name}" is managed by plugin "${owner}"; direct edits are refused. ` +
      `Update it through the plugin, or remove the "plugin" marker for that server in ` +
      `groups/${folder}/container.json to take manual ownership.`,
  );
}

/** RFC 7230 token charset — what a header field-name may contain. */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/**
 * The ONLY header names that may carry a literal value; everything else must be the OneCLI placeholder.
 * Deliberately an allowlist: credential header names and values are open sets, configuration headers are not.
 */
const LITERAL_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'content-type',
  'user-agent',
  'mcp-protocol-version',
  'x-api-version',
  'x-request-id',
]);
/** The value the OneCLI gateway replaces at the proxy boundary. */
const ONECLI_PLACEHOLDER = 'onecli-managed';
/**
 * The bare placeholder or one auth-scheme token before it. A substring test would accept
 * `Bearer real-secret onecli-managed`.
 */
const ONECLI_HEADER_VALUE_RE = new RegExp(`^(?:[A-Za-z][A-Za-z0-9-]* )?${ONECLI_PLACEHOLDER}$`);
/** Real-credential prefixes TOKEN_SHAPE_PATTERNS (scoped to outbound-text scrubbing) does not carry. */
const MCP_ONLY_SECRET_PREFIX_RE = /(^|\s)(github_pat_|AKIA|-----BEGIN )/;

/**
 * A recognizable raw-credential shape (tested on an isolated header value, path segment or query value). Patterns
 * are rebuilt without `g`: `.test()` on the scrubber's shared global regexes would resume from a stale
 * `lastIndex`. The only net for a JWT in a neutral-named query parameter.
 */
function isKnownRawSecret(value: string): boolean {
  if (MCP_ONLY_SECRET_PREFIX_RE.test(value)) return true;
  return TOKEN_SHAPE_PATTERNS.some(([re]) => new RegExp(re.source, re.flags.replace('g', '')).test(value));
}
/**
 * Could be a bearer token or equally a tenant id: nothing distinguishes them, so this drives a warning on the
 * approval card, NOT a rejection.
 */
function looksOpaque(value: string): boolean {
  if (value.length < 16) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(value)).length;
  return classes >= 2 && !/[\s.]/.test(value);
}

/** Path segments and query values of `url` that a human should eyeball. */
export function opaqueUrlParts(url: string): string[] {
  const parsed = new URL(url);
  return [
    ...parsed.pathname.split('/').filter((seg) => looksOpaque(decodeURIComponent(seg))),
    ...[...parsed.searchParams.values()].filter(looksOpaque),
  ];
}

/** Whether a header value is the OneCLI placeholder the gateway substitutes. */
export function isOneCliPlaceholder(value: string): boolean {
  return ONECLI_HEADER_VALUE_RE.test(value);
}

/** Throws unless `name` is a safe MCP server name (1-64 chars of [A-Za-z0-9_-]). */
export function validateMcpServerName(name: string): void {
  if (!MCP_SERVER_NAME_RE.test(name)) {
    throw new Error('server name must be 1-64 characters of letters, digits, "_" or "-"');
  }
  if (RESERVED_MCP_SERVER_NAMES.has(name)) {
    throw new Error(`server name ${JSON.stringify(name)} is reserved`);
  }
}

/**
 * Returns a fresh copy. Duplicate names after lowercasing are rejected (`Headers` would comma-join them into a
 * value that no longer matches the placeholder form). Values are validated by constructing `Headers` itself, the
 * runtime's own rules (control characters, code points above U+00FF).
 */
function normalizeMcpHeaders(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('headers must be a JSON object with string values');
  }
  const seenNames = new Set<string>();
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') throw new Error('headers must be a JSON object with string values');
    if (!HEADER_NAME_RE.test(key)) {
      throw new Error(`header name ${JSON.stringify(key)} is not a valid HTTP header field name`);
    }
    const lowerName = key.toLowerCase();
    if (seenNames.has(lowerName)) {
      throw new Error(
        `header "${key}" duplicates an already-declared header of the same name (HTTP header names are case-insensitive) — Headers combines them into one value on the wire, which can silently break authentication`,
      );
    }
    seenNames.add(lowerName);
    try {
      new Headers({ [key]: value });
    } catch (err) {
      throw new Error(
        `header "${key}" value is not valid for an HTTP header (control characters and any character above U+00FF are rejected by the transport)`,
        { cause: err },
      );
    }
    // Only allowlisted configuration headers may hold a literal; value length or character mix cannot decide this.
    if (!LITERAL_HEADER_ALLOWLIST.has(lowerName) && !ONECLI_HEADER_VALUE_RE.test(value)) {
      throw new Error(
        `header "${key}" is not a known configuration header, so its value must be exactly "${ONECLI_PLACEHOLDER}" or an auth scheme followed by it (e.g. "Bearer ${ONECLI_PLACEHOLDER}") — the gateway substitutes the real secret at the proxy boundary. Configuration headers that carry no credential: ${[...LITERAL_HEADER_ALLOWLIST].join(', ')}`,
      );
    }
    if (isKnownRawSecret(value)) {
      throw new Error(
        `header "${key}" carries a raw credential; declare it as "${ONECLI_PLACEHOLDER}" and let the OneCLI gateway inject the real value`,
      );
    }
    headers[key] = value;
  }
  return headers;
}

/**
 * Exactly one of `command` (stdio) or `url` (Streamable HTTP). The only validator of an agent's `add_mcp_server`
 * request: the container forwards raw fields.
 */
export function parseMcpServerConfig(input: Record<string, unknown>): ParsedMcpServerConfig {
  const declaredType = input.type === undefined ? undefined : String(input.type);
  if (declaredType !== undefined && !['stdio', 'http', 'streamable-http'].includes(declaredType)) {
    throw new Error(`unsupported MCP transport ${JSON.stringify(input.type)}; use "stdio" or "http"`);
  }
  const command = typeof input.command === 'string' && input.command.trim() ? input.command : undefined;
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : undefined;

  const instructions = input.instructions;
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new Error('MCP instructions must be a string');
  }

  // Host-only capability-snapshot metadata, validated at intake.
  const displayName = input.displayName;
  if (displayName !== undefined && (typeof displayName !== 'string' || displayName.trim() === '')) {
    throw new Error('MCP displayName must be a non-empty string');
  }
  const description = input.description;
  if (description !== undefined && typeof description !== 'string') {
    throw new Error('MCP description must be a string');
  }
  const metadata = {
    ...(displayName === undefined ? {} : { displayName: displayName.trim() }),
    ...(description === undefined ? {} : { description }),
  };

  if (url !== undefined) {
    if (input.command !== undefined) throw new Error('Provide exactly one of command or url');
    // A declared type that contradicts the fields fails loudly rather than being rewritten.
    if (declaredType === 'stdio') throw new Error('type "stdio" cannot be used with url; use "http"');
    if (input.args !== undefined || input.env !== undefined || input.cwd !== undefined) {
      throw new Error('args, env, and cwd are only valid with command');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      throw new Error('url must be a valid HTTP(S) URL', { cause: err });
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw new Error('url must use HTTPS (plain HTTP is allowed only for localhost and host.docker.internal)');
    }
    if (parsed.username || parsed.password || parsed.hash) {
      throw new Error('url must not contain credentials or fragments; use the OneCLI gateway for authentication');
    }
    for (const [key, value] of parsed.searchParams) {
      if (isCredentialQueryKey(key)) {
        throw new Error(
          `url query parameter "${key}" looks like a credential; use the OneCLI gateway for authentication`,
        );
      }
      if (isKnownRawSecret(value)) {
        throw new Error(
          `url query parameter "${key}" carries a raw credential; use the OneCLI gateway for authentication`,
        );
      }
    }
    // A credential in the PATH (e.g. https://host/s/<token>/mcp) would persist verbatim to container.json and the
    // approval row: reject at intake.
    for (const segment of parsed.pathname.split('/')) {
      if (isKnownRawSecret(decodeURIComponent(segment))) {
        throw new Error(
          'url path carries a raw credential; use the OneCLI gateway for authentication rather than a secret in the URL',
        );
      }
    }
    const headers = input.headers === undefined ? undefined : normalizeMcpHeaders(input.headers);
    if (loopback && headers && Object.values(headers).some(isOneCliPlaceholder)) {
      throw new Error(
        'placeholder headers are not allowed for local MCP servers because the OneCLI gateway cannot inject credentials',
      );
    }
    return {
      type: 'http',
      url,
      ...(headers === undefined || Object.keys(headers).length === 0 ? {} : { headers }),
      ...(instructions === undefined ? {} : { instructions }),
      ...metadata,
    };
  }
  if (command === undefined) throw new Error('Provide exactly one of command or url');
  if (input.url !== undefined) throw new Error('Provide exactly one of command or url');
  if (declaredType !== undefined && declaredType !== 'stdio') {
    throw new Error(`type ${JSON.stringify(declaredType)} cannot be used with command; use "stdio" or omit it`);
  }
  if (input.headers !== undefined) throw new Error('headers are only valid with url');

  const args = input.args ?? [];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new Error('args must be a JSON array of strings');
  }
  const rawEnv = input.env ?? {};
  if (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv)) {
    throw new Error('env must be a JSON object with string values');
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value !== 'string') throw new Error('env must be a JSON object with string values');
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`env key ${JSON.stringify(key)} must be a valid environment variable name`);
    }
    env[key] = value;
  }
  const cwd = parseCwd(input.cwd);
  // No explicit `type` on stdio: emitting one would churn every container.json for no behavior change.
  return {
    command,
    args,
    env,
    ...(cwd === undefined ? {} : { cwd }),
    ...(instructions === undefined ? {} : { instructions }),
    ...metadata,
  };
}

/** Accept only the spec's fixed cwd shapes, lexically contained (no ".." segments). */
function parseCwd(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CWD_FORM_RE.test(value)) {
    throw new Error('cwd must be ./path, ${PLUGIN_ROOT}[/path], or ${PLUGIN_DATA}[/path]');
  }
  // rest === '' is the bare form (`${PLUGIN_DATA}`, `./`); empty segments in a
  // non-empty rest are rejected for symmetry with the command validator.
  const rest = value.startsWith('./') ? value.slice(2) : value.replace(CWD_FORM_RE, '');
  if (
    rest.includes('${') ||
    rest.includes('\\') ||
    (rest !== '' && rest.split('/').some((s) => s === '..' || s === ''))
  ) {
    throw new Error('cwd escapes the plugin root');
  }
  return value;
}

export function validateMcpServers(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  for (const [name, server] of Object.entries(servers)) {
    if (server?.type === 'sse') {
      throw new Error(
        `MCP server "${name}" uses deprecated SSE transport. Use Streamable HTTP (type: "http") instead.`,
      );
    }
    // cwd resolves against a plugin root; this strip is the ONLY layer, on both read and write paths.
    if (server && server.type !== 'http' && server.cwd && !server.pluginRoot) {
      delete server.cwd;
      log.warn('Stripping cwd from stored MCP server without plugin provenance', { server: name });
    }
  }
  return servers;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/**
 * Privilege hardening only; defaults via `resolveContainerSecurity`. Resource ceilings deliberately live in
 * `resources` (`dockerResourceLimitArgs`): one Docker flag set in two places yields contradictory args.
 */
export interface SecurityConfig {
  /** Linux capabilities to drop. Default `['ALL']`. */
  capDrop?: string[];
  /** Capabilities to add back after the drop. Default none. */
  capAdd?: string[];
  /** Emit `--security-opt no-new-privileges:true`. Default true. */
  noNewPrivileges?: boolean;
}

/** Single owner of the defaults: `securityArgs` emits them and `ncl groups config get` reports them. */
export function resolveContainerSecurity(security?: SecurityConfig): Required<SecurityConfig> {
  return {
    capDrop: security?.capDrop ?? ['ALL'],
    capAdd: security?.capAdd ?? [],
    noNewPrivileges: security?.noNewPrivileges ?? true,
  };
}

/** Separate from credentialFolder: siblings may share credentials but keep individual attribution. */
export interface GitIdentity {
  name: string;
  email: string;
}

const GIT_IDENTITY_UNSAFE_NAME_RE = /[<>]/;
const GIT_IDENTITY_EMAIL_RE = /^[^\s<>@]+@[^\s<>@]+$/;

function hasGitIdentityControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

/** All-or-nothing: a partial identity lets Git silently fall back to an inherited one. */
function validateGitIdentity(value: unknown): GitIdentity | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('gitIdentity must be an object with non-empty name and email strings');
  }
  const { name, email } = value as Record<string, unknown>;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    typeof email !== 'string' ||
    !email.trim() ||
    GIT_IDENTITY_UNSAFE_NAME_RE.test(name) ||
    hasGitIdentityControlCharacter(name) ||
    hasGitIdentityControlCharacter(email) ||
    !GIT_IDENTITY_EMAIL_RE.test(email)
  ) {
    throw new Error(
      'gitIdentity must set a non-empty name without angle brackets or control characters and an email with one non-empty local and domain part',
    );
  }
  return { name, email };
}

/** Below ~100k, standing instructions plus a few tool results would compact every handful of calls. */
export const MIN_AUTO_COMPACT_WINDOW = 100_000;

/** Absent = fleet default. A typo throws rather than silently reverting to the default (a fail-open). */
function validateAutoCompactWindow(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_AUTO_COMPACT_WINDOW) {
    throw new Error(`autoCompactWindow must be an integer token count >= ${MIN_AUTO_COMPACT_WINDOW}`);
  }
  return value;
}

/** Re-exported from src/plugin-exclusions.ts, which the container runs a verbatim copy of. */
export { splitExcludedPlugins, validateExcludePlugins } from './plugin-exclusions.js';
/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  /** Structured reporting override. Absent is the fleet default; false is rollback. */
  outcomeReporting?: boolean;
  /** Model/effort subtext under replies; ON unless `false`. Read by the runner from the mounted file. */
  statusSubtext?: boolean;
  /** Physical channel addresses whose routine outcomes belong to an existing external reporter. */
  outcomeReportingExternalChannels?: string[];
  /** Host-enrolled wiki actors fail closed if their private policy is absent. */
  wikiMaintenance?: boolean;
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  /** Per-session container resource request and hard ceilings. */
  resources?: ContainerResources;

  /** Per-session container privilege hardening (capabilities, no-new-privileges). */
  security?: SecurityConfig;

  /** What the container_configs row materializes for `ncl` (distinct from the default* intent fields below). */
  model?: string;
  effort?: string;

  /** IANA zone for the container's `TZ`; absent = install timezone. Mirrored from `container_configs.timezone`. */
  timezone?: string;

  /** `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (tokens); absent = fleet default. Not mirrored to the DB. */
  autoCompactWindow?: number;

  /** Opt-in route while `provider` is recorded unavailable; without it an outage fails loudly. */
  providerFallback?: {
    provider: string;
    model?: string;
    effort?: string;
  };

  /**
   * OneCLI secret names or UUIDs. Non-empty: the agent's secret mode is forced to `selective` with exactly these
   * (declarative). Absent/empty: no-op, the operator's assignment stands. An unresolvable name fails the spawn.
   */
  onecliSecrets?: string[];

  /** Host env var holding this group's GitHub token; default `GITHUB_TOKEN_<FOLDER_UPPER>`, then `GITHUB_TOKEN`. */
  githubTokenEnv?: string;

  /**
   * `~/plugins` paths NOT delivered to this group (validated by `validateExcludePlugins`). A top-level entry is
   * never mounted, guard files included (OpenCode's skills still arrive via a mirror filtered only for sub-path
   * entries). A sub-path entry (`"bootstrap/plugins/orchestrate"`) withholds only REGISTRATION: the repo mounts
   * whole, so absolute-path guard files stay, and each walker that would register it skips it via
   * `src/plugin-exclusions.ts`. An entry naming a path this install lacks REFUSES THE SPAWN: an exclusion that
   * matches nothing silently withholds nothing.
   */
  excludePlugins?: string[];

  /** Fleet MCP server names to withhold from this group. */
  excludeMcpServers?: string[];

  /** Mount host `~/.wix` RW for the Wix CLI's OAuth session. Default OFF: one tenant's CLI, no fleet-wide use. */
  wixHostAuth?: boolean;

  /**
   * Host `~/.codex*` dirs mounted as fallback OAuth identities (entries without `auth.json` dropped); the codex
   * provider rotates through them on usage-limit/overload errors, carrying the rollout so history is preserved.
   */
  codexAuthFallbacks?: string[];

  /**
   * Folder used as the `<BASE>_<FOLDER_UPPER>` credential lookup key (default: the group's own folder), so a
   * sibling can inherit its source group's credentials. Identity-bound paths stay on `agent_groups.folder`.
   */
  credentialFolder?: string;

  /** Git author/committer identity; omit to keep credentialFolder-scoped Git env resolution. */
  gitIdentity?: GitIdentity;

  /**
   * Parse-only legacy compatibility data. Retained so old container.json files
   * still deserialize without loss; true and false are behaviorally inert.
   */
  gitnexusInjectAgentsMd?: boolean;

  /**
   * Group default model (NANOCLAW_CLAUDE_MODEL); per-channel wiring and per-session `-m` override it. It does NOT
   * change what the bare `opus` alias resolves to: that stays the install's Opus constant for every group.
   */
  defaultModel?: string;

  /** Group default effort; per-channel wiring and per-session `-e` override it. */
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  /** Tone profile (`tone-profiles/<name>.md`) used when the wiring sets no `default_tone`. */
  tone?: string;

  /**
   * Per-agent credential/tool allowlist (`snowflake`, `snowflake:archive-one`); omit to grant every credential
   * surface. A FILTER, not a grant: an entry only permits a surface some code path actually mounts or injects, so
   * a name nothing honors is silently inert and is no evidence a credential is wired.
   */
  tools?: string[];

  /**
   * Per-provider sticky config, validated container-side (the provider's exported `<name>ConfigSchema` defines
   * the keys). Each provider reads only its own slice; providers without a schema must get `{}`.
   */
  providerConfig?: Record<string, unknown>;

  /** Daily digest; `messagingGroupId` is the opt-in and destination (no fallback to a wired channel). */
  dailySummary?: {
    messagingGroupId?: string;
    /** GitHub `owner/repo` backlog source instead of legacy SQLite rows. */
    githubIssuesRepo?: string;
    /** Shipped-work sections; default true. */
    shipLog?: boolean;
    /** Resolved backlog items; default true. */
    resolved?: boolean;
    /** Ranked open-backlog list; default true. */
    backlog?: boolean;
  };

  /** Slack channel canvas board (src/backlog-canvas.ts); declare it on the group whose bot holds `canvases:write`. */
  backlogCanvas?: {
    /** Destination channel. Its channel_type also selects the bot token. */
    messagingGroupId?: string;
    /** Linear team whose issues the board renders (e.g. "XZO"). */
    linearTeam?: string;
  };

  /**
   * Observatory presentation for this agent's WORKGROUP; the first member declaration found wins. `platforms`
   * allow-lists channel-type prefixes (absent = all).
   */
  observatory?: {
    platforms?: string[];
    /** Platform ids to keep off the office floor (a canvas the API reports as a channel, a bot-only room). */
    hideRooms?: string[];
  };

  /** Matches workgroups.id (shared by an agent and its codex sibling). */
  workgroup_id?: string;

  /**
   * Slack user-token scoping. Fail-closed: the token is injected only in the owner's 1:1 DM; other sessions spawn
   * under the `<group>-noslack` OneCLI identity with it withheld, unless listed in `also_allowed_in`.
   */
  slack_user_token?: SlackUserTokenConfig;
}

/** Per-agent Slack user-token scoping. The token never appears in this config. */
interface SlackUserTokenConfig {
  /**
   * RETIRED, accepted and ignored: it registered the removed Slack MCP. No
   * spawn or capability path reads it; sibling-parity still compares it.
   */
  enabled?: boolean;

  /** messaging_groups.id values where the owner's token may also be injected (beyond the owner DM). */
  also_allowed_in?: string[];

  /**
   * OneCLI secrets backing Slack user-token access, WITHHELD from non-owner-safe sessions. Unset falls back to any
   * merged secret whose name contains both "slack" and "user"; set it explicitly rather than rely on that guess.
   */
  onecli_secret_names?: string[];
}

function emptyConfig(): ContainerConfig {
  // tools defaults to `[]` (default-deny) so a child spawned via create_agent inherits no credential surface.
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    tools: [],
  };
}

function configPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'container.json');
}

/**
 * THE predicate for honouring a stored override: anything the zone database cannot confirm (offsets,
 * abbreviations, wrong case, retired aliases; every id on a host with no zone database) is ignored.
 */
export function honouredTimezoneOverride(override: string | null | undefined): string | undefined {
  return override && isIanaTimezone(override) ? override : undefined;
}

/**
 * The honoured override, or `fallback` (the fleet report passes the service's own systemd `TZ`).
 */
export function effectiveTimezone(override: string | null | undefined, fallback: string = TIMEZONE): string {
  return honouredTimezoneOverride(override) ?? fallback;
}

/**
 * THE resolver: every caller needing a group's timezone goes through here. The spawn path reaches the same verdict
 * via `effectiveTimezone` on the container.json value.
 */
export async function resolveGroupTimezone(agentGroupId: string, fallback: string = TIMEZONE): Promise<string> {
  return effectiveTimezone((await getContainerConfig(agentGroupId))?.timezone, fallback);
}

/**
 * Effective agent provider for a group: the AUTHORITATIVE `container.json`,
 * and NEVER from the `container_configs` projection.
 *
 * THE resolver. The projection CAN lag, and reading it gives wrong answers (e.g. a migration audit reporting
 * nothing stranded). An ABSENT `provider` resolves to `claude`, never to the projection, because that is what the
 * spawn path boots (`resolveProviderName` defaults a missing value to `claude`).
 */
export async function resolveGroupProvider(agentGroupId: string, sessionProvider?: string | null): Promise<string> {
  // Takes the group id ALONE: a folder parameter let callers pass `undefined` and silently get the projection.
  // `sessionProvider` (per-session sticky override) outranks both stores.
  const folder = (await getAgentGroup(agentGroupId))?.folder;
  const fileProvider = folder ? readContainerConfig(folder).provider : undefined;
  // Deliberately the same two arguments the spawn path passes, and no third.
  return resolveProviderName(sessionProvider ?? null, fileProvider);
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  return {
    mcpServers: validateMcpServers(JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>),
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: row.provider ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    timezone: honouredTimezoneOverride(row.timezone),
    security: row.security_json ? (JSON.parse(row.security_json) as SecurityConfig) : undefined,
  };
}

/**
 * Never throws for a missing or malformed file (warns and falls back to empty); unsupported MCP transports fail
 * closed after parsing.
 */
export function readContainerConfig(folder: string): ContainerConfig {
  const p = configPath(folder);
  if (!fs.existsSync(p)) return emptyConfig();

  let raw: Partial<ContainerConfig>;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<ContainerConfig>;
  } catch (err) {
    console.error(`[container-config] failed to parse ${p}: ${String(err)}`);
    return emptyConfig();
  }

  return materializeContainerConfig(raw);
}

/**
 * Read one trustworthy config snapshot for an operator-gated spawn. Unlike the
 * legacy reader, absence, malformed JSON, and symlinks are fatal so a canary
 * fence cannot silently fall back to stale DB identity.
 */
export function readContainerConfigStrict(folder: string): ContainerConfig {
  const p = configPath(folder);
  const stat = fs.lstatSync(p);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe container config: ${p}`);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<ContainerConfig>;
  return materializeContainerConfig(raw);
}

/** Select strict admission reads only while an operator spawn fence is active. */
export function readContainerConfigForSpawn(folder: string, requireAuthoritativeFile: boolean): ContainerConfig {
  return requireAuthoritativeFile ? readContainerConfigStrict(folder) : readContainerConfig(folder);
}

function materializeContainerConfig(raw: Partial<ContainerConfig>): ContainerConfig {
  validateContainerResources(raw.resources);
  if (raw.outcomeReporting !== undefined && typeof raw.outcomeReporting !== 'boolean')
    throw new Error('outcomeReporting must be a boolean when present');

  return {
    wikiMaintenance: raw.wikiMaintenance,
    outcomeReporting: raw.outcomeReporting,
    // Only an explicit `false` opts out; `undefined` keeps the key out of a rewritten container.json.
    statusSubtext: raw.statusSubtext === false ? false : undefined,
    outcomeReportingExternalChannels: Array.isArray(raw.outcomeReportingExternalChannels)
      ? raw.outcomeReportingExternalChannels.filter((value): value is string => typeof value === 'string')
      : [],
    mcpServers: validateMcpServers(raw.mcpServers ?? {}),
    packages: {
      apt: raw.packages?.apt ?? [],
      npm: raw.packages?.npm ?? [],
    },
    imageTag: raw.imageTag,
    additionalMounts: raw.additionalMounts ?? [],
    skills: raw.skills ?? 'all',
    provider: raw.provider,
    groupName: raw.groupName,
    assistantName: raw.assistantName,
    agentGroupId: raw.agentGroupId,
    maxMessagesPerPrompt: raw.maxMessagesPerPrompt,
    resources: raw.resources,
    security: raw.security,
    model: raw.model,
    effort: raw.effort,
    timezone: raw.timezone,
    autoCompactWindow: validateAutoCompactWindow(raw.autoCompactWindow),
    providerFallback: raw.providerFallback,
    githubTokenEnv: raw.githubTokenEnv,
    excludePlugins: validateExcludePlugins(raw.excludePlugins),
    // This projection is an ALLOWLIST: a key with no line here (e.g. the removed `codexHostAuth`) is dropped.
    wixHostAuth: raw.wixHostAuth,
    codexAuthFallbacks: raw.codexAuthFallbacks,
    credentialFolder: raw.credentialFolder,
    gitIdentity: validateGitIdentity(raw.gitIdentity),
    excludeMcpServers: raw.excludeMcpServers,
    gitnexusInjectAgentsMd: raw.gitnexusInjectAgentsMd,
    defaultModel: raw.defaultModel,
    defaultEffort: raw.defaultEffort,
    tone: raw.tone,
    tools: raw.tools,
    providerConfig: raw.providerConfig,
    dailySummary: raw.dailySummary,
    backlogCanvas: raw.backlogCanvas,
    observatory: raw.observatory,
    onecliSecrets: raw.onecliSecrets,
    workgroup_id: raw.workgroup_id,
    slack_user_token: raw.slack_user_token,
  };
}

/** Only an explicit `false` opts out. Operator views must show this AND the stored value (unset ≠ explicitly on). */
export function effectiveStatusSubtext(config: Pick<ContainerConfig, 'statusSubtext'>): boolean {
  return config.statusSubtext !== false;
}

/** Fleet default without materializing it into operator-owned container.json. */
export function effectiveOutcomeReporting(config: Pick<ContainerConfig, 'outcomeReporting'>): boolean {
  return config.outcomeReporting !== false;
}

/**
 * UNLOCKED: every change to an EXISTING config must go through `updateContainerConfig`; this is exported only for
 * seeding a config from whole cloth. Refuses to overwrite a file that is not a JSON object, including unparseable
 * bytes: every caller is read-modify-write over the tolerant reader, which would write its defaulted guess (e.g.
 * no `excludePlugins`) over the operator's file. Consequence: a group with a malformed container.json does not
 * spawn until a person repairs it.
 */
export function writeContainerConfig(folder: string, config: ContainerConfig): void {
  validateMcpServers(config.mcpServers ?? {});
  validateContainerResources(config.resources);
  validateGitIdentity(config.gitIdentity);
  validateExcludePlugins(config.excludePlugins);
  const p = configPath(folder);
  assertOverwritableContainerConfig(p);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // IN PLACE, deliberately NOT write-to-temp-and-rename: the group dir is agent-writable and only a nested RO mount
  // protects this file, so an agent could replace a sibling temp file before the rename and have the host install
  // its bytes as the config. Torn writes are refused by `assertOverwritableContainerConfig` instead.
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
}

/** Throw unless `p` is absent or a JSON object. Absence is distinguished from a failed read, never inferred. */
function assertOverwritableContainerConfig(p: string): void {
  const refuse = (why: string): never => {
    throw new Error(
      `refusing to overwrite ${p}: ${why}, so any field it declares (excludePlugins among them) would be ` +
        'discarded rather than read. Fix the file by hand — nothing here rewrites it for you.',
    );
  };
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    return refuse(`it exists but could not be read (${(err as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse('its contents are not valid JSON');
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return;
  const shape = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
  refuse(`its root is a JSON ${shape}, not an object`);
}

/**
 * A SIDECAR lock under host-only DATA_DIR, never beside the config: the group dir is mounted into the container,
 * where an agent could delete the lock, and `withFileLock` treats a changed lock inode as a hard failure.
 * Stateless; safe to delete while the host is stopped.
 */
export function containerConfigLockPath(folder: string): string {
  return path.join(DATA_DIR, 'locks', 'container-config', `${path.basename(folder)}.lock`);
}

/**
 * THE mutation primitive for an existing `container.json`: the lock (cross-process `flock`, since one writer is a
 * hand-run script) spans read → mutate → write, so no concurrent writer's change (e.g. `excludePlugins`) is
 * silently lost. Keep mutators synchronous and trivial: anything slow blocks every other writer for that group.
 */
export async function updateContainerConfig(
  folder: string,
  mutate: (config: ContainerConfig) => void,
  project?: (config: ContainerConfig) => Promise<void>,
): Promise<ContainerConfig> {
  return withFileLock(
    containerConfigLockPath(folder),
    async () => {
      const config = readContainerConfig(folder);
      mutate(config);
      writeContainerConfig(folder, config);
      // Inside the lock: a projection written after release can land behind a later writer's and go stale.
      await project?.(config);
      return config;
    },
    { label: `container.json for ${folder}` },
  );
}

/**
 * Write scalar config to both stores: the runtime fields to container.json, which the spawn and runner read, and
 * every field to the `container_configs` projection. THE FILE COMMITS FIRST: if one write fails, file-ahead is the
 * recoverable disagreement (the container boots what was asked; the flag vocabulary lags until a re-run), while
 * projection-ahead is indistinguishable from success.
 */
export async function writeContainerConfigScalars(
  agentGroupId: string,
  folder: string,
  updates: Parameters<typeof updateContainerConfigScalars>[1],
): Promise<void> {
  const { provider, model, effort, image_tag, assistant_name, timezone } = updates;
  if (![provider, model, effort, image_tag, assistant_name, timezone].some((v) => v !== undefined)) {
    await updateContainerConfigScalars(agentGroupId, updates);
    return;
  }
  await updateContainerConfig(
    folder,
    (config) => {
      if (provider !== undefined) config.provider = provider ?? undefined;
      if (image_tag !== undefined) config.imageTag = image_tag || undefined;
      if (model !== undefined) config.model = model || undefined;
      if (effort !== undefined) config.effort = effort || undefined;
      if (assistant_name !== undefined) config.assistantName = assistant_name || undefined;
      // null must ERASE the field so the spawn falls back to the install timezone.
      if (timezone !== undefined) config.timezone = timezone ?? undefined;
    },
    () => updateContainerConfigScalars(agentGroupId, updates),
  );
}

/** Edit the package lists in both stores, file first; the projection copies the file's result for the image build. */
export async function writeContainerConfigPackages(
  agentGroupId: string,
  folder: string,
  edit: (packages: ContainerConfig['packages']) => void,
): Promise<ContainerConfig['packages']> {
  const { packages } = await updateContainerConfig(
    folder,
    (config) => {
      if (!config.packages) config.packages = { apt: [], npm: [] };
      edit(config.packages);
    },
    async ({ packages: projected }) => {
      await updateContainerConfigJson(agentGroupId, 'packages_apt', projected.apt);
      await updateContainerConfigJson(agentGroupId, 'packages_npm', projected.npm);
    },
  );
  return packages;
}

/** Idempotent; under the same lock so two concurrent calls cannot both see "absent". */
export async function initContainerConfig(folder: string): Promise<boolean> {
  return withFileLock(
    containerConfigLockPath(folder),
    () => {
      const p = configPath(folder);
      if (fs.existsSync(p)) return false;
      writeContainerConfig(folder, emptyConfig());
      return true;
    },
    { label: `container.json for ${folder}` },
  );
}
