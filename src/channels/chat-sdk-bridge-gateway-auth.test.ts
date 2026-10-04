import http from 'http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelSetup } from './adapter.js';
import { startLocalWebhookServer } from './chat-sdk-bridge.js';

const BOT_TOKEN = 'test-bot-token';

const click = JSON.stringify({
  type: 'GATEWAY_INTERACTION_CREATE',
  data: {
    type: 3,
    id: 'interaction-1',
    token: 'interaction-token',
    channel_id: 'chan-1',
    data: { custom_id: 'ncq:q-1:approve' },
    member: { user: { id: 'clicker-1', username: 'clicker' } },
    message: { id: 'card-1', embeds: [] },
  },
});
const message = JSON.stringify({ type: 'GATEWAY_MESSAGE_CREATE', data: { id: 'm-1', content: 'hi' } });

const realFetch = globalThis.fetch;
let discordApi: ReturnType<typeof vi.fn>;

beforeEach(() => {
  discordApi = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', discordApi);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function start(botToken: string | undefined) {
  const handleWebhook = vi.fn(async () => new Response('ok'));
  const onAction = vi.fn();
  const setupConfig = {
    onInbound: async () => {},
    onInboundEvent: async () => {},
    onMetadata: () => {},
    onAction,
  } as unknown as ChannelSetup;
  const url = await startLocalWebhookServer({ name: 'discord', handleWebhook } as never, setupConfig, botToken);
  const post = (body: string, headers: Record<string, string> = {}) =>
    realFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  return { url, post, onAction, handleWebhook };
}

describe('startLocalWebhookServer — gateway token', () => {
  it.each([
    ['no gateway token', {}],
    ['a wrong gateway token', { 'x-discord-gateway-token': 'not-the-token' }],
  ])('rejects a request with %s before any handling', async (_label, headers) => {
    const { post, onAction, handleWebhook } = await start(BOT_TOKEN);
    for (const body of [click, message]) {
      expect((await post(body, headers)).status).toBe(401);
    }
    expect(onAction).not.toHaveBeenCalled();
    expect(handleWebhook).not.toHaveBeenCalled();
    expect(discordApi).not.toHaveBeenCalled();
  });

  it('answers 401 without waiting for the request body', async () => {
    const { url } = await start(BOT_TOKEN);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request(url, { method: 'POST', headers: { 'Content-Length': '1000' } }, (res) => {
        resolve(res.statusCode);
        req.destroy();
      });
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(status).toBe(401);
  });

  it('rejects every request when no bot token is configured', async () => {
    const { post, onAction, handleWebhook } = await start(undefined);
    expect((await post(click, { 'x-discord-gateway-token': '' })).status).toBe(401);
    expect((await post(message)).status).toBe(401);
    expect(onAction).not.toHaveBeenCalled();
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it('forwards an event when the gateway token matches', async () => {
    const { post, handleWebhook } = await start(BOT_TOKEN);
    expect((await post(message, { 'x-discord-gateway-token': BOT_TOKEN })).status).toBe(200);
    expect(handleWebhook).toHaveBeenCalledTimes(1);
  });
});
