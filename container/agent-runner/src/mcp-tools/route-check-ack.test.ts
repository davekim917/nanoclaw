/**
 * The runner side of the host's routing check: only an `lb-` handoff post waits for the host's verdict, and the
 * agent reads the host's veto notice (or, when the host is late, the key it must assume) in the tool result.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { getInboundDb } from '../mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendMessage } from './core.js';
import { routeCheckedSendResult } from './route-check-ack.js';

const savedPolicy = process.env.NANOCLAW_OUTCOME_REPORTING;

beforeEach(() => {
  initTestSessionDb();
  process.env.NANOCLAW_OUTCOME_REPORTING = '1';
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('watch', 'Watch', 'channel', 'discord', 'discord:111:222', NULL)`,
    )
    .run();
});

afterEach(() => {
  if (savedPolicy === undefined) delete process.env.NANOCLAW_OUTCOME_REPORTING;
  else process.env.NANOCLAW_OUTCOME_REPORTING = savedPolicy;
  closeSessionDb();
});

function deliver(messageOutId: string, notice: string | null): void {
  getInboundDb()
    .prepare(
      "INSERT INTO delivered (message_out_id, platform_message_id, status, notice, delivered_at) VALUES (?, '9001', 'delivered', ?, ?)",
    )
    .run(messageOutId, notice, new Date().toISOString());
}

async function rowOnceWritten(): Promise<{ id: string }> {
  for (let i = 0; i < 100; i++) {
    const [row] = getUndeliveredMessages();
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('send_message wrote no row');
}

describe('send_message — routing-checked handoff posts', () => {
  it("waits for the host's verdict on an lb- handoff post and hands the agent its veto notice", async () => {
    const pending = sendMessage.handler({
      to: 'watch',
      text: 'ASK: a new request',
      purpose: 'handoff',
      thread_key: 'lb-dm-x',
    });
    const row = await rowOnceWritten();
    deliver(row.id, 'ROUTING CHECK VETO: use thread_key "lb-dm-x.split-1".');

    const result = await pending;

    expect(result.content[0].text).toBe(
      `Message sent to watch (id: 1). ROUTING CHECK VETO: use thread_key "lb-dm-x.split-1".`,
    );
  });

  it('reads a kept post, or a host without the notice column, as a plain send', async () => {
    const pending = sendMessage.handler({
      to: 'watch',
      text: 'ASK: same request',
      purpose: 'handoff',
      thread_key: 'lb-dm-x',
    });
    const row = await rowOnceWritten();
    getInboundDb().exec('ALTER TABLE delivered DROP COLUMN notice');
    getInboundDb()
      .prepare("INSERT INTO delivered (message_out_id, status, delivered_at) VALUES (?, 'delivered', ?)")
      .run(row.id, new Date().toISOString());

    expect((await pending).content[0].text).toBe('Message sent to watch (id: 1).');
  });

  it.each([
    ['another key', { purpose: 'handoff', thread_key: 'topic-a' }],
    ['no key', { purpose: 'handoff' }],
    ['an lb- work-session post', { purpose: 'decision', thread_key: 'lb-dm-x' }],
  ])('returns at once, without waiting for any ack, for %s', async (_label, args) => {
    const result = await sendMessage.handler({ to: 'watch', text: 'hello', ...args });

    expect(result.content[0].text).toBe('Message sent to watch (id: 1)');
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('a host that has not answered in time names the key the request moved to', async () => {
    const result = await routeCheckedSendResult('msg-1-ab', 7, 'watch', 'lb-dm-x', 30);

    expect(result.content[0].text).toBe(
      'Message queued to watch (id: 7). ROUTING CHECK UNCONFIRMED: the host did not answer within 0.03s, and a ' +
        'check it could not finish in time counts as a veto. If thread_key "lb-dm-x" already had a thread before ' +
        'this post, this post opened a NEW thread and this request\'s thread_key is now "lb-dm-x.split-msg-1-ab": ' +
        'use "lb-dm-x.split-msg-1-ab" for its topic file, its dispatch and every later post about it. Otherwise ' +
        'keep using "lb-dm-x".',
    );
  });

  it('a host refusal is an error', async () => {
    getInboundDb()
      .prepare(
        "INSERT INTO delivered (message_out_id, status, error, delivered_at) VALUES ('msg-2', 'failed', 'refused', ?)",
      )
      .run(new Date().toISOString());

    const result = await routeCheckedSendResult('msg-2', 8, 'watch', 'lb-dm-x', 1000);

    expect(result).toMatchObject({ isError: true, content: [{ text: 'Error: Message not delivered: refused' }] });
  });
});
