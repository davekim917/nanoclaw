/**
 * Agent management MCP tools: create_agent.
 *
 * send_to_agent was removed — sending to another agent is now just
 * send_message(to="agent-name") since agents and channels share the
 * unified destinations namespace.
 *
 * create_agent is admin-only. Non-admin containers never see this tool
 * (see mcp-tools/index.ts). The host re-checks permission on receive.
 */
import { writeMessageOut } from '../db/messages-out.js';
// Side-effect import: the MCP server runs as a separate subprocess
// (see container-runner.ts mcp-config "nanoclaw" entry). Without this,
// the provider registry stays empty in this process and explicit
// `provider:` calls fail with "not registered" even when the main
// agent-runner process sees them fine.
import '../providers/index.js';
import { listProviderNames, validateProviderConfig } from '../providers/provider-registry.js';
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

export const createAgent: McpToolDefinition = {
  tool: {
    name: 'create_agent',
    description:
      'Create a long-lived companion sub-agent (research assistant, task manager, specialist) — the name becomes your destination for it. Admin-only. Fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-readable name (also becomes your destination name for this agent)' },
        instructions: { type: 'string', description: 'CLAUDE.md content for the new agent (personality, role, instructions)' },
        provider: {
          type: 'string',
          description:
            "Agent provider backend. Default: the host's default (currently 'claude'). " +
            "Valid values depend on what's installed on this host — e.g. 'claude', 'codex' (via /add-codex), 'opencode' (via /add-opencode).",
        },
        provider_config: {
          type: 'object',
          additionalProperties: true,
          description:
            "Provider-specific config. Shape depends on 'provider'. " +
            "Claude: { model?: string, effort?: 'low'|'medium'|'high'|'xhigh'|'max' }. " +
            "Codex: { model?: string, reasoning_effort?: 'low'|'medium'|'high' }. " +
            "Unknown keys are rejected. Keep this in sync with each provider's configSchema — " +
            "see R6 in the design for the future z.toJSONSchema() migration.",
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    if (!name) return err('name is required');

    const provider = (args.provider as string | undefined) ?? undefined;
    const providerConfig = args.provider_config as Record<string, unknown> | undefined;

    if (provider !== undefined) {
      const registered = listProviderNames();
      if (!registered.includes(provider)) {
        return err(
          `Provider '${provider}' is not registered. Registered: [${registered.join(', ')}]. Run /add-${provider} on the host first.`,
        );
      }
    }

    if (providerConfig !== undefined) {
      const result = validateProviderConfig(provider ?? 'claude', providerConfig);
      if (!result.ok) {
        return err(`Invalid provider_config: ${result.error}`);
      }
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_agent',
        requestId,
        name,
        instructions: (args.instructions as string) || null,
        ...(provider !== undefined ? { provider } : {}),
        ...(providerConfig !== undefined ? { provider_config: providerConfig } : {}),
      }),
    });

    log(`create_agent: ${requestId} → "${name}"`);
    return ok(`Creating agent "${name}". You will be notified when it is ready.`);
  },
};

registerTools([createAgent]);
