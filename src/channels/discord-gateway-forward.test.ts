import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiscordAdapter } from '@chat-adapter/discord';
import { Client, Message } from 'discord.js';

const GUILD = '1001';
const CHANNEL = '1002';
const AUTHOR = '1003';
const MENTIONED = '1004';

/**
 * discord.js emits `raw` and then builds a Message from the same packet object; for a guild mention,
 * MessageMentions sets `mention.member.user = mention`, so the packet becomes circular. A forwarder that
 * serializes after a tick sends nothing. Drives the real adapter and the real discord.js Message.
 */
describe('Discord gateway forward of MESSAGE_CREATE', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('forwards a guild mention as emitted, after discord.js has built a Message from the same packet', async () => {
    let rawListener: ((packet: unknown) => Promise<void>) | undefined;
    const clients: Client[] = [];
    const originalOn = Client.prototype.on;
    vi.spyOn(Client.prototype, 'login').mockResolvedValue('token');
    vi.spyOn(Client.prototype, 'on').mockImplementation(function (this: Client, event: string, listener: never) {
      if (event === 'raw') {
        rawListener = listener;
        clients.push(this);
      }
      return originalOn.call(this, event as never, listener);
    } as never);
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response('ok');
    });
    const errors: string[] = [];
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error: (message: string) => errors.push(message),
      child() {
        return logger;
      },
    };
    const adapter = createDiscordAdapter({ botToken: 'x', publicKey: '0'.repeat(64), applicationId: '1', logger });
    void (adapter as unknown as { runGatewayListener(ms: number, s: undefined, url: string): Promise<void> })
      .runGatewayListener(200, undefined, 'http://127.0.0.1/hook')
      .catch(() => {});
    await vi.waitFor(() => expect(rawListener).toBeDefined());
    (clients[0].guilds as unknown as { _add(data: object): void })._add({
      id: GUILD,
      name: 'Guild',
      channels: [],
      members: [],
      roles: [],
    });

    const packet = {
      t: 'MESSAGE_CREATE',
      d: {
        id: '1005',
        channel_id: CHANNEL,
        guild_id: GUILD,
        type: 0,
        content: `<@${MENTIONED}> hi`,
        timestamp: new Date(0).toISOString(),
        author: { id: AUTHOR, username: 'user', discriminator: '0' },
        member: { roles: [] },
        mentions: [{ id: MENTIONED, username: 'agent', discriminator: '0', bot: true, member: { roles: [] } }],
        mention_roles: [],
        attachments: [],
        embeds: [],
      },
    };
    const forwarded = rawListener!(packet);
    new (Message as unknown as new (c: Client, d: object) => Message)(clients[0], packet.d);
    expect(() => JSON.stringify(packet.d)).toThrow(/circular/);
    await forwarded;

    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(errors).toEqual([]);
    expect(bodies[0]).toMatchObject({ type: 'GATEWAY_MESSAGE_CREATE', data: { content: `<@${MENTIONED}> hi` } });
  });
});
