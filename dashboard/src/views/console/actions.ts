import {
  closeThread as apiCloseThread,
  assignItem,
  postThreadMessage,
  snoozeThread,
  unsnoozeThread,
  type ThreadCloseResponse,
  type ThreadMessageResponse,
  type ThreadSummary,
} from '../../lib/api.js';

/**
 * The console's actions: one message primitive, snooze, and close.
 *
 * **There is ONE primitive — send a message to a chosen agent.** Steer, push,
 * ship, assign and reassign are all `sendToAgent`; what differs between them is
 * the word on the button and whether the chosen agent already has a session on
 * the thread. Nothing here kills a container, and there is no verb that does:
 * a stalled thread gets a message.
 *
 * There used to be a third action, Close/Dismiss, which archived every session
 * on a thread and stopped nothing — a hide-without-stop action, not a close.
 * It was removed for that reason. `closeThread` below is NOT that action come
 * back: it is a thin pass-through to `POST /dashboard/api/threads/:id/close`
 * (`src/dashboard/thread-close.ts`), which asks the agent to wrap up, clears
 * its saved continuation, stops its container, and archives the thread only
 * once that is true — see `CloseControl.tsx` for the one/two-confirmation UI
 * this drives.
 *
 * `POST /dashboard/api/threads/:id/message` is that call. It resolves the
 * session (creating one when the agent has never spoken here) and then goes
 * through the SAME `POST /dashboard/api/sessions/:id/message` executor the
 * previous shape used — same gate (owner / global-admin / admin-of-group), same
 * rate limit, same idempotency, same platform echo. Nothing in this file widens
 * a permission.
 *
 * `POST /observatory/steer|nudge` remain what they were: one-shot tasks that
 * accept a claim slug, which a thread row does not have. They cannot serve this
 * surface and are not used here.
 *
 * `POST /observatory/assign` IS used, by `assignOwnerless` below, and only by
 * it. It is not a second copy of `sendToAgent` — it is the one row type
 * `sendToAgent` structurally cannot serve. An ownerless row's `thread_id` is a
 * board dedupe key, not a thread id, so the message path parses no channel out
 * of it, finds no wiring, and refuses; there is also no session to write into
 * and no conversation for a platform echo to land in. Assign answers that by
 * queueing a one-shot task in the room the item's source declared, which is
 * what opens the thread (DESIGN.md §2). The split is between "a thread exists"
 * and "one has to be created", not between two ways of doing the same thing.
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

/** Snooze — durable, per-user, expires when the thread moves. See thread-snooze.ts. */
export async function setSnoozed(threadId: string, snoozed: boolean): Promise<void> {
  await (snoozed ? snoozeThread(threadId) : unsnoozeThread(threadId));
}

/**
 * Close — the one action that ENDS work instead of sending a message.
 *
 * Deliberately a bare pass-through with no local retry/counting logic: the
 * confirmation count is server-authoritative (`thread-close-guard.ts`), so
 * this function's only job is to hand the caller's count to the endpoint and
 * let `CloseControl.tsx` react to whatever comes back — success, or a 409
 * naming how many confirmations are actually required.
 */
export async function closeThread(threadId: string, confirmations: number): Promise<ThreadCloseResponse> {
  return apiCloseThread(threadId, { confirmations });
}

/**
 * True when this row is an ownerless work item — no session behind it, only a
 * board entry. The ONLY rows `assignOwnerless` may be offered on.
 *
 * Two clauses on purpose. `attention_source` is set by exactly one producer
 * (`threads.ts`'s attention rows), so it alone would do; `session_ids` makes
 * the rule structural rather than a fact about today's producer, and it is the
 * clause that keeps a session-backed thread off this path if an ordinary row
 * ever grows a source of its own.
 */
export function isOwnerlessItem(thread: Pick<ThreadSummary, 'attention_source' | 'session_ids'>): boolean {
  return !!thread.attention_source && thread.session_ids.length === 0;
}

/**
 * Assign — the ownerless row's verb. Ids only: which item, which agent.
 *
 * No text parameter, and that is not an oversight. There is no thread to say
 * anything in yet, and the item already carries the board's own `next_action`;
 * the server composes the instruction from that so a browser cannot author what
 * an agent is told to do in a room full of people.
 */
export async function assignOwnerless(
  threadId: string,
  agentGroupId: string,
): Promise<{ agent: string; channel: string; etaSeconds: number }> {
  return assignItem(threadId, agentGroupId);
}
