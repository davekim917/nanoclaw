/**
 * Discord inbound and outbound over the real transport stack: the host's Discord wiring (discord.ts), the real
 * `@chat-adapter/discord` with its pnpm patch, a real discord.js Client on a real gateway WebSocket, and the real Chat
 * SDK bridge with its local webhook server. Only Discord is fake: a local server answers REST and speaks the gateway
 * protocol. discord.js emits `raw` and then builds its own objects from the same packet, so a forwarder that
 * serializes late sees the packet discord.js mutated; only a real Client on a real socket reproduces that order.
 */
import http from 'http';
import type { AddressInfo } from 'net';

import { DefaultRestOptions } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import { allowNetwork } from '../test-hermeticity.js';
import type { ChannelSetup, InboundMessage } from './adapter.js';
import { serveAttachments } from '../test-attachment-transport.js';

const TOKEN = 'live-path-test-token';
const BOT = '123456789000000001';
const HUMAN = '123456789000000002';
const GUILD = '123456789000000003';
const CHANNEL = '123456789000000004';
const DM_CHANNEL = '123456789000000005';
const THREAD = '123456789000000006';

vi.mock('../env.js', async (importOriginal) => {
  const values: Record<string, string> = {
    DISCORD_BOT_TOKEN: TOKEN,
    DISCORD_PUBLIC_KEY: '0'.repeat(64),
    DISCORD_APPLICATION_ID: '123456789000000001',
  };
  return {
    ...(await importOriginal<typeof import('../env.js')>()),
    readEnvFileMatching: (pattern: RegExp) =>
      Object.fromEntries(Object.entries(values).filter(([key]) => pattern.test(key))),
    readEnvFile: () => values,
  };
});

const botUser = { id: BOT, username: 'example-agent', discriminator: '0', global_name: null, bot: true, avatar: null };
const humanUser = {
  id: HUMAN,
  username: 'example.user',
  discriminator: '0',
  global_name: 'Example User',
  avatar: null,
};
const channel = { id: CHANNEL, type: 0, guild_id: GUILD, name: 'general', position: 0, permission_overwrites: [] };
const thread = { id: THREAD, type: 11, guild_id: GUILD, parent_id: CHANNEL, name: 'a thread', thread_metadata: {} };

let server: http.Server;
let gateway: WebSocketServer;
let socket: WebSocket | null = null;
let seq = 0;
let identifyToken: string | undefined;
let identifyIntents = 0;
const unfaked: string[] = [];
const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
const inbound: Array<{ platformId: string; threadId: string | null; message: InboundMessage }> = [];
const waiters: Array<() => void> = [];
let registry: typeof import('./channel-registry.js');
let savedApiUrl: string | undefined;
// The adapter constructs its own discord.js Client, so the library default is the only way to point its REST at the
// fake. It is typed read-only but is a plain object at runtime.
const restDefaults = DefaultRestOptions as { api: string };
const savedRestApi = restDefaults.api;

function dispatch(t: string, d: unknown): void {
  seq += 1;
  socket!.send(JSON.stringify({ op: 0, t, s: seq, d }));
}

function rest(method: string, path: string, body: Record<string, unknown>): [number, unknown] {
  if (method === 'GET' && path === '/gateway/bot') {
    const { port } = server.address() as AddressInfo;
    return [
      200,
      {
        url: `ws://127.0.0.1:${port}`,
        shards: 1,
        session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
      },
    ];
  }
  if (method === 'GET' && path === '/users/@me') return [200, botUser];
  if (method === 'GET' && path === `/channels/${CHANNEL}`) return [200, channel];
  if (method === 'GET' && path === `/channels/${THREAD}`) return [200, thread];
  if (method === 'GET' && path === `/channels/${DM_CHANNEL}`) return [200, { id: DM_CHANNEL, type: 1 }];
  if (method === 'GET' && path === `/guilds/${GUILD}/channels`) return [200, [channel]];
  if (method === 'POST' && /^\/channels\/\d+\/messages$/.test(path)) {
    posted.push({ path, body });
    return [200, { id: '123456789000000099', channel_id: path.split('/')[2], content: body.content, author: botUser }];
  }
  if (method === 'POST' && /^\/channels\/\d+\/messages\/\d+\/threads$/.test(path)) return [201, thread];
  unfaked.push(`${method} ${path}`);
  return [404, { message: 'Unknown', code: 0 }];
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw && (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(raw) : {}));
  });
}

function nextInbound(count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`expected ${count} inbound message(s), got ${inbound.length}`)),
      3_000,
    );
    const check = (): void => {
      if (inbound.length >= count) {
        clearTimeout(timer);
        resolve();
      } else {
        waiters.push(check);
      }
    };
    check();
  });
}

