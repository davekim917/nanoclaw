/**
 * A click resolves an approval only when it was made on that approval's own
 * card.
 *
 * A click reaches the host as the questionId baked into its button, the chosen
 * value, the clicker, and the platform id of the clicked message. An agent that
 * writes a raw ask_question row can post a card of its own reusing a pending
 * approval's id. Before the binding, a click on that card resolved the real
 * approval: the render lookup decoded the click through the agent's options,
 * and the approvals handler, which runs first (src/modules/index.ts:22-23),
 * claimed the row by its id alone. The last block pins the render lookup's
 * preference for the approval's own options when both rows hold the id.
 *
 * Real central DB, the bridge's real click paths (the Chat SDK dispatch and the
 * Discord gateway interaction), and the real response handlers in production
 * order. `onActionFor` builds the payload as main.ts's onAction does and
 * dispatches as its dispatchResponse does (src/main.ts:212-222).
 */
import * as fs from 'fs';

import type { Adapter, Chat } from 'chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ chat: null as unknown }));

vi.mock('../../webhook-server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../webhook-server.js')>()),
  registerWebhookAdapter: vi.fn((chat: unknown) => {
    captured.chat = chat;
  }),
}));

// The approvals barrel starts the OneCLI gateway handler once a delivery
// adapter is set; stub the SDK at the leaf so nothing leaves the process.
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    configureManualApproval(): { stop: () => void } {
      return { stop: () => {} };
    }
  },
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-click-binding') }));

import type { ChannelSetup } from '../../channels/adapter.js';
import { normalizeOptions } from '../../channels/ask-question.js';
import { createChatSdkBridge, handleForwardedEvent } from '../../channels/chat-sdk-bridge.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initMigratedTestDb } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import {
  createPendingApproval,
  createPendingQuestion,
  createSession,
  getPendingApproval,
  getPendingQuestion,
} from '../../db/sessions.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { getResponseHandlers, type ResponsePayload } from '../../response-registry.js';
import { initSessionFolder } from '../../session-manager.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { createUser } from '../permissions/db/users.js';
// Production order: approvals, then interactive (src/modules/index.ts:22-23).
import './index.js';
import '../interactive/index.js';
import { registerChoiceHandler, type ChoiceHandlerContext } from './choices.js';
import { ONECLI_ACTION } from './onecli-approvals.js';
import { registerApprovalHandler } from './primitive.js';
import { handleApprovalsResponse } from './response-handler.js';

const AG = 'ag-click';
const OWNER = 'slack:UOWNER';
const DISCORD_OWNER = 'discord:downer';
const GATE = 'test-click-gate';
const CHOICE = 'test-click-choice';
const REFUSED = 'Ignoring a click that was not made on the approval card';

function now(): string {
  return new Date().toISOString();
}

const approved: Array<{ approvalId: string; userId: string }> = [];
const answered: ChoiceHandlerContext[] = [];

registerApprovalHandler(GATE, async ({ approval, userId }) => {
  approved.push({ approvalId: approval.approval_id, userId });
});
registerChoiceHandler(CHOICE, async (ctx) => {
  answered.push(ctx);
  return ctx.requester ?? null;
});

/** Host-side card deliveries: a choice card's edit goes out through here. */
let deliveries: Array<Record<string, unknown>>;
/** Message ids the bridge edited on click. */
let bridgeEdits: string[];
let bridgeAdapter: Adapter;
/** Dispatches started by onAction, which main.ts fires without awaiting. */
const dispatches: Array<Promise<void>> = [];

/** main.ts's onAction and dispatchResponse, for one channel type. */
function onActionFor(channelType: string): ChannelSetup['onAction'] {
  return (questionId, selectedOption, userId, messageId) => {
    const payload: ResponsePayload = {
      questionId,
      value: selectedOption,
      userId,
      channelType,
      platformId: '',
      threadId: null,
      messageId,
    };
    dispatches.push(
      (async () => {
        for (const handler of getResponseHandlers()) {
          if (await handler(payload)) return;
        }
      })(),
    );
  };
}

function setupFor(channelType: string): ChannelSetup {
  return {
    onInbound: async () => {},
    onInboundEvent: async () => {},
    onMetadata: () => {},
    onAction: onActionFor(channelType),
  };
}

/** A click through the Chat SDK dispatch: button `index` of `questionId`, made on message `messageId`. */
async function click(questionId: string, index: number, clicker: string, messageId: string): Promise<void> {
  await (captured.chat as Chat).processAction(
    {
      actionId: `ncq:${questionId}:${index}`,
      adapter: bridgeAdapter,
      messageId,
      raw: {},
      threadId: 'T-1',
      user: { userId: clicker, userName: clicker } as never,
      value: String(index),
    },
    undefined,
  );
  await Promise.all(dispatches.splice(0));
}

