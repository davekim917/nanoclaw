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

vi.mock('./container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: `${TEST_DIR}/groups` };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-delivery') }));

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { getDeliveredIds } from './modules/mailbox/ops/delivery.js';
import { resolveSession, resolveTaskSession, withMailboxSession, writeSessionMessage } from './session-manager.js';
import { openInboundDb as openInboundDbAt } from './modules/mailbox/openers.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { getTaskThreadAnchor, setTaskThreadAnchor } from './db/task-thread-anchors.js';
import { getRawDb } from './db/connection.js';
import { createPendingApproval, deletePendingApproval, getPendingApproval, getPendingQuestion } from './db/sessions.js';
import {
  _resetStatusTrackingForTest,
  _threadKeyLockWaitersForTest,
  clearSessionStatusOnKill,
  deliverSessionMessages,
  registerDeliveryAction,
  setDeliveryAdapter,
  settleSessionStatusAfterPublicDelivery,
  assertChannelRoutingConsistency,
} from './delivery.js';
import { unguarded } from './guard/index.js';
import { createChannelDeliveryAdapter } from './channels/channel-registry.js';
import { isContainerRunning } from './container-runner.js';
import { renderWorkOutcome } from './outcome-reporting-schema.js';

function now(): string {
  return new Date().toISOString();
}

