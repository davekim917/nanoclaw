/**
 * Acceptance cases for the Slack room actions (theme T6 PR 5).
 *
 * Fork-only file by design: these are the fork's own criteria (t6-scope §5
 * cases 11 and 12 plus the four the brief adds), and upstream owns no test
 * they belong in. Seeded through `initMigratedTestDb()` so the raw-db pin
 * does not move.
 *
 * The whole flow is driven through the REGISTERED delivery entry
 * (`getDeliveryAction`), not by calling the bodies directly: precheck → guard
 * → deny/hold/allow is the thing under test, and calling a body directly
 * would test a path production never takes.
 *
 * Slack is stubbed at the adapter's narrow call surface. No test in this file
 * reaches the network: `createConversation` and `inviteUsers` are the only two
 * Slack calls the module can make, and both are mocked here.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initMigratedTestDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent, getMessagingGroupAgents } from '../../db/messaging-groups.js';
import { registerSlackBot, unregisterSlackBot, type SlackBotIdentity } from '../../channels/slack-mentions.js';
import type { MessagingGroup, MessagingGroupAgent, PendingApproval, Session } from '../../types.js';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-slack-rooms') }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: `${TEST_DIR}/groups` };
});

// The two Slack calls the module can make — stubbed so nothing leaves the box.
const defaultCreateConversation = async (_instance: string, opts: { name: string; isPrivate?: boolean }) => ({
  channelId: 'CROOM1',
  name: opts.name.toLowerCase().replace(/\s+/g, '-'),
});
const defaultSetPurpose = async (_instance: string, _channelId: string, purpose: string) => purpose.trim() !== '';
const createConversationMock = vi.fn(defaultCreateConversation);
const inviteUsersMock = vi.fn(async (_instance: string, _channelId: string, _userIds: string[]) => {});
const setPurposeMock = vi.fn(defaultSetPurpose);
vi.mock('../../channels/slack.js', () => ({
  createConversation: (...args: Parameters<typeof createConversationMock>) => createConversationMock(...args),
  inviteUsers: (...args: Parameters<typeof inviteUsersMock>) => inviteUsersMock(...args),
  setConversationPurpose: (...args: Parameters<typeof setPurposeMock>) => setPurposeMock(...args),
  isSlackNameTaken: (err: unknown) => err instanceof Error && err.message.includes('name_taken'),
}));

const notifyAgentMock = vi.fn(async (_session: Session, _text: string) => {});
const requestApprovalMock = vi.fn(async (_opts: Record<string, unknown>) => true);
vi.mock('../approvals/index.js', () => ({
  notifyAgent: (...args: Parameters<typeof notifyAgentMock>) => notifyAgentMock(...args),
  requestApproval: (...args: Parameters<typeof requestApprovalMock>) => requestApprovalMock(...args),
  registerApprovalHandler: vi.fn(),
}));
vi.mock('../approvals/primitive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../approvals/primitive.js')>()),
  pickApprover: vi.fn(async () => ['slack-alpha:UOWNER']),
}));

const { getDeliveryAction } = await import('../../delivery.js');
await import('./index.js');

function now(): string {
  return new Date().toISOString();
}

const ALPHA: SlackBotIdentity = { userId: 'UALPHA', username: 'alpha', teamId: 'T1' };
const BETA: SlackBotIdentity = { userId: 'UBETA', username: 'beta', teamId: 'T1' };
const GAMMA: SlackBotIdentity = { userId: 'UGAMMA', username: 'gamma', teamId: 'T1' };
const FOREIGN: SlackBotIdentity = { userId: 'UFOREIGN', username: 'foreign', teamId: 'T2' };

/**
 * The Slack bot registry is module-global and `unregisterSlackBot` only
 * deletes on OBJECT identity, so a case that registers a variant identity
 * (same channel type, different team) leaks it into every later case — which
 * is exactly how a two-workspace fixture silently became a one-workspace one.
 * Every registration in this file goes through here, and afterEach undoes them
 * newest-first so a channel type registered twice ends up genuinely absent.
 */
