import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The console has ONE message primitive, and these tests bind the ways that
 * goes wrong silently: a send routed through the `observatory/steer`
 * task-spawner (which cannot address a thread at all), and a send that names a
 * session instead of an agent (so Assign becomes unreachable).
 *
 * There used to be a THIRD action here, Close/Dismiss, which archived a
 * thread's sessions and stopped nothing. It was removed for that reason. The
 * `closeThread` tested below is NOT that action come back — it is a bare
 * pass-through to the real `POST .../close` endpoint
 * (`src/dashboard/thread-close.ts`), which the second describe block below
 * exists specifically to keep distinct from the deleted one: it must reach
 * the real server action, and the server — not this module — must be the one
 * deciding how many confirmations that takes.
 */

const postThreadMessage = vi.fn().mockResolvedValue({});
const snoozeThread = vi.fn().mockResolvedValue({});
const unsnoozeThread = vi.fn().mockResolvedValue({});
const closeThreadApi = vi.fn().mockResolvedValue({});
vi.mock('../../lib/api.js', () => ({
  postThreadMessage,
  snoozeThread,
  unsnoozeThread,
  closeThread: closeThreadApi,
}));

const actions = await import('./actions.js');
const { newIdempotencyKey, sendToAgent, setSnoozed, closeThread } = actions;

beforeEach(() => {
  postThreadMessage.mockClear();
  snoozeThread.mockClear();
  unsnoozeThread.mockClear();
  closeThreadApi.mockClear();
});

describe('sendToAgent — steer, push, ship, assign and reassign are ONE call', () => {
  it('posts to the thread endpoint naming the chosen AGENT, with a fresh key', async () => {
    await sendToAgent('slack:CROOM:1700000000.11', 'ag-alpha', 'ship the other one');
    expect(postThreadMessage).toHaveBeenCalledTimes(1);
    const [threadId, body] = postThreadMessage.mock.calls[0]!;
    expect(threadId).toBe('slack:CROOM:1700000000.11');
    // The agent, not a session: an agent with no session on the thread is a
    // valid choice and is exactly what Assign is.
    expect(body.agent_group_id).toBe('ag-alpha');
    expect(body.text).toBe('ship the other one');
    expect(body.idempotency_key).toBeTruthy();
  });

  it('never reuses an idempotency key across two sends', async () => {
    await sendToAgent('slack:CROOM:1700000000.11', 'ag-alpha', 'one');
    await sendToAgent('slack:CROOM:1700000000.11', 'ag-alpha', 'two');
    const first = postThreadMessage.mock.calls[0]![1].idempotency_key;
    const second = postThreadMessage.mock.calls[1]![1].idempotency_key;
    expect(first).not.toBe(second);
  });

  it('mints a key even where crypto.randomUUID is missing', () => {
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      expect(newIdempotencyKey()).toMatch(/^ncc-/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
    }
  });
});

/**
 * Kill was a verb here once. It is gone, not disabled — nothing exports it,
 * and no describe block below tests for one.
 */
describe('there is no kill action', () => {
  it('the actions module exposes exactly the message primitive, snooze, and close', () => {
    expect(Object.keys(actions).sort()).toEqual(['closeThread', 'newIdempotencyKey', 'sendToAgent', 'setSnoozed']);
    expect(JSON.stringify(Object.keys(actions)).toLowerCase()).not.toContain('kill');
  });
});

describe('setSnoozed', () => {
  it('snoozes and un-snoozes through the thread-keyed endpoints', async () => {
    await setSnoozed('slack:CTESTCHAN01:1700000000.11', true);
    expect(snoozeThread).toHaveBeenCalledWith('slack:CTESTCHAN01:1700000000.11');

    await setSnoozed('slack:CTESTCHAN01:1700000000.11', false);
    expect(unsnoozeThread).toHaveBeenCalledWith('slack:CTESTCHAN01:1700000000.11');
  });
});

/**
 * `closeThread` is a REAL server action, not the deleted Dismiss come back
 * under a new name. These bind the two things that would make it that: a
 * local decision about how many confirmations are enough (there is none —
 * every count this module is given goes straight to the wire), and any local
 * archiving/hiding of the thread (there is none of that either — no session
 * id, no archive call, nothing but a thread id and a count reach the API).
 */
describe('closeThread — a pass-through to the real close endpoint, not a local action', () => {
  it('forwards the thread id and confirmation count verbatim, and returns whatever the server said', async () => {
    closeThreadApi.mockResolvedValueOnce({ thread_id: 't-1', session_ids: ['s-1'], confirm_window_ms: 600_000 });
    const res = await closeThread('slack:CTESTCHAN01:1700000000.11', 1);
    expect(closeThreadApi).toHaveBeenCalledWith('slack:CTESTCHAN01:1700000000.11', { confirmations: 1 });
    expect(res).toEqual({ thread_id: 't-1', session_ids: ['s-1'], confirm_window_ms: 600_000 });
  });

  it('sends whatever count it is given — it does not decide 1 vs 2 itself', async () => {
    await closeThread('t-2', 2);
    expect(closeThreadApi).toHaveBeenCalledWith('t-2', { confirmations: 2 });
  });

  it('does not swallow a rejection into a fake success — the caller sees the real error', async () => {
    closeThreadApi.mockRejectedValueOnce({ status: 409, error: 'confirmation_required', required_confirmations: 2 });
    await expect(closeThread('t-3', 1)).rejects.toMatchObject({ error: 'confirmation_required' });
  });
});
