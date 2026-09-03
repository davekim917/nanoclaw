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

export const addMcpServer: McpToolDefinition = {
  tool: {
    name: 'add_mcp_server',
    description:
      'Wire an EXISTING third-party MCP server into YOUR per-agent runtime config — you must already know the exact `command` + `args` to invoke it (e.g. `npx @modelcontextprotocol/server-github`; browse options at https://mcp.so). Requires admin approval; fire-and-forget. Never ask the user for credentials or fabricate credential-setup instructions — OneCLI handles them: use `"onecli-managed"` as the placeholder value for any credential env var or config field the server needs. After the server is installed and the container restarts, load the `onecli-gateway` skill for the full credential-handling flow (connect URLs, stubs, error recovery).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'MCP server name (unique identifier)' },
        command: { type: 'string', description: 'Command to run the MCP server' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments' },
        env: { type: 'object', description: 'Environment variables for the server' },
      },
      required: ['name', 'command'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    const command = args.command as string;
    if (!name || !command) return err('name and command are required');

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'add_mcp_server',
        name,
        command,
        args: (args.args as string[]) || [],
        env: (args.env as Record<string, string>) || {},
      }),
    });

    log(`add_mcp_server: ${requestId} → "${name}" (${command})`);
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