const registeredBots: Array<[string, SlackBotIdentity]> = [];
function useBot(channelType: string, identity: SlackBotIdentity): void {
  registeredBots.push([channelType, identity]);
  registerSlackBot(channelType, identity);
}

async function makeWorkgroup(id: string): Promise<void> {
  await getDb().run('INSERT INTO workgroups (id, onecli_secrets, created_at) VALUES (?, ?, ?)', id, '[]', now());
}

/** An agent group with a Slack bot on `channelType`, wired to its own DM row. */
async function makeAgent(opts: {
  id: string;
  folder: string;
  workgroup: string;
  channelType: string;
  identity: SlackBotIdentity;
}): Promise<void> {
  await createAgentGroup({
    id: opts.id,
    name: opts.folder,
    folder: opts.folder,
    agent_provider: null,
    created_at: now(),
    workgroup_id: opts.workgroup,
  });
  useBot(opts.channelType, opts.identity);
  await wire(`mg-dm-${opts.id}`, opts.channelType, `slack:D-${opts.id}`, null, 0, opts.id);
}

/** A messaging-group row plus (optionally) one wiring. */
async function wire(
  mgId: string,
  channelType: string,
  platformId: string,
  name: string | null,
  isGroup: 0 | 1,
  agentGroupId: string | null,
): Promise<MessagingGroup> {
  const mg: MessagingGroup = {
    id: mgId,
    channel_type: channelType,
    platform_id: platformId,
    instance: channelType,
    name,
    is_group: isGroup,
    unknown_sender_policy: 'public',
    created_at: now(),
  };
  await createMessagingGroup(mg);
  if (agentGroupId) {
    const mga: MessagingGroupAgent = {
      id: `mga-${mgId}-${agentGroupId}`,
      messaging_group_id: mgId,
      agent_group_id: agentGroupId,
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'accumulate',
      session_mode: 'per-thread',
      priority: 0,
      default_model: null,
      default_effort: null,
      default_tone: null,
      instructions_profile: null,
      created_at: now(),
    };
    await createMessagingGroupAgent(mga);
  }
  return mg;
}

/** A destination so the caller can name `target` the way send_message does. */
async function destination(from: string, localName: string, to: string): Promise<void> {
  await getDb().run(
    `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, ?, 'agent', ?, ?)`,
    from,
    localName,
    to,
    now(),
  );
}

/**
 * A real `sessions` row — `pending_approvals.session_id` is a foreign key, so
 * the replay case cannot run against a fabricated session object.
 */
async function makeSession(agentGroupId: string, messagingGroupId: string): Promise<Session> {
  const row = {
    id: `sess-${agentGroupId}`,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  } as unknown as Session;
  const { createSession } = await import('../../db/sessions.js');
  await createSession(row);
  return row;
}

/** The pending_approvals row a hold would have written, as a grant. */
function grantFrom(action: string): PendingApproval {
  const opts = requestApprovalMock.mock.calls.at(-1)![0] as { payload: Record<string, unknown> };
  return {
    approval_id: 'appr-1',
    session_id: 'sess-ag-caller',
    agent_group_id: 'ag-caller',
    request_id: 'appr-1',
    action,
    payload: JSON.stringify(opts.payload),
    created_at: now(),
  } as unknown as PendingApproval;
}

/** Insert that grant so the guard's live-row check finds it. */
async function persistGrant(grant: PendingApproval): Promise<PendingApproval> {
  const { createPendingApproval } = await import('../../db/sessions.js');
  await createPendingApproval({
    ...grant,
    title: 't',
    question: 'q',
    options_json: '[]',
  } as unknown as PendingApproval);
  return grant;
}

