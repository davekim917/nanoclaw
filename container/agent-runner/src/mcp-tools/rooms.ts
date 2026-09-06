/**
 * Room management MCP tools: create_room, add_to_room.
 *
 * A "room" is one shared Slack conversation holding the operator and several
 * agents. Both tools are fire-and-forget, the same shape create_agent uses:
 * they write one outbound system row and return. The host resolves the names,
 * makes the Slack calls, wires every participant, and reports back as a system
 * note — the container never talks to Slack and never holds a bot token.
 *
 * Authorization is enforced HOST-SIDE by the guard (src/modules/slack-rooms/):
 * a trusted global-scope group acts directly, adding a sibling from the same
 * workgroup is allowed, and everything else holds for admin approval. Nothing
 * here gates anything — the container is untrusted and cannot be relied on to
 * gate itself; these checks only save the agent a round trip on an obviously
 * malformed call.
 *
 * NO `rooms.instructions.md`. Every `*.instructions.md` beside an MCP tool
 * module is loaded into EVERY agent group's composed CLAUDE.md on every spawn
 * (src/claude-md-compose.ts), and this fork retired that always-on tier in
 * favour of putting the guidance in the tool descriptions where it stays next
 * to the thing it describes. `instruction-fragment-migration.test.ts` pins
 * that rule; the descriptions below are where the room guidance lives.
 */
import { writeMessageOut } from '../db/messages-out.js';
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

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export const createRoom: McpToolDefinition = {
  tool: {
    name: 'create_room',
    description:
      'Open ONE shared Slack room — a NEW private channel holding you, the operator, and the agents you name — and ' +
      'wire every one of them to it so they can all read and post there. It never reuses an existing channel, so ' +
      'nobody gains access to a conversation that predates the room. This is the TEAM primitive: for a team of ' +
      'several agents, call it ONCE naming all of them, never once per agent. Each agent you name must already be a ' +
      'send_message destination of yours, and every agent must have a Slack bot in the same workspace as yours — a ' +
      'roster spanning two workspaces is refused, because one Slack conversation cannot cross workspaces. ' +
      'May require admin approval. Fire-and-forget: the call returns immediately and a system note tells you when ' +
      'the room is live and asks you to post the intro there yourself.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description:
            'Room name. Slack normalizes it (lowercase, dashes) and the normalized form is what the room is called ' +
            'afterwards — it is also the name add_to_room takes later, so pick something specific enough to stay ' +
            'unambiguous inside your workgroup.',
        },
        purpose: {
          type: 'string',
          description:
            'One short PUBLIC line (under 80 chars) saying what the room is for. Everyone in the room sees it, so ' +
            'never put private details from your instructions here.',
        },
        agents: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Agent names to include — the same names you use with send_message. You are always a member; do not ' +
            'name yourself.',
        },
      },
      required: ['name', 'agents'],
    },
  },
  async handler(args) {
    const name = cleanString(args.name);
    if (!name) return err('name is required');
    const agents = Array.isArray(args.agents) ? args.agents.map(cleanString).filter(Boolean) : [];
    if (agents.length === 0) return err('agents must list at least one agent name');

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_room',
        requestId,
        name,
        agents,
        ...(cleanString(args.purpose) ? { purpose: cleanString(args.purpose) } : {}),
      }),
    });

    log(`create_room: ${requestId} → "${name}" (${agents.length} agents)`);
    return ok(`Creating room "${name}". You will be notified when it is live.`);
  },
};

export const addToRoom: McpToolDefinition = {
  tool: {
    name: 'add_to_room',
    description:
      'Add ONE agent to a room that already exists. The room keeps its Slack conversation — it does not move, and ' +
      'nobody has to be re-invited — so history and links stay valid. The room is looked up by name among the rooms ' +
      'wired to you or to another agent in your workgroup, and nowhere else: a name that matches two of those rooms ' +
      'is an error listing both, and a room belonging to another workgroup is never found. Adding an agent from ' +
      'your own workgroup happens straight away; adding one from outside it requires admin approval, because ' +
      "Slack hands a new member the room's PRIOR HISTORY as well as everything posted afterwards — the whole " +
      'conversation to date, not just what follows. Say so when you propose it. For a team you already know the ' +
      'shape of, prefer one complete create_room over a chain of adds. Fire-and-forget: a system note reports the ' +
      'outcome.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        room: {
          type: 'string',
          description:
            'Room name as it is called now. If two of your rooms share a name you will be told, and can pass the ' +
            'Slack channel id from that message instead.',
        },
        agent: {
          type: 'string',
          description: 'Agent name to add — the same name you use with send_message.',
        },
      },
      required: ['room', 'agent'],
    },
  },
  async handler(args) {
    const room = cleanString(args.room);
    const agent = cleanString(args.agent);
    if (!room) return err('room is required');
    if (!agent) return err('agent is required');

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'add_to_room', requestId, room, agent }),
    });

    log(`add_to_room: ${requestId} → "${agent}" into "${room}"`);
    return ok(`Adding "${agent}" to room "${room}". You will be notified when it is done.`);
  },
};

registerTools([createRoom, addToRoom]);
