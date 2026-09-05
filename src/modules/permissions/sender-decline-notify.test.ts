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
 *  - The decline threads under the message it answers; the FYI does not
 *  - Dedupe: a second message within 24h sends nothing further
 *  - An expired (>24h) stamp declines again
 *  - Policy flips in both directions across the shared UNIQUE key
 *  - A card issued before a flip to decline_notify stops granting on click
 *  - A group messaging group degrades to strict (no public decline)
 *  - An adapter that reports no DM/group context degrades to strict too
 *  - The FYI goes to an owner, not to the first admin pickApprover would card
 *  - The FYI tells the truth when the decline itself failed to deliver
 *  - The stamp keeps no trace of what the declined sender wrote
 *  - Caller-supplied copy + conversation-scoped dedupe overrides
 */
import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations, getRawDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent, updateMessagingGroup } from '../../db/messaging-groups.js';
import { upsertUser } from './db/users.js';
import { grantRole } from './db/user-roles.js';

// Mock container runner — prevent actual docker spawn.
vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Mock delivery adapter — record decline + FYI sends for assertions.
const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../delivery.js')>()),
  getDeliveryAdapter: () => ({
    deliver: deliverMock,
  }),
  onDeliveryAdapterReady: vi.fn(),
  registerDeliveryAction: vi.fn(),
}));

// Records what pickApprovalDelivery passed down to cold-DM resolution, so the
// instance handoff can be asserted without a live adapter registry.
const { ensureUserDmCalls } = vi.hoisted(() => ({
  ensureUserDmCalls: [] as Array<{ userId: string; instance?: string }>,
}));

