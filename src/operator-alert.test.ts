import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  roleRows: [] as Array<{ user_id: string }>,
  deliver: vi.fn<(...a: unknown[]) => Promise<string>>(),
  ensureUserDm: vi.fn(),
  adapter: null as unknown,
}));

vi.mock('./db/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/connection.js')>()),
  getDb: () => ({ all: async () => mocks.roleRows }),
}));
vi.mock('./modules/permissions/user-dm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./modules/permissions/user-dm.js')>()),
  ensureUserDm: (...args: unknown[]) => mocks.ensureUserDm(...args),
}));
vi.mock('./delivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./delivery.js')>()),
  getDeliveryAdapter: () => mocks.adapter,
}));
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import { notifyOperators } from './operator-alert.js';
import { registerSecrets } from './secret-scrubber.js';

beforeEach(() => {
  mocks.roleRows = [{ user_id: 'discord:owner-1' }];
  mocks.deliver.mockReset().mockResolvedValue('plat-1');
  mocks.ensureUserDm.mockReset().mockResolvedValue({ channel_type: 'discord', platform_id: 'dm-1' });
  mocks.adapter = { deliver: mocks.deliver };
});

describe('notifyOperators', () => {
  it('delivers to the owner and reports a real receipt', async () => {
    expect(await notifyOperators('something broke')).toBe(true);
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
  });

  it('reports FAILURE when there is no adapter, so no caller stamps a cooldown on nothing', async () => {
    mocks.adapter = null;
    expect(await notifyOperators('something broke')).toBe(false);
  });

  it('reports failure when no owner or global admin exists', async () => {
    mocks.roleRows = [];
    expect(await notifyOperators('something broke')).toBe(false);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it('reports failure when every recipient send throws', async () => {
    mocks.deliver.mockRejectedValue(new Error('slack down'));
    expect(await notifyOperators('something broke')).toBe(false);
  });

  it('sends through ONE bot only, even with several owner rows', async () => {
    mocks.roleRows = [{ user_id: 'discord:owner-1' }, { user_id: 'slack:owner-1' }];
    expect(await notifyOperators('something broke')).toBe(true);
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
  });

  it('falls over to the next recipient when the first is unreachable', async () => {
    mocks.roleRows = [{ user_id: 'discord:owner-1' }, { user_id: 'slack:owner-1' }];
    mocks.ensureUserDm.mockResolvedValueOnce(null);
    expect(await notifyOperators('something broke')).toBe(true);
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
  });

  // Codex round 3, P1. The registry resolves adapters by EXACT key
  // (`getChannelAdapterExact(instance ?? channelType)`), so on a multi-bot
  // install an alert sent without the instance looks up a bare `discord`
  // adapter that does not exist — undeliverable — or reaches the wrong bot.
  // This PR exists because the previous notification path was undeliverable
  // when it mattered; shipping a second one would fix nothing.
  it("routes through the owner DM's resolved adapter instance", async () => {
    mocks.ensureUserDm.mockResolvedValue({
      channel_type: 'discord',
      platform_id: 'dm-1',
      instance: 'discord-ops-bot',
    });
    expect(await notifyOperators('something broke')).toBe(true);
    // 7th argument is the instance the registry keys on.
    expect(mocks.deliver.mock.calls[0]![6]).toBe('discord-ops-bot');
  });

  it('falls back to the channel type when the DM has no named instance', async () => {
    mocks.ensureUserDm.mockResolvedValue({ channel_type: 'discord', platform_id: 'dm-1', instance: null });
    expect(await notifyOperators('something broke')).toBe(true);
    expect(mocks.deliver.mock.calls[0]![6]).toBe('discord');
  });

  it('scrubs secrets out of the alert body', async () => {
    // Alerts quote what failed, and what failed is often agent or command
    // output. The outbound scrubber in delivery.ts is not on this path.
    registerSecrets({ TEST_TOKEN: 'sk-super-secret-value' });
    await notifyOperators('the task died carrying sk-super-secret-value in its output');
    const body = JSON.parse(mocks.deliver.mock.calls[0]![4] as string) as { text: string };
    expect(body.text).not.toContain('sk-super-secret-value');
    expect(body.text).toContain('[REDACTED]');
  });
});
