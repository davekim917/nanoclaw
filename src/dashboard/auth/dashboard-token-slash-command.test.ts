import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../../channels/chat-sdk-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../channels/chat-sdk-bridge.js')>()),
  registerSlashCommandHandler: vi.fn(),
}));

vi.mock('../../modules/permissions/db/user-roles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/permissions/db/user-roles.js')>()),
  isAnyAdmin: vi.fn(),
}));

vi.mock('../../modules/permissions/db/agent-group-members.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/permissions/db/agent-group-members.js')>()),
  hasAnyMembership: vi.fn(),
}));

vi.mock('../../modules/permissions/db/users.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/permissions/db/users.js')>()),
  upsertUser: vi.fn(),
}));

vi.mock('./dashboard-token-issue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dashboard-token-issue.js')>()),
  mintDashboardTokenUrl: vi.fn(),
  formatTtl: vi.fn(() => '720h'),
}));

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope — importOriginal() would
// install those in this test file's worker. Kept as a complete stub instead.
// (davekim917/nanoclaw#355 review thread)
vi.mock('../../log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import { dashboardTokenSlashCommand } from './dashboard-token-slash-command.js';
import { isAnyAdmin } from '../../modules/permissions/db/user-roles.js';
import { hasAnyMembership } from '../../modules/permissions/db/agent-group-members.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { mintDashboardTokenUrl } from './dashboard-token-issue.js';
import type { SlashCommandEvent } from 'chat';

function makeEvent(overrides: Partial<SlashCommandEvent> = {}): SlashCommandEvent {
  return {
    adapter: { name: 'slack-test' } as SlashCommandEvent['adapter'],
    channel: {} as SlashCommandEvent['channel'],
    command: '/dashboard-token',
    openModal: vi.fn(),
    raw: { response_url: 'https://hooks.slack.com/commands/T1/1/abc' },
    text: '',
    user: { userId: 'U123', userName: 'alex', fullName: 'Alex Example', isBot: false, isMe: false },
    ...overrides,
  } as SlashCommandEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('dashboardTokenSlashCommand', () => {
  it('test_authorized_admin_mints_and_replies_ephemerally', async () => {
    vi.mocked(isAnyAdmin).mockReturnValue(true);
    vi.mocked(hasAnyMembership).mockReturnValue(false);
    vi.mocked(mintDashboardTokenUrl).mockResolvedValue({
      url: 'http://localhost:3000/observatory/#token=abc123',
      ttlHours: 720,
    });

    await dashboardTokenSlashCommand(makeEvent());

    // Identity mapping: <channel_type>:<slack_user_id>
    expect(isAnyAdmin).toHaveBeenCalledWith('slack-test:U123');
    expect(upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'slack-test:U123', kind: 'slack-test', display_name: 'Alex Example' }),
    );
    expect(mintDashboardTokenUrl).toHaveBeenCalledWith('slack-test:U123');

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.slack.com/commands/T1/1/abc');
    const body = JSON.parse(init.body as string) as { response_type: string; text: string };
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toContain('http://localhost:3000/observatory/#token=abc123');
  });

  it('test_authorized_member_without_admin_role_mints', async () => {
    vi.mocked(isAnyAdmin).mockReturnValue(false);
    vi.mocked(hasAnyMembership).mockReturnValue(true);
    vi.mocked(mintDashboardTokenUrl).mockResolvedValue({ url: 'http://x/#token=y', ttlHours: 24 });

    await dashboardTokenSlashCommand(makeEvent());

    expect(mintDashboardTokenUrl).toHaveBeenCalledWith('slack-test:U123');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('test_unauthorized_user_gets_ephemeral_denial_no_mint', async () => {
    vi.mocked(isAnyAdmin).mockReturnValue(false);
    vi.mocked(hasAnyMembership).mockReturnValue(false);

    await dashboardTokenSlashCommand(makeEvent());

    expect(mintDashboardTokenUrl).not.toHaveBeenCalled();
    expect(upsertUser).not.toHaveBeenCalled();

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { response_type: string; text: string };
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toMatch(/don't have dashboard access/i);
  });

  it('test_missing_response_url_is_a_noop', async () => {
    vi.mocked(isAnyAdmin).mockReturnValue(true);

    await dashboardTokenSlashCommand(makeEvent({ raw: {} }));

    expect(mintDashboardTokenUrl).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('test_reply_never_carries_channel_id_only_response_url', async () => {
    // Regression guard: the handler must never fall back to posting via a
    // channel/messaging-group path (which would require bot membership).
    vi.mocked(isAnyAdmin).mockReturnValue(true);
    vi.mocked(mintDashboardTokenUrl).mockResolvedValue({ url: 'http://x/#token=z', ttlHours: 1 });

    await dashboardTokenSlashCommand(makeEvent({ raw: { response_url: 'https://hooks.slack.com/commands/T1/2/def' } }));

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls[0][0]).toBe('https://hooks.slack.com/commands/T1/2/def');
  });
});
