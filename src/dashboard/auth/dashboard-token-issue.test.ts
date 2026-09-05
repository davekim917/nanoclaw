import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../../delivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../delivery.js')>()),
  getDeliveryAdapter: vi.fn(),
}));

vi.mock('../../db/messaging-groups.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/messaging-groups.js')>()),
  getMessagingGroup: vi.fn(),
}));

vi.mock('../../modules/permissions/user-dm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/permissions/user-dm.js')>()),
  ensureUserDm: vi.fn(),
}));

vi.mock('../db/dashboard-tokens.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/dashboard-tokens.js')>()),
  issueDashboardToken: vi.fn(),
}));

vi.mock('./cookie.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cookie.js')>()),
  resolveServerKey: vi.fn(() => Buffer.from('a'.repeat(64), 'hex')),
  dashboardSessionTtlHours: vi.fn(() => 720),
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

// Suppress side-effect registration during test module load
vi.mock('../../command-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../command-gate.js')>()),
  registerInterceptHandler: vi.fn(),
  getInterceptHandler: vi.fn(),
  clearInterceptHandlers: vi.fn(),
}));

import { dashboardTokenIssue } from './dashboard-token-issue.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { ensureUserDm } from '../../modules/permissions/user-dm.js';
import { issueDashboardToken } from '../db/dashboard-tokens.js';
import type { MessagingGroup } from '../../types.js';
import crypto from 'crypto';

function makeCtx(overrides = {}) {
  return {
    userId: 'u1',
    replyMessagingGroupId: 'mg-1',
    command: '/dashboard-token',
    args: '',
    ...overrides,
  };
}

function makeSlackMg(): MessagingGroup {
  return {
    id: 'mg-1',
    channel_type: 'slack-test',
    platform_id: 'platform-1',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'public',
    denied_at: null,
    created_at: new Date().toISOString(),
  };
}

function makeSlackChannelMg(): MessagingGroup {
  return {
    id: 'mg-channel-1',
    channel_type: 'slack-test',
    platform_id: 'channel-platform-1',
    name: '#shared-channel',
    is_group: 1,
    unknown_sender_policy: 'public',
    denied_at: null,
    created_at: new Date().toISOString(),
  };
}

