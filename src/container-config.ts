/**
 * Container config types and access layer.
 *
 * `groups/<folder>/container.json` is the canonical source of truth for every
 * non-DB field (onecliSecrets, tools, credentialFolder, codexHostAuth,
 * dailySummary, etc.) — read by `readContainerConfig`, written by
 * `writeContainerConfig`, modified directly on disk by skills and operators.
 *
 * The `container_configs` table mirrors a subset of operationally-mutated
 * scalars (provider, model, effort, image_tag, assistant_name, skills,
 * mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope) so
 * those fields are addressable via `ncl groups config get/update` and survive
 * across container respawns. `configFromDb` reconstructs ONLY those scalars;
 * it does NOT carry the file-only fields. Any code path that writes the file
 * from DB state alone would silently drop those fields — which is why no such
 * path exists. The DB row is a read-side projection, not an authoritative
 * source for the full config.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import { validateContainerResources, type ContainerResources } from './container-resources.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getContainerConfig, resolveProviderName } from './db/container-configs.js';
import { log } from './log.js';
import { validateExcludePlugins } from './plugin-exclusions.js';
import { TOKEN_SHAPE_PATTERNS } from './secret-scrubber.js';
import { isIanaTimezone } from './timezone.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

/**
 * Per-MCP-server config. Stdio (default) runs a subprocess inside the
 * container; http hits a remote Streamable HTTP URL with credentials injected
 * at the HTTPS_PROXY layer by OneCLI — the container never sees the token.
 * SSE is deprecated and rejected by config validation.
 */
/**
 * Container-side path where a group's stamped plugins are mounted read-only.
 * Lockstep: create-agent.ts records `pluginRoot` under this prefix and
 * container-runner.ts mounts groups/<folder>/plugins here.
 *
 * Not the fork's fleet-wide `~/plugins` -> /workspace/plugins mount, which is
 * operator-curated, live, and shared by every group.
 */
export const CONTAINER_PLUGINS_DIR = '/workspace/agent/plugins';

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig | SseMcpServerConfig;

/**
 * What `parseMcpServerConfig` may produce — the deprecated SSE transport is
 * rejected there, so callers narrowing on `type === 'http'` get a clean
 * two-way discriminated union.
 */
export type ParsedMcpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

export interface StdioMcpServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Working directory in the Agent Plugins fixed forms (./p, ${PLUGIN_ROOT}[/p],
   * ${PLUGIN_DATA}[/p]). For plugin servers the agent-runner (plugin-mcp.ts)
   * resolves it to an absolute container path; providers consume it natively
   * (codex) or via a launch shim (cwd-shim.ts). Without a pluginRoot there is
   * nothing to resolve against, so `validateMcpServers` strips it — the only
   * layer that does; the runtime passes provenance-less servers through
   * untouched. No CLI flag or self-mod tool param exposes it; raw payloads
   * carrying one are rejected at intake (`parseMcpServerConfig`).
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
   * (`ncl groups create --template`). Internal — never CLI input, and never
   * written to container.json: that file IS the spawn-time config here, so the
   * marker would flow into every provider's server map. Ownership is read from
   * the `container_configs.mcp_servers` projection, which every guard site
   * already has in hand.
   */
  plugin?: string;
  instructions?: string;
}

export interface HttpMcpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  /** See StdioMcpServerConfig.plugin — same ownership marker. */
  plugin?: string;
  // Optional always-in-context guidance; host imports into composed CLAUDE.md.
  instructions?: string;
}

export interface SseMcpServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  // Optional always-in-context guidance; host imports into composed CLAUDE.md.
  instructions?: string;
}

/**
 * Query keys that name a credential.
 *
 * Two passes, because one was never enough. Word-bounded matching after
 * camelCase splitting catches `authToken`, `api_key` and `x-auth`, but not
 * the all-lowercase compounds `apikey`, `accesskey` and `authtoken`, which
 * have no boundary to find. So the noun is also matched as a SUFFIX of the
 * whole key: credential names in the wild put it last.
 *
 * Deliberate cost: `monkey` and `turnkey` end in a credential noun and are
 * refused. An earlier revision protected them with word boundaries, which is
 * exactly what let `apikey` through — and nobody passes `?monkey=` to an MCP
 * endpoint, while `?apikey=` is how half the vendors on the internet spell
 * authentication. A false positive costs a clear error message; a false
 * negative writes a credential to container.json.
 *
 * Ordinary query params stay legal: they are endpoint config, not credentials
 * (the install's own `exa` wiring carries `?tools=web_search_exa,...`, and a
 * search endpoint's `?keyword=` is a prefix, not a suffix).
 */
const CREDENTIAL_NOUNS = 'o?auth(orization)?|token|key|secret|passw(or)?d|pwd|credentials?|bearer|jwt|sig(nature)?';
const SECRET_QUERY_WORD_RE = new RegExp(`(^|[_.-])(${CREDENTIAL_NOUNS})([_.-]|$)`, 'i');
const SECRET_QUERY_SUFFIX_RE = new RegExp(`(${CREDENTIAL_NOUNS})$`, 'i');

/** camelCase → snake_case before matching, so `authToken` hits the word list. */
const CAMEL_SPLIT_RE = /([a-z0-9])([A-Z])/g;