function messageCreate(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    type: 0,
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    flags: 0,
    author: humanUser,
    ...fields,
  };
}

beforeAll(async () => {
  allowNetwork();
  const { initMigratedTestDb } = await import('../db/index.js');
  await initMigratedTestDb();

  const answer = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const path = (req.url ?? '').replace(/^\/api(\/v\d+)?/, '').split('?')[0]!;
    const [status, body] = rest(req.method ?? 'GET', path, await readBody(req));
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  server = http.createServer((req, res) => void answer(req, res));
  gateway = new WebSocketServer({ server });
  gateway.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as { op: number; d: { token?: string; intents?: number } };
      if (frame.op === 1) ws.send(JSON.stringify({ op: 11 }));
      if (frame.op === 2) {
        identifyToken = frame.d.token;
        identifyIntents = frame.d.intents ?? 0;
        const { port } = server.address() as AddressInfo;
        dispatch('READY', {
          v: 10,
          user: botUser,
          guilds: [{ id: GUILD, unavailable: true }],
          session_id: 'live-path-session',
          resume_gateway_url: `ws://127.0.0.1:${port}`,
          application: { id: BOT, flags: 0 },
        });
        dispatch('GUILD_CREATE', {
          id: GUILD,
          name: 'Example Guild',
          owner_id: HUMAN,
          unavailable: false,
          member_count: 2,
          roles: [
            {
              id: GUILD,
              name: '@everyone',
              permissions: '0',
              position: 0,
              color: 0,
              hoist: false,
              managed: false,
              mentionable: false,
            },
          ],
          channels: [channel],
          threads: [],
          members: [],
          emojis: [],
          features: [],
        });
      }
    });
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  restDefaults.api = `http://127.0.0.1:${port}/api`;
  savedApiUrl = process.env.DISCORD_API_URL;
  process.env.DISCORD_API_URL = `http://127.0.0.1:${port}/api/v10`;

  await import('./discord.js');
  registry = await import('./channel-registry.js');
  const setup: ChannelSetup = {
    onInbound: async (platformId, threadId, msg) => {
      inbound.push({ platformId, threadId, message: msg });
      for (const wake of waiters.splice(0)) wake();
    },
    onInboundEvent: async () => {},
    onMetadata: async () => {},
    onAction: () => {},
  };
  await registry.initChannelAdapters(() => setup);
  const deadline = Date.now() + 10_000;
  while (identifyToken === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  if (identifyToken === undefined) throw new Error('discord.js never identified to the fake gateway');
  await new Promise((r) => setTimeout(r, 200));
}, 30_000);

afterAll(async () => {
  await registry?.teardownChannelAdapters();
  restDefaults.api = savedRestApi;
  if (savedApiUrl === undefined) delete process.env.DISCORD_API_URL;
  else process.env.DISCORD_API_URL = savedApiUrl;
  gateway?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  const { closeDb } = await import('../db/index.js');
  await closeDb();
});

