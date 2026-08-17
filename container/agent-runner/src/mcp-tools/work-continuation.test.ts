import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { setCurrentInReplyTo } from '../db/session-state.js';

mock.module('./server.js', () => ({ registerTools: (_tools: unknown) => {} }));

const { cancelContinuation, continueWork } = await import('./work-continuation.js');

beforeEach(() => initTestSessionDb());

describe('work continuation tools', () => {
  it('continue_work persists a validated queued task', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('turn-anchor', 'chat', ?, 'processing', '{}')`,
      )
      .run(new Date().toISOString());
    setCurrentInReplyTo('turn-anchor');
    const result = await continueWork.handler({ task: 'write focused tests' });
    expect(result.isError).toBeUndefined();
    const row = getOutboundDb().prepare("SELECT value FROM session_state WHERE key = 'work_continuation'").get() as {
      value: string;
    };
    expect(JSON.parse(row.value)).toMatchObject({
      task: 'write focused tests',
      source_message_id: 'turn-anchor',
      phase: 'queued',
      chain: 1,
    });
  });

  it('rejects empty, oversized, and unknown input without writing', async () => {
    expect((await continueWork.handler({ task: '   ' })).isError).toBe(true);
    const oversized = await continueWork.handler({ task: 'x'.repeat(501) });
    expect(oversized.isError).toBe(true);
    // Report the received length so the agent doesn't binary-search the cap.
    expect(oversized.content[0].text).toContain('501 chars');
    expect(oversized.content[0].text).toContain('max is 500');
    expect((await continueWork.handler({ task: 'ok', surprise: true })).isError).toBe(true);
    expect(getOutboundDb().prepare("SELECT 1 FROM session_state WHERE key = 'work_continuation'").get()).toBeNull();
  });

  it('cancel_continuation clears state idempotently and rejects arguments', async () => {
    await continueWork.handler({ task: 'stop later' });
    expect((await cancelContinuation.handler({})).isError).toBeUndefined();
    expect((await cancelContinuation.handler({})).isError).toBeUndefined();
    expect((await cancelContinuation.handler({ reason: 'extra' })).isError).toBe(true);
  });
});
