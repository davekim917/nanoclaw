/**
 * Self-modification MCP tools: install_packages, add_mcp_server.
 *
 * Both are fire-and-forget — the tool writes a system action row and returns
 * immediately. The host processes the request (including admin approval)
 * and notifies the agent via a chat message when complete. Admin approval
 * is approval to apply the change: `install_packages` auto-rebuilds the
 * per-agent image and restarts the container; `add_mcp_server` just
 * updates `container.json` and restarts (bun runs TS directly — no build
 * step needed for a pure MCP wiring change).
 *
 * Package names are sanitized here at the tool boundary AND re-validated on
 * the host side (defense in depth).
 */
import { getCentralDb } from '../central-db.js';
import { writeMessageOut } from '../db/messages-out.js';
import { setStickyModel, setStickyEffort } from '../modules/mailbox/index.js';
import { getConfig } from '../config.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

// Mirror of the host flag-parser's OPENCODE_VALID_MODEL_RE (src/flag-parser.ts):
// a well-formed provider-prefixed opencode slug `<provider>/<id…>`. Kept in sync
// by hand — the container can't import the host module (separate tree).
const OPENCODE_MODEL_SLUG_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/i;

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGES = 20;

export const installPackages: McpToolDefinition = {
  tool: {
    name: 'install_packages',
    description:
      'Install apt and/or npm packages into YOUR per-agent container image so they persist for all future turns — use this over a workspace `pnpm install` (which only lasts the current turn) whenever the user asks you to add a capability for good. Requires admin approval; fire-and-forget. On approval, the image is rebuilt and the container is restarted automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        apt: { type: 'array', items: { type: 'string' }, description: 'apt packages to install (names only, no version specs or flags)' },
        npm: { type: 'array', items: { type: 'string' }, description: 'npm packages to install globally (names only, no version specs)' },
        reason: { type: 'string', description: 'Why these packages are needed' },
      },
    },
  },
  async handler(args) {
    const apt = (args.apt as string[]) || [];
    const npm = (args.npm as string[]) || [];
    if (apt.length === 0 && npm.length === 0) return err('At least one apt or npm package is required');
    if (apt.length + npm.length > MAX_PACKAGES) return err(`Maximum ${MAX_PACKAGES} packages per request`);

    const invalidApt = apt.find((p) => !APT_RE.test(p));
    if (invalidApt) return err(`Invalid apt package name: "${invalidApt}". Only lowercase letters, digits, and ._+- allowed.`);
    const invalidNpm = npm.find((p) => !NPM_RE.test(p));
    if (invalidNpm) return err(`Invalid npm package name: "${invalidNpm}". No version specs or shell characters.`);

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'install_packages',
        apt,
        npm,
        reason: (args.reason as string) || '',
      }),
    });

    log(`install_packages: ${requestId} → apt=[${apt.join(',')}] npm=[${npm.join(',')}]`);
    return ok(`Package install request submitted. You will be notified when admin approves or rejects.`);
  },
};

/**
 * Query keys that name a credential. Mirrors the host's `isCredentialQueryKey`
 * (src/container-config.ts).
 *
 * Two passes: word-bounded after camelCase splitting catches `authToken` and
 * `api_key`, and a SUFFIX pass catches the all-lowercase compounds `apikey`,
 * `accesskey`, `authtoken` that have no boundary to find. `monkey` and
 * `turnkey` are refused as a deliberate cost — nobody passes those to an MCP
 * endpoint, while `?apikey=` is how half the internet spells auth.
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
 * Names and env keys reach provider config writers with structural syntax —
 * the codex writer emits TOML table headers, and `mcpAllowPattern` in the
 * Claude provider collapses non-[A-Za-z0-9_-] to `_`, so unvalidated names
 * can collide. Hence a charset allowlist at every entry point.
 */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 7230 token charset — what a header field-name may contain. */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/**
 * The ONLY header names a remote MCP server may set to a literal value.
 * Mirrors the host's `LITERAL_HEADER_ALLOWLIST` (src/container-config.ts).
 *
 * An allowlist of configuration, not a denylist of credentials: credential
 * header names are an open set and so are credential values (`abc123` is a
 * fine API key and looks like nothing), so neither can gate. Configuration
 * headers are a small closed set, so that is what gets enumerated.
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
 * The ONLY accepted forms for a non-allowlisted header: the bare placeholder,
 * or a single auth-scheme token in front of it.
 */
const ONECLI_HEADER_VALUE_RE = new RegExp(`^(?:[A-Za-z][A-Za-z0-9-]* )?${ONECLI_PLACEHOLDER}$`);
/** Shapes of real credentials that must never be written into container.json. */
const RAW_SECRET_VALUE_RE = /(^|\s)(sk-|ghp_|github_pat_|xox[a-z]-|AKIA|-----BEGIN )/;