/** Whether a query parameter NAME signals a credential. */
export function isCredentialQueryKey(key: string): boolean {
  const normalized = key.replace(CAMEL_SPLIT_RE, '$1_$2');
  return SECRET_QUERY_WORD_RE.test(normalized) || SECRET_QUERY_SUFFIX_RE.test(normalized);
}

/**
 * Server names and env keys end up in provider config writers that emit
 * formats with structural syntax: the codex writer emits TOML table
 * headers, and the Claude SDK collapses any character outside
 * [A-Za-z0-9_-] to `_` when forming MCP tool call prefixes
 * (`mcp__<name>__<tool>`) for permission matching — so unvalidated names
 * can collide. Allowlist the charset at every entry point so no downstream
 * writer has to defend. Mirrored in
 * `container/agent-runner/src/mcp-tools/self-mod.ts`; keep the two in sync.
 */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * `mcpServers[name] = config` at every write site (CLI, `applyAddMcpServer`,
 * `parseTemplateMcpServers`) is a plain-object assignment. `__proto__`,
 * `constructor`, and `prototype` all pass MCP_SERVER_NAME_RE's charset but
 * hit an inherited Object.prototype setter/property instead of creating an
 * own enumerable entry — the server silently vanishes from JSON.stringify
 * while every caller reports success. `nanoclaw` is reserved for a different
 * reason: `container/agent-runner/src/index.ts` seeds a built-in `nanoclaw`
 * MCP server, then layers every `container.json` mcpServers entry on top
 * with the same plain assignment — a static entry named `nanoclaw` would
 * silently replace the built-in and the agent loses its core tools.
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
 * The ONE refusal for every mutation path that writes `mcpServers[name]`:
 * `ncl groups config add/remove-mcp-server` and the self-mod approval apply
 * both call this, so a plugin-stamped entry cannot be overwritten (and its
 * provenance marker dropped) through either door. Plugin-owned entries are
 * template content; the fork has no in-place restamp verb yet (deferred to
 * the templates theme), so the only sanctioned remediation today is editing
 * the plugin itself or explicitly taking manual ownership.
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
 * The ONLY header names a remote MCP server may set to a literal value.
 *
 * This is deliberately an allowlist of configuration, not a denylist of
 * credentials. Two earlier shapes of this rule both leaked, for the same
 * reason: credential header NAMES are an open set (`X-Functions-Key`,
 * `X-Client-Key`, whatever the next vendor ships) and so are credential
 * VALUES (`abc123` is a perfectly good API key and looks like nothing).
 * Neither side can be enumerated, so neither can gate. Configuration headers
 * ARE a small closed set, so that is what gets enumerated, and everything
 * else must be the OneCLI placeholder.
 *
 * A genuinely non-credential vendor header that is missing here is a one-line
 * addition. A credential that is missing from a denylist is a secret on disk.
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
 * The ONLY accepted forms for a credential header: the bare placeholder, or a
 * single auth-scheme token in front of it (`Bearer onecli-managed`,
 * `Key onecli-managed`). A substring test accepted
 * `Bearer real-secret onecli-managed`, which persists the real secret while
 * passing the rule that exists to stop exactly that.
 */
const ONECLI_HEADER_VALUE_RE = new RegExp(`^(?:[A-Za-z][A-Za-z0-9-]* )?${ONECLI_PLACEHOLDER}$`);
/**
 * Prefixes of real credentials that TOKEN_SHAPE_PATTERNS doesn't carry —
 * that list is scoped to shapes worth scrubbing from agent-echoed text
 * (SDK/vendor API keys, bearer tokens, JWTs), not to every credential shape
 * that could reach a URL or header here. A GitHub fine-grained PAT, an AWS
 * access key id, and a PEM key block are exactly as real a leak in a remote
 * MCP URL or header, so they're kept as a small local addition rather than
 * folded into the scrubber (which has no outbound-text reason to carry them).
 */
const MCP_ONLY_SECRET_PREFIX_RE = /(^|\s)(github_pat_|AKIA|-----BEGIN )/;

/**
 * Whether `value` contains a recognizable raw-credential shape that must
 * never be written into container.json — a header value, a URL path
 * segment, or a URL query value, all tested as an isolated string with no
 * surrounding context.
 *
 * TOKEN_SHAPE_PATTERNS (src/secret-scrubber.ts) is imported rather than
 * hand-copied: earlier rounds of review each caught one more prefix missing
 * from a hand-maintained list here (a JWT, then GitLab/Stripe tokens) — the
 * scrubber already carries these shapes for outbound-text redaction, so a
 * future addition there is inherited here automatically instead of costing
 * this file its own review round. Each pattern is rebuilt without the `g`
 * flag before testing: the scrubber's copies are `.replace()`d in a loop and
 * so carry global regexes, and `.test()` on a shared global-flag instance
 * would silently start each check from wherever the previous call's
 * `lastIndex` left off.
 *
 * `?code=eyJ...` in a neutral-named query parameter has no credential-shaped
 * NAME to catch it via `isCredentialQueryKey`, and `looksOpaque` excludes
 * dotted values on purpose, so this is the only net that catches a JWT (or
 * any of these shapes) there.
 */
