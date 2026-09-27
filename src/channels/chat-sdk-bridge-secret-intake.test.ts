/**
 * The secret-intake card: its button opens a platform form, and the form's value reaches the host hook without
 * passing through a chat message. Driven through the real Chat SDK dispatch, as in chat-sdk-bridge-answer-cards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, Chat, ModalElement } from 'chat';

const captured = vi.hoisted(() => ({ chat: null as unknown }));

vi.mock('../webhook-server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../webhook-server.js')>()),
  registerWebhookAdapter: vi.fn((chat: unknown) => {
    captured.chat = chat;
  }),
}));

import { closeDb, initMigratedTestDb } from '../db/index.js';
import type { ChannelSetup, SecretIntakeHooks } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

const SECRET = 'sk-live-BRIDGE-SENTINEL-51c2';

interface Harness {
  chat: Chat;
  adapter: Adapter;
  posts: unknown[];
  modals: Array<{ triggerId: string; modal: ModalElement; contextId?: string }>;
  hooks: { open: ReturnType<typeof vi.fn>; submit: ReturnType<typeof vi.fn> };
}

async function harness(hooks?: Partial<SecretIntakeHooks>, supportsModals = true): Promise<Harness> {
  const posts: unknown[] = [];
  const modals: Harness['modals'] = [];
  const adapter = {
    name: 'stub',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => `stub:${threadId}`,
    postMessage: async (_threadId: string, content: unknown) => {
      posts.push(content);
      return { id: `m-${posts.length}` };
    },
    ...(supportsModals
      ? {
          openModal: async (triggerId: string, modal: ModalElement, contextId?: string) => {
            modals.push({ triggerId, modal, contextId });
            return { viewId: 'V1' };
          },
        }
      : {}),
  } as unknown as Adapter;
  const open = vi.fn(
    hooks?.open ??
      (async () => ({
        ok: true as const,
        form: { title: 'Store secret', body: 'Linear-API-Key', inputLabel: 'Secret value' },
      })),
  );
  const submit = vi.fn(hooks?.submit ?? (async () => ({ ok: true as const })));
  const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
  await bridge.setup({
    onInbound: async () => {},
    onInboundEvent: async () => {},
    onMetadata: () => {},
    onAction: () => {},
    secretIntake: { open, submit },
  } as ChannelSetup);
  return { chat: captured.chat as Chat, adapter, posts, modals, hooks: { open, submit }, ...{} };
}

async function clickIntake(h: Harness, intakeId: string): Promise<void> {
  await h.chat.processAction(
    {
      actionId: `ncs:${intakeId}`,
      adapter: h.adapter,
      messageId: 'card-1',
      raw: {},
      threadId: 'D-1',
      triggerId: 'trigger-1',
      user: { userId: 'U1', userName: 'owner' } as never,
    },
    undefined,
  );
}

async function submitForm(h: Harness, intakeId: string, value: string) {
  return h.chat.processModalSubmit(
    {
      adapter: h.adapter,
      callbackId: 'nc-secret-intake',
      privateMetadata: intakeId,
      raw: {},
      user: { userId: 'U1', userName: 'owner' } as never,
      values: { secret_value: value },
      viewId: 'V1',
    },
    h.modals[0]?.contextId,
  );
}

beforeEach(async () => {
  captured.chat = null;
  await initMigratedTestDb();
});

afterEach(async () => {
  await closeDb();
});

describe('secret intake through the Chat SDK bridge', () => {
  it('renders the card with one button carrying only the intake id', async () => {
    const posts: unknown[] = [];
    const adapter = {
      name: 'stub',
      initialize: async () => {},
      channelIdFromThreadId: (t: string) => `stub:${t}`,
      postMessage: async (_t: string, content: unknown) => {
        posts.push(content);
        return { id: 'm-1' };
      },
    } as unknown as Adapter;
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    await bridge.setup({
      onInbound: async () => {},
      onInboundEvent: async () => {},
      onMetadata: () => {},
      onAction: () => {},
    } as ChannelSetup);
    const id = await bridge.deliver('stub:D-1', null, {
      kind: 'chat-sdk',
      content: { type: 'secret_intake', intakeId: 'si-abc', title: '🔐 New secret: X', body: 'Sent only to api.x.com' },
    });
    expect(id).toBe('m-1');
    const serialized = JSON.stringify(posts[0]);
    expect(serialized).toContain('ncs:si-abc');
    expect(serialized).toContain('Sent only to api.x.com');
  });

  it('opens a form with a text input when the host allows the click', async () => {
    const h = await harness();
    await clickIntake(h, 'si-abc');
    expect(h.hooks.open).toHaveBeenCalledWith('si-abc', 'U1');
    expect(h.modals).toHaveLength(1);
    const modal = h.modals[0].modal;
    expect(modal.callbackId).toBe('nc-secret-intake');
    expect(modal.privateMetadata).toBe('si-abc');
    expect(modal.children.some((c) => c.type === 'text_input' && c.id === 'secret_value')).toBe(true);
  });

  it('posts the refusal and opens nothing when the host refuses the click', async () => {
    const h = await harness({ open: async () => ({ ok: false, message: 'Only an owner can enter a secret.' }) });
    const posted: string[] = [];
    vi.spyOn(h.adapter, 'postMessage').mockImplementation(async (_t: string, content: unknown) => {
      posted.push(typeof content === 'string' ? content : JSON.stringify(content));
      return { id: 'm-x', threadId: 'D-1', raw: {} };
    });
    await clickIntake(h, 'si-abc');
    expect(h.modals).toHaveLength(0);
    expect(posted.join('\n')).toContain('Only an owner can enter a secret.');
  });

  it('says so when the platform cannot open a form', async () => {
    const h = await harness(undefined, false);
    const posted: string[] = [];
    vi.spyOn(h.adapter, 'postMessage').mockImplementation(async (_t: string, content: unknown) => {
      posted.push(typeof content === 'string' ? content : JSON.stringify(content));
      return { id: 'm-x', threadId: 'D-1', raw: {} };
    });
    await clickIntake(h, 'si-abc');
    expect(posted.join('\n')).toContain('cannot open a form');
  });

  it('hands the submitted value to the host hook and closes the form', async () => {
    const h = await harness();
    await clickIntake(h, 'si-abc');
    const response = await submitForm(h, 'si-abc', SECRET);
    expect(h.hooks.submit).toHaveBeenCalledWith('si-abc', 'U1', SECRET);
    expect(response).toEqual({ action: 'close' });
    expect(JSON.stringify(h.posts)).not.toContain(SECRET);
  });

  it('shows a refused submit as a field error, keeping the form open', async () => {
    const h = await harness({ submit: async () => ({ ok: false, message: 'Paste the secret value.' }) });
    await clickIntake(h, 'si-abc');
    expect(await submitForm(h, 'si-abc', '   ')).toEqual({
      action: 'errors',
      errors: { secret_value: 'Paste the secret value.' },
    });
  });
});
