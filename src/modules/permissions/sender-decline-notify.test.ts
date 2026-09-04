/**
 * Integration tests for the unknown-sender decline_notify flow.
 *
 * Every case drives the real path — routeInbound → access gate → guard
 * decision → declineAndNotify → delivery adapter — rather than calling the
 * continuation in isolation, except the overrides case, which exercises the
 * exported seam a channel module would call.
 *
 * Covers:
 *  - decline_notify policy: the unknown sender's message is dropped, the bot
 *    sends a polite decline into the origin DM, the owner gets a one-line
 *    FYI (plain text, not a card), and the drop is recorded
 *  - No approval card / pending card row — only the decline stamp
 *  - Dedupe: a second message within 24h sends nothing further
 *  - An expired (>24h) stamp declines again
 *  - Policy flips in both directions across the shared UNIQUE key
 *  - A group messaging group degrades to strict (no public decline)
 *  - An adapter that reports no DM/group context degrades to strict too
 *  - The FYI goes to an owner, not to the first admin pickApprover would card
 *  - The FYI tells the truth when the decline itself failed to deliver
 *  - The stamp keeps no trace of what the declined sender wrote
 *  - Caller-supplied copy + conversation-scoped dedupe overrides
 */
import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent, updateMessagingGroup } from '../../db/messaging-groups.js';
import { upsertUser } from './db/users.js';
import { grantRole } from './db/user-roles.js';

// Mock container runner — prevent actual docker spawn.
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Mock delivery adapter — record decline + FYI sends for assertions.
const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({
    deliver: deliverMock,
  }),
  onDeliveryAdapterReady: vi.fn(),
  registerDeliveryAction: vi.fn(),
}));

// Mock ensureUserDm to return the approver's existing messaging group
// instead of hitting a real openDM RPC.
vi.mock('./user-dm.js', () => ({
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getDb } = await import('../../db/connection.js');
    return getDb()
      .prepare(
        `SELECT mg.* FROM messaging_groups mg
           JOIN user_dms ud ON ud.messaging_group_id = mg.id
          WHERE ud.user_id = ?`,
      )
      .get(userId);
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-decline-notify' };
});

const TEST_DIR = '/tmp/nanoclaw-test-decline-notify';

function now() {
  return new Date().toISOString();
}

