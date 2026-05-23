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
import { getCentralDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getConfig } from '../config.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

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
      'Install apt and/or npm packages into YOUR per-agent container image. Requires admin approval; fire-and-forget. On approval, the image is rebuilt and the container is restarted automatically.',
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
    writeMessageOut({
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
      'Wire an EXISTING third-party MCP server into YOUR per-agent runtime config — you must already know the exact `command` + `args` to invoke it (e.g. `npx @modelcontextprotocol/server-github`). Requires admin approval; fire-and-forget.',
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
    writeMessageOut({
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

export const listModels: McpToolDefinition = {
  tool: {
    name: 'list_models',
    description:
      "REQUIRED whenever the user asks anything about available models, model options, what you can switch to, what models are available, what your provider supports, or similar — you MUST call this tool first and report its result, NOT speculate from training data. Returns every model reachable from this container's auth.json + env (asking OpenCode itself), grouped by upstream provider prefix (opencode-go/*, opencode/*, nvidia/*, etc.), minus any slugs the operator has put on the deny list. Training-data lists of models are not authoritative; this tool is. Also call this before invoking change_model to validate any slug the user proposes. Read-only, no approval needed.",
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
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
      "Request a model change for YOUR own container. Requires admin approval; fire-and-forget. On approval, the container's model (and optionally effort) is updated and the container is restarted. Use list_models first to discover valid slugs for your provider — passing a slug NOT in that allowlist is rejected at request time.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: {
          type: 'string',
          description:
            'The model identifier to switch to (must be in the allowlist returned by list_models, e.g. "opencode/kimi-k2.6-thinking").',
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Optional effort level. Omit to keep current.',
        },
        reason: { type: 'string', description: 'Why this change is needed — shown to the admin for context.' },
      },
      required: ['slug'],
    },
  },
  async handler(args) {
    const slug = args.slug as string;
    const effort = args.effort as string | undefined;
    const reason = (args.reason as string) || '';
    if (!slug) return err('slug is required');
    if (effort && !['low', 'medium', 'high'].includes(effort)) {
      return err('effort must be one of: low, medium, high');
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'change_model', slug, effort: effort ?? null, reason }),
    });
    log(`change_model: ${requestId} → ${slug}${effort ? ` (effort=${effort})` : ''}`);
    return ok(
      `Model change request submitted (${slug}). You will be notified when admin approves or rejects. Continue your current work; if the change is approved, the container will restart and you'll get a follow-up message.`,
    );
  },
};

registerTools([installPackages, addMcpServer, listModels, changeModel]);
