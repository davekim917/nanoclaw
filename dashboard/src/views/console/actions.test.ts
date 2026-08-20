import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Each live verb must hit the endpoint DESIGN §10.3 says it hits, with the
 * payload that endpoint actually accepts. These are the assertions that catch
 * the two ways this goes wrong silently: a reply routed through the
 * `observatory/steer` task-spawner (which cannot address a thread at all), and
 * a Close that archives one session out of six and so never changes the state.
 */

const postSessionMessage = vi.fn().mockResolvedValue({});
const archiveSession = vi.fn().mockResolvedValue({});
const snoozeThread = vi.fn().mockResolvedValue({});
const unsnoozeThread = vi.fn().mockResolvedValue({});
vi.mock('../../lib/api.js', () => ({ postSessionMessage, archiveSession, snoozeThread, unsnoozeThread }));

const { closeThread, newIdempotencyKey, sendReply, setSnoozed } = await import('./actions.js');

beforeEach(() => {
  postSessionMessage.mockClear();
  archiveSession.mockClear();
  snoozeThread.mockClear();
  unsnoozeThread.mockClear();
});

describe('sendReply — Answer and Steer are the same call', () => {
  it('posts to the NAMED session with a fresh idempotency key', async () => {
    await sendReply('sess-alpha', 'ship the other one');
    expect(postSessionMessage).toHaveBeenCalledTimes(1);
    const [sessionId, body] = postSessionMessage.mock.calls[0]!;
    expect(sessionId).toBe('sess-alpha');
    expect(body.text).toBe('ship the other one');
    expect(body.idempotency_key).toBeTruthy();
  });

  it('never reuses an idempotency key across two sends', async () => {
    await sendReply('sess-alpha', 'one');
    await sendReply('sess-alpha', 'two');
    const first = postSessionMessage.mock.calls[0]![1].idempotency_key;
    const second = postSessionMessage.mock.calls[1]![1].idempotency_key;
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

describe('closeThread', () => {
  it('archives EVERY session on the thread — §5 computes `done` from all of them', async () => {
    await closeThread({ session_ids: ['s-1', 's-2', 's-3'] });
    expect(archiveSession.mock.calls.map((c) => c[0])).toEqual(['s-1', 's-2', 's-3']);
  });
});

describe('setSnoozed', () => {
  it('snoozes and un-snoozes through the thread-keyed endpoints, not archive', async () => {
    await setSnoozed('slack:CTESTCHAN01:1700000000.11', true);
    expect(snoozeThread).toHaveBeenCalledWith('slack:CTESTCHAN01:1700000000.11');
    expect(archiveSession).not.toHaveBeenCalled();

    await setSnoozed('slack:CTESTCHAN01:1700000000.11', false);
    expect(unsnoozeThread).toHaveBeenCalledWith('slack:CTESTCHAN01:1700000000.11');
  });
});