function isKnownRawSecret(value: string): boolean {
  if (MCP_ONLY_SECRET_PREFIX_RE.test(value)) return true;
  return TOKEN_SHAPE_PATTERNS.some(([re]) => new RegExp(re.source, re.flags.replace('g', '')).test(value));
}
/**
 * A path segment or query value long and mixed enough that it could be a
 * bearer token — or could equally be a tenant id, workspace slug, or build
 * hash. Nothing in the string distinguishes those, which is why this is NOT a
 * rejection rule: a threshold strict enough to catch `/s/<token>/mcp` rejects
 * hosted endpoints that carry a workspace id in the path, and one loose enough
 * to admit those misses short tokens. It drives an explicit warning on the
 * approval card instead, so the human already in the loop is told which
 * segment to look at. The hard rejection stays on shapes we can actually
 * recognize (`isKnownRawSecret`) and on credential-named headers and query
 * keys.
 */
export function looksOpaque(value: string): boolean {
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
 * Validate one `headers` map for a remote MCP server. Returns a fresh copy.
 *
 * Two rules a hand-rolled character check can't safely stand in for, so both
 * defer to the thing that will actually consume this map:
 *
 * - Duplicate names, after lowercasing. HTTP header names are
 *   case-insensitive, so `{ Authorization: "...", authorization: "..." }`
 *   looks like two headers to this plain-object copy but is ONE header on
 *   the wire — `Headers` combines them with a comma
 *   (`Bearer x, Key onecli-managed`), which no longer matches the
 *   placeholder form this function already validated and can leave the
 *   server unauthenticated. Rejected outright rather than merged or
 *   silently overwritten.
 * - Value validity, by constructing `new Headers({ [key]: value })` — the
 *   same constructor the runtime hands the request to, not a maintained
 *   copy of its rules. It throws on control characters (CR/LF/NUL — what
 *   the old hand-written check caught) AND on any code point above U+00FF:
 *   header values are Latin-1 bytes on the wire, not arbitrary Unicode, so
 *   `User-Agent: "测试"` passed a control-character-only check and then
 *   failed when the actual MCP connection tried to send it — the server was
 *   approved and restarted, then unusable.
 *
 * Mirrored as `normalizeMcpHeaders` in
 * `container/agent-runner/src/mcp-tools/self-mod.ts` — there are no shared
 * modules across the host/container boundary; keep the two in sync.
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
    // Allowlisted configuration headers may hold a literal; everything else
    // must be the placeholder, whatever it is named and however short its
    // value. `abc123` is a perfectly good API key, so value length and
    // character mix cannot decide this.
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
 * Parse one CLI, template, or approval payload into the persisted MCP config
 * shape. Exactly one of `command` (local stdio subprocess) or `url` (remote
 * Streamable HTTP) is required.
 *
 * Duplicated in `container/agent-runner/src/mcp-tools/self-mod.ts`
 * (`parseMcpServerInput`) — there are no shared modules across the
 * host/container boundary; keep the two in sync.
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

  if (url !== undefined) {
    if (input.command !== undefined) throw new Error('Provide exactly one of command or url');
    // A declared type that contradicts the fields is a mistake, not something
    // to silently rewrite — the whole point of parsing strictly is that a
    // pasted vendor snippet fails loudly.
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
    // Some vendors put the token in the PATH (a Zapier-style
    // https://host/s/<token>/mcp). The URL is persisted verbatim to
    // container.json and to the approval row, so a credential there is an
    // on-disk secret no amount of card redaction undoes — reject at intake.
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
  // No explicit `type` on the stdio branch: it is the union's default and the
  // pre-existing writers omit it, so emitting one would churn every
  // container.json without changing behavior.
  return {
    command,
    args,
    env,
    ...(cwd === undefined ? {} : { cwd }),
    ...(instructions === undefined ? {} : { instructions }),
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
    // cwd resolves against a plugin root; without provenance nothing can
    // resolve it. This strip is the ONLY layer (the runtime passes
    // provenance-less servers through untouched, per plugin-mcp.ts), and it
    // runs on both the read and write paths since both flow through here.
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
 * Per-group container PRIVILEGE hardening. Absent fields fall back to the
 * safe defaults resolved by `resolveContainerSecurity` (cap-drop ALL,
 * no-new-privileges).
 *
 * Deliberately narrower than upstream's shape: resource ceilings (memory,
 * pids-limit, cpu) are NOT here. This install already owns those in
 * `resources` / `ContainerResources`, resolved by `resolveContainerResources`
 * and emitted by `dockerResourceLimitArgs`. Two places to set one Docker flag
 * is how a spawn ends up with contradictory `--memory` args, so privilege
 * flags live here and resource ceilings live there — one mechanism each.
 */
export interface SecurityConfig {
  /** Linux capabilities to drop. Default `['ALL']`. */
  capDrop?: string[];
  /** Capabilities to add back after the drop. Default none. */
  capAdd?: string[];
  /** Emit `--security-opt no-new-privileges:true`. Default true. */
  noNewPrivileges?: boolean;
}

/**
 * Resolve a declared `security` block against the safe defaults, mirroring
 * `resolveContainerResources`. Single owner of the defaults: `securityArgs`
 * turns this into Docker flags and `ncl groups config get` reports it as
 * `effective_security`, so an audit sees exactly what the spawn will do.
 */
export function resolveContainerSecurity(security?: SecurityConfig): Required<SecurityConfig> {
  return {
    capDrop: security?.capDrop ?? ['ALL'],
    capAdd: security?.capAdd ?? [],
    noNewPrivileges: security?.noNewPrivileges ?? true,
  };
}

/**
 * Explicit Git author and committer identity for one agent group. This is
 * intentionally separate from credentialFolder: siblings may share credentials
 * while retaining attribution that identifies the individual agent.
 */
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

/**
 * Validate the all-or-nothing per-agent Git identity declaration. Git will
 * otherwise silently fall back to a repository or inherited identity, which
 * defeats the point of explicitly configuring attribution for an agent.
 */
export function validateGitIdentity(value: unknown): GitIdentity | undefined {
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

/**
 * Smallest honoured `autoCompactWindow`. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80
 * fires at 80% of the window; below ~100k a large standing-instruction set
 * (~14k tokens on the heaviest group) plus a few tool results would compact every handful
 * of calls, and the session would lose more context to summaries than the
 * window saves.
 */
export const MIN_AUTO_COMPACT_WINDOW = 100_000;

/**
 * Validate the optional `autoCompactWindow` override. Absent means the fleet
 * default; anything present must be an integer token count at or above
 * `MIN_AUTO_COMPACT_WINDOW`. A typo throws, like `validateContainerResources`,
 * rather than silently reading as the 1M default — a lowered window that
 * quietly reverts is a fail-open.
 */
export function validateAutoCompactWindow(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_AUTO_COMPACT_WINDOW) {
    throw new Error(`autoCompactWindow must be an integer token count >= ${MIN_AUTO_COMPACT_WINDOW}`);
  }
  return value;
}

/**
 * `excludePlugins` validation and the covering relation live in
 * `src/plugin-exclusions.ts`, the import-free file the container runs a
 * verbatim copy of (`container/agent-runner/src/plugin-exclusions.ts`), so the
 * host's reading of an entry and each in-container walker's are one
 * implementation. Re-exported here because this module is where every host
 * consumer already reaches for container.json's schema.
 */
export { splitExcludedPlugins, validateExcludePlugins, isExcludedPluginPath } from './plugin-exclusions.js';
export type { ExcludedPlugins } from './plugin-exclusions.js';

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
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

  /**
   * Provider-level model / reasoning effort tracked in the container_configs
   * DB row (upstream's 014 schema). Distinct from the per-group default*
   * fields below — those are intent ("opus" alias resolution); these are
   * what the DB row materializes for ops tooling that scopes via `ncl`.
   */
  model?: string;
  effort?: string;

  /**
   * IANA timezone for this group's container (`TZ` env at spawn) — the zone
   * the agent's own clock and `formatLocalTime` render in. Absent = follow
   * the install-global timezone. Mirrored from `container_configs.timezone`
   * by the `ncl groups create`/`groups config update` write paths, the same
   * dual-write provider/model/effort use.
   */
  timezone?: string;

  /**
   * Claude Code auto-compact window (tokens) for this group's containers —
   * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` at spawn. Absent = the fleet default
   * (1,000,000, the [1m] capacity). Lowering it makes compaction fire earlier
   * and bounds the per-step context a long session carries. Not mirrored to
   * the DB; only the spawn path reads it. docs/specs/quota-burn/plan.md §0.5.
   */
  autoCompactWindow?: number;

  /**
   * Where to route spawns while `provider` is recorded unavailable (an
   * exhausted account, a suspended key). Opt-in per group: with no
   * declaration a provider outage still fails loudly rather than silently
   * changing which model answers a user.
   *
   * A fallback is a deliberate degradation — a different vendor means
   * different failure modes and, for adversarial roles, a loss of the
   * independence the pairing was built for. Groups that care must say so in
   * their own output; this field only keeps them running.
   */
  providerFallback?: {
    provider: string;
    model?: string;
    effort?: string;
  };

  /**
   * Per-group OneCLI secret declaration. Each entry is either a secret
   * NAME (e.g. "Datafold-ExampleRetail") or a UUID. Names resolve via
   * `onecli secrets list` at apply time. When non-empty, the host
   * forces the agent's secret mode to `selective` and assigns exactly
   * these secrets (declarative — replaces any prior assignment).
   *
   * Missing/empty/absent = no-op: agent keeps whatever assignment and
   * mode the operator set via the UI or CLI. Use this when you want a
   * group to have access to only a specific subset of vault secrets
   * (e.g. `example-retail` should not see `Example Labs-*` keys).
   *
   * Hard-fails the container spawn if any declared name doesn't resolve
   * to a vault secret — matches the codebase's fail-closed posture so
   * misconfigurations are loud rather than silently broken.
   */
  onecliSecrets?: string[];

  /**
   * Name of the env var on the host that holds this group's GitHub token.
   * If unset, container-runner derives a name from the folder
   * (`GITHUB_TOKEN_<FOLDER_UPPER>` with dashes as underscores) and falls
   * back to `GITHUB_TOKEN`.
   */
  githubTokenEnv?: string;

  /**
   * Plugin paths under `~/plugins/` to NOT deliver to this group. Plugins
   * under `~/plugins/` are mounted into every container by default (RO at
   * `/workspace/plugins/<name>`). Use this when a group shouldn't have access
   * to a specific plugin — e.g., security-sensitive agents excluding the
   * `codex` plugin to avoid handing them a CLI with the host's Codex OAuth
   * session.
   *
   * Two granularities, one field — and today they reach different distances:
   *   - `"bootstrap"` — a top-level entry. Its mount is never created, so the
   *     plugin is absent from `/workspace/plugins` for every provider.
   *   - `"bootstrap/plugins/orchestrate"` — one sub-plugin of a monorepo whose
   *     other sub-plugins the group keeps. This withholds that sub-plugin's
   *     standing directive from the composed prompt
   *     (`src/claude-md-compose.ts`) and NOTHING ELSE: the repo mounts whole,
   *     so the sub-plugin's skills, manifest and hooks are still reachable in
   *     the container.
   *
   * The gap is deliberate and temporary. Masking the sub-path with an empty
   * bind mount was tried and removed: it required the host to predict what a
   * container's own walkers would resolve, and an absolute symlink inside the
   * repo is absent to a host `statSync` while live once the repo is mounted, so
   * the exclusion silently did not apply. Container-side exclusion lands in a
   * follow-up, where each walker honours this same list in its own namespace.
   *
   * Validated by `validateExcludePlugins` — a malformed entry throws rather
   * than being silently ignored.
   */
  excludePlugins?: string[];

  /**
   * Named MCP servers to suppress for this group. Universal MCPs
   * (granola, deepwiki, context7, exa, pocket) are injected by default
   * in every container; add entries here to opt OUT per group.
   */
  excludeMcpServers?: string[];

  /**
   * When true, expose host Codex auth to the container. For provider=codex,
   * the active `~/.codex` remains a session-local private copy, and the host
   * Codex home is mounted separately as a read-only refresh source so long
   * running containers can heal a stale copied auth.json. For codex-as-peer
   * groups, the host Codex home is mounted directly. SECURITY: read access
   * to auth.json is enough to exfiltrate the OAuth token. Default OFF — opt
   * in only for groups that specifically need Codex host auth (e.g., the Codex
   * agent provider, /codex:rescue use cases). Pre-2026-05-03 the mount was
   * unconditional and RW; the cross-tenant audit forced it opt-in.
   */
  codexHostAuth?: boolean;

  /**
   * When true, mount the host `~/.wix` directory into the container RW so the
   * Wix CLI uses the host's OAuth session (operator ran `wix login` once on the
   * host). RW because the CLI rewrites `~/.wix/auth/account.json` on token
   * refresh. Mounted straight to `/home/node/.wix` via a dedicated path in
   * container-runner — NOT `additionalMounts`, which `validateAdditionalMounts`
   * sandboxes under `/workspace/extra` (where the CLI's `os.homedir()`-based
   * `~/.wix` lookup would never find it). Mirrors `codexHostAuth`. Default OFF.
   */
  wixHostAuth?: boolean;

  /**
   * Ordered list of additional host `~/.codex*` directories to mount as
   * fallback OAuth identities. Each entry is a host path (e.g.
   * `~/.codex`, `~/.codex-other`). At spawn, container-runner resolves
   * `~`, drops entries that lack an `auth.json`, mounts each survivor RW
   * at `/home/node/.codex-fallback-N/`, and forwards
   * `CODEX_FALLBACK_HOMES=/home/node/.codex-fallback-1:/home/node/.codex-fallback-2`.
   *
   * The container's codex provider rotates through these on
   * UsageLimitExceeded / ServerOverloaded / coarse-systemError by
   * copying the active thread's rollout `.jsonl` into the next CODEX_HOME's
   * sessions tree, killing the codex app-server, and respawning under the
   * new CODEX_HOME. Conversation history is preserved (the rollout file
   * is self-contained — codex reconstructs history inline).
   *
   * Inherits the existing `codexHostAuth: true` gate; entries are ignored
   * when host-auth mounting is opt-out.
   */
  codexAuthFallbacks?: string[];

  /**
   * Optional override for the folder used as the lookup key when resolving
   * per-group credentials (LOOKER_*, DBT_*, GITHUB_TOKEN, RENDER_PG_*,
   * GIT_AUTHOR_*, Claude OAuth, Codex auth dir, etc.) via the
   * `<BASE>_<FOLDER_UPPER>` scoped-env convention.
   *
   * Default (when undefined): `agent_groups.folder` is the lookup key, so
   * each group needs its own scoped env vars.
   *
   * Set when a sibling agent group should inherit another group's credentials
   * — most commonly a Codex sibling cloned from a Claude source. Example:
   * `groups/example-retail-codex/container.json` sets
   * `"credentialFolder": "example-retail"` so example-assistant-codex picks up
   * `LOOKER_BASE_URL_EXAMPLE_RETAIL` instead of looking for the non-existent
   * `LOOKER_BASE_URL_EXAMPLE_RETAIL_CODEX`.
   *
   * Does NOT affect identity-bound paths such as container name, group dir
   * mount, and log fields; those stay on `agent_groups.folder`.
   */
  credentialFolder?: string;

  /**
   * Optional author and committer identity for Git commands in this agent's
   * container. Omit it to retain the established credentialFolder-scoped Git
   * environment resolution.
   */
  gitIdentity?: GitIdentity;

  /**
   * Parse-only legacy compatibility data. Retained so old container.json files
   * still deserialize without loss; true and false are behaviorally inert.
   */
  gitnexusInjectAgentsMd?: boolean;

  /**
   * Per-group default model when the agent uses the bare `opus` alias.
   * Resolves the SDK's opus-alias short-circuit ANTHROPIC_DEFAULT_OPUS_MODEL.
   * Overrides the install-wide DEFAULT_OPUS_MODEL constant in
   * container-runner.ts. Per-channel wiring overrides this; per-session
   * `-m <model>` flags override on top of that.
   */
  defaultModel?: string;

  /**
   * Per-group default reasoning effort when the agent doesn't pass
   * `-e <level>`. One of 'low' | 'medium' | 'high' | 'xhigh' | 'max'.
   * Overrides the install-wide DEFAULT_EFFORT constant in
   * container-runner.ts. Per-channel wiring overrides this; per-session
   * `-e <level>` flags override on top of that.
   */
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  /**
   * Per-agent-group default tone profile name (matches a file under
   * `tone-profiles/<name>.md`). Acts as the fallback when a per-channel
   * wiring doesn't set `default_tone` on `messaging_group_agents`.
   */
  tone?: string;

  /**
   * Per-agent credential/tool allowlist. Each entry is either a bare tool
   * name (`snowflake`) or scoped (`snowflake:archive-one`, `aws:example-data`).
   * Omit to grant every credential surface; include to filter per-tool
   * before mount. Supported tool names: gmail, gmail-readonly, calendar,
   * google-workspace, snowflake, aws, gcloud, dbt, github, render, datafold,
   * linear, atlassian, looker, dbt-mcp.
   *
   * This is a FILTER, not a grant — an entry here only permits a surface some
   * other code path mounts or injects. A name that nothing honors is silently
   * inert, so do not read a `tools` entry as evidence that a credential is
   * wired. `browser-auth` was listed here for a long time and never had an
   * implementation: no `isToolEnabled('browser-auth')` call, no `.env` section,
   * no staged `creds/` dir. Groups declaring `browser-auth:<account>` read as
   * though browser credentials were scoped per agent when nothing was
   * delivered; browser logins are supplied by an explicit `additionalMounts`
   * entry or a shared workgroup file instead. Removed 2026-08-07 after it cost
   * a live debugging session.
   */
  tools?: string[];

  /**
   * Per-provider sticky config for the agent that runs in this group.
   * Populated by `create_agent`'s host handler after container-side Zod
   * validation (decision D4 — container is the validation authority).
   * Each provider reads only its own slice.
   *
   * Source of truth for valid keys per provider:
   *   container/agent-runner/src/providers/<name>.ts — see the exported
   *   `<name>ConfigSchema`. Currently:
   *     - 'claude': { model?: string, effort?: 'low'|'medium'|'high'|'xhigh'|'max' }
   *     - 'codex':  { model?: string,
   *                   reasoning_effort?: 'low'|'medium'|'high'|'xhigh'|'max'|'ultra',
   *                   max_concurrent_threads_per_session?: positive integer }
   *     - Others (e.g. opencode, mock): no configSchema — must be empty {}.
   *
   * Provider schemas are the durable source of truth; historical planning
   * artifacts are intentionally not tracked in the public repository.
   */
  providerConfig?: Record<string, unknown>;

  /**
   * Per-group daily summary digest config. The host-side daily-summary timer
   * (src/daily-summary.ts) posts a per-workgroup activity digest once a day.
   * `messagingGroupId` is the explicit opt-in and destination; without it,
   * the workgroup has no digest and the host does not fall back to a primary
   * wired channel.
   */
  dailySummary?: {
    messagingGroupId?: string;
    /**
     * Optional GitHub Issues source for this Codex poster's workgroup backlog,
     * as `owner/repo`. When set, the host summary reads open and recently
     * closed issues from GitHub instead of legacy SQLite backlog rows.
     */
    githubIssuesRepo?: string;
    /**
     * Include the shipped-work sections (🤖 Agent Shipped / 🛠 Other commits)
     * in the digest. Defaults to true. Workgroups whose ship state already
     * lives in a dedicated release channel (a release scrum-master agent)
     * set false so the digest carries only backlog activity.
     */
    shipLog?: boolean;
    /**
     * Include backlog items resolved during the digest window. Defaults to
     * true. Set false when another workflow already reports completed work
     * and this digest should be an open-backlog-only reminder.
     */
    resolved?: boolean;
    /**
     * Include the ranked open-backlog list (parent headline + threaded list).
     * Defaults to true. Set false once the workgroup's backlog lives in a real
     * tracker and is rendered by `backlogCanvas` — the daily repost of a list
     * that barely changes day to day is noise, and the canvas is always current.
     */
    backlog?: boolean;
  };

  /**
   * Per-workgroup live backlog board, rendered into a Slack channel canvas by
   * `src/backlog-canvas.ts`. Presence of `messagingGroupId` is the opt-in — no
   * declaration means no canvas, so other workgroups are unaffected.
   *
   * Declare this on the group whose Slack bot holds the `canvases:write` scope;
   * the canvas is a property of the channel, not of the posting bot, so the
   * choice of writer is invisible to readers.
   */
  backlogCanvas?: {
    /** Destination channel. Its channel_type also selects the bot token. */
    messagingGroupId?: string;
    /** Linear team whose issues the board renders (e.g. "XZO"). */
    linearTeam?: string;
  };

  /**
   * Observatory presentation for this agent's WORKGROUP. Declared on any one
   * member group (same convention as backlogCanvas); the first declaration
   * found wins.
   *
   * `platforms` is an allow-list of channel-type prefixes the office floor
   * shows — `["slack"]` hides a workgroup's dormant Discord wiring without
   * un-wiring it. Absent = show every platform.
   */
  observatory?: {
    platforms?: string[];
    /** Platform ids to keep off the office floor (a canvas the API reports as a channel, a bot-only room). */
    hideRooms?: string[];
  };

  /**
   * The workgroup this agent belongs to. Set by migration 036 and written
   * into container.json for workgroup-scoped retrieval.
   *
   * Value matches workgroups.id (e.g. "example-retail" for both example-retail
   * and example-retail-codex agents).
   */
  workgroup_id?: string;

  /**
   * Slack user-token (xoxp-) MCP capability. When enabled, the agent gets
   * the korotovsky/slack-mcp-server MCP — letting it search/read DMs,
   * channels, threads, and files from the OWNER'S Slack lens.
   *
   * Fail-closed defaults: the capability is auto-scoped to the owner's
   * 1:1 DM with this agent at runtime. Adding the agent to a shared
   * channel does NOT grant teammates the ability to query through it
   * unless the operator explicitly extends `also_allowed_in` with the
   * channel's messaging_group_id.
   *
   * The OneCLI vault must have a token entry for the agent's workspace
   * (e.g., `Slack-User-Token-Example Labs`) assigned via the workgroup's
   * `onecli_secrets`. Without the token, the MCP refuses to register
   * even when `enabled: true` and the gate would allow.
   */
  slack_user_token?: SlackUserTokenConfig;
}

/**
 * Per-agent Slack user-token MCP capability. Wired into containers via the
 * korotovsky/slack-mcp-server binary. The actual token lives in OneCLI vault
 * and is injected at request time — never appears in this config.
 */
export interface SlackUserTokenConfig {
  /**
   * Whether this agent has the Slack user-token MCP at all. When false or
   * unset, the MCP is never registered for this agent. Default false.
   */
  enabled: boolean;

  /**
   * Override allow-list. By default the MCP is only registered when the
   * spawning session is the owner's 1:1 DM with this agent. Add specific
   * `messaging_group_id` values here to allow the capability in additional
   * contexts (e.g., a private channel that's just the owner + trusted
   * collaborators where it's OK to query the owner's lens).
   *
   * Format: messaging_groups.id strings. Use `pnpm exec tsx scripts/q.ts
   * data/v2.db "SELECT id, name FROM messaging_groups"` to find ids.
   */
  also_allowed_in?: string[];

  /**
   * Names (or UUIDs) of the OneCLI secrets that back Slack user-token access
   * for this agent — the credentials that let it read the OWNER's Slack via
   * the proxy (`curl https://slack.com/api/*`) or the MCP. In SHARED sessions
   * (not owner-safe per `also_allowed_in` / owner-DM) these secrets are
   * WITHHELD from the session's OneCLI agent, so neither curl nor the MCP can
   * reach Slack — the boundary is enforced at the credential layer, not just
   * the MCP registration.
   *
   * When unset, the host falls back to a naming convention: any merged
   * OneCLI secret whose name contains both "slack" and "user" (case-
   * insensitive — matches `Slack-User-Token-*`). Set this explicitly when
   * your secret doesn't follow that convention, so the security control
   * doesn't rely on a regex guess. See `slackUserTokenSecrets`.
   */
  onecli_secret_names?: string[];
}

function emptyConfig(): ContainerConfig {
  // tools defaults to `[]` (default-deny) for new groups so a child
  // spawned via create_agent doesn't inherit every credential surface
  // (snowflake, gws, aws, dbt, etc.). Operators add tool entries to
  // explicitly grant credential access. Pre-2026-05-03 this field was
  // omitted, which made `isToolEnabled()` allow every tool — pairing
  // dangerously with create_agent. See cross-tenant audit.
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
 * Decide whether a stored override is honoured — THE predicate, and the only
 * place `isIanaTimezone` is consulted about a stored value. The ncl write path
 * validates and canonicalizes on the way in, but a hand-edited value must not
 * silently flip a group's clock: anything the zone database cannot confirm (a
 * fixed offset, an abbreviation, wrong case, a retired alias, and on a host
 * with no zone database, any id at all) is ignored, exactly as if no override
 * were set.
 */
export function honouredTimezoneOverride(override: string | null | undefined): string | undefined {
  return override && isIanaTimezone(override) ? override : undefined;
}

/**
 * The same verdict expressed as a timezone to use — the honoured override, or
 * `fallback`. `fallback` exists for the one caller with a better default than
 * the config's `TIMEZONE`: the fleet report reads the running service's own
 * `TZ` off its systemd unit.
 */
export function effectiveTimezone(override: string | null | undefined, fallback: string = TIMEZONE): string {
  return honouredTimezoneOverride(override) ?? fallback;
}

/**
 * Effective timezone for an agent group: per-group override → install global.
 * THE resolver — every caller that needs to know which timezone applies to a
 * group goes through here, so the answer is derived in one place: scheduling
 * (cron interpretation, `--process-after`, run-log stamps), recurrence,
 * dashboard assembly and mutations, host-gated task scripts, and the operator
 * scripts under `scripts/`. There is no second lookup of
 * `container_configs.timezone` anywhere.
 *
 * This is the DB side. The container's own `TZ` comes from `container.json`
 * at spawn — mirrored by the same write paths, the identical split
 * provider/model/effort already live under — and reaches the same verdict
 * through `effectiveTimezone`, which the spawn path calls directly because it
 * holds the file value rather than a group id.
 */
export async function resolveGroupTimezone(agentGroupId: string, fallback: string = TIMEZONE): Promise<string> {
  return effectiveTimezone((await getContainerConfig(agentGroupId))?.timezone, fallback);
}

/**
 * Effective agent provider for a group: the AUTHORITATIVE `container.json`,
 * and NEVER from the `container_configs` projection.
 *
 * THE resolver — every caller that needs to know which provider a group
 * actually runs goes through here, for the same reason `resolveGroupTimezone`
 * above exists: the answer must be derived in one place or the copies drift.
 * The file is what the spawn path bind-mounts and what the in-container runner
 * reads; the DB row is a read-side projection for flag vocabulary and image
 * builds, and it CAN lag — a DB-only edit, a restore, an older code path.
 *
 * Reading the projection instead is not a style question, it is a
 * wrong-answer: a group whose row says `claude` while its file still says
 * `codex` is running codex, so a provider-migration audit consulting the row
 * reports "nothing stranded" for a group that has stranded pins, and a bulk
 * repin resolves aliases and validates replacements in the wrong vocabulary.
 * Both of those were found as separate defects at separate call sites before
 * this resolver existed, which is the argument for it.
 *
 * An ABSENT `provider` key resolves to `claude`, not to the projection.
 * That is not a preference — it is what actually boots: the spawn path calls
 * `resolveProviderName(session.agent_provider, containerConfig.provider)` on
 * the file it bind-mounts (`container-runner.ts`), and `resolveProviderName`
 * defaults a missing value to `claude`. Consulting the row for the absent
 * case reintroduces the whole bug one level down: a group with no `provider`
 * key and a stale `codex` row runs Claude, but this resolver would answer
 * `codex`, so `config update --provider codex` reads as a no-op, skips the
 * pin audit entirely, and then writes `codex` into the authoritative file —
 * stranding every Claude pin in exactly the migration this resolver exists
 * to make safe. The resolver must agree with the spawn path even where the
 * spawn path's answer comes from a default rather than from a stored value.
 */
export async function resolveGroupProvider(agentGroupId: string, sessionProvider?: string | null): Promise<string> {
  // Takes the group id ALONE and finds the folder itself. An earlier shape
  // required callers to pass the folder, which is how a resolver acquires a
  // second way to be called wrong — a caller with no folder in hand quietly
  // passes `undefined` and silently gets the projection back, i.e. exactly the
  // bug this exists to prevent, reintroduced by its own signature.
  //
  // `sessionProvider` is the per-session sticky override the MCP scheduling
  // path carries; it outranks both stores when set, unchanged from before.
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
 * Read the container config for a group, returning sensible defaults for
 * any missing fields (or an entirely empty config if the file is absent).
 * Never throws for missing / malformed JSON — corruption logs a warning
 * via console.error and falls back to empty. Unsupported MCP transports fail
 * closed after the file is parsed.
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

  return {
    wikiMaintenance: raw.wikiMaintenance,
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
    codexHostAuth: raw.codexHostAuth,
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

/**
 * Write the container config for a group, creating the groups/<folder>/
 * directory if necessary. Pretty-printed JSON so diffs in the activation
 * flow are reviewable.
 */
export function writeContainerConfig(folder: string, config: ContainerConfig): void {
  validateMcpServers(config.mcpServers ?? {});
  validateContainerResources(config.resources);
  validateGitIdentity(config.gitIdentity);
  validateExcludePlugins(config.excludePlugins);
  const p = configPath(folder);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Apply a mutator function to a group's container config and persist the
 * result. Convenient for append-style changes like `install_packages` and
 * `add_mcp_server` handlers.
 */
export function updateContainerConfig(folder: string, mutate: (config: ContainerConfig) => void): ContainerConfig {
  const config = readContainerConfig(folder);
  mutate(config);
  writeContainerConfig(folder, config);
  return config;
}

/**
 * Initialize an empty container.json for a group if one doesn't already
 * exist. Idempotent — used from `group-init.ts`.
 */
export function initContainerConfig(folder: string): boolean {
  const p = configPath(folder);
  if (fs.existsSync(p)) return false;
  writeContainerConfig(folder, emptyConfig());
  return true;
}
