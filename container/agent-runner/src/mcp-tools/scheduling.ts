/**
 * Scheduling MCP tools: schedule_task, list_tasks, cancel_task, pause_task, resume_task.
 *
 * With the two-DB split, the container cannot write to inbound.db (host-owned).
 * Scheduling operations are sent as system actions via messages_out — the host
 * reads them during delivery and applies the changes to inbound.db.
 */
import type { Database } from 'bun:sqlite';

import { openChannelInboundDb, openInboundDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { TIMEZONE, parseZonedToUtc } from '../timezone.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

interface TaskRow {
  id: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  thread_id: string | null;
  content: string;
}

/**
 * Scheduled tasks live in one of two inbound.dbs visible to this container:
 *   - the OWN session inbound (`/workspace/inbound.db`) — holds thread-scoped
 *     loops bound to this thread;
 *   - the channel-root mount (`/workspace/channel-inbound.db`) — holds durable
 *     channel-scoped tasks.
 * For a channel-root container the two can reference the same rows, so we dedupe
 * by series id. One row per series — the live (pending/paused) occurrence.
 */
function collectLiveTasks(status: string | undefined): TaskRow[] {
  const seen = new Set<string>();
  const out: TaskRow[] = [];
  for (const db of [openInboundDb(), openChannelInboundDb()] as Array<Database | null>) {
    if (!db) continue;
    try {
      const where = status ? 'status = ?' : "status IN ('pending', 'paused')";
      const sql =
        `SELECT series_id AS id, status, process_after, recurrence, thread_id, content, MAX(seq) AS _seq
           FROM messages_in
          WHERE kind = 'task' AND ${where}
          GROUP BY series_id`;
      const rows = (status ? db.prepare(sql).all(status) : db.prepare(sql).all()) as TaskRow[];
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
      }
    } finally {
      db.close();
    }
  }
  out.sort((a, b) => (a.process_after ?? '').localeCompare(b.process_after ?? ''));
  return out;
}

