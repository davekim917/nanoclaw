import { afterEach, describe, expect, test } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from './connection.js';
import { SqliteAgentMailbox } from './index.js';

afterEach(() => closeSessionDb());

describe('SQLite runner mailbox canonical serialization', () => {
  test('classifies only corruption errors as requiring a fresh runner', () => {
    const mailbox = new SqliteAgentMailbox();
    expect(mailbox.shouldRestartAfter(new Error('database disk image is malformed'))).toBe(true);
    expect(mailbox.shouldRestartAfter('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(mailbox.shouldRestartAfter('file is not a database')).toBe(true);
    expect(mailbox.shouldRestartAfter('database is locked')).toBe(false);
    expect(mailbox.shouldRestartAfter('no such table: messages_in')).toBe(false);
  });

  test('round-trips full inbound and outbound lifecycle records', async () => {
    const { inbound, outbound } = initTestSessionDb();
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, trigger,
            platform_id, channel_type, thread_id, content, on_wake)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'in-1',
        2,
        'chat',
        '2026-01-01 00:00:00',
        'pending',
        null,
        null,
        'in-1',
        0,
        1,
        'room',
        'test',
        'thread',
        '{"text":"hello"}',
        1,
      );
    inbound
      .prepare(
        `INSERT INTO destinations
           (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('test-room', null, 'channel', 'test', 'room', null);
    outbound
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('continuation', 'token', '2026-01-01 00:00:00');

    const mailbox = new SqliteAgentMailbox();
    await mailbox.start({ agentGroupId: 'agent', sessionId: 'session', mailbox: null });
    expect(mailbox.getPendingMessages(10, true)).toEqual([
      {
        id: 'in-1',
        sequence: 2,
        kind: 'chat',
        timestamp: '2026-01-01T00:00:00.000Z',
        status: 'pending',
        processAfter: null,
        recurrence: null,
        seriesId: 'in-1',
        tries: 0,
        trigger: true,
        platformId: 'room',
        channelType: 'test',
        threadId: 'thread',
        content: '{"text":"hello"}',
        sourceSessionId: null,
        onWake: true,
      },
    ]);
    expect(mailbox.getState('continuation')).toEqual({
      value: 'token',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(mailbox.getDestinations()).toEqual([
      {
        name: 'test-room',
        displayName: null,
        type: 'channel',
        channelType: 'test',
        platformId: 'room',
        agentGroupId: null,
      },
    ]);

    for (const invalidTimeout of [-1, 1.5]) {
      mailbox.setContainerToolInFlight('Bash', invalidTimeout);
      expect(outbound.prepare('SELECT current_tool, tool_declared_timeout_ms FROM container_state').get()).toEqual({
        current_tool: 'Bash',
        tool_declared_timeout_ms: null,
      });
    }

    expect(
      await mailbox.writeMessageOut({
        id: 'out-1',
        inReplyTo: 'in-1',
        deliverAfter: '2026-01-01T00:00:01.000Z',
        recurrence: '0 * * * *',
        kind: 'chat',
        platformId: 'room',
        channelType: 'test',
        threadId: 'thread',
        content: '{"text":"reply"}',
      }),
    ).toBe(3);
    expect(mailbox.getUndeliveredMessages()).toEqual([
      {
        id: 'out-1',
        sequence: 3,
        inReplyTo: 'in-1',
        timestamp: expect.any(String),
        deliverAfter: '2026-01-01T00:00:01.000Z',
        recurrence: '0 * * * *',
        kind: 'chat',
        platformId: 'room',
        channelType: 'test',
        threadId: 'thread',
        content: '{"text":"reply"}',
      },
    ]);
  });

  test('counts conversation traffic from separate inbound and outbound cursors', () => {
    const { inbound, outbound } = initTestSessionDb();
    const T = 'slack:C1:171.1';
    const addIn = inbound.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, trigger, platform_id, thread_id, content)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', 'pending', 0, 1, ?, ?, '{}')`,
    );
    const addOut = outbound.prepare(
      `INSERT INTO messages_out (id, seq, kind, timestamp, platform_id, thread_id, content)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', ?, ?, '{}')`,
    );
    // Inbound numbering trails outbound: the host counts from inbound.db alone.
    addIn.run('in-2', 2, 'chat-sdk', 'slack:C1', T);
    addOut.run('list', 11, 'task_list', 'slack:C1', T);
    addIn.run('in-4', 4, 'chat-sdk', 'slack:C1', T);
    addIn.run('in-6', 6, 'system', 'slack:C1', T);
    // A host/system note (inbound `chat`, the group as its platform) and
    // traffic in another thread never show below the list.
    addIn.run('in-8', 8, 'chat', 'ag-1', null);
    addIn.run('in-10', 10, 'chat-sdk', 'slack:C1', 'slack:C1:999.9');
    // A native `chat` ingress routed to the conversation (the CLI adapter's kind) does count.
    addIn.run('in-12', 12, 'chat', 'cli:local', null);
    addOut.run('elsewhere', 15, 'chat', 'slack:C2', null);
    addOut.run('reply', 13, 'chat', 'slack:C1', T);
    const mailbox = new SqliteAgentMailbox();
    expect(mailbox.maxInboundSeq()).toBe(12);
    // After the list (outbound 11, inbound 2): in-4 and the reply only.
    expect(mailbox.countConversationMessagesAfter(11, 2, { platformId: 'slack:C1', threadId: T })).toBe(2);
    // A channel-level conversation (null thread) matches null exactly.
    expect(mailbox.countConversationMessagesAfter(11, 2, { platformId: 'slack:C2', threadId: null })).toBe(1);
    expect(mailbox.countConversationMessagesAfter(11, 2, { platformId: 'cli:local', threadId: null })).toBe(1);
  });

  test('reads one inbound message route by id', () => {
    const { inbound } = initTestSessionDb();
    inbound
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, trigger, platform_id, channel_type, thread_id, content)
         VALUES ('in-1', 2, 'chat', '2026-01-01T00:00:00.000Z', 'pending', 0, 1, 'slack:C1', 'slack', 'slack:C1:171.1', '{}')`,
      )
      .run();
    const mailbox = new SqliteAgentMailbox();
    expect(mailbox.getInboundRouteById('in-1')).toEqual({
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: 'slack:C1:171.1',
    });
    expect(mailbox.getInboundRouteById('missing')).toBeNull();
  });

  test('skips malformed pending inbound rows instead of crashing the runner', () => {
    const { inbound } = initTestSessionDb();
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, trigger,
            platform_id, channel_type, thread_id, content, on_wake)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'bad-row',
        2,
        'not-a-kind',
        new Date().toISOString(),
        'pending',
        null,
        null,
        null,
        0,
        1,
        null,
        null,
        null,
        '{}',
        0,
      );

    const mailbox = new SqliteAgentMailbox();
    expect(mailbox.getPendingMessages(10, false)).toEqual([]);
  });
});
