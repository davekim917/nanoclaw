/**
 * Actor byline on the cards the Chat SDK bridge still edits.
 *
 * Drives the bridge's real onAction handler through the real Chat SDK
 * dispatch (`chat.processAction`): `bridge.setup()` registers the handler on
 * a real Chat instance, which the test captures from the webhook-server
 * registration (mocked so no HTTP server binds a port). After a button click
 * the bridge edits the card; the edit must append " — <actor>" so shared
 * channels see who resolved it. Goes red if the byLine concatenation is
 * removed from the edited markdown.
 *
 * The bridge edits a card whose render came from pending_questions (an agent's
 * ask_user_question) or from no row at all. It edits NO pending_approvals card
 * — it has not checked whose card was clicked — and the last case pins that;
 * the host writes those bylines instead (modules/approvals/primitive.ts
 * editApprovalCardResolution, covered in modules/approvals/click-binding.test.ts).
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

import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations, getRawDb } from '../db/index.js';
import { createPendingApproval, createPendingQuestion } from '../db/sessions.js';
import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

interface CapturedEdit {
  threadId: string;
  messageId: string;
  markdown?: string;
  card?: { title?: string; subtitle?: string; children?: Array<{ type?: string; content?: string }> };
}

function makeAdapter(edits: CapturedEdit[]): Adapter {
  return {
    name: 'stub',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => `stub:${threadId}`,
    editMessage: async (
      threadId: string,
      messageId: string,
      content: {
        markdown?: string;
        card?: { title?: string; subtitle?: string; children?: Array<{ type?: string; content?: string }> };
      },
    ) => {
      edits.push({ threadId, messageId, markdown: content.markdown, card: content.card });
    },
  } as unknown as Adapter;
}

async function fireAction(
  user: Record<string, unknown>,
  action: { actionId: string; value: string } = { actionId: 'ncq:q-1:approve', value: 'approve' },
): Promise<{ edits: CapturedEdit[]; actions: string[] }> {
  const edits: CapturedEdit[] = [];
  const actions: string[] = [];
  const adapter = makeAdapter(edits);
  const bridge = createChatSdkBridge({ adapter, supportsThreads: false });

  await bridge.setup({
    onInbound: async () => {},
    onInboundEvent: async () => {},
    onMetadata: () => {},
    onAction: (questionId: string, selectedOption: string, userId: string) => {
      actions.push(`${questionId}:${selectedOption}:${userId}`);
    },
  } as ChannelSetup);

  const chat = captured.chat as Chat;
  expect(chat).toBeTruthy();
  await chat.processAction(
    {
      actionId: action.actionId,
      adapter,
      messageId: 'msg-1',
      raw: {},
      threadId: 'T-1',
      user: user as never,
      value: action.value,
    },
    undefined,
  );
  return { edits, actions };
}

async function seedApproval(id: string, title = '⚠️ Test approval', question = ''): Promise<void> {
  await createPendingApproval({
    approval_id: id,
    request_id: id,
    action: 'test',
    payload: '{}',
    created_at: new Date().toISOString(),
    title,
    question,
    options_json: JSON.stringify([
      { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
      { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
    ]),
  });
}

async function seedInteractiveQuestion(
  id: string,
  title: string,
  question: string,
  options: Array<{ label: string; selectedLabel: string; value: string }> = [
    { label: 'Proceed', selectedLabel: '✅ Proceeded', value: 'proceed' },
  ],
): Promise<void> {
  const createdAt = new Date().toISOString();
  await createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: createdAt,
  });
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: createdAt,
  });
  await createPendingQuestion({
    question_id: id,
    session_id: 'sess-1',
    message_out_id: `out-${id}`,
    platform_id: 'C1',
    channel_type: 'slack',
    thread_id: null,
    title,
    question,
    options,
    created_at: createdAt,
  });
}

beforeEach(async () => {
  captured.chat = null;
  await initTestDb();
  const db = getRawDb();
  runMigrations(db);
});

afterEach(async () => {
  await closeDb();
});

describe('chat-sdk-bridge approval-card byline', () => {
  it('appends the acting user to the edited card markdown', async () => {
    const { edits, actions } = await fireAction({ userId: 'U1', userName: 'gavriel', fullName: 'Gavriel C' });

    expect(edits).toHaveLength(1);
    expect(edits[0].threadId).toBe('T-1');
    expect(edits[0].messageId).toBe('msg-1');
    expect(edits[0].markdown).toContain('approve — gavriel');
    expect(actions).toEqual(['q-1:approve:U1']);
  });

  it('falls back to fullName when userName is missing', async () => {
    const { edits } = await fireAction({ userId: 'U2', fullName: 'Gavriel C' });

    expect(edits).toHaveLength(1);
    expect(edits[0].markdown).toContain('— Gavriel C');
  });

  it('omits the byline when the actor has no name', async () => {
    const { edits } = await fireAction({ userId: 'U3' });

    expect(edits).toHaveLength(1);
    expect(edits[0].markdown).not.toContain('—');
    expect(edits[0].markdown).toContain('approve');
  });

  it('resolves an indexed button to its value before dispatching it', async () => {
    await seedInteractiveQuestion('q-1', 'Run this?', '', [
      { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
      { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
    ]);

    const { edits, actions } = await fireAction(
      { userId: 'U1', userName: 'gavriel' },
      { actionId: 'ncq:q-1:0', value: '0' },
    );

    expect(actions).toEqual(['q-1:approve:U1']);
    expect(edits).toHaveLength(1);
    expect(edits[0].markdown).toContain('✅ Approved — gavriel');
  });

  it('leaves an approval card alone: the host edits the card that row names', async () => {
    await seedApproval('q-1', 'Install Packages Request', 'Agent "example-group" wants to install WebKit libraries.');

    const { edits, actions } = await fireAction(
      { userId: 'U1', userName: 'gavriel' },
      { actionId: 'ncq:q-1:0', value: '0' },
    );

    // Dispatched, but nothing of the approval's content is written back to the
    // clicked message — the bridge does not yet know whose card it was.
    expect(actions).toEqual(['q-1:approve:U1']);
    expect(edits).toEqual([]);
  });

  it('keeps interactive-question context visible when pending_questions is the render source', async () => {
    await seedInteractiveQuestion('interactive-1', 'Choose a path', 'Which deployment path should I use?');

    const { edits, actions } = await fireAction(
      { userId: 'U1', userName: 'gavriel' },
      { actionId: 'ncq:interactive-1:0', value: '0' },
    );

    expect(actions).toEqual(['interactive-1:proceed:U1']);
    expect(edits[0].card?.title).toBe('Choose a path');
    expect(edits[0].card?.subtitle).toBe('Which deployment path should I use?');
    expect(edits[0].card?.children?.[0]?.content).toContain('✅ Proceeded — gavriel');
  });

  it('does not turn an unresolved indexed button into a rejection', async () => {
    const { edits, actions } = await fireAction(
      { userId: 'U1', userName: 'gavriel' },
      { actionId: 'ncq:missing:0', value: '0' },
    );

    expect(actions).toEqual([]);
    expect(edits).toEqual([]);
  });
});
