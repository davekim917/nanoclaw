/**
 * Integration tests for the unknown-channel registration flow (ACTION-ITEMS
 * item 22).
 *
 * Covers:
 *  - Mention on an unwired channel fires an owner-approval card
 *  - DM on an unwired channel fires a card (engage_mode will default to pattern='.')
 *  - In-flight dedup: second mention while a card is pending doesn't spam
 *  - Approve: wiring created with correct defaults, triggering sender added
 *    as member, replay wakes the container
 *  - Deny: messaging_groups.denied_at set, future mentions drop silently
 *  - Unauthorized clicker is rejected (same pattern as sender-approval)
 *  - No-owner install: no card, no row
 *  - No agent groups configured: no card, no row
 */
import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations, getRawDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { AGENT_ACCESS_SCOPE_WARNING } from './channel-approval.js';
import { createMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { initChannelAdapters, registerChannelAdapter } from '../../channels/channel-registry.js';
import type { ChannelAdapter, ChannelConversation, ChannelDefaults } from '../../channels/adapter.js';
import { upsertUser } from './db/users.js';
import { grantRole } from './db/user-roles.js';

// Registration-tier declaration for the fixture channel — a threaded platform
// whose declared defaults match the historical card-flow behavior
// (mention-sticky groups, pattern '.' DMs). Without it, the no-live-adapter
// fallback resolves threads=false and coerces sticky → mention.
// Registry maps are module-global; keep channel names unique per test file.
const telegramDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};
registerChannelAdapter('telegram', { factory: () => null, defaults: telegramDefaults });

// Mock container runner — prevent actual docker spawn. `...real` carries
// `sessionStillActive` through UNCHANGED: the router builds the replay's wake
// guard from it (`wakeContainer(session, priority, { guard: sessionStillActive(...) })`,
// #291), and this file never mocks `./db/sessions.js`, so the real predicate
// reads this suite's real sqlite fixture — exactly the liveness the replayed
// session should prove. A literal mock without it throws "no such export" the
// moment the guard is built, which the replay's catch swallows, silently
// skipping the wake — see the fleet-wide hardening in router.test.ts and
// siblings (commit 94800223) for the same pattern.
vi.mock('../../container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../container-runner.js')>();
  return {
    ...real,
    wakeContainer: vi.fn().mockResolvedValue(undefined),
    isContainerRunning: vi.fn().mockReturnValue(false),
    getActiveContainerCount: vi.fn().mockReturnValue(0),
    killContainer: vi.fn(),
  };
});

// Mock delivery adapter.
const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: deliverMock }),
  // Fork modules (bash-gate etc.) self-register delivery actions and
  // adapter-ready hooks at import time via the router's module graph — stub
  // the registries.
  registerDeliveryAction: vi.fn(),
  onDeliveryAdapterReady: vi.fn(),
}));

