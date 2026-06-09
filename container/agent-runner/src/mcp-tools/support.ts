/**
 * Support-inbox MCP tool: `dispatch_support_issue`.
 *
 * The inbox-poller agent calls this once per triaged support email — after it
 * has confirmed the email is real support and created/located the Linear ticket
 * — to route the issue into its own Slack working thread + per-issue session.
 *
 * Like the scheduling tools, the container can't touch host state directly: it
 * writes a `kind='system'` outbound action that the host applies in
 * `src/modules/support-threads/dispatch.ts`. The host is idempotent on
 * `gmailThreadId` — calling this again for the same Gmail thread routes the
 * follow-up into the existing thread/session instead of opening a new one.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const dispatchSupportIssue: McpToolDefinition = {
  tool: {
    name: 'dispatch_support_issue',
    description:
      'Route a triaged support email to its own Slack working thread + dedicated session. Call once per real support email after the noise pre-flight — you do NOT create the Linear ticket yourself; the per-issue session handles all ticketing. The host posts a channel announcement, opens a thread, and seeds a per-issue session that creates/updates the Linear ticket and works it in that thread. Idempotent on `gmailThreadId`: calling it again for the same Gmail thread (a follow-up email) routes the new message into the EXISTING thread/session instead of opening a duplicate — so always pass the real Gmail `threadId`, including for replies.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        gmailThreadId: { type: 'string', description: 'Gmail thread id of the email (the stable per-issue key).' },
        linearIssue: { type: 'string', description: 'Linear issue identifier, ONLY if one is already known for this thread. Usually omit — the per-issue session creates the ticket.' },
        linearTeam: { type: 'string', description: 'Linear team, only if already known. Usually omit.' },
        subject: { type: 'string', description: 'Email subject (used in the channel announcement + thread title).' },
        sender: { type: 'string', description: 'Email sender (display form, e.g. "Jane Doe <jane@acme.com>").' },
        bodyText: { type: 'string', description: 'The cleaned email body (quoted history stripped). Posted into the thread.' },
        lastMessageId: { type: 'string', description: 'RFC-822 Message-ID header of this email, retained for future reply threading. Optional.' },
      },
      required: ['gmailThreadId'],
    },
  },
  async handler(args) {
    const gmailThreadId = args.gmailThreadId as string;
    if (!gmailThreadId) return err('gmailThreadId is required');

    writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({
        action: 'dispatch_support_issue',
        gmailThreadId,
        linearIssue: (args.linearIssue as string) || null,
        linearTeam: (args.linearTeam as string) || null,
        subject: (args.subject as string) || null,
        sender: (args.sender as string) || null,
        bodyText: (args.bodyText as string) || null,
        lastMessageId: (args.lastMessageId as string) || null,
      }),
    });

    log(`dispatch_support_issue: ${gmailThreadId}`);
    return ok(`Support issue dispatched (gmail thread ${gmailThreadId}). It now has its own Slack thread + session.`);
  },
};

export const updateSupportTicket: McpToolDefinition = {
  tool: {
    name: 'update_support_ticket',
    description:
      'Record the Linear ticket for THIS support thread. Call this from a per-issue support session immediately after you create the Linear issue (or discover its identifier). The host resolves which support thread you are from your session — you only pass the ticket fields — records it centrally, and updates the channel announcement to show the ticket id. Required so follow-up emails on this thread post Linear comments instead of duplicate tickets.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        linearIssue: { type: 'string', description: 'Linear issue identifier you created (e.g. "XZO-123").' },
        linearTeam: { type: 'string', description: 'Linear team the issue is on ("XZO" or "Apollo"). Optional.' },
      },
      required: ['linearIssue'],
    },
  },
  async handler(args) {
    const linearIssue = args.linearIssue as string;
    if (!linearIssue) return err('linearIssue is required');

    writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({
        action: 'update_support_ticket',
        linearIssue,
        linearTeam: (args.linearTeam as string) || null,
      }),
    });

    log(`update_support_ticket: ${linearIssue}`);
    return ok(`Ticket ${linearIssue} recorded for this support thread.`);
  },
};

registerTools([dispatchSupportIssue, updateSupportTicket]);