function makeSlackDmMg(): MessagingGroup {
  return {
    id: 'mg-dm-1',
    channel_type: 'slack-test',
    platform_id: 'dm-platform-1',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    denied_at: null,
    created_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dashboardTokenIssue', () => {
  it('test_dashboardTokenIssue_inserts_hmac_row', async () => {
    const deliverMock = vi.fn().mockResolvedValue('msg-id');
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver: deliverMock } as never);
    vi.mocked(getMessagingGroup).mockReturnValue(makeSlackMg());
    vi.mocked(issueDashboardToken).mockResolvedValue({
      id: 1,
      user_id: 'u1',
      token_hmac: 'hmac',
      issued_at: new Date().toISOString(),
      expires_at: new Date().toISOString(),
      used_at: null,
    });

    await dashboardTokenIssue(makeCtx());

    expect(issueDashboardToken).toHaveBeenCalledOnce();
    const [calledUserId, calledHmac, calledTtl] = vi.mocked(issueDashboardToken).mock.calls[0] as [
      string,
      string,
      number,
    ];
    expect(calledUserId).toBe('u1');
    expect(calledTtl).toBe(720); // hours; mirrors dashboardSessionTtlHours() default + Set-Cookie Max-Age

    // Verify HMAC matches what we'd compute from the raw token in the deliver call
    expect(deliverMock).toHaveBeenCalledOnce();
    const deliveredContent = JSON.parse(deliverMock.mock.calls[0][4] as string) as { text: string };
    const rawTokenMatch = deliveredContent.text.match(/([0-9a-f]{64})/);
    expect(rawTokenMatch).not.toBeNull();
    const rawToken = rawTokenMatch![1];

    // raw token must NOT equal the hmac stored
    expect(rawToken).not.toBe(calledHmac);

    // verify the hmac was computed correctly from the raw token
    const { resolveServerKey } = await import('./cookie.js');
    const serverKey = resolveServerKey();
    const expectedHmac = crypto.createHmac('sha256', serverKey).update(rawToken).digest('hex');
    expect(calledHmac).toBe(expectedHmac);
  });

  it('test_dashboardTokenIssue_reply_text_contains_url', async () => {
    const deliverMock = vi.fn().mockResolvedValue('msg-id');
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver: deliverMock } as never);
    vi.mocked(getMessagingGroup).mockReturnValue(makeSlackMg());
    vi.mocked(issueDashboardToken).mockResolvedValue({
      id: 1,
      user_id: 'u1',
      token_hmac: 'hmac',
      issued_at: new Date().toISOString(),
      expires_at: new Date().toISOString(),
      used_at: null,
    });

    await dashboardTokenIssue(makeCtx());

    const deliveredContent = JSON.parse(deliverMock.mock.calls[0][4] as string) as { text: string };
    // One clickable link carrying the token in the FRAGMENT. The fragment is
    // never sent to the server, so a live token cannot reach an access or
    // proxy log; a query param would, which is why that form stays banned.
    expect(deliveredContent.text).toMatch(/https?:\/\/[^/]+\/observatory\/#token=[0-9a-f]{64}/);
    expect(deliveredContent.text).not.toMatch(/\?token=/);
  });

  it('test_dashboardTokenIssue_token_entropy', async () => {
    const deliverMock = vi.fn().mockResolvedValue('msg-id');
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver: deliverMock } as never);
    vi.mocked(getMessagingGroup).mockReturnValue(makeSlackMg());
    vi.mocked(issueDashboardToken).mockResolvedValue({
      id: 1,
      user_id: 'u1',
      token_hmac: 'hmac',
      issued_at: new Date().toISOString(),
      expires_at: new Date().toISOString(),
      used_at: null,
    });

    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      await dashboardTokenIssue(makeCtx());
      const deliveredContent = JSON.parse(deliverMock.mock.calls[i][4] as string) as { text: string };
      const match = deliveredContent.text.match(/([0-9a-f]{64})/);
      expect(match).not.toBeNull();
      const rawToken = match![1];
      expect(rawToken).toHaveLength(64);
      tokens.add(rawToken);
    }
    expect(tokens.size).toBe(100);
  });

  it('test_dashboardTokenIssue_no_messaging_group', async () => {
    const deliverMock = vi.fn();
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver: deliverMock } as never);
    vi.mocked(getMessagingGroup).mockReturnValue(undefined);

    await dashboardTokenIssue(makeCtx());

    // Must NOT call issueDashboardToken (no orphan token rows)
    expect(issueDashboardToken).not.toHaveBeenCalled();
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('test_dashboardTokenIssue_group_routes_link_to_dm_not_channel', async () => {
    const deliverMock = vi.fn().mockResolvedValue('msg-id');
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver: deliverMock } as never);
    vi.mocked(getMessagingGroup).mockReturnValue(makeSlackChannelMg());
    vi.mocked(ensureUserDm).mockResolvedValue(makeSlackDmMg());
    vi.mocked(issueDashboardToken).mockResolvedValue({
      id: 1,
      user_id: 'u1',
      token_hmac: 'hmac',
      issued_at: new Date().toISOString(),
      expires_at: new Date().toISOString(),
      used_at: null,
    });

    await dashboardTokenIssue(makeCtx());

    expect(ensureUserDm).toHaveBeenCalledWith('u1');
    expect(issueDashboardToken).toHaveBeenCalledOnce();
    expect(deliverMock).toHaveBeenCalledTimes(2);

    // First deliver: the DM, carrying the token.
    const dmCall = deliverMock.mock.calls[0];
    expect(dmCall[0]).toBe('slack-test');
    expect(dmCall[1]).toBe('dm-platform-1'); // the DM's platform_id, NOT the channel's
    const dmContent = JSON.parse(dmCall[4] as string) as { text: string };
    expect(dmContent.text).toMatch(/#token=[0-9a-f]{64}/);

    // Second deliver: the channel, credential-free.
    const channelCall = deliverMock.mock.calls[1];
    expect(channelCall[0]).toBe('slack-test');
    expect(channelCall[1]).toBe('channel-platform-1'); // back to the original channel
    const channelContent = JSON.parse(channelCall[4] as string) as { text: string };
    expect(channelContent.text).not.toMatch(/token=/);
    expect(channelContent.text).not.toMatch(/[0-9a-f]{64}/);
    expect(channelContent.text).not.toMatch(/https?:\/\//);
  });

  it('test_dashboardTokenIssue_group_no_dm_path_fails_closed', async () => {
    const deliverMock = vi.fn().mockResolvedValue('msg-id');
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver: deliverMock } as never);
    vi.mocked(getMessagingGroup).mockReturnValue(makeSlackChannelMg());
    vi.mocked(ensureUserDm).mockResolvedValue(null); // platform has no DM capability, or openDM threw

    await dashboardTokenIssue(makeCtx());

    // No credential minted when there's nowhere private to put it.
    expect(issueDashboardToken).not.toHaveBeenCalled();

    // Exactly one message, and it carries no URL, no token, no hint that a
    // credential exists.
    expect(deliverMock).toHaveBeenCalledOnce();
    const call = deliverMock.mock.calls[0];
    expect(call[0]).toBe('slack-test');
    expect(call[1]).toBe('channel-platform-1');
    const content = JSON.parse(call[4] as string) as { text: string };
    expect(content.text).not.toMatch(/token=/);
    expect(content.text).not.toMatch(/[0-9a-f]{64}/);
    expect(content.text).not.toMatch(/https?:\/\//);
  });

  it('test_dashboardTokenIssue_dm_invocation_never_calls_ensureUserDm', async () => {
    // Regression: a DM invocation is already private — must not pay the
    // extra openDM round trip, and must reply in the same conversation.
    const deliverMock = vi.fn().mockResolvedValue('msg-id');
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver: deliverMock } as never);
    vi.mocked(getMessagingGroup).mockReturnValue(makeSlackMg());
    vi.mocked(issueDashboardToken).mockResolvedValue({
      id: 1,
      user_id: 'u1',
      token_hmac: 'hmac',
      issued_at: new Date().toISOString(),
      expires_at: new Date().toISOString(),
      used_at: null,
    });

    await dashboardTokenIssue(makeCtx());

    expect(ensureUserDm).not.toHaveBeenCalled();
    expect(deliverMock).toHaveBeenCalledOnce();
    expect(deliverMock.mock.calls[0][1]).toBe('platform-1');
  });
});
