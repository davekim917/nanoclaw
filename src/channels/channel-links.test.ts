import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { linkDiscordChannelNames, linkSlackChannelNames, type KnownChannel } from './channel-links.js';
import { registerSlackBot, unregisterSlackBot, type SlackBotIdentity } from './slack-mentions.js';

const BOT_A: SlackBotIdentity = {
  userId: 'UTESTA001',
  username: 'bot-a',
  teamId: 'TTEST1',
  workspaceUrl: 'https://example.slack.com/',
};
const BOT_A2: SlackBotIdentity = { userId: 'UTESTA002', username: 'bot-a2', teamId: 'TTEST1' };
const BOT_B: SlackBotIdentity = { userId: 'UTESTB001', username: 'bot-b', teamId: 'TTEST2' };

const CHANNELS: KnownChannel[] = [
  { channelType: 'slack-a', platformId: 'slack:CTESTBUILD', name: '#build-room' },
  // The same channel seen by a sibling bot: one channel, not a collision.
  { channelType: 'slack-a2', platformId: 'slack:CTESTBUILD', name: 'build-room' },
  { channelType: 'slack-a', platformId: 'slack:DTESTDM1', name: 'someone' },
  { channelType: 'slack-b', platformId: 'slack:COTHER01', name: 'elsewhere' },
  { channelType: 'slack-a', platformId: 'slack:CTESTDUP1', name: 'dup' },
  { channelType: 'slack-a2', platformId: 'slack:CTESTDUP2', name: 'dup' },
  { channelType: 'discord', platformId: 'discord:100:200', name: 'ops-desk' },
  { channelType: 'discord', platformId: 'discord:@me:300', name: 'someone-dm' },
];

describe('linkSlackChannelNames', () => {
  beforeEach(() => {
    registerSlackBot('slack-a', BOT_A);
    registerSlackBot('slack-a2', BOT_A2);
    registerSlackBot('slack-b', BOT_B);
  });
  afterEach(() => {
    unregisterSlackBot('slack-a', BOT_A);
    unregisterSlackBot('slack-a2', BOT_A2);
    unregisterSlackBot('slack-b', BOT_B);
  });

  const link = (text: string) => linkSlackChannelNames(text, 'slack-a', CHANNELS);

  it('links a known channel in the same workspace to its permalink', () => {
    expect(link('flagged it in #build-room, posted numbers')).toBe(
      'flagged it in [#build-room](https://example.slack.com/archives/CTESTBUILD), posted numbers',
    );
  });

  it('leaves unknown, other-workspace, DM and ambiguous names as text', () => {
    for (const text of ['see #nowhere', 'see #elsewhere', 'see #someone', 'see #dup']) expect(link(text)).toBe(text);
  });

  it('never touches code, links, URLs, issue refs or headings', () => {
    const text = [
      'run `grep #build-room`',
      '[#build-room](https://x.test/a)',
      'https://example.com/page#build-room',
      'APP#2135 and #2135',
      '# Heading',
      '<#CTESTBUILD>',
    ].join('\n');
    expect(link(text)).toBe(text);
  });

  it('does nothing for a bot this host does not know', () => {
    expect(linkSlackChannelNames('see #build-room', 'slack-unknown', CHANNELS)).toBe('see #build-room');
  });
});

describe('linkDiscordChannelNames', () => {
  it('turns a known guild channel into a native mention', () => {
    expect(linkDiscordChannelNames('ask in #ops-desk.', CHANNELS)).toBe('ask in <#200>.');
  });

  it('leaves DMs and unknown names alone', () => {
    expect(linkDiscordChannelNames('ping #someone or #nope', CHANNELS)).toBe('ping #someone or #nope');
  });
});
