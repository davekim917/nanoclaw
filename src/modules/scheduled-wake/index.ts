/**
 * Scheduled-wake module — the in-session "wait" primitive.
 *
 * The container agent's `wait` MCP tool writes a kind='system' outbound row
 * with action 'schedule_wake'; this handler converts it into a
 * `process_after` row in the SAME session's inbound.db. When it fires, the
 * sweep's due-wake step wakes this session (or a warm container's follow-up
 * poll pushes it into the active query) — an in-thread continuation with
 * full conversation context. This is deliberately NOT `ncl tasks`: a core
 * scheduled task fires in an isolated task session and posts to a
 * destination, which is the wrong shape for "I'll check CI in 15 minutes"
 * said inside a thread.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';

import { insertDeferredMessageWithContextIfNew, readSessionRouting } from '../../db/session-db.js';
import { registerDeliveryAction, type DeliveryActionResult } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

const MAX_PROMPT_CHARS = 2000;
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — host-side backstop; the tool caps at 7.
const ALLOWED_KEYS = new Set(['action', 'wake_id', 'process_after', 'prompt', 'in_reply_to']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function applyScheduleWake(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<DeliveryActionResult> {
  const prompt = typeof content.prompt === 'string' ? content.prompt.trim() : '';
  const wakeId = typeof content.wake_id === 'string' ? content.wake_id : '';
  const processAfterRaw = typeof content.process_after === 'string' ? content.process_after : '';
  const hasInReplyTo = Object.hasOwn(content, 'in_reply_to');
  const inReplyTo = typeof content.in_reply_to === 'string' ? content.in_reply_to : null;
  const fireAtMs = Date.parse(processAfterRaw);
  const now = Date.now();
  const unknownKeys = Object.keys(content).filter((key) => !ALLOWED_KEYS.has(key));
  if (
    unknownKeys.length > 0 ||
    (hasInReplyTo &&
      content.in_reply_to !== null &&
      (inReplyTo === null || inReplyTo.length === 0 || inReplyTo.length > 1024)) ||
    (wakeId !== '' && !UUID_RE.test(wakeId)) ||
    prompt === '' ||
    prompt.length > MAX_PROMPT_CHARS ||
    !Number.isFinite(fireAtMs) ||
    new Date(fireAtMs).toISOString() !== processAfterRaw ||
    fireAtMs - now > MAX_DELAY_MS
  ) {
    log.warn('schedule_wake rejected: invalid payload', {
      sessionId: session.id,
      promptChars: prompt.length,
      wakeId,
      process_after: processAfterRaw,
      unknownKeys,
    });
    throw new Error('schedule_wake rejected: invalid payload');
  }

  const anchoredRouting = inReplyTo
    ? (inDb.prepare('SELECT platform_id, channel_type, thread_id FROM messages_in WHERE id = ?').get(inReplyTo) as
        | { platform_id: string | null; channel_type: string | null; thread_id: string | null }
        | undefined)
    : undefined;
  if (inReplyTo && !anchoredRouting) {
    log.warn('schedule_wake rejected: reply anchor is not in the caller session', {
      sessionId: session.id,
      inReplyTo,
    });
    throw new Error('schedule_wake rejected: invalid reply anchor');
  }
  const routing = anchoredRouting ?? readSessionRouting(inDb);
  const effectiveWakeId =
    wakeId ||
    `legacy-${createHash('sha256').update(`${session.id}\0${processAfterRaw}\0${prompt}`).digest('hex').slice(0, 32)}`;
  const processAfter = new Date(Math.max(fireAtMs, now)).toISOString();
  const inserted = insertDeferredMessageWithContextIfNew(inDb, {
    id: `schedule-wake-${effectiveWakeId}`,
    kind: 'chat',
    timestamp: new Date(now).toISOString(),
    platformId: routing?.platform_id ?? null,
    channelType: routing?.channel_type ?? null,
    threadId: routing?.thread_id ?? null,
    content: JSON.stringify({
      text: `[system] ${prompt}`,
      sender: 'system',
      senderId: 'system',
      _system: { kind: 'agent_scheduled_wake' },
    }),
    processAfter,
    recurrence: null,
  });
  log.info(inserted ? 'schedule_wake queued' : 'schedule_wake replay ignored', {
    sessionId: session.id,
    wakeId: effectiveWakeId,
    fireAt: processAfter,
  });
  return undefined;
}

registerDeliveryAction(
  'schedule_wake',
  applyScheduleWake,
  unguarded("in-session self-scheduling; writes only a process_after row to the caller's own session inbound.db"),
);
