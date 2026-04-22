/**
 * Permissions MCP tools (fork addition).
 *
 * Chat-invokable access grants so power users don't need to SSH into the
 * host to run SQL when they want to add a teammate to a strict channel.
 * Host-side authorization is deliberate: these tools emit system actions,
 * the host determines the real caller from the session's latest inbound
 * message (not from anything the agent can fake), checks the caller has
 * the right role, and performs the DB write. See
 * `src/modules/permissions/grant.ts` for the host half.
 *
 * Target resolution. `user` accepts three shapes:
 *   - Already-namespaced id: `slack-illysium:U12345`, `discord:602…`
 *   - Platform mention as it appears in chat: `<@U12345>` (Slack),
 *     `<@602…>` (Discord) — the leading `<@` and trailing `>` are
 *     stripped and the current session's channel_type is prepended.
 *   - Bare platform id (no prefix, no `<@>`): prepended with the current
 *     session's channel_type.
 *
 * Role. `member` (default) — allowed-to-invoke, no admin powers. `admin`
 * — scoped admin of the target agent group (granular; host's primitive
 * gates what admin can do). Owner is intentionally not grantable via
 * tool; set via `/init-first-agent` or direct DB edit.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emit(action: string, extra: Record<string, unknown> = {}): void {
  const r = getSessionRouting();
  writeMessageOut({
    id: genId('perm'),
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

export const grantAccessTool: McpToolDefinition = {
  tool: {
    name: 'grant_access',
    description:
      'Grant a user access to chat with this agent (or another agent group). Host verifies the real caller from the latest inbound message and checks authority — only the owner / a global admin / an admin of the target group can grant; admins can only grant `member`. Use this when someone asks the bot to let a teammate in. The host replies in-chat with success or the reason for denial.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        user: {
          type: 'string',
          description:
            'Target user. Accepts a namespaced id (`slack-illysium:U123`), a platform mention (`<@U123>`), or a bare platform id. Mentions and bare ids are resolved against the current session\'s channel_type.',
        },
        role: {
          type: 'string',
          enum: ['member', 'admin'],
          description: 'Role to grant. Defaults to `member`. Admins can only grant `member`.',
        },
        agentGroupId: {
          type: 'string',
          description: 'Target agent group id. Defaults to the current session\'s agent group.',
        },
      },
      required: ['user'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const user = typeof args.user === 'string' ? args.user.trim() : '';
    if (!user) return ok('Error: `user` is required.');
    const role = typeof args.role === 'string' ? args.role.trim().toLowerCase() : 'member';
    const agentGroupId = typeof args.agentGroupId === 'string' ? args.agentGroupId.trim() : undefined;
    emit('grant_access', { user, role, agentGroupId });
    return ok(`grant_access requested (user=${user}, role=${role}${agentGroupId ? `, agentGroup=${agentGroupId}` : ''}). Host will reply with the outcome.`);
  },
};

export const revokeAccessTool: McpToolDefinition = {
  tool: {
    name: 'revoke_access',
    description:
      'Revoke a user\'s access to this agent group (membership + any scoped admin role). Host verifies the caller has authority before executing. Does not affect owner or global-admin roles — those must be revoked by direct edit.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        user: {
          type: 'string',
          description: 'Target user (same shape as grant_access).',
        },
        agentGroupId: {
          type: 'string',
          description: 'Target agent group id. Defaults to the current session\'s agent group.',
        },
      },
      required: ['user'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const user = typeof args.user === 'string' ? args.user.trim() : '';
    if (!user) return ok('Error: `user` is required.');
    const agentGroupId = typeof args.agentGroupId === 'string' ? args.agentGroupId.trim() : undefined;
    emit('revoke_access', { user, agentGroupId });
    return ok(`revoke_access requested (user=${user}${agentGroupId ? `, agentGroup=${agentGroupId}` : ''}). Host will reply with the outcome.`);
  },
};

export const listAccessTool: McpToolDefinition = {
  tool: {
    name: 'list_access',
    description:
      'List who has access to an agent group — owners, admins, and members. Defaults to the current session\'s agent group. Any session participant can call this (read-only).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agentGroupId: {
          type: 'string',
          description: 'Target agent group id. Defaults to the current session\'s agent group.',
        },
      },
      required: [],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const agentGroupId = typeof args.agentGroupId === 'string' ? args.agentGroupId.trim() : undefined;
    emit('list_access', { agentGroupId });
    return ok(`list_access requested${agentGroupId ? ` (agentGroup=${agentGroupId})` : ''}. Host will reply with the roster.`);
  },
};

export const permissionTools: McpToolDefinition[] = [grantAccessTool, revokeAccessTool, listAccessTool];

registerTools(permissionTools);
