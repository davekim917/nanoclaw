/**
 * Slack sibling-bot loop governor.
 *
 * The unit layer pins the counting rules; the bridge layer proves a dropped
 * message never reaches the host — the governor is wired as the Slack
 * bridge's `inboundFilter`, so a bug there is a message that still wakes a
 * container.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, Chat } from 'chat';
import { Message, parseMarkdown } from 'chat';

const captured = vi.hoisted(() => ({ chat: null as unknown }));

vi.mock('../webhook-server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../webhook-server.js')>()),
  registerWebhookAdapter: vi.fn((chat: unknown) => {
    captured.chat = chat;
  }),
}));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import type { ChannelSetup, InboundMessage } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerSlackBot, type SlackBotIdentity } from './slack-mentions.js';
import { slackHopInboundFilter } from './slack.js';
import { createSlackHopGovernor, DEFAULT_MAX_BOT_HOPS, parseMaxBotHops } from './slack-hop-limit.js';

const THREAD = 'slack:C1:ts-1';

describe('parseMaxBotHops', () => {
  it('falls back to the default for absent and malformed values', () => {
    for (const raw of [undefined, '', '   ', 'six', '-1', '2.5', 'NaN']) {
      expect(parseMaxBotHops(raw)).toBe(DEFAULT_MAX_BOT_HOPS);
    }
  });

  it('honors an explicit limit, and treats 0 as disabled', () => {
    expect(parseMaxBotHops('3')).toBe(3);
    expect(parseMaxBotHops('0')).toBe(0);
  });
});

describe('createSlackHopGovernor', () => {
  const sibling = { threadId: THREAD, isSiblingBot: true, isHuman: false };
  const human = { threadId: THREAD, isSiblingBot: false, isHuman: true };

  it('admits sibling turns up to the limit, then drops', () => {
    const governor = createSlackHopGovernor('slack', () => 3);
    expect([1, 2, 3].map(() => governor.admit(sibling))).toEqual([true, true, true]);
    expect(governor.admit(sibling)).toBe(false);
    expect(governor.admit(sibling)).toBe(false);
  });

  it('resets on a human message, so a supervised exchange never stalls', () => {
    const governor = createSlackHopGovernor('slack', () => 2);
    governor.admit(sibling);
    governor.admit(sibling);
    expect(governor.admit(sibling)).toBe(false);
    expect(governor.admit(human)).toBe(true);
    expect(governor.hops(THREAD)).toBe(0);
    expect(governor.admit(sibling)).toBe(true);
  });

  it('counts per thread, so a runaway in one thread does not mute another', () => {
    const governor = createSlackHopGovernor('slack', () => 1);
    expect(governor.admit(sibling)).toBe(true);
    expect(governor.admit(sibling)).toBe(false);
    expect(governor.admit({ ...sibling, threadId: 'slack:C1:ts-2' })).toBe(true);
  });

  it('never counts or drops a third-party bot', () => {
    const governor = createSlackHopGovernor('slack', () => 1);
    const foreign = { threadId: THREAD, isSiblingBot: false, isHuman: false };
    for (let i = 0; i < 5; i++) expect(governor.admit(foreign)).toBe(true);
    expect(governor.hops(THREAD)).toBe(0);
    expect(governor.admit(sibling)).toBe(true);
  });

  it('logs the mute once, not once per dropped message', async () => {
    const { log } = await import('../log.js');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const governor = createSlackHopGovernor('slack', () => 1);
      governor.admit(sibling);
      for (let i = 0; i < 5; i++) expect(governor.admit(sibling)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);

      // A human resets the mute, so the NEXT runaway is reported again.
      governor.admit(human);
      governor.admit(sibling);
      expect(governor.admit(sibling)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('is disabled at 0', () => {
    const governor = createSlackHopGovernor('slack', () => 0);
    for (let i = 0; i < 50; i++) expect(governor.admit(sibling)).toBe(true);
  });

  it('bounds the tracked-thread map instead of growing for the life of the host', () => {
    const governor = createSlackHopGovernor('slack', () => 5);
    for (let i = 0; i < 1200; i++) governor.admit({ ...sibling, threadId: `slack:C1:ts-${i}` });
    // The oldest threads were evicted; the newest are still counted.
    expect(governor.hops('slack:C1:ts-0')).toBe(0);
    expect(governor.hops('slack:C1:ts-1199')).toBe(1);
  });
});

const SELF: SlackBotIdentity = { userId: 'UBOT_SELF', username: 'nano', teamId: 'T1' };
const SIBLING: SlackBotIdentity = { userId: 'UBOT_SIB', username: 'nano-codex', teamId: 'T1' };
const FOREIGN_WORKSPACE: SlackBotIdentity = { userId: 'UBOT_OTHER', username: 'nano-other', teamId: 'T2' };

describe('slackHopInboundFilter — projecting a Chat SDK message', () => {
  beforeEach(() => {
    registerSlackBot('slack-hop-self', SELF);
    registerSlackBot('slack-hop-sib', SIBLING);
    registerSlackBot('slack-hop-other', FOREIGN_WORKSPACE);
  });

  const msg = (author: { userId?: string; isBot?: boolean | 'unknown' }) => ({ threadId: THREAD, author });

  it('counts a sibling in the same workspace', () => {
    const governor = createSlackHopGovernor('slack', () => 1);
    expect(slackHopInboundFilter(governor, SELF, msg({ userId: SIBLING.userId, isBot: true }))).toBe(true);
    expect(slackHopInboundFilter(governor, SELF, msg({ userId: SIBLING.userId, isBot: true }))).toBe(false);
  });

  it('does not count a bot from another workspace', () => {
    const governor = createSlackHopGovernor('slack', () => 1);
    for (let i = 0; i < 4; i++) {
      expect(slackHopInboundFilter(governor, SELF, msg({ userId: FOREIGN_WORKSPACE.userId, isBot: true }))).toBe(true);
    }
    expect(governor.hops(THREAD)).toBe(0);
  });

  it('fails closed with no identity — nothing is a sibling, nothing is dropped', () => {
    const governor = createSlackHopGovernor('slack', () => 1);
    for (let i = 0; i < 4; i++) {
      expect(slackHopInboundFilter(governor, null, msg({ userId: SIBLING.userId, isBot: true }))).toBe(true);
    }
    expect(governor.hops(THREAD)).toBe(0);
  });

  it('treats an unknown-isBot stranger as a human, so the counter still resets', () => {
    const governor = createSlackHopGovernor('slack', () => 1);
    slackHopInboundFilter(governor, SELF, msg({ userId: SIBLING.userId, isBot: true }));
    expect(governor.hops(THREAD)).toBe(1);
    expect(slackHopInboundFilter(governor, SELF, msg({ userId: 'U-human', isBot: 'unknown' }))).toBe(true);
    expect(governor.hops(THREAD)).toBe(0);
  });

  it('a third-party bot neither counts nor resets', () => {
    const governor = createSlackHopGovernor('slack', () => 2);
    slackHopInboundFilter(governor, SELF, msg({ userId: SIBLING.userId, isBot: true }));
    expect(slackHopInboundFilter(governor, SELF, msg({ userId: 'B-github', isBot: true }))).toBe(true);
    expect(governor.hops(THREAD)).toBe(1);
  });
});

/** Drive the bridge's real inbound path with the governor installed. */
async function runThroughBridge(
  authors: Array<{ userId: string; isBot: boolean }>,
  maxHops: number,
): Promise<string[]> {
  const adapter = {
    name: 'slack',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => threadId.split(':').slice(0, 2).join(':'),
  } as unknown as Adapter;

  const governor = createSlackHopGovernor('slack', () => maxHops);
  const bridge = createChatSdkBridge({
    adapter,
    supportsThreads: true,
    inboundFilter: (message, ctx) => (ctx.recovered ? true : slackHopInboundFilter(governor, SELF, message)),
  });

  const delivered: string[] = [];
  await bridge.setup({
    onInbound: async (_platformId: string, _threadId: string | null, message: InboundMessage) => {
      delivered.push(message.id);
    },
    onInboundEvent: async () => {},
    onMetadata: () => {},
    onAction: () => {},
  } as unknown as ChannelSetup);

  const chat = captured.chat as Chat;
  expect(chat).toBeTruthy();

  for (const [index, author] of authors.entries()) {
    const message = new Message({
      id: `m-${index}`,
      threadId: THREAD,
      text: 'over to you',
      formatted: parseMarkdown('over to you'),
      raw: {},
      author: { userId: author.userId, userName: 'x', fullName: 'X', isBot: author.isBot, isMe: false },
      metadata: { dateSent: new Date(Date.UTC(2026, 8, 3, 0, index)), edited: false },
      attachments: [],
    } as never);
    await chat.processMessage(adapter, THREAD, message);
  }
  return delivered;
}

