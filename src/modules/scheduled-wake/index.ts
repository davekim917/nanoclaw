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

import { insertMessage, readSessionRouting } from '../../db/session-db.js';
import { registerDeliveryAction, type DeliveryActionResult } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

const MAX_PROMPT_CHARS = 2000;
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — host-side backstop; the tool caps at 7.

export async function applyScheduleWake(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<DeliveryActionResult> {
  const prompt = typeof content.prompt === 'string' ? content.prompt.trim() : '';
  const processAfterRaw = typeof content.process_after === 'string' ? content.process_after : '';
  const fireAtMs = Date.parse(processAfterRaw);
  const now = Date.now();
  if (
    prompt === '' ||
    prompt.length > MAX_PROMPT_CHARS ||
    !Number.isFinite(fireAtMs) ||
    fireAtMs <= now ||
    fireAtMs - now > MAX_DELAY_MS
  ) {
    log.warn('schedule_wake rejected: invalid payload', {
      sessionId: session.id,
      promptChars: prompt.length,
      process_after: processAfterRaw,
    });
    return undefined;
  }

  const routing = readSessionRouting(inDb);
  insertMessage(inDb, {
    id: `schedule-wake-${now}-${Math.random().toString(36).slice(2, 8)}`,
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
    processAfter: new Date(fireAtMs).toISOString(),
    recurrence: null,
    trigger: 1,
  });
  log.info('schedule_wake queued', { sessionId: session.id, fireAt: new Date(fireAtMs).toISOString() });
  return undefined;
}

registerDeliveryAction(
  'schedule_wake',
  applyScheduleWake,
  unguarded("in-session self-scheduling; writes only a process_after row to the caller's own session inbound.db"),
);
