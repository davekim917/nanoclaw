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
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-delivery' };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { resolveSession, outboundDbPath } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';

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
): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, datetime('now'), ?, ?, ?, ?, ?)`,
  ).run(msgId, kind, platformId, channelType, threadId, JSON.stringify(content));
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
