import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The console has ONE message primitive, and these tests bind the ways that
 * goes wrong silently: a send routed through the `observatory/steer`
 * task-spawner (which cannot address a thread at all), and a send that names a
 * session instead of an agent (so Assign becomes unreachable).
 *
 * There used to be a third action, Close, which archived a thread's sessions.
 * It is gone — archiving hid a thread without stopping the agent inside it.
 */

const postThreadMessage = vi.fn().mockResolvedValue({});
const snoozeThread = vi.fn().mockResolvedValue({});
const unsnoozeThread = vi.fn().mockResolvedValue({});
vi.mock('../../lib/api.js', () => ({ postThreadMessage, snoozeThread, unsnoozeThread }));

const actions = await import('./actions.js');
const { newIdempotencyKey, sendToAgent, setSnoozed } = actions;

beforeEach(() => {
  postThreadMessage.mockClear();
  snoozeThread.mockClear();
  unsnoozeThread.mockClear();
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
 * Kill was a verb here once. It is gone, not disabled — nothing exports it.
 * Close/Dismiss was a second one, gone for the same reason a kill would be
 * wrong for the opposite case: it hid a thread from the queue without
 * stopping the agent, so the work kept running unattended.
 */
describe('there is no kill action, and no close/dismiss action', () => {
  it('the actions module exposes exactly the message primitive and snooze', () => {
    expect(Object.keys(actions).sort()).toEqual(['newIdempotencyKey', 'sendToAgent', 'setSnoozed']);
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
