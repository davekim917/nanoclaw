/**
 * request_choice host side: delivery action → approvals-backed card → click
 * authority → one host-marked line in the right session, which is woken → the
 * card edited to show the answer.
 *
 * Real central DB, real approvals response handler, and a live fake channel
 * adapter with threads on, so the router's thread policy applies. The delivery
 * adapter is a recorder, writeSessionMessage is mocked to read back what each
 * session is told, and wakeContainer is mocked to observe wakes.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { registerSlackBot, unregisterSlackBot } from '../../channels/slack-mentions.js';
import { wakeContainer } from '../../container-runner.js';
import { closeDb, getDb, initMigratedTestDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import {
  createSession,
  findSessionForAgent,
  getPendingApproval,
  getPendingApprovalsByAction,
} from '../../db/sessions.js';
import { getDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { sessionMessageExists, writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { createDestination } from '../agent-to-agent/db/agent-destinations.js';
import { registerApprovalHandler, requestApproval } from '../approvals/primitive.js';
import { handleApprovalsResponse, resolveApprovalFromHost } from '../approvals/response-handler.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { formatChoiceResponse, REQUEST_CHOICE_ACTION, SUPERSEDED_LINE } from './choice.js';

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn(), sessionMessageExists: vi.fn().mockResolvedValue(false) };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-request-choice') }));

// A Slack variant (isChannelVariant, types.ts:194-196), so the Slack
// thread-id composition applies, under its own registry key.
const CHANNEL = 'slack-fixture';
const SIBLING = 'slack-fixture-sibling';
const OWN = 'slack:chan-1';
const OWN_THREAD = 'slack:chan-1:100.1';
const RELEASE = 'slack:chan-2';
const OTHER = 'slack:chan-3';
const ADMIN = `${CHANNEL}:admin-1`;
const ADMIN_TWO = `${CHANNEL}:admin-2`;
const MEMBER = `${CHANNEL}:member-1`;
const OPTIONS = [
  { label: 'Ship A', value: 'ship-a', style: 'primary' },
  { label: 'Ship all (2)', value: 'ship-all' },
  { label: 'Hold', value: 'hold', style: 'danger' },
];
const TO_RELEASE = { to: 'release-room', channelType: CHANNEL, platformId: RELEASE };
const ASK_TEXT = 'Release\n\nWhich change ships?';

registerChannelAdapter(CHANNEL, {
  factory: (): ChannelAdapter => ({
    name: CHANNEL,
    channelType: CHANNEL,
    supportsThreads: true,
    async setup() {},
    async teardown() {},
    isConnected: () => true,
    async deliver() {
      return undefined;
    },
  }),
});

interface Delivered {
  channelType: string;
  platformId: string;
  threadId: string | null;
  instance: string | undefined;
  content: Record<string, unknown>;
}

let session: Session;
let taskSession: Session;
let delivered: Delivered[];
let failEdits: boolean;
let failPosts: boolean;

function now(): string {
  return new Date().toISOString();
}

function sessionRow(id: string, agentGroupId: string, mgId: string | null, threadId: string): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: mgId,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
}

/** Every line written into a session, with the session it went to. */
function notes(): Array<{ sessionId: string; text: string }> {
  return vi.mocked(writeSessionMessage).mock.calls.map((call) => ({
    sessionId: call[1],
    text: (JSON.parse(call[2].content) as { text: string }).text,
  }));
}

/** Deliveries after the first `n` (the card posts). */
function after(n: number): Delivered[] {
  return delivered.slice(n);
}

async function ask(
  from: Session,
  extra: Record<string, unknown> = {},
  choiceId = 'choice-1',
): Promise<PendingApproval | undefined> {
  await getDeliveryAction(REQUEST_CHOICE_ACTION)!(
    {
      action: REQUEST_CHOICE_ACTION,
      choiceId,
      title: 'Release',
      question: 'Which change ships?',
      options: OPTIONS,
      ...extra,
    },
    from,
  );
  return (await getPendingApprovalsByAction(REQUEST_CHOICE_ACTION)).find((r) => r.request_id === choiceId);
}

