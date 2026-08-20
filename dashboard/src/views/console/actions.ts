import {
  archiveSession,
  postThreadMessage,
  snoozeThread,
  unsnoozeThread,
  type ThreadMessageResponse,
  type ThreadSummary,
} from '../../lib/api.js';

/**
 * The console's three actions: one message primitive, plus close and snooze.
 *
 * **There is ONE primitive — send a message to a chosen agent.** Steer, push,
 * ship, assign and reassign are all `sendToAgent`; what differs between them is
 * the word on the button and whether the chosen agent already has a session on
 * the thread. Nothing here kills a container, and there is no verb that does:
 * a stalled thread gets a message.
 *
 * `POST /dashboard/api/threads/:id/message` is that call. It resolves the
 * session (creating one when the agent has never spoken here) and then goes
 * through the SAME `POST /dashboard/api/sessions/:id/message` executor the
 * previous shape used — same gate (owner / global-admin / admin-of-group), same
 * rate limit, same idempotency, same platform echo. Nothing in this file widens
 * a permission.
 *
 * `POST /observatory/steer|nudge|assign` remain what they were: one-shot tasks
 * that accept a claim slug or a release-board item id, neither of which a thread
 * row has. They cannot serve this surface and are not used here.
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
 * The one primitive. Two parameters: which agent, what text.
 *
 * The agent is chosen by the operator (defaulting to the thread's
 * `reply_target_session_id`'s participant), never inferred here: a thread has N
 * inbound queues and picking silently is how an answer reaches an agent that
 * never asked the question. An agent with no session on the thread is a valid
 * choice — that is Assign, and the server opens the queue.
 */
export async function sendToAgent(
  threadId: string,
  agentGroupId: string,
  text: string,
): Promise<ThreadMessageResponse> {
  return postThreadMessage(threadId, { agent_group_id: agentGroupId, idempotency_key: newIdempotencyKey(), text });
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
