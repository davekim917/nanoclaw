import {
  cancelWorkContinuation,
  queueWorkContinuation,
  WORK_CONTINUATION_CHAIN_MAX,
  WORK_CONTINUATION_TASK_MAX_CHARS,
} from '../db/session-state.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true as const };
}

export const continueWork: McpToolDefinition = {
  tool: {
    name: 'continue_work',
    description:
      'Durably hand yourself one unfinished next step. Call this BEFORE ending a turn that promises more work. ' +
      'The runner immediately starts the task after the current response and resumes it after container or host restarts. ' +
      'Calling it again replaces the queued task. Do not use it for a time delay; use wait for that.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        task: {
          type: 'string',
          minLength: 1,
          maxLength: WORK_CONTINUATION_TASK_MAX_CHARS,
          description: 'Concrete next action to start immediately after this turn.',
        },
      },
      required: ['task'],
    },
  },
  async handler(args) {
    if (Object.keys(args).some((key) => key !== 'task')) return err('unknown input field');
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (!task || task.length > WORK_CONTINUATION_TASK_MAX_CHARS) {
      return err(`task is required (max ${WORK_CONTINUATION_TASK_MAX_CHARS} chars)`);
    }
    const queued = queueWorkContinuation(task);
    if (!queued.accepted) {
      return err(
        `autonomous continuation reached its ${WORK_CONTINUATION_CHAIN_MAX}-turn safety cap; ` +
          'tell the user what remains and wait for real input',
      );
    }
    return ok(`Continuation queued: ${queued.continuation.task}`);
  },
};

export const cancelContinuation: McpToolDefinition = {
  tool: {
    name: 'cancel_continuation',
    description:
      'Cancel durable unfinished work only when the user explicitly says to stop. Status questions do not cancel work.',
    inputSchema: { type: 'object' as const, additionalProperties: false, properties: {} },
  },
  async handler(args) {
    if (Object.keys(args).length > 0) return err('cancel_continuation takes no arguments');
    cancelWorkContinuation();
    return ok('Durable continuation cancelled.');
  },
};

registerTools([continueWork, cancelContinuation]);
