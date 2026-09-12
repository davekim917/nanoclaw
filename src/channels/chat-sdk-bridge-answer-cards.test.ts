/**
 * Answer cards are not edited by the bridge on click.
 *
 * Same harness as chat-sdk-bridge-byline.test.ts: the bridge's real onAction
 * handler, driven through the real Chat SDK dispatch. For an answer card
 * (src/answer-cards.ts) the host edits the card after it has authorized the
 * click and delivered the answer, so the bridge must dispatch without editing:
 * an early "✅ label — clicker" would show an answer that a refused or losing
 * click never gave. Approval cards keep today's edit-then-dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, Chat } from 'chat';

const captured = vi.hoisted(() => ({ chat: null as unknown }));

vi.mock('../webhook-server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../webhook-server.js')>()),
  registerWebhookAdapter: vi.fn((chat: unknown) => {
    captured.chat = chat;
  }),
}));

// The classification must come from the render read itself. getPendingApproval
// stands in for any second read: a test makes it answer "gone", as it would
// if the winning click deleted the row between two reads.
vi.mock('../db/sessions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/sessions.js')>();
  return { ...actual, getPendingApproval: vi.fn(actual.getPendingApproval) };
});

import { registerAnswerCardAction } from '../answer-cards.js';
import { closeDb, initMigratedTestDb } from '../db/index.js';
import { createPendingApproval, getPendingApproval } from '../db/sessions.js';
import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge, handleForwardedEvent } from './chat-sdk-bridge.js';

const ANSWER_ACTION = 'test_answer_card';
registerAnswerCardAction(ANSWER_ACTION);

async function seedCard(id: string, action: string): Promise<void> {
  await createPendingApproval({
    approval_id: id,
    request_id: id,
    action,
    payload: '{}',
    created_at: new Date().toISOString(),
    title: 'Release',
    question: 'Which change ships?',
    options_json: JSON.stringify([
      { label: 'Ship', selectedLabel: 'Ship', value: 'ship' },
      { label: 'Hold', selectedLabel: 'Hold', value: 'hold' },
    ]),
  });
}

async function click(questionId: string): Promise<{ edits: unknown[]; actions: string[] }> {
  const edits: unknown[] = [];
  const actions: string[] = [];
  const adapter = {
    name: 'stub',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => `stub:${threadId}`,
    editMessage: async (_threadId: string, _messageId: string, content: unknown) => {
      edits.push(content);
    },
  } as unknown as Adapter;
  const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
  await bridge.setup({
    onInbound: async () => {},
    onInboundEvent: async () => {},
    onMetadata: () => {},
    onAction: (id: string, value: string, userId: string) => {
      actions.push(`${id}:${value}:${userId}`);
    },
  } as ChannelSetup);

  const chat = captured.chat as Chat;
  await chat.processAction(
    {
      actionId: `ncq:${questionId}:0`,
      adapter,
      messageId: 'msg-1',
      raw: {},
      threadId: 'T-1',
      user: { userId: 'U1', userName: 'member' } as never,
      value: '0',
    },
    undefined,
  );
  return { edits, actions };
}

async function discordClick(questionId: string): Promise<{ bodies: unknown[]; onAction: ReturnType<typeof vi.fn> }> {
  const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  const onAction = vi.fn();
  await handleForwardedEvent(
    JSON.stringify({
      type: 'GATEWAY_INTERACTION_CREATE',
      data: {
        type: 3,
        id: 'interaction-1',
        token: 'token-1',
        data: { custom_id: `ncq:${questionId}:0` },
        member: { user: { id: 'U1' } },
        message: { id: 'discord-msg-1', embeds: [{ title: 'Release', description: 'Which change ships?' }] },
      },
    }),
    { name: 'gateway-stub', handleWebhook: vi.fn(async () => new Response('ok')) } as unknown as Adapter,
    { onInbound: async () => {}, onInboundEvent: async () => {}, onMetadata: () => {}, onAction },
    'bot-token',
  );
  return { bodies: fetchMock.mock.calls.map((call) => JSON.parse(call[1]!.body as string)), onAction };
}

beforeEach(async () => {
  captured.chat = null;
  const actual = await vi.importActual<typeof import('../db/sessions.js')>('../db/sessions.js');
  vi.mocked(getPendingApproval).mockImplementation(actual.getPendingApproval);
  await initMigratedTestDb();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await closeDb();
});

describe('chat-sdk-bridge answer cards', () => {
  it('dispatches an answer-card click without editing the card', async () => {
    await seedCard('ans-1', ANSWER_ACTION);

    const { edits, actions } = await click('ans-1');

    expect(actions).toEqual(['ans-1:ship:U1']);
    expect(edits).toEqual([]);
  });

  it('classifies from the render read: a row gone for any later read still skips the edit', async () => {
    await seedCard('ans-2', ANSWER_ACTION);
    vi.mocked(getPendingApproval).mockResolvedValue(undefined);

    const { edits, actions } = await click('ans-2');

    expect(actions).toEqual(['ans-2:ship:U1']);
    expect(edits).toEqual([]);
  });

  it('Discord: acknowledges an answer-card click without updating the message', async () => {
    await seedCard('ans-d', ANSWER_ACTION);

    const { bodies, onAction } = await discordClick('ans-d');

    expect(bodies).toEqual([{ type: 6 }]);
    expect(onAction).toHaveBeenCalledWith('ans-d', 'ship', 'U1', 'discord-msg-1');
  });

  it('Discord: classifies from the render read too', async () => {
    await seedCard('ans-d2', ANSWER_ACTION);
    vi.mocked(getPendingApproval).mockResolvedValue(undefined);

    const { bodies } = await discordClick('ans-d2');

    expect(bodies).toEqual([{ type: 6 }]);
  });

  it('Discord: an approval card still gets its UPDATE_MESSAGE', async () => {
    await seedCard('appr-d', 'test_approval_card');

    const { bodies } = await discordClick('appr-d');

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ type: 7 });
  });

  it('still edits an approval card before dispatching it', async () => {
    await seedCard('appr-1', 'test_approval_card');

    const { edits, actions } = await click('appr-1');

    expect(actions).toEqual(['appr-1:ship:U1']);
    expect(edits).toHaveLength(1);
  });
});