describe('the governor never runs on recovery', () => {
  /**
   * Recovery pages arrive newest-first and are sorted only afterwards, so a
   * stateful filter fed from them both mis-orders its state and re-judges
   * history the live path already judged. Goes red if the ctx.recovered
   * opt-out is dropped from the Slack wiring.
   */
  const wired =
    (governor: ReturnType<typeof createSlackHopGovernor>) =>
    (
      message: { threadId: string; author?: { userId?: string; isBot?: boolean | 'unknown' } },
      ctx: { recovered: boolean },
    ) => (ctx.recovered ? true : slackHopInboundFilter(governor, SELF, message));

  it('admits recovered sibling messages past the limit and leaves the counter untouched', () => {
    const governor = createSlackHopGovernor('slack', () => 1);
    const filter = wired(governor);
    const message = { threadId: THREAD, author: { userId: SIBLING.userId, isBot: true } };
    for (let i = 0; i < 5; i++) expect(filter(message, { recovered: true })).toBe(true);
    expect(governor.hops(THREAD)).toBe(0);
    // The live path is still governed afterwards.
    expect(filter(message, { recovered: false })).toBe(true);
    expect(filter(message, { recovered: false })).toBe(false);
  });
});

describe('the governor as the Slack bridge inboundFilter', () => {
  beforeEach(() => {
    captured.chat = null;
    registerSlackBot('slack-hop-self', SELF);
    registerSlackBot('slack-hop-sib', SIBLING);
    runMigrations(initTestDb());
  });

  afterEach(() => {
    closeDb();
  });

  it('stops a runaway sibling exchange from reaching the host at all', async () => {
    const sibling = { userId: SIBLING.userId, isBot: true };
    const delivered = await runThroughBridge([sibling, sibling, sibling, sibling], 2);
    expect(delivered).toEqual(['m-0', 'm-1']);
  });

  it('lets the exchange continue once a human speaks in the thread', async () => {
    const sibling = { userId: SIBLING.userId, isBot: true };
    const human = { userId: 'U-human', isBot: false };
    const delivered = await runThroughBridge([sibling, sibling, sibling, human, sibling], 2);
    expect(delivered).toEqual(['m-0', 'm-1', 'm-3', 'm-4']);
  });

  it('never blocks a human, however long the bot exchange ran', async () => {
    const sibling = { userId: SIBLING.userId, isBot: true };
    const human = { userId: 'U-human', isBot: false };
    const delivered = await runThroughBridge([sibling, sibling, sibling, human], 1);
    expect(delivered).toEqual(['m-0', 'm-3']);
  });
});