function generateId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function routing() {
  return getSessionRouting();
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const scheduleTask: McpToolDefinition = {
  tool: {
    name: 'schedule_task',
    description:
      `Schedule a one-shot or recurring task. The user's timezone is declared in the <context timezone="..."/> header of your prompt — interpret the user's "9pm" etc. in that zone. Cron expressions are interpreted in the user's timezone too.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'Task instructions/prompt' },
        processAfter: {
          type: 'string',
          description:
            `ISO 8601 timestamp for the first run. Accepts either UTC (ending in "Z" or "+00:00") or a naive local timestamp (no offset) which is interpreted in the user's timezone (e.g. "2026-01-15T21:00:00" = 9pm user-local). Prefer naive local.`,
        },
        recurrence: {
          type: 'string',
          description:
            'Cron expression for recurring tasks (e.g., "0 9 * * 1-5" = weekdays at 9am user-local). Evaluated in the user\'s timezone.',
        },
        script: { type: 'string', description: 'Optional pre-agent script to run before processing' },
        scope: {
          type: 'string',
          enum: ['channel', 'thread'],
          description:
            `Where the task lives and reports. 'channel' (default): durable — runs in the channel-root session and posts to the channel root, surviving thread archival. Use for standing tasks like inbox pollers. 'thread': an opt-in recurring "loop" bound to THIS thread — runs in this thread's session and reports IN this thread. It lives and dies with the thread, which is correct for an ephemeral, self-cancelling loop started in a conversation (e.g. "loop until the PR is approved, report here"). Only meaningful when invoked from within a thread; from the channel root it falls back to 'channel'.`,
        },
        model: {
          type: 'string',
          description:
            `Optional model to run this task's fires on. Set it when the user names a model (e.g. "use sonnet" → "sonnet", "run it on opus" → "opus"). Accepts family aliases ("sonnet", "opus", "haiku") or exact ids; for codex/opencode agents use that provider's model ids. OMIT to use the scheduled-task default (Claude agents default to Sonnet). Invalid values are rejected host-side, so pass the user's words as-is rather than guessing an id.`,
        },
        effort: {
          type: 'string',
          description:
            `Optional reasoning effort for this task's fires: "low" | "medium" | "high" | "xhigh" | "max" (supported levels vary by model/provider). Set it when the user names an effort (e.g. "medium effort" → "medium"). OMIT to use the default (high).`,
        },
      },
      required: ['prompt', 'processAfter'],
    },
  },
  async handler(args) {
    const prompt = args.prompt as string;
    const processAfterIn = args.processAfter as string;
    if (!prompt || !processAfterIn) return err('prompt and processAfter are required');
    const scope = args.scope === 'thread' ? 'thread' : 'channel';

    let processAfter: string;
    try {
      const d = parseZonedToUtc(processAfterIn, TIMEZONE);
      if (Number.isNaN(d.getTime())) return err(`invalid processAfter: ${processAfterIn}`);
      processAfter = d.toISOString();
    } catch {
      return err(`invalid processAfter: ${processAfterIn}`);
    }

    const id = generateId();
    const r = routing();
    const recurrence = (args.recurrence as string) || null;
    const script = (args.script as string) || null;

    // Write as a system action — host will insert into inbound.db
    writeMessageOut({
      id,
      kind: 'system',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        action: 'schedule_task',
        taskId: id,
        prompt,
        script,
        processAfter,
        recurrence,
        scope,
        // Model/effort are validated + resolved to a flagIntent host-side
        // (handleScheduleTask) against this agent's provider vocab. Passed as
        // the user's raw words; omitted keys leave the task on the default.
        ...(typeof args.model === 'string' && args.model ? { model: args.model } : {}),
        ...(typeof args.effort === 'string' && args.effort ? { effort: args.effort } : {}),
        platformId: r.platform_id,
        channelType: r.channel_type,
        threadId: r.thread_id,
      }),
    });

    log(`schedule_task: ${id} at ${processAfter}${recurrence ? ` (recurring: ${recurrence})` : ''} scope=${scope}`);
    return ok(
      `Task scheduled (id: ${id}, runs at: ${processAfter}${recurrence ? `, recurrence: ${recurrence}` : ''}${scope === 'thread' ? ', scope: thread (reports in this thread)' : ''})`,
    );
  },
};

export const listTasks: McpToolDefinition = {
  tool: {
    name: 'list_tasks',
    description:
      'List scheduled tasks. Returns one row per series — the live (pending or paused) occurrence. The id shown is the series id, which is what update_task / cancel_task / pause_task / resume_task expect.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter by status: pending or paused (default: both)' },
      },
    },
  },
  async handler(args) {
    const status = args.status as string | undefined;
    // Merge thread-scoped loops (own inbound) + durable channel tasks (channel
    // mount), one row per series. The series_id is the stable handle the
    // update/cancel/pause/resume tools expect.
    const rows = collectLiveTasks(status);
    if (rows.length === 0) return ok('No tasks found.');

    const lines = rows.map((r) => {
      const content = JSON.parse(r.content);
      const prompt = ((content.prompt as string) || '').slice(0, 80);
      const scope = r.thread_id ? ' [thread]' : '';
      return `- ${r.id} [${r.status}]${scope} at=${r.process_after || 'now'} ${r.recurrence ? `recur=${r.recurrence} ` : ''}→ ${prompt}`;
    });

    return ok(lines.join('\n'));
  },
};

