/**
 * Chat-invokable access grants. The host derives the real caller from the session's latest inbound message and
 * checks its role. `user` accepts a namespaced id, a platform mention (`<@U123>`) or a bare id; the latter two
 * get the session's channel_type prepended. Owner is intentionally not grantable via tool.
 */
import { registerTools } from './server.js';
import { emitSystemAction, ok } from './tool-helpers.js';
import type { McpToolDefinition } from './types.js';

const grantAccessTool: McpToolDefinition = {
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
            "Target user. Accepts a namespaced id (`slack-example-labs:U123`), a platform mention (`<@U123>`), or a bare platform id. Mentions and bare ids are resolved against the current session's channel_type.",
        },
        role: {
          type: 'string',
          enum: ['member', 'admin'],
          description: 'Role to grant. Defaults to `member`. Admins can only grant `member`.',
        },
        agentGroupId: {
          type: 'string',
          description: "Target agent group id. Defaults to the current session's agent group.",
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
    await emitSystemAction('perm', 'grant_access', { user, role, agentGroupId });
    return ok(
      `grant_access requested (user=${user}, role=${role}${agentGroupId ? `, agentGroup=${agentGroupId}` : ''}). Host will reply with the outcome.`,
    );
  },
};

const revokeAccessTool: McpToolDefinition = {
  tool: {
    name: 'revoke_access',
    description:
      "Revoke a user's access to this agent group (membership + any scoped admin role). Host verifies the caller has authority before executing. Does not affect owner or global-admin roles — those must be revoked by direct edit.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        user: {
          type: 'string',
          description: 'Target user (same shape as grant_access).',
        },
        agentGroupId: {
          type: 'string',
          description: "Target agent group id. Defaults to the current session's agent group.",
        },
      },
      required: ['user'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const user = typeof args.user === 'string' ? args.user.trim() : '';
    if (!user) return ok('Error: `user` is required.');
    const agentGroupId = typeof args.agentGroupId === 'string' ? args.agentGroupId.trim() : undefined;
    await emitSystemAction('perm', 'revoke_access', { user, agentGroupId });
    return ok(
      `revoke_access requested (user=${user}${agentGroupId ? `, agentGroup=${agentGroupId}` : ''}). Host will reply with the outcome.`,
    );
  },
};

const listAccessTool: McpToolDefinition = {
  tool: {
    name: 'list_access',
    description:
      "List who has access to an agent group — owners, admins, and members. Defaults to the current session's agent group. Any session participant can call this (read-only).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        agentGroupId: {
          type: 'string',
          description: "Target agent group id. Defaults to the current session's agent group.",
        },
      },
      required: [],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const agentGroupId = typeof args.agentGroupId === 'string' ? args.agentGroupId.trim() : undefined;
    await emitSystemAction('perm', 'list_access', { agentGroupId });
    return ok(
      `list_access requested${agentGroupId ? ` (agentGroup=${agentGroupId})` : ''}. Host will reply with the roster.`,
    );
  },
};

const permissionTools: McpToolDefinition[] = [grantAccessTool, revokeAccessTool, listAccessTool];

registerTools(permissionTools);
