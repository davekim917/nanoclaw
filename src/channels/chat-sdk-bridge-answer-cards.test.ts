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

import { registerAnswerCardAction } from '../answer-cards.js';
import { closeDb, initMigratedTestDb } from '../db/index.js';
import { createPendingApproval } from '../db/sessions.js';
import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

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

beforeEach(async () => {
  captured.chat = null;
  await initMigratedTestDb();
});

afterEach(async () => {
  await closeDb();
});

describe('chat-sdk-bridge answer cards', () => {
  it('dispatches an answer-card click without editing the card', async () => {
    await seedCard('ans-1', ANSWER_ACTION);

    const { edits, actions } = await click('ans-1');

    expect(actions).toEqual(['ans-1:ship:U1']);
    expect(edits).toEqual([]);
  });

  it('still edits an approval card before dispatching it', async () => {
    await seedCard('appr-1', 'test_approval_card');

    const { edits, actions } = await click('appr-1');

    expect(actions).toEqual(['appr-1:ship:U1']);
    expect(edits).toHaveLength(1);
  });
});
