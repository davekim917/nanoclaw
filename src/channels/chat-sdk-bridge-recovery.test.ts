import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseMarkdown, type Adapter, type Message as ChatMessage } from 'chat';

vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));

import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import { createPendingApproval } from '../db/sessions.js';
import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge, handleForwardedEvent, RecoveryIngressGate } from './chat-sdk-bridge.js';

function message(options: {
  id: string;
  timestamp: string;
  text: string;
  threadId?: string;
  isBot?: boolean;
  isMe?: boolean;
  authorUserId?: string;
  authorUserName?: string;
  authorFullName?: string;
  links?: ChatMessage['links'];
  raw?: unknown;
}): ChatMessage {
  const formatted = parseMarkdown(options.text);
  const author = {
    userId: options.authorUserId ?? (options.isMe ? 'bot-self' : `user-${options.id}`),
    userName: options.authorUserName ?? (options.isMe ? 'Example Agent' : 'Operator'),
    fullName: options.authorFullName ?? (options.isMe ? 'Example Agent' : 'Operator'),
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
    links: options.links ?? [],
    toJSON: () => ({
      id: options.id,
      threadId: options.threadId ?? 'stub:C:T',
      text: options.text,
      formatted,
      raw: options.raw ?? {},
      author,
      metadata: { dateSent: options.timestamp, edited: false },
      attachments: [],
      links: options.links ?? [],
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

  it('keeps live ingress flowing during recovery while serializing recovery passes', async () => {
    const gate = new RecoveryIngressGate();
    let finishFirstRecovery!: () => void;
    const order: string[] = [];

    const firstRecovery = gate.runRecovery(
      () =>
        new Promise<void>((resolve) => {
          order.push('recovery-1-start');
          finishFirstRecovery = () => {
            order.push('recovery-1-end');
            resolve();
          };
        }),
    );
    const secondRecovery = gate.runRecovery(async () => {
      order.push('recovery-2');
    });
    const live = gate.runLive(async () => {
      order.push('live');
    });

    await vi.waitFor(() => expect(order).toEqual(['live', 'recovery-1-start']));
    finishFirstRecovery();
    await Promise.all([firstRecovery, secondRecovery, live]);
    expect(order).toEqual(['live', 'recovery-1-start', 'recovery-1-end', 'recovery-2']);
  });

  it('replays only post-gap user messages in timestamp order with recovered mention semantics', async () => {
    const fetched = [
      message({ id: 'new-2', timestamp: '2026-07-21T18:20:00Z', text: 'second' }),
      message({ id: 'old', timestamp: '2026-07-21T18:15:00Z', text: 'before gap' }),
      message({ id: 'self', timestamp: '2026-07-21T18:19:00Z', text: 'bot reply', isBot: true, isMe: true }),
      message({ id: 'new-1', timestamp: '2026-07-21T18:18:00Z', text: '@Example Agent first', raw: { mention: true } }),
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

  it('normalizes stale sibling sender names before recovered messages reach the router', async () => {
    const fetched = [
      message({
        id: 'peer',
        timestamp: '2026-07-21T18:18:00Z',
        text: 'assignment',
        isBot: true,
        authorUserId: 'U-DINESH',
        authorUserName: 'beacon',
        authorFullName: 'Beacon',
      }),
    ];
    const bridge = createChatSdkBridge({
      adapter: {
        name: 'stub',
        initialize: async () => {},
        channelIdFromThreadId: () => 'stub:C',
        fetchMessages: vi.fn(async () => ({ messages: fetched })),
      } as unknown as Adapter,
      supportsThreads: true,
      allowRecoveredBotMessage: () => true,
      transformInboundSender: (author) => (author.userId === 'U-DINESH' ? 'Dinesh' : null),
    });
    const senders: string[] = [];
    await bridge.setup({
      onInbound: async (_platformId, _threadId, msg) => {
        senders.push((msg.content as { senderName?: string }).senderName ?? 'missing');
      },
      onInboundEvent: async () => {},
      onMetadata: () => {},
      onAction: () => {},
    } as ChannelSetup);

    await bridge.recoverMissedMessages!({
      since: '2026-07-21T18:16:00Z',
      reason: 'event-loop-stall',
      targets: [{ platformId: 'stub:C', threadId: 'stub:C:T', isDM: false }],
    });

    expect(senders).toEqual(['Dinesh']);
  });

  it('normalizes a stale sibling name in recovered quoted-message context', async () => {
    const fetched = [
      message({
        id: 'quote',
        timestamp: '2026-07-21T18:18:00Z',
        text: 'following up',
        links: [
          {
            fetchMessage: async () => ({
              id: 'quoted-peer',
              text: 'original assignment',
              author: { userId: 'U-DINESH', userName: 'beacon', fullName: 'Beacon' },
            }),
          },
        ] as ChatMessage['links'],
      }),
    ];
    const bridge = createChatSdkBridge({
      adapter: {
        name: 'stub',
        initialize: async () => {},
        channelIdFromThreadId: () => 'stub:C',
        fetchMessages: vi.fn(async () => ({ messages: fetched })),
      } as unknown as Adapter,
      supportsThreads: true,
      transformInboundSender: (author) => (author.userId === 'U-DINESH' ? 'Dinesh' : null),
    });
    const quotedSenders: string[] = [];
    await bridge.setup({
      onInbound: async (_platformId, _threadId, msg) => {
        const content = msg.content as { replyTo?: { sender?: string } };
        quotedSenders.push(content.replyTo?.sender ?? 'missing');
      },
      onInboundEvent: async () => {},
      onMetadata: () => {},
      onAction: () => {},
    } as ChannelSetup);

    await bridge.recoverMissedMessages!({
      since: '2026-07-21T18:16:00Z',
      reason: 'event-loop-stall',
      targets: [{ platformId: 'stub:C', threadId: 'stub:C:T', isDM: false }],
    });

    expect(quotedSenders).toEqual(['Dinesh']);
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
    const missed = message({ id: 'missed', timestamp: '2026-07-21T18:17:00Z', text: '@Example Agent missed' });
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

describe('Chat SDK bridge Discord approval actions', () => {
  function interaction(customId: string): string {
    return JSON.stringify({
      type: 'GATEWAY_INTERACTION_CREATE',
      data: {
        type: 3,
        id: 'interaction-1',
        token: 'token-1',
        data: { custom_id: customId },
        member: { user: { id: 'U1' } },
        message: { embeds: [{ title: '⚠️ Test approval', description: 'Details' }] },
      },
    });
  }

  function seedApproval(id: string): void {
    createPendingApproval({
      approval_id: id,
      request_id: id,
      action: 'test',
      payload: '{}',
      created_at: new Date().toISOString(),
      title: '⚠️ Test approval',
      options_json: JSON.stringify([
        { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
        { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
      ]),
    });
  }

  afterEach(() => vi.unstubAllGlobals());

  it('maps Discord index zero to approve rather than rejecting it', async () => {
    seedApproval('appr-discord');
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const onAction = vi.fn();

    await handleForwardedEvent(
      interaction('ncq:appr-discord:0'),
      { name: 'gateway-stub', handleWebhook: vi.fn(async () => new Response('ok')) } as unknown as Adapter,
      { onInbound: async () => {}, onInboundEvent: async () => {}, onMetadata: () => {}, onAction },
      'bot-token',
    );

    expect(onAction).toHaveBeenCalledWith('appr-discord', 'approve', 'U1');
    const callbackInit = fetchMock.mock.calls[0]?.[1];
    expect(callbackInit).toBeDefined();
    expect(JSON.parse(callbackInit!.body as string)).toMatchObject({
      type: 7,
      data: {
        content: '**⚠️ Test approval**\n\nDetails\n\n✅ Approved',
        embeds: [],
        components: [],
        allowed_mentions: { parse: [] },
      },
    });
  });

  it("decodes Discord's newline-delimited custom_id before resolving the option", async () => {
    seedApproval('appr-discord-wire');
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const onAction = vi.fn();

    // @chat-adapter/discord encodes a button carrying both id and value as
    // `${actionId}\n${value}`. This is the literal wire shape from Discord,
    // not the already-decoded shape delivered through Chat.processAction.
    await handleForwardedEvent(
      interaction('ncq:appr-discord-wire:0\n0'),
      { name: 'gateway-stub', handleWebhook: vi.fn(async () => new Response('ok')) } as unknown as Adapter,
      { onInbound: async () => {}, onInboundEvent: async () => {}, onMetadata: () => {}, onAction },
      'bot-token',
    );

    expect(onAction).toHaveBeenCalledWith('appr-discord-wire', 'approve', 'U1');
    const callbackInit = fetchMock.mock.calls[0]?.[1];
    expect(callbackInit).toBeDefined();
    expect(JSON.parse(callbackInit!.body as string)).toMatchObject({ type: 7 });
  });

  it('keeps a Discord approval pending when its indexed option cannot be resolved', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const onAction = vi.fn();

    await handleForwardedEvent(
      interaction('ncq:missing:0'),
      { name: 'gateway-stub', handleWebhook: vi.fn(async () => new Response('ok')) } as unknown as Adapter,
      { onInbound: async () => {}, onInboundEvent: async () => {}, onMetadata: () => {}, onAction },
      'bot-token',
    );

    expect(onAction).not.toHaveBeenCalled();
    const callbackInit = fetchMock.mock.calls[0]?.[1];
    expect(callbackInit).toBeDefined();
    expect(JSON.parse(callbackInit!.body as string)).toMatchObject({
      type: 4,
      data: { flags: 64 },
    });
  });
});

describe('Chat SDK bridge dead-target registry', () => {
  const stubAdapter = (fetchMessages: ReturnType<typeof vi.fn>) =>
    ({
      name: 'stub',
      initialize: async () => {},
      channelIdFromThreadId: () => 'stub:C',
      fetchMessages,
    }) as unknown as Adapter;
  const setup = {
    onInbound: async () => {},
    onInboundEvent: async () => {},
    onMetadata: () => {},
    onAction: () => {},
  } as ChannelSetup;
  const classify = (err: unknown) =>
    err instanceof Error && err.message.includes('channel_not_found') ? ('permanent' as const) : ('transient' as const);
  const readKv = (key: string): string | undefined =>
    (getDb().prepare('SELECT value FROM chat_sdk_kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;

  it('parks a permanently-failing target, completes the pass, and skips it next pass', async () => {
    const fetchMessages = vi.fn(async () => {
      throw new Error('An API error occurred: channel_not_found');
    });
    const bridge = createChatSdkBridge({
      adapter: stubAdapter(fetchMessages),
      supportsThreads: true,
      classifyRecoveryError: classify,
    });
    await bridge.setup(setup);

    await expect(
      bridge.recoverMissedMessages!({
        since: '2026-07-21T18:16:00Z',
        reason: 'transport-ready',
        targets: [{ platformId: 'stub:C', threadId: null, isDM: false }],
      }),
    ).resolves.toEqual({ scannedTargets: 1, recoveredMessages: 0, failedTargets: 0 });

    const dead = JSON.parse(JSON.parse(readKv('nanoclaw:recovery-dead:stub')!)) as Record<string, { error: string }>;
    expect(Object.values(dead)[0].error).toContain('channel_not_found');
    // Pass completed → gap floor cleared, cursor advanced (the window is unfrozen).
    expect(readKv('nanoclaw:recovery-gap:stub')).toBeUndefined();

    fetchMessages.mockClear();
    await expect(
      bridge.recoverMissedMessages!({
        since: '2026-07-21T18:16:00Z',
        reason: 'event-loop-stall',
        targets: [{ platformId: 'stub:C', threadId: null, isDM: false }],
      }),
    ).resolves.toEqual({ scannedTargets: 0, recoveredMessages: 0, failedTargets: 0 });
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  it('parks a target reported failed by discovery with a permanent error', async () => {
    const fetchMessages = vi.fn(async () => ({ messages: [] }));
    const bridge = createChatSdkBridge({
      adapter: stubAdapter(fetchMessages),
      supportsThreads: true,
      classifyRecoveryError: classify,
      discoverRecoveryTargets: async () => ({
        targets: [],
        complete: true,
        failed: [
          { target: { platformId: 'stub:C', threadId: null, isDM: false }, error: new Error('channel_not_found') },
        ],
      }),
    });
    await bridge.setup(setup);

    await expect(
      bridge.recoverMissedMessages!({
        since: '2026-07-21T18:16:00Z',
        reason: 'transport-ready',
        targets: [{ platformId: 'stub:C', threadId: null, isDM: false }],
      }),
    ).resolves.toEqual({ scannedTargets: 0, recoveredMessages: 0, failedTargets: 0 });
    expect(fetchMessages).not.toHaveBeenCalled();
    expect(readKv('nanoclaw:recovery-dead:stub')).toBeDefined();
  });

  it('re-probes an expired dead entry and clears it on success', async () => {
    const expired = { 'stub:C-expired-key': { until: '2020-01-01T00:00:00.000Z', error: 'channel_not_found' } };
    getDb()
      .prepare('INSERT INTO chat_sdk_kv (key, value, expires_at) VALUES (?, ?, NULL)')
      .run('nanoclaw:recovery-dead:stub', JSON.stringify(JSON.stringify(expired)));
    const fetchMessages = vi.fn(async () => ({ messages: [] }));
    const bridge = createChatSdkBridge({
      adapter: stubAdapter(fetchMessages),
      supportsThreads: true,
      classifyRecoveryError: classify,
    });
    await bridge.setup(setup);

    await expect(
      bridge.recoverMissedMessages!({
        since: '2026-07-21T18:16:00Z',
        reason: 'transport-ready',
        targets: [{ platformId: 'stub:C', threadId: null, isDM: false }],
      }),
    ).resolves.toEqual({ scannedTargets: 1, recoveredMessages: 0, failedTargets: 0 });
    expect(fetchMessages).toHaveBeenCalled();
    const dead = JSON.parse(JSON.parse(readKv('nanoclaw:recovery-dead:stub')!)) as Record<string, unknown>;
    expect(Object.keys(dead)).toHaveLength(0);
  });

  it('still fails the pass on a transient error (default classification)', async () => {
    const fetchMessages = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const bridge = createChatSdkBridge({
      adapter: stubAdapter(fetchMessages),
      supportsThreads: true,
      classifyRecoveryError: classify,
    });
    await bridge.setup(setup);

    await expect(
      bridge.recoverMissedMessages!({
        since: '2026-07-21T18:16:00Z',
        reason: 'transport-ready',
        targets: [{ platformId: 'stub:C', threadId: null, isDM: false }],
      }),
    ).resolves.toEqual({ scannedTargets: 1, recoveredMessages: 0, failedTargets: 1 });
    expect(readKv('nanoclaw:recovery-dead:stub')).toBeUndefined();
  });
});
