/**
 * Delivery race tests.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages. A running session
 * sits in both result sets, so the two timer chains can race on the same
 * outbound row — read-undelivered → call channel API → markDelivered. The
 * INSERT OR IGNORE in markDelivered makes the DB write idempotent, but
 * the channel API has already fired twice → user sees the message twice.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-delivery', GROUPS_DIR: '/tmp/nanoclaw-test-delivery/groups' };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { getDeliveredIds } from './db/session-db.js';
import { resolveSession, resolveTaskSession, outboundDbPath, inboundDbPath, openInboundDb } from './session-manager.js';
import { getTaskThreadAnchor, setTaskThreadAnchor } from './db/task-thread-anchors.js';
import { getDb } from './db/connection.js';
import {
  clearSessionStatusOnKill,
  deliverSessionMessages,
  setDeliveryAdapter,
  assertChannelRoutingConsistency,
} from './delivery.js';
import { createChannelDeliveryAdapter } from './channels/channel-registry.js';
import { isContainerRunning } from './container-runner.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentAndChannel(): void {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function insertOutbound(agentGroupId: string, sessionId: string, msgId: string): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(msgId, JSON.stringify({ text: 'hello' }));
  db.close();
}

function insertOutboundKind(
  agentGroupId: string,
  sessionId: string,
  msgId: string,
  kind: string,
  channelType: string,
  platformId: string,
  content: object,
  threadId: string | null = null,
  inReplyTo: string | null = null,
): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content, in_reply_to)
     VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?)`,
  ).run(msgId, kind, platformId, channelType, threadId, JSON.stringify(content), inReplyTo);
  db.close();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('deliverSessionMessages — concurrent invocations', () => {
  it('delivers a message exactly once when active and sweep polls overlap', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        // Hold long enough that the second concurrent caller can race the
        // read-undelivered → markDelivered window.
        await new Promise((r) => setTimeout(r, 100));
        return 'plat-msg-1';
      },
    });

    // Two concurrent calls — simulating active (1s) and sweep (60s) polls
    // hitting the same running session at the same moment.
    await Promise.all([deliverSessionMessages(session), deliverSessionMessages(session)]);

    expect(calls).toHaveLength(1);
  });

  it('still delivers on a subsequent call after the first finishes', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-first');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    expect(calls).toHaveLength(1);

    // Insert a second outbound message and deliver again — the lock from
    // the first call must have been released.
    insertOutbound('ag-1', session.id, 'out-second');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(2);
  });

  it('deletes the orphan thinking-block on chat-final delivery, using the stored route', async () => {
    // Status posts to (telegram, telegram:123). Then a kind='chat' delivers.
    // Cleanup must fire deleteMessage with the SAME route the status was
    // posted to — even if the chat reply hypothetically targeted a different
    // route, we must not delete via the chat reply's route.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // First insert a status row.
    insertOutboundKind('ag-1', session.id, 'status-1', 'status', 'telegram', 'telegram:123', {
      text: '> 💭 thinking...',
    });

    type DeleteCall = { channelType: string; platformId: string; threadId: string | null; messageId: string };
    const delivers: Array<{ kind: string; channelType: string; platformId: string }> = [];
    const deletes: DeleteCall[] = [];
    setDeliveryAdapter({
      async deliver(channelType, platformId, _threadId, kind) {
        delivers.push({ kind, channelType, platformId });
        return 'plat-status-id';
      },
      async deleteMessage(channelType, platformId, threadId, messageId) {
        deletes.push({ channelType, platformId, threadId, messageId });
      },
    });

    await deliverSessionMessages(session);
    expect(delivers).toHaveLength(1);
    expect(delivers[0].kind).toBe('status');
    expect(deletes).toHaveLength(0); // No chat yet, no orphan delete.

    // Now insert the chat-final reply on the SAME route. Cleanup should fire.
    insertOutboundKind('ag-1', session.id, 'chat-1', 'chat', 'telegram', 'telegram:123', {
      text: 'final answer',
    });
    await deliverSessionMessages(session);

    expect(delivers).toHaveLength(2);
    expect(delivers[1].kind).toBe('chat');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toEqual({
      channelType: 'telegram',
      platformId: 'telegram:123',
      threadId: null,
      messageId: 'plat-status-id',
    });
  });

  it('deletes the orphan thinking-block at turn_end when the turn posted no chat-final', async () => {
    // A thinking label is scaffolding, never an outcome. When a turn ends with
    // no <message> block, the anchor-based reset only fires on the NEXT turn —
    // and a task session (support-inbox poller, scheduled job) never gets one,
    // so the 💭 stands in the channel as the "answer" forever. The container
    // emits a `turn_end` system row after markCompleted; it must clean up.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    const deletes: string[] = [];
    setDeliveryAdapter({
      async deliver() {
        return 'plat-status-1';
      },
      async deleteMessage(_channelType, _platformId, _threadId, messageId) {
        deletes.push(messageId);
      },
    });

    insertOutboundKind(
      'ag-1',
      session.id,
      'status-1',
      'status',
      'telegram',
      'telegram:123',
      { text: 'labeling…' },
      null,
      'in-1',
    );
    await deliverSessionMessages(session);
    expect(deletes).toHaveLength(0); // Status posted and tracked; turn still open.

    insertOutboundKind('ag-1', session.id, 'end-1', 'system', 'telegram', 'telegram:123', { action: 'turn_end' });
    await deliverSessionMessages(session);
    expect(deletes).toEqual(['plat-status-1']);

    // Idempotent: a second turn_end with nothing tracked must not throw or
    // re-delete a message id the platform no longer has.
    insertOutboundKind('ag-1', session.id, 'end-2', 'system', 'telegram', 'telegram:123', { action: 'turn_end' });
    await deliverSessionMessages(session);
    expect(deletes).toEqual(['plat-status-1']);
  });

  it('drops the tracked status when the container is killed, since it can never emit turn_end', async () => {
    // The real-world failure the turn_end signal did NOT cover. For a
    // scheduled-task session the idle reaper killing the container mid-stream
    // IS the normal exit: markCompleted fires inside processQuery on the first
    // result, processingClaimCount drops to 0, and the reaper kills seconds
    // later with the provider stream still open — so the batch tail, and its
    // emitTurnEnd, are never reached. Observed on the support-inbox poller:
    // the 💭 stood as the run's only visible output in #support, twice.
    // The host must not depend on a dying process to clean up after itself.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    const deletes: string[] = [];
    setDeliveryAdapter({
      async deliver() {
        return 'plat-status-1';
      },
      async deleteMessage(_channelType, _platformId, _threadId, messageId) {
        deletes.push(messageId);
      },
    });

    insertOutboundKind(
      'ag-1',
      session.id,
      'status-1',
      'status',
      'telegram',
      'telegram:123',
      { text: 'polling…' },
      null,
      'in-1',
    );
    await deliverSessionMessages(session);
    expect(deletes).toHaveLength(0); // Tracked, container still alive.

    await clearSessionStatusOnKill(session.id);
    expect(deletes).toEqual(['plat-status-1']);

    // Idempotent: a second kill (or a kill after a chat-final already cleared
    // tracking) must not throw or re-delete a vanished platform message.
    await clearSessionStatusOnKill(session.id);
    expect(deletes).toEqual(['plat-status-1']);
  });

  it('resets the status line on a new turn when the prior turn posted no chat-final', async () => {
    // Bug: a turn that ends WITHOUT a user-facing <message> block (agent
    // thought/used tools but chose not to reply) never writes a kind='chat'
    // row, so the chat-final orphan cleanup never runs. The 💭 status from
    // that turn lingers, and the next turn's status — found in statusTracking
    // — gets EDITED in place, landing above the user's newer message. Status
    // rows now carry their turn's batch anchor in in_reply_to; a status with a
    // different anchor than the tracked one must delete the stale orphan and
    // post fresh instead of editing.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    type DeliverCall = { kind: string; content: string };
    const delivers: DeliverCall[] = [];
    const deletes: string[] = [];
    let postCount = 0;
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, kind, content) {
        delivers.push({ kind, content });
        return `plat-status-${++postCount}`;
      },
      async deleteMessage(_channelType, _platformId, _threadId, messageId) {
        deletes.push(messageId);
      },
    });

    // Turn 1: a status posts fresh and is tracked. No chat-final follows.
    insertOutboundKind(
      'ag-1',
      session.id,
      'status-1',
      'status',
      'telegram',
      'telegram:123',
      { text: 'turn-1' },
      null,
      'in-1',
    );
    await deliverSessionMessages(session);
    expect(delivers).toHaveLength(1);
    expect(deletes).toHaveLength(0); // No chat-final ran, orphan still tracked.

    // Turn 2 (user followed up → new batch anchor). The stale turn-1 status
    // must be deleted and turn-2's status posted FRESH, not edited.
    insertOutboundKind(
      'ag-1',
      session.id,
      'status-2',
      'status',
      'telegram',
      'telegram:123',
      { text: 'turn-2' },
      null,
      'in-2',
    );
    await deliverSessionMessages(session);
    expect(deletes).toEqual(['plat-status-1']); // Stale orphan removed.
    expect(delivers).toHaveLength(2);
    // Fresh post, not an edit of the prior turn's message.
    expect(JSON.parse(delivers[1].content)).not.toHaveProperty('operation');

    // A second status in the SAME turn (same anchor) still edits in place —
    // the reset must not fire mid-turn.
    insertOutboundKind(
      'ag-1',
      session.id,
      'status-2b',
      'status',
      'telegram',
      'telegram:123',
      { text: 'turn-2 more' },
      null,
      'in-2',
    );
    await deliverSessionMessages(session);
    expect(deletes).toEqual(['plat-status-1']); // No additional delete.
    expect(delivers).toHaveLength(3);
    const edit = JSON.parse(delivers[2].content);
    expect(edit.operation).toBe('edit');
    expect(edit.messageId).toBe('plat-status-2'); // Edits turn-2's message.
  });

  it.each(['discord', 'discord-codex'] as const)(
    'posts and tracks a fresh %s status after edit error 30046',
    async (channelType) => {
      createAgentGroup({
        id: 'ag-1',
        name: 'Test Agent',
        folder: 'test-agent',
        agent_provider: null,
        created_at: now(),
      });
      createMessagingGroup({
        id: 'mg-1',
        channel_type: channelType,
        platform_id: 'discord:guild-1:channel-1',
        name: 'Test Discord Thread',
        is_group: 1,
        unknown_sender_policy: 'public',
        created_at: now(),
      });
      const { session } = resolveSession('ag-1', 'mg-1', 'thread-1', 'per-thread');

      type DeliverCall = { operation?: string; messageId?: string; text?: string };
      const calls: DeliverCall[] = [];
      const deletes: string[] = [];
      let freshPosts = 0;
      let rejectedOldEdit = false;
      setDeliveryAdapter({
        async deliver(_channelType, _platformId, _threadId, _kind, content) {
          const parsed = JSON.parse(content) as DeliverCall;
          calls.push(parsed);
          if (parsed.operation === 'edit') {
            if (!rejectedOldEdit) {
              rejectedOldEdit = true;
              throw new Error(
                'NetworkError: Discord API error: 429 {"message":"Maximum number of edits to messages older than 1 hour reached","code":30046}',
              );
            }
            return;
          }
          freshPosts++;
          return `status-${freshPosts}`;
        },
        async deleteMessage(_channelType, _platformId, _threadId, messageId) {
          deletes.push(messageId);
        },
      });

      insertOutboundKind(
        'ag-1',
        session.id,
        'status-1',
        'status',
        channelType,
        'discord:guild-1:channel-1',
        { text: 'first' },
        'thread-1',
        'turn-1',
      );
      await deliverSessionMessages(session);

      insertOutboundKind(
        'ag-1',
        session.id,
        'status-2',
        'status',
        channelType,
        'discord:guild-1:channel-1',
        { text: 'second' },
        'thread-1',
        'turn-1',
      );
      await deliverSessionMessages(session);

      expect(calls).toHaveLength(3);
      expect(calls[1]).toMatchObject({ operation: 'edit', messageId: 'status-1', text: 'second' });
      expect(calls[2]).toEqual({ text: 'second' });
      expect(deletes).toEqual(['status-1']);

      insertOutboundKind(
        'ag-1',
        session.id,
        'status-3',
        'status',
        channelType,
        'discord:guild-1:channel-1',
        { text: 'third' },
        'thread-1',
        'turn-1',
      );
      await deliverSessionMessages(session);

      expect(calls[3]).toMatchObject({ operation: 'edit', messageId: 'status-2', text: 'third' });
      const inDb = openInboundDb('ag-1', session.id);
      const delivered = getDeliveredIds(inDb);
      inDb.close();
      expect(delivered.has('status-2')).toBe(true);
      expect(delivered.has('status-3')).toBe(true);
    },
  );

  it('preserves status order when a Discord 30046 replacement post fails transiently', async () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord-codex',
      platform_id: 'discord:guild-1:channel-1',
      name: 'Test Discord Thread',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    const { session } = resolveSession('ag-1', 'mg-1', 'thread-1', 'per-thread');

    type DeliverCall = { operation?: string; messageId?: string; text?: string };
    const calls: DeliverCall[] = [];
    const deletes: string[] = [];
    let postCount = 0;
    let oldEditRejected = false;
    let replacementPostRejected = false;
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        const parsed = JSON.parse(content) as DeliverCall;
        calls.push(parsed);
        if (parsed.operation === 'edit' && parsed.messageId === 'status-1' && !oldEditRejected) {
          oldEditRejected = true;
          throw new Error(
            'NetworkError: Discord API error: 429 {"message":"Maximum number of edits to messages older than 1 hour reached","code":30046}',
          );
        }
        if (!parsed.operation && parsed.text === 'second' && !replacementPostRejected) {
          replacementPostRejected = true;
          throw new Error('transient Discord post failure');
        }
        if (!parsed.operation) return `status-${++postCount}`;
      },
      async deleteMessage(_channelType, _platformId, _threadId, messageId) {
        deletes.push(messageId);
      },
    });

    insertOutboundKind(
      'ag-1',
      session.id,
      'status-1',
      'status',
      'discord-codex',
      'discord:guild-1:channel-1',
      { text: 'first' },
      'thread-1',
      'turn-1',
    );
    await deliverSessionMessages(session);

    insertOutboundKind(
      'ag-1',
      session.id,
      'status-2',
      'status',
      'discord-codex',
      'discord:guild-1:channel-1',
      { text: 'second' },
      'thread-1',
      'turn-1',
    );
    insertOutboundKind(
      'ag-1',
      session.id,
      'status-3',
      'status',
      'discord-codex',
      'discord:guild-1:channel-1',
      { text: 'third' },
      'thread-1',
      'turn-1',
    );

    await deliverSessionMessages(session);

    expect(calls).toEqual([
      { text: 'first' },
      { operation: 'edit', messageId: 'status-1', text: 'second' },
      { text: 'second' },
    ]);
    expect(deletes).toEqual([]);
    let inDb = openInboundDb('ag-1', session.id);
    let delivered = getDeliveredIds(inDb);
    inDb.close();
    expect(delivered.has('status-2')).toBe(false);
    expect(delivered.has('status-3')).toBe(false);

    await deliverSessionMessages(session);

    expect(calls).toEqual([
      { text: 'first' },
      { operation: 'edit', messageId: 'status-1', text: 'second' },
      { text: 'second' },
      { text: 'second' },
      { operation: 'edit', messageId: 'status-2', text: 'third' },
    ]);
    expect(deletes).toEqual(['status-1']);
    inDb = openInboundDb('ag-1', session.id);
    delivered = getDeliveredIds(inDb);
    inDb.close();
    expect(delivered.has('status-2')).toBe(true);
    expect(delivered.has('status-3')).toBe(true);
  });

  it('threads the messaging-group instance through status delivery and the orphan delete', async () => {
    // Multi-instance install: a messaging_groups row whose `instance` differs
    // from its `channel_type` (two bots of the same platform). The status post
    // and the chat reply must both go through the SAME named instance, and the
    // orphan-delete must reuse it — otherwise the two halves of one turn post
    // from different bot identities and the delete misroutes to the default
    // adapter. Regression for the merged channel-instance dimension (the status
    // branch previously dropped the instance arg).
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'telegram:123',
      instance: 'telegram-bot-A',
      name: 'Test Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    insertOutboundKind('ag-1', session.id, 'status-1', 'status', 'telegram', 'telegram:123', {
      text: '> 💭 thinking...',
    });

    const deliverInstances: Array<string | undefined> = [];
    const deleteInstances: Array<string | undefined> = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, _content, _files, instance) {
        deliverInstances.push(instance);
        return 'plat-status-id';
      },
      async deleteMessage(_channelType, _platformId, _threadId, _messageId, instance) {
        deleteInstances.push(instance);
      },
    });

    await deliverSessionMessages(session);
    // Status posted through the named instance — previously dropped → default.
    expect(deliverInstances).toEqual(['telegram-bot-A']);

    insertOutboundKind('ag-1', session.id, 'chat-1', 'chat', 'telegram', 'telegram:123', {
      text: 'final answer',
    });
    await deliverSessionMessages(session);

    // Chat reply through the same instance, and the orphan delete reuses it.
    expect(deliverInstances).toEqual(['telegram-bot-A', 'telegram-bot-A']);
    expect(deleteInstances).toEqual(['telegram-bot-A']);
  });

  it('suppresses status messages in chat for spawn-child sessions', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // Mark this session as a spawn-child by inserting a task row with
    // child_session_id = session.id. `isSpawnChildSession` queries the
    // central tasks table and caches per-process.
    const { getDb } = await import('./db/connection.js');
    getDb()
      .prepare(
        `INSERT INTO tasks
           (task_id, idempotency_key, parent_session_id, parent_agent_group_id,
            child_session_id, status, task_content, request_hash, admitted_at,
            surface_mode, created_at)
         VALUES (?, ?, ?, 'ag-1', ?, 'running', 'x', 'h', ?, 'native_thread', ?)`,
      )
      .run('task-spawn-1', 'key-1', session.id, session.id, now(), now());

    // Insert a status row that WOULD post to the channel for a normal
    // session. For a spawn-child session, delivery should suppress it.
    insertOutboundKind('ag-1', session.id, 'thinking-1', 'status', 'telegram', 'telegram:123', {
      text: '> 💭 reading the brief...',
    });

    const calls: Array<{ kind: string }> = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, kind) {
        calls.push({ kind });
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);

    // No platform send happened for the status row.
    expect(calls.filter((c) => c.kind === 'status')).toHaveLength(0);

    // The row should still be markDelivered'd so it doesn't reprocess.
    const inDb = openInboundDb('ag-1', session.id);
    const delivered = getDeliveredIds(inDb);
    inDb.close();
    expect(delivered.has('thinking-1')).toBe(true);
  });

  it('swallows deleteMessage failures so chat reply still completes', async () => {
    // If the platform delete fails (network, permission, message-not-found),
    // the chat reply must still mark delivered. Otherwise the reply gets
    // retried and the user sees a duplicate.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    insertOutboundKind('ag-1', session.id, 'status-1', 'status', 'telegram', 'telegram:123', {
      text: '> 💭 thinking...',
    });

    let deliverCount = 0;
    let deleteAttempts = 0;
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind) {
        deliverCount++;
        return 'plat-id';
      },
      async deleteMessage() {
        deleteAttempts++;
        throw new Error('simulated delete failure');
      },
    });

    await deliverSessionMessages(session);
    insertOutboundKind('ag-1', session.id, 'chat-1', 'chat', 'telegram', 'telegram:123', {
      text: 'final answer',
    });
    await deliverSessionMessages(session);

    // Delete was attempted and failed (swallowed), but the chat still delivered.
    expect(deleteAttempts).toBe(1);
    expect(deliverCount).toBe(2); // status + chat both delivered

    // A second invocation must not re-deliver the chat (idempotency preserved
    // despite the delete failure).
    await deliverSessionMessages(session);
    expect(deliverCount).toBe(2);
  });

  it('does not re-deliver when retried after a successful send (cleanup-after-send safety)', async () => {
    // If something post-send throws (e.g. outbox cleanup), the message has
    // still landed on the user's screen — the catch path must not trigger
    // a re-send. We simulate by having the adapter succeed on the first
    // call and recording how many times it's invoked across two attempts.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-once');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    // Re-invoke — should be idempotent because the message is now in the
    // delivered table; the channel adapter must not be called again.
    await deliverSessionMessages(session);

    expect(callCount).toBe(1);
  });
});

describe('deliverSessionMessages — retry and permanent failure', () => {
  it('retries on adapter failure and marks failed after MAX_DELIVERY_ATTEMPTS (3)', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-flaky');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        throw new Error('network timeout');
      },
    });

    // Attempt 1
    await deliverSessionMessages(session);
    expect(callCount).toBe(1);

    // Attempt 2
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);

    // Attempt 3 — should mark as permanently failed
    await deliverSessionMessages(session);
    expect(callCount).toBe(3);

    // Attempt 4 — message is now in delivered (as failed), adapter not called
    await deliverSessionMessages(session);
    expect(callCount).toBe(3);

    // Verify the message is in the delivered table with 'failed' status
    const inDb = openInboundDb('ag-1', session.id);
    const delivered = getDeliveredIds(inDb);
    inDb.close();
    expect(delivered.has('out-flaky')).toBe(true);
  });

  it('does not acknowledge a message when no channel adapter is registered (#2995)', async () => {
    // Regression: the real bridge used to return undefined when the exact
    // adapter lookup missed, and drainSession marked the row delivered with
    // platform_message_id=NULL even though no send happened. The bridge must
    // throw so the row takes the normal retry → failed path. Uses the REAL
    // createChannelDeliveryAdapter with an empty registry — the state after
    // an adapter factory returns null (missing credentials) at startup.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-offline');

    setDeliveryAdapter(createChannelDeliveryAdapter());

    // Attempt 1 — must NOT be acknowledged as delivered
    await deliverSessionMessages(session);
    let inDb = openInboundDb('ag-1', session.id);
    expect(getDeliveredIds(inDb).has('out-offline')).toBe(false);
    inDb.close();

    // Attempts 2 and 3 — exhausts MAX_DELIVERY_ATTEMPTS
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    // The row must end as status='failed', never 'delivered'
    inDb = openInboundDb('ag-1', session.id);
    const row = inDb
      .prepare('SELECT status, platform_message_id FROM delivered WHERE message_out_id = ?')
      .get('out-offline') as { status: string; platform_message_id: string | null } | undefined;
    inDb.close();
    expect(row).toBeDefined();
    expect(row!.status).toBe('failed');
    expect(row!.platform_message_id).toBeNull();
  });

  it('clears attempt counter on successful delivery', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-retry-ok');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        if (callCount === 1) throw new Error('transient');
        return 'plat-ok';
      },
    });

    // Attempt 1 — fails
    await deliverSessionMessages(session);
    expect(callCount).toBe(1);

    // Attempt 2 — succeeds
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);

    // Attempt 3 — not called, message already delivered
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);
  });
});

describe('deliverSessionMessages — instance resolution', () => {
  it('delivers via the origin session instance when sibling rows share (channel_type, platform_id)', async () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    // Two instances own the same chat address. The named row sorts before
    // 'slack', so a plain by-platform lookup (default-instance-first) would
    // pick mg-default — only origin-session preference selects mg-tester.
    createMessagingGroup({
      id: 'mg-default',
      channel_type: 'slack',
      platform_id: 'slack:C1',
      name: 'Default',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-tester',
      channel_type: 'slack',
      platform_id: 'slack:C1',
      instance: 'alpha-tester',
      name: 'Tester',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-tester', null, 'shared');
    const db = new Database(outboundDbPath('ag-1', session.id));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES ('out-inst', datetime('now'), 'chat', 'slack:C1', 'slack', ?)`,
    ).run(JSON.stringify({ text: 'hi' }));
    db.close();

    const instances: Array<string | undefined> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, _content, _files, instance) {
        instances.push(instance);
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);
    expect(instances).toEqual(['alpha-tester']);
  });

  it('default session passes the backfilled default instance (= channel_type)', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-default-inst');

    const instances: Array<string | undefined> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, _content, _files, instance) {
        instances.push(instance);
        return 'plat-2';
      },
    });

    await deliverSessionMessages(session);
    expect(instances).toEqual(['telegram']);
  });
});

describe('deliverSessionMessages — permission check', () => {
  it('rejects delivery to an unauthorized channel destination', async () => {
    seedAgentAndChannel();

    // Create a second messaging group that the agent is NOT wired to
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'discord:456',
      name: 'Unauthorized Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    // Session is on mg-1 (telegram)
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // Insert an outbound message targeting mg-2 (discord) — not the origin chat
    const outDb = new Database(outboundDbPath('ag-1', session.id));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, datetime('now'), 'chat', 'discord:456', 'discord', ?)`,
      )
      .run('out-unauth', JSON.stringify({ text: 'sneaky' }));
    outDb.close();

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        calls.push(content);
        return 'plat-msg';
      },
    });

    // Deliver 3 times to exhaust retries
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    // Adapter never called — permission check throws before reaching it
    expect(calls).toHaveLength(0);

    // Message is marked as permanently failed
    const inDb = openInboundDb('ag-1', session.id);
    const delivered = getDeliveredIds(inDb);
    inDb.close();
    expect(delivered.has('out-unauth')).toBe(true);
  });
});

describe('assertChannelRoutingConsistency', () => {
  it('test_consistency_both_null_ok', () => {
    expect(() => assertChannelRoutingConsistency({ channelType: null, platformId: null })).not.toThrow();
  });

  it('test_consistency_both_non_null_ok', () => {
    expect(() => assertChannelRoutingConsistency({ channelType: 'slack', platformId: 'C123' })).not.toThrow();
  });

  it('test_consistency_split_state_throws_channel_null', () => {
    expect(() => assertChannelRoutingConsistency({ channelType: null, platformId: 'C123' })).toThrow(
      /inconsistent channel routing/,
    );
  });

  it('test_consistency_split_state_throws_platform_null', () => {
    expect(() => assertChannelRoutingConsistency({ channelType: 'slack', platformId: null })).toThrow(
      /inconsistent channel routing/,
    );
  });

  it('test_consistency_empty_string_treated_as_null', () => {
    // Empty string should count as null (nullish)
    expect(() => assertChannelRoutingConsistency({ channelType: '', platformId: 'C123' })).toThrow(
      /inconsistent channel routing/,
    );
  });
});

describe('per-turn channel-root threading', () => {
  // Insert a chat row with an explicit in_reply_to + timestamp so ordering is
  // deterministic across the drain (getDueOutboundMessages sorts by timestamp).
  function insertChatReply(
    agentGroupId: string,
    sessionId: string,
    msgId: string,
    inReplyTo: string | null,
    ts: string,
  ): void {
    const db = new Database(outboundDbPath(agentGroupId, sessionId));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, in_reply_to, content)
       VALUES (?, ?, 'chat', 'telegram:123', 'telegram', NULL, ?, ?)`,
    ).run(msgId, ts, inReplyTo, JSON.stringify({ text: msgId }));
    db.close();
  }

  it('threads a turn’s follow-up messages under the first root post', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    // Two messages, same turn (same in_reply_to), both thread-unbound — the
    // scheduled-task shape: first posts at root, second replies under it.
    insertChatReply('ag-1', session.id, 'out-1', 'task-fire-A', '2026-05-30T12:00:00.000Z');
    insertChatReply('ag-1', session.id, 'out-2', 'task-fire-A', '2026-05-30T12:00:01.000Z');

    const calls: Array<{ id: string; threadId: string | null }> = [];
    let n = 0;
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, threadId, _kind, content) {
        const id = (JSON.parse(content) as { text: string }).text;
        calls.push({ id, threadId });
        return `plat-${++n}`;
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toHaveLength(2);
    // First posts at root (no thread).
    expect(calls[0]).toEqual({ id: 'out-1', threadId: null });
    // Second threads under the first, addressed as `<platform_id>:<messageId>`.
    //
    // This assertion used to expect the BARE `'plat-1'`. That was wrong and it
    // masked a live bug: adapters decode thread ids as `discord:<guild>:<channel>:
    // <thread>` / `slack:<channel>:<ts>` and throw ValidationError on anything
    // else, so in production every follow-up was retried 3x and dropped. The fake
    // adapter here accepts any string, which is precisely why it never surfaced.
    // Fixed 2026-07-25 after the example-retail meeting digest lost 3 of 4 chunks.
    expect(calls[1]).toEqual({ id: 'out-2', threadId: 'telegram:123:plat-1' });
  });

  it('falls back to root instead of dropping when threading under the anchor fails', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertChatReply('ag-1', session.id, 'out-1', 'task-fire-A', '2026-05-30T12:00:00.000Z');
    insertChatReply('ag-1', session.id, 'out-2', 'task-fire-A', '2026-05-30T12:00:01.000Z');
    insertChatReply('ag-1', session.id, 'out-3', 'task-fire-A', '2026-05-30T12:00:02.000Z');

    const calls: Array<{ id: string; threadId: string | null }> = [];
    let n = 0;
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, threadId, _kind, content) {
        const id = (JSON.parse(content) as { text: string }).text;
        calls.push({ id, threadId });
        // Discord's shape: a thread sharing the parent message's snowflake only
        // resolves if a thread was actually created. None was, so it 404s.
        if (threadId !== null) throw new Error('Unknown Channel');
        return `plat-${++n}`;
      },
    });

    await deliverSessionMessages(session);

    // out-2 tries the anchor once, fails, reposts at root. out-3 then goes
    // straight to root — anchoring is off for the rest of the turn, so it never
    // pays another failing call.
    expect(calls.map((c) => c.threadId)).toEqual([null, 'telegram:123:plat-1', null, null]);
    // The property that actually matters: nothing was dropped.
    expect(new Set(calls.map((c) => c.id))).toEqual(new Set(['out-1', 'out-2', 'out-3']));
    const delivered = getDeliveredIds(openInboundDb('ag-1', session.id));
    expect([...delivered].sort()).toEqual(['out-1', 'out-2', 'out-3']);
  });

  it('starts a new root thread when the turn (in_reply_to) changes', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertChatReply('ag-1', session.id, 'out-1', 'task-fire-A', '2026-05-30T12:00:00.000Z');
    insertChatReply('ag-1', session.id, 'out-2', 'task-fire-B', '2026-05-30T12:00:01.000Z');

    const calls: Array<{ id: string; threadId: string | null }> = [];
    let n = 0;
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, threadId, _kind, content) {
        const id = (JSON.parse(content) as { text: string }).text;
        calls.push({ id, threadId });
        return `plat-${++n}`;
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toHaveLength(2);
    // Different fires (in_reply_to) → each posts at its own root.
    expect(calls[0]).toEqual({ id: 'out-1', threadId: null });
    expect(calls[1]).toEqual({ id: 'out-2', threadId: null });
  });

  it('leaves an agent-targeted thread_id untouched (no anchoring)', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    // thread_id explicitly set — a per-thread reply, not a root post.
    const db = new Database(outboundDbPath('ag-1', session.id));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, in_reply_to, content)
       VALUES ('out-1', '2026-05-30T12:00:00.000Z', 'chat', 'telegram:123', 'telegram', 'thr-9', 'task-fire-A', ?)`,
    ).run(JSON.stringify({ text: 'out-1' }));
    db.close();

    const calls: Array<{ threadId: string | null }> = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, threadId) {
        calls.push({ threadId });
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: 'thr-9' }]);
  });
});

describe('rolling task-thread anchor (fleet-hardening 1.4)', () => {
  // Task sessions have messaging_group_id = null, so origin-chat delivery
  // permission doesn't apply — grant the explicit agent_destinations row the
  // permission check requires instead.
  function grantChannelDestination(agentGroupId: string, messagingGroupId: string): void {
    getDb()
      .prepare(
        `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
         VALUES (?, 'main', 'channel', ?, ?)`,
      )
      .run(agentGroupId, messagingGroupId, now());
  }

  function insertTaskChat(
    agentGroupId: string,
    sessionId: string,
    msgId: string,
    ts: string,
    threadId: string | null = null,
  ): void {
    const db = new Database(outboundDbPath(agentGroupId, sessionId));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, in_reply_to, content)
       VALUES (?, ?, 'chat', 'telegram:123', 'telegram', ?, ?, ?)`,
    ).run(msgId, ts, threadId, `task-fire-${msgId}`, JSON.stringify({ text: msgId }));
    db.close();
  }

  it('first post: no anchor yet — posts at root and stores the anchor', async () => {
    seedAgentAndChannel();
    grantChannelDestination('ag-1', 'mg-1');
    const { session } = resolveTaskSession('ag-1', 'series-1');
    insertTaskChat('ag-1', session.id, 'out-1', '2026-08-10T09:00:00.000Z');

    const calls: Array<{ threadId: string | null }> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, threadId) {
        calls.push({ threadId });
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: null }]);
    const anchor = getTaskThreadAnchor(session.id, 'telegram', 'telegram:123');
    expect(anchor).toEqual({ threadPlatformId: 'plat-1', createdAt: expect.any(String) });
  });

  it('second post same UTC day: threads under the stored anchor', async () => {
    seedAgentAndChannel();
    grantChannelDestination('ag-1', 'mg-1');
    const { session } = resolveTaskSession('ag-1', 'series-1');
    // Now-relative: rotation compares against the real clock, so a hardcoded
    // date makes this test fail the day after it was written.
    setTaskThreadAnchor(session.id, 'telegram', 'telegram:123', 'plat-1', new Date().toISOString());
    insertTaskChat('ag-1', session.id, 'out-2', new Date().toISOString());

    const calls: Array<{ threadId: string | null }> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, threadId) {
        calls.push({ threadId });
        return 'plat-2';
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: 'telegram:123:plat-1' }]);
    // Threading under an existing anchor must not overwrite it.
    const anchor = getTaskThreadAnchor(session.id, 'telegram', 'telegram:123');
    expect(anchor?.threadPlatformId).toBe('plat-1');
  });

  it('day rollover: posts a fresh root message and replaces the anchor', async () => {
    seedAgentAndChannel();
    grantChannelDestination('ag-1', 'mg-1');
    const { session } = resolveTaskSession('ag-1', 'series-1');
    setTaskThreadAnchor(
      session.id,
      'telegram',
      'telegram:123',
      'plat-1',
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    );
    insertTaskChat('ag-1', session.id, 'out-3', new Date().toISOString());

    const calls: Array<{ threadId: string | null }> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, threadId) {
        calls.push({ threadId });
        return 'plat-3';
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: null }]);
    const anchor = getTaskThreadAnchor(session.id, 'telegram', 'telegram:123');
    expect(anchor?.threadPlatformId).toBe('plat-3');
  });

  it('interactive (non-task) session posts are never anchored in task_thread_anchors', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const db = new Database(outboundDbPath('ag-1', session.id));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, in_reply_to, content)
       VALUES ('out-1', '2026-08-10T09:00:00.000Z', 'chat', 'telegram:123', 'telegram', NULL, 'turn-A', ?)`,
    ).run(JSON.stringify({ text: 'out-1' }));
    db.close();

    setDeliveryAdapter({
      async deliver() {
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);

    expect(getTaskThreadAnchor(session.id, 'telegram', 'telegram:123')).toBeNull();
  });

  it('a task post that already targets an explicit thread is left untouched (not anchored)', async () => {
    seedAgentAndChannel();
    grantChannelDestination('ag-1', 'mg-1');
    const { session } = resolveTaskSession('ag-1', 'series-1');
    insertTaskChat('ag-1', session.id, 'out-1', '2026-08-10T09:00:00.000Z', 'thr-9');

    const calls: Array<{ threadId: string | null }> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, threadId) {
        calls.push({ threadId });
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: 'thr-9' }]);
    expect(getTaskThreadAnchor(session.id, 'telegram', 'telegram:123')).toBeNull();
  });

  it('a series with threadAnchor:false posts every message at root and stores no anchor', async () => {
    seedAgentAndChannel();
    grantChannelDestination('ag-1', 'mg-1');
    const { session } = resolveTaskSession('ag-1', 'series-exempt');
    // The exemption is read from the series' own task row (content.threadAnchor
    // === false, set via `ncl tasks … --thread-anchor false`).
    const inDb = new Database(inboundDbPath('ag-1', session.id));
    inDb
      .prepare("INSERT INTO messages_in (id, kind, timestamp, series_id, content) VALUES (?, 'task', ?, ?, ?)")
      .run('task-row-1', now(), 'series-exempt', JSON.stringify({ prompt: 'p', threadAnchor: false }));
    inDb.close();
    insertTaskChat('ag-1', session.id, 'root-a', '2026-08-10T09:00:00.000Z');
    insertTaskChat('ag-1', session.id, 'root-b', '2026-08-10T10:00:00.000Z');

    const calls: Array<{ threadId: string | null }> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, threadId) {
        calls.push({ threadId });
        return `plat-${calls.length}`;
      },
    });

    await deliverSessionMessages(session);

    // Both posts land at root — same UTC day, but the series opted out.
    expect(calls).toEqual([{ threadId: null }, { threadId: null }]);
    expect(getTaskThreadAnchor(session.id, 'telegram', 'telegram:123')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bounded periodic work — delivery sweep change-gate.
// docs/specs/bounded-periodic-work/plan.md, acceptance criteria A1-A17.
//
// The sweep opened ~1,657 session DB pairs a minute to find the ~17 that had
// changed. These cases pin the gate that stops that, and — more importantly —
// pin the ways it must refuse to engage. Its failure mode would be a silently
// undelivered message, so the behavioural cases (A14-A17) assert delivery,
// not cache state.
// ---------------------------------------------------------------------------
import {
  shouldSkipQuietDelivery,
  quietDeliveryDeadlineMs,
  runSweepDeliveryCycle,
  sweepDeliverSession,
  peekQuietDeliveryMark,
  _resetQuietDeliveryCacheForTest,
  _setQuietDeliveryMarkForTest,
  QUIET_DELIVERY_BACKOFF_MS,
} from './delivery.js';
import { log } from './log.js';

const STAT = { mtimeNs: 1_000n, size: 4096 };

describe('shouldSkipQuietDelivery (A1-A5)', () => {
  it('A1 skips a quiet session whose outbound.db is unchanged within the time bound', () => {
    const armedAtMs = 1_000_000;
    const mark = { ...STAT, armedAtMs };
    expect(shouldSkipQuietDelivery(mark, STAT, armedAtMs + 60_000, 'sess-a')).toBe(true);
  });

  it('A2 polls when mtime moved', () => {
    const armedAtMs = 1_000_000;
    const mark = { ...STAT, armedAtMs };
    expect(shouldSkipQuietDelivery(mark, { mtimeNs: 1_001n, size: 4096 }, armedAtMs + 60_000, 'sess-a')).toBe(false);
  });

  it('A3 polls when size moved', () => {
    const armedAtMs = 1_000_000;
    const mark = { ...STAT, armedAtMs };
    expect(shouldSkipQuietDelivery(mark, { mtimeNs: 1_000n, size: 8192 }, armedAtMs + 60_000, 'sess-a')).toBe(false);
  });

  it('A4 polls once the time bound elapses even if nothing changed', () => {
    const armedAtMs = 1_000_000;
    const mark = { ...STAT, armedAtMs };
    const past = armedAtMs + QUIET_DELIVERY_BACKOFF_MS + 1;
    expect(shouldSkipQuietDelivery(mark, STAT, past, 'sess-a')).toBe(false);
  });

  it('A5 polls when there is no cache entry', () => {
    expect(shouldSkipQuietDelivery(undefined, STAT, 1_000_000, 'sess-a')).toBe(false);
  });
});

describe('quietDeliveryDeadlineMs (A13)', () => {
  it('A13 staggers forced re-poll deadlines across sessions, within the backoff maximum', () => {
    const armedAtMs = 1_000_000;
    const deadlines = ['sess-a', 'sess-b', 'sess-c', 'sess-d', 'sess-e'].map((id) =>
      quietDeliveryDeadlineMs(id, armedAtMs),
    );
    // Not all identical — otherwise the fleet expires in unison and the burst returns.
    expect(new Set(deadlines).size).toBeGreaterThan(1);
    for (const d of deadlines) {
      expect(d).toBeGreaterThanOrEqual(armedAtMs + QUIET_DELIVERY_BACKOFF_MS / 2);
      expect(d).toBeLessThanOrEqual(armedAtMs + QUIET_DELIVERY_BACKOFF_MS);
    }
    // Deterministic: survives a restart.
    expect(quietDeliveryDeadlineMs('sess-a', armedAtMs)).toBe(deadlines[0]);
  });
});

describe('delivery sweep gate — arming rules (A6-A12)', () => {
  beforeEach(() => {
    _resetQuietDeliveryCacheForTest();
    seedAgentAndChannel();
  });

  it('A6 never arms for a session left holding an undelivered row', async () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');
    setDeliveryAdapter({
      async deliver() {
        throw new Error('adapter down');
      },
    });

    await sweepDeliverSession(session, Date.now());
    expect(peekQuietDeliveryMark(session.id)).toBeUndefined();
  });

  it('A7 never arms for a session holding a future deliver_after row', async () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const db = new Database(outboundDbPath('ag-1', session.id));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content, deliver_after)
       VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?, datetime('now', '+1 hour'))`,
    ).run('out-future', JSON.stringify({ text: 'later' }));
    db.close();
    setDeliveryAdapter({
      async deliver() {
        return 'plat-1';
      },
    });

    await sweepDeliverSession(session, Date.now());
    expect(peekQuietDeliveryMark(session.id)).toBeUndefined();
  });

  it('A8 arms only after a drain that leaves zero undelivered rows', async () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');
    setDeliveryAdapter({
      async deliver() {
        return 'plat-1';
      },
    });

    await sweepDeliverSession(session, Date.now());
    const mark = peekQuietDeliveryMark(session.id);
    expect(mark).toBeDefined();
    // The stored stat is the one taken BEFORE the open, so a commit landing
    // during the drain is re-polled rather than swallowed.
    const after = fs.statSync(outboundDbPath('ag-1', session.id), { bigint: true });
    expect(mark!.mtimeNs).toBeLessThanOrEqual(after.mtimeNs);
  });

  it('A9 polls a session whose container is live regardless of cache', async () => {
    // Isolates the live-container bypass: the cache is armed to the CURRENT
    // stat, so the change signal says "nothing moved". The only thing that can
    // cause a poll here is the liveness check — if it were deleted, this test
    // fails. `isContainerRunning` is authoritative because spawn records its
    // in-memory entry before the central row is updated, so a swept snapshot
    // can still read 'stopped' for a container that is already writing.
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    setDeliveryAdapter({
      async deliver() {
        return 'plat-1';
      },
    });
    await sweepDeliverSession(session, Date.now());
    expect(peekQuietDeliveryMark(session.id)).toBeDefined();

    insertOutbound('ag-1', session.id, 'out-live');
    const stat = fs.statSync(outboundDbPath('ag-1', session.id), { bigint: true });
    _setQuietDeliveryMarkForTest(session.id, {
      mtimeNs: stat.mtimeNs,
      size: Number(stat.size),
      armedAtMs: Date.now(),
    });

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _k, content) {
        calls.push(content);
        return 'plat-2';
      },
    });

    // The session row still says stopped — exactly the staleness window.
    vi.mocked(isContainerRunning).mockReturnValue(true);
    try {
      const outcome = await sweepDeliverSession(session, Date.now());
      expect(outcome).not.toBe('skipped');
      expect(calls).toHaveLength(1);
    } finally {
      vi.mocked(isContainerRunning).mockReturnValue(false);
    }
  });

  it('A10 polls when a hot journal exists', async () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    setDeliveryAdapter({
      async deliver() {
        return 'plat-1';
      },
    });
    await sweepDeliverSession(session, Date.now());
    expect(peekQuietDeliveryMark(session.id)).toBeDefined();

    fs.writeFileSync(`${outboundDbPath('ag-1', session.id)}-journal`, '');
    const outcome = await sweepDeliverSession(session, Date.now());
    expect(outcome).not.toBe('skipped');
  });

  it('A11 does not lose a commit that lands after the pre-open stat', async () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');
    setDeliveryAdapter({
      async deliver() {
        // A row committed by the container while this drain is in flight.
        insertOutbound('ag-1', session.id, 'out-racing');
        return 'plat-1';
      },
    });
    await sweepDeliverSession(session, Date.now());

    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _k, content) {
        delivered.push(content);
        return 'plat-2';
      },
    });
    const outcome = await sweepDeliverSession(session, Date.now());
    expect(outcome).not.toBe('skipped');
    expect(delivered).toHaveLength(1);
  });

  it('A18 one unreadable session does not abort the cycle for the rest', async () => {
    // The drain now reads `delivered` for every swept session, not just ones
    // with due rows, so a legacy/corrupt session DB has a wider blast radius
    // than before. It must cost that session, not the whole sweep.
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'telegram',
      platform_id: 'telegram:456',
      name: 'Second Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    const { session: broken } = resolveSession('ag-1', 'mg-2', null, 'shared');
    const { session: healthy } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', healthy.id, 'out-ok');
    const inDb = new Database(inboundDbPath('ag-1', broken.id));
    inDb.exec('DROP TABLE delivered');
    inDb.close();

    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _k, content) {
        delivered.push(content);
        return 'plat-1';
      },
    });

    const cycle = await runSweepDeliveryCycle(Date.now());
    expect(delivered).toHaveLength(1);
    expect(cycle.polled).toBeGreaterThanOrEqual(2);
    expect(peekQuietDeliveryMark(broken.id)).toBeUndefined();
  });

  it('A12 records polled and skipped counts every cycle', async () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    setDeliveryAdapter({
      async deliver() {
        return 'plat-1';
      },
    });
    const spy = vi.spyOn(log, 'info');

    const first = await runSweepDeliveryCycle(Date.now());
    expect(first.polled).toBeGreaterThanOrEqual(1);
    expect(first.skipped).toBe(0);

    const second = await runSweepDeliveryCycle(Date.now());
    expect(second.skipped).toBeGreaterThanOrEqual(1);

    // Emitted every cycle — a fast, skip-heavy cycle must not be silent, or a
    // stopped sweep looks identical to a healthy one.
    const timing = spy.mock.calls.filter((c) => c[0] === 'Sweep delivery poll timing');
    expect(timing.length).toBe(2);
    expect(timing[1]![1]).toMatchObject({ skipped: expect.any(Number), polled: expect.any(Number) });
    expect(session.id).toBeDefined();
    spy.mockRestore();
  });
});

describe('delivery sweep gate — delivery is never stranded (A14-A17)', () => {
  beforeEach(() => {
    _resetQuietDeliveryCacheForTest();
    seedAgentAndChannel();
  });

  it('A14 delivers by the backoff deadline even when the change signal never moves', async () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    setDeliveryAdapter({
      async deliver() {
        return 'plat-1';
      },
    });
    const armedAt = Date.now();
    await sweepDeliverSession(session, armedAt);
    const mark = peekQuietDeliveryMark(session.id)!;
    expect(mark).toBeDefined();

    // A row arrives, but the change signal does not move — the pathological
    // case the time bound exists for. Forced via the test seam because arming
    // legitimately requires a clean drain, and utimes cannot restore ns
    // precision, so this state is unreachable through the public path.
    const outPath = outboundDbPath('ag-1', session.id);
    insertOutbound('ag-1', session.id, 'out-stuck');
    const stale = fs.statSync(outPath, { bigint: true });
    _setQuietDeliveryMarkForTest(session.id, {
      mtimeNs: stale.mtimeNs,
      size: Number(stale.size),
      armedAtMs: mark.armedAtMs,
    });

    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _k, content) {
        delivered.push(content);
        return 'plat-2';
      },
    });

    // Before the deadline the gate legitimately skips.
    await sweepDeliverSession(session, armedAt + 1_000);
    expect(delivered).toHaveLength(0);

    // Past the jittered deadline it must poll regardless of the frozen signal.
    await sweepDeliverSession(session, quietDeliveryDeadlineMs(session.id, mark.armedAtMs) + 1);
    expect(delivered).toHaveLength(1);
  });

  it('A15 delivers a row written between the pre-open stat and arming, on the next sweep', async () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');
    setDeliveryAdapter({
      async deliver() {
        insertOutbound('ag-1', session.id, 'out-racing');
        return 'plat-1';
      },
    });
    const t = Date.now();
    await sweepDeliverSession(session, t);

    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t2, _k, content) {
        delivered.push(content);
        return 'plat-2';
      },
    });
    // Same instant — not waiting out the backoff. The pre-open stat is what
    // makes this re-poll.
    await sweepDeliverSession(session, t);
    expect(delivered).toHaveLength(1);
  });

  it('A16 does not arm while pollActive owns the session', async () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    setDeliveryAdapter({
      async deliver() {
        await held;
        return 'plat-1';
      },
    });

    const active = deliverSessionMessages(session);
    const swept = await sweepDeliverSession(session, Date.now());
    expect(swept).toBe('busy');
    expect(peekQuietDeliveryMark(session.id)).toBeUndefined();
    release();
    await active;
  });

  it('A17 does not arm when delivery failed this cycle, and retries next sweep', async () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');
    let attempts = 0;
    setDeliveryAdapter({
      async deliver() {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
        return 'plat-1';
      },
    });

    const first = await sweepDeliverSession(session, Date.now());
    expect(first).toBe('error');
    expect(peekQuietDeliveryMark(session.id)).toBeUndefined();

    await sweepDeliverSession(session, Date.now());
    expect(attempts).toBe(2);
  });
});
