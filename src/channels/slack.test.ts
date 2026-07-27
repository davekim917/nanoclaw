import { describe, expect, it, vi } from 'vitest';

import {
  extractSlackChannelId,
  parseSlackWorkspaces,
  slackPostParent,
  slackCreateThread,
  discoverSlackRecoveryTargets,
  makeSlackRecoveryPageFetcher,
  type SlackPostMessageClient,
} from './slack.js';

describe('Slack missed-message recovery', () => {
  it('parses channel-root history with each message native thread id', async () => {
    const parseSlackMessage = vi.fn(async (raw: unknown, threadId: string) => ({
      id: (raw as { ts: string }).ts,
      threadId,
      metadata: { dateSent: new Date('2026-07-21T18:17:00Z') },
    }));
    const fetchPage = makeSlackRecoveryPageFetcher(
      { fetchMessages: vi.fn(), parseSlackMessage } as never,
      {
        conversations: {
          history: vi.fn().mockResolvedValue({ messages: [{ ts: '1753121820.000001' }] }),
        },
      } as never,
    );

    const result = await fetchPage('slack:C1:', {
      limit: 100,
      direction: 'backward',
      since: '2026-07-21T18:16:00Z',
    });

    expect(parseSlackMessage).toHaveBeenCalledWith({ ts: '1753121820.000001' }, 'slack:C1:1753121820.000001');
    expect(result.messages[0].threadId).toBe('slack:C1:1753121820.000001');
  });

  it('uses Slack native cursor pagination for large threads instead of the adapter backward-fetch truncation', async () => {
    const replies = vi.fn().mockResolvedValue({
      messages: [{ ts: '1753121880.000001', thread_ts: '1650000000.000001' }],
      response_metadata: { next_cursor: 'next-page' },
    });
    const parseSlackMessage = vi.fn(async (raw: unknown, threadId: string) => ({
      id: (raw as { ts: string }).ts,
      threadId,
      metadata: { dateSent: new Date('2026-07-21T18:18:00Z') },
    }));
    const adapterFetchMessages = vi.fn();
    const slackAdapter = { fetchMessages: adapterFetchMessages, parseSlackMessage };
    const fetchPage = makeSlackRecoveryPageFetcher(
      slackAdapter as never,
      {
        conversations: { replies },
      } as never,
    );

    const result = await fetchPage('slack:C1:1650000000.000001', {
      limit: 100,
      direction: 'backward',
      cursor: 'current-page',
      since: '2025-07-21T18:16:00Z',
    });

    expect(adapterFetchMessages).not.toHaveBeenCalled();
    expect(replies).toHaveBeenCalledWith({
      channel: 'C1',
      ts: '1650000000.000001',
      limit: 100,
      cursor: 'current-page',
      oldest: String(Date.parse('2025-07-21T18:16:00Z') / 1000),
    });
    expect(parseSlackMessage).toHaveBeenCalledWith(
      { ts: '1753121880.000001', thread_ts: '1650000000.000001' },
      'slack:C1:1650000000.000001',
    );
    expect(result.nextCursor).toBe('next-page');
  });

  it('discovers a thread created during the recovery gap', async () => {
    const result = await discoverSlackRecoveryTargets(
      {
        conversations: {
          history: vi.fn().mockResolvedValue({
            messages: [{ ts: '1753121820.000001', reply_count: 1, latest_reply: '1753121880.000001' }],
          }),
        },
      } as never,
      {
        since: '2025-07-21T18:16:00Z',
        reason: 'event-loop-stall',
        targets: [{ platformId: 'slack:C1', threadId: null, isDM: false }],
      },
    );

    expect(result).toEqual({
      targets: [{ platformId: 'slack:C1', threadId: 'slack:C1:1753121820.000001', isDM: false }],
      complete: true,
    });
  });

  it('continues past old roots because they can receive their first reply during the gap', async () => {
    const history = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ ts: '1700000000.000001' }],
        response_metadata: { next_cursor: 'older' },
      })
      .mockResolvedValueOnce({
        messages: [{ ts: '1650000000.000001', reply_count: 1, latest_reply: '1753121880.000001' }],
      });

    const result = await discoverSlackRecoveryTargets({ conversations: { history } } as never, {
      since: '2025-07-21T18:16:00Z',
      reason: 'event-loop-stall',
      targets: [{ platformId: 'slack:C1', threadId: null, isDM: false }],
    });

    expect(history).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      targets: [{ platformId: 'slack:C1', threadId: 'slack:C1:1650000000.000001', isDM: false }],
      complete: true,
    });
  });

  it('continues discovery through an empty page that still has a cursor', async () => {
    const history = vi
      .fn()
      .mockResolvedValueOnce({ messages: [], response_metadata: { next_cursor: 'next' } })
      .mockResolvedValueOnce({
        messages: [{ ts: '1650000000.000001', reply_count: 1, latest_reply: '1753121880.000001' }],
      });

    const result = await discoverSlackRecoveryTargets({ conversations: { history } } as never, {
      since: '2025-07-21T18:16:00Z',
      reason: 'host-startup',
      targets: [{ platformId: 'slack:C1', threadId: null, isDM: false }],
    });

    expect(history).toHaveBeenCalledTimes(2);
    expect(result.complete).toBe(true);
    expect(result.targets).toHaveLength(1);
  });

  it('discovers a previously unseen DM sub-thread that received a gap reply', async () => {
    const result = await discoverSlackRecoveryTargets(
      {
        conversations: {
          history: vi.fn().mockResolvedValue({
            messages: [{ ts: '1650000000.000001', reply_count: 1, latest_reply: '1753121880.000001' }],
          }),
        },
      } as never,
      {
        since: '2025-07-21T18:16:00Z',
        reason: 'host-startup',
        targets: [{ platformId: 'slack:D1', threadId: null, isDM: true }],
      },
    );

    expect(result).toEqual({
      targets: [{ platformId: 'slack:D1', threadId: 'slack:D1:1650000000.000001', isDM: true }],
      complete: true,
    });
  });
});