type ParsedMcpServer =
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { command: string; args: string[]; env: Record<string, string> };

/**
 * Mirrors the host's `parseMcpServerConfig` (src/container-config.ts) — the
 * host re-validates on receipt and again on apply, but this copy answers the
 * agent instantly instead of after an approval round-trip. There are no
 * shared modules across the host/container boundary; keep the two in sync.
 */
function parseMcpServerInput(args: Record<string, unknown>): { config: ParsedMcpServer } | { error: string } {
  const declaredType = args.type === undefined ? undefined : String(args.type);
  if (declaredType !== undefined && !['stdio', 'http', 'streamable-http'].includes(declaredType)) {
    return { error: `unsupported MCP transport ${JSON.stringify(args.type)}; use "stdio" or "http"` };
  }
  const command = typeof args.command === 'string' && args.command.trim() ? args.command : undefined;
  const url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : undefined;

  if (url !== undefined) {
    if (command !== undefined) return { error: 'Provide exactly one of command or url' };
    // A declared type that contradicts the fields is a mistake, not something
    // to silently rewrite.
    if (declaredType === 'stdio') return { error: 'type "stdio" cannot be used with url; use "http"' };
    if (args.args !== undefined || args.env !== undefined) return { error: 'args and env are only valid with command' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: 'url must be a valid HTTP(S) URL' };
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      return { error: 'url must use HTTPS (plain HTTP is allowed only for localhost and host.docker.internal)' };
    }
    if (parsed.username || parsed.password || parsed.hash) {
      return { error: 'url must not contain credentials or fragments; use the OneCLI gateway for authentication' };
    }
    for (const [key, value] of parsed.searchParams) {
      if (isCredentialQueryKey(key)) {
        return { error: `url query parameter "${key}" looks like a credential; use the OneCLI gateway for authentication` };
      }
      if (RAW_SECRET_VALUE_RE.test(value)) {
        return { error: `url query parameter "${key}" carries a raw credential; use the OneCLI gateway for authentication` };
      }
    }
    // Some vendors put the token in the PATH (a Zapier-style
    // https://host/s/<token>/mcp). The URL is persisted verbatim, so reject
    // a credential there at intake rather than redacting it for display.
    for (const segment of parsed.pathname.split('/')) {
      if (RAW_SECRET_VALUE_RE.test(decodeURIComponent(segment))) {
        return {
          error:
            'url path carries a raw credential; use the OneCLI gateway for authentication rather than a secret in the URL',
        };
      }
    }
    if (args.headers === undefined) return { config: { type: 'http', url } };
    const rawHeaders = args.headers;
    if (typeof rawHeaders !== 'object' || rawHeaders === null || Array.isArray(rawHeaders)) {
      return { error: 'headers must be an object with string values' };
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value !== 'string') return { error: 'headers must be an object with string values' };
      if (!HEADER_NAME_RE.test(key)) {
        return { error: `header name ${JSON.stringify(key)} is not a valid HTTP header field name` };
      }
      if (RAW_SECRET_VALUE_RE.test(value)) {
        return {
          error: `header "${key}" carries a raw credential; declare it as "${ONECLI_PLACEHOLDER}" and let the OneCLI gateway inject the real value`,
        };
      }
      if (!LITERAL_HEADER_ALLOWLIST.has(key.toLowerCase()) && !ONECLI_HEADER_VALUE_RE.test(value)) {
        return {
          error: `header "${key}" is not a known configuration header, so its value must be exactly "${ONECLI_PLACEHOLDER}" or an auth scheme followed by it (e.g. "Bearer ${ONECLI_PLACEHOLDER}"). Configuration headers that carry no credential: ${[...LITERAL_HEADER_ALLOWLIST].join(', ')}`,
        };
      }
      headers[key] = value;
    }
    return {
      config: { type: 'http', url, ...(Object.keys(headers).length === 0 ? {} : { headers }) },
    };
  }
  if (command === undefined) return { error: 'Provide exactly one of command or url' };
  if (declaredType !== undefined && declaredType !== 'stdio') {
    return { error: `type ${JSON.stringify(declaredType)} cannot be used with command; use "stdio" or omit it` };
  }
  if (args.headers !== undefined) return { error: 'headers are only valid with url' };

  const commandArgs = args.args ?? [];
  if (!Array.isArray(commandArgs) || !commandArgs.every((arg) => typeof arg === 'string')) {
    return { error: 'args must be an array of strings' };
  }
  const rawEnv = args.env ?? {};
  if (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv)) {
    return { error: 'env must be an object with string values' };
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value !== 'string') return { error: 'env must be an object with string values' };
    if (!ENV_KEY_RE.test(key)) {
      return { error: `env key ${JSON.stringify(key)} must be a valid environment variable name` };
    }
    env[key] = value;
  }
  return { config: { command, args: commandArgs, env } };
}

