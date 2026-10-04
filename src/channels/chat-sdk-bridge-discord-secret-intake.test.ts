import http from 'http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import type { ChannelSetup, SecretIntakeHooks } from './adapter.js';
import { handleForwardedEvent, isDiscordSecretIntakeEvent, startLocalWebhookServer } from './chat-sdk-bridge.js';

const SECRET = 'sk-live-DISCORD-SENTINEL-7f3a';
const SECOND = 'cs-live-DISCORD-SENTINEL-9b21';

function hooks(overrides: Partial<SecretIntakeHooks> = {}) {
  return {
    open: vi.fn(
      overrides.open ??
        (async () => ({
          ok: true as const,
          form: {
            title: 'Store secret',
            body: 'Example-Client',
            inputs: [
              { id: 'client_id', label: 'Client ID' },
              { id: 'client_secret', label: 'A label that is much longer than forty-five characters', optional: true },
            ],
          },
        })),
    ),
    submit: vi.fn(overrides.submit ?? (async () => ({ ok: true as const }))),
  };
}

function setup(intake?: ReturnType<typeof hooks>): ChannelSetup {
  return {
    onInbound: async () => {},
    onInboundEvent: async () => {},
    onMetadata: () => {},
    onAction: vi.fn(),
    ...(intake ? { secretIntake: intake } : {}),
  } as ChannelSetup;
}

function click(intakeId: string, user: Record<string, unknown> = { member: { user: { id: '555' } } }): string {
  return JSON.stringify({
    type: 'GATEWAY_INTERACTION_CREATE',
    data: { type: 3, id: 'i-1', token: 't-1', data: { custom_id: `ncs:${intakeId}` }, ...user },
  });
}

function submit(intakeId: string, rows: unknown[]): string {
  return JSON.stringify({
    type: 'GATEWAY_INTERACTION_CREATE',
    data: {
      type: 5,
      id: 'i-2',
      token: 't-2',
      user: { id: '555' },
      data: { custom_id: `nc-secret-intake:${intakeId}`, components: rows },
    },
  });
}

const gatewayAdapter = () =>
  ({ name: 'discord', handleWebhook: vi.fn(async () => new Response('ok')) }) as unknown as Adapter & {
    handleWebhook: ReturnType<typeof vi.fn>;
  };

