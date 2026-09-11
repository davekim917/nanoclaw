/**
 * request_choice MCP tool — the non-blocking sibling of ask_user_question.
 *
 * Writes a `request_choice` system action and returns. The host
 * (src/modules/interactive/choice.ts) posts an approvals-backed card — into
 * this session's own conversation, or top-level into a named channel
 * destination — and, on an authorized click, relays the answer as a chat
 * message into the session a reply in the card's thread would reach.
 *
 * A kind='system' row never touches the chat budget (admitChatWrite returns
 * early for anything but kind 'chat', modules/mailbox/index.ts:117-118), so a
 * muted task can still post a card — the same lane escalate_to_owner uses.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting, getTaskSeriesId } from '../db/session-routing.js';
import { findByName, getAllDestinations } from '../destinations.js';
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

const MAX_CHOICE_OPTIONS = 10;
const CHOICE_STYLES = new Set<unknown>(['primary', 'danger', 'default']);
const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function channelDestinationNames(): string {
  const names = getAllDestinations()
    .filter((d) => d.type === 'channel')
    .map((d) => d.name);
  return names.length > 0 ? names.join(', ') : '(none)';
}

export const requestChoice: McpToolDefinition = {
  tool: {
    name: 'request_choice',
    description:
      'Post a card of buttons and return immediately. This tool never blocks and never waits for a click. Omit `to` to post in the current conversation; pass `to` (a channel destination name, as for send_message) to post the card top-level in that channel — required when this session has no conversation (a scheduled task), and it works from a muted task, since a card is not a chat message. Pass `key` to replace instead of stack: your open card with the same key is closed as superseded before this one posts. The answer arrives later as a new message from sender "system" — possibly hours later, after this container has exited — in the session a reply in the card\'s thread would reach (the asking session when the card is in its own thread; the thread under a `to` card when this agent is wired to that channel; otherwise back here), and that session is woken. The message is one line: `choice_response choice_id=<id> value=<value> label=<label> user_id=<channel:handle> user_name=<name>`, keys in that order, each value percent-encoded (decode with decodeURIComponent; user_name may be empty). Match choice_id to the id this call returns. Only an admin or owner of this agent can answer: other clicks are ignored and the card stays open. The first authorized click closes the card; later clicks do nothing. Use this for decisions that can wait; use ask_user_question only when you must pause for an answer within minutes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short card title shown above the question' },
        question: { type: 'string', description: 'The decision being asked for' },
        options: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_CHOICE_OPTIONS,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Button text' },
              value: { type: 'string', description: 'Returned to you when this button is clicked; unique per card' },
              style: { type: 'string', enum: ['primary', 'danger', 'default'], description: 'Optional button style' },
            },
            required: ['label', 'value'],
          },
          description: `1 to ${MAX_CHOICE_OPTIONS} buttons, each {label, value, style?}`,
        },
        to: {
          type: 'string',
          description:
            'Channel destination name. Posts the card top-level there. Omit to post in the current conversation.',
        },
        key: {
          type: 'string',
          description: 'Up to 128 of A-Z a-z 0-9 . _ : - . A newer card with the same key closes this one.',
        },
      },
      required: ['title', 'question', 'options'],
    },
  },
  async handler(args) {
    const { title, question, options: rawOptions, to, key } = args;
    if (typeof title !== 'string' || !title.trim() || typeof question !== 'string' || !question.trim()) {
      return err('title and question are required');
    }
    if (!Array.isArray(rawOptions) || rawOptions.length < 1 || rawOptions.length > MAX_CHOICE_OPTIONS) {
      return err(`options must hold 1 to ${MAX_CHOICE_OPTIONS} entries`);
    }
    const options: Array<{ label: string; value: string; style?: string }> = [];
    const seen = new Set<string>();
    for (const raw of rawOptions as unknown[]) {
      const { label, value, style } = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      if (typeof label !== 'string' || !label.trim()) return err('every option needs a non-empty label');
      if (typeof value !== 'string' || !value) return err(`option "${label}" needs a non-empty value`);
      if (seen.has(value)) return err(`option values must be unique ("${value}" repeats)`);
      if (style !== undefined && !CHOICE_STYLES.has(style)) {
        return err(`option "${label}" has an unknown style (use primary, danger or default)`);
      }
      seen.add(value);
      options.push({ label, value, ...(style !== undefined ? { style: style as string } : {}) });
    }
    if (key !== undefined && (typeof key !== 'string' || !KEY_RE.test(key))) {
      return err('key must be 1-128 characters of letters, digits and . _ : -');
    }

    // Routing: a named channel destination (the host re-authorizes it), or
    // nothing — the host then posts into this session's own conversation and
    // thread, where send_message and ask_user_question land too.
    let target: { to: string; channelType: string; platformId: string } | undefined;
    if (to !== undefined) {
      if (typeof to !== 'string' || !to) return err('to must be a destination name');
      const dest = findByName(to);
      if (!dest) return err(`Unknown destination "${to}". Channel destinations: ${channelDestinationNames()}`);
      if (dest.type !== 'channel' || !dest.channelType || !dest.platformId) {
        return err(`"${to}" is not a channel destination. Channel destinations: ${channelDestinationNames()}`);
      }
      target = { to, channelType: dest.channelType, platformId: dest.platformId };
    } else {
      const routing = getSessionRouting();
      if (getTaskSeriesId() || !routing.channel_type || !routing.platform_id || routing.channel_type === 'agent') {
        return err(
          `This session has no conversation to post a card into — pass "to" with a channel destination. Options: ${channelDestinationNames()}`,
        );
      }
    }

    const choiceId = `choice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await writeMessageOut({
      id: choiceId,
      kind: 'system',
      content: JSON.stringify({
        action: 'request_choice',
        choiceId,
        title,
        question,
        options,
        ...(key !== undefined ? { key } : {}),
        ...(target ?? {}),
      }),
    });

    log(
      `request_choice: ${choiceId}${target ? ` → ${target.to}` : ''} "${question}" [${options.map((o) => o.value).join(', ')}]`,
    );
    return ok(
      `Choice card requested (choice_id: ${choiceId}). This call does not wait: the answer arrives later as a "choice_response" message carrying this choice_id.`,
    );
  },
};

registerTools([requestChoice]);
