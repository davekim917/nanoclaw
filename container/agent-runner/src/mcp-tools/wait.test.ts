/**
 * Tests for the `wait` MCP tool — in-session delayed wake via the
 * schedule_wake system action.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { setCurrentInReplyTo } from '../db/session-state.js';
import { wait } from './wait.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function systemRows(): Array<Record<string, unknown>> {
  const rows = getOutboundDb().prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as Array<{
    content: string;
  }>;
  return rows.map((r) => JSON.parse(r.content) as Record<string, unknown>);
}

describe('wait', () => {
  it('minutes path writes a schedule_wake system action with the right fire time', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
         VALUES ('turn-anchor', 'chat', datetime('now'), 'processing', 1, '{}')`,
      )
      .run();
    setCurrentInReplyTo('turn-anchor');
    const before = Date.now();
    const result = await wait.handler({ minutes: 15, prompt: 'Check CI for PR #207 and report status' });
    const after = Date.now();

    expect(result.isError).toBeUndefined();
    const rows = systemRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('schedule_wake');
    expect(rows[0].wake_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0].prompt).toBe('Check CI for PR #207 and report status');
    expect(rows[0].in_reply_to).toBe('turn-anchor');
    expect(getOutboundDb().prepare("SELECT in_reply_to FROM messages_out WHERE kind = 'system'").get()).toEqual({
      in_reply_to: 'turn-anchor',
    });
    const fireAtMs = Date.parse(rows[0].process_after as string);
    expect(fireAtMs).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(fireAtMs).toBeLessThanOrEqual(after + 15 * 60_000);
  });

  it('at path accepts an absolute ISO time and normalizes it', async () => {
    const at = new Date(Date.now() + 45 * 60_000).toISOString();
    const result = await wait.handler({ at, prompt: 'check deploy' });
    expect(result.isError).toBeUndefined();
    expect(systemRows()[0].process_after).toBe(at);
  });

  it('accepts ISO timestamps with an explicit offset and normalizes to UTC', async () => {
    const at = new Date(Date.now() + 45 * 60_000).toISOString().replace('Z', '+00:00');
    const result = await wait.handler({ at, prompt: 'check deploy' });
    expect(result.isError).toBeUndefined();
    expect(systemRows()[0].process_after).toBe(new Date(at).toISOString());
  });

  it('rejects missing prompt', async () => {
    const result = await wait.handler({ minutes: 5 });
    expect(result.isError).toBe(true);
    expect(systemRows()).toHaveLength(0);
  });

  it('rejects both or neither of minutes/at', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await wait.handler({ minutes: 5, at: future, prompt: 'x' })).isError).toBe(true);
    expect((await wait.handler({ prompt: 'x' })).isError).toBe(true);
    expect(systemRows()).toHaveLength(0);
  });

  it('rejects out-of-range minutes and invalid/past absolute times', async () => {
    expect((await wait.handler({ minutes: 0, prompt: 'x' })).isError).toBe(true);
    expect((await wait.handler({ minutes: 99999, prompt: 'x' })).isError).toBe(true);
    expect((await wait.handler({ at: 'not a date', prompt: 'x' })).isError).toBe(true);
    expect((await wait.handler({ at: new Date(Date.now() - 60_000).toISOString(), prompt: 'x' })).isError).toBe(true);
    expect(systemRows()).toHaveLength(0);
  });

  it('rejects sub-second delays, non-canonical timestamps, and unknown fields', async () => {
    expect((await wait.handler({ minutes: 0.000001, prompt: 'x' })).isError).toBe(true);
    expect((await wait.handler({ at: new Date(Date.now() + 60_000).toUTCString(), prompt: 'x' })).isError).toBe(true);
    expect((await wait.handler({ minutes: 1, prompt: 'x', extra: true })).isError).toBe(true);
    expect(systemRows()).toHaveLength(0);
  });

  it('submits a keyed request without promising a new wake time or route', async () => {
    const result = await wait.handler({
      minutes: 5,
      prompt: 'owned recovery',
      dedupe_key: 'demo/42/abc/worker-recovery',
    });
    expect(result.isError).toBeUndefined();
    expect(systemRows()[0].dedupe_key).toBe('demo/42/abc/worker-recovery');
    const text = JSON.stringify(result.content);
    expect(text).toContain('request submitted');
    expect(text).toContain('first accepted request');
    expect(text).toContain('route');
    expect(text).toContain('row is retained');
    expect(text).not.toContain('Wake scheduled');
  });

  it('preserves independent transport IDs and omits the optional key for unkeyed calls', async () => {
    await wait.handler({ minutes: 5, prompt: 'first' });
    await wait.handler({ minutes: 5, prompt: 'second' });
    const rows = systemRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].wake_id).not.toBe(rows[1].wake_id);
    expect(rows.every((row) => !Object.hasOwn(row, 'dedupe_key'))).toBe(true);
  });

  it('accepts key length boundaries without normalization', async () => {
    for (const dedupe_key of ['a', 'A' + 'b'.repeat(199), 'demo#42/head._:1/recovery-1']) {
      expect((await wait.handler({ minutes: 5, prompt: 'check', dedupe_key })).isError).toBeUndefined();
      expect(systemRows().at(-1)?.dedupe_key).toBe(dedupe_key);
    }
  });

  it('rejects invalid optional keys instead of falling back to an unkeyed wake', async () => {
    for (const dedupe_key of [
      '',
      null,
      undefined,
      1,
      {},
      'x'.repeat(201),
      ' key',
      'key ',
      'key\n',
      'key\t',
      'key\0',
      'café',
      '/key',
    ]) {
      expect((await wait.handler({ minutes: 5, prompt: 'check', dedupe_key })).isError).toBe(true);
    }
    expect(systemRows()).toHaveLength(0);
  });
});
