/**
 * The `wait` tool — an in-session delayed wake ("check CI in 15 minutes").
 *
 * Writes a kind='system' outbound row with action 'schedule_wake'; the host
 * converts it into a process_after row in THIS session's inbound.db. The
 * wake fires in this thread with full conversation context — unlike
 * `ncl tasks create`, which creates a standalone scheduled job in an
 * isolated task session whose output posts to a destination.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const MAX_MINUTES = 7 * 24 * 60; // 7 days
const MAX_PROMPT_CHARS = 2000;

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true as const };
}

export const wait: McpToolDefinition = {
  tool: {
    name: 'wait',
    description:
      'Schedule a wake in THIS thread after a delay — for time-based waits like "check CI in 15 minutes". ' +
      'The prompt comes back to you as a message in this session when it fires, with full conversation context. ' +
      'Not for next-step continuations (end the turn with a NEXT: directive instead) and not for standalone ' +
      'scheduled jobs that post to a destination (use ncl tasks create for those).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        minutes: {
          type: 'number',
          description: `Delay in minutes from now (0 < minutes <= ${MAX_MINUTES}). Exactly one of minutes/at is required.`,
        },
        at: {
          type: 'string',
          description: 'Absolute fire time as ISO 8601 (e.g. "2026-07-28T15:00:00Z"). Exactly one of minutes/at is required.',
        },
        prompt: {
          type: 'string',
          description:
            'The instruction that comes back to you when the wake fires, e.g. "Check CI for PR #207 and report status here".',
        },
      },
      required: ['prompt'],
    },
  },
  async handler(args) {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    const minutes = typeof args.minutes === 'number' ? args.minutes : undefined;
    const at = typeof args.at === 'string' ? args.at : undefined;

    if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
      return err(`prompt is required (max ${MAX_PROMPT_CHARS} chars)`);
    }
    if ((minutes === undefined) === (at === undefined)) {
      return err('pass exactly one of minutes or at');
    }

    let fireAtMs: number;
    if (minutes !== undefined) {
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) {
        return err(`minutes must be in (0, ${MAX_MINUTES}]`);
      }
      fireAtMs = Date.now() + Math.round(minutes * 60_000);
    } else {
      fireAtMs = Date.parse(at as string);
      if (!Number.isFinite(fireAtMs)) return err(`at is not a valid timestamp: ${at}`);
      if (fireAtMs <= Date.now()) return err('at must be in the future');
      if (fireAtMs - Date.now() > MAX_MINUTES * 60_000) return err(`at must be within ${MAX_MINUTES} minutes (7 days)`);
    }

    const fireAtIso = new Date(fireAtMs).toISOString();
    writeMessageOut({
      id: `wait-sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'schedule_wake', process_after: fireAtIso, prompt }),
    });
    return ok(`Wake scheduled for ${fireAtIso}. It fires in THIS thread — the prompt comes back to you as a message then.`);
  },
};

registerTools([wait]);
