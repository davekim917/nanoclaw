/** `update_task_list` tool surface (logic in ../task-list.ts). Registered only when spawned with NANOCLAW_TASK_LIST=1; spawn-scoped, so flipping the host switch never changes a running container's tools. */
import { awaitDeliveryAck } from '../db/delivery-acks.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting, getTaskSeriesId } from '../db/session-routing.js';
import { getCurrentInReplyTo } from '../db/session-state.js';
import { getAgentMailbox } from '../mailbox/index.js';
import {
  applyTaskListUpdate,
  describeOutcome,
  parseTaskListInput,
  parseTaskListState,
  TASK_LIST_ITEM_MAX,
  TASK_LIST_ITEMS_MAX,
  TASK_LIST_STATE_KEY,
  TASK_LIST_TITLE_MAX,
  taskListEnabled,
  type TaskListDeps,
} from '../task-list.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true as const };
}

/** Serializes update_task_list calls within this MCP server process. */
let updateChain: Promise<unknown> = Promise.resolve();

const TASK_LIST_DESCRIPTION =
  'Keep a live task list in this conversation: one checklist message, edited in place, that shows people what you are doing without them watching you work. ' +
  'Use it proactively — nobody will ask for it — whenever a request takes 3 or more distinct steps or several tool calls; start it before the first step. Skip it for a quick answer, a single step, or conversation. ' +
  'Send the WHOLE list every call (it replaces the last one): a short title naming the work (e.g. "Migrating the orders table"), and every item with its status. ' +
  'Call it when you start, when an item starts or finishes, and when you add work; keep one item in_progress while you work. ' +
  'Write items as actions ("Run the migration"). When one finishes, rewrite it as its outcome ("Migration ran: 14 tables, no errors"), so the finished list reads as a summary. ' +
  'Format items like chat: backtick identifiers (`orders_v2`, `pnpm test`), link PRs and issues as [repo#123](url), and name channels as #name. ' +
  'A follow-up that arrives while you work: react to acknowledge it and add it as an item, rather than starting another list. ' +
  'The list is progress, not the deliverable: post results, findings and answers as their own messages. ' +
  'Updating the list notifies no one, so a blocker, a question, an approval you need, or the final result goes in a new message, and you @-mention someone only when they must act. ' +
  'Set new_list true only to start unrelated work while an older list is unfinished; a finished list is replaced automatically. ' +
  'Only the main agent keeps the list: a delegated subagent or worker never calls this tool, and reports its progress in its result instead.';

export const updateTaskList: McpToolDefinition = {
  tool: {
    name: 'update_task_list',
    description: TASK_LIST_DESCRIPTION,
    // Keep the tool loaded: Claude Code defers MCP tools behind tool search by default, and a deferred list goes
    // unused. Other providers ignore _meta.
    _meta: { 'anthropic/alwaysLoad': true },
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          maxLength: TASK_LIST_TITLE_MAX,
          description: 'One short line naming the work.',
        },
        items: {
          type: 'array',
          maxItems: TASK_LIST_ITEMS_MAX,
          description: 'The whole list, in order.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', maxLength: TASK_LIST_ITEM_MAX },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
            },
            required: ['text', 'status'],
          },
        },
        new_list: {
          type: 'boolean',
          description: 'Start a separate list for unrelated new work instead of updating the current one.',
        },
      },
      required: ['title', 'items'],
    },
  },
  async handler(args) {
    if (getTaskSeriesId()) {
      return err('task lists are for conversations; a scheduled task reports through send_message');
    }
    const input = parseTaskListInput(args);
    if ('error' in input) return err(input.error);
    const session = getSessionRouting();
    if (!session.channel_type || !session.platform_id || session.channel_type === 'agent') {
      return err('this session has no conversation to show a task list in');
    }
    const ops = getAgentMailbox().operations;
    // A channel-level session has no thread of its own; post the list in the replied-to message's thread.
    let threadId = session.thread_id;
    if (threadId === null) {
      const inReplyTo = getCurrentInReplyTo();
      const inbound = inReplyTo ? ops.getInboundRouteById(inReplyTo) : null;
      if (inbound && inbound.channelType === session.channel_type && inbound.platformId === session.platform_id) {
        threadId = inbound.threadId;
      }
    }
    const routing = { channelType: session.channel_type, platformId: session.platform_id, threadId };
    const deps: TaskListDeps = {
      load: () => parseTaskListState(ops.getState(TASK_LIST_STATE_KEY)?.value),
      save: (state) => ops.setState(TASK_LIST_STATE_KEY, JSON.stringify(state)),
      async write(content, r) {
        const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const seq = await writeMessageOut({
          id,
          in_reply_to: getCurrentInReplyTo(),
          kind: 'task_list',
          platform_id: r.platformId,
          channel_type: r.channelType,
          thread_id: r.threadId,
          content: JSON.stringify(content),
        });
        return { id, seq };
      },
      async awaitPlatformId(outboundId, timeoutMs) {
        const ack = await awaitDeliveryAck(outboundId, timeoutMs);
        if (!ack) return { platformId: null, failed: false };
        // Delivered without a platform id means the host recorded it without posting: treat as failed so the next update posts afresh.
        if (ack.status === 'delivered' && ack.platformMessageId)
          return { platformId: ack.platformMessageId, failed: false };
        return { platformId: null, failed: true };
      },
      inboundSeq: () => ops.maxInboundSeq(),
      messagesAfter: (outboundSeq, inboundSeq) =>
        ops.countConversationMessagesAfter(outboundSeq, inboundSeq, {
          platformId: routing.platformId,
          threadId: routing.threadId,
        }),
      now: () => new Date(),
    };
    // One update at a time: each reads, writes and saves the one record, so a
    // parallel pair must not interleave (duplicate posts, lost revisions).
    const run = updateChain.then(() => applyTaskListUpdate(input, routing, deps));
    updateChain = run.catch(() => undefined);
    const outcome = await run;
    if (!outcome.ok) return err(outcome.error);
    return ok(describeOutcome(outcome));
  },
};

if (taskListEnabled()) registerTools([updateTaskList]);
