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

  describe('from a session bound to a thread', () => {
    const here = 'discord:1:2:3';
    const other = 'discord:1:2:9';

    beforeEach(() => {
      const db = getInboundDb();
      db.exec(
        'CREATE TABLE IF NOT EXISTS session_routing (id INTEGER PRIMARY KEY, channel_type TEXT, platform_id TEXT, thread_id TEXT)',
      );
      db.prepare(
        "INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, 'discord', 'discord:1:2', ?)",
      ).run(here);
      db.prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('team', 'Team', 'channel', 'discord', 'discord:1:2', NULL)`,
      ).run();
    });

    it('leaves the session thread so the host can route to the named one, with or without `to`', async () => {
      await sendMessage.handler({ text: 'a', thread_key: 'topic-a', continue_thread: other });
      await sendMessage.handler({ to: 'team', text: 'b', thread_key: 'topic-a', continue_thread: other });

      const out = getUndeliveredMessages();
      expect(out.map((m) => [m.platform_id, m.thread_id])).toEqual([
        ['discord:1:2', null],
        ['discord:1:2', null],
      ]);
      expect(JSON.parse(out[0].content).continueThread).toBe(other);
    });

    describe('with outcome reporting on', () => {
      beforeEach(() => {
        process.env.NANOCLAW_OUTCOME_REPORTING = '1';
      });
      afterEach(() => {
        delete process.env.NANOCLAW_OUTCOME_REPORTING;
      });

      it('a reply leaves the session thread', async () => {
        await sendMessage.handler({ purpose: 'reply', text: 'a', thread_key: 'topic-a', continue_thread: other });

        expect(getUndeliveredMessages()[0].thread_id).toBeNull();
      });

      it('refuses an outcome, which the host never routes by key, and writes nothing', async () => {
        const result = await sendMessage.handler({
          purpose: 'outcome',
          text: 'Fixed.',
          outcome: { workItem: 'https://github.com/org/repo/pull/17', verified: 'Tests passed' },
          thread_key: 'topic-a',
          continue_thread: other,
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('continue_thread');
        expect(getUndeliveredMessages()).toHaveLength(0);
      });
    });

    it('a key alone stays in the session thread', async () => {
      await sendMessage.handler({ to: 'team', text: 'a', thread_key: 'topic-a' });

      expect(getUndeliveredMessages()[0].thread_id).toBe(here);
    });
  });

  it('both tools advertise continue_thread as optional', () => {
    for (const t of [sendMessage, sendFile]) {
      expect(t.tool.inputSchema.properties).toHaveProperty('continue_thread');
      expect(t.tool.inputSchema.required).not.toContain('continue_thread');
    }
  });
});