describe('parseSlackWorkspaces', () => {
  it('returns an empty list when no credentials present', () => {
    expect(parseSlackWorkspaces({})).toEqual([]);
  });

  it('registers the primary workspace as channelType "slack"', () => {
    const ws = parseSlackWorkspaces({
      SLACK_BOT_TOKEN: 'xoxb-primary',
      SLACK_SIGNING_SECRET: 'sig-primary',
    });
    expect(ws).toEqual([{ channelType: 'slack', botToken: 'xoxb-primary', signingSecret: 'sig-primary' }]);
  });

  it('registers suffixed workspaces as channelType "slack-<suffix>" (lowercased)', () => {
    const ws = parseSlackWorkspaces({
      SLACK_BOT_TOKEN_EXAMPLE_LABS: 'xoxb-ill',
      SLACK_SIGNING_SECRET_EXAMPLE_LABS: 'sig-ill',
      SLACK_BOT_TOKEN_NEWJOB: 'xoxb-new',
      SLACK_SIGNING_SECRET_NEWJOB: 'sig-new',
    });
    expect(ws.map((w) => w.channelType).sort()).toEqual(['slack-example-labs', 'slack-newjob']);
  });

  it('registers primary and suffixed workspaces together', () => {
    const ws = parseSlackWorkspaces({
      SLACK_BOT_TOKEN: 'xoxb-p',
      SLACK_SIGNING_SECRET: 'sig-p',
      SLACK_BOT_TOKEN_SECOND: 'xoxb-s',
      SLACK_SIGNING_SECRET_SECOND: 'sig-s',
    });
    expect(ws.map((w) => w.channelType).sort()).toEqual(['slack', 'slack-second']);
  });

  it('skips workspaces missing a signing secret', () => {
    const ws = parseSlackWorkspaces({
      SLACK_BOT_TOKEN: 'xoxb-p',
      SLACK_SIGNING_SECRET: 'sig-p',
      SLACK_BOT_TOKEN_ORPHAN: 'xoxb-orphan',
    });
    expect(ws).toEqual([{ channelType: 'slack', botToken: 'xoxb-p', signingSecret: 'sig-p' }]);
  });

  it('skips workspaces missing a bot token', () => {
    const ws = parseSlackWorkspaces({
      SLACK_SIGNING_SECRET_ORPHAN: 'sig-orphan',
    });
    expect(ws).toEqual([]);
  });

  it('accepts underscores in the suffix and maps them to dashes in channelType', () => {
    // Convention match in two directions:
    //   - Env-var name: `SLACK_BOT_TOKEN_EXAMPLE_LABS_CODEX` mirrors how other
    //     fork-scoped env vars look (GITHUB_TOKEN_EXAMPLE_RETAIL).
    //   - channelType: `slack-example-labs-codex` mirrors the dash-separated
    //     existing channelType convention (`slack-example-labs`,
    //     `slack-exampleretail`).
    // channel-auto-wire/index.ts:67 inverse-maps `-` → `_` when building
    // env-var lookups, so the round-trip is symmetric.
    const ws = parseSlackWorkspaces({
      SLACK_BOT_TOKEN_EXAMPLE_LABS_CODEX: 'xoxb-codex',
      SLACK_SIGNING_SECRET_EXAMPLE_LABS_CODEX: 'sig-codex',
    });
    expect(ws).toEqual([
      { channelType: 'slack-example-labs-codex', botToken: 'xoxb-codex', signingSecret: 'sig-codex' },
    ]);
  });
});

