/** Wrappers around the host's `claude remote-control`: a system action out, the URL or status back as a chat message. */
import { registerTools } from './server.js';
import { emitSystemAction, ok } from './tool-helpers.js';
import type { McpToolDefinition } from './types.js';

const startRemoteControlTool: McpToolDefinition = {
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
    await emitSystemAction('rc', 'start_remote_control', { sender, chatJid });
    return ok('Starting Remote Control on the host. URL will arrive as a follow-up message in this chat.');
  },
};

const stopRemoteControlTool: McpToolDefinition = {
  tool: {
    name: 'stop_remote_control',
    description: 'Stop the currently-running Claude Code Remote Control session on the host.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    await emitSystemAction('rc', 'stop_remote_control');
    return ok('Requested Remote Control stop. Confirmation will arrive as a follow-up message.');
  },
};

const getRemoteControlStatusTool: McpToolDefinition = {
  tool: {
    name: 'get_remote_control_status',
    description: 'Check whether a Remote Control session is active on the host, and if so, return its URL.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    await emitSystemAction('rc', 'get_remote_control_status');
    return ok('Asked host for Remote Control status. Response will arrive as a follow-up message.');
  },
};

const remoteControlTools: McpToolDefinition[] = [
  startRemoteControlTool,
  stopRemoteControlTool,
  getRemoteControlStatusTool,
];

registerTools(remoteControlTools);