const lastNotice = (): string => String(notifyAgentMock.mock.calls.at(-1)?.[1] ?? '');

let callerSession: Session;

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();
  // mockReset, not mockClear: a `mockImplementationOnce` that a case never
  // consumes survives mockClear and fires inside the NEXT case.
  createConversationMock.mockReset();
  createConversationMock.mockImplementation(defaultCreateConversation);
  inviteUsersMock.mockReset();
  setPurposeMock.mockReset();
  setPurposeMock.mockImplementation(defaultSetPurpose);
  notifyAgentMock.mockClear();
  requestApprovalMock.mockClear();
});

afterEach(async () => {
  for (const [channelType, identity] of registeredBots.splice(0).reverse()) {
    unregisterSlackBot(channelType, identity);
  }
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// ── create_room ──

describe('create_room', () => {
  beforeEach(async () => {
    await makeWorkgroup('home');
    await makeAgent({
      id: 'ag-caller',
      folder: 'caller',
      workgroup: 'home',
      channelType: 'slack-alpha',
      identity: ALPHA,
    });
    await makeAgent({ id: 'ag-mate', folder: 'mate', workgroup: 'home', channelType: 'slack-beta', identity: BETA });
    await destination('ag-caller', 'mate', 'ag-mate');
    callerSession = await makeSession('ag-caller', 'mg-dm-ag-caller');
  });

  it('create_room persists a messaging group wired to every participant and the caller', async () => {
    await getDb().run(
      `INSERT INTO container_configs (agent_group_id, cli_scope, updated_at) VALUES (?, 'global', ?)`,
      'ag-caller',
      now(),
    );

    await getDeliveryAction('create_room')!(
      { action: 'create_room', name: 'Ops Room', agents: ['mate'] },
      callerSession,
    );

    expect(createConversationMock).toHaveBeenCalledWith('slack-alpha', { name: 'Ops Room', isPrivate: true });
    // The invite carries the OTHER bot plus the operator, never the creator.
    expect(inviteUsersMock).toHaveBeenCalledWith('slack-alpha', 'CROOM1', ['UBETA', 'UOWNER']);

    const rows = await getDb().all<MessagingGroup>(
      `SELECT * FROM messaging_groups WHERE platform_id = 'slack:CROOM1' ORDER BY channel_type`,
    );
    // One row PER participating bot channel type — the fork's routing key is
    // (channel_type, platform_id, instance), so a single shared row would be
    // heard by exactly one bot.
    expect(rows.map((r) => r.channel_type)).toEqual(['slack-alpha', 'slack-beta']);
    expect(rows.every((r) => r.instance === r.channel_type && r.is_group === 1 && r.name === 'ops-room')).toBe(true);
    // The room the operator just approved must not put its own members behind
    // a sender-approval cascade — same policy the router's group auto-create
    // branch lands on, resolved through the one helper so the two agree.
    expect(rows.every((r) => r.unknown_sender_policy === 'public')).toBe(true);

    for (const row of rows) {
      const wirings = await getMessagingGroupAgents(row.id);
      expect(wirings).toHaveLength(1);
      expect(wirings[0]!.session_mode).toBe('per-thread');
      expect(wirings[0]!.ignored_message_policy).toBe('accumulate');
    }
    expect(
      (
        await getDb().all<{ agent_group_id: string }>(
          `SELECT mga.agent_group_id FROM messaging_group_agents mga
           JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
          WHERE mg.platform_id = 'slack:CROOM1' ORDER BY mga.agent_group_id`,
        )
      ).map((r) => r.agent_group_id),
    ).toEqual(['ag-caller', 'ag-mate']);
  });

  it('adopts a room it already has under that name instead of dying on Slack name_taken', async () => {
    await getDb().run(
      `INSERT INTO container_configs (agent_group_id, cli_scope, updated_at) VALUES (?, 'global', ?)`,
      'ag-caller',
      now(),
    );
    // Residue of a run that created the channel and wired the caller, then
    // failed. conversations.create would answer name_taken forever.
    await wire('mg-half', 'slack-alpha', 'slack:CHALF', 'ops-room', 1, 'ag-caller');

    await getDeliveryAction('create_room')!(
      { action: 'create_room', name: 'ops-room', agents: ['mate'] },
      callerSession,
    );

    expect(createConversationMock).not.toHaveBeenCalled();
    expect(inviteUsersMock).toHaveBeenCalledWith('slack-alpha', 'CHALF', ['UBETA', 'UOWNER']);
    // The missing participant's row is now there; the caller's is adopted.
    expect(
      (
        await getDb().all<MessagingGroup>(
          `SELECT channel_type FROM messaging_groups WHERE platform_id = 'slack:CHALF' ORDER BY channel_type`,
        )
      ).map((r) => r.channel_type),
    ).toEqual(['slack-alpha', 'slack-beta']);
    expect(lastNotice()).toMatch(/already existed/);
  });

  it('reports a Slack channel it cannot adopt rather than telling the agent to retry', async () => {
    await getDb().run(
      `INSERT INTO container_configs (agent_group_id, cli_scope, updated_at) VALUES (?, 'global', ?)`,
      'ag-caller',
      now(),
    );
    createConversationMock.mockImplementationOnce(async () => {
      throw new Error('slack conversations.create failed: name_taken');
    });

    await getDeliveryAction('create_room')!({ action: 'create_room', name: 'ops', agents: ['mate'] }, callerSession);

    expect(lastNotice()).toMatch(/not wired to you/);
    expect(lastNotice()).toMatch(/different name/);
  });

  it('applies the purpose it promised, and says so when Slack refuses it', async () => {
    await getDb().run(
      `INSERT INTO container_configs (agent_group_id, cli_scope, updated_at) VALUES (?, 'global', ?)`,
      'ag-caller',
      now(),
    );

    await getDeliveryAction('create_room')!(
      { action: 'create_room', name: 'Ops Room', agents: ['mate'], purpose: 'ship the release' },
      callerSession,
    );
    expect(setPurposeMock).toHaveBeenCalledWith('slack-alpha', 'CROOM1', 'ship the release');

    setPurposeMock.mockImplementationOnce(async () => false);
    await getDeliveryAction('create_room')!(
      { action: 'create_room', name: 'Second Room', agents: ['mate'], purpose: 'ship the release' },
      callerSession,
    );
    expect(lastNotice()).toMatch(/would not accept the purpose/);
  });

  it('create_room refuses a cross-workspace member', async () => {
    await makeWorkgroup('away');
    await makeAgent({
      id: 'ag-foreign',
      folder: 'foreign',
      workgroup: 'away',
      channelType: 'slack-foreign',
      identity: FOREIGN,
    });
    await destination('ag-caller', 'foreign', 'ag-foreign');

    await getDeliveryAction('create_room')!(
      { action: 'create_room', name: 'Ops Room', agents: ['foreign'] },
      callerSession,
    );

    expect(lastNotice()).toMatch(/span 2 Slack workspaces/);
    // Refused in the precheck: no Slack call, and no card for an admin to read.
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(requestApprovalMock).not.toHaveBeenCalled();
  });

  it('holds for approval when the caller is not a trusted global-scope group', async () => {
    await getDeliveryAction('create_room')!(
      { action: 'create_room', name: 'Ops Room', agents: ['mate'] },
      callerSession,
    );

    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    expect(createConversationMock).not.toHaveBeenCalled();
  });
});

// ── add_to_room ──

describe('add_to_room', () => {
  beforeEach(async () => {
    await makeWorkgroup('home');
    await makeWorkgroup('away');
    await makeAgent({
      id: 'ag-caller',
      folder: 'caller',
      workgroup: 'home',
      channelType: 'slack-alpha',
      identity: ALPHA,
    });
    await makeAgent({ id: 'ag-mate', folder: 'mate', workgroup: 'home', channelType: 'slack-beta', identity: BETA });
    await destination('ag-caller', 'mate', 'ag-mate');
    // The caller's room, wired to the caller only.
    await wire('mg-room-home', 'slack-alpha', 'slack:CHOME', 'ops', 1, 'ag-caller');
    callerSession = await makeSession('ag-caller', 'mg-dm-ag-caller');
  });

  it('add_to_room with two workgroups holding a same-named room picks the caller’s, or errors on ambiguity; never the other workgroup’s', async () => {
    // Another workgroup owns a room with the SAME name. Upstream would scan
    // every messaging group and take the newest match — this one.
    await makeAgent({
      id: 'ag-outsider',
      folder: 'outsider',
      workgroup: 'away',
      channelType: 'slack-foreign',
      identity: FOREIGN,
    });
    await wire('mg-room-away', 'slack-foreign', 'slack:CAWAY', 'ops', 1, 'ag-outsider');

    await getDeliveryAction('add_to_room')!({ action: 'add_to_room', room: 'ops', agent: 'mate' }, callerSession);

    // Sibling add — allowed unheld — and it landed on the caller's room.
    expect(requestApprovalMock).not.toHaveBeenCalled();
    expect(inviteUsersMock).toHaveBeenCalledWith('slack-alpha', 'CHOME', ['UBETA']);
    expect(
      await getDb().get(
        `SELECT id FROM messaging_groups WHERE platform_id = 'slack:CAWAY' AND channel_type = 'slack-beta'`,
      ),
    ).toBeUndefined();

    // A SECOND room named "ops" inside the caller's own workgroup is the
    // ambiguity case: no "newest wins" tie-break, an error naming both.
    inviteUsersMock.mockClear();
    await wire('mg-room-home-2', 'slack-alpha', 'slack:CHOME2', 'ops', 1, 'ag-caller');

    await getDeliveryAction('add_to_room')!({ action: 'add_to_room', room: 'ops', agent: 'mate' }, callerSession);

    expect(lastNotice()).toMatch(/ambiguous/);
    expect(lastNotice()).toContain('slack:CHOME');
    expect(lastNotice()).toContain('slack:CHOME2');
    expect(inviteUsersMock).not.toHaveBeenCalled();
  });

  it('an approved add_to_room replay binds to the room id, not the name', async () => {
    await makeAgent({
      id: 'ag-outsider',
      folder: 'outsider',
      workgroup: 'away',
      channelType: 'slack-foreign',
      identity: FOREIGN,
    });
    // The outsider is reachable by name but is NOT a sibling, so it holds.
    await destination('ag-caller', 'outsider', 'ag-outsider');
    // Put the outsider's bot in the caller's workspace so the cross-workspace
    // refusal is not what this case measures.
    useBot('slack-foreign', { ...FOREIGN, teamId: 'T1' });

    await getDeliveryAction('add_to_room')!({ action: 'add_to_room', room: 'ops', agent: 'outsider' }, callerSession);
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    const held = requestApprovalMock.mock.calls[0]![0] as { payload: Record<string, unknown> };
    expect(held.payload.room_platform_id).toBe('slack:CHOME');

    // While the card sits unanswered the name moves: the carded room is
    // renamed and a NEWER room takes the name "ops". Re-resolving by name at
    // approve time would redirect the invite to CLATER.
    await getDb().run(`UPDATE messaging_groups SET name = 'ops-archive' WHERE platform_id = 'slack:CHOME'`);
    await wire('mg-room-later', 'slack-alpha', 'slack:CLATER', 'ops', 1, 'ag-caller');

    const grant = await persistGrant(grantFrom('add_to_room'));
    const { reenterGuardedDeliveryAction } = await import('../../delivery.js');
    await reenterGuardedDeliveryAction('add_to_room')({
      session: callerSession,
      payload: JSON.parse(grant.payload) as Record<string, unknown>,
      approval: grant,
    });

    expect(inviteUsersMock).toHaveBeenCalledTimes(1);
    expect(inviteUsersMock).toHaveBeenCalledWith('slack-alpha', 'CHOME', ['UFOREIGN']);
    const landed = await getDb().all<MessagingGroup>(
      `SELECT platform_id FROM messaging_groups WHERE channel_type = 'slack-foreign' AND is_group = 1`,
    );
    expect(landed.map((r) => r.platform_id)).toEqual(['slack:CHOME']);
  });

  it('a non-sibling add_to_room holds for approval; a sibling add is allowed', async () => {
    await makeAgent({
      id: 'ag-outsider',
      folder: 'outsider',
      workgroup: 'away',
      channelType: 'slack-foreign',
      identity: { ...FOREIGN, teamId: 'T1' },
    });
    await destination('ag-caller', 'outsider', 'ag-outsider');

    await getDeliveryAction('add_to_room')!({ action: 'add_to_room', room: 'ops', agent: 'outsider' }, callerSession);
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    expect(inviteUsersMock).not.toHaveBeenCalled();

    await getDeliveryAction('add_to_room')!({ action: 'add_to_room', room: 'ops', agent: 'mate' }, callerSession);
    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    expect(inviteUsersMock).toHaveBeenCalledWith('slack-alpha', 'CHOME', ['UBETA']);
  });

  it('invites through a bot that is in the room, not the caller’s, when the room is a sibling’s', async () => {
    // The room is wired only to the sibling. The caller can name it (same
    // workgroup) but its own bot is not a member, so inviting through the
    // caller would fail with not_in_channel.
    await makeAgent({
      id: 'ag-third',
      folder: 'third',
      workgroup: 'home',
      channelType: 'slack-gamma',
      identity: GAMMA,
    });
    await destination('ag-caller', 'third', 'ag-third');
    await wire('mg-room-sib', 'slack-beta', 'slack:CSIB', 'sibs', 1, 'ag-mate');

    await getDeliveryAction('add_to_room')!({ action: 'add_to_room', room: 'sibs', agent: 'third' }, callerSession);

    expect(inviteUsersMock).toHaveBeenCalledWith('slack-beta', 'CSIB', ['UGAMMA']);
    expect(
      await getDb().get(
        `SELECT id FROM messaging_groups WHERE platform_id = 'slack:CSIB' AND channel_type = 'slack-gamma'`,
      ),
    ).toBeDefined();
  });

  it('accepts a Slack channel id through the public room argument, as the ambiguity error tells it to', async () => {
    await wire('mg-room-home-2', 'slack-alpha', 'slack:CHOME2', 'ops', 1, 'ag-caller');

    // The name is ambiguous, which is exactly when an agent is told to use an id.
    await getDeliveryAction('add_to_room')!({ action: 'add_to_room', room: 'ops', agent: 'mate' }, callerSession);
    expect(lastNotice()).toMatch(/ambiguous/);
    expect(inviteUsersMock).not.toHaveBeenCalled();

    await getDeliveryAction('add_to_room')!(
      { action: 'add_to_room', room: 'slack:CHOME2', agent: 'mate' },
      callerSession,
    );
    expect(inviteUsersMock).toHaveBeenCalledWith('slack-alpha', 'CHOME2', ['UBETA']);

    // The bare spelling resolves to the same room: the answer is now "already
    // in room", which only the correct room can produce.
    inviteUsersMock.mockClear();
    await getDeliveryAction('add_to_room')!({ action: 'add_to_room', room: 'CHOME2', agent: 'mate' }, callerSession);
    expect(lastNotice()).toMatch(/already in room/);
    expect(inviteUsersMock).not.toHaveBeenCalled();
  });

  it('keys a room by workspace as well as channel id, so one id in two workspaces is two rooms', async () => {
    // Slack channel ids are workspace-scoped and this host runs several
    // workspaces, so the same id can name two unrelated channels.
    await makeAgent({
      id: 'ag-third',
      folder: 'third',
      workgroup: 'home',
      channelType: 'slack-gamma',
      identity: GAMMA,
    });
    await makeAgent({
      id: 'ag-far',
      folder: 'far',
      workgroup: 'home',
      channelType: 'slack-foreign',
      identity: FOREIGN,
    });
    await destination('ag-caller', 'third', 'ag-third');
    await wire('mg-dup-t1', 'slack-alpha', 'slack:CDUP', 'dup', 1, 'ag-caller');
    await wire('mg-dup-t2', 'slack-foreign', 'slack:CDUP', 'dup', 1, 'ag-far');

    const { candidateRooms } = await import('./resolve.js');
    const rooms = (await candidateRooms('ag-caller')).filter((r) => r.platformId === 'slack:CDUP');
    expect(rooms).toHaveLength(2);
    expect(rooms.map((r) => r.teamId).sort()).toEqual(['T1', 'T2']);

    // Naming it by id is therefore ambiguous rather than a coin flip.
    await getDeliveryAction('add_to_room')!(
      { action: 'add_to_room', room: 'slack:CDUP', agent: 'third' },
      callerSession,
    );
    expect(lastNotice()).toMatch(/Slack workspaces/);
    expect(inviteUsersMock).not.toHaveBeenCalled();
  });

  it('refuses a room outside the caller’s workgroup even when named exactly', async () => {
    await makeAgent({
      id: 'ag-outsider',
      folder: 'outsider',
      workgroup: 'away',
      channelType: 'slack-foreign',
      identity: FOREIGN,
    });
    await wire('mg-room-away', 'slack-foreign', 'slack:CAWAY', 'secrets', 1, 'ag-outsider');

    await getDeliveryAction('add_to_room')!({ action: 'add_to_room', room: 'secrets', agent: 'mate' }, callerSession);

    expect(lastNotice()).toMatch(/no Slack room named "secrets"/);
    expect(inviteUsersMock).not.toHaveBeenCalled();
  });

  it('refuses a caller-supplied channel id outside the candidate set', async () => {
    // Naming a room by id skips NAME resolution, never authorization: the id
    // is validated against the same candidate set.
    await makeAgent({
      id: 'ag-outsider',
      folder: 'outsider',
      workgroup: 'away',
      channelType: 'slack-foreign',
      identity: FOREIGN,
    });
    await wire('mg-room-away', 'slack-foreign', 'slack:CAWAY', 'secrets', 1, 'ag-outsider');

    await getDeliveryAction('add_to_room')!(
      { action: 'add_to_room', room: 'ops', agent: 'mate', room_platform_id: 'slack:CAWAY' },
      callerSession,
    );

    expect(lastNotice()).toMatch(/no longer wired to you/);
    expect(inviteUsersMock).not.toHaveBeenCalled();
  });

  it('cannot be talked into a sibling allow by a forged workgroup claim', async () => {
    await makeAgent({
      id: 'ag-outsider',
      folder: 'outsider',
      workgroup: 'away',
      channelType: 'slack-foreign',
      identity: { ...FOREIGN, teamId: 'T1' },
    });
    await destination('ag-caller', 'outsider', 'ag-outsider');

    await getDeliveryAction('add_to_room')!(
      // The container controls every key it writes; the precheck overwrites
      // both workgroup stamps from live rows before the guard reads them.
      { action: 'add_to_room', room: 'ops', agent: 'outsider', caller_workgroup_id: 'x', target_workgroup_id: 'x' },
      callerSession,
    );

    expect(requestApprovalMock).toHaveBeenCalledTimes(1);
    expect(inviteUsersMock).not.toHaveBeenCalled();
  });
});
