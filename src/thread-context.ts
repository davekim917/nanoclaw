/**
 * Replay prior thread messages from archive.db into a per-thread session's
 * inbound.db on wake. Without this, agents invoked mid-thread (or after a
 * gap of non-invoking messages) reply context-free — a regression from v1
 * where the full thread transcript was always in scope.
 *
 * Watermark-driven idempotency: each wake only queries archive rows newer
 * than `sessions.last_archive_at` and older than the current trigger; the
 * injection batch uses INSERT OR IGNORE so a crashed watermark advance
 * can't cause a PK collision on the next wake.
 */
import { getThreadMessagesInWindow } from './message-archive.js';
import { log } from './log.js';
import { writeContextMessagesBatch } from './session-manager.js';
import { advanceSessionArchiveWatermark } from './db/sessions.js';
import type { Session } from './types.js';

/** Max messages to inject on any single wake. */
const MAX_CONTEXT_MESSAGES = 20;
/** First-wake look-back window in minutes. */
const FIRST_WAKE_WINDOW_MIN = 30;

export interface ThreadContextTarget {
  channelType: string;
  platformId: string;
  threadId: string | null;
}

/**
 * Inject archived prior messages into a session's inbound.db. Returns the
 * number of messages injected. Idempotent across wakes — advances the
 * session watermark so each archive row is replayed at most once.
 *
 * `triggerTimestamp` is the current inbound message's timestamp; injected
 * messages are strictly older so the agent sees chronological order and the
 * trigger remains the only row wearing trigger=1.
 */
export function injectThreadContext(session: Session, target: ThreadContextTarget, triggerTimestamp: string): number {
  // On first wake there's no watermark — bound the look-back window so we
  // don't dump arbitrarily old history into a fresh session.
  const sinceIso = session.last_archive_at ?? new Date(Date.now() - FIRST_WAKE_WINDOW_MIN * 60_000).toISOString();

  let rows;
  try {
    rows = getThreadMessagesInWindow({
      agentGroupId: session.agent_group_id,
      channelType: target.channelType,
      platformId: target.platformId,
      threadId: target.threadId,
      sinceIso,
      beforeIso: triggerTimestamp,
      limit: MAX_CONTEXT_MESSAGES,
    });
  } catch (err) {
    log.warn('thread-context: archive query failed', {
      sessionId: session.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  if (rows.length === 0) return 0;

  // Mirror the inbound JSON envelope so the container formatter renders
  // these rows identically to live chat. The `ctx:` id prefix namespaces
  // them away from live `messages_in.id` and carries over into the
  // INSERT OR IGNORE idempotency (reinjection after a failed watermark
  // advance is a no-op).
  const batch = rows.map((row) => ({
    id: `ctx:${row.id}`,
    kind: 'chat',
    timestamp: row.sent_at,
    platformId: target.platformId,
    channelType: target.channelType,
    threadId: target.threadId,
    content: JSON.stringify({
      text: row.text,
      sender: row.sender_name ?? (row.role === 'assistant' ? 'assistant' : 'unknown'),
    }),
    trigger: 0 as const,
  }));

  try {
    writeContextMessagesBatch(session.agent_group_id, session.id, batch);
  } catch (err) {
    log.warn('thread-context: batch write failed', {
      sessionId: session.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  const maxSentAt = rows[rows.length - 1].sent_at;
  try {
    advanceSessionArchiveWatermark(session.id, maxSentAt);
  } catch (err) {
    log.warn('thread-context: failed to advance watermark', {
      sessionId: session.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  log.debug('thread-context: injected prior messages', {
    sessionId: session.id,
    count: rows.length,
    from: rows[0].sent_at,
    to: maxSentAt,
  });

  return rows.length;
}