describe('extractSlackChannelId', () => {
  it('test_strip_slack_prefix_from_canonical_platform_id', () => {
    expect(extractSlackChannelId('slack:CTEST00004')).toBe('CTEST00004');
  });

  it('test_returns_raw_id_when_no_prefix', () => {
    expect(extractSlackChannelId('CTEST00004')).toBe('CTEST00004');
  });
});

describe('slackPostParent', () => {
  it('test_post_parent_returns_ts: returns {messageId} from response.ts', async () => {
    const mockClient: SlackPostMessageClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: 'parent-1234.5678', ok: true }),
      },
    };
    const result = await slackPostParent(mockClient, 'C0', 'launched task');
    expect(result).toEqual({ messageId: 'parent-1234.5678' });
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({ channel: 'C0', text: 'launched task' });
  });

  it('test_post_parent_strips_slack_prefix_before_api_call', async () => {
    // Regression: orchestrator-dispatch's threaded path passes the raw
    // messaging_groups.platform_id (`slack:CHANNEL`) — Slack's API needs the
    // bare channel ID or returns channel_not_found. Observed in production
    // when first attempting to spawn into Slack.
    const postMessage = vi.fn().mockResolvedValue({ ts: 'parent-ts', ok: true });
    const mockClient: SlackPostMessageClient = { chat: { postMessage } };
    await slackPostParent(mockClient, 'slack:CTEST00004', 'spawned task');
    expect(postMessage).toHaveBeenCalledWith({ channel: 'CTEST00004', text: 'spawned task' });
  });
});

describe('slackCreateThread', () => {
  it('test_create_thread_returns_parent_as_thread_id: threadId === parentMessageId (not reply.ts)', async () => {
    const mockClient: SlackPostMessageClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: 'reply-9999.0000', ok: true }),
      },
    };
    const result = await slackCreateThread(mockClient, 'C0', 'parent-1234.5678', 'Task X', 'first message');
    expect(result).toEqual({ threadId: 'parent-1234.5678', messageId: 'reply-9999.0000' });
  });

  it('test_create_thread_passes_thread_ts_correctly: calls postMessage with thread_ts = parentMessageId', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: 'reply-ts', ok: true });
    const mockClient: SlackPostMessageClient = { chat: { postMessage } };
    await slackCreateThread(mockClient, 'C0', 'parent-X', 'Task', 'msg');
    expect(postMessage).toHaveBeenCalledWith({
      channel: 'C0',
      thread_ts: 'parent-X',
      text: 'msg',
    });
  });

  it('test_create_thread_strips_slack_prefix_before_api_call', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: 'reply-ts', ok: true });
    const mockClient: SlackPostMessageClient = { chat: { postMessage } };
    await slackCreateThread(mockClient, 'slack:CTEST00004', 'parent-ts', 'Task', 'first');
    expect(postMessage).toHaveBeenCalledWith({
      channel: 'CTEST00004',
      thread_ts: 'parent-ts',
      text: 'first',
    });
  });
});
