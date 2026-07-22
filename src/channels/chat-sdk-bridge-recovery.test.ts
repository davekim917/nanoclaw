import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseMarkdown, type Adapter, type Message as ChatMessage } from 'chat';

vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));

import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge, handleForwardedEvent, RecoveryIngressGate } from './chat-sdk-bridge.js';

function message(options: {
  id: string;
  timestamp: string;
  text: string;
  threadId?: string;
  isBot?: boolean;
  isMe?: boolean;
  raw?: unknown;
}): ChatMessage {
  const formatted = parseMarkdown(options.text);
  const author = {
    userId: options.isMe ? 'bot-self' : `user-${options.id}`,
    userName: options.isMe ? 'Axie' : 'Dave',
    fullName: options.isMe ? 'Axie' : 'Dave',
    isBot: options.isBot ?? false,
    isMe: options.isMe ?? false,
  };
  const metadata = { dateSent: new Date(options.timestamp), edited: false };
  return {
    id: options.id,
    threadId: options.threadId ?? 'stub:C:T',
    text: options.text,
    formatted,
    raw: options.raw ?? {},
    author,
    metadata,
    attachments: [],
    links: [],
    toJSON: () => ({
      id: options.id,
      threadId: options.threadId ?? 'stub:C:T',
      text: options.text,
      formatted,
      raw: options.raw ?? {},
      author,
      metadata: { dateSent: options.timestamp, edited: false },
      attachments: [],
      links: [],
    }),
  } as unknown as ChatMessage;
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => closeDb());