function click(approvalId: string, value: string, handle: string, channelType = CHANNEL): Promise<boolean> {
  return handleApprovalsResponse({
    questionId: approvalId,
    value,
    userId: handle.slice(channelType.length + 1),
    channelType,
    platformId: '',
    threadId: null,
  });
}

async function wire(mgId: string): Promise<void> {
  await createMessagingGroupAgent({
    id: `mga-${mgId}`,
    messaging_group_id: mgId,
    agent_group_id: 'ag-1',
    engage_mode: 'mention',
    engage_pattern: null,
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
}

async function destinationOnly(mgId: string, name: string): Promise<void> {
  await createDestination({
    agent_group_id: 'ag-1',
    local_name: name,
    target_type: 'channel',
    target_id: mgId,
    created_at: now(),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(sessionMessageExists).mockResolvedValue(false);
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));

  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  await createAgentGroup({ id: 'ag-2', name: 'Other', folder: 'other', agent_provider: null, created_at: now() });
  for (const [id, platformId, name] of [
    ['mg-1', OWN, 'Team room'],
    ['mg-2', RELEASE, 'Release room'],
    ['mg-3', OTHER, 'Other room'],
  ]) {
    await createMessagingGroup({
      id,
      channel_type: CHANNEL,
      platform_id: platformId,
      name,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  }
  session = sessionRow('sess-1', 'ag-1', 'mg-1', OWN_THREAD);
  await createSession(session);
  taskSession = sessionRow('sess-task', 'ag-1', null, 'system:tasks:watch-1');
  await createSession(taskSession);

  // Two admins of ag-1, and a thread member with no role.
  for (const [id, name] of [
    [ADMIN, 'Admin One'],
    [ADMIN_TWO, 'Admin Two'],
  ]) {
    await upsertUser({ id, kind: CHANNEL, display_name: name, created_at: now() });
    await grantRole({ user_id: id, role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
  }
  await upsertUser({ id: MEMBER, kind: CHANNEL, display_name: 'Member One', created_at: now() });

  delivered = [];
  failEdits = false;
  failPosts = false;
  let seq = 0;
  setDeliveryAdapter({
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      _kind: string,
      content: string,
      _files?: unknown,
      instance?: string,
    ) {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      delivered.push({ channelType, platformId, threadId, instance, content: parsed });
      if (failEdits && parsed.operation === 'edit') throw new Error('platform down');
      if (failPosts && parsed.type === 'ask_question') throw new Error('platform down');
      seq += 1;
      return `pm-${seq}`;
    },
  });
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('request_choice delivery', () => {
  it('posts an in-thread card with one button per option and opens a pending row', async () => {
    const row = (await ask(session))!;

    expect(row).toMatchObject({
      session_id: 'sess-1',
      agent_group_id: 'ag-1',
      request_id: 'choice-1',
      status: 'pending',
      channel_type: CHANNEL,
      platform_id: OWN,
      thread_id: OWN_THREAD,
      platform_message_id: 'pm-1',
      approver_user_id: null,
    });
    // The row's options are what the bridge decodes a click against.
    expect((JSON.parse(row.options_json) as Array<{ value: string }>).map((o) => o.value)).toEqual([
      'ship-a',
      'ship-all',
      'hold',
    ]);

    expect(delivered).toHaveLength(1);
    const [card] = delivered;
    expect(card).toMatchObject({ channelType: CHANNEL, platformId: OWN, threadId: OWN_THREAD });
    expect(card.content).toMatchObject({
      type: 'ask_question',
      questionId: row.approval_id,
      title: 'Release',
      question: 'Which change ships?',
    });
    const buttons = card.content.options as Array<{ label: string; value: string; style?: string }>;
    expect(buttons.map((b) => [b.label, b.value, b.style])).toEqual([
      ['Ship A', 'ship-a', 'primary'],
      ['Ship all (2)', 'ship-all', undefined],
      ['Hold', 'hold', 'danger'],
    ]);
    expect(notes()).toEqual([]);
  });

  it('refuses a malformed request without opening a row', async () => {
    expect(await ask(session, { options: [] })).toBeUndefined();
    expect(delivered).toHaveLength(0);
    expect(notes().map((n) => n.text)).toEqual(['request_choice failed: options must hold 1 to 10 entries']);
  });

  it('from a task session with `to`, posts the card top-level in the destination', async () => {
    await destinationOnly('mg-2', 'release-room');

    const row = (await ask(taskSession, TO_RELEASE))!;

    expect(row).toMatchObject({
      session_id: 'sess-task',
      channel_type: CHANNEL,
      platform_id: RELEASE,
      thread_id: null,
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ channelType: CHANNEL, platformId: RELEASE, threadId: null });
    expect(delivered[0].content).toMatchObject({ type: 'ask_question', questionId: row.approval_id });
  });

  it('refuses a `to` that is not one of the agent’s destinations, whatever routing the container sent', async () => {
    const notListed = await ask(taskSession, { to: 'other-room', channelType: CHANNEL, platformId: OTHER });
    const unknown = await ask(taskSession, { to: 'ghost', channelType: CHANNEL, platformId: 'slack:chan-9' }, 'c-2');

    expect(notListed).toBeUndefined();
    expect(unknown).toBeUndefined();
    expect(delivered).toHaveLength(0);
    expect(notes().map((n) => n.text)).toEqual([
      'request_choice failed: "other-room" is not one of your destinations.',
      'request_choice failed: "ghost" is not one of your destinations.',
    ]);
  });
});

describe('request_choice click authority and resolution', () => {
  it('relays an admin click as one host-marked line, wakes the session, resolves the row, then edits the card', async () => {
    const row = (await ask(session))!;

    expect(await click(row.approval_id, 'ship-all', ADMIN)).toBe(true);

    expect(notes()).toEqual([
      {
        sessionId: 'sess-1',
        text: 'choice_response choice_id=choice-1 value=ship-all label=Ship%20all%20(2) user_id=slack-fixture%3Aadmin-1 user_name=Admin%20One',
      },
    ]);
    const [, , message, options] = vi.mocked(writeSessionMessage).mock.calls[0];
    expect(message.kind).toBe('chat');
    expect(message.id).toBe(`choice-answer-${row.approval_id}`);
    expect(JSON.parse(message.content)).toMatchObject({ origin: 'host' });
    expect(options).toEqual({ hostOrigin: true });
    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(wakeContainer).mock.calls[0][0].id).toBe('sess-1');
    expect(await getPendingApproval(row.approval_id)).toBeUndefined();
    // The host's edit is the only one: the bridge leaves answer cards alone.
    expect(after(1)).toHaveLength(1);
    expect(after(1)[0]).toMatchObject({ instance: row.instance ?? CHANNEL });
    expect(after(1)[0].content).toEqual({
      operation: 'edit',
      messageId: 'pm-1',
      text: `${ASK_TEXT}\n\n✅ Ship all (2) — Admin One`,
    });
  });

  it('ignores a non-admin thread member: nothing is sent, the row stays pending, the card is untouched', async () => {
    const row = (await ask(session))!;

    expect(await click(row.approval_id, 'ship-a', MEMBER)).toBe(true);

    expect(notes()).toEqual([]);
    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
    expect((await getPendingApproval(row.approval_id))?.status).toBe('pending');
    expect(after(1)).toEqual([]);

    // The same card still answers for an admin.
    await click(row.approval_id, 'hold', ADMIN);
    expect(notes()).toHaveLength(1);
    expect(notes()[0].text).toContain('value=hold');
  });

  it('ignores an unknown option without touching the row or the card', async () => {
    const row = (await ask(session))!;

    await click(row.approval_id, 'not-an-option', ADMIN);

    expect(notes()).toEqual([]);
    expect((await getPendingApproval(row.approval_id))?.status).toBe('pending');
    expect(after(1)).toEqual([]);
  });

  it('treats a second click as a no-op', async () => {
    const row = (await ask(session))!;

    await click(row.approval_id, 'hold', ADMIN);
    const secondClaimed = await click(row.approval_id, 'ship-a', ADMIN);

    expect(secondClaimed).toBe(false); // row gone — no handler claims it
    expect(notes()).toHaveLength(1);
    expect(notes()[0].text).toContain('value=hold');
    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
  });

  it('lets exactly one of two racing admin clicks through', async () => {
    const row = (await ask(session))!;

    await Promise.all([click(row.approval_id, 'hold', ADMIN), click(row.approval_id, 'ship-a', ADMIN_TWO)]);

    expect(notes()).toHaveLength(1);
    expect(await getPendingApproval(row.approval_id)).toBeUndefined();
    expect(after(1).filter((d) => d.content.operation === 'edit')).toHaveLength(1);
  });

  it('a click that loses the claim does nothing: no answer and no edit (the winner edits)', async () => {
    for (const status of ['approved', 'expired']) {
      const row = (await ask(session, {}, `c-${status}`))!;
      await getDb().run('UPDATE pending_approvals SET status = ? WHERE approval_id = ?', status, row.approval_id);
      const before = delivered.length;

      await click(row.approval_id, 'hold', ADMIN);

      expect(delivered.length - before).toBe(0);
    }
    expect(notes()).toEqual([]);
  });

  it('with no live session to take the answer, leaves the card open and logs at error', async () => {
    // The card's channel is not wired, so the only candidate is the requester — which has ended.
    const row = (await ask(session))!;
    await getDb().run('UPDATE sessions SET status = ? WHERE id = ?', 'closed', 'sess-1');
    const errorSpy = vi.spyOn(log, 'error');
    try {
      expect(await click(row.approval_id, 'ship-a', ADMIN)).toBe(true);

      expect(notes()).toEqual([]);
      expect((await getPendingApproval(row.approval_id))?.status).toBe('pending');
      expect(after(1)).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(
        'Choice answered but no live session can take it — card left open',
        expect.objectContaining({ approvalId: row.approval_id }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('reopens the card when the answer was not recorded, so a later click can deliver it', async () => {
    const row = (await ask(session))!;
    vi.mocked(writeSessionMessage).mockRejectedValueOnce(new Error('disk full'));

    await click(row.approval_id, 'ship-a', ADMIN);

    expect((await getPendingApproval(row.approval_id))?.status).toBe('pending');
    expect(after(1)).toEqual([]);

    await click(row.approval_id, 'ship-a', ADMIN);
    expect(await getPendingApproval(row.approval_id)).toBeUndefined();
    expect(after(1).map((d) => d.content.operation)).toEqual(['edit']);
  });

  it('treats a recorded answer as delivered even when writing failed after the insert', async () => {
    const row = (await ask(session))!;
    vi.mocked(writeSessionMessage).mockRejectedValueOnce(new Error('wake bookkeeping failed'));
    vi.mocked(sessionMessageExists).mockResolvedValueOnce(true);

    await click(row.approval_id, 'ship-a', ADMIN);

    expect(vi.mocked(sessionMessageExists)).toHaveBeenCalledWith('ag-1', 'sess-1', `choice-answer-${row.approval_id}`);
    expect(await getPendingApproval(row.approval_id)).toBeUndefined();
    expect(after(1).map((d) => d.content.operation)).toEqual(['edit']);
  });

  it('is not resolvable through the approve/reject host path', async () => {
    const row = (await ask(session))!;
    const result = await resolveApprovalFromHost(row.approval_id, 'approve', ADMIN);
    expect(result.resolved).toBe(false);
    expect((await getPendingApproval(row.approval_id))?.status).toBe('pending');
  });
});

describe('request_choice approvers', () => {
  it('a narrowed card refuses an admin who is not listed, and answers for one who is', async () => {
    const row = (await ask(session, { approvers: [ADMIN] }))!;

    await click(row.approval_id, 'ship-a', ADMIN_TWO);
    expect(notes()).toEqual([]);
    expect((await getPendingApproval(row.approval_id))?.status).toBe('pending');
    expect(after(1)).toEqual([]);

    await click(row.approval_id, 'hold', ADMIN);
    expect(notes()).toHaveLength(1);
    expect(notes()[0].text).toContain('user_id=slack-fixture%3Aadmin-1');
  });

  it('matches a listed Slack id through a same-workspace sibling instance', async () => {
    const own = { userId: 'UBOT1', userName: 'bot', teamId: 'T-fixture' } as never;
    const sibling = { userId: 'UBOT2', userName: 'bot-two', teamId: 'T-fixture' } as never;
    registerSlackBot(CHANNEL, own);
    registerSlackBot(SIBLING, sibling);
    try {
      const row = (await ask(session, { approvers: [ADMIN] }))!;

      await click(row.approval_id, 'hold', `${SIBLING}:admin-1`, SIBLING);

      expect(notes()).toHaveLength(1);
      expect(notes()[0].text).toContain('user_id=slack-fixture-sibling%3Aadmin-1');
    } finally {
      unregisterSlackBot(CHANNEL, own);
      unregisterSlackBot(SIBLING, sibling);
    }
  });

  it('refuses a card that names an approver without admin privilege', async () => {
    expect(await ask(session, { approvers: [ADMIN, MEMBER] })).toBeUndefined();
    expect(delivered).toHaveLength(0);
    expect(notes().map((n) => n.text)).toEqual([
      `request_choice failed: approver "${MEMBER}" is not an owner or admin of this agent group.`,
    ]);
  });
});

describe('where the answer lands', () => {
  it('a click on a top-level card lands in the thread session keyed by the card’s ts, created when absent', async () => {
    await wire('mg-2');
    const row = (await ask(taskSession, TO_RELEASE))!;
    expect(row.platform_message_id).toBe('pm-1');

    await click(row.approval_id, 'ship-a', ADMIN);

    const threadSession = await findSessionForAgent('ag-1', 'mg-2', `${RELEASE}:pm-1`);
    expect(threadSession).toBeDefined();
    expect(notes()).toHaveLength(1);
    expect(notes()[0].sessionId).toBe(threadSession!.id);
    expect(notes()[0].sessionId).not.toBe('sess-task');
    expect(vi.mocked(wakeContainer).mock.calls[0][0].id).toBe(threadSession!.id);
  });

  it('a click on a top-level card lands in the thread session a typed reply already opened', async () => {
    await wire('mg-2');
    const row = (await ask(taskSession, TO_RELEASE))!;
    await createSession(sessionRow('sess-reply', 'ag-1', 'mg-2', `${RELEASE}:pm-1`));

    await click(row.approval_id, 'hold', ADMIN);

    expect(notes().map((n) => n.sessionId)).toEqual(['sess-reply']);
  });

  it('an in-thread card’s click lands in the requesting session', async () => {
    await wire('mg-1');
    const row = (await ask(session))!;

    await click(row.approval_id, 'hold', ADMIN);

    expect(notes().map((n) => n.sessionId)).toEqual(['sess-1']);
    const count = await getDb().get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM sessions WHERE agent_group_id = ?',
      'ag-1',
    );
    expect(count?.n).toBe(2); // no session was created for the click
  });

  it('a card in a channel the agent is not wired to falls back to the requester', async () => {
    await destinationOnly('mg-2', 'release-room');
    const row = (await ask(taskSession, TO_RELEASE))!;

    await click(row.approval_id, 'ship-all', ADMIN);

    expect(notes().map((n) => n.sessionId)).toEqual(['sess-task']);
  });
});

describe('replace, never stack (key)', () => {
  it('a newer ask with the same key posts first, then supersedes the open card', async () => {
    const first = (await ask(session, { key: 'release:web' }, 'choice-1'))!;
    const second = (await ask(session, { key: 'release:web' }, 'choice-2'))!;

    expect(await getPendingApproval(first.approval_id)).toBeUndefined();
    expect(second.status).toBe('pending');
    expect(delivered.map((d) => d.content.operation ?? d.content.type)).toEqual([
      'ask_question',
      'ask_question',
      'edit',
    ]);
    const edit = delivered[2];
    expect(edit.content).toMatchObject({ operation: 'edit', messageId: first.platform_message_id });
    expect(edit.content.text).toBe(`${ASK_TEXT}\n\n${SUPERSEDED_LINE}`);
    expect(edit.instance).toBe(first.instance ?? first.channel_type);

    // A late click on the superseded card does nothing.
    expect(await click(first.approval_id, 'ship-a', ADMIN)).toBe(false);
    expect(notes()).toEqual([]);
  });

  it('keeps the open card when the newer ask fails to post', async () => {
    const first = (await ask(session, { key: 'release:web' }, 'choice-1'))!;
    failPosts = true;

    expect(await ask(session, { key: 'release:web' }, 'choice-2')).toBeUndefined();

    expect((await getPendingApproval(first.approval_id))?.status).toBe('pending');
    expect(delivered.some((d) => d.content.operation === 'edit')).toBe(false);
  });

  it('leaves a different key and another agent group’s card alone', async () => {
    const other = sessionRow('sess-2', 'ag-2', 'mg-1', 'slack:chan-1:200.1');
    await createSession(other);

    await ask(session, { key: 'release:web' }, 'choice-1');
    await ask(other, { key: 'release:web' }, 'choice-2');
    await ask(session, { key: 'release:api' }, 'choice-3');

    const open = (await getPendingApprovalsByAction(REQUEST_CHOICE_ACTION)).filter((r) => r.status === 'pending');
    expect(open.map((r) => r.request_id).sort()).toEqual(['choice-1', 'choice-2', 'choice-3']);
    expect(delivered.some((d) => d.content.operation === 'edit')).toBe(false);
  });

  it('does not supersede without a key', async () => {
    await ask(session, {}, 'choice-1');
    await ask(session, {}, 'choice-2');

    expect(await getPendingApprovalsByAction(REQUEST_CHOICE_ACTION)).toHaveLength(2);
    expect(delivered.some((d) => d.content.operation === 'edit')).toBe(false);
  });

  it('retires the old row even when the edit fails, and logs it at error', async () => {
    const errorSpy = vi.spyOn(log, 'error');
    try {
      const first = (await ask(session, { key: 'release:web' }, 'choice-1'))!;
      failEdits = true;
      const second = (await ask(session, { key: 'release:web' }, 'choice-2'))!;

      expect(await getPendingApproval(first.approval_id)).toBeUndefined();
      expect(second.status).toBe('pending');
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to edit choice card',
        expect.objectContaining({ approvalId: first.approval_id }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('thread-delivered gate cards (unchanged)', () => {
  it('still let any thread member resolve, with the standard approval buttons', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('test_thread_gate', handler);

    await requestApproval({
      session,
      agentName: 'Agent',
      action: 'test_thread_gate',
      payload: {},
      title: 'Gate',
      question: 'Run it?',
      deliveryTarget: 'thread',
    });
    const [row] = await getPendingApprovalsByAction('test_thread_gate');
    expect((delivered[0].content.options as Array<{ value: string }>).map((o) => o.value)).toEqual([
      'approve',
      'reject',
      'reject_with_reason',
    ]);

    expect(await click(row.approval_id, 'approve', MEMBER)).toBe(true);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ userId: MEMBER }));
    expect(await getPendingApproval(row.approval_id)).toBeUndefined();
  });
});

describe('formatChoiceResponse', () => {
  it('keeps the line single and free of characters the runner escapes', () => {
    const line = formatChoiceResponse({
      choiceId: 'choice-9',
      value: 'a "b" <c> & d',
      label: 'multi\nline',
      userId: 'slack:x',
      userName: null,
    });
    expect(line).not.toMatch(/[\n"<>&]/);
    expect(line.endsWith('user_name=')).toBe(true);
    const fields = Object.fromEntries(
      line
        .split(' ')
        .slice(1)
        .map((pair) => {
          const at = pair.indexOf('=');
          return [pair.slice(0, at), decodeURIComponent(pair.slice(at + 1))];
        }),
    );
    expect(fields).toEqual({
      choice_id: 'choice-9',
      value: 'a "b" <c> & d',
      label: 'multi\nline',
      user_id: 'slack:x',
      user_name: '',
    });
  });
});
