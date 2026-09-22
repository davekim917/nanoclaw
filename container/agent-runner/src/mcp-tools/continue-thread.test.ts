/**
 * `continue_thread` on send_message/send_file: runner-side validation and the
 * content it writes. The host decides whether the thread is adopted
 * (src/continue-thread.ts); the runner only checks shape and that a thread_key
 * came with it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { getInboundDb } from '../mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendFile, sendMessage } from './core.js';
import { parseContinueThread } from './continue-thread.js';

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('parseContinueThread', () => {
  it('treats absent or blank as none, with or without a key', () => {
    expect(parseContinueThread(undefined, null)).toEqual({ continueThread: null });
    expect(parseContinueThread(null, 'k')).toEqual({ continueThread: null });
    expect(parseContinueThread('   ', null)).toEqual({ continueThread: null });
  });

  it('accepts an encoded id, a bare id, and an https link, trimmed', () => {
    expect(parseContinueThread(' discord:1:2:3 ', 'k')).toEqual({ continueThread: 'discord:1:2:3' });
    expect(parseContinueThread('123456789012345678', 'k')).toEqual({ continueThread: '123456789012345678' });
    expect(parseContinueThread('https://discord.com/channels/1/3', 'k')).toEqual({
      continueThread: 'https://discord.com/channels/1/3',
    });
  });

  it('refuses a value without thread_key, a non-string, an over-long value, and an unsafe shape', () => {
    expect(parseContinueThread('discord:1:2:3', null)).toHaveProperty('error');
    expect(parseContinueThread(42, 'k')).toHaveProperty('error');
    expect(parseContinueThread('9'.repeat(513), 'k')).toHaveProperty('error');
    expect(parseContinueThread('has space', 'k')).toHaveProperty('error');
    expect(parseContinueThread('http://discord.com/channels/1/3', 'k')).toHaveProperty('error');
    expect(parseContinueThread('-leading', 'k')).toHaveProperty('error');
  });
});

describe('send_message / send_file — continue_thread', () => {
  it('send_message writes continueThread beside threadKey', async () => {
    await sendMessage.handler({ to: 'peer', text: 'topic', thread_key: 'topic-a', continue_thread: ' discord:1:2:3 ' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content)).toEqual({
      text: 'topic',
      threadKey: 'topic-a',
      continueThread: 'discord:1:2:3',
    });
  });

  it('send_message without continue_thread writes exactly the keyed content', async () => {
    await sendMessage.handler({ to: 'peer', text: 'topic', thread_key: 'topic-a' });

    expect(getUndeliveredMessages()[0].content).toBe(JSON.stringify({ text: 'topic', threadKey: 'topic-a' }));
  });

  it('send_message refuses continue_thread without thread_key and writes nothing', async () => {
    const result = await sendMessage.handler({ to: 'peer', text: 'topic', continue_thread: 'discord:1:2:3' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('thread_key');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('send_file refuses an invalid continue_thread before staging anything', async () => {
    const result = await sendFile.handler({
      to: 'peer',
      path: '/nonexistent/report.txt',
      thread_key: 'topic-a',
      continue_thread: 'not a thread',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('continue_thread');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('both tools advertise continue_thread as optional', () => {
    for (const t of [sendMessage, sendFile]) {
      expect(t.tool.inputSchema.properties).toHaveProperty('continue_thread');
      expect(t.tool.inputSchema.required).not.toContain('continue_thread');
    }
  });
});
