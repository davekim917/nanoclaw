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
import { getCurrentInReplyTo } from '../db/session-state.js';
import { randomUUID } from 'node:crypto';
import { registerTools } from './server.js';
import { err, ok } from './tool-helpers.js';
import type { McpToolDefinition } from './types.js';

const MAX_MINUTES = 7 * 24 * 60; // 7 days
const MAX_PROMPT_CHARS = 2000;
const MIN_DELAY_MS = 1000;
const ALLOWED_KEYS = new Set(['minutes', 'at', 'prompt', 'dedupe_key']);
const DEDUPE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/;
const ISO_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export const wait: McpToolDefinition = {
  tool: {
    name: 'wait',
    description:
      'Schedule a wake in THIS thread after a delay — for time-based waits like "check CI in 15 minutes". ' +
      'The prompt comes back to you as a message in this session when it fires, with full conversation context restored. ' +
      'Not for immediate next-step continuations (use continue_work instead). ' +
      '`ncl tasks create` is only for jobs whose stop condition is "never" — anything with a writable end ' +
      'condition belongs in a wait loop instead of a standalone task. ' +
      'Prefer existing worker completion/failure notifications; use timed wakes for bounded fallback or deadlines. ' +
      'With dedupe_key, the first accepted request in this session fixes the time, prompt and route; ' +
      'that key cannot rearm after completion while its message row is retained.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        dedupe_key: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          pattern: DEDUPE_KEY_RE.source,
          description:
            'Optional stable work-item/artifact/purpose key (ASCII letters, digits, . _ : / # -; starts alphanumeric). ' +
            'The first accepted request wins, even after completion while its row is retained. ' +
            'Omit for independent wakes. Use a distinct meaningful key for a genuinely new episode or deadline.',
        },
        minutes: {
          type: 'number',
          description: `Delay in minutes from now (0 < minutes <= ${MAX_MINUTES}). Exactly one of minutes/at is required.`,
        },
        at: {
          type: 'string',
          description:
            'Absolute fire time as ISO 8601 (e.g. "2026-07-28T15:00:00Z"). Exactly one of minutes/at is required.',
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
    const unknownKeys = Object.keys(args).filter((key) => !ALLOWED_KEYS.has(key));
    if (unknownKeys.length > 0) return err(`unknown field(s): ${unknownKeys.join(', ')}`);

    const hasDedupeKey = Object.hasOwn(args, 'dedupe_key');
    const dedupeKey = typeof args.dedupe_key === 'string' ? args.dedupe_key : '';
    // Do not normalize keys; trim equality also rejects the final newline allowed by regex $.
    if (hasDedupeKey && (!DEDUPE_KEY_RE.test(dedupeKey) || dedupeKey.trim() !== dedupeKey)) {
      return err('dedupe_key must be 1–200 ASCII key characters, starting with a letter or digit');
    }

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
      const delayMs = Math.round(minutes * 60_000);
      if (delayMs < MIN_DELAY_MS) return err('minutes must schedule at least 1 second in the future');
      fireAtMs = Date.now() + delayMs;
    } else {
      fireAtMs = Date.parse(at as string);
      if (!Number.isFinite(fireAtMs)) return err(`at is not a valid timestamp: ${at}`);
      if (!ISO_WITH_ZONE_RE.test(at as string)) return err('at must be an ISO 8601 timestamp with a timezone');
      if (fireAtMs - Date.now() < MIN_DELAY_MS) return err('at must be at least 1 second in the future');
      if (fireAtMs - Date.now() > MAX_MINUTES * 60_000) return err(`at must be within ${MAX_MINUTES} minutes (7 days)`);
    }

    const fireAtIso = new Date(fireAtMs).toISOString();
    const wakeId = randomUUID();
    const inReplyTo = getCurrentInReplyTo();
    await writeMessageOut({
      id: `wait-sys-${wakeId}`,
      in_reply_to: inReplyTo,
      kind: 'system',
      content: JSON.stringify({
        action: 'schedule_wake',
        wake_id: wakeId,
        ...(hasDedupeKey ? { dedupe_key: dedupeKey } : {}),
        process_after: fireAtIso,
        prompt,
        in_reply_to: inReplyTo,
      }),
    });
    if (hasDedupeKey) {
      return ok(
        `Keyed wake request submitted for ${fireAtIso}. The first accepted request for this key in this session wins; ` +
          'repeats do not change its time, prompt or route, or rearm it after completion while its row is retained. ' +
          'A key is consumed by its first accepted request.',
      );
    }
    return ok(
      `Wake scheduled for ${fireAtIso}. It fires in THIS thread — the prompt comes back to you as a message then.`,
    );
  },
};

registerTools([wait]);