async function seedAgentAndChannel(): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
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

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initTestDb();
  const db = getRawDb();
  runMigrations(db);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('deliverSessionMessages — concurrent invocations', () => {
  it.each([false, true])(
    'isolates malformed wiki policy while retaining durable actor restriction (listed=%s)',
    async (listed) => {
      await seedAgentAndChannel();
      const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
      const directory = `${TEST_DIR}/groups/_ops/wiki`;
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        `${directory}/actors.json`,
        JSON.stringify({ version: 1, actorGroupIds: [listed ? 'ag-1' : 'writer', 'verifier'] }),
      );
      fs.writeFileSync(`${directory}/admission.json`, '{malformed');
      insertOutbound('ag-1', session.id, 'policy-isolation');
      const deliver = vi.fn(async () => 'policy-test-message');
      setDeliveryAdapter({ deliver });
      await deliverSessionMessages(session);
      expect(deliver).toHaveBeenCalledTimes(listed ? 0 : 1);
    },
  );
  it('delivers a message exactly once when active and sweep polls overlap', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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

  it('humanizes gate-verdict tokens in chat text before the adapter sees it', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutboundKind('ag-1', session.id, 'out-verdict', 'chat', 'telegram', 'telegram:123', {
      text: 'Verdict: do not ship — `NO_GO` on a/NO_GO/b',
    });
    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'plat-verdict';
      },
    });
    await deliverSessionMessages(session);
    expect(calls.map((c) => JSON.parse(c).text)).toEqual(['Verdict: do not ship — No-go on a/NO_GO/b']);
  });

  it('deletes the orphan thinking-block on chat-final delivery, using the stored route', async () => {
    // Status posts to (telegram, telegram:123). Then a kind='chat' delivers.
    // Cleanup must fire deleteMessage with the SAME route the status was
    // posted to — even if the chat reply hypothetically targeted a different
    // route, we must not delete via the chat reply's route.
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

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
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

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
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

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

  it('removes a stopped lifecycle row when a queued reply lands after the container was killed', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

    const deliveries: Array<{ kind: string; content: Record<string, unknown> }> = [];
    const deletes: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, kind, content) {
        deliveries.push({ kind, content: JSON.parse(content) as Record<string, unknown> });
        if (deliveries.length === 1) return 'plat-lifecycle-1';
        if (kind === 'chat') return 'plat-reply-1';
        return undefined;
      },
      async deleteMessage(_channelType, _platformId, _threadId, messageId) {
        deletes.push(messageId);
      },
    });

    insertOutboundKind('ag-1', session.id, 'lifecycle-1', 'status', 'telegram', 'telegram:123', {
      text: 'Accepted · working',
      reporting: { version: 1, purpose: 'liveness', state: 'working' },
    });
    await deliverSessionMessages(session);
    insertOutboundKind('ag-1', session.id, 'queued-reply', 'chat', 'telegram', 'telegram:123', {
      text: 'The queued work completed.',
      reporting: { version: 1, purpose: 'reply' },
    });

    await clearSessionStatusOnKill(session.id);
    expect(deliveries[1]).toMatchObject({
      kind: 'status',
      content: { operation: 'edit', messageId: 'plat-lifecycle-1', text: 'Stopped.' },
    });

    await deliverSessionMessages(session);
    expect(deliveries.at(-1)).toMatchObject({ kind: 'chat', content: { text: 'The queued work completed.' } });
    expect(deletes).toEqual(['plat-lifecycle-1']);
  });

  it.each(['unsupported', 'throws'] as const)(
    'keeps same-route approval settlement terminal when status deletion is %s',
    async (deleteMode) => {
      await seedAgentAndChannel();
      const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
      const events: string[] = [];
      setDeliveryAdapter({
        async deliver(_channelType, _platformId, _threadId, kind, content) {
          const parsed = JSON.parse(content) as { operation?: string; text?: string };
          events.push(parsed.operation === 'edit' ? `edit:${parsed.text}` : `post:${kind}`);
          return kind === 'status' && !parsed.operation ? 'plat-lifecycle-approval' : undefined;
        },
        ...(deleteMode === 'throws'
          ? {
              async deleteMessage() {
                const inbound = openInboundDb('ag-1', session.id);
                const receipt = inbound
                  .prepare('SELECT platform_message_id,lifecycle_terminal_at FROM delivered WHERE message_out_id = ?')
                  .get('lifecycle-approval') as {
                  platform_message_id: string;
                  lifecycle_terminal_at: string | null;
                };
                inbound.close();
                expect(receipt.platform_message_id).toBe('plat-lifecycle-approval');
                expect(receipt.lifecycle_terminal_at).not.toBeNull();
                events.push('delete:throws');
                throw new Error('delete unsupported by adapter');
              },
            }
          : {}),
      });
      insertOutboundKind('ag-1', session.id, 'lifecycle-approval', 'status', 'telegram', 'telegram:123', {
        text: 'Accepted · working',
        reporting: { version: 1, purpose: 'liveness', state: 'working' },
      });
      await deliverSessionMessages(session);
      await createPendingApproval({
        approval_id: `approval-${deleteMode}`,
        request_id: `approval-${deleteMode}`,
        action: 'test_action',
        payload: '{}',
        created_at: now(),
        title: 'Approve?',
        options_json: '[]',
        session_id: session.id,
        agent_group_id: 'ag-1',
        channel_type: 'telegram',
        platform_id: 'telegram:123',
        thread_id: null,
      });

      await settleSessionStatusAfterPublicDelivery(session.id, {
        conversation: { channelType: 'telegram', platformId: 'telegram:123', threadId: null },
        waitWhenElsewhere: true,
      });
      await deletePendingApproval(`approval-${deleteMode}`);
      _resetStatusTrackingForTest();
      insertOutboundKind('ag-1', session.id, `turn-end-${deleteMode}`, 'system', null as never, null as never, {
        action: 'turn_end',
        lifecycleStatusId: 'lifecycle-approval',
      });
      await deliverSessionMessages(session);

      expect(events).toContain('edit:Response delivered.');
      expect(events.some((event) => event.includes('Stopped'))).toBe(false);
      const inbound = openInboundDb('ag-1', session.id);
      const receipt = inbound
        .prepare('SELECT platform_message_id,lifecycle_terminal_at FROM delivered WHERE message_out_id = ?')
        .get('lifecycle-approval') as { platform_message_id: string; lifecycle_terminal_at: string | null };
      expect(receipt.platform_message_id).toBe('plat-lifecycle-approval');
      expect(receipt.lifecycle_terminal_at).not.toBeNull();
      inbound.close();
    },
  );

  it('keeps an off-route pending approval visible as waiting across turn_end and host memory loss', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    const edits: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, kind, content) {
        const parsed = JSON.parse(content) as { operation?: string; text?: string };
        if (parsed.operation === 'edit') edits.push(parsed.text ?? '');
        return kind === 'status' && !parsed.operation ? 'plat-off-route' : undefined;
      },
      async deleteMessage() {
        throw new Error('must not delete an off-route waiting line');
      },
    });
    insertOutboundKind(
      'ag-1',
      session.id,
      'lifecycle-off-route',
      'status',
      'telegram',
      'telegram:123',
      {
        text: 'Accepted · working',
        reporting: { version: 1, purpose: 'liveness', state: 'working' },
      },
      'thread-a',
    );
    await deliverSessionMessages(session);
    await createPendingApproval({
      approval_id: 'approval-off-route',
      request_id: 'approval-off-route',
      action: 'test_action',
      payload: '{}',
      created_at: now(),
      title: 'Approve?',
      options_json: '[]',
      session_id: session.id,
      agent_group_id: 'ag-1',
      channel_type: 'telegram',
      platform_id: 'telegram:123',
      thread_id: 'thread-b',
    });

    await settleSessionStatusAfterPublicDelivery(session.id, {
      conversation: { channelType: 'telegram', platformId: 'telegram:123', threadId: 'thread-b' },
      waitWhenElsewhere: true,
    });
    _resetStatusTrackingForTest();
    insertOutboundKind('ag-1', session.id, 'turn-end-off-route', 'system', null as never, null as never, {
      action: 'turn_end',
      lifecycleStatusId: 'lifecycle-off-route',
    });
    await deliverSessionMessages(session);

    expect(edits).toEqual(['Waiting for approval.', 'Waiting for approval.']);
    const inbound = openInboundDb('ag-1', session.id);
    expect(
      inbound
        .prepare('SELECT lifecycle_terminal_at FROM delivered WHERE message_out_id = ?')
        .get('lifecycle-off-route'),
    ).toEqual({ lifecycle_terminal_at: null });
    inbound.close();
  });

  it('acks one public send even when lifecycle receipt settlement loses its central DB', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    let publicSends = 0;
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, kind) {
        if (kind === 'status') return 'plat-working-db-loss';
        publicSends += 1;
        await closeDb();
        return 'plat-public-db-loss';
      },
    });
    insertOutboundKind('ag-1', session.id, 'working-db-loss', 'status', 'telegram', 'telegram:123', {
      text: 'Accepted · working',
      reporting: { version: 1, purpose: 'liveness', state: 'working' },
    });
    await deliverSessionMessages(session);
    insertOutboundKind('ag-1', session.id, 'public-db-loss', 'chat', 'telegram', 'telegram:123', {
      text: 'The result was delivered.',
      reporting: { version: 1, purpose: 'reply' },
    });

    await deliverSessionMessages(session);

    expect(publicSends).toBe(1);
    const inbound = openInboundDb('ag-1', session.id);
    expect(getDeliveredIds(inbound).has('public-db-loss')).toBe(true);
    inbound.close();
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
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

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
      await createAgentGroup({
        id: 'ag-1',
        name: 'Test Agent',
        folder: 'test-agent',
        agent_provider: null,
        created_at: now(),
      });
      await createMessagingGroup({
        id: 'mg-1',
        channel_type: channelType,
        platform_id: 'discord:guild-1:channel-1',
        name: 'Test Discord Thread',
        is_group: 1,
        unknown_sender_policy: 'public',
        created_at: now(),
      });
      const { session } = await resolveSession('ag-1', 'mg-1', 'thread-1', 'per-thread');

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
        { text: 'first', reporting: { version: 1, purpose: 'liveness', state: 'working' } },
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
        { text: 'second', reporting: { version: 1, purpose: 'progress' } },
        'thread-1',
        'turn-1',
      );
      await deliverSessionMessages(session);

      expect(calls).toHaveLength(3);
      expect(calls[1]).toMatchObject({ operation: 'edit', messageId: 'status-1', text: 'second' });
      expect(calls[2]).toMatchObject({ text: 'second' });
      expect(deletes).toEqual(['status-1']);

      insertOutboundKind(
        'ag-1',
        session.id,
        'status-3',
        'status',
        channelType,
        'discord:guild-1:channel-1',
        { text: 'third', reporting: { version: 1, purpose: 'progress' } },
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

      _resetStatusTrackingForTest();
      insertOutboundKind(
        'ag-1',
        session.id,
        'final-reply',
        'chat',
        channelType,
        'discord:guild-1:channel-1',
        { text: 'Done.' },
        'thread-1',
        'turn-1',
      );
      await deliverSessionMessages(session);
      expect(deletes).toEqual(['status-1', 'status-2']);
    },
  );

  it('preserves status order when a Discord 30046 replacement post fails transiently', async () => {
    await createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord-codex',
      platform_id: 'discord:guild-1:channel-1',
      name: 'Test Discord Thread',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    const { session } = await resolveSession('ag-1', 'mg-1', 'thread-1', 'per-thread');

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
    await createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'telegram:123',
      instance: 'telegram-bot-A',
      name: 'Test Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

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
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

    // Mark this session as a spawn-child by inserting a task row with
    // child_session_id = session.id. `isSpawnChildSession` queries the
    // central tasks table and caches per-process.
    const { getRawDb } = await import('./db/connection.js');
    getRawDb()
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
      reporting: { version: 1, purpose: 'progress' },
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
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

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
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    await createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    // Two instances own the same chat address. The named row sorts before
    // 'slack', so a plain by-platform lookup (default-instance-first) would
    // pick mg-default — only origin-session preference selects mg-tester.
    await createMessagingGroup({
      id: 'mg-default',
      channel_type: 'slack',
      platform_id: 'slack:C1',
      name: 'Default',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-tester',
      channel_type: 'slack',
      platform_id: 'slack:C1',
      instance: 'alpha-tester',
      name: 'Tester',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const { session } = await resolveSession('ag-1', 'mg-tester', null, 'shared');
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
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    await seedAgentAndChannel();

    // Create a second messaging group that the agent is NOT wired to
    await createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'discord:456',
      name: 'Unauthorized Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    // Session is on mg-1 (telegram)
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

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
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    getRawDb()
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
    inReplyTo = `task-fire-${msgId}`,
    content: Record<string, unknown> = { text: msgId },
  ): void {
    const db = new Database(outboundDbPath(agentGroupId, sessionId));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, in_reply_to, content)
       VALUES (?, ?, 'chat', 'telegram:123', 'telegram', ?, ?, ?)`,
    ).run(msgId, ts, threadId, inReplyTo, JSON.stringify(content));
    db.close();
  }

  // ── the 2026-09-07 escalation ledger (migration 075) ──────────────────────
  //
  // A failing fire used to leave the run log (a markdown file nothing queries)
  // and an occurrence row reading `completed`. `task_run_outcomes` is the
  // queryable half; delivery is where the runner's verdict becomes a row.
  function insertTaskLog(
    agentGroupId: string,
    sessionId: string,
    msgId: string,
    content: Record<string, unknown>,
    inReplyTo: string | null = null,
  ): void {
    const db = new Database(outboundDbPath(agentGroupId, sessionId));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, in_reply_to, content)
       VALUES (?, ?, 'task_log', NULL, NULL, NULL, ?, ?)`,
    ).run(msgId, now(), inReplyTo, JSON.stringify(content));
    db.close();
  }

  async function outcomeRows(): Promise<Array<{ outcome: string; model: string | null; detail: string | null }>> {
    return getRawDb().prepare('SELECT outcome, model, detail FROM task_run_outcomes ORDER BY id').all() as Array<{
      outcome: string;
      model: string | null;
      detail: string | null;
    }>;
  }

  it('records an errored task run as a failure, with the model that ran', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveTaskSession('ag-1', 'series-1');
    insertTaskLog('ag-1', session.id, 'log-1', {
      text: "There's an issue with the selected model (gpt-6-astra).",
      auto: true,
      isError: true,
      model: 'gpt-6-astra',
    });
    setDeliveryAdapter({
      async deliver() {
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);

    expect(await outcomeRows()).toEqual([
      {
        outcome: 'failed',
        model: 'gpt-6-astra',
        detail: "There's an issue with the selected model (gpt-6-astra).",
      },
    ]);
  });

  it('records a clean task run as a success', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveTaskSession('ag-1', 'series-1');
    insertTaskLog('ag-1', session.id, 'log-1', { text: 'no PR state changes', auto: true, model: 'claude-fable-5-1' });
    setDeliveryAdapter({
      async deliver() {
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);

    expect((await outcomeRows()).map((r) => r.outcome)).toEqual(['ok']);
  });
  it('keeps correlated internal phase outcomes private and leaves unrelated inbound work pending', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveTaskSession('ag-1', 'phase-1');
    const inbound = new Database(inboundDbPath('ag-1', session.id));
    inbound
      .prepare(
        "INSERT INTO messages_in(id,seq,kind,timestamp,status,content) VALUES('human-unrelated',2,'chat',?,'pending','{}')",
      )
      .run(now());
    insertTaskLog(
      'ag-1',
      session.id,
      'phase-log',
      { text: 'phase artifacts accepted', auto: true, taskMessageIds: ['event-one'] },
      'event-one',
    );
    const deliver = vi.fn().mockResolvedValue('unexpected-public-post');
    setDeliveryAdapter({ deliver });
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(deliver).not.toHaveBeenCalled();
    expect(await outcomeRows()).toHaveLength(1);
    expect(inbound.prepare("SELECT status FROM messages_in WHERE id='human-unrelated'").get()).toEqual({
      status: 'pending',
    });
    inbound.close();
  });

  it('ignores a mid-run append-log note — only the end-of-run summary is a fire', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveTaskSession('ag-1', 'series-1');
    insertTaskLog('ag-1', session.id, 'log-1', { text: 'one feed returned 403; continuing' });
    setDeliveryAdapter({
      async deliver() {
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);

    expect(await outcomeRows()).toEqual([]);
  });

  it('first post: no anchor yet — posts at root and stores the anchor', async () => {
    await seedAgentAndChannel();
    grantChannelDestination('ag-1', 'mg-1');
    const { session } = await resolveTaskSession('ag-1', 'series-1');
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
    const anchor = await getTaskThreadAnchor(session.id, 'telegram', 'telegram:123');
    expect(anchor).toEqual({ threadPlatformId: 'plat-1', createdAt: expect.any(String) });
  });

  // ── Regression guard for migration 056 ────────────────────────────────────
  //
  // `sessions.messaging_group_id === null` is the discriminator BOTH task-only
  // branches of delivery.ts key on: the `task_log` branch that appends a run's
  // final text to the series log, and `isTaskSessionPost`, which drives this
  // whole rolling-anchor block. Migration 056 adds a routing stamp to task
  // sessions, and the obvious-but-wrong way to ship it would have been to give
  // the session the `messaging_group_id` it was routed to — which would send
  // `task_log` rows to the "task_log row outside a task session — ignoring"
  // else branch and silently stop run-log appends, and would drop this session
  // out of `isTaskSessionPost` so it never anchors again.
  //
  // This test pins that the stamp does NOT do that: a fully routed task session
  // still has a NULL messaging_group_id, and still behaves as a task-session
  // post end to end (root post + stored anchor).
  it('a routing-stamped task session keeps messaging_group_id NULL and still anchors', async () => {
    await seedAgentAndChannel();
    grantChannelDestination('ag-1', 'mg-1');
    const { session } = await resolveTaskSession('ag-1', 'series-1', 'telegram:123');

    // The stamp landed on its own column, and the discriminator column did not
    // move — read straight from the DB, not from the in-memory object.
    const row = getRawDb()
      .prepare('SELECT messaging_group_id, task_routing_platform_id FROM sessions WHERE id = ?')
      .get(session.id) as { messaging_group_id: string | null; task_routing_platform_id: string | null };
    expect(row.messaging_group_id).toBeNull();
    expect(row.task_routing_platform_id).toBe('telegram:123');
    expect(session.messaging_group_id).toBeNull();

    // ...and delivery still treats it as a task-session post: root post, anchor
    // stored. Both are unreachable once `isTaskSessionPost` goes false.
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
    expect(await getTaskThreadAnchor(session.id, 'telegram', 'telegram:123')).toEqual({
      threadPlatformId: 'plat-1',
      createdAt: expect.any(String),
    });
  });

  it('second post same UTC day: threads under the stored anchor', async () => {
    await seedAgentAndChannel();
    grantChannelDestination('ag-1', 'mg-1');
    const { session } = await resolveTaskSession('ag-1', 'series-1');
    // Now-relative: rotation compares against the real clock, so a hardcoded
    // date makes this test fail the day after it was written.
    await setTaskThreadAnchor(session.id, 'telegram', 'telegram:123', 'plat-1', new Date().toISOString());
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
    const anchor = await getTaskThreadAnchor(session.id, 'telegram', 'telegram:123');
    expect(anchor?.threadPlatformId).toBe('plat-1');
  });

  it('edits/reactions: the anchor message is addressed at root, in-thread messages via the anchor', async () => {
    await seedAgentAndChannel();
    grantChannelDestination('ag-1', 'mg-1');
    const { session } = await resolveTaskSession('ag-1', 'series-1');
    await setTaskThreadAnchor(session.id, 'telegram', 'telegram:123', 'plat-1', new Date().toISOString());
    const now = new Date().toISOString();
    const edit = (messageId: string) => ({ operation: 'edit', messageId, text: 'amended' });
    insertTaskChat('ag-1', session.id, 'out-1', now, null, 'task-fire-x', edit('plat-1'));
    insertTaskChat('ag-1', session.id, 'out-2', now, null, 'task-fire-x', {
      operation: 'reaction',
      messageId: 'plat-1',
      emoji: 'eyes',
    });
    insertTaskChat('ag-1', session.id, 'out-3', now, null, 'task-fire-x', edit('plat-in-thread'));

    const calls: Array<{ threadId: string | null }> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, threadId) {
        calls.push({ threadId });
        return undefined;
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: null }, { threadId: null }, { threadId: 'telegram:123:plat-1' }]);
    expect((await getTaskThreadAnchor(session.id, 'telegram', 'telegram:123'))?.threadPlatformId).toBe('plat-1');
  });

  it('edits: a failed edit under the anchor retries at root and keeps the anchor', async () => {
    await seedAgentAndChannel();
    grantChannelDestination('ag-1', 'mg-1');
    const { session } = await resolveTaskSession('ag-1', 'series-1');
    await setTaskThreadAnchor(session.id, 'telegram', 'telegram:123', 'plat-1', new Date().toISOString());
    insertTaskChat('ag-1', session.id, 'out-1', new Date().toISOString(), null, 'task-fire-x', {
      operation: 'edit',
      messageId: 'plat-yesterday',
      text: 'amended',
    });

    const calls: Array<{ threadId: string | null }> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, threadId) {
        calls.push({ threadId });
        if (threadId !== null) throw new Error('Unknown Message');
        return undefined;
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: 'telegram:123:plat-1' }, { threadId: null }]);
    expect((await getTaskThreadAnchor(session.id, 'telegram', 'telegram:123'))?.threadPlatformId).toBe('plat-1');
  });

  it('day rollover: posts a fresh root message and replaces the anchor', async () => {
    await seedAgentAndChannel();
    grantChannelDestination('ag-1', 'mg-1');
    const { session } = await resolveTaskSession('ag-1', 'series-1');
    await setTaskThreadAnchor(
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
    const anchor = await getTaskThreadAnchor(session.id, 'telegram', 'telegram:123');
    expect(anchor?.threadPlatformId).toBe('plat-3');
  });

  it('interactive (non-task) session posts are never anchored in task_thread_anchors', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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

    expect(await getTaskThreadAnchor(session.id, 'telegram', 'telegram:123')).toBeNull();
  });

  it('a task post that already targets an explicit thread is left untouched (not anchored)', async () => {
    await seedAgentAndChannel();
    grantChannelDestination('ag-1', 'mg-1');
    const { session } = await resolveTaskSession('ag-1', 'series-1');
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
    expect(await getTaskThreadAnchor(session.id, 'telegram', 'telegram:123')).toBeNull();
  });

  it('a series with threadAnchor:false posts every message at root and stores no anchor', async () => {
    await seedAgentAndChannel();
    grantChannelDestination('ag-1', 'mg-1');
    const { session } = await resolveTaskSession('ag-1', 'series-exempt');
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
    expect(await getTaskThreadAnchor(session.id, 'telegram', 'telegram:123')).toBeNull();
  });

  it('a threadAnchor:false campaign keeps same-fire evidence under its fresh root', async () => {
    await seedAgentAndChannel();
    grantChannelDestination('ag-1', 'mg-1');
    const { session } = await resolveTaskSession('ag-1', 'series-contact-sheet');
    const inDb = new Database(inboundDbPath('ag-1', session.id));
    inDb
      .prepare("INSERT INTO messages_in (id, kind, timestamp, series_id, content) VALUES (?, 'task', ?, ?, ?)")
      .run(
        'task-row-contact-sheet',
        now(),
        'series-contact-sheet',
        JSON.stringify({ prompt: 'p', threadAnchor: false }),
      );
    inDb.close();

    // The campaign itself owns a new root per fire; its immediate contact-sheet
    // evidence is a second row from the SAME fire and belongs in that root's
    // platform thread, not beside it in the channel.
    insertTaskChat('ag-1', session.id, 'kickoff', '2026-08-10T09:00:00.000Z', null, 'task-fire-contact-sheet');
    insertTaskChat('ag-1', session.id, 'contact-sheet', '2026-08-10T09:00:01.000Z', null, 'task-fire-contact-sheet');

    const calls: Array<{ threadId: string | null }> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, threadId) {
        calls.push({ threadId });
        return `plat-${calls.length}`;
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: null }, { threadId: 'telegram:123:plat-1' }]);
    // The transient same-fire anchor must not turn into the task's rolling
    // day anchor; the next fire still starts a distinct campaign root.
    expect(await getTaskThreadAnchor(session.id, 'telegram', 'telegram:123')).toBeNull();
  });
});

