/**
 * Child-only MCP tools: spawn_progress, spawn_complete, spawn_failed,
 * spawn_request_steer.
 *
 * Mounted ONLY when getSessionSpawnTaskId() !== null — i.e., this container
 * is running as a child of an orchestrator's spawn.
 *
 * All tools write kind='system' outbound rows. task_id is auto-filled
 * from session metadata (getSessionSpawnTaskId) so the agent doesn't need
 * to pass it explicitly — the tool injection layer fills it in.
 */
import { writeMessageOut, type WriteMessageOut } from '../db/messages-out.js';
import { getSessionSpawnTaskId } from '../db/session-routing.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[spawn-child] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true as const };
}

function sysId(): string {
  return `spawn-child-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface SpawnChildDependencies {
  getSessionSpawnTaskId: () => string | null;
  writeMessageOut: (message: WriteMessageOut) => number;
  makeSystemId: () => string;
  log: (message: string) => void;
}

const DEFAULT_DEPENDENCIES: SpawnChildDependencies = {
  getSessionSpawnTaskId,
  writeMessageOut,
  makeSystemId: sysId,
  log,
};

/**
 * Resolve task_id, write a kind='system' envelope carrying the action, log.
 * Shared scaffolding for every spawn_* handler. `extra` lets each caller
 * attach action-specific fields (message / summary / fail_reason / question)
 * to the envelope. `logSuffix` is appended to the log line for grep-ability.
 */
function emitSpawnAction(
  dependencies: SpawnChildDependencies,
  action: 'spawn_progress' | 'spawn_complete' | 'spawn_failed' | 'spawn_request_steer',
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
  ackMessage: string,
  logSuffix = '',
) {
  const taskId = (args.task_id as string | undefined) ?? dependencies.getSessionSpawnTaskId();
  if (!taskId) return err('task_id could not be determined — not running as a spawned child');

  dependencies.writeMessageOut({
    id: dependencies.makeSystemId(),
    kind: 'system',
    content: JSON.stringify({ action, task_id: taskId, ...extra }),
  });

  dependencies.log(`${action}: ${taskId}${logSuffix}`);
  return ok(ackMessage);
}

export function createSpawnChildTools(dependencyOverrides: Partial<SpawnChildDependencies> = {}): {
  spawnProgress: McpToolDefinition;
  spawnComplete: McpToolDefinition;
  spawnFailed: McpToolDefinition;
  spawnRequestSteer: McpToolDefinition;
} {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };

  const spawnProgress: McpToolDefinition = {
    tool: {
      name: 'spawn_progress',
      description:
        'Report progress on this spawned task to the parent orchestrator. Fire-and-forget — the parent sees this on its next turn.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message: { type: 'string', description: 'Progress update message for the orchestrator.' },
          task_id: { type: 'string', description: 'Task ID (optional — auto-filled from session metadata).' },
        },
        required: ['message'],
      },
    },
    async handler(args) {
      const message = args.message as string | undefined;
      if (!message) return err('message is required');
      return emitSpawnAction(
        dependencies,
        'spawn_progress',
        args,
        { message },
        `Progress reported: ${message}`,
        ` — ${message}`,
      );
    },
  };

  const spawnComplete: McpToolDefinition = {
    tool: {
      name: 'spawn_complete',
      description:
        'Mark this spawned task as successfully completed. Terminal state — the parent receives the summary on its next turn.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          summary: { type: 'string', description: 'Summary of work completed for the parent orchestrator.' },
          task_id: { type: 'string', description: 'Task ID (optional — auto-filled from session metadata).' },
        },
        required: ['summary'],
      },
    },
    async handler(args) {
      const summary = args.summary as string | undefined;
      if (!summary) return err('summary is required');
      return emitSpawnAction(
        dependencies,
        'spawn_complete',
        args,
        { summary },
        'Task completed. Summary sent to orchestrator.',
      );
    },
  };

  const spawnFailed: McpToolDefinition = {
    tool: {
      name: 'spawn_failed',
      description:
        'Mark this spawned task as failed. Terminal state — the parent receives the failure details on its next turn.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          summary: { type: 'string', description: 'Summary of what went wrong for the parent orchestrator.' },
          fail_reason: {
            type: 'string',
            description: 'Short machine-readable failure category (e.g., "agent_error", "deadline_exceeded").',
          },
          task_id: { type: 'string', description: 'Task ID (optional — auto-filled from session metadata).' },
        },
        required: ['summary'],
      },
    },
    async handler(args) {
      const summary = args.summary as string | undefined;
      if (!summary) return err('summary is required');
      const extra: Record<string, unknown> = { summary };
      if (args.fail_reason !== undefined) extra.fail_reason = args.fail_reason;
      return emitSpawnAction(
        dependencies,
        'spawn_failed',
        args,
        extra,
        'Task failure reported to orchestrator.',
        args.fail_reason ? ` (${args.fail_reason})` : '',
      );
    },
  };

  const spawnRequestSteer: McpToolDefinition = {
    tool: {
      name: 'spawn_request_steer',
      description:
        'Signal that this spawned task is blocked waiting on operator input — surfaces in the dashboard "Needs you" lane. Non-terminal: the task remains running. Call instead of merely printing a question into chat, which leaves the worker indistinguishable from one actively working.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          question: {
            type: 'string',
            description:
              'Optional one-line summary of what you need from the operator. Shown above the steer composer in the dashboard. Keep ≤500 chars.',
          },
          task_id: { type: 'string', description: 'Task ID (optional — auto-filled from session metadata).' },
        },
        required: [],
      },
    },
    async handler(args) {
      const extra: Record<string, unknown> = {};
      if (args.question !== undefined) extra.question = args.question;
      return emitSpawnAction(
        dependencies,
        'spawn_request_steer',
        args,
        extra,
        'Steer request signaled. Idle until operator responds.',
        args.question ? ` — ${String(args.question).slice(0, 80)}` : '',
      );
    },
  };

  return { spawnProgress, spawnComplete, spawnFailed, spawnRequestSteer };
}

export const { spawnProgress, spawnComplete, spawnFailed, spawnRequestSteer } = createSpawnChildTools();