export const addMcpServer: McpToolDefinition = {
  tool: {
    name: 'add_mcp_server',
    description:
      'Wire an EXISTING third-party MCP server into YOUR per-agent runtime config. Provide EITHER the local `command` + optional `args`/`env` (e.g. `npx @modelcontextprotocol/server-github`; browse options at https://mcp.so), OR the remote Streamable HTTP `url` of a hosted server (HTTPS; plain HTTP only for localhost / host.docker.internal). Requires admin approval; fire-and-forget. Never ask the user for credentials or fabricate credential-setup instructions — OneCLI handles them: use `"onecli-managed"` as the placeholder value for any credential env var, header, or config field the server needs (e.g. `headers: { "Authorization": "Bearer onecli-managed" }`). After the server is installed and the container restarts, load the `onecli-gateway` skill for the full credential-handling flow (connect URLs, stubs, error recovery).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'MCP server name (unique identifier)' },
        command: { type: 'string', description: 'Command to run a local stdio MCP server' },
        url: {
          type: 'string',
          description:
            'Streamable HTTP MCP endpoint (HTTPS; plain HTTP only for localhost / host.docker.internal). Mutually exclusive with command.',
        },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments (command only)' },
        env: { type: 'object', description: 'Environment variables for the server (command only)' },
        headers: {
          type: 'object',
          description:
            'HTTP headers for a remote server (url only). Credential headers must use the "onecli-managed" placeholder — the gateway substitutes the real secret at the proxy boundary.',
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = typeof args.name === 'string' ? args.name : '';
    if (!name) return err('name is required');
    if (!MCP_SERVER_NAME_RE.test(name)) {
      return err('server name must be 1-64 characters of letters, digits, "_" or "-"');
    }
    const parsed = parseMcpServerInput(args);
    if ('error' in parsed) return err(parsed.error);

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'add_mcp_server',
        name,
        ...parsed.config,
      }),
    });

    log(`add_mcp_server: ${requestId} → "${name}" (${'url' in parsed.config ? 'HTTP' : parsed.config.command})`);
    return ok(`MCP server request submitted. You will be notified when admin approves or rejects.`);
  },
};

export function unavailableModelInventory(provider: string) {
  if (provider === 'opencode') return null;
  return ok(
    `This is a ${provider} session. \`list_models\` inventories OpenCode slugs only and is not a ${provider} model catalog. ` +
      'For an authorized request to change this channel default, call `set_channel_model` directly; the host validates the provider-specific model.',
  );
}

