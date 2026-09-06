/**
 * mcp.json reading per the Agent Plugins 1.0.0 MCP component schema.
 *
 * Failure boundaries follow the spec: a missing file is fine; a malformed
 * file (bad JSON, wrong $schema, extra top-level fields) invalidates only the
 * MCP component; an invalid server entry skips only that server. The one
 * deliberate fatal case is a smuggled credential (threat #5): a value
 * matching a high-confidence secret pattern rejects the whole plugin so a
 * real key never lands in a registry install.
 *
 * FORK NOTE — this layers on `parseMcpServerConfig`, which is strictly
 * stricter here than upstream's. Three fork rules have no upstream
 * counterpart and all of them still bite through this reader:
 *
 *   - a raw credential in a URL PATH SEGMENT (the Zapier-style
 *     `https://host/s/<token>/mcp`) is refused;
 *   - a credential-named QUERY KEY (`?apikey=`, `?authToken=`) is refused,
 *     via two-pass word + suffix matching;
 *   - a credential header on a LOOPBACK url is refused, because the OneCLI
 *     gateway cannot inject into a container-local endpoint.
 *
 * And the fork's credential-header contract differs from upstream's: a header
 * that is not one of a small closed set of configuration headers must carry
 * the OneCLI placeholder (`onecli-managed`, optionally behind one auth-scheme
 * token), not the Agent Plugins literal `placeholder`. A plugin shipping
 * `Authorization: placeholder` therefore has that ONE server skipped with a
 * named report line — the gateway would not substitute such a header, so
 * accepting it would stamp a server that 401s on first use. `placeholder` in
 * an `env` value is unaffected and accepted, which is where the Agent Plugins
 * convention actually carries weight.
 *
 * Ordering matters: the fatal secret lint runs on the RAW entry, BEFORE the
 * fork's parser, so a real credential is a whole-plugin rejection rather than
 * being downgraded to a per-server skip by the stricter header allowlist.
 */
import fs from 'fs';
import path from 'path';

import {
  isOneCliPlaceholder,
  parseMcpServerConfig,
  validateMcpServerName,
  type ParsedMcpServerConfig,
} from '../container-config.js';
import { SECRET_ENV_KEY_RE, SECRET_VALUE_RE } from '../modules/self-mod/request.js';
import { MCP_SCHEMA_URL } from './manifest.js';

/** The Agent Plugins literal the stamp-time secret lint always accepts. */
export const PLACEHOLDER_VALUE = 'placeholder';

/**
 * Values the lint never questions: the Agent Plugins literal, and this fork's
 * OneCLI placeholder (`onecli-managed`, optionally behind one auth-scheme
 * token). The second is what the warn line below tells authors to write, so
 * warning about it would be advice that contradicts itself.
 */
function isDeclaredPlaceholder(value: string): boolean {
  return value === PLACEHOLDER_VALUE || isOneCliPlaceholder(value);
}

const STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd']);
const HTTP_FIELDS = new Set(['type', 'url', 'headers']);

