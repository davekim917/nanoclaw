import { archiveSession, postSessionMessage, snoozeThread, unsnoozeThread, type ThreadSummary } from '../../lib/api.js';

/**
 * The console's four live verbs, and nothing else.
 *
 * DESIGN §10.3 leaves two steer mechanisms in the tree and they are not
 * interchangeable. `POST /dashboard/api/sessions/:id/message` writes into ONE
 * session's inbound queue and echoes into the originating platform thread; it
 * is idempotent, rate-limited per (user, session) and role-gated to
 * owner / global-admin / admin-of-group. `POST /observatory/steer|nudge|assign`
 * spawn a one-shot task and accept only a claim slug or a release-board item
 * id — neither of which a thread row has — so they cannot serve this surface at
 * all. The session path is therefore the whole reply mechanism here, and every
 * send names a session explicitly rather than "the thread".
 *
 * Nothing in this file widens a permission. Each call lands on an endpoint that
 * already existed with the gate it already had.
 */

/**
 * Idempotency key for one send. `crypto.randomUUID` is the real source; the
 * fallback exists only for a jsdom without it, and a colliding key would at
 * worst de-duplicate two identical sends a millisecond apart.
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `ncc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Answer / Steer — the same call, differing only in which state prompted it.
 *
 * `sessionId` is chosen by the operator (defaulting to the thread's
 * `reply_target_session_id`), never inferred here: a thread has N inbound
 * queues and picking silently is how an answer reaches an agent that never
 * asked the question.
 */
export async function sendReply(sessionId: string, text: string): Promise<void> {
  await postSessionMessage(sessionId, { idempotency_key: newIdempotencyKey(), text });
}

/**
 * Close — archive every session on the thread.
 *
 * `archived_at` is exactly what DESIGN §5 computes `done` from, so this is the
 * one verb whose effect and whose state are the same fact. All N sessions,
 * because a thread is only `done` when every one of them is (`allArchived`);
 * archiving one of six would leave the row unchanged and read as a dead button.
 */
export async function closeThread(thread: Pick<ThreadSummary, 'session_ids'>): Promise<void> {
  await Promise.all(thread.session_ids.map((id) => archiveSession(id)));
}

/** Snooze — durable, per-user, expires when the thread moves. See thread-snooze.ts. */
export async function setSnoozed(threadId: string, snoozed: boolean): Promise<void> {
  await (snoozed ? snoozeThread(threadId) : unsnoozeThread(threadId));
}