export const listModels: McpToolDefinition = {
  tool: {
    name: 'list_models',
    description:
      "OpenCode-only model inventory for the session-scoped `change_model` tool. It returns OpenCode slugs reachable from this container's auth.json + env, grouped by upstream provider prefix (opencode-go/*, opencode/*, nvidia/*, etc.), minus any operator-denied slugs. Do NOT use it to validate or reject a channel-default request (`set_channel_model`): that host-side tool is provider-aware and must be called directly for an authorized request. Read-only, no approval needed.",
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    const provider = getConfig().provider;
    const unavailable = unavailableModelInventory(provider);
    if (unavailable) return unavailable;

    // Live source of truth: `opencode models` enumerates every reachable
    // model given the container's auth.json + env. We then subtract the
    // operator-curated deny list (central.db: denied_models).
    let opencodeOut: string;
    try {
      const proc = Bun.spawn(['opencode', 'models'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      opencodeOut = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return err(`opencode models exited ${exitCode}: ${stderr.trim() || 'no stderr'}`);
      }
    } catch (e) {
      return err(`Failed to run opencode models: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Each non-blank line is a slug like "opencode-go/kimi-k2.6" or
    // "nvidia/deepseek-ai/deepseek-v4-pro". Group by the FIRST path segment.
    const slugs = opencodeOut
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));

    // Pull the deny list for this provider from central.db so we can filter.
    const central = getCentralDb();
    const agentGroupId = getConfig().agentGroupId;
    if (!agentGroupId) return err('No agent group ID — container not properly initialized.');

    // Both tables come from the per-session central-db projection
    // (src/db/per-agent-projections.ts). Missing tables on an older session
    // shouldn't kill the tool — we still want the model list to surface.
    let config: { provider: string | null; model: string | null; effort: string | null } | undefined;
    let deniedSet = new Set<string>();
    if (central) {
      try {
        config = central
          .prepare('SELECT provider, model, effort FROM container_configs WHERE agent_group_id = ?')
          .get(agentGroupId) as typeof config;
      } catch (e) {
        log(`list_models: container_configs unavailable (${e instanceof Error ? e.message : String(e)})`);
      }
      if (config?.provider) {
        try {
          const deniedRows = central
            .prepare('SELECT slug FROM denied_models WHERE provider = ?')
            .all(config.provider) as Array<{ slug: string }>;
          deniedSet = new Set(deniedRows.map((r) => r.slug));
        } catch (e) {
          log(`list_models: denied_models unavailable (${e instanceof Error ? e.message : String(e)})`);
        }
      }
    }

    const grouped: Record<string, string[]> = {};
    let denied = 0;
    for (const slug of slugs) {
      if (deniedSet.has(slug)) {
        denied++;
        continue;
      }
      const sep = slug.indexOf('/');
      const prefix = sep > 0 ? slug.slice(0, sep) : '(unknown)';
      if (!grouped[prefix]) grouped[prefix] = [];
      grouped[prefix].push(slug);
    }

    const payload = {
      provider: config?.provider ?? null,
      current: { model: config?.model ?? null, effort: config?.effort ?? null },
      total: slugs.length - denied,
      denied,
      grouped,
    };
    return ok(JSON.stringify(payload, null, 2));
  },
};

export const changeModel: McpToolDefinition = {
  tool: {
    name: 'change_model',
    description:
      "Switch the model for YOUR session — exactly like the user's `-m <slug>` flag. Takes effect on your NEXT turn with NO container restart; this turn finishes on the current model. Session-scoped (does NOT change the group default — that's `ncl groups config update`). Use list_models first for valid slugs. Optional effort: low|medium|high|max (max only on models that support it, e.g. DeepSeek V4). The operator deny list is the only hard block.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: {
          type: 'string',
          description:
            'The model slug to switch to, e.g. "opencode-go/kimi-k2.7-code" (provider-prefixed for opencode). Run list_models for valid ids.',
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'max'],
          description: 'Optional effort level (max is supported by some models, e.g. DeepSeek V4). Omit to keep current.',
        },
      },
      required: ['slug'],
    },
  },
  async handler(args) {
    const slug = (args.slug as string)?.trim();
    const effort = args.effort as string | undefined;
    if (!slug) return err('slug is required');
    if (effort && !['low', 'medium', 'high', 'max'].includes(effort)) {
      return err('effort must be one of: low, medium, high, max');
    }

    const provider = getConfig().provider;
    // OpenCode slugs MUST be a well-formed provider-prefixed `<provider>/<id>`
    // (the routing provider is derived from the prefix). Mirrors the host
    // flag-parser's OPENCODE_VALID_MODEL_RE / isOpenCodeModelSlug exactly —
    // replicated here because the container can't import the host module. A
    // looser "contains a slash" check would let `opencode-go/`, `/kimi`, or
    // garbage chars persist into session_state, after which splitModelSlug
    // silently drops body.model while the prompt claims a switch.
    if (provider === 'opencode' && !OPENCODE_MODEL_SLUG_RE.test(slug)) {
      return err(
        `"${slug}" is not a valid opencode model slug — use the provider-prefixed form ` +
          `(e.g. opencode-go/kimi-k2.7-code, nvidia/moonshotai/kimi-k2.6). Run list_models for exact ids.`,
      );
    }

    // Operator deny list (central.db projection) — block wrong-subscription models.
    const central = getCentralDb();
    if (central) {
      try {
        const denied = central
          .prepare('SELECT reason FROM denied_models WHERE provider = ? AND slug = ?')
          .get(provider, slug) as { reason?: string } | undefined;
        if (denied) {
          return err(`"${slug}" is on the operator deny list${denied.reason ? ` (${denied.reason})` : ''} — cannot switch to it.`);
        }
      } catch {
        // denied_models absent on an older session projection — skip the check.
      }
    }

    // Behave EXACTLY like the user's `-m`/`-e` flags: set the SESSION-sticky model
    // (+ effort) in session_state. The provider applies it per-turn on the NEXT
    // turn (this turn finishes on the prior model). No container restart, no
    // group-DB change — seamless and session-scoped, identical to `-m`.
    setStickyModel(slug);
    if (effort) setStickyEffort(effort);
    log(`change_model: session sticky → ${slug}${effort ? ` (effort=${effort})` : ''}`);
    return ok(
      `Switched to \`${slug}\`${effort ? ` (effort \`${effort}\`)` : ''} for this session — takes effect on your next turn ` +
        `(no restart; same as the \`-m\` flag). This turn finishes on the previous model.`,
    );
  },
};

// `list_models` shells out to OpenCode and therefore cannot describe a Codex
// or Claude catalog. Register the shared tools at import time, then let the
// MCP barrel add that provider-specific tool after it has loaded config.
registerTools([installPackages, addMcpServer, changeModel]);

export function registerProviderSpecificSelfModTools(provider: string = getConfig().provider): void {
  if (provider === 'opencode') registerTools([listModels]);
}