describe('Chat SDK bridge missed-message recovery', () => {
  it('persists the pre-restart cursor as a gap before platform initialization can emit live traffic', async () => {
    const oldCursor = '2026-07-21T18:00:00.000Z';
    getDb()
      .prepare('INSERT INTO chat_sdk_kv (key, value, expires_at) VALUES (?, ?, NULL)')
      .run('nanoclaw:recovery-cursor:stub', JSON.stringify(oldCursor));
    let gapDuringInitialize: string | undefined;
    const adapter = {
      name: 'stub',
      initialize: async () => {
        const row = getDb().prepare("SELECT value FROM chat_sdk_kv WHERE key = 'nanoclaw:recovery-gap:stub'").get() as
          | { value: string }
          | undefined;
        gapDuringInitialize = row ? (JSON.parse(row.value) as string) : undefined;
      },
      channelIdFromThreadId: () => 'stub:C',
      fetchMessages: vi.fn(async () => ({ messages: [] })),
    } as unknown as Adapter;

    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    await bridge.setup({
      onInbound: async () => {},
      onInboundEvent: async () => {},
      onMetadata: () => {},
      onAction: () => {},
    } as ChannelSetup);

    expect(gapDuringInitialize).toBe(oldCursor);
    const cursor = getDb()
      .prepare("SELECT value FROM chat_sdk_kv WHERE key = 'nanoclaw:recovery-cursor:stub'")
      .get() as { value: string };
    expect(JSON.parse(cursor.value)).toBe(oldCursor);
  });

  it.each([
    ['GATEWAY_READY', 'transport-ready'],
    ['GATEWAY_RESUMED', 'transport-resumed'],
  ] as const)('maps %s into the channel-agnostic connection-restored callback', async (eventType, reason) => {
    const handleWebhook = vi.fn(async () => new Response('ok'));
    const restored = vi.fn(async () => {});
    await handleForwardedEvent(
      JSON.stringify({ type: eventType, data: {} }),
      { name: 'gateway-stub', handleWebhook } as unknown as Adapter,
      {
        onInbound: async () => {},
        onInboundEvent: async () => {},
        onMetadata: () => {},
        onAction: () => {},
      },
      'token',
      restored,
    );
    await vi.waitFor(() => expect(restored).toHaveBeenCalledWith(reason));
    expect(handleWebhook).toHaveBeenCalledOnce();
  });

  it('does not finish a reconnect event until recovery has completed', async () => {
    let finishRecovery!: () => void;
    const restored = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRecovery = resolve;
        }),
    );
    let finished = false;
    const handling = handleForwardedEvent(
      JSON.stringify({ type: 'GATEWAY_READY', data: {} }),
      { name: 'gateway-stub', handleWebhook: vi.fn(async () => new Response('ok')) } as unknown as Adapter,
      {
        onInbound: async () => {},
        onInboundEvent: async () => {},
        onMetadata: () => {},
        onAction: () => {},
      },
      'token',
      restored,
    ).then(() => {
      finished = true;
    });

    await vi.waitFor(() => expect(restored).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    finishRecovery();
    await handling;
    expect(finished).toBe(true);
  });

  it('holds new live ingress until in-flight live work drains and recovery finishes', async () => {
    const gate = new RecoveryIngressGate();
    let finishFirstLive!: () => void;
    let finishRecovery!: () => void;
    const order: string[] = [];

    const firstLive = gate.runLive(
      () =>
        new Promise<void>((resolve) => {
          order.push('live-1-start');
          finishFirstLive = () => {
            order.push('live-1-end');
            resolve();
          };
        }),
    );
    const recovery = gate.runRecovery(
      () =>
        new Promise<void>((resolve) => {
          order.push('recovery-start');
          finishRecovery = () => {
            order.push('recovery-end');
            resolve();
          };
        }),
    );
    const secondLive = gate.runLive(async () => {
      order.push('live-2');
    });

    await vi.waitFor(() => expect(order).toEqual(['live-1-start']));
    finishFirstLive();
    await vi.waitFor(() => expect(order).toEqual(['live-1-start', 'live-1-end', 'recovery-start']));
    finishRecovery();
    await Promise.all([firstLive, recovery, secondLive]);
    expect(order).toEqual(['live-1-start', 'live-1-end', 'recovery-start', 'recovery-end', 'live-2']);
  });

  it('replays only post-gap user messages in timestamp order with recovered mention semantics', async () => {
    const fetched = [
      message({ id: 'new-2', timestamp: '2026-07-21T18:20:00Z', text: 'second' }),
      message({ id: 'old', timestamp: '2026-07-21T18:15:00Z', text: 'before gap' }),
      message({ id: 'self', timestamp: '2026-07-21T18:19:00Z', text: 'bot reply', isBot: true, isMe: true }),
      message({ id: 'new-1', timestamp: '2026-07-21T18:18:00Z', text: '@Axie first', raw: { mention: true } }),
    ];
    const adapter = {
      name: 'stub',
      initialize: async () => {},
      channelIdFromThreadId: () => 'stub:C',
      fetchMessages: vi.fn(async () => ({ messages: fetched })),
    } as unknown as Adapter;
    const bridge = createChatSdkBridge({
      adapter,
      supportsThreads: true,
      detectRecoveredMention: (msg) => (msg.raw as { mention?: boolean }).mention === true,
    });
    const inbound: Array<{ id: string; isMention: boolean | undefined }> = [];
    await bridge.setup({
      onInbound: async (_platformId, _threadId, msg) => {
        inbound.push({ id: msg.id, isMention: msg.isMention });
      },
      onInboundEvent: async () => {},
      onMetadata: () => {},
      onAction: () => {},
    } as ChannelSetup);

    const result = await bridge.recoverMissedMessages!({
      since: '2026-07-21T18:16:00Z',
      reason: 'event-loop-stall',
      targets: [{ platformId: 'stub:C', threadId: 'stub:C:T', isDM: false }],
    });

    expect(inbound).toEqual([
      { id: 'new-1', isMention: true },
      { id: 'new-2', isMention: false },
    ]);
    expect(result).toEqual({ scannedTargets: 1, recoveredMessages: 2, failedTargets: 0 });
  });

  it('fails soft per target and reports incomplete coverage', async () => {
    const adapter = {
      name: 'stub',
      initialize: async () => {},
      channelIdFromThreadId: () => 'stub:C',
      fetchMessages: vi.fn(async () => {
        throw new Error('history unavailable');
      }),
    } as unknown as Adapter;
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    const onInbound = vi.fn();
    await bridge.setup({
      onInbound,
      onInboundEvent: async () => {},
      onMetadata: () => {},
      onAction: () => {},
    } as ChannelSetup);

    await expect(
      bridge.recoverMissedMessages!({
        since: '2026-07-21T18:16:00Z',
        reason: 'transport-ready',
        targets: [{ platformId: 'stub:C', threadId: 'stub:C:T', isDM: false }],
      }),
    ).resolves.toEqual({ scannedTargets: 1, recoveredMessages: 0, failedTargets: 1 });
    expect(onInbound).not.toHaveBeenCalled();
  });

  it('paginates beyond ten pages instead of retrying the same truncated gap forever', async () => {
    let page = 0;
    const fetchMessages = vi.fn(async () => {
      page++;
      const timestamp = new Date(Date.parse('2026-07-21T18:30:00Z') - page * 60_000).toISOString();
      return {
        messages: [message({ id: `page-${page}`, timestamp, text: 'history' })],
        nextCursor: page < 11 ? `cursor-${page}` : undefined,
      };
    });
    const bridge = createChatSdkBridge({
      adapter: {
        name: 'stub',
        initialize: async () => {},
        channelIdFromThreadId: () => 'stub:C',
        fetchMessages,
      } as unknown as Adapter,
      supportsThreads: true,
    });
    await bridge.setup({
      onInbound: async () => {},
      onInboundEvent: async () => {},
      onMetadata: () => {},
      onAction: () => {},
    } as ChannelSetup);

    await expect(
      bridge.recoverMissedMessages!({
        since: '2026-07-21T18:00:00Z',
        reason: 'event-loop-stall',
        targets: [{ platformId: 'stub:C', threadId: 'stub:C:T', isDM: false }],
      }),
    ).resolves.toMatchObject({ failedTargets: 0, recoveredMessages: 11 });
    expect(fetchMessages).toHaveBeenCalledTimes(11);
  });

  it('follows a continuation cursor even when an intermediate page is empty', async () => {
    const fetchMessages = vi
      .fn()
      .mockResolvedValueOnce({ messages: [], nextCursor: 'after-empty' })
      .mockResolvedValueOnce({
        messages: [message({ id: 'after-empty', timestamp: '2026-07-21T18:20:00Z', text: 'recovered' })],
      });
    const bridge = createChatSdkBridge({
      adapter: {
        name: 'stub',
        initialize: async () => {},
        channelIdFromThreadId: () => 'stub:C',
        fetchMessages,
      } as unknown as Adapter,
      supportsThreads: true,
    });
    const inbound = vi.fn();
    await bridge.setup({
      onInbound: inbound,
      onInboundEvent: async () => {},
      onMetadata: () => {},
      onAction: () => {},
    } as ChannelSetup);

    await expect(
      bridge.recoverMissedMessages!({
        since: '2026-07-21T18:16:00Z',
        reason: 'host-startup',
        targets: [{ platformId: 'stub:C', threadId: 'stub:C:T', isDM: false }],
      }),
    ).resolves.toMatchObject({ failedTargets: 0, recoveredMessages: 1 });
    expect(fetchMessages).toHaveBeenNthCalledWith(2, 'stub:C:T', expect.objectContaining({ cursor: 'after-empty' }));
    expect(inbound).toHaveBeenCalledOnce();
  });

  it('keeps the original gap floor after failure even when the next trigger is newer', async () => {
    const missed = message({ id: 'missed', timestamp: '2026-07-21T18:17:00Z', text: '@Axie missed' });
    const fetchMessages = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary history failure'))
      .mockResolvedValue({ messages: [missed] });
    const adapter = {
      name: 'stub',
      initialize: async () => {},
      channelIdFromThreadId: () => 'stub:C',
      fetchMessages,
    } as unknown as Adapter;
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    const inbound: string[] = [];
    await bridge.setup({
      onInbound: async (_platformId, _threadId, msg) => {
        inbound.push(msg.id);
      },
      onInboundEvent: async () => {},
      onMetadata: () => {},
      onAction: () => {},
    } as ChannelSetup);

    await expect(
      bridge.recoverMissedMessages!({
        since: '2026-07-21T18:16:00Z',
        reason: 'transport-ready',
        targets: [{ platformId: 'stub:C', threadId: 'stub:C:T', isDM: false }],
      }),
    ).resolves.toMatchObject({ failedTargets: 1 });
    expect(
      getDb().prepare("SELECT value FROM chat_sdk_kv WHERE key = 'nanoclaw:recovery-gap:stub'").get(),
    ).toBeDefined();

    await expect(
      bridge.recoverMissedMessages!({
        since: '2026-07-21T18:20:00Z',
        reason: 'transport-resumed',
        targets: [{ platformId: 'stub:C', threadId: 'stub:C:T', isDM: false }],
      }),
    ).resolves.toMatchObject({ failedTargets: 0, recoveredMessages: 1 });
    expect(inbound).toEqual(['missed']);
    expect(
      getDb().prepare("SELECT value FROM chat_sdk_kv WHERE key = 'nanoclaw:recovery-gap:stub'").get(),
    ).toBeUndefined();
  });
});