// Mock ensureUserDm — look up the owner's preconfigured DM row instead of
// hitting a real openDM RPC.
// importOriginal, not a bare factory: only `ensureUserDm` needs stubbing
// (these tests pre-seed user_dms and must not hit a platform openDM).
// `resolveUserChannelType` stays real so the approver-reachability check
// under test is the shipped one.
vi.mock('./user-dm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./user-dm.js')>()),
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getRawDb } = await import('../../db/connection.js');
    const row = getRawDb()
      .prepare(
        `SELECT mg.* FROM messaging_groups mg
           JOIN user_dms ud ON ud.messaging_group_id = mg.id
          WHERE ud.user_id = ?`,
      )
      .get(userId);
    return row;
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
  };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-channel-approval') }));

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(`${TEST_DIR}/groups`, { recursive: true });
  await initTestDb();
  const db = getRawDb();
  runMigrations(db);

  await import('./index.js'); // register hooks

  // Base fixtures: one agent group + owner with a DM on 'telegram'.
  await createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });

  await upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  await grantRole({
    user_id: 'telegram:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });

  // Pre-seed owner's DM messaging group + user_dms mapping.
  await createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'telegram',
    platform_id: 'dm-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  getRawDb()
    .prepare(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run('telegram:owner', 'telegram', 'mg-dm-owner', now());

  // Fork: pickApprovalDelivery keeps workspace boundaries — the approver is
  // matched by user-id channel prefix against the ORIGIN channel_type. Seed a
  // wamock-identity owner (+ DM) so the undeclared-channel ('wamock')
  // registration tests can deliver a card.
  await upsertUser({ id: 'wamock:owner', kind: 'wamock', display_name: 'Owner', created_at: now() });
  await grantRole({
    user_id: 'wamock:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-dm-owner-wamock',
    channel_type: 'wamock',
    platform_id: 'dm-owner-wamock',
    name: 'Owner wamock DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  getRawDb()
    .prepare(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run('wamock:owner', 'wamock', 'mg-dm-owner-wamock', now());

  deliverMock.mockClear();
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function groupMention(platformId: string, text = '@bot hello') {
  return {
    channelType: 'telegram',
    platformId,
    threadId: 'thread-1',
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({ senderId: 'caller', senderName: 'Caller', text }),
      timestamp: now(),
      isMention: true,
      isGroup: true, // group context comes from the adapter flag, never threadId
    },
  };
}

function dmEvent(platformId: string, text = 'hello') {
  return {
    channelType: 'telegram',
    platformId,
    threadId: null,
    // This fixture models a DM, so it declares that explicitly. router.ts
    // now defaults an unknown isGroup/isDM signal to group/mention mode
    // (the safe direction to be wrong in for an adapter that might be a
    // real group chat) rather than DM-style — so a fixture that stayed
    // silent on this would silently get treated as a group, regardless of
    // what any particular adapter does or doesn't report.
    isDM: true,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({ senderId: 'stranger', senderName: 'Stranger', text }),
      timestamp: now(),
      isMention: true, // DM bridge sets isMention=true
    },
  };
}

describe('unknown-channel registration flow', () => {
  it('delivers an approval card on mention into an unwired group', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-new'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const [channel, platformId, thread, kind, content] = deliverMock.mock.calls[0];
    expect(channel).toBe('telegram');
    expect(platformId).toBe('dm-owner'); // delivered to owner's DM
    expect(thread).toBeNull();
    expect(kind).toBe('chat-sdk');
    const payload = JSON.parse(content as string);
    expect(payload.type).toBe('ask_question');
    // Card tells the approver the resolved engage rule.
    expect(payload.question).toContain('will respond to @-mentions in this group');
    // …and what approving it grants.
    expect(payload.question).toContain(AGENT_ACCESS_SCOPE_WARNING);
    // Single-agent card offers a direct "Connect to <name>" button.
    const connectOption = payload.options.find((o: { value: string }) => o.value.startsWith('connect:'));
    expect(connectOption).toBeDefined();
    expect(connectOption.label).toContain('Andy');

    const { getRawDb } = await import('../../db/connection.js');
    const rows = getRawDb().prepare('SELECT * FROM pending_channel_approvals').all() as Array<{
      messaging_group_id: string;
    }>;
    expect(rows).toHaveLength(1);
  });

  // T4 PR1 (§5 case 11): the registration card must be delivered through the
  // approver DM's own adapter instance, not the bare channel_type — on an
  // install whose bots are all named instances, an untagged deliver() call
  // resolves no adapter or the wrong sibling bot.
  it('the registration card is delivered on the origin conversation instance', async () => {
    const { getRawDb } = await import('../../db/connection.js');
    getRawDb().prepare("UPDATE messaging_groups SET instance = 'telegram-work' WHERE id = 'mg-dm-owner'").run();

    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-instance'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    // 7th positional arg is `instance` on ChannelDeliveryAdapter.deliver.
    expect(deliverMock.mock.calls[0][6]).toBe('telegram-work');
  });

  it('delivers a card on DM too (non-threaded event)', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(dmEvent('dm-new-user'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(deliverMock.mock.calls[0][4] as string) as { question: string };
    expect(payload.question).toContain('will respond to all messages');
    const { getRawDb } = await import('../../db/connection.js');
    const count = (getRawDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('dedups a second mention while the card is pending', async () => {
    const { routeInbound } = await import('../../router.js');
    const first = groupMention('chat-busy');
    const second = groupMention('chat-busy', '@bot still here');
    await routeInbound(first);
    await new Promise((r) => setTimeout(r, 10));
    await routeInbound(second);
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const { getRawDb } = await import('../../db/connection.js');
    const count = (getRawDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }).c;
    expect(count).toBe(1);
    const receipts = getRawDb().prepare('SELECT message_id, status FROM channel_ingress_receipts').all() as Array<{
      message_id: string;
      status: string;
    }>;
    expect(Object.fromEntries(receipts.map((row) => [row.message_id, row.status]))).toEqual({
      [first.message.id]: 'deferred',
      [second.message.id]: 'completed',
    });
  });

  it('approve → creates wiring, admits triggering sender, replays', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { wakeContainer } = await import('../../container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound(groupMention('chat-approve'));
    await new Promise((r) => setTimeout(r, 10));

    const { getRawDb } = await import('../../db/connection.js');
    const pending = getRawDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };
    expect(pending).toBeDefined();

    // Owner clicks "Connect to Andy" (single-agent card).
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'connect:ag-1',
        userId: 'owner', // raw platform id — handler namespaces it
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // Wiring created with defaults.
    const mga = getRawDb()
      .prepare('SELECT * FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(pending.messaging_group_id) as {
      engage_mode: string;
      engage_pattern: string | null;
      sender_scope: string;
      ignored_message_policy: string;
      agent_group_id: string;
    };
    expect(mga).toBeDefined();
    expect(mga.engage_mode).toBe('mention-sticky'); // declared group default (threads:true keeps sticky)
    expect(mga.engage_pattern).toBeNull();
    expect(mga.sender_scope).toBe('known');
    expect(mga.ignored_message_policy).toBe('accumulate');
    expect(mga.agent_group_id).toBe('ag-1');

    // Triggering sender auto-admitted so sender_scope='known' doesn't
    // bounce the replay into sender-approval.
    const member = getRawDb()
      .prepare('SELECT 1 AS x FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get('telegram:caller', 'ag-1');
    expect(member).toBeDefined();

    // Pending row cleared and container woken via replay.
    const stillPending = (
      getRawDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }
    ).c;
    expect(stillPending).toBe(0);
    expect(wakeContainer).toHaveBeenCalled();
  });

  it('approve on a DM wires with pattern="." defaults', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(dmEvent('dm-approve-user'));
    await new Promise((r) => setTimeout(r, 10));

    const { getRawDb } = await import('../../db/connection.js');
    const pending = getRawDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'connect:ag-1',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    const mga = getRawDb()
      .prepare('SELECT engage_mode, engage_pattern FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(pending.messaging_group_id) as { engage_mode: string; engage_pattern: string };
    expect(mga.engage_mode).toBe('pattern');
    expect(mga.engage_pattern).toBe('.');
  });

  // WhatsApp-like platform: groups exist but thread ids don't (threadId is
  // always null), and the adapter is undeclared (stale skill-installed copy)
  // so resolution goes through the behavior-faithful fallback. This is the
  // one deliberate behavior change of the defaults work: the old
  // `threadId !== null` heuristic misread these groups as DMs and wired
  // pattern '.'.
  function waGroupMention(platformId: string) {
    return {
      channelType: 'wamock',
      platformId,
      threadId: null,
      message: {
        id: `msg-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'caller', senderName: 'Caller', text: '@bot hi' }),
        timestamp: now(),
        isMention: true,
        isGroup: true,
      },
    };
  }

  async function approvePending(agentGroupId = 'ag-1') {
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { getRawDb } = await import('../../db/connection.js');
    const pending = getRawDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };
    expect(pending).toBeDefined();
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: `connect:${agentGroupId}`,
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }
    return pending.messaging_group_id;
  }

  it('non-threaded group (isGroup flag, null threadId) wires the GROUP default, sticky coerced to mention', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(waGroupMention('wa-group-1'));
    await new Promise((r) => setTimeout(r, 10));

    const mgId = await approvePending();

    const { getRawDb } = await import('../../db/connection.js');
    const mga = getRawDb()
      .prepare('SELECT engage_mode, engage_pattern FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(mgId) as { engage_mode: string; engage_pattern: string | null };
    // Faithful fallback group default is mention-sticky, but with no live
    // adapter threads resolve false → coerced to plain mention. NOT the old
    // pattern '.' DM misclassification.
    expect(mga.engage_mode).toBe('mention');
    expect(mga.engage_pattern).toBeNull();
  });

  it('DM on an undeclared channel stays pattern "." through the faithful fallback', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound({
      ...waGroupMention('wa-dm-1'),
      message: { ...waGroupMention('wa-dm-1').message, isGroup: false },
    });
    await new Promise((r) => setTimeout(r, 10));

    const mgId = await approvePending();

    const { getRawDb } = await import('../../db/connection.js');
    const mga = getRawDb()
      .prepare('SELECT engage_mode, engage_pattern FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(mgId) as { engage_mode: string; engage_pattern: string | null };
    expect(mga.engage_mode).toBe('pattern');
    expect(mga.engage_pattern).toBe('.');
  });

  it('connect-existing and new-agent approve paths produce identical wirings', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { getRawDb } = await import('../../db/connection.js');

    // Path 1: connect to existing agent.
    await routeInbound(groupMention('chat-path-connect'));
    await new Promise((r) => setTimeout(r, 10));
    const mgIdConnect = await approvePending();

    // Path 2: new agent via free-text name reply.
    await routeInbound(groupMention('chat-path-newagent'));
    await new Promise((r) => setTimeout(r, 10));
    const pending = getRawDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'new_agent',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }
    // Owner replies with the agent name in their DM — interceptor wires.
    await routeInbound({
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
      message: {
        id: `msg-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'owner', text: 'Bravo' }),
        timestamp: now(),
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    const select =
      'SELECT engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority ' +
      'FROM messaging_group_agents WHERE messaging_group_id = ?';
    const viaConnect = getRawDb().prepare(select).get(mgIdConnect);
    const viaNewAgent = getRawDb().prepare(select).get(pending.messaging_group_id);
    expect(viaNewAgent).toBeDefined();
    expect(viaNewAgent).toEqual(viaConnect);
  });

  it('deny → sets denied_at; future mentions drop silently without a second card', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(groupMention('chat-deny'));
    await new Promise((r) => setTimeout(r, 10));
    const { getRawDb } = await import('../../db/connection.js');
    const pending = getRawDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'reject',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // denied_at set, pending row cleared, no wiring.
    const mg = await getMessagingGroupByPlatform('telegram', 'chat-deny');
    expect(mg?.denied_at).not.toBeNull();
    expect(mg?.denied_at).toBeTruthy();
    const mgaCount = (
      getRawDb()
        .prepare('SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ?')
        .get(pending.messaging_group_id) as { c: number }
    ).c;
    expect(mgaCount).toBe(0);

    // A follow-up mention on the denied channel: no new card, no new pending row.
    deliverMock.mockClear();
    await routeInbound(groupMention('chat-deny', '@bot please'));
    await new Promise((r) => setTimeout(r, 10));
    expect(deliverMock).not.toHaveBeenCalled();
    const stillPending = (
      getRawDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }
    ).c;
    expect(stillPending).toBe(0);
  });

  it('rejects clicks from an unauthorized user (prevents self-admit via forwarded card)', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(groupMention('chat-unauth'));
    await new Promise((r) => setTimeout(r, 10));
    const { getRawDb } = await import('../../db/connection.js');
    const pending = getRawDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'approve',
        userId: 'random-bystander',
        channelType: 'telegram',
        platformId: 'dm-random',
        threadId: null,
      });
      if (claimed) break;
    }

    // No wiring created, pending row preserved so a real approver can act on it.
    const mgaCount = (
      getRawDb()
        .prepare('SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ?')
        .get(pending.messaging_group_id) as { c: number }
    ).c;
    expect(mgaCount).toBe(0);
    const stillPending = (
      getRawDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }
    ).c;
    expect(stillPending).toBe(1);
  });

  it('does not let a scoped admin connect an unknown channel to another agent group', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { getRawDb } = await import('../../db/connection.js');

    await createAgentGroup({ id: 'ag-2', name: 'Betty', folder: 'betty', agent_provider: null, created_at: now() });
    await upsertUser({
      id: 'telegram:scoped-admin',
      kind: 'telegram',
      display_name: 'Scoped Admin',
      created_at: now(),
    });
    await grantRole({
      user_id: 'telegram:scoped-admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: 'telegram:owner',
      granted_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-dm-scoped-admin',
      channel_type: 'telegram',
      platform_id: 'dm-scoped-admin',
      name: 'Scoped Admin DM',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    getRawDb()
      .prepare(
        `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES (?, ?, ?, ?)`,
      )
      .run('telegram:scoped-admin', 'telegram', 'mg-dm-scoped-admin', now());

    await routeInbound(groupMention('chat-scoped-cross-group'));
    await new Promise((r) => setTimeout(r, 10));

    const pending = getRawDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };
    expect(pending).toBeDefined();
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(deliverMock.mock.calls[0][1]).toBe('dm-scoped-admin');

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'choose_existing',
        userId: 'scoped-admin',
        channelType: 'telegram',
        platformId: 'dm-scoped-admin',
        threadId: null,
      });
      if (claimed) break;
    }

    const followupPayload = JSON.parse(deliverMock.mock.calls[1][4] as string) as {
      question: string;
      options: Array<{ label: string; value: string }>;
    };
    expect(followupPayload.question).toContain(AGENT_ACCESS_SCOPE_WARNING);
    expect(followupPayload.options.map((option) => option.value)).toContain('connect:ag-1');
    expect(followupPayload.options.map((option) => option.value)).not.toContain('connect:ag-2');

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'connect:ag-2',
        userId: 'scoped-admin',
        channelType: 'telegram',
        platformId: 'dm-scoped-admin',
        threadId: null,
      });
      if (claimed) break;
    }

    const mgaCount = (
      getRawDb()
        .prepare('SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ?')
        .get(pending.messaging_group_id) as { c: number }
    ).c;
    expect(mgaCount).toBe(0);
    const stillPending = (
      getRawDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }
    ).c;
    expect(stillPending).toBe(1);
  });

  it('create new agent: the free-text name reply creates the group and wires the channel', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { getRawDb } = await import('../../db/connection.js');

    await routeInbound(groupMention('chat-create-new'));
    await new Promise((r) => setTimeout(r, 10));
    const pending = getRawDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };

    // Owner clicks "Connect new agent" → name prompt lands in their DM.
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'new_agent',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // Owner replies with the agent name in the same DM — the interceptor
    // captures it and creates.
    await routeInbound({
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
      message: {
        id: 'name-reply-1',
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'owner', senderName: 'Owner', text: 'Newbie' }),
        timestamp: now(),
      },
    });

    const created = getRawDb().prepare("SELECT id FROM agent_groups WHERE name = 'Newbie'").get() as
      | { id: string }
      | undefined;
    expect(created).toBeDefined();
    const mgaCount = (
      getRawDb()
        .prepare('SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?')
        .get(pending.messaging_group_id, created!.id) as { c: number }
    ).c;
    expect(mgaCount).toBe(1);
    const stillPending = (
      getRawDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }
    ).c;
    expect(stillPending).toBe(0);
  });

  // T4 PR3 (§5 case 17): group creation refuses an undisposed folder,
  // including a dangling symlink — a folder occupying the name on disk with
  // no claiming DB row is deleted-group residue, and adopting it would
  // silently re-scope the old group's data under the new agent's identity.
  // A dangling symlink specifically exercises the lstat-not-existsSync
  // distinction: existsSync follows the link and reports the name as free,
  // but the allocator must still treat it as occupied.
  it('create new agent: refuses an undisposed folder, including a dangling symlink', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { getRawDb } = await import('../../db/connection.js');

    fs.mkdirSync(`${TEST_DIR}/groups`, { recursive: true });
    fs.symlinkSync(`${TEST_DIR}/groups/nowhere-${Math.random()}`, `${TEST_DIR}/groups/dangler`);
    expect(fs.existsSync(`${TEST_DIR}/groups/dangler`)).toBe(false); // dangling: existsSync follows and reports absent

    await routeInbound(groupMention('chat-create-dangler'));
    await new Promise((r) => setTimeout(r, 10));
    const pending = getRawDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'new_agent',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    await routeInbound({
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
      message: {
        id: 'name-reply-dangler',
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'owner', senderName: 'Owner', text: 'Dangler' }),
        timestamp: now(),
      },
    });

    const created = getRawDb().prepare("SELECT id, folder FROM agent_groups WHERE name = 'Dangler'").get() as
      | { id: string; folder: string }
      | undefined;
    expect(created).toBeDefined();
    // Skipped to the next suffix rather than colliding with the dangling
    // symlink (or throwing) — the bounded-retry behavior is unchanged.
    expect(created!.folder).toBe('dangler-2');
    expect(fs.lstatSync(`${TEST_DIR}/groups/dangler`).isSymbolicLink()).toBe(true); // left alone, not overwritten
  });

  // T4 PR1 (§5 case 13): both the "choose existing agent" follow-up card and
  // the free-text name prompt are DMs to the approver, so they must carry the
  // approver DM's own instance too — same defect, two more sites in index.ts.
  it('the agent-selection follow-up and the name prompt are delivered on the approver DM instance', async () => {
    const { getRawDb } = await import('../../db/connection.js');
    getRawDb().prepare("UPDATE messaging_groups SET instance = 'telegram-work' WHERE id = 'mg-dm-owner'").run();

    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    // Path 1: "Choose existing agent" follow-up card.
    await routeInbound(groupMention('chat-instance-choose'));
    await new Promise((r) => setTimeout(r, 10));
    const pendingChoose = getRawDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };
    deliverMock.mockClear();
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pendingChoose.messaging_group_id,
        value: 'choose_existing',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(deliverMock.mock.calls[0][6]).toBe('telegram-work');

    // Path 2: "Create new agent" free-text name prompt.
    await routeInbound(groupMention('chat-instance-newagent'));
    await new Promise((r) => setTimeout(r, 10));
    const pendingNew = getRawDb()
      .prepare('SELECT messaging_group_id FROM pending_channel_approvals WHERE messaging_group_id != ?')
      .get(pendingChoose.messaging_group_id) as { messaging_group_id: string };
    deliverMock.mockClear();
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pendingNew.messaging_group_id,
        value: 'new_agent',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(deliverMock.mock.calls[0][6]).toBe('telegram-work');
  });

  // T4 PR1 (§5 case 14): the free-text name interceptor must match on the
  // reply's instance too, not just channelType/platformId — a same-channel
  // reply from a DIFFERENT sibling bot's DM is not the approver answering.
  it('a name reply from a different instance is not consumed; the matching instance is', async () => {
    const { getRawDb } = await import('../../db/connection.js');
    getRawDb().prepare("UPDATE messaging_groups SET instance = 'telegram-work' WHERE id = 'mg-dm-owner'").run();

    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(groupMention('chat-instance-mismatch'));
    await new Promise((r) => setTimeout(r, 10));
    const pending = getRawDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'new_agent',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // Same channelType/platformId, but no `instance` — a bare-channel-type
    // reply on a named-instance approver DM is a different conversation and
    // must not be consumed.
    await routeInbound({
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
      message: {
        id: 'name-reply-mismatch',
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'owner', senderName: 'Owner', text: 'WrongInstance' }),
        timestamp: now(),
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(getRawDb().prepare("SELECT id FROM agent_groups WHERE name = 'WrongInstance'").get()).toBeUndefined();

    // The matching-instance reply is still awaited and gets consumed.
    await routeInbound({
      channelType: 'telegram',
      instance: 'telegram-work',
      platformId: 'dm-owner',
      threadId: null,
      message: {
        id: 'name-reply-match',
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'owner', senderName: 'Owner', text: 'RightInstance' }),
        timestamp: now(),
      },
    });

    const created = getRawDb().prepare("SELECT id FROM agent_groups WHERE name = 'RightInstance'").get();
    expect(created).toBeDefined();
  });

  it('a name reply after the registration vanished is consumed without creating anything', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { getRawDb } = await import('../../db/connection.js');

    await routeInbound(groupMention('chat-vanished'));
    await new Promise((r) => setTimeout(r, 10));
    const pending = getRawDb().prepare('SELECT messaging_group_id FROM pending_channel_approvals').get() as {
      messaging_group_id: string;
    };

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'new_agent',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // The registration disappears between the click and the reply (rejected
    // from another card, group delete cascade, …) — the interceptor no
    // longer finds a pending registration, so the reply must not create.
    getRawDb()
      .prepare('DELETE FROM pending_channel_approvals WHERE messaging_group_id = ?')
      .run(pending.messaging_group_id);

    const agentGroupsBefore = (getRawDb().prepare('SELECT COUNT(*) AS c FROM agent_groups').get() as { c: number }).c;
    await routeInbound({
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
      message: {
        id: 'name-reply-2',
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'owner', senderName: 'Owner', text: 'Ghost' }),
        timestamp: now(),
      },
    });

    const agentGroupsAfter = (getRawDb().prepare('SELECT COUNT(*) AS c FROM agent_groups').get() as { c: number }).c;
    expect(agentGroupsAfter).toBe(agentGroupsBefore);
    const mgaCount = (getRawDb().prepare('SELECT COUNT(*) AS c FROM messaging_group_agents').get() as { c: number }).c;
    expect(mgaCount).toBe(0);
  });
});

