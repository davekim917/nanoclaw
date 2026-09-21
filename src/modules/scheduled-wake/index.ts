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
import { createHash } from 'crypto';

import { registerDeliveryAction, type DeliveryActionResult } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';

const MAX_PROMPT_CHARS = 2000;
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — host-side backstop; the tool caps at 7.
const ALLOWED_KEYS = new Set(['action', 'wake_id', 'process_after', 'prompt', 'in_reply_to', 'dedupe_key']);
const DEDUPE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function applyScheduleWake(
  content: Record<string, unknown>,
  session: Session,
): Promise<DeliveryActionResult> {
  const prompt = typeof content.prompt === 'string' ? content.prompt.trim() : '';
  const wakeId = typeof content.wake_id === 'string' ? content.wake_id : '';
  const processAfterRaw = typeof content.process_after === 'string' ? content.process_after : '';
  const hasDedupeKey = Object.hasOwn(content, 'dedupe_key');
  const dedupeKey = typeof content.dedupe_key === 'string' ? content.dedupe_key : '';
  const hasInReplyTo = Object.hasOwn(content, 'in_reply_to');
  const inReplyTo = typeof content.in_reply_to === 'string' ? content.in_reply_to : null;
  const fireAtMs = Date.parse(processAfterRaw);
  const now = Date.now();
  const unknownKeys = Object.keys(content).filter((key) => !ALLOWED_KEYS.has(key));
  if (
    unknownKeys.length > 0 ||
    // Strict identity: reject rather than normalize, including regex $'s trailing newline.
    (hasDedupeKey && (!DEDUPE_KEY_RE.test(dedupeKey) || dedupeKey.trim() !== dedupeKey)) ||
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

  // One short mailbox session of its own for the whole handler: the anchor
  // lookup, the routing fallback and the deferred insert are one logical step
  // against the caller's own inbound queue, and delivery holds no session
  // while a handler runs (plan §4.5b). The rejection throws from inside the
  // action so the anchor check still precedes the insert; the helper closes
  // its handles on the way out.
  //
  // Existing-only, never provisioning: `prepare()` would open the
  // container-owned outbound.db read-write to apply its schema, and this
  // request was read out of that very mailbox, so it exists. A session that
  // has vanished has nothing left to wake.
  // src/modules/mailbox/ops/ingress.ts:102–111 checks the trigger ID regardless of status before
  // atomically inserting its pair. The key stays consumed while that row is retained.
  const effectiveWakeId = hasDedupeKey
    ? `keyed-${createHash('sha256').update(`${session.id}\0${dedupeKey}`).digest('hex')}`
    : wakeId ||
      `legacy-${createHash('sha256').update(`${session.id}\0${processAfterRaw}\0${prompt}`).digest('hex').slice(0, 32)}`;
  const processAfter = new Date(Math.max(fireAtMs, now)).toISOString();

  const inserted = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
    const anchoredRouting = inReplyTo ? mailbox.getInboundRoutingAnchor(inReplyTo) : null;
    if (inReplyTo && !anchoredRouting) {
      log.warn('schedule_wake rejected: reply anchor is not in the caller session', {
        sessionId: session.id,
        inReplyTo,
      });
      throw new Error('schedule_wake rejected: invalid reply anchor');
    }
    const routing = anchoredRouting ?? mailbox.readSessionRouting();
    return mailbox.insertDeferredMessageWithContextIfNew({
      id: `schedule-wake-${effectiveWakeId}`,
      kind: 'chat',
      timestamp: new Date(now).toISOString(),
      platformId: routing?.platform_id ?? null,
      channelType: routing?.channel_type ?? null,
      threadId: routing?.thread_id ?? null,
      sourceSessionId: anchoredRouting?.source_session_id ?? null,
      content: JSON.stringify({
        // Delivery contract stated at fire time: on a self-wake, bare final
        // text is logged, never posted (see Routing.selfWake in the runner) —
        // without this line agents narrated "nothing moved, no post" and the
        // origin-fallback posted exactly that to the channel, every wake.
        text: `[system] ${prompt}\n\n(Scheduled wake: bare final text is NOT delivered. Wrap anything that should post in a <message> block; if nothing needs posting, end with no message at all.)`,
        sender: 'system',
        senderId: 'system',
        _system: { kind: 'agent_scheduled_wake' },
      }),
      processAfter,
      recurrence: null,
    });
  });

  if (inserted === undefined) {
    log.warn('schedule_wake rejected: session mailbox is gone', { sessionId: session.id });
    throw new Error('schedule_wake rejected: session mailbox is gone');
  }

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