/** The same click on Discord, as the gateway forwards the interaction. */
async function discordClick(questionId: string, index: number, clicker: string, messageId: string): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  await handleForwardedEvent(
    JSON.stringify({
      type: 'GATEWAY_INTERACTION_CREATE',
      data: {
        type: 3,
        id: 'interaction-1',
        token: 'token-1',
        data: { custom_id: `ncq:${questionId}:${index}\n${index}` },
        member: { user: { id: clicker } },
        message: { id: messageId, content: 'Run this?' },
      },
    }),
    { name: 'gateway-stub', handleWebhook: vi.fn(async () => new Response('ok')) } as unknown as Adapter,
    setupFor('discord'),
    'bot-token',
  );
  await Promise.all(dispatches.splice(0));
}

/** A payload straight into the approvals handler, for the cases the bridge adds nothing to. */
function payload(questionId: string, value: string, userId: string, messageId?: string): ResponsePayload {
  return {
    questionId,
    value,
    userId,
    channelType: 'slack',
    platformId: '',
    threadId: null,
    ...(messageId === undefined ? {} : { messageId }),
  };
}

const GATE_OPTIONS = JSON.stringify(
  normalizeOptions([
    { label: 'Approve', value: 'approve' },
    { label: 'Reject', value: 'reject' },
  ]),
);

async function seedGate(
  approvalId: string,
  card: { sessionId: string; channelType?: string; platformId: string; platformMessageId: string | null },
): Promise<void> {
  await createPendingApproval({
    approval_id: approvalId,
    request_id: approvalId,
    action: GATE,
    payload: '{}',
    created_at: now(),
    title: 'Run this?',
    options_json: GATE_OPTIONS,
    session_id: card.sessionId,
    agent_group_id: AG,
    channel_type: card.channelType ?? 'slack',
    platform_id: card.platformId,
    thread_id: null,
    platform_message_id: card.platformMessageId,
  });
}

async function seedChoice(approvalId: string, platformMessageId: string | null): Promise<void> {
  await createPendingApproval({
    approval_id: approvalId,
    request_id: `choice-${approvalId}`,
    action: CHOICE,
    payload: '{}',
    created_at: now(),
    title: 'Production release',
    question: 'Ship to production?',
    options_json: JSON.stringify(
      normalizeOptions([
        { label: 'Ship production', value: 'ship' },
        { label: 'Hold', value: 'hold' },
      ]),
    ),
    session_id: 'sess-thread',
    agent_group_id: AG,
    channel_type: 'slack',
    platform_id: 'slack:CAGENT',
    thread_id: null,
    platform_message_id: platformMessageId,
  });
}