describe('Discord inbound and outbound through the real adapter and discord.js gateway', () => {
  it('identifies to the gateway with the bot token and the intents inbound needs', () => {
    expect(identifyToken).toBe(TOKEN);
    // Discord withholds what an intent does not ask for: DMs without DirectMessages, message text without
    // MessageContent. The fake gateway delivers regardless, so the request itself is the contract.
    const required = { Guilds: 1 << 0, GuildMessages: 1 << 9, DirectMessages: 1 << 12, MessageContent: 1 << 15 };
    const missing = Object.entries(required).filter(([, bit]) => (identifyIntents & bit) === 0);
    expect(missing.map(([name]) => name)).toEqual([]);
  });

  it('delivers a guild @mention that discord.js turns circular once it builds its Message', async () => {
    inbound.length = 0;
    dispatch(
      'MESSAGE_CREATE',
      messageCreate('123456789000000010', {
        channel_id: CHANNEL,
        guild_id: GUILD,
        content: `<@${BOT}> status please`,
        member: { roles: [], joined_at: new Date(0).toISOString(), deaf: false, mute: false },
        mentions: [
          { ...botUser, member: { roles: [], joined_at: new Date(0).toISOString(), deaf: false, mute: false } },
        ],
      }),
    );
    await nextInbound(1);

    expect(inbound[0]!.platformId).toContain(CHANNEL);
    expect(inbound[0]!.message).toMatchObject({ isMention: true, isDM: false });
    expect(inbound[0]!.message.content).toMatchObject({
      text: expect.stringContaining('status please'),
      author: expect.objectContaining({ userId: HUMAN }),
    });
  });

  it('delivers a reply to the bot, whose implicit mention discord.js also turns circular', async () => {
    inbound.length = 0;
    const member = { roles: [], joined_at: new Date(0).toISOString(), deaf: false, mute: false };
    dispatch(
      'MESSAGE_CREATE',
      messageCreate('123456789000000013', {
        type: 19,
        channel_id: CHANNEL,
        guild_id: GUILD,
        content: 'thanks, and one more thing',
        member,
        mentions: [{ ...botUser, member }],
        message_reference: { message_id: '123456789000000099', channel_id: CHANNEL, guild_id: GUILD },
        referenced_message: messageCreate('123456789000000099', {
          channel_id: CHANNEL,
          guild_id: GUILD,
          author: botUser,
          content: 'an earlier answer',
        }),
      }),
    );
    await nextInbound(1);

    expect(inbound[0]!.message).toMatchObject({ isMention: true, isDM: false });
    expect(inbound[0]!.message.content).toMatchObject({ text: expect.stringContaining('one more thing') });
  });

  it('downloads an attachment above the adapter default without sending the bot token to the CDN', async () => {
    const { INBOUND_ATTACHMENT_MAX_BYTES } = await import('../config.js');
    const MiB = 1024 * 1024;
    const big = `https://cdn.discordapp.com/attachments/${CHANNEL}/123456789000000020/originals.zip`;
    const huge = `https://cdn.discordapp.com/attachments/${CHANNEL}/123456789000000021/footage.zip`;
    const requests = serveAttachments(
      new Map([
        [big, 30 * MiB],
        [huge, INBOUND_ATTACHMENT_MAX_BYTES + 1],
      ]),
    );
    const attachment = (id: string, filename: string, size: number, url: string) => ({
      id,
      filename,
      size,
      url,
      proxy_url: url.replace('cdn.discordapp.com', 'media.discordapp.net'),
      content_type: 'application/zip',
    });
    inbound.length = 0;
    dispatch(
      'MESSAGE_CREATE',
      messageCreate('123456789000000014', {
        channel_id: DM_CHANNEL,
        content: 'the archives',
        attachments: [
          attachment('123456789000000021', 'footage.zip', 101 * MiB, huge),
          attachment('123456789000000020', 'originals.zip', 30 * MiB, big),
        ],
      }),
    );
    await nextInbound(1);

    const attachments = (inbound[0]!.message.content as { attachments: Array<{ name: string; data?: string }> })
      .attachments;
    expect(attachments.map((a) => a.name)).toEqual(['footage.zip', 'originals.zip']);
    expect(attachments[0]!.data).toBeUndefined();
    expect(Buffer.from(attachments[1]!.data ?? '', 'base64').length).toBe(30 * MiB);
    expect(requests).toEqual([{ url: big, authorization: undefined }]);
  });

  it('delivers a plain guild message as not a mention', async () => {
    inbound.length = 0;
    dispatch(
      'MESSAGE_CREATE',
      messageCreate('123456789000000011', {
        channel_id: CHANNEL,
        guild_id: GUILD,
        content: 'just chatting',
        member: { roles: [], joined_at: new Date(0).toISOString(), deaf: false, mute: false },
      }),
    );
    await nextInbound(1);

    expect(inbound[0]!.message).toMatchObject({ isMention: false, isDM: false });
    expect(inbound[0]!.message.content).toMatchObject({ text: 'just chatting' });
  });

  it('delivers a direct message as a DM addressed to the bot', async () => {
    inbound.length = 0;
    dispatch(
      'MESSAGE_CREATE',
      messageCreate('123456789000000012', { channel_id: DM_CHANNEL, content: 'a private question' }),
    );
    await nextInbound(1);

    expect(inbound[0]!.platformId).toContain(DM_CHANNEL);
    expect(inbound[0]!.message).toMatchObject({ isMention: true, isDM: true });
    expect(inbound[0]!.message.content).toMatchObject({ text: 'a private question' });
  });

  it('posts an agent reply into a thread through the REST API', async () => {
    const adapter = registry.getChannelAdapterExact('discord')!;
    posted.length = 0;
    await adapter.deliver(`discord:${GUILD}:${CHANNEL}`, `discord:${GUILD}:${CHANNEL}:${THREAD}`, {
      kind: 'chat',
      content: { text: 'a reply from the agent' },
    });

    expect(posted.map((p) => p.path)).toContain(`/channels/${THREAD}/messages`);
    expect(JSON.stringify(posted)).toContain('a reply from the agent');
  });

  it('answers every REST call the host made, so no step ran on a faked failure', () => {
    expect(unfaked).toEqual([]);
  });
});