// Hostnames that reach the Docker host from inside a container. Hygiene, not
// a boundary — the agent's own tools can reach the same endpoints; the real
// boundary is the container network policy.
const HOST_GATEWAY_HOSTS = new Set(['host.docker.internal', 'gateway.docker.internal', '172.17.0.1']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * plugin-data subpaths declared as a server `cwd` (`${PLUGIN_DATA}/sub`).
 * The stamp owns creating these: plugin-data is NanoClaw-managed writable
 * space, so a declared nested cwd must exist before the server first
 * launches or its `cd` fails and the server never boots. `./` and
 * `${PLUGIN_ROOT}` cwds point into the shipped plugin instead — if those
 * directories are missing, that is the plugin's bug.
 */
export function pluginDataCwdSubpaths(servers: Record<string, ParsedMcpServerConfig>): string[] {
  const prefix = '${PLUGIN_DATA}/';
  return Object.values(servers).flatMap((s) =>
    s.type !== 'http' && s.cwd?.startsWith(prefix) ? [s.cwd.slice(prefix.length)] : [],
  );
}

export function readPluginMcp(pluginDir: string): { servers: Record<string, ParsedMcpServerConfig>; report: string[] } {
  const report: string[] = [];
  const file = path.join(pluginDir, 'mcp.json');

  if (fs.existsSync(path.join(pluginDir, '.mcp.json'))) {
    report.push('.mcp.json: ignored (legacy name); rename it to mcp.json');
  }
  if (!fs.existsSync(file)) return { servers: {}, report };

  // CLASS INVARIANT (#500 rounds 2-4): no plugin whose `mcp.json` cannot be
  // PROVEN free of credentials may be stamped. `createAgentFromTemplate` copies
  // the whole plugin directory into the agent-readable
  // `groups/<folder>/plugins/<name>` mount, so every skip below ships the file
  // anyway. A file that cannot be parsed cannot be linted — a trailing comma
  // beside `API_KEY: "sk-…"` would otherwise carry the credential straight to
  // the agent — so an unreadable or unparseable mcp.json rejects the plugin
  // outright rather than degrading to a skip. Skips remain only for shapes the
  // lint has already inspected.
  let raw: unknown;
  // eslint-disable-next-line no-catch-all/no-catch-all -- a malformed template file is expected input, reported as a rejection
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(
      `mcp.json is not valid JSON, so it cannot be checked for credentials before it is copied into the agent's ` +
        `workspace: ${err instanceof Error ? err.message : String(err)}. Fix the syntax and re-stamp.`,
      { cause: err },
    );
  }
  if (!isPlainObject(raw)) {
    throw new Error(
      'mcp.json is not a JSON object, so it cannot be checked for credentials before it is copied into the ' +
        "agent's workspace. It must be an object with $schema and mcpServers.",
    );
  }

  // FATAL lint before ANY component-level skip below. A skipped component
  // still ships: `createAgentFromTemplate` copies the whole plugin directory
  // into the agent-readable `groups/<folder>/plugins/<name>` tree, so a
  // credential sitting in a well-formed entry under a wrong `$schema` or an
  // unknown top-level key would have reached the agent unlinted (Codex on
  // #500). The severity belongs to the credential, whatever else is malformed.
  lintServerCredentials(raw.mcpServers, report);

  if (raw.$schema !== MCP_SCHEMA_URL) {
    report.push(`mcp.json: $schema must be "${MCP_SCHEMA_URL}"; MCP component skipped`);
    return { servers: {}, report };
  }
  const unknownTop = Object.keys(raw).filter((key) => key !== '$schema' && key !== 'mcpServers');
  if (unknownTop.length > 0) {
    report.push(`mcp.json: allows exactly $schema and mcpServers (found "${unknownTop[0]}"); MCP component skipped`);
    return { servers: {}, report };
  }
  if (!isPlainObject(raw.mcpServers)) {
    report.push('mcp.json: mcpServers must be an object; MCP component skipped');
    return { servers: {}, report };
  }

  const servers: Record<string, ParsedMcpServerConfig> = {};
  for (const [name, entry] of Object.entries(raw.mcpServers)) {
    // eslint-disable-next-line no-catch-all/no-catch-all -- rethrown; the catch only annotates which server was fatal
    try {
      const server = readServerEntry(name, entry);
      if (typeof server === 'string') report.push(`mcp.json: server "${name}" skipped: ${server}`);
      else servers[name] = server;
    } catch (err) {
      // Secret rejection is fatal for the whole plugin — rethrow.
      throw err instanceof Error ? new Error(`mcp.json server "${name}": ${err.message}`, { cause: err }) : err;
    }
  }
  return { servers, report };
}

/**
 * Lint every entry's raw `env`/`headers` for smuggled credentials, whatever
 * else is wrong with the file. Throws (whole-plugin rejection) on a real
 * credential; ordinary shape problems are left to the callers below.
 */
function lintServerCredentials(mcpServers: unknown, report: string[]): void {
  if (!isPlainObject(mcpServers)) return;
  for (const [name, entry] of Object.entries(mcpServers)) {
    if (!isPlainObject(entry)) continue;
    for (const kind of ['env', 'headers'] as const) {
      // A value the lint cannot read is unlintable, not absent: `env:
      // { API_KEY: { value: "sk-live-…" } }` would otherwise pass, fail the
      // shape check later, and still ship inside the copied plugin.
      assertLintableValues(name, kind, entry[kind]);
    }
    // EVERY string in the entry, not an enumerated field list. `args`
    // (`["--token", "sk-live-…"]`) reached container.json and the copied
    // mcp.json while only env and headers were scanned (Codex on #500 round
    // 6); enumerating one more field each round is how that recurs. The whole
    // entry ships, so the whole entry is scanned.
    for (const [where, value] of entryStrings(entry)) lintSecrets(name, where, value, report);
  }
}

/**
 * Every string anywhere in a server entry, paired with a dotted path naming
 * where it came from (`args[0]`, `env.API_KEY`, `headers.Authorization`).
 */
function entryStrings(entry: unknown, prefix = ''): [string, string][] {
  if (typeof entry === 'string') return [[prefix || 'value', entry]];
  if (Array.isArray(entry)) return entry.flatMap((item, i) => entryStrings(item, `${prefix}[${i}]`));
  if (isPlainObject(entry)) {
    return Object.entries(entry).flatMap(([key, value]) => entryStrings(value, prefix ? `${prefix}.${key}` : key));
  }
  return [];
}

