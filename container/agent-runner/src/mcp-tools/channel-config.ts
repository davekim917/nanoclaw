/**
 * Channel-config MCP tools (fork addition — v1 had equivalents named
 * `set_group_model` / `set_group_effort`, but v1's "group" conflated
 * channel and agent-group; v2 names are aligned with the entity model).
 *
 * Terminology (v2):
 *   - channel = messaging_group (one chat on one platform)
 *   - agent   = agent_group (one persona/workspace)
 *   - wiring  = messaging_group_agents row (channel ↔ agent link)
 *
 * These tools mutate the default_model / default_effort columns on the
 * wiring row for (current agent_group, named channel). That's the
 * per-channel layer — it overrides the agent's container.json defaults
 * and the host-env defaults, but is still overridden by a user's
 * per-session `-m` / `-e` flags.
 *
 * Host-side authorization (trust-minimal):
 *   - Container emits a system action; it doesn't write the DB.
 *   - Host derives caller identity from the session's latest inbound
 *     chat message (not from anything the agent can fake).
 *   - Only owners / admins of the agent group / global admins may
 *     mutate. Non-admins get a notify reply; no SQL side effect.
 *
 * See `src/modules/channel-config/index.ts` for the host half.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emit(action: string, extra: Record<string, unknown> = {}): void {
  const r = getSessionRouting();
  writeMessageOut({
    id: genId('chcfg'),
    kind: 'system',
    platform_id: r.platform_id,
    channel_type: r.channel_type,
    thread_id: r.thread_id,
    content: JSON.stringify({ action, ...extra }),
  });
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export const setChannelModelTool: McpToolDefinition = {
  tool: {
    name: 'set_channel_model',
    description:
      'Set the default model for a specific channel (messaging group) wired to this agent. Applies to every future turn on that channel unless the user passes `-m <model>` explicitly. Mutates messaging_group_agents.default_model. Pass `model` as a short alias (opus46, opus4-7, sonnet46, haiku45) or a full SDK id (claude-opus-4-7[1m]). Pass model=null to clear the per-channel override and fall back to the agent / host defaults. Admin-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          description: 'Destination name for the channel to configure. Defaults to the channel this message came from.',
        },
        model: {
          type: ['string', 'null'],
          description: 'Model to pin (e.g. `opus47`, `claude-opus-4-6[1m]`). Pass null to clear the per-channel override.',
        },
      },
      required: ['model'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const channel = typeof args.channel === 'string' ? args.channel.trim() : undefined;
    const model = args.model === null ? null : typeof args.model === 'string' ? args.model.trim() : undefined;
    if (model === undefined) {
      return ok('Error: `model` is required. Pass a model id / alias, or null to clear.');
    }
    emit('set_channel_model', { channel, model });
    const action = model === null ? 'clear' : `set to ${model}`;
    return ok(
      `set_channel_model requested (channel=${channel ?? '(current)'}, action=${action}). Host will reply with the outcome.`,
    );
  },
};

export const setChannelEffortTool: McpToolDefinition = {
  tool: {
    name: 'set_channel_effort',
    description:
      'Set the default reasoning effort for a specific channel (messaging group) wired to this agent. Applies until the user passes `-e <level>` explicitly. Values: low | medium | high | xhigh, or null to clear. Admin-only. Mutates messaging_group_agents.default_effort.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          description: 'Destination name for the channel to configure. Defaults to the channel this message came from.',
        },
        effort: {
          type: ['string', 'null'],
          description: 'Effort level (low | medium | high | xhigh) or null to clear the override.',
        },
      },
      required: ['effort'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const channel = typeof args.channel === 'string' ? args.channel.trim() : undefined;
    const effort = args.effort === null ? null : typeof args.effort === 'string' ? args.effort.trim().toLowerCase() : undefined;
    if (effort === undefined) {
      return ok('Error: `effort` is required. Pass low/medium/high/xhigh, or null to clear.');
    }
    if (effort !== null && !VALID_EFFORTS.has(effort)) {
      return ok(`Error: effort must be one of low, medium, high, xhigh (or null). Got ${JSON.stringify(args.effort)}.`);
    }
    emit('set_channel_effort', { channel, effort });
    const action = effort === null ? 'clear' : `set to ${effort}`;
    return ok(
      `set_channel_effort requested (channel=${channel ?? '(current)'}, action=${action}). Host will reply with the outcome.`,
    );
  },
};

export const channelConfigTools: McpToolDefinition[] = [setChannelModelTool, setChannelEffortTool];

registerTools(channelConfigTools);
