/**
 * Regression test: `ncl messaging-groups create` must satisfy the NOT NULL
 * `instance` column without an operator-supplied `--instance`. The column has
 * no CLI flag at the operator's altitude (the default instance IS the channel
 * type), so the generic CRUD insert defaults it to `channel_type` — matching
 * `createMessagingGroup`'s `instance ?? channel_type` fallback on the router
 * path. Delete the `instance` column / `defaultFrom` wiring in
 * `messaging-groups.ts` and this goes red: the insert fails the NOT NULL.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

const { TEST_DIR, getDeliveryAdapter } = vi.hoisted(() => ({
  TEST_DIR: uniqueTmpRoot('test-cli-msggroups'),
  getDeliveryAdapter: vi.fn(),
}));

vi.mock('../../delivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../delivery.js')>()),
  getDeliveryAdapter,
}));

import type { ChannelDefaults } from '../../channels/adapter.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { initTestDb, closeDb, runMigrations, getRawDb } from '../../db/index.js';
import { createMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import type { MessagingGroup } from '../../types.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `messaging-groups-create` command.
import './messaging-groups.js';

// Registration-tier declaration (no live adapter) — the environment `ncl`
// sees for offline instances and setup scripts.
const declared: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};
registerChannelAdapter('declchan-mg', { factory: () => null, defaults: declared });

describe('messaging-groups CLI create defaults instance to channel_type', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await initTestDb();
    runMigrations(getRawDb());
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('create without --instance sets instance = channel_type', async () => {
    // caller: 'host' is the post-approval re-entry path for create (approval op).
    const resp = await dispatch(
      {
        id: 'req-1',
        command: 'messaging-groups-create',
        args: { channel_type: 'telegram', platform_id: '12345' },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const row = await getMessagingGroupByPlatform('telegram', '12345');
    expect(row).toBeDefined();
    expect(row?.instance).toBe('telegram');
  });

  it('create with an explicit --instance keeps that value', async () => {
    const resp = await dispatch(
      {
        id: 'req-2',
        command: 'messaging-groups-create',
        args: { channel_type: 'telegram', platform_id: '67890', instance: 'work' },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect((await getMessagingGroupByPlatform('telegram', '67890', 'work'))?.instance).toBe('work');
  });
});

describe('messaging-groups CLI create resolves unknown_sender_policy from the channel declaration', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await initTestDb();
    runMigrations(getRawDb());
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  const create = (args: Record<string, unknown>, id: string) =>
    dispatch({ id, command: 'messaging-groups-create', args }, { caller: 'host' });

  it('DM context takes the declared dm policy', async () => {
    const resp = await create({ channel_type: 'declchan-mg', platform_id: 'dm-1' }, 'req-d1');
    expect(resp.ok).toBe(true);
    expect((await getMessagingGroupByPlatform('declchan-mg', 'dm-1'))?.unknown_sender_policy).toBe('public');
  });

  it('group context takes the declared group policy', async () => {
    const resp = await create({ channel_type: 'declchan-mg', platform_id: 'g-1', is_group: '1' }, 'req-d2');
    expect(resp.ok).toBe(true);
    expect((await getMessagingGroupByPlatform('declchan-mg', 'g-1'))?.unknown_sender_policy).toBe('request_approval');
  });

  it('explicit --unknown-sender-policy wins over the declaration', async () => {
    const resp = await create(
      { channel_type: 'declchan-mg', platform_id: 'dm-2', unknown_sender_policy: 'strict' },
      'req-d3',
    );
    expect(resp.ok).toBe(true);
    expect((await getMessagingGroupByPlatform('declchan-mg', 'dm-2'))?.unknown_sender_policy).toBe('strict');
  });

  it("undeclared channels keep the legacy static 'strict' default (back-compat)", async () => {
    const resp = await create({ channel_type: 'stalechan-mg', platform_id: 's-1' }, 'req-d4');
    expect(resp.ok).toBe(true);
    expect((await getMessagingGroupByPlatform('stalechan-mg', 's-1'))?.unknown_sender_policy).toBe('strict');
  });
});

describe('messaging-groups CLI notify', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await initTestDb();
    runMigrations(getRawDb());
    vi.mocked(getDeliveryAdapter).mockReset();
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  function createUnwiredNamedInstanceGroup(): MessagingGroup {
    const group: MessagingGroup = {
      id: 'mg-notify',
      channel_type: 'test-channel',
      platform_id: 'destination-current',
      instance: 'test-channel-secondary',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(group);
    return group;
  }

  it('delivers directly to an unwired group through its exact named adapter instance', async () => {
    const group = createUnwiredNamedInstanceGroup();
    const deliver = vi.fn().mockResolvedValue('platform-message');
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver } as ChannelDeliveryAdapter);

    const response = await dispatch(
      {
        id: 'notify-1',
        command: 'messaging-groups-notify',
        args: { id: group.id, text: 'Weekly report body' },
      },
      { caller: 'host' },
    );

    expect(response).toMatchObject({
      ok: true,
      data: {
        delivered: {
          messaging_group_id: group.id,
          channel_type: group.channel_type,
          platform_id: group.platform_id,
          instance: group.instance,
          platform_message_id: 'platform-message',
        },
      },
    });
    expect(deliver).toHaveBeenCalledWith(
      group.channel_type,
      group.platform_id,
      null,
      'chat',
      JSON.stringify({ text: 'Weekly report body' }),
      undefined,
      group.instance,
    );
    const wiringCount = getRawDb()
      .prepare('SELECT COUNT(*) AS count FROM messaging_group_agents WHERE messaging_group_id = ?')
      .get(group.id) as { count: number };
    expect(wiringCount.count).toBe(0);
  });

  it('fails cleanly when the target or delivery adapter is unavailable', async () => {
    const missing = await dispatch(
      {
        id: 'notify-2',
        command: 'messaging-groups-notify',
        args: { id: 'missing-group', text: 'Weekly report body' },
      },
      { caller: 'host' },
    );
    expect(missing).toMatchObject({ ok: false, error: { code: 'handler-error', message: /not found/ } });

    const group = createUnwiredNamedInstanceGroup();
    vi.mocked(getDeliveryAdapter).mockReturnValue(null);
    const unavailable = await dispatch(
      {
        id: 'notify-3',
        command: 'messaging-groups-notify',
        args: { id: group.id, text: 'Weekly report body' },
      },
      { caller: 'host' },
    );
    expect(unavailable).toMatchObject({ ok: false, error: { code: 'handler-error', message: /adapter unavailable/ } });
  });

  it('requires id and text and rejects every container caller', async () => {
    const missingText = await dispatch(
      { id: 'notify-4', command: 'messaging-groups-notify', args: { id: 'mg-notify' } },
      { caller: 'host' },
    );
    expect(missingText).toMatchObject({ ok: false, error: { code: 'invalid-args', message: /--text is required/ } });

    const agent = await dispatch(
      {
        id: 'notify-5',
        command: 'messaging-groups-notify',
        args: { id: 'mg-notify', text: 'Weekly report body' },
      },
      {
        caller: 'agent',
        sessionId: 'test-session',
        agentGroupId: 'test-agent-group',
        messagingGroupId: 'mg-notify',
      },
    );
    expect(agent).toMatchObject({ ok: false, error: { code: 'forbidden', message: /operator-only/ } });
  });
});