// Mock ensureUserDm to return the approver's existing messaging group
// instead of hitting a real openDM RPC.
//
// importOriginal, not a bare factory: only `ensureUserDm` needs stubbing
// (this suite pre-seeds user_dms and must not hit a platform openDM).
// `resolveUserChannelType` stays real — pickApprovalDelivery calls it to
// screen approvers by channel kind, so a factory that omitted it would make
// the FYI half of the flow throw and silently deliver only the decline.
vi.mock('./user-dm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./user-dm.js')>()),
  ensureUserDm: vi.fn(async (userId: string, options?: { instance?: string; privacySafeLogs?: boolean }) => {
    ensureUserDmCalls.push({ userId, instance: options?.instance });
    const { getRawDb } = await import('../../db/connection.js');
    return getRawDb()
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
  const { getRawDb } = await import('../../db/connection.js');
  return getRawDb();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initTestDb();
  const handle = getRawDb();
  runMigrations(handle);

  // Side-effect import: registers the access gate AFTER the mocks are in
  // place so it picks up the mocked delivery + user-dm helpers.
  await import('./index.js');

  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });

  // A wired 1:1 DM messaging group on decline_notify.
  await createMessagingGroup({
    id: 'mg-dm-stranger',
    channel_type: 'telegram',
    platform_id: 'dm-stranger',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'decline_notify',
    created_at: now(),
  });
  await createMessagingGroupAgent({
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
  await upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  await grantRole({
    user_id: 'telegram:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  // Named instance, not the bare channel_type: on such an install nothing is
  // registered under 'telegram', so an omitted instance resolves no adapter.
  await createMessagingGroup({
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
  ensureUserDmCalls.length = 0;
});

afterEach(async () => {
  await closeDb();
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

  it('sends the decline on the wiring thread it was given, FYI always unthreaded', async () => {
    // The decline is a reply TO the stranger, so it goes where the wiring
    // would reply. The access gate hands down the thread router fanout
    // already resolved for that wiring (resolveThreadPolicy), so this seam
    // takes the address rather than re-deriving it from the event.
    const { declineAndNotify } = await import('./sender-approval.js');
    const thread = 'slack:D123:1699999999.000100';
    await declineAndNotify({
      messagingGroupId: 'mg-dm-stranger',
      agentGroupId: 'ag-1',
      senderIdentity: 'tg:stranger',
      senderName: 'Stranger',
      event: { ...strangerDm('hi'), threadId: thread },
      threadId: thread,
    });
    await waitForDeliveries(2);

    expect(deliverMock.mock.calls[0][2]).toBe(thread);
    // The owner FYI opens a fresh line in the owner's own DM — it is not a
    // reply to the stranger, so it must never inherit their thread.
    expect(deliverMock.mock.calls[1][2]).toBeNull();
  });

  it('collapses the decline to the root when the wiring turns threads off', async () => {
    // threads = 0 on the wiring makes resolveThreadPolicy hand the gate a
    // null even though the event carries a real thread. Forwarding the raw
    // event thread here would post declines inside sub-threads the operator
    // deliberately collapsed.
    const { declineAndNotify } = await import('./sender-approval.js');
    await declineAndNotify({
      messagingGroupId: 'mg-dm-stranger',
      agentGroupId: 'ag-1',
      senderIdentity: 'tg:stranger',
      senderName: 'Stranger',
      event: { ...strangerDm('hi'), threadId: 'slack:D123:1699999999.000100' },
      threadId: null,
    });
    await waitForDeliveries(2);

    expect(deliverMock.mock.calls[0][2]).toBeNull();
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

  // Issue #443, Codex round 1 — the async read-then-write class.
  //
  // `declineAndNotify` used to read the stamp, decide the 24h window had
  // expired, and only then write it. Under the async driver that read yields,
  // so two overlapping declines for the same (group, sender) both concluded
  // "no fresh stamp" and both sent — the stranger refused twice, the owner
  // FYI'd twice. The fix folds the freshness test into the upsert's conflict
  // clause (`claimDeclineStamp`), so exactly one caller wins.
  //
  // Both calls are started before either is awaited, which is what makes them
  // overlap: the first suspends at its first `await` and the second then runs
  // the same lookup against the same unchanged table. Driven through the real
  // routing path first so the messaging group, the wiring and the stamp are
  // the ones production would have.
  it('two overlapping declines send one decline and one FYI, not two of each', async () => {
    const { routeInbound } = await import('../../router.js');
    const { declineAndNotify } = await import('./sender-approval.js');

    await routeInbound(strangerDm('hello'));
    await waitForDeliveries(2);

    const conn = await db();
    const mg = conn.prepare('SELECT id FROM messaging_groups WHERE platform_id = ?').get('dm-stranger') as {
      id: string;
    };
    // Age the stamp past the window so both callers below legitimately see an
    // expired one — the state the race needs.
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    conn.prepare(`UPDATE pending_sender_approvals SET created_at = ? WHERE id LIKE 'decline:%'`).run(old);

    deliverMock.mockClear();
    const input = {
      messagingGroupId: mg.id,
      agentGroupId: 'ag-1',
      senderIdentity: 'tg:stranger',
      senderName: 'Stranger',
      event: strangerDm('hello again'),
      threadId: null,
    };
    await Promise.all([declineAndNotify(input), declineAndNotify(input)]);
    await settle();

    // One decline + one FYI, not two pairs.
    expect(deliverMock).toHaveBeenCalledTimes(2);

    // And still exactly one stamp row for the pair.
    const stamps = conn
      .prepare(`SELECT COUNT(*) AS c FROM pending_sender_approvals WHERE id LIKE 'decline:%'`)
      .get() as { c: number };
    expect(stamps.c).toBe(1);
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
    await updateMessagingGroup('mg-dm-stranger', { unknown_sender_policy: 'request_approval' });
    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('hello'));
    await waitForDeliveries(1); // the approval card

    let rows = (await db()).prepare('SELECT id FROM pending_sender_approvals').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^nsa-/);

    // Operator flips the policy while the card is still pending.
    await updateMessagingGroup('mg-dm-stranger', { unknown_sender_policy: 'decline_notify' });
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

  it('a card issued before the flip stops granting once the group is decline_notify', async () => {
    // The conversion in declineAndNotify only runs on the sender's NEXT
    // message. Until then the already-delivered buttons stay live, so the
    // click itself has to honor the new policy — otherwise decline_notify
    // ("no approval path, grants stay explicit") is bypassable by clicking a
    // stale card.
    await updateMessagingGroup('mg-dm-stranger', { unknown_sender_policy: 'request_approval' });
    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('let me in'));
    await waitForDeliveries(1);

    const card = (await db()).prepare(`SELECT id FROM pending_sender_approvals WHERE id LIKE 'nsa-%'`).get() as {
      id: string;
    };

    await updateMessagingGroup('mg-dm-stranger', { unknown_sender_policy: 'decline_notify' });

    // The owner clicks Allow on the card they were sent before the flip.
    const { getResponseHandlers } = await import('../../response-registry.js');
    for (const handler of getResponseHandlers()) {
      await handler({
        questionId: card.id,
        value: 'approve',
        userId: 'owner', // raw platform id; the handler namespaces it
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
    }

    // No membership granted, and the void card is gone rather than left
    // clickable.
    const member = (await db())
      .prepare('SELECT user_id FROM agent_group_members WHERE user_id = ?')
      .get('tg:stranger') as { user_id: string } | undefined;
    expect(member).toBeUndefined();
    const rows = (await db()).prepare('SELECT id FROM pending_sender_approvals').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(0);
  });

  it('policy flip back to request_approval clears the stale stamp and cards normally', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('hello'));
    await waitForDeliveries(2);

    await updateMessagingGroup('mg-dm-stranger', { unknown_sender_policy: 'request_approval' });
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
    await createMessagingGroup({
      id: 'mg-team',
      channel_type: 'telegram',
      platform_id: 'group-team',
      name: 'Team',
      is_group: 1,
      unknown_sender_policy: 'decline_notify',
      created_at: now(),
    });
    await createMessagingGroupAgent({
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

  it('names the owner who actually gets the FYI, not the first owner on the books', async () => {
    // A second owner, granted later, whose DM is the only one reachable on
    // this channel — the beforeEach owner ('Owner') keeps their user_dms row,
    // so make them unreachable by pointing it at a different channel_type.
    (await db()).prepare('DELETE FROM user_dms WHERE user_id = ?').run('telegram:owner');
    await upsertUser({ id: 'telegram:second', kind: 'telegram', display_name: 'Second', created_at: now() });
    await grantRole({
      user_id: 'telegram:second',
      role: 'owner',
      agent_group_id: null,
      granted_by: 'telegram:owner',
      granted_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-dm-second',
      channel_type: 'telegram',
      instance: 'telegram-owner-bot',
      platform_id: 'dm-second',
      name: 'Second DM',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    (await db())
      .prepare(
        `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('telegram:second', 'telegram', 'mg-dm-second', now());

    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('hello'));
    await waitForDeliveries(2);

    // The notice goes to the reachable owner...
    expect(deliverMock.mock.calls[1][1]).toBe('dm-second');
    // ...so the stranger must be told THAT owner's name. Naming the first
    // owner on the books would disclose the wrong person to someone we are
    // refusing, and contradict who was actually notified.
    expect(JSON.parse(deliverMock.mock.calls[0][4] as string).text).toBe(
      "I'm Second's personal agent — I can't help you directly.",
    );
  });

  it('resolves the owner DM on the origin adapter instance', async () => {
    // The FYI dispatches on the resolved row's exact instance key. If the row
    // has to be cold-created it must be stamped with the origin's instance,
    // or on a named-instance install it names an adapter that does not exist
    // and the owner silently misses the notice for 24h.
    // A stranger DM arriving on a NAMED adapter instance. Built as its own
    // row rather than mutated onto the shared fixture: `instance` is fixed at
    // creation, and inbound lookup is exact-on-instance, so the row and the
    // event have to agree or the router auto-creates a separate default row.
    await createMessagingGroup({
      id: 'mg-dm-named',
      channel_type: 'telegram',
      instance: 'telegram-owner-bot',
      platform_id: 'dm-named',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'decline_notify',
      created_at: now(),
    });
    await createMessagingGroupAgent({
      id: 'mga-named',
      messaging_group_id: 'mg-dm-named',
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
    await routeInbound({ ...strangerDm('hello'), platformId: 'dm-named', instance: 'telegram-owner-bot' });
    await waitForDeliveries(2);

    expect(ensureUserDmCalls).toContainEqual({ userId: 'telegram:owner', instance: 'telegram-owner-bot' });
  });

  it('uses the generic label when the reachable owner has no display name', async () => {
    // The named owner must come from the person actually notified. When that
    // owner has no display_name, falling back to another owner's name would
    // reintroduce the mismatch — say "my owner" instead.
    (await db()).prepare('DELETE FROM user_dms WHERE user_id = ?').run('telegram:owner');
    await upsertUser({ id: 'telegram:nameless', kind: 'telegram', display_name: null, created_at: now() });
    await grantRole({
      user_id: 'telegram:nameless',
      role: 'owner',
      agent_group_id: null,
      granted_by: 'telegram:owner',
      granted_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-dm-nameless',
      channel_type: 'telegram',
      instance: 'telegram-owner-bot',
      platform_id: 'dm-nameless',
      name: 'Nameless DM',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    (await db())
      .prepare(
        `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('telegram:nameless', 'telegram', 'mg-dm-nameless', now());

    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('hello'));
    await waitForDeliveries(2);

    // The notice goes to the nameless owner...
    expect(deliverMock.mock.calls[1][1]).toBe('dm-nameless');
    // ...so the decline must not name the other owner ('Owner').
    const declineText = JSON.parse(deliverMock.mock.calls[0][4] as string).text;
    expect(declineText).toBe("I'm my owner's personal agent — I can't help you directly.");
    expect(declineText).not.toContain('Owner');
  });

  it('sends the FYI to the owner, not to the admin the approval card would go to', async () => {
    // A scoped admin of ag-1 with a reachable DM. pickApprover puts this
    // user FIRST (scoped admins → global admins → owners), so a card would
    // land here; the personal FYI must not.
    await upsertUser({ id: 'telegram:admin', kind: 'telegram', display_name: 'Admin', created_at: now() });
    await grantRole({
      user_id: 'telegram:admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: 'telegram:owner',
      granted_at: now(),
    });
    await createMessagingGroup({
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
    expect((await pickApprover('ag-1'))[0]).toBe('telegram:admin');

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
    await updateMessagingGroup('mg-dm-stranger', { unknown_sender_policy: 'request_approval' });
    const { routeInbound } = await import('../../router.js');
    const carded = strangerDm('let me in, my token is abc123');
    await routeInbound(carded);
    await waitForDeliveries(1);

    const card = (await db())
      .prepare(`SELECT original_message FROM pending_sender_approvals WHERE id LIKE 'nsa-%'`)
      .get() as { original_message: string };
    expect(card.original_message).toContain('abc123'); // the card legitimately retains it for replay

    await updateMessagingGroup('mg-dm-stranger', { unknown_sender_policy: 'decline_notify' });
    await routeInbound(strangerDm('hello?'));
    await waitForDeliveries(3);

    const stamp = (await db())
      .prepare(`SELECT original_message FROM pending_sender_approvals WHERE id LIKE 'decline:%'`)
      .get() as { original_message: string };
    expect(stamp.original_message).toBe('{"declined":true}');

    // The conversion destroys the retained event, which is the only thing
    // that could ever resolve the carded message's ingress receipt. Leaving
    // it `deferred` would strand it until the seven-day prune, so the
    // conversion has to close it out first.
    const receipt = (await db())
      .prepare('SELECT status FROM channel_ingress_receipts WHERE message_id = ?')
      .get(carded.message.id) as { status: string } | undefined;
    expect(receipt?.status).toBe('completed');
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