export const readTask: McpToolDefinition = {
  tool: {
    name: 'read_task',
    description:
      `Return the full content of a scheduled task by series id. Use this when you need to read the existing prompt or script before calling update_task with a targeted edit — list_tasks only shows a truncated preview. Returns the live (pending or paused) occurrence.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Series id from list_tasks' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');
    // Look across both inboxes (thread-scoped own inbound + channel mount).
    const row = collectLiveTasks(undefined).find((r) => r.id === taskId);
    if (!row) return err(`task not found: ${taskId} (no live row for this series)`);

    const parsed = JSON.parse(row.content) as { prompt?: string; script?: string };
    const lines = [
      `id: ${row.id}`,
      `status: ${row.status}`,
      `scope: ${row.thread_id ? 'thread (reports in this thread)' : 'channel'}`,
      `process_after: ${row.process_after ?? 'now'}`,
      `recurrence: ${row.recurrence ?? '(one-shot)'}`,
      `prompt:`,
      parsed.prompt ?? '',
    ];
    if (parsed.script) {
      lines.push(`script:`, parsed.script);
    }
    return ok(lines.join('\n'));
  },
};

export const cancelTask: McpToolDefinition = {
  tool: {
    name: 'cancel_task',
    description: 'Cancel a scheduled task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to cancel' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    // Write as a system action — host will update inbound.db
    writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'cancel_task', taskId }),
    });

    log(`cancel_task: ${taskId}`);
    return ok(`Task cancellation requested: ${taskId}`);
  },
};

export const pauseTask: McpToolDefinition = {
  tool: {
    name: 'pause_task',
    description: 'Pause a scheduled task. It will not run until resumed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to pause' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'pause_task', taskId }),
    });

    log(`pause_task: ${taskId}`);
    return ok(`Task pause requested: ${taskId}`);
  },
};

export const resumeTask: McpToolDefinition = {
  tool: {
    name: 'resume_task',
    description: 'Resume a paused task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to resume' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'resume_task', taskId }),
    });

    log(`resume_task: ${taskId}`);
    return ok(`Task resume requested: ${taskId}`);
  },
};

export const updateTask: McpToolDefinition = {
  tool: {
    name: 'update_task',
    description:
      'Update a scheduled task. Pass the series id from list_tasks. Any field omitted is left unchanged. Use this instead of cancel + reschedule when adjusting an existing task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Series id of the task to update (as shown by list_tasks)' },
        prompt: { type: 'string', description: 'New task prompt (optional)' },
        recurrence: {
          type: 'string',
          description: 'New cron expression (optional). Pass empty string to clear and make the task one-shot.',
        },
        processAfter: {
          type: 'string',
          description:
            `New ISO 8601 timestamp for the next run (optional). Accepts either UTC (ending in "Z" / "+00:00") or a naive local timestamp interpreted in the user's timezone.`,
        },
        script: {
          type: 'string',
          description: 'New pre-agent script (optional). Pass empty string to clear.',
        },
        model: {
          type: 'string',
          description:
            `New model for this task's fires (optional). Set when the user changes it (e.g. "switch that task to opus"). Family aliases ("sonnet"/"opus"/"haiku") or exact ids; validated host-side. Leaves the current pin unchanged if omitted.`,
        },
        effort: {
          type: 'string',
          description:
            `New reasoning effort for this task's fires (optional): "low" | "medium" | "high" | "xhigh" | "max". Leaves the current effort unchanged if omitted.`,
        },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    const update: Record<string, unknown> = { taskId };
    if (typeof args.prompt === 'string') update.prompt = args.prompt;
    if (typeof args.model === 'string' && args.model) update.model = args.model;
    if (typeof args.effort === 'string' && args.effort) update.effort = args.effort;
    if (typeof args.processAfter === 'string') {
      try {
        const d = parseZonedToUtc(args.processAfter, TIMEZONE);
        if (Number.isNaN(d.getTime())) return err(`invalid processAfter: ${args.processAfter}`);
        update.processAfter = d.toISOString();
      } catch {
        return err(`invalid processAfter: ${args.processAfter}`);
      }
    }
    // Empty string clears recurrence/script; undefined leaves them as-is.
    if (typeof args.recurrence === 'string') update.recurrence = args.recurrence === '' ? null : args.recurrence;
    if (typeof args.script === 'string') update.script = args.script === '' ? null : args.script;

    if (Object.keys(update).length === 1) return err('at least one field to update is required');

    writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'update_task', ...update }),
    });

    log(`update_task: ${taskId}`);
    return ok(`Task update requested: ${taskId}`);
  },
};

registerTools([scheduleTask, listTasks, readTask, updateTask, cancelTask, pauseTask, resumeTask]);