/** Every value in an `env`/`headers` map must be a string the lint can read. */
function assertLintableValues(server: string, kind: 'env' | 'headers', raw: unknown): void {
  if (raw === undefined) return;
  if (!isPlainObject(raw)) {
    throw new Error(
      `mcp.json server "${server}": ${kind} must be an object of string values — it cannot be checked for ` +
        `credentials otherwise, and the file is copied into the agent's workspace either way.`,
    );
  }
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      throw new Error(
        `mcp.json server "${server}": ${kind}."${key}" is not a string, so it cannot be checked for credentials ` +
          `before the file is copied into the agent's workspace. Use a string, or remove the entry.`,
      );
    }
  }
}

/**
 * Validate one server entry. Returns the parsed config, or a skip reason.
 * Never throws: `lintServerCredentials` has already rejected the whole plugin
 * for a smuggled secret before any entry reaches here (#500 rounds 2-3).
 */
function readServerEntry(name: string, entry: unknown): ParsedMcpServerConfig | string {
  // Shared intake gate: names reach provider config writers with structural
  // syntax (codex TOML table headers), so the charset allowlist applies here
  // exactly as in the approval and ncl paths.
  if (!isPlainObject(entry)) return 'not an object';

  // eslint-disable-next-line no-catch-all/no-catch-all -- a bad server name is expected input, reported as a skip
  try {
    validateMcpServerName(name);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  // The published mcp schema requires a declared transport on every entry.
  const type = entry.type;
  if (type === 'sse') return 'unsupported transport "sse"';
  if (type !== 'stdio' && type !== 'streamable-http') {
    return 'type must be "stdio" or "streamable-http"';
  }

  const allowed = type === 'stdio' ? STDIO_FIELDS : HTTP_FIELDS;
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) return `unknown field "${key}"`;
  }

  let server: ParsedMcpServerConfig;
  // eslint-disable-next-line no-catch-all/no-catch-all -- template authoring errors are expected input errors
  try {
    server = parseMcpServerConfig({ ...entry, type: type === 'streamable-http' ? 'http' : type });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  if (server.type === 'http') {
    const hostname = new URL(server.url).hostname;
    if (HOST_GATEWAY_HOSTS.has(hostname)) return `URL host "${hostname}" reaches the container host; not allowed`;
    return server;
  }

  // command is a single token: a bare executable name or a ./-relative path
  // resolved against PLUGIN_ROOT inside the container. No shell strings, no
  // placeholder expansion in the command itself.
  if (/\s/.test(server.command)) return 'command must be a single token (no shell strings)';
  if (server.command.includes('${')) return 'command does not support ${PLUGIN_ROOT}/${PLUGIN_DATA} expansion';
  if (server.command.startsWith('./')) {
    const segments = server.command.slice(2).split('/');
    if (segments.some((s) => s === '..' || s === '')) return 'command escapes the plugin root';
  } else if (server.command.includes('/') || server.command.includes('\\')) {
    return 'command must be a bare executable name or a ./-relative path';
  }

  for (const key of Object.keys(server.env ?? {})) {
    if (key === 'PLUGIN_ROOT' || key === 'PLUGIN_DATA') {
      return `env must not define "${key}" (the client always sets it)`;
    }
  }
  return server;
}

/**
 * Stamp-time secret lint (threat #5). High-confidence known-format matches
 * reject the whole plugin; a secret-looking KEY with an unrecognized value
 * only warns, so ordinary config values never block a legitimate setup.
 */
function lintSecrets(server: string, where: string, value: string, report: string[]): void {
  if (isDeclaredPlaceholder(value)) return;
  // SECRET_VALUE_RE is ^-anchored, so strip a leading auth scheme first. The
  // surrounding parser accepts ANY single-token scheme, so match that rather
  // than a fixed list — "Key sk-…" hid its credential from a Bearer/Token/Basic
  // list while the parser happily accepted the header (Codex on #500 round 6).
  const bare = value.replace(/^[A-Za-z][A-Za-z0-9-]*\s+/, '');
  if (SECRET_VALUE_RE.test(value) || SECRET_VALUE_RE.test(bare)) {
    throw new Error(
      `${where} looks like a real credential; ship the literal "${PLACEHOLDER_VALUE}" instead ` +
        '(operators supply real values after stamping)',
    );
  }
  const key = where.slice(where.lastIndexOf('.') + 1);
  if (SECRET_ENV_KEY_RE.test(key)) {
    report.push(
      `mcp.json: server "${server}" ${where} has a non-"${PLACEHOLDER_VALUE}" value; ` +
        'if it is a credential, use the placeholder convention',
    );
  }
}