async function seedCredential(approvalId: string, platformMessageId: string): Promise<void> {
  await createPendingApproval({
    approval_id: approvalId,
    request_id: `onecli-${approvalId}`,
    action: ONECLI_ACTION,
    payload: '{}',
    created_at: now(),
    title: 'Credentials Request',
    options_json: GATE_OPTIONS,
    agent_group_id: AG,
    channel_type: 'slack',
    platform_id: 'slack:DOWNER',
    platform_message_id: platformMessageId,
    // Still open, so the barrel's OneCLI re-attach and sweep leave it alone.
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
}

/**
 * The row delivery persisted, before this change, for a raw outbound
 * ask_question reusing `questionId`: the agent's own card.
 */
async function agentCard(questionId: string, label: string, value: string): Promise<void> {
  await createPendingQuestion({
    question_id: questionId,
    session_id: 'sess-thread',
    message_out_id: `out-${questionId}`,
    platform_id: 'slack:CAGENT',
    channel_type: 'slack',
    thread_id: null,
    title: 'FYI',
    question: 'Nothing to do here',
    options: normalizeOptions([{ label, value }]),
    created_at: now(),
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();
  approved.length = 0;
  answered.length = 0;
  dispatches.length = 0;
  deliveries = [];
  bridgeEdits = [];
  setDeliveryAdapter({
    async deliver(_channelType, _platformId, _threadId, _kind, content) {
      deliveries.push(JSON.parse(content) as Record<string, unknown>);
      return undefined;
    },
  });

  await createAgentGroup({ id: AG, name: 'Click', folder: 'click', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-agent',
    channel_type: 'slack',
    platform_id: 'slack:CAGENT',
    name: 'agent room',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const base = {
    agent_group_id: AG,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  } as const;
  await createSession({ ...base, id: 'sess-dm', messaging_group_id: null });
  await createSession({ ...base, id: 'sess-thread', messaging_group_id: 'mg-agent' });
  for (const id of [OWNER, DISCORD_OWNER]) {
    await createUser({ id, kind: id.split(':')[0], display_name: 'Owner', created_at: now() });
    await grantRole({ user_id: id, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  }

  captured.chat = null;
  bridgeAdapter = {
    name: 'stub',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => `stub:${threadId}`,
    editMessage: async (_threadId: string, messageId: string) => {
      bridgeEdits.push(messageId);
    },
  } as unknown as Adapter;
  await createChatSdkBridge({ adapter: bridgeAdapter, supportsThreads: false }).setup(setupFor('slack'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('a click made on any other card resolves nothing', () => {
  it('choice card: "Dismiss" on an agent card reusing its id leaves it pending and unedited', async () => {
    await seedChoice('appr-choice', 'real-choice-card');
    await agentCard('appr-choice', 'Dismiss', 'ship');
    const warn = vi.spyOn(log, 'warn');

    await click('appr-choice', 0, 'UOWNER', 'agent-card');

    expect(answered).toEqual([]);
    expect((await getPendingApproval('appr-choice'))?.status).toBe('pending');
    expect(deliveries).toEqual([]);
    expect(bridgeEdits).not.toContain('real-choice-card');
    // Claimed by the approvals handler, so the agent's own row is not consumed as an answer either.
    expect(await getPendingQuestion('appr-choice')).toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      REFUSED,
      expect.objectContaining({
        approvalId: 'appr-choice',
        clickedMessageId: 'agent-card',
        cardMessageId: 'real-choice-card',
      }),
    );
  });

  it('admin-DM approval: "Snooze" on an agent card reusing its id does not approve it', async () => {
    await seedGate('appr-dm', { sessionId: 'sess-dm', platformId: 'slack:DOWNER', platformMessageId: 'real-dm-card' });
    await agentCard('appr-dm', 'Snooze', 'approve');

    await click('appr-dm', 0, 'UOWNER', 'agent-card');

    expect(approved).toEqual([]);
    expect((await getPendingApproval('appr-dm'))?.status).toBe('pending');
  });

  it('thread gate: an unprivileged member\'s "Got it" on an agent card does not approve it', async () => {
    await seedGate('appr-thread', {
      sessionId: 'sess-thread',
      platformId: 'slack:CAGENT',
      platformMessageId: 'real-gate-card',
    });
    await agentCard('appr-thread', 'Got it', 'approve');

    await click('appr-thread', 0, 'UNOBODY', 'agent-card');

    expect(approved).toEqual([]);
    expect((await getPendingApproval('appr-thread'))?.status).toBe('pending');
  });

  it('Discord: a click on another message does not approve', async () => {
    await seedGate('appr-discord', {
      sessionId: 'sess-dm',
      channelType: 'discord',
      platformId: 'discord:@me:dm-owner',
      platformMessageId: 'discord-card',
    });

    await discordClick('appr-discord', 0, 'downer', 'other-message');

    expect(approved).toEqual([]);
    expect((await getPendingApproval('appr-discord'))?.status).toBe('pending');
  });

  it('OneCLI credential approval: a click on another message does not decide it', async () => {
    await seedCredential('oa-click01', 'real-credential-card');

    expect(await handleApprovalsResponse(payload('oa-click01', 'approve', OWNER, 'agent-card'))).toBe(true);

    expect((await getPendingApproval('oa-click01'))?.status).toBe('pending');
  });

  it('a click that carries no message id resolves nothing', async () => {
    await seedGate('appr-bare', {
      sessionId: 'sess-dm',
      platformId: 'slack:DOWNER',
      platformMessageId: 'real-dm-card',
    });

    expect(await handleApprovalsResponse(payload('appr-bare', 'approve', OWNER))).toBe(true);

    expect(approved).toEqual([]);
  });

  it('a choice card whose message id is not stored yet refuses every click', async () => {
    await seedChoice('appr-choice-new', null);

    await click('appr-choice-new', 0, 'UOWNER', 'any-card');

    expect(answered).toEqual([]);
    expect((await getPendingApproval('appr-choice-new'))?.status).toBe('pending');
  });
});

describe("a click made on the approval's own card still resolves it", () => {
  it('admin-DM approval', async () => {
    await seedGate('appr-dm', { sessionId: 'sess-dm', platformId: 'slack:DOWNER', platformMessageId: 'real-dm-card' });

    await click('appr-dm', 0, 'UOWNER', 'real-dm-card');

    expect(approved).toEqual([{ approvalId: 'appr-dm', userId: OWNER }]);
    expect(await getPendingApproval('appr-dm')).toBeUndefined();
  });

  it('thread gate, by any thread member', async () => {
    await seedGate('appr-thread', {
      sessionId: 'sess-thread',
      platformId: 'slack:CAGENT',
      platformMessageId: 'real-gate-card',
    });

    await click('appr-thread', 0, 'UNOBODY', 'real-gate-card');

    expect(approved).toEqual([{ approvalId: 'appr-thread', userId: 'slack:UNOBODY' }]);
  });

  it('choice card: the answer is delivered, then the host edits that card', async () => {
    await seedChoice('appr-choice', 'real-choice-card');

    await click('appr-choice', 0, 'UOWNER', 'real-choice-card');

    expect(answered.map((a) => [a.value, a.label, a.userId])).toEqual([['ship', 'Ship production', OWNER]]);
    expect(await getPendingApproval('appr-choice')).toBeUndefined();
    expect(deliveries).toEqual([expect.objectContaining({ operation: 'edit', messageId: 'real-choice-card' })]);
  });

  it('Discord', async () => {
    await seedGate('appr-discord', {
      sessionId: 'sess-dm',
      channelType: 'discord',
      platformId: 'discord:@me:dm-owner',
      platformMessageId: 'discord-card',
    });

    await discordClick('appr-discord', 0, 'downer', 'discord-card');

    expect(approved).toEqual([{ approvalId: 'appr-discord', userId: DISCORD_OWNER }]);
  });

  it('OneCLI credential approval', async () => {
    await seedCredential('oa-click02', 'real-credential-card');

    await handleApprovalsResponse(payload('oa-click02', 'approve', OWNER, 'real-credential-card'));

    // Nothing is armed in this process, so the decision is held on the row (onecli-approvals.ts:201-213).
    expect((await getPendingApproval('oa-click02'))?.status).toBe('approved');
  });

  it('a registered approval stored without a message id resolves as before', async () => {
    await seedGate('appr-legacy', { sessionId: 'sess-dm', platformId: 'slack:DOWNER', platformMessageId: null });

    await click('appr-legacy', 0, 'UOWNER', 'any-card');

    expect(approved).toEqual([{ approvalId: 'appr-legacy', userId: OWNER }]);
  });
});

describe('an agent row reusing an approval id cannot decode a click on the real card', () => {
  /**
   * A row written before delivery refused colliding ids: two buttons, both
   * mapped to `value`, so either index decodes to it if this row is read.
   */
  async function staleAgentCard(questionId: string, value: string): Promise<void> {
    await createPendingQuestion({
      question_id: questionId,
      session_id: 'sess-thread',
      message_out_id: `out-${questionId}`,
      platform_id: 'slack:CAGENT',
      channel_type: 'slack',
      thread_id: null,
      title: 'FYI',
      question: 'Nothing to do here',
      options: normalizeOptions([
        { label: 'Later', value },
        { label: 'Dismiss', value },
      ]),
      created_at: now(),
    });
  }

  it('"Reject" on the real card of an approval rejects it', async () => {
    initSessionFolder(AG, 'sess-dm');
    await seedGate('appr-dm', { sessionId: 'sess-dm', platformId: 'slack:DOWNER', platformMessageId: 'real-dm-card' });
    await staleAgentCard('appr-dm', 'approve');
    const info = vi.spyOn(log, 'info');

    await click('appr-dm', 1, 'UOWNER', 'real-dm-card');

    expect(approved).toEqual([]);
    expect(info).toHaveBeenCalledWith('Approval rejected', expect.objectContaining({ approvalId: 'appr-dm' }));
    expect(await getPendingApproval('appr-dm')).toBeUndefined();
  });

  it('"Hold" on the real choice card answers hold, and the bridge leaves the card to the host', async () => {
    await seedChoice('appr-choice', 'real-choice-card');
    await staleAgentCard('appr-choice', 'ship');

    await click('appr-choice', 1, 'UOWNER', 'real-choice-card');

    expect(answered.map((a) => [a.value, a.label])).toEqual([['hold', 'Hold']]);
    expect(bridgeEdits).toEqual([]);
  });

  it('an approval whose stored options are unreadable leaves the click unresolved', async () => {
    await createPendingApproval({
      approval_id: 'appr-corrupt',
      request_id: 'appr-corrupt',
      action: GATE,
      payload: '{}',
      created_at: now(),
      title: 'Run this?',
      options_json: '{not json',
      session_id: 'sess-dm',
      agent_group_id: AG,
      channel_type: 'slack',
      platform_id: 'slack:DOWNER',
      platform_message_id: 'real-corrupt-card',
    });
    await staleAgentCard('appr-corrupt', 'approve');

    await click('appr-corrupt', 0, 'UOWNER', 'real-corrupt-card');

    expect(approved).toEqual([]);
    expect((await getPendingApproval('appr-corrupt'))?.status).toBe('pending');
    expect(await getPendingQuestion('appr-corrupt')).toBeDefined();
  });
});
