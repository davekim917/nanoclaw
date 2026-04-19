/**
 * Remote Control MCP tools (Phase 5.7).
 *
 * Thin agent-facing wrappers around the host's `claude remote-control`
 * CLI. The agent emits a system-action via messages_out; the host
 * spawns / stops / queries Claude's OOTB remote-control command and
 * sends a chat-kind message back into the session with the URL or
 * status. The agent picks that up as normal inbound and relays to
 * the user.
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
    id: genId('rc'),
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

export const startRemoteControlTool: McpToolDefinition = {
  tool: {
    name: 'start_remote_control',
    description:
      'Start a Claude Code Remote Control session on the host so the user can drive this NanoClaw install from the Claude mobile/web app. Returns immediately; the host-side spawn + URL arrives in chat as a follow-up system message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sender: { type: 'string', description: 'User id / handle of whoever requested it (for logging).' },
        chatJid: { type: 'string', description: 'Originating chat jid (for logging / audit).' },
      },
    },
  },
  async handler(args) {
    const sender = (args.sender as string) || 'agent';
    const chatJid = (args.chatJid as string) || '';
    emit('start_remote_control', { sender, chatJid });
    return ok('Starting Remote Control on the host. URL will arrive as a follow-up message in this chat.');
  },
};

export const stopRemoteControlTool: McpToolDefinition = {
  tool: {
    name: 'stop_remote_control',
    description: 'Stop the currently-running Claude Code Remote Control session on the host.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    emit('stop_remote_control');
    return ok('Requested Remote Control stop. Confirmation will arrive as a follow-up message.');
  },
};

export const getRemoteControlStatusTool: McpToolDefinition = {
  tool: {
    name: 'get_remote_control_status',
    description: 'Check whether a Remote Control session is active on the host, and if so, return its URL.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    emit('get_remote_control_status');
    return ok('Asked host for Remote Control status. Response will arrive as a follow-up message.');
  },
};

export const remoteControlTools: McpToolDefinition[] = [
  startRemoteControlTool,
  stopRemoteControlTool,
  getRemoteControlStatusTool,
];

registerTools(remoteControlTools);
