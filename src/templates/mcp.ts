/**
 * mcp.json reading per the Agent Plugins 1.0.0 MCP component schema.
 *
 * Failure boundaries follow the spec: a missing file is fine; a malformed
 * file (bad JSON, wrong $schema, extra top-level fields) invalidates only the
 * MCP component; an invalid server entry skips only that server. The one
 * deliberate fatal case is a smuggled credential: a value
 * matching a high-confidence secret pattern rejects the whole plugin so a
 * real key never lands in a registry install.
 *
 * FORK NOTE: `parseMcpServerConfig` is stricter than upstream's. It refuses a raw credential in a URL path segment, a
 * credential-named query key, and a credential header on a loopback URL (the OneCLI gateway cannot inject there). A
 * non-configuration header must carry the OneCLI placeholder (`onecli-managed`), not the Agent Plugins literal
 * `placeholder`, which the gateway would not substitute, so such a server is skipped; `placeholder` in `env` is fine.
 * The fatal secret lint runs on the RAW entry BEFORE that parser, so a real credential rejects the whole plugin
 * rather than becoming a per-server skip.
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
const PLACEHOLDER_VALUE = 'placeholder';

/**
 * The Agent Plugins literal and the fork's OneCLI placeholder, which the warn line below tells authors to write.
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

  // CLASS INVARIANT: a plugin whose mcp.json cannot be PROVEN credential-free is never stamped. The whole plugin dir
  // is copied into the agent-readable mount, so a skip still ships the file; an unreadable or unparseable file
  // therefore rejects the plugin instead of degrading to a skip.
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

  // FATAL lint before ANY component-level skip: a skipped component still ships, so a credential under a wrong
  // `$schema` or an unknown key would otherwise reach the agent unlinted.
  lintDocumentCredentials(raw, report);

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
 * Lints the WHOLE parsed mcp.json and throws (whole-plugin rejection) on a real credential. The document, not a walk
 * of recognised entries: every subset scan had an edge that shipped (a credential in `args`, a bare string entry),
 * and the file is copied verbatim into the agent-readable mount.
 */
function lintDocumentCredentials(raw: Record<string, unknown>, report: string[]): void {
  if (isPlainObject(raw.mcpServers)) {
    for (const [name, entry] of Object.entries(raw.mcpServers)) {
      if (!isPlainObject(entry)) continue;
      // A value the lint cannot read is unlintable, not absent.
      for (const kind of ['env', 'headers'] as const) assertLintableValues(name, kind, entry[kind]);
    }
  }
  // `raw`, not `raw.mcpServers`: a credential in a sibling key ships just the same.
  for (const [where, value] of entryStrings(raw)) {
    lintSecrets(where.split('.')[1] ?? 'mcp.json', where, value, report);
  }
}

/** Every string under a value, with a dotted path naming where it came from (`mcpServers.crm.args[0]`). */
function entryStrings(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string') return [[prefix || 'value', value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => entryStrings(item, `${prefix}[${i}]`));
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, child]) => entryStrings(child, prefix ? `${prefix}.${key}` : key));
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
 * Never throws: `lintDocumentCredentials` has already rejected the whole plugin
 * for a smuggled secret before any entry reaches here.
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
 * Stamp-time secret lint. High-confidence known-format matches
 * reject the whole plugin; a secret-looking KEY with an unrecognized value
 * only warns, so ordinary config values never block a legitimate setup.
 */
function lintSecrets(server: string, where: string, value: string, report: string[]): void {
  if (isDeclaredPlaceholder(value)) return;
  // SECRET_VALUE_RE is ^-anchored, so strip a leading auth scheme first: ANY single-token scheme, as the parser
  // accepts, not a fixed list.
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