async function db() {
  const { getDb } = await import('../../db/connection.js');
  return getDb();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const handle = initTestDb();
  runMigrations(handle);

  // Side-effect import: registers the access gate AFTER the mocks are in
  // place so it picks up the mocked delivery + user-dm helpers.
  await import('./index.js');

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });

  // A wired 1:1 DM messaging group on decline_notify.
  createMessagingGroup({
    id: 'mg-dm-stranger',
    channel_type: 'telegram',
    platform_id: 'dm-stranger',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'decline_notify',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-dm-stranger',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: null,
    instructions_profile: null,
    created_at: now(),
  });

  // Owner (display name feeds the decline copy) + their DM.
  upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  grantRole({
    user_id: 'telegram:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  // Named instance, not the bare channel_type: on such an install nothing is
  // registered under 'telegram', so an omitted instance resolves no adapter.
  createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'telegram',
    instance: 'telegram-owner-bot',
    platform_id: 'dm-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  (await db())
    .prepare(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run('telegram:owner', 'telegram', 'mg-dm-owner', now());

  deliverMock.mockClear();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function strangerDm(text: string) {
  return {
    channelType: 'telegram',
    platformId: 'dm-stranger',
    threadId: null,
    // Positive DM evidence — the flow requires it, because is_group = 0 on
    // its own can mean "the adapter didn't say".
    isDM: true,
    message: {
      id: `stranger-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({
        senderId: 'tg:stranger',
        // handleUnknownSender reads `sender` for the display name (the same
        // extraction the request_approval card uses).
        sender: 'Stranger',
        text,
      }),
      timestamp: now(),
    },
  };
}

async function settle() {
  // The decline flow is fire-and-forget off the access gate.
  await new Promise((r) => setTimeout(r, 25));
}

async function waitForDeliveries(count: number): Promise<void> {
  await vi.waitFor(() => expect(deliverMock).toHaveBeenCalledTimes(count));
}

describe('unknown-sender decline_notify flow', () => {
  it('the guard denies decline_notify — it never holds a card', async () => {
    const { guard } = await import('../../guard/index.js');
    const { sendersAdmit } = await import('./guard.js');
    const decision = guard(sendersAdmit, {
      actor: { kind: 'human', userId: 'tg:stranger' },
      payload: {
        messagingGroupId: 'mg-dm-stranger',
        agentGroupId: 'ag-1',
        senderIdentity: 'tg:stranger',
        policy: 'decline_notify',
      },
    });
    // The decline + FYI are the caller's side effects; nothing pends, and
    // there is no grant path a click could replay. The access gate reads
    // this verdict, so a hold here would card instead of declining.
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toContain('decline-and-notify');
  });

  it('declines in the DM, FYIs the owner, records the drop — no card', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('hi, can you book me a flight?'));
    await waitForDeliveries(2);

    // (a) Polite decline into the stranger's DM, as the bot, on the origin
    // messaging group's adapter instance.
    const [dChannel, dPlatform, dThread, dKind, dContent, , dInstance] = deliverMock.mock.calls[0];
    expect(dChannel).toBe('telegram');
    expect(dPlatform).toBe('dm-stranger');
    expect(dThread).toBeNull();
    expect(dKind).toBe('chat-sdk');
    expect(dInstance).toBe('telegram');
    const decline = JSON.parse(dContent as string);
    expect(decline.text).toBe("I'm Owner's personal agent — I can't help you directly.");
    expect(decline.type).toBeUndefined(); // plain text, not ask_question
    expect(decline.options).toBeUndefined(); // no buttons

    // (b) One-line FYI to the owner's DM — informational, not a card, and
    // dispatched on that DM's own adapter instance.
    const [fChannel, fPlatform, , fKind, fContent, , fInstance] = deliverMock.mock.calls[1];
    expect(fChannel).toBe('telegram');
    expect(fPlatform).toBe('dm-owner');
    expect(fKind).toBe('chat-sdk');
    expect(fInstance).toBe('telegram-owner-bot');
    const fyi = JSON.parse(fContent as string);
    expect(fyi.type).toBeUndefined();
    expect(fyi.options).toBeUndefined();
    expect(fyi.text).toContain('FYI');
    expect(fyi.text).toContain('Stranger (tg:stranger)');
    expect(fyi.text).toContain('ncl members add');

    const drop = (await db())
      .prepare('SELECT user_id, reason FROM unregistered_senders WHERE platform_id = ?')
      .get('dm-stranger') as { user_id: string; reason: string } | undefined;
    expect(drop).toBeDefined();
    expect(drop!.user_id).toBe('tg:stranger');

    // No card rows anywhere — only the decline stamp.
    const rows = (await db()).prepare('SELECT id FROM pending_sender_approvals').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^decline:/);
    const channelRows = (await db()).prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as {
      c: number;
    };
    expect(channelRows.c).toBe(0);
  });

  it('dedupes: a second message within 24h sends no further decline or FYI', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('hello'));
    await waitForDeliveries(2);

    await routeInbound(strangerDm('are you there?'));
    await settle();

    expect(deliverMock).toHaveBeenCalledTimes(2);
    // The drop is still recorded for every message — dedupe suppresses the
    // outbound pair, not the accounting.
    const drop = (await db())
      .prepare('SELECT message_count FROM unregistered_senders WHERE platform_id = ?')
      .get('dm-stranger') as { message_count: number };
    expect(drop.message_count).toBeGreaterThan(1);
  });

  it('declines again once the 24h stamp expires', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('hello'));
    await waitForDeliveries(2);

    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    (await db()).prepare(`UPDATE pending_sender_approvals SET created_at = ? WHERE id LIKE 'decline:%'`).run(old);

    await routeInbound(strangerDm('hello again'));
    await waitForDeliveries(4);

    const stamp = (await db())
      .prepare(`SELECT created_at FROM pending_sender_approvals WHERE id LIKE 'decline:%'`)
      .get() as { created_at: string };
    expect(new Date(stamp.created_at).getTime()).toBeGreaterThan(Date.now() - 60_000); // refreshed
  });

  it('flip request_approval→decline_notify with a card pending: the card row converts to a stamp', async () => {
    updateMessagingGroup('mg-dm-stranger', { unknown_sender_policy: 'request_approval' });
    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('hello'));
    await waitForDeliveries(1); // the approval card

    let rows = (await db()).prepare('SELECT id FROM pending_sender_approvals').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^nsa-/);

    // Operator flips the policy while the card is still pending.
    updateMessagingGroup('mg-dm-stranger', { unknown_sender_policy: 'decline_notify' });
    deliverMock.mockClear();

    await routeInbound(strangerDm('are you there?'));
    await waitForDeliveries(2);

    rows = (await db()).prepare('SELECT id FROM pending_sender_approvals').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^decline:/);

    // And the stamp dedupes: a third message sends nothing further.
    await routeInbound(strangerDm('hello??'));
    await settle();
    expect(deliverMock).toHaveBeenCalledTimes(2);
  });

  it('policy flip back to request_approval clears the stale stamp and cards normally', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('hello'));
    await waitForDeliveries(2);

    updateMessagingGroup('mg-dm-stranger', { unknown_sender_policy: 'request_approval' });
    deliverMock.mockClear();

    await routeInbound(strangerDm('let me in'));
    await waitForDeliveries(1);

    const [, platform, , , content] = deliverMock.mock.calls[0];
    expect(platform).toBe('dm-owner');
    expect(JSON.parse(content as string).type).toBe('ask_question');

    const rows = (await db()).prepare('SELECT id FROM pending_sender_approvals').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^nsa-/); // real card row; the stamp is gone
  });

  it('decline_notify on a group messaging group: silent drop — no public decline, no FYI', async () => {
    createMessagingGroup({
      id: 'mg-team',
      channel_type: 'telegram',
      platform_id: 'group-team',
      name: 'Team',
      is_group: 1,
      unknown_sender_policy: 'decline_notify',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-team',
      messaging_group_id: 'mg-team',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      default_model: null,
      default_effort: null,
      default_tone: null,
      instructions_profile: null,
      created_at: now(),
    });

    const { routeInbound } = await import('../../router.js');
    // isDM stays true on the event: the row is the authority for a group, so
    // this pins the row half of the check independently of the evidence half.
    await routeInbound({ ...strangerDm('hi all'), platformId: 'group-team' });
    await settle();

    // Nothing delivered anywhere — the DM-phrased decline must never be
    // posted publicly into the group channel; no stamp either.
    expect(deliverMock).not.toHaveBeenCalled();
    const drop = (await db())
      .prepare('SELECT user_id FROM unregistered_senders WHERE platform_id = ?')
      .get('group-team') as { user_id: string } | undefined;
    expect(drop).toBeDefined();
    expect(drop!.user_id).toBe('tg:stranger');
    const stamps = (await db()).prepare('SELECT COUNT(*) AS c FROM pending_sender_approvals').get() as { c: number };
    expect(stamps.c).toBe(0);
  });

  it('no DM/group evidence from the adapter: silent drop, no decline, no stamp', async () => {
    const { routeInbound } = await import('../../router.js');
    // An older chat-sdk plugin build: adapterIsDM returns undefined, so the
    // event carries neither isDM nor isGroup and the row's is_group = 0 is
    // the router's default rather than a fact.
    const { isDM: _dropped, ...noEvidence } = strangerDm('hi');
    await routeInbound(noEvidence);
    await settle();

    expect(deliverMock).not.toHaveBeenCalled();
    const stamps = (await db()).prepare('SELECT COUNT(*) AS c FROM pending_sender_approvals').get() as { c: number };
    expect(stamps.c).toBe(0);
    // Still dropped and accounted for.
    const drop = (await db())
      .prepare('SELECT user_id FROM unregistered_senders WHERE platform_id = ?')
      .get('dm-stranger') as { user_id: string } | undefined;
    expect(drop).toBeDefined();
  });

  it('sends the FYI to the owner, not to the admin the approval card would go to', async () => {
    // A scoped admin of ag-1 with a reachable DM. pickApprover puts this
    // user FIRST (scoped admins → global admins → owners), so a card would
    // land here; the personal FYI must not.
    upsertUser({ id: 'telegram:admin', kind: 'telegram', display_name: 'Admin', created_at: now() });
    grantRole({
      user_id: 'telegram:admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: 'telegram:owner',
      granted_at: now(),
    });
    createMessagingGroup({
      id: 'mg-dm-admin',
      channel_type: 'telegram',
      instance: 'telegram-owner-bot',
      platform_id: 'dm-admin',
      name: 'Admin DM',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    (await db())
      .prepare(
        `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('telegram:admin', 'telegram', 'mg-dm-admin', now());

    // Sanity: the card audience really does put the admin first.
    const { pickApprover } = await import('../approvals/primitive.js');
    expect(pickApprover('ag-1')[0]).toBe('telegram:admin');

    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('hello'));
    await waitForDeliveries(2);

    expect(deliverMock.mock.calls[1][1]).toBe('dm-owner');
  });

  it('tells the owner the truth when the decline itself failed to deliver', async () => {
    deliverMock.mockRejectedValueOnce(new Error('telegram 429'));

    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('hello'));
    await waitForDeliveries(2);

    const fyi = JSON.parse(deliverMock.mock.calls[1][4] as string);
    expect(fyi.text).toContain("couldn't deliver the decline");
    expect(fyi.text).not.toContain('I sent a polite decline');
  });

  it('keeps no declined-sender content in the stamp', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('my bank password is hunter2'));
    await waitForDeliveries(2);

    const stamp = (await db()).prepare(`SELECT * FROM pending_sender_approvals WHERE id LIKE 'decline:%'`).get() as {
      original_message: string;
      sender_name: string | null;
      title: string;
      options_json: string;
    };
    expect(stamp.original_message).not.toContain('hunter2');
    expect(stamp.original_message).toBe('{"declined":true}');
    expect(stamp.sender_name).toBeNull();
    // And no render metadata, so the row can never be drawn as a card.
    expect(stamp.title).toBe('');
    expect(stamp.options_json).toBe('[]');
  });

  it('converting a pending card row into a stamp drops the retained message body', async () => {
    updateMessagingGroup('mg-dm-stranger', { unknown_sender_policy: 'request_approval' });
    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('let me in, my token is abc123'));
    await waitForDeliveries(1);

    const card = (await db())
      .prepare(`SELECT original_message FROM pending_sender_approvals WHERE id LIKE 'nsa-%'`)
      .get() as { original_message: string };
    expect(card.original_message).toContain('abc123'); // the card legitimately retains it for replay

    updateMessagingGroup('mg-dm-stranger', { unknown_sender_policy: 'decline_notify' });
    await routeInbound(strangerDm('hello?'));
    await waitForDeliveries(3);

    const stamp = (await db())
      .prepare(`SELECT original_message FROM pending_sender_approvals WHERE id LIKE 'decline:%'`)
      .get() as { original_message: string };
    expect(stamp.original_message).toBe('{"declined":true}');
  });

  it('honors caller-supplied copy and conversation-scoped dedupe', async () => {
    const { declineAndNotify } = await import('./sender-approval.js');
    const input = {
      messagingGroupId: 'mg-dm-stranger',
      agentGroupId: 'ag-1',
      senderIdentity: 'telegram:stranger-1',
      senderName: 'Stranger One',
      event: strangerDm('hello'),
      dedupeKey: 'conversation',
      declineText: 'Only the owner can connect me here.',
      fyiText: 'FYI: I declined an unauthorized channel invitation.',
    };

    await declineAndNotify(input);
    await waitForDeliveries(2);
    expect(JSON.parse(deliverMock.mock.calls[0][4] as string).text).toBe(input.declineText);
    expect(JSON.parse(deliverMock.mock.calls[1][4] as string).text).toBe(input.fyiText);

    // A different sender in the same conversation is deduped by the shared
    // key — sender-scoped dedupe would have let this one through.
    await declineAndNotify({
      ...input,
      senderIdentity: 'telegram:stranger-2',
      senderName: 'Stranger Two',
      event: strangerDm('hello too'),
    });
    await settle();

    expect(deliverMock).toHaveBeenCalledTimes(2);
    const stamp = (await db())
      .prepare(`SELECT sender_identity FROM pending_sender_approvals WHERE id LIKE 'decline:%'`)
      .get() as { sender_identity: string };
    expect(stamp.sender_identity).toBe('conversation');
  });
});