describe('no-owner / no-agent failure modes', () => {
  it('no owner → no card, no pending row (fresh-install bootstrap path)', async () => {
    // Wipe the owner grant set up in the outer beforeEach.
    const { getRawDb } = await import('../../db/connection.js');
    getRawDb().prepare('DELETE FROM user_roles').run();

    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-noowner'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).not.toHaveBeenCalled();
    const count = (getRawDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('no agent groups → no card, no pending row', async () => {
    const { getRawDb } = await import('../../db/connection.js');
    // Drop foreign-key-dependent rows first, then the agent group itself.
    getRawDb().prepare('DELETE FROM user_roles').run();
    getRawDb().prepare('DELETE FROM agent_groups').run();

    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-noagent'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).not.toHaveBeenCalled();
    const count = (getRawDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }).c;
    expect(count).toBe(0);
  });
});

/**
 * MPDM-aware card text.
 *
 * Drives the real registration flow end to end (routeInbound → the card the
 * approver is delivered), with a LIVE adapter that implements the optional
 * `resolveConversation` seam. A group DM has no name a human recognizes —
 * Slack's own label is a slug like `mpdm-alice--bob--carol-1` — so the card
 * has to describe it by who is in it.
 */
const resolveChannelNameSpy = vi.fn();

async function liveAdapterWithConversation(
  channelType: string,
  resolveConversation?: (platformId: string) => Promise<ChannelConversation | null>,
  channelName = '#mpdm-alice--bob--carol-1',
): Promise<void> {
  resolveChannelNameSpy.mockClear();
  const adapter = {
    name: channelType,
    channelType,
    supportsThreads: true,
    defaults: telegramDefaults,
    async setup() {},
    async teardown() {},
    isConnected: () => true,
    async deliver() {
      return undefined;
    },
    async resolveChannelName() {
      resolveChannelNameSpy();
      return channelName;
    },
    ...(resolveConversation ? { resolveConversation } : {}),
  } as unknown as ChannelAdapter;
  registerChannelAdapter(channelType, { factory: () => adapter, defaults: telegramDefaults });
  await initChannelAdapters(
    () =>
      ({
        onInbound: () => {},
        onInboundEvent: () => {},
        onMetadata: () => {},
        onAction: () => {},
      }) as never,
  );
}

async function cardQuestion(): Promise<string> {
  await new Promise((r) => setTimeout(r, 10));
  expect(deliverMock).toHaveBeenCalledTimes(1);
  return (JSON.parse(deliverMock.mock.calls[0][4] as string) as { question: string }).question;
}

describe('approval card names a group DM by its participants', () => {
  it('describes the people instead of the platform slug', async () => {
    await liveAdapterWithConversation('telegram', async () => ({
      type: 'group_dm',
      name: null,
      participantNames: ['Alice', 'Bob', 'Carol'],
    }));
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('mpdm-1'));

    const question = await cardQuestion();
    expect(question).toContain('in a group DM with Alice, Bob and Carol on telegram');
    expect(question).not.toContain('mpdm-alice--bob--carol-1');
  });

  it('still says "a group DM" when the roster cannot be resolved', async () => {
    await liveAdapterWithConversation('telegram', async () => ({ type: 'group_dm', name: null }));
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('mpdm-2'));

    expect(await cardQuestion()).toContain('in a group DM on telegram');
  });

  it('keeps the channel-name rendering for an ordinary channel', async () => {
    await liveAdapterWithConversation('telegram', async () => ({ type: 'channel', name: '#general' }), '#general');
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chan-1'));

    expect(await cardQuestion()).toContain('#general on telegram');
  });

  it('falls back to the generic rendering for an adapter without the seam', async () => {
    await liveAdapterWithConversation('telegram', undefined, '#general');
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chan-2'));

    expect(await cardQuestion()).toContain('#general on telegram');
  });
});