function stubFetch() {
  const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    bodies: () => fetchMock.mock.calls.map((call) => JSON.parse(call[1]!.body as string)),
    urls: () => fetchMock.mock.calls.map((call) => String(call[0])),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Discord secret intake', () => {
  it('answers the card button with a private modal built from the form', async () => {
    const f = stubFetch();
    const intake = hooks();
    const adapter = gatewayAdapter();
    await handleForwardedEvent(click('si-abc'), adapter, setup(intake), 'bot');

    expect(intake.open).toHaveBeenCalledWith('si-abc', '555');
    expect(f.urls()).toEqual(['https://discord.com/api/v10/interactions/i-1/t-1/callback']);
    const [response] = f.bodies();
    expect(response.type).toBe(9);
    expect(response.data.custom_id).toBe('nc-secret-intake:si-abc');
    expect(response.data.title).toBe('Store secret');
    const inputs = response.data.components.map((row: { components: unknown[] }) => row.components[0]);
    expect(inputs).toMatchObject([
      { type: 4, custom_id: 'client_id', label: 'Client ID', required: true },
      { type: 4, custom_id: 'client_secret', required: false },
    ]);
    expect(Array.from(inputs[1].label as string)).toHaveLength(45);
    expect(adapter.handleWebhook).not.toHaveBeenCalled();
  });

  it('takes the clicker from a DM interaction too', async () => {
    stubFetch();
    const intake = hooks();
    await handleForwardedEvent(click('si-abc', { user: { id: '777' } }), gatewayAdapter(), setup(intake), 'bot');
    expect(intake.open).toHaveBeenCalledWith('si-abc', '777');
  });

  it('refuses privately, with no modal, when the host refuses to open', async () => {
    const f = stubFetch();
    const intake = hooks({ open: async () => ({ ok: false, message: 'Only an owner can enter this.' }) });
    await handleForwardedEvent(click('si-abc'), gatewayAdapter(), setup(intake), 'bot');
    expect(f.bodies()).toEqual([
      { type: 4, data: { content: 'Only an owner can enter this.', flags: 64, allowed_mentions: { parse: [] } } },
    ]);
  });

  it('refuses a click the bot has no intake hooks for', async () => {
    const f = stubFetch();
    await handleForwardedEvent(click('si-abc'), gatewayAdapter(), setup(), 'bot');
    expect(f.bodies()[0]).toMatchObject({ type: 4, data: { flags: 64 } });
  });

  it('passes every submitted field to the host by its id, from action rows and labels alike', async () => {
    const f = stubFetch();
    const intake = hooks();
    const adapter = gatewayAdapter();
    await handleForwardedEvent(
      submit('si-abc', [
        { type: 1, components: [{ type: 4, custom_id: 'client_id', value: SECRET }] },
        { type: 18, component: { type: 4, custom_id: 'client_secret', value: SECOND } },
      ]),
      adapter,
      setup(intake),
      'bot',
    );
    expect(intake.submit).toHaveBeenCalledWith('si-abc', '555', { client_id: SECRET, client_secret: SECOND });
    expect(f.bodies()[0]).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(f.bodies()[0].data.content).toMatch(/^Received/);
    expect(adapter.handleWebhook).not.toHaveBeenCalled();
  });

  it('says privately why a submit was refused, and that nothing was stored', async () => {
    const f = stubFetch();
    const intake = hooks({ submit: async () => ({ ok: false, message: '"Client ID" is empty.', field: 'client_id' }) });
    await handleForwardedEvent(submit('si-abc', []), gatewayAdapter(), setup(intake), 'bot');
    expect(f.bodies()[0]).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(f.bodies()[0].data.content).toContain('"Client ID" is empty. Nothing was stored.');
  });

  it('leaves every other interaction to the existing handlers', async () => {
    const f = stubFetch();
    const intake = hooks();
    const adapter = gatewayAdapter();
    const other = JSON.stringify({
      type: 'GATEWAY_INTERACTION_CREATE',
      data: {
        type: 5,
        id: 'i-9',
        token: 't-9',
        user: { id: '555' },
        data: { custom_id: 'someone-else:x', components: [] },
      },
    });
    await handleForwardedEvent(other, adapter, setup(intake), 'bot');
    expect(intake.submit).not.toHaveBeenCalled();
    expect(f.fetchMock).not.toHaveBeenCalled();
    expect(adapter.handleWebhook).toHaveBeenCalledTimes(1);
  });

  it('never logs or answers with a submitted value', async () => {
    const f = stubFetch();
    const { log } = await import('../log.js');
    const logged = [
      vi.spyOn(log, 'info'),
      vi.spyOn(log, 'warn'),
      vi.spyOn(log, 'error'),
      vi.spyOn(log, 'debug'),
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'error'),
    ];
    const intake = hooks({ submit: async () => ({ ok: false, message: 'Refused.' }) });
    f.fetchMock.mockImplementation(async () => new Response('bad', { status: 500 }));
    await handleForwardedEvent(
      submit('si-abc', [{ type: 1, components: [{ type: 4, custom_id: 'client_id', value: SECRET }] }]),
      gatewayAdapter(),
      setup(intake),
      'bot',
    );
    const observable = JSON.stringify([f.bodies(), f.urls(), logged.map((spy) => spy.mock.calls)]);
    expect(observable).not.toContain(SECRET);
  });

  it('recognises only its own interactions as urgent', () => {
    expect(isDiscordSecretIntakeEvent(click('si-abc'))).toBe(true);
    expect(isDiscordSecretIntakeEvent(submit('si-abc', []))).toBe(true);
    expect(
      isDiscordSecretIntakeEvent(
        JSON.stringify({ type: 'GATEWAY_INTERACTION_CREATE', data: { type: 3, data: { custom_id: 'ncq:q:0' } } }),
      ),
    ).toBe(false);
    expect(isDiscordSecretIntakeEvent(JSON.stringify({ type: 'GATEWAY_MESSAGE_CREATE', data: {} }))).toBe(false);
    expect(isDiscordSecretIntakeEvent('not json "GATEWAY_INTERACTION_CREATE"')).toBe(false);
  });

  it('answers a card click while an earlier forwarded event is still being handled', async () => {
    const f = stubFetch();
    let release!: () => void;
    const handleWebhook = vi.fn(
      () => new Promise<Response>((resolve) => (release = () => resolve(new Response('ok')))),
    );
    const adapter = { name: 'discord', handleWebhook };
    const url = await startLocalWebhookServer(adapter as never, setup(hooks()), 'bot');
    const post = (body: string) =>
      new Promise<void>((resolve, reject) => {
        const req = http.request(url, { method: 'POST', headers: { 'x-discord-gateway-token': 'bot' } }, (res) => {
          res.resume();
          res.on('end', () => resolve());
        });
        req.on('error', reject);
        req.end(body);
      });

    const slow = post(JSON.stringify({ type: 'GATEWAY_MESSAGE_CREATE', data: {} }));
    await vi.waitFor(() => expect(handleWebhook).toHaveBeenCalledTimes(1));
    await post(click('si-abc'));
    expect(f.bodies()[0]?.type).toBe(9);
    release();
    await slow;
  });
});