describe('keyed thread anchors (content.threadKey, migration 081)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function grantChannelDestination(agentGroupId: string, messagingGroupId: string): void {
    getRawDb()
      .prepare(
        `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
         VALUES (?, 'main', 'channel', ?, ?)`,
      )
      .run(agentGroupId, messagingGroupId, now());
  }

  // Content shapes are the ones the runner's tools write
  // (container/agent-runner/src/mcp-tools/core.ts): send_message → { text, threadKey },
  // edit_message → { operation: 'edit', messageId, text, threadKey }.
  function insertChat(
    agentGroupId: string,
    sessionId: string,
    msgId: string,
    content: Record<string, unknown>,
    opts: { ts?: string; threadId?: string | null; inReplyTo?: string } = {},
  ): void {
    const db = new Database(outboundDbPath(agentGroupId, sessionId));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, in_reply_to, content)
       VALUES (?, ?, 'chat', 'telegram:123', 'telegram', ?, ?, ?)`,
    ).run(msgId, opts.ts ?? now(), opts.threadId ?? null, opts.inReplyTo ?? `fire-${msgId}`, JSON.stringify(content));
    db.close();
  }

  function keyRows(): Array<{
    agent_group_id: string;
    messaging_group_id: string;
    thread_key: string;
    thread_platform_id: string;
    created_at: string;
    last_used_at: string;
  }> {
    return getRawDb()
      .prepare(
        'SELECT agent_group_id, messaging_group_id, thread_key, thread_platform_id, created_at, last_used_at FROM thread_key_anchors ORDER BY agent_group_id, messaging_group_id, thread_key',
      )
      .all() as never;
  }

  function seedKey(
    agentGroupId: string,
    threadKey: string,
    threadPlatformId: string,
    atIso: string,
    messagingGroupId = 'mg-1',
  ): void {
    getRawDb()
      .prepare(
        `INSERT INTO thread_key_anchors
           (agent_group_id, messaging_group_id, thread_key, thread_platform_id, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(agentGroupId, messagingGroupId, threadKey, threadPlatformId, atIso, atIso);
  }

  function recordingAdapter(opts: { failThreaded?: boolean } = {}): Array<{ threadId: string | null }> {
    const calls: Array<{ threadId: string | null }> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, threadId) {
        calls.push({ threadId });
        if (opts.failThreaded && threadId !== null) throw new Error('Unknown Channel');
        return `plat-${calls.length}`;
      },
    });
    return calls;
  }

  function deliveredIds(agentGroupId: string, sessionId: string): Set<string> {
    const inDb = openInboundDbAt(inboundDbPath(agentGroupId, sessionId));
    try {
      return getDeliveredIds(inDb);
    } finally {
      inDb.close();
    }
  }

  async function taskSession(series = 'series-1') {
    await seedAgentAndChannel();
    grantChannelDestination('ag-1', 'mg-1');
    return (await resolveTaskSession('ag-1', series)).session;
  }

  it('first keyed post goes to root and records the key', async () => {
    const session = await taskSession();
    insertChat('ag-1', session.id, 'out-1', { text: 'job A failed', threadKey: 'job-a-run-1' });
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: null }]);
    expect(keyRows()).toEqual([
      {
        agent_group_id: 'ag-1',
        messaging_group_id: 'mg-1',
        thread_key: 'job-a-run-1',
        thread_platform_id: 'plat-1',
        created_at: expect.any(String),
        last_used_at: expect.any(String),
      },
    ]);
    // A keyed post is not the series' rolling day anchor.
    expect(await getTaskThreadAnchor(session.id, 'telegram', 'telegram:123')).toBeNull();
  });

  it('a later post with the same key threads under the first, keeps the record, and bumps last_used_at', async () => {
    const session = await taskSession();
    const earlier = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    seedKey('ag-1', 'job-a-run-1', 'plat-root', earlier);
    insertChat('ag-1', session.id, 'out-2', { text: 'still failing', threadKey: 'job-a-run-1' });
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: 'telegram:123:plat-root' }]);
    const [row] = keyRows();
    expect(row.thread_platform_id).toBe('plat-root');
    expect(row.created_at).toBe(earlier);
    expect(row.last_used_at > earlier).toBe(true);
  });

  it('archives a keyed follow-up under the thread it landed in, so read_thread finds it', async () => {
    const session = await taskSession();
    seedKey('ag-1', 'job-a-run-1', 'plat-root', now());
    insertChat('ag-1', session.id, 'out-2', { text: 'still failing', threadKey: 'job-a-run-1' });
    recordingAdapter();

    await deliverSessionMessages(session);

    const archive = new Database(`${TEST_DIR}/archive.db`, { readonly: true });
    try {
      expect(archive.prepare("SELECT thread_id FROM messages_archive WHERE id = 'out-2'").get()).toEqual({
        thread_id: 'telegram:123:plat-root',
      });
    } finally {
      archive.close();
    }
  });

  it('a different key is a new top-level post, even the same day and with a live day anchor', async () => {
    const session = await taskSession();
    seedKey('ag-1', 'job-a-run-1', 'plat-root-a', now());
    await setTaskThreadAnchor(session.id, 'telegram', 'telegram:123', 'plat-day', now());
    insertChat('ag-1', session.id, 'out-1', { text: 'job B failed', threadKey: 'job-b-run-5' });
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: null }]);
    expect(keyRows().map((r) => [r.thread_key, r.thread_platform_id])).toEqual([
      ['job-a-run-1', 'plat-root-a'],
      ['job-b-run-5', 'plat-1'],
    ]);
    // The keyed post neither threaded under nor replaced the day anchor.
    expect((await getTaskThreadAnchor(session.id, 'telegram', 'telegram:123'))?.threadPlatformId).toBe('plat-day');
  });

  it('does not rotate at the day boundary: a key recorded days ago still threads', async () => {
    const session = await taskSession();
    seedKey('ag-1', 'job-a-run-1', 'plat-root', new Date(Date.now() - 3 * DAY_MS).toISOString());
    insertChat('ag-1', session.id, 'out-1', { text: 'day 4, still red', threadKey: 'job-a-run-1' });
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: 'telegram:123:plat-root' }]);
  });

  it('is scoped per agent group: another group with the same key does not thread this one', async () => {
    const session = await taskSession();
    await createAgentGroup({ id: 'ag-2', name: 'Other', folder: 'other', agent_provider: null, created_at: now() });
    seedKey('ag-2', 'job-a-run-1', 'plat-other-group', now());
    insertChat('ag-1', session.id, 'out-1', { text: 'x', threadKey: 'job-a-run-1' });
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: null }]);
    expect(keyRows().map((r) => [r.agent_group_id, r.thread_platform_id])).toEqual([
      ['ag-1', 'plat-1'],
      ['ag-2', 'plat-other-group'],
    ]);
  });

  it('is scoped per adapter instance: a second instance on the same conversation keeps its own parent', async () => {
    await seedAgentAndChannel();
    await createMessagingGroup({
      id: 'mg-1b',
      channel_type: 'telegram',
      platform_id: 'telegram:123',
      instance: 'telegram-second-bot',
      name: 'Test Chat (second bot)',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    // Instance A (mg-1) already opened the key.
    seedKey('ag-1', 'job-a-run-1', 'plat-instance-a', now(), 'mg-1');
    // A session whose origin chat is instance B delivers through mg-1b (origin-first resolution).
    const { session } = await resolveSession('ag-1', 'mg-1b', null, 'shared');
    insertChat('ag-1', session.id, 'out-1', { text: 'x', threadKey: 'job-a-run-1' });
    const calls: Array<{ threadId: string | null; instance?: string }> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, threadId, _kind, _content, _files, instance) {
        calls.push({ threadId, instance });
        return 'plat-instance-b';
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: null, instance: 'telegram-second-bot' }]);
    expect(keyRows().map((r) => [r.messaging_group_id, r.thread_platform_id])).toEqual([
      ['mg-1', 'plat-instance-a'],
      ['mg-1b', 'plat-instance-b'],
    ]);
  });

  it('survives a recreated session: the key is held by the agent group, not the session', async () => {
    const first = await taskSession('series-1');
    insertChat('ag-1', first.id, 'out-1', { text: 'x', threadKey: 'job-a-run-1' });
    recordingAdapter();
    await deliverSessionMessages(first);

    const second = (await resolveTaskSession('ag-1', 'series-2')).session;
    insertChat('ag-1', second.id, 'out-2', { text: 'y', threadKey: 'job-a-run-1' });
    const calls = recordingAdapter();
    await deliverSessionMessages(second);

    expect(calls).toEqual([{ threadId: 'telegram:123:plat-1' }]);
  });

  it('a failed threaded post falls back to root and replaces the record', async () => {
    const session = await taskSession();
    seedKey('ag-1', 'job-a-run-1', 'plat-deleted', now());
    insertChat('ag-1', session.id, 'out-1', { text: 'x', threadKey: 'job-a-run-1' });
    const calls = recordingAdapter({ failThreaded: true });
    const warn = vi.spyOn(log, 'warn');

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: 'telegram:123:plat-deleted' }, { threadId: null }]);
    expect(keyRows().map((r) => r.thread_platform_id)).toEqual(['plat-2']);
    // Reported as a keyed fallback, not a day-anchor one: a keyed post is never task-anchor eligible.
    expect(warn).toHaveBeenCalledWith(
      'Threaded delivery under anchor failed — posting at root',
      expect.objectContaining({ taskAnchor: false, threadKey: 'job-a-run-1' }),
    );
    warn.mockRestore();
  });

  it('a transient threaded failure whose root fallback also throws keeps the existing record', async () => {
    const session = await taskSession();
    seedKey('ag-1', 'job-a-run-1', 'plat-root', now());
    insertChat('ag-1', session.id, 'out-1', { text: 'x', threadKey: 'job-a-run-1' });
    const calls = recordingAdapter();
    setDeliveryAdapter({
      async deliver(_ct, _pid, threadId) {
        calls.push({ threadId });
        throw new Error('network down');
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: 'telegram:123:plat-root' }, { threadId: null }]);
    expect(keyRows().map((r) => r.thread_platform_id)).toEqual(['plat-root']);
    expect(deliveredIds('ag-1', session.id).has('out-1')).toBe(false);
  });

  it('a failed threaded post whose root fallback returns no id leaves no dead record behind', async () => {
    const session = await taskSession();
    seedKey('ag-1', 'job-a-run-1', 'plat-deleted', now());
    insertChat('ag-1', session.id, 'out-1', { text: 'x', threadKey: 'job-a-run-1' });
    setDeliveryAdapter({
      async deliver(_ct, _pid, threadId) {
        if (threadId !== null) throw new Error('Unknown Channel');
        return undefined;
      },
    });

    await deliverSessionMessages(session);

    expect(keyRows()).toEqual([]);
  });

  it('a bookkeeping write that fails after the post landed is logged, and the message is not re-posted', async () => {
    const session = await taskSession();
    getRawDb().exec(
      "CREATE TRIGGER thread_key_anchors_refuse BEFORE INSERT ON thread_key_anchors BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    insertChat('ag-1', session.id, 'out-1', { text: 'x', threadKey: 'job-a-run-1' });
    const calls = recordingAdapter();
    const warn = vi.spyOn(log, 'warn');

    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: null }]);
    expect(deliveredIds('ag-1', session.id).has('out-1')).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      'Keyed thread anchor bookkeeping failed after delivery — the post stands',
      expect.objectContaining({ id: 'out-1', threadKey: 'job-a-run-1' }),
    );
    warn.mockRestore();
  });

  it('edit_message rows: the keyed root is edited at root, an in-thread message via the key, nothing recorded', async () => {
    const session = await taskSession();
    seedKey('ag-1', 'job-a-run-1', 'plat-root', now());
    const edit = (messageId: string) => ({ operation: 'edit', messageId, text: 'amended', threadKey: 'job-a-run-1' });
    insertChat('ag-1', session.id, 'out-1', edit('plat-root'), { ts: '2026-08-10T09:00:00.000Z' });
    insertChat('ag-1', session.id, 'out-2', edit('plat-in-thread'), { ts: '2026-08-10T09:00:01.000Z' });
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: null }, { threadId: 'telegram:123:plat-root' }]);
    expect(keyRows().map((r) => r.thread_platform_id)).toEqual(['plat-root']);
  });

  it('an explicit thread_id wins over a key: posted where addressed, anchor untouched', async () => {
    const session = await taskSession();
    const earlier = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    seedKey('ag-1', 'job-a-run-1', 'plat-root', earlier);
    insertChat('ag-1', session.id, 'out-1', { text: 'x', threadKey: 'job-a-run-1' }, { threadId: 'thr-9' });
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: 'thr-9' }]);
    expect(keyRows().map((r) => [r.thread_platform_id, r.last_used_at])).toEqual([['plat-root', earlier]]);
  });

  it('a malformed key is ignored and the row delivers exactly as an unkeyed one (day anchor)', async () => {
    const session = await taskSession();
    await setTaskThreadAnchor(session.id, 'telegram', 'telegram:123', 'plat-day', now());
    insertChat('ag-1', session.id, 'out-1', { text: 'x', threadKey: 'has space' });
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: 'telegram:123:plat-day' }]);
    expect(keyRows()).toEqual([]);
  });

  it('unkeyed task posts never touch thread_key_anchors', async () => {
    const session = await taskSession();
    insertChat('ag-1', session.id, 'out-1', { text: 'x' });
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: null }]);
    expect((await getTaskThreadAnchor(session.id, 'telegram', 'telegram:123'))?.threadPlatformId).toBe('plat-1');
    expect(keyRows()).toEqual([]);
  });

  it("a keyed root in an interactive turn does not become that turn's anchor", async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertChat(
      'ag-1',
      session.id,
      'out-1',
      { text: 'incident', threadKey: 'inc-1' },
      {
        ts: '2026-08-10T09:00:00.000Z',
        inReplyTo: 'turn-A',
      },
    );
    insertChat(
      'ag-1',
      session.id,
      'out-2',
      { text: 'unrelated' },
      { ts: '2026-08-10T09:00:01.000Z', inReplyTo: 'turn-A' },
    );
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: null }, { threadId: null }]);
  });

  it('a key unused past the retention window is a new incident, and recording prunes stale keys', async () => {
    const session = await taskSession();
    seedKey('ag-1', 'job-a-run-1', 'plat-ancient', new Date(Date.now() - 31 * DAY_MS).toISOString());
    seedKey('ag-1', 'job-z-stale', 'plat-stale', new Date(Date.now() - 31 * DAY_MS).toISOString());
    const recent = new Date(Date.now() - 29 * DAY_MS).toISOString();
    seedKey('ag-1', 'job-y-recent', 'plat-recent', recent);
    insertChat('ag-1', session.id, 'out-1', { text: 'x', threadKey: 'job-a-run-1' });
    const calls = recordingAdapter();

    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId: null }]);
    expect(keyRows().map((r) => [r.thread_key, r.thread_platform_id])).toEqual([
      ['job-a-run-1', 'plat-1'],
      ['job-y-recent', 'plat-recent'],
    ]);
  });

  it('two sessions of one group posting the same new key concurrently make exactly one root', async () => {
    const a = await taskSession('series-1');
    const b = (await resolveTaskSession('ag-1', 'series-2')).session;
    insertChat('ag-1', a.id, 'out-a', { text: 'a', threadKey: 'job-a-run-1' });
    insertChat('ag-1', b.id, 'out-b', { text: 'b', threadKey: 'job-a-run-1' });
    const calls: Array<{ threadId: string | null }> = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => (firstEntered = resolve));
    setDeliveryAdapter({
      async deliver(_ct, _pid, threadId) {
        calls.push({ threadId });
        if (calls.length === 1) {
          firstEntered();
          await firstHeld;
        }
        return `plat-${calls.length}`;
      },
    });

    const drains = Promise.all([deliverSessionMessages(a), deliverSessionMessages(b)]);
    await firstStarted;
    // Release the first post only once the other session is observably queued on
    // the key's lock. A timeout fails loudly instead of falling through to a pass.
    const deadline = Date.now() + 5_000;
    while (_threadKeyLockWaitersForTest() !== 1) {
      if (Date.now() > deadline) throw new Error('second session never queued on the thread-key lock');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(calls).toHaveLength(1);
    releaseFirst();
    await drains;

    expect(calls).toEqual([{ threadId: null }, { threadId: 'telegram:123:plat-1' }]);
    expect(keyRows().map((r) => r.thread_platform_id)).toEqual(['plat-1']);
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

// `session-manager`'s ids-addressed inbound opener went away with the mailbox
// seam's raw wrappers (PR 7). Production code opens sessions through the seam;
// this fixture still wants a plain handle on a named session's file, which is
// the module's own path-addressed funnel plus the layout helper.
function openInboundDb(agentGroupId: string, sessionId: string): Database.Database {
  return openInboundDbAt(inboundDbPath(agentGroupId, sessionId));
}

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
  beforeEach(async () => {
    _resetQuietDeliveryCacheForTest();
    await seedAgentAndChannel();
  });

  it('A6 never arms for a session left holding an undelivered row', async () => {
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    // The drain reads `delivered` for every swept session, not just ones with
    // due rows, so a corrupt session DB has a wide blast radius. It must cost
    // that session, not the whole sweep.
    //
    // The fixture is a corrupt FILE, not a dropped table: since the drain went
    // through the mailbox seam, opening a session runs the fork's schema
    // ensure first, so a missing `delivered` table is recreated rather than
    // raised. Unreadable now means the bytes are not a database at all.
    await createMessagingGroup({
      id: 'mg-2',
      channel_type: 'telegram',
      platform_id: 'telegram:456',
      name: 'Second Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    const { session: broken } = await resolveSession('ag-1', 'mg-2', null, 'shared');
    const { session: healthy } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', healthy.id, 'out-ok');
    fs.writeFileSync(inboundDbPath('ag-1', broken.id), 'this is not a sqlite database');

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
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
  beforeEach(async () => {
    _resetQuietDeliveryCacheForTest();
    await seedAgentAndChannel();
  });

  it('A14 delivers by the backoff deadline even when the change signal never moves', async () => {
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
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

/**
 * The drain loop is serial across sessions, so anything a system-action handler
 * awaits inline stalls delivery for the whole host — `cycleMs=172606 polled=2`
 * on 2026-09-01, while one repository publication waited for sibling containers
 * to reach a mount barrier. Detaching that work (see
 * modules/repository-workspaces/job-runner.ts) rests on two properties of the
 * `deferAck` contract, neither of which was pinned by a test.
 */
describe('deliverSessionMessages — deferAck system actions', () => {
  function insertAt(sessionId: string, msgId: string, timestamp: string, kind: string, content: object): void {
    const db = new Database(outboundDbPath('ag-1', sessionId));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      msgId,
      timestamp,
      kind,
      kind === 'system' ? null : 'telegram:123',
      kind === 'system' ? null : 'telegram',
      JSON.stringify(content),
    );
    db.close();
  }

  it('does not hold the rest of the queue behind a deferred action, and stays pending', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    registerDeliveryAction(
      'test_defer_ack',
      async () => ({ deferAck: true }) as const,
      unguarded('test-only action that defers its own ack'),
    );

    insertAt(session.id, 'out-deferred', '2026-09-01T00:00:01.000Z', 'system', { action: 'test_defer_ack' });
    insertAt(session.id, 'out-after', '2026-09-01T00:00:02.000Z', 'chat', { text: 'chat must not wait' });

    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(content);
        return 'plat-1';
      },
    });

    const outcome = await deliverSessionMessages(session);

    // The chat row behind the deferred action went out on the same pass.
    expect(delivered).toEqual([JSON.stringify({ text: 'chat must not wait' })]);
    // The deferred row is still outstanding: its handler owns that `delivered`
    // row, so the drain must report pending and never arm the quiet gate.
    const inDb = openInboundDb('ag-1', session.id);
    const ids = getDeliveredIds(inDb);
    inDb.close();
    expect(ids.has('out-deferred')).toBe(false);
    expect(ids.has('out-after')).toBe(true);
    expect(outcome).toBe('pending');
  });

  it('keeps lifecycle state for deferred and internal system actions', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    registerDeliveryAction(
      'test_defer_without_public_delivery',
      async () => ({ deferAck: true }) as const,
      unguarded('test-only deferred internal action'),
    );
    registerDeliveryAction(
      'test_internal_delivery_action',
      async () => undefined,
      unguarded('test-only completed internal action'),
    );

    const deletes: string[] = [];
    setDeliveryAdapter({
      async deliver() {
        return 'plat-working';
      },
      async deleteMessage(_channelType, _platformId, _threadId, messageId) {
        deletes.push(messageId);
      },
    });
    insertOutboundKind('ag-1', session.id, 'working', 'status', 'telegram', 'telegram:123', {
      text: 'Accepted · working',
      reporting: { version: 1, purpose: 'liveness', state: 'working' },
    });
    await deliverSessionMessages(session);

    insertAt(session.id, 'deferred', '2026-09-01T00:00:02.000Z', 'system', {
      action: 'test_defer_without_public_delivery',
    });
    insertAt(session.id, 'internal', '2026-09-01T00:00:03.000Z', 'system', {
      action: 'test_internal_delivery_action',
    });
    await deliverSessionMessages(session);

    expect(deletes).toEqual([]);
  });
});

/**
 * Mailbox seam, PR 3 (plan §4.5b, invariants I-8 and I-9).
 *
 * The drain loop now reads due rows in one mailbox session, CLOSES it, invokes
 * the handler with no session open, then opens a short session to write the
 * ack. Two things have to stay true through that rearrangement: a handler may
 * write to the very session it is delivering for (the `spawn_cancel` shape),
 * and a row that carries no thread origin still posts at the channel root.
 */
describe('delivery through the mailbox seam', () => {
  function insertSystemAction(sessionId: string, msgId: string, action: string): void {
    const db = new Database(outboundDbPath('ag-1', sessionId));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, datetime('now'), 'system', NULL, NULL, ?)`,
    ).run(msgId, JSON.stringify({ action }));
    db.close();
  }

  function deliveredStatus(sessionId: string, msgId: string): string | undefined {
    const db = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
    try {
      return (
        db.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get(msgId) as { status: string } | undefined
      )?.status;
    } finally {
      db.close();
    }
  }

  function inboundHas(sessionId: string, messageId: string): boolean {
    const db = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
    try {
      return db.prepare('SELECT 1 FROM messages_in WHERE id = ?').get(messageId) !== undefined;
    } finally {
      db.close();
    }
  }

  /** Every warn/error the drain logged, flattened so a nesting throw cannot hide in a nested field. */
  function loggedText(warn: ReturnType<typeof vi.spyOn>, error: ReturnType<typeof vi.spyOn>): string {
    return [...warn.mock.calls, ...error.mock.calls]
      .map((args) => args.map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a, replaceErrors))).join(' '))
      .join('\n');
  }

  function replaceErrors(_key: string, value: unknown): unknown {
    return value instanceof Error ? `${value.name}: ${value.message}` : value;
  }

  /** System actions are only dispatched once an adapter is configured. */
  function setNoopAdapter(): void {
    setDeliveryAdapter({
      async deliver() {
        return 'plat-noop';
      },
    });
  }

  it('a delivery action handler that writes to its own session succeeds and the action is acked', async () => {
    await seedAgentAndChannel();
    setNoopAdapter();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

    // The handler does what `spawn_cancel` does — writes an inbound row for a
    // session through the ordinary writer — and, on top of that, opens a
    // mailbox session on the DELIVERING key, which is the open the loop used
    // to be holding across the handler.
    registerDeliveryAction(
      'test_writes_own_session',
      async (_content, s) => {
        await writeSessionMessage(s.agent_group_id, s.id, {
          id: 'handler-write-1',
          kind: 'system',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({ note: 'written from inside the handler' }),
        });
        await withMailboxSession(s.agent_group_id, s.id, (m) => m.countDueMessages());
        return undefined;
      },
      unguarded('test-only action that writes to its own session'),
    );

    insertSystemAction(session.id, 'out-own-write', 'test_writes_own_session');

    const warn = vi.spyOn(log, 'warn');
    const error = vi.spyOn(log, 'error');
    try {
      const outcome = await deliverSessionMessages(session);

      expect(loggedText(warn, error)).not.toMatch(/Nested mailbox session/);
      expect(inboundHas(session.id, 'handler-write-1')).toBe(true);
      expect(deliveredStatus(session.id, 'out-own-write')).toBe('delivered');
      expect(outcome).toBe('clean');
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('a deferAck handler that writes to its own session leaves the delivered row to itself', async () => {
    await seedAgentAndChannel();
    setNoopAdapter();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

    registerDeliveryAction(
      'test_writes_own_session_defer',
      async (_content, s) => {
        await writeSessionMessage(s.agent_group_id, s.id, {
          id: 'handler-write-2',
          kind: 'system',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({ note: 'deferred handler write' }),
        });
        return { deferAck: true } as const;
      },
      unguarded('test-only deferring action that writes to its own session'),
    );

    insertSystemAction(session.id, 'out-own-write-defer', 'test_writes_own_session_defer');

    const warn = vi.spyOn(log, 'warn');
    const error = vi.spyOn(log, 'error');
    try {
      const outcome = await deliverSessionMessages(session);

      expect(loggedText(warn, error)).not.toMatch(/Nested mailbox session/);
      expect(inboundHas(session.id, 'handler-write-2')).toBe(true);
      // The outer loop must not have touched `delivered` — the handler owns it.
      expect(deliveredStatus(session.id, 'out-own-write-defer')).toBeUndefined();
      expect(outcome).toBe('pending');
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('an outbound row with no thread origin is delivered top-level', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

    // No thread_id and no in_reply_to: nothing anchors this row to a thread,
    // so it must post at the channel root rather than being held or dropped.
    insertOutboundKind(
      'ag-1',
      session.id,
      'out-orphan',
      'chat',
      'telegram',
      'telegram:123',
      { text: 'orphan' },
      null,
      null,
    );

    const threadIds: Array<string | null | undefined> = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, threadId, _kind, _content) {
        threadIds.push(threadId);
        return 'plat-orphan';
      },
    });

    const outcome = await deliverSessionMessages(session);

    expect(threadIds).toEqual([null]);
    expect(deliveredStatus(session.id, 'out-orphan')).toBe('delivered');
    expect(outcome).toBe('clean');
  });
});

describe('deliverSessionMessages — ask_question ids', () => {
  const ask = (questionId: string) => ({
    type: 'ask_question',
    questionId,
    title: 'FYI',
    question: 'Nothing to do here',
    options: [{ label: 'Dismiss', value: 'approve' }],
  });

  function recordDeliveries(): string[] {
    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'plat-ask';
      },
    });
    return calls;
  }

  it('refuses one that reuses a pending approval id: no card, no pending question, not retried', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    await createPendingApproval({
      approval_id: 'appr-collide',
      request_id: 'appr-collide',
      action: 'install_packages',
      payload: '{}',
      created_at: now(),
      title: 'Install packages?',
      options_json: '[]',
      session_id: session.id,
      agent_group_id: 'ag-1',
      platform_message_id: 'real-card',
    });
    insertOutboundKind('ag-1', session.id, 'out-ask', 'chat-sdk', 'telegram', 'telegram:123', ask('appr-collide'));
    const calls = recordDeliveries();

    await deliverSessionMessages(session);

    expect(calls).toEqual([]);
    expect(await getPendingQuestion('appr-collide')).toBeUndefined();
    expect((await getPendingApproval('appr-collide'))?.status).toBe('pending');
    const inDb = openInboundDb('ag-1', session.id);
    const delivered = getDeliveredIds(inDb);
    inDb.close();
    expect(delivered.has('out-ask')).toBe(true);
  });

  it('refuses one whose id a click would decode onto a pending approval, delimiter and all', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    await createPendingApproval({
      approval_id: 'appr-suffix',
      request_id: 'appr-suffix',
      action: 'install_packages',
      payload: '{}',
      created_at: now(),
      title: 'Install packages?',
      options_json: '[]',
      session_id: session.id,
      agent_group_id: 'ag-1',
      platform_message_id: 'real-card',
    });
    // Written whole, so an exact-match check misses it; both click parsers cut
    // at the first ':' and hand the handlers `appr-suffix`.
    insertOutboundKind('ag-1', session.id, 'out-ask', 'chat-sdk', 'telegram', 'telegram:123', ask('appr-suffix:1'));
    const calls = recordDeliveries();

    await deliverSessionMessages(session);

    expect(calls).toEqual([]);
    expect(await getPendingQuestion('appr-suffix:1')).toBeUndefined();
    expect((await getPendingApproval('appr-suffix'))?.status).toBe('pending');
  });

  it('refuses one whose id carries a delimiter even when it collides with nothing', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutboundKind('ag-1', session.id, 'out-ask', 'chat-sdk', 'telegram', 'telegram:123', ask('q-agent:2'));
    const calls = recordDeliveries();

    await deliverSessionMessages(session);

    // The card would be undecodable anyway: a click resolves `q-agent`, and
    // pending_questions is keyed by the whole id.
    expect(calls).toEqual([]);
    expect(await getPendingQuestion('q-agent:2')).toBeUndefined();
  });

  it('delivers one whose id names no pending approval, and records its pending question', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutboundKind('ag-1', session.id, 'out-ask', 'chat-sdk', 'telegram', 'telegram:123', ask('q-agent-1'));
    const calls = recordDeliveries();

    await deliverSessionMessages(session);

    expect(calls).toHaveLength(1);
    expect(await getPendingQuestion('q-agent-1')).toMatchObject({ session_id: session.id, message_out_id: 'out-ask' });
  });

  it('clears lifecycle state only after an ask_question card is delivered', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    const events: string[] = [];
    let posts = 0;
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, kind) {
        posts += 1;
        events.push(`post:${kind}`);
        return posts === 1 ? 'plat-working' : 'plat-question';
      },
      async deleteMessage(_channelType, _platformId, _threadId, messageId) {
        events.push(`delete:${messageId}`);
      },
    });
    insertOutboundKind('ag-1', session.id, 'working', 'status', 'telegram', 'telegram:123', {
      text: 'Accepted · working',
      reporting: { version: 1, purpose: 'liveness', state: 'working' },
    });
    await deliverSessionMessages(session);
    insertOutboundKind('ag-1', session.id, 'out-ask', 'chat-sdk', 'telegram', 'telegram:123', ask('q-agent-2'));

    await deliverSessionMessages(session);

    expect(posts).toBe(2);
    expect(events).toEqual(['post:status', 'post:chat-sdk', 'delete:plat-working']);
    expect(await getPendingQuestion('q-agent-2')).toMatchObject({ session_id: session.id, message_out_id: 'out-ask' });
  });

  it('keeps lifecycle state when an ask_question card fails to post', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    const events: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, kind) {
        events.push(`post:${kind}`);
        if (kind === 'chat-sdk') throw new Error('card rejected');
        return 'plat-working';
      },
      async deleteMessage(_channelType, _platformId, _threadId, messageId) {
        events.push(`delete:${messageId}`);
      },
    });
    insertOutboundKind('ag-1', session.id, 'working', 'status', 'telegram', 'telegram:123', {
      text: 'Accepted · working',
      reporting: { version: 1, purpose: 'liveness', state: 'working' },
    });
    await deliverSessionMessages(session);
    insertOutboundKind('ag-1', session.id, 'out-ask', 'chat-sdk', 'telegram', 'telegram:123', ask('q-agent-3'));

    await deliverSessionMessages(session);

    expect(events).toEqual(['post:status', 'post:chat-sdk']);
    const inbound = openInboundDb('ag-1', session.id);
    expect(
      inbound.prepare('SELECT lifecycle_terminal_at FROM delivered WHERE message_out_id = ?').get('working'),
    ).toEqual({ lifecycle_terminal_at: null });
    inbound.close();
  });
});

describe('per-work-item outcome delivery', () => {
  async function prepare() {
    await seedAgentAndChannel();
    getRawDb().prepare('INSERT INTO workgroups (id,created_at) VALUES (?,?)').run('outcomes', now());
    getRawDb().prepare('UPDATE agent_groups SET workgroup_id=? WHERE id=?').run('outcomes', 'ag-1');
    fs.mkdirSync(`${TEST_DIR}/groups/test-agent`, { recursive: true });
    fs.writeFileSync(`${TEST_DIR}/groups/test-agent/container.json`, JSON.stringify({ outcomeReporting: true }));
    return (await resolveSession('ag-1', 'mg-1', null, 'shared')).session;
  }
  async function outcome(workItem = 'https://github.com/Example-org/Checkout/pull/17') {
    const { renderWorkOutcome } = await import('./outcome-reporting-schema.js');
    const summary = 'The checkout fix merged to develop.';
    const data = {
      workItem,
      verified: 'Post-merge checks passed.',
      evidence: 'https://github.com/Example-org/Checkout/pull/17',
    };
    return {
      text: renderWorkOutcome(summary, data).text,
      reporting: { version: 1, purpose: 'outcome', summary, outcome: data },
    };
  }

  function opaqueOutcome(
    agentGroupId: string,
    sessionId: string,
    sequence: number,
    platformMessageId: string,
    sourceRoute = { channelType: 'telegram', platformId: 'telegram:123' },
    summary = 'The requested work is complete.',
    sourceContent: Record<string, unknown> = {},
  ): { text: string; reporting: object } {
    const inbound = openInboundDbAt(inboundDbPath(agentGroupId, sessionId));
    const rowId = `${platformMessageId}:${agentGroupId}`;
    inbound
      .prepare(
        `INSERT INTO messages_in
         (id,seq,kind,timestamp,status,trigger,platform_id,channel_type,content)
         VALUES (?,?, 'chat', ?, 'completed', 1, ?, ?, ?)`,
      )
      .run(
        rowId,
        sequence,
        now(),
        sourceRoute.platformId,
        sourceRoute.channelType,
        JSON.stringify({ text: 'Do the work', platformMsgId: platformMessageId, ...sourceContent }),
      );
    inbound.close();
    const data = { requestId: sequence, verified: 'Focused checks passed.' };
    const trusted = {
      sessionId,
      messageId: rowId,
      sequence,
      origin: { ...sourceRoute, platformMessageId },
    };
    return {
      text: renderWorkOutcome(summary, data, trusted).text,
      reporting: { version: 1, purpose: 'outcome', summary, outcome: data },
    };
  }

  it('retains routine records without platform calls and preserves legacy human replies and native questions', async () => {
    const session = await prepare();
    const deliver = vi.fn().mockResolvedValue('question-or-reply');
    setDeliveryAdapter({ deliver });
    insertOutboundKind('ag-1', session.id, 'internal', 'work_log', 'telegram', 'telegram:123', {
      text: 'Checking again',
    });
    insertOutboundKind('ag-1', session.id, 'progress', 'status', 'telegram', 'telegram:123', {
      text: 'Thinking',
      reporting: { version: 1, purpose: 'progress' },
    });
    await deliverSessionMessages(session);
    expect(deliver).not.toHaveBeenCalled();
    insertOutboundKind('ag-1', session.id, 'legacy-human', 'chat', 'telegram', 'telegram:123', {
      text: 'Answer from an older runner',
    });
    insertOutboundKind('ag-1', session.id, 'question', 'chat-sdk', 'telegram', 'telegram:123', {
      type: 'ask_question',
      questionId: 'q-outcome',
      title: 'Choose scope',
      question: 'Which product scope?',
      text: 'Interactive card payload, not an assistant chat reply.',
      options: ['A', 'B'],
    });
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(getRawDb().prepare('SELECT last_outbound_at FROM sessions WHERE id=?').get(session.id)).toBeTruthy();
    const archive = new Database(`${TEST_DIR}/archive.db`, { readonly: true });
    try {
      expect(archive.prepare('SELECT id FROM messages_archive WHERE id = ?').get('legacy-human')).toEqual({
        id: 'legacy-human',
      });
      expect(archive.prepare('SELECT id FROM messages_archive WHERE id = ?').get('question')).toBeUndefined();
    } finally {
      archive.close();
    }
  });

  it('dedupes normalized work items across concurrent sibling sessions and later replay', async () => {
    const first = await prepare();
    await createAgentGroup({
      id: 'ag-2',
      name: 'Sibling',
      folder: 'sibling',
      agent_provider: null,
      workgroup_id: 'outcomes',
      created_at: now(),
    });
    const second = (await resolveSession('ag-2', 'mg-1', null, 'shared')).session;
    const deliver = vi.fn().mockResolvedValue('platform-outcome');
    setDeliveryAdapter({ deliver });
    insertOutboundKind('ag-1', first.id, 'outcome-a', 'chat', 'telegram', 'telegram:123', await outcome());
    insertOutboundKind(
      'ag-2',
      second.id,
      'outcome-b',
      'chat',
      'telegram',
      'telegram:123',
      await outcome('https://github.com/example-ORG/checkout/pull/17?presentation=1'),
    );
    await Promise.all([deliverSessionMessages(first), deliverSessionMessages(second)]);
    const owner = getRawDb().prepare('SELECT session_id FROM work_outcome_receipts').get() as { session_id: string };
    const sibling = owner.session_id === first.id ? second : first;
    // The non-owner's conflicting result remains retryable for three delivery
    // attempts, then becomes a truthful failed row instead of a false ACK.
    await deliverSessionMessages(sibling);
    await deliverSessionMessages(sibling);
    insertOutboundKind('ag-2', second.id, 'outcome-replay', 'chat', 'telegram', 'telegram:123', await outcome());
    // A replay from the owner records the existing receipt immediately; a
    // replay from the sibling exhausts the same recoverable ownership conflict.
    await deliverSessionMessages(second);
    await deliverSessionMessages(second);
    await deliverSessionMessages(second);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(getRawDb().prepare('SELECT state,platform_message_id FROM work_outcome_receipts').all()).toEqual([
      { state: 'delivered', platform_message_id: 'platform-outcome' },
    ]);
    // A later real correction is not swallowed by the terminal receipt.
    insertOutboundKind('ag-2', second.id, 'correction', 'chat', 'telegram', 'telegram:123', {
      text: 'Rollback: post-merge verification was wrong.',
      reporting: { version: 1, purpose: 'urgent' },
    });
    await deliverSessionMessages(second);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('dedupes one trusted platform request but reports a different sibling outcome as unpublished', async () => {
    const first = await prepare();
    await createAgentGroup({
      id: 'ag-2',
      name: 'Sibling',
      folder: 'sibling',
      agent_provider: null,
      workgroup_id: 'outcomes',
      created_at: now(),
    });
    const second = (await resolveSession('ag-2', 'mg-1', null, 'shared')).session;
    const deliver = vi.fn().mockResolvedValue('one-platform-outcome');
    setDeliveryAdapter({ deliver });
    insertOutboundKind(
      'ag-1',
      first.id,
      'opaque-a',
      'chat',
      'telegram',
      'telegram:123',
      opaqueOutcome('ag-1', first.id, 2, 'platform-request-1'),
    );
    insertOutboundKind(
      'ag-2',
      second.id,
      'opaque-b',
      'chat',
      'telegram',
      'telegram:123',
      opaqueOutcome(
        'ag-2',
        second.id,
        8,
        'platform-request-1',
        { channelType: 'telegram', platformId: 'telegram:123' },
        'The sibling completed a different authorized slice.',
      ),
    );
    await deliverSessionMessages(first);
    await deliverSessionMessages(second);
    await deliverSessionMessages(second);
    await deliverSessionMessages(second);
    expect(deliver).toHaveBeenCalledTimes(1);
    const receipt = getRawDb().prepare('SELECT work_item,state FROM work_outcome_receipts').get() as {
      work_item: string;
      state: string;
    };
    expect(receipt.work_item).toMatch(/^request:v1:[0-9a-f]{64}$/);
    expect(receipt.state).toBe('delivered');
    const siblingInbound = openInboundDb('ag-2', second.id);
    expect(
      siblingInbound.prepare('SELECT status,error FROM delivered WHERE message_out_id = ?').get('opaque-b'),
    ).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('another agent owns the existing receipt'),
    });
    siblingInbound.close();
  });

  it('rejects an opaque outcome keyed to an agent-authored inbound row', async () => {
    const session = await prepare();
    const deliver = vi.fn().mockResolvedValue('must-not-deliver');
    setDeliveryAdapter({ deliver });
    insertOutboundKind(
      'ag-1',
      session.id,
      'agent-keyed-outcome',
      'chat',
      'telegram',
      'telegram:123',
      opaqueOutcome('ag-1', session.id, 2, 'agent-handoff-1', {
        channelType: 'agent',
        platformId: 'agent:peer',
      }),
    );
    await deliverSessionMessages(session);
    expect(deliver).not.toHaveBeenCalled();
    expect(getRawDb().prepare('SELECT COUNT(*) AS count FROM work_outcome_receipts').get()).toEqual({ count: 0 });
  });

  it('rejects an opaque outcome from a trusted bot author even when flat sender fields look human', async () => {
    const session = await prepare();
    const deliver = vi.fn().mockResolvedValue('must-not-deliver');
    setDeliveryAdapter({ deliver });
    insertOutboundKind(
      'ag-1',
      session.id,
      'bot-keyed-outcome',
      'chat',
      'telegram',
      'telegram:123',
      opaqueOutcome(
        'ag-1',
        session.id,
        2,
        'platform-bot-1',
        { channelType: 'telegram', platformId: 'telegram:123' },
        'The automated request is complete.',
        { sender: 'Operator', senderId: 'U1', author: { isBot: true } },
      ),
    );

    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    expect(deliver).not.toHaveBeenCalled();
    expect(getRawDb().prepare('SELECT COUNT(*) AS count FROM work_outcome_receipts').get()).toEqual({ count: 0 });
    const inbound = openInboundDb('ag-1', session.id);
    expect(
      inbound.prepare('SELECT status,error FROM delivered WHERE message_out_id = ?').get('bot-keyed-outcome'),
    ).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('not an original human request'),
    });
    inbound.close();
  });

  it('gives unrelated scheduled work outcomes independent roots instead of the daily task thread', async () => {
    await prepare();
    const session = (await resolveTaskSession('ag-1', 'outcome-series')).session;
    // Scheduled tasks retain the existing destination permission requirement.
    getRawDb()
      .prepare(
        "INSERT OR IGNORE INTO agent_destinations (agent_group_id,local_name,target_type,target_id,created_at) VALUES ('ag-1','test','channel','mg-1',?)",
      )
      .run(now());
    const deliver = vi.fn().mockResolvedValueOnce('first-item').mockResolvedValueOnce('second-item');
    setDeliveryAdapter({ deliver });
    insertOutboundKind(
      'ag-1',
      session.id,
      'item-one',
      'chat',
      'telegram',
      'telegram:123',
      await outcome(),
      null,
      'fire-one',
    );
    insertOutboundKind(
      'ag-1',
      session.id,
      'item-two',
      'chat',
      'telegram',
      'telegram:123',
      await outcome('https://github.com/Example-org/Checkout/pull/18'),
      null,
      'fire-two',
    );
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.map((call) => call[2])).toEqual([null, null]);
  });

  it('accepts an admitted task occurrence as a host-validated opaque outcome root', async () => {
    await prepare();
    const session = (await resolveTaskSession('ag-1', 'opaque-task-series')).session;
    getRawDb()
      .prepare(
        "INSERT OR IGNORE INTO agent_destinations (agent_group_id,local_name,target_type,target_id,created_at) VALUES ('ag-1','test','channel','mg-1',?)",
      )
      .run(now());
    const inbound = openInboundDbAt(inboundDbPath('ag-1', session.id));
    inbound
      .prepare(
        `INSERT INTO messages_in
         (id,seq,kind,timestamp,status,trigger,platform_id,channel_type,content)
         VALUES ('opaque-task-occurrence',22,'task',?,'completed',1,NULL,NULL,?)`,
      )
      .run(now(), JSON.stringify({ prompt: 'Run the scheduled audit.' }));
    inbound.close();
    const data = { requestId: 22, verified: 'Focused checks passed.' };
    const rendered = renderWorkOutcome('The scheduled audit is complete.', data, {
      sessionId: session.id,
      messageId: 'opaque-task-occurrence',
      sequence: 22,
    });
    insertOutboundKind(
      'ag-1',
      session.id,
      'opaque-task-outcome',
      'chat',
      'telegram',
      'telegram:123',
      {
        text: rendered.text,
        reporting: {
          version: 1,
          purpose: 'outcome',
          summary: 'The scheduled audit is complete.',
          outcome: data,
        },
      },
      null,
      'opaque-task-occurrence',
    );
    const deliver = vi.fn().mockResolvedValue('opaque-task-platform-message');
    setDeliveryAdapter({ deliver });

    await deliverSessionMessages(session);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(getRawDb().prepare('SELECT work_item,state,platform_message_id FROM work_outcome_receipts').get()).toEqual({
      work_item: rendered.key,
      state: 'delivered',
      platform_message_id: 'opaque-task-platform-message',
    });
  });

  it('holds an ambiguous platform result across replay, without acknowledging success or retrying', async () => {
    const session = await prepare();
    const deliver = vi.fn().mockRejectedValue(new Error('response lost after acceptance'));
    setDeliveryAdapter({ deliver });
    insertOutboundKind('ag-1', session.id, 'unknown', 'chat', 'telegram', 'telegram:123', await outcome());
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    insertOutboundKind('ag-1', session.id, 'unknown-copy', 'chat', 'telegram', 'telegram:123', await outcome());
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(getRawDb().prepare('SELECT state FROM work_outcome_receipts').get()).toEqual({ state: 'uncertain' });
    expect(getDeliveredIds(openInboundDb('ag-1', session.id)).has('unknown')).toBe(false);
  });

  it('preserves legacy status and acknowledges successful adapter return without an id', async () => {
    const session = await prepare();
    const deliver = vi.fn().mockResolvedValue(undefined);
    setDeliveryAdapter({ deliver });
    insertOutboundKind('ag-1', session.id, 'old-status', 'status', 'telegram', 'telegram:123', {
      text: 'Legacy status',
    });
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(1);
    insertOutboundKind('ag-1', session.id, 'no-id', 'chat', 'telegram', 'telegram:123', await outcome());
    await deliverSessionMessages(session);
    insertOutboundKind('ag-1', session.id, 'no-id-copy', 'chat', 'telegram', 'telegram:123', await outcome());
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(getDeliveredIds(openInboundDb('ag-1', session.id)).has('no-id')).toBe(true);
    expect(getRawDb().prepare('SELECT state,platform_message_id FROM work_outcome_receipts').get()).toEqual({
      state: 'delivered',
      platform_message_id: null,
    });
  });

  it('keeps old untyped status public, suppresses typed progress without a lifecycle line, and recovers typed liveness', async () => {
    const session = await prepare();
    const deliver = vi
      .fn()
      .mockResolvedValueOnce('legacy-status')
      .mockResolvedValueOnce('lifecycle-status')
      .mockResolvedValue(undefined);
    setDeliveryAdapter({ deliver });
    insertOutboundKind('ag-1', session.id, 'legacy', 'status', 'telegram', 'telegram:123', { text: 'Legacy status' });
    insertOutboundKind('ag-1', session.id, 'narration', 'status', 'telegram', 'telegram:123', {
      text: 'Model narration',
      reporting: { version: 1, purpose: 'progress' },
    });
    insertOutboundKind('ag-1', session.id, 'lifecycle', 'status', 'telegram', 'telegram:123', {
      text: 'Accepted · working',
      reporting: { version: 1, purpose: 'liveness', state: 'working' },
    });
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(2);
    _resetStatusTrackingForTest();
    insertOutboundKind('ag-1', session.id, 'ended', 'system', null as never, null as never, {
      action: 'turn_end',
      lifecycleStatusId: 'lifecycle',
    });
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(JSON.parse(deliver.mock.calls[2][4])).toMatchObject({
      operation: 'edit',
      messageId: 'lifecycle-status',
      text: 'Stopped before sending a reply.',
    });
  });

  it('edits one recovered lifecycle line for repeated progress and removes it when the permanent reply lands', async () => {
    const session = await prepare();
    const deliver = vi
      .fn()
      .mockResolvedValueOnce('lifecycle-status')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('public-reply');
    const deleteMessage = vi.fn().mockResolvedValue(undefined);
    setDeliveryAdapter({ deliver, deleteMessage });
    insertOutboundKind(
      'ag-1',
      session.id,
      'lifecycle',
      'status',
      'telegram',
      'telegram:123',
      { text: 'Accepted · working', reporting: { version: 1, purpose: 'liveness', state: 'working' } },
      null,
      'human-request-1',
    );
    await deliverSessionMessages(session);

    _resetStatusTrackingForTest();
    insertOutboundKind(
      'ag-1',
      session.id,
      'wrong-turn-progress',
      'status',
      'telegram',
      'telegram:123',
      { text: '> 💭 Belongs to another turn.', reporting: { version: 1, purpose: 'progress' } },
      null,
      'human-request-2',
    );
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(1);

    _resetStatusTrackingForTest();
    insertOutboundKind(
      'ag-1',
      session.id,
      'wrong-thread-progress',
      'status',
      'telegram',
      'telegram:123',
      { text: '> 💭 Belongs to another thread.', reporting: { version: 1, purpose: 'progress' } },
      'other-thread',
      'human-request-1',
    );
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(1);

    _resetStatusTrackingForTest();
    insertOutboundKind(
      'ag-1',
      session.id,
      'progress-1',
      'status',
      'telegram',
      'telegram:123',
      { text: '> 💭 Inspecting the delivery path.', reporting: { version: 1, purpose: 'progress' } },
      null,
      'human-request-1',
    );
    insertOutboundKind(
      'ag-1',
      session.id,
      'progress-2',
      'status',
      'telegram',
      'telegram:123',
      { text: '> 🔧 Running focused checks.', reporting: { version: 1, purpose: 'progress' } },
      null,
      'human-request-1',
    );
    await deliverSessionMessages(session);
    insertOutboundKind(
      'ag-1',
      session.id,
      'reply',
      'chat',
      'telegram',
      'telegram:123',
      { text: 'The requested answer.', reporting: { version: 1, purpose: 'reply' } },
      null,
      'human-request-1',
    );
    await deliverSessionMessages(session);

    expect(deliver).toHaveBeenCalledTimes(4);
    expect(JSON.parse(deliver.mock.calls[0]![4])).toEqual({
      text: 'Accepted · working',
      reporting: { version: 1, purpose: 'liveness', state: 'working' },
    });
    expect(JSON.parse(deliver.mock.calls[1]![4])).toEqual({
      operation: 'edit',
      messageId: 'lifecycle-status',
      text: '> 💭 Inspecting the delivery path.',
    });
    expect(JSON.parse(deliver.mock.calls[2]![4])).toEqual({
      operation: 'edit',
      messageId: 'lifecycle-status',
      text: '> 🔧 Running focused checks.',
    });
    expect(JSON.parse(deliver.mock.calls[3]![4])).toMatchObject({ text: 'The requested answer.' });
    expect(deleteMessage).toHaveBeenCalledWith('telegram', 'telegram:123', null, 'lifecycle-status', 'telegram');
  });

  it('reconciles verified non-delivery and allows only the original queued row to retry', async () => {
    const reconciliationModule = '../scripts/outcome-receipts.js';
    const { reconcileOutcome } = await import(reconciliationModule);
    const first = await prepare();
    await createAgentGroup({
      id: 'ag-2',
      name: 'Sibling',
      folder: 'sibling',
      agent_provider: null,
      workgroup_id: 'outcomes',
      created_at: now(),
    });
    const second = (await resolveSession('ag-2', 'mg-1', null, 'shared')).session;
    const deliver = vi.fn().mockRejectedValueOnce(new Error('socket disconnected')).mockResolvedValue('recovered');
    setDeliveryAdapter({ deliver });
    insertOutboundKind('ag-1', first.id, 'retry-original', 'chat', 'telegram', 'telegram:123', await outcome());
    await deliverSessionMessages(first);
    const receipt = getRawDb().prepare('SELECT updated_at,resolution FROM work_outcome_receipts').get() as {
      updated_at: string;
      resolution: string;
    };
    expect(receipt.resolution).toContain('socket disconnected');
    reconcileOutcome(getRawDb(), {
      action: 'confirm-not-sent',
      workgroup: 'outcomes',
      workItem: 'https://github.com/example-org/checkout/pull/17',
      expectedUpdatedAt: receipt.updated_at,
      reason: 'Platform readback verified no post was accepted.',
    });
    insertOutboundKind('ag-2', second.id, 'retry-sibling', 'chat', 'telegram', 'telegram:123', await outcome());
    await deliverSessionMessages(second);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(getDeliveredIds(openInboundDb('ag-2', second.id)).has('retry-sibling')).toBe(false);
    await deliverSessionMessages(first);
    await deliverSessionMessages(second);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(getRawDb().prepare('SELECT state,message_id FROM work_outcome_receipts').get()).toEqual({
      state: 'delivered',
      message_id: 'retry-original',
    });
  });

  it('rejects unauthorized destinations before claiming an outcome', async () => {
    const session = await prepare();
    await createMessagingGroup({
      id: 'mg-private',
      channel_type: 'telegram',
      platform_id: 'telegram:private',
      name: 'Private',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    const deliver = vi.fn().mockResolvedValue('unexpected');
    setDeliveryAdapter({ deliver });
    insertOutboundKind('ag-1', session.id, 'denied-outcome', 'chat', 'telegram', 'telegram:private', await outcome());
    await deliverSessionMessages(session);
    expect(deliver).not.toHaveBeenCalled();
    expect(getRawDb().prepare('SELECT COUNT(*) AS n FROM work_outcome_receipts').get()).toEqual({ n: 0 });
  });

  it('makes external terminal lanes exclusive without blocking direct replies or approvals', async () => {
    const session = await prepare();
    fs.writeFileSync(
      `${TEST_DIR}/groups/test-agent/container.json`,
      JSON.stringify({ outcomeReporting: true, outcomeReportingExternalChannels: ['telegram:123'] }),
    );
    const deliver = vi.fn().mockResolvedValue('reply');
    setDeliveryAdapter({ deliver });
    insertOutboundKind('ag-1', session.id, 'external-terminal', 'chat', 'telegram', 'telegram:123', await outcome());
    for (let i = 0; i < 3; i++) await deliverSessionMessages(session);
    expect(deliver).not.toHaveBeenCalled();
    insertOutboundKind('ag-1', session.id, 'external-reply', 'chat', 'telegram', 'telegram:123', {
      text: 'The detail you requested.',
      reporting: { version: 1, purpose: 'reply' },
    });
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('uses an agent-group receipt scope when a legacy group has no workgroup membership', async () => {
    await seedAgentAndChannel();
    fs.mkdirSync(`${TEST_DIR}/groups/test-agent`, { recursive: true });
    fs.writeFileSync(`${TEST_DIR}/groups/test-agent/container.json`, JSON.stringify({}));
    const session = (await resolveSession('ag-1', 'mg-1', null, 'shared')).session;
    const deliver = vi.fn().mockResolvedValue('legacy-group-outcome');
    setDeliveryAdapter({ deliver });
    insertOutboundKind('ag-1', session.id, 'legacy-group', 'chat', 'telegram', 'telegram:123', await outcome());
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(getRawDb().prepare('SELECT workgroup_id,state FROM work_outcome_receipts').get()).toEqual({
      workgroup_id: 'agent-group:ag-1',
      state: 'delivered',
    });
  });
});
