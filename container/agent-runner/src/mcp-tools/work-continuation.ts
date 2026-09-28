import { getCurrentInReplyTo } from '../db/session-state.js';
import {
  cancelWorkContinuation,
  DONE_PROPOSAL_REASON_MAX_CHARS,
  proposeDone as recordDoneProposal,
  queueWorkContinuation,
  WORK_CONTINUATION_CHAIN_MAX,
  WORK_CONTINUATION_TASK_MAX_CHARS,
} from '../modules/mailbox/index.js';
import { registerTools } from './server.js';
import { err, ok } from './tool-helpers.js';
import type { McpToolDefinition } from './types.js';

export const continueWork: McpToolDefinition = {
  tool: {
    name: 'continue_work',
    description:
      'Durably hand yourself one unfinished next step. Call this BEFORE ending a turn that promises more work — ' +
      'plain future-tense prose or a "NEXT: …" note does nothing on its own. ' +
      'The runner starts the task after the current response, resuming after any input that already arrived, ' +
      'and the queued task survives container and host restarts. Calling it again replaces the queued task; ' +
      'cancel_continuation cancels it. Do not use it for a time delay; use wait for that.',
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
    if (!task) return err(`task is required (1-${WORK_CONTINUATION_TASK_MAX_CHARS} chars after trimming)`);
    // Report the received length, not just the cap, or agents binary-search it.
    if (task.length > WORK_CONTINUATION_TASK_MAX_CHARS) {
      return err(
        `task is ${task.length} chars after trimming; max is ${WORK_CONTINUATION_TASK_MAX_CHARS} — shorten it and retry`,
      );
    }
    const queued = queueWorkContinuation(task, getCurrentInReplyTo());
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

/** A PROPOSAL, not a close: nothing is stopped or archived; only an operator can end the work. */
export const proposeDone: McpToolDefinition = {
  tool: {
    name: 'propose_done',
    description:
      'Tell the operator you believe this thread is finished, with a one-line reason. ' +
      'This is a PROPOSAL, not a close: nothing stops, and you keep working if more arrives — only the operator decides. ' +
      'Callable only once you have delivered the result and hold no continuation. ' +
      'A `[system] … asked to close this thread` message IS that decision: finish or checkpoint, ' +
      'report state (done / lost / next), then call this to confirm.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: DONE_PROPOSAL_REASON_MAX_CHARS,
          description: 'One line on what was finished and how you know — this is what the operator reads.',
        },
      },
      required: ['reason'],
    },
  },
  async handler(args) {
    if (Object.keys(args).some((key) => key !== 'reason')) return err('unknown input field');
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    if (!reason) return err(`reason is required (1-${DONE_PROPOSAL_REASON_MAX_CHARS} chars after trimming)`);
    if (reason.length > DONE_PROPOSAL_REASON_MAX_CHARS) {
      return err(
        `reason is ${reason.length} chars after trimming; max is ${DONE_PROPOSAL_REASON_MAX_CHARS} — shorten it and retry`,
      );
    }
    const proposal = recordDoneProposal(reason);
    return ok(`Close proposed at ${proposal.proposed_at}. The operator decides; nothing has stopped.`);
  },
};

registerTools([continueWork, cancelContinuation, proposeDone]);
