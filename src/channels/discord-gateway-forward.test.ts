import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiscordAdapter } from '@chat-adapter/discord';
import { Client } from 'discord.js';

/**
 * discord.js emits `raw` and then patches the same packet object in place (Message._patch sets
 * `data.member.user = this.author`, a client-bound User), so a forwarder that serializes the packet
 * after a tick sends a circular structure. Drives the real adapter and the real discord.js Client.
 */
describe('Discord gateway forward of MESSAGE_CREATE', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('forwards the packet as it was emitted, even after discord.js mutates it', async () => {
    let rawListener: ((packet: unknown) => Promise<void>) | undefined;
    const originalOn = Client.prototype.on;
    vi.spyOn(Client.prototype, 'login').mockResolvedValue('token');
    vi.spyOn(Client.prototype, 'on').mockImplementation(function (this: Client, event: string, listener: never) {
      if (event === 'raw') rawListener = listener;
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

    const packet = {
      t: 'MESSAGE_CREATE',
      d: {
        id: '9',
        channel_id: 'c1',
        guild_id: 'g1',
        content: 'hi',
        author: { id: 'u1', username: 'user', bot: false },
        member: { roles: [] as string[] } as Record<string, unknown>,
      },
    };
    const forwarded = rawListener!(packet);
    const author: Record<string, unknown> = { id: 'u1' };
    Object.assign(packet.d.member, { user: author });
    author.member = packet.d.member;
    await forwarded;

    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(errors).toEqual([]);
    expect(bodies[0]).toMatchObject({ type: 'GATEWAY_MESSAGE_CREATE', data: { id: '9', content: 'hi' } });
  });
});