describe('the conversation is classified once, not twice', () => {
  async function persistedName(platformId: string): Promise<string | null> {
    const { getRawDb } = await import('../../db/connection.js');
    const row = getRawDb().prepare('SELECT name FROM messaging_groups WHERE platform_id = ?').get(platformId) as
      | { name: string | null }
      | undefined;
    return row?.name ?? null;
  }

  it('derives the persisted name from the classification and never calls the legacy resolver', async () => {
    await liveAdapterWithConversation('telegram', async () => ({
      type: 'group_dm',
      name: null,
      participantNames: ['Alice', 'Bob'],
    }));
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('mpdm-once'));
    await cardQuestion();

    expect(resolveChannelNameSpy).not.toHaveBeenCalled();
    expect(await persistedName('mpdm-once')).toBe('Group DM: Alice and Bob');
  });

  it('falls back to the legacy resolver when the rich seam is absent', async () => {
    await liveAdapterWithConversation('telegram', undefined, '#general');
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chan-legacy'));
    await cardQuestion();

    expect(resolveChannelNameSpy).toHaveBeenCalledTimes(1);
    expect(await persistedName('chan-legacy')).toBe('#general');
  });

  it('falls back when the rich lookup fails outright', async () => {
    await liveAdapterWithConversation('telegram', async () => null, '#general');
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chan-failed'));
    await cardQuestion();

    expect(resolveChannelNameSpy).toHaveBeenCalledTimes(1);
    expect(await persistedName('chan-failed')).toBe('#general');
  });

  // Codex review (PR #251): reportChannelMetadata's one-shot legacy name
  // lookup (chat-sdk-bridge.ts) races this exact classification on the same
  // first inbound event, with no ordering guarantee between the two writers.
  // Simulate the race having already gone the "wrong" way — the raw platform
  // slug landed in messaging_groups.name before this classification ran —
  // and confirm the richer classified name still wins.
  it('overwrites a name a racing legacy metadata lookup already set', async () => {
    await createMessagingGroup({
      id: 'mg-mpdm-raced',
      channel_type: 'telegram',
      platform_id: 'mpdm-raced',
      name: 'mpdm-alice--bob-1',
      is_group: 1,
      unknown_sender_policy: 'request_approval',
      created_at: new Date().toISOString(),
    });
    await liveAdapterWithConversation('telegram', async () => ({
      type: 'group_dm',
      name: null,
      participantNames: ['Alice', 'Bob'],
    }));
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('mpdm-raced'));
    await cardQuestion();

    expect(await persistedName('mpdm-raced')).toBe('Group DM: Alice and Bob');
  });

  it('leaves an existing name alone when the classified name is unavailable', async () => {
    await createMessagingGroup({
      id: 'mg-mpdm-noroster',
      channel_type: 'telegram',
      platform_id: 'mpdm-noroster',
      name: 'mpdm-alice--bob-1',
      is_group: 1,
      unknown_sender_policy: 'request_approval',
      created_at: new Date().toISOString(),
    });
    await liveAdapterWithConversation('telegram', async () => ({ type: 'group_dm', name: null }));
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('mpdm-noroster'));
    await cardQuestion();

    expect(await persistedName('mpdm-noroster')).toBe('mpdm-alice--bob-1');
  });
});
