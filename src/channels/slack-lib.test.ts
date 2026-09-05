/**
 * slack-lib — request/error shaping of the shared fetch-based Web API client
 * and the per-instance bot-token env-key convention.
 *
 * Pinned invariants: Slack's error strings surface in thrown messages; token
 * values never do (Authorization header is the only place a token travels).
 * All fetches are mocked — no live Slack calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeName } from '../modules/agent-to-agent/db/agent-destinations.js';
import { parseSlackWorkspaces } from './slack.js';
import {
  appTokenKeyForChannelType,
  botTokenKeyForChannelType,
  slackChannelTypeForSlug,
  slugForSlackChannelType,
  SlackApiError,
  slackAuthTest,
  slackCall,
  slackConversationsInfo,
  slackConversationsMembers,
  slackConversationsOpen,
  slackPostMessage,
} from './slack-lib.js';

const TOKEN = 'xoxb-secret-test-token-value';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl as (...args: unknown[]) => Promise<Response>);
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function captureError(promise: Promise<unknown>): Promise<SlackApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SlackApiError);
    return err as SlackApiError;
  }
  throw new Error('expected the call to throw');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('slackCall request shaping', () => {
  it('POSTs the method to slack.com/api with a JSON body, bearer token, and a timeout signal', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ ok: true, stuff: 1 }));

    const json = await slackCall(TOKEN, 'chat.postMessage', { channel: 'C1', text: 'hi' }, 'my-step');

    expect(json).toMatchObject({ ok: true, stuff: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toContain('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ channel: 'C1', text: 'hi' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('slackCall error shaping', () => {
  it("surfaces Slack's error string with the method and step — never the token", async () => {
    mockFetch(async () => jsonResponse({ ok: false, error: 'channel_not_found' }));

    const err = await captureError(slackCall(TOKEN, 'conversations.info', { channel: 'C9' }, 'room-lookup'));

    expect(err.name).toBe('SlackApiError');
    expect(err.step).toBe('room-lookup');
    expect(err.message).toBe('slack conversations.info failed: channel_not_found');
    expect(err.message).not.toContain(TOKEN);
  });

  it('falls back to the HTTP status when ok:false carries no error string', async () => {
    mockFetch(async () => jsonResponse({ ok: false }, 429));

    const err = await captureError(slackCall(TOKEN, 'auth.test', {}, 's'));

    expect(err.message).toBe('slack auth.test failed: HTTP 429');
  });

  it('wraps fetch-level failures (network error / timeout abort) without leaking the token', async () => {
    mockFetch(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    const err = await captureError(slackCall(TOKEN, 'auth.test', {}, 'origin-auth'));

    expect(err.step).toBe('origin-auth');
    expect(err.message).toBe('slack auth.test failed: The operation was aborted due to timeout');
    expect(err.message).not.toContain(TOKEN);
  });

  it('reports non-JSON bodies as HTTP <status>, non-JSON body', async () => {
    mockFetch(async () => new Response('<html>bad gateway</html>', { status: 502 }));

    const err = await captureError(slackCall(TOKEN, 'chat.postMessage', { channel: 'C1' }, 's'));

    expect(err.message).toBe('slack chat.postMessage failed: HTTP 502, non-JSON body');
  });
});

describe('slackAuthTest', () => {
  it('maps user_id/team_id/team/url from the response', async () => {
    mockFetch(async () =>
      jsonResponse({ ok: true, user_id: 'U123', team_id: 'T456', team: 'acme', url: 'https://acme.slack.com/' }),
    );

    await expect(slackAuthTest(TOKEN, 's')).resolves.toEqual({
      userId: 'U123',
      teamId: 'T456',
      team: 'acme',
      url: 'https://acme.slack.com/',
    });
  });

  it('throws when the response has no user_id', async () => {
    mockFetch(async () => jsonResponse({ ok: true }));

    const err = await captureError(slackAuthTest(TOKEN, 'origin-auth'));

    expect(err.step).toBe('origin-auth');
    expect(err.message).toBe('slack auth.test failed: no user_id in response');
  });
});

describe('slackConversationsOpen', () => {
  it('joins user ids with commas and returns the channel id', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ ok: true, channel: { id: 'D777' } }));

    await expect(slackConversationsOpen(TOKEN, ['U1', 'U2', 'U3'], 's')).resolves.toBe('D777');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ users: 'U1,U2,U3' });
  });

  it('throws when the response has no channel id', async () => {
    mockFetch(async () => jsonResponse({ ok: true, channel: {} }));

    const err = await captureError(slackConversationsOpen(TOKEN, ['U1'], 'dm-open'));

    expect(err.step).toBe('dm-open');
    expect(err.message).toBe('slack conversations.open failed: no channel id in response');
  });
});

describe('slackPostMessage', () => {
  it('posts channel and text', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ ok: true }));

    await slackPostMessage(TOKEN, 'C1', 'hello there');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(JSON.parse(init.body as string)).toEqual({ channel: 'C1', text: 'hello there' });
  });

  it('tags failures with the generic default step unless the caller passes one', async () => {
    mockFetch(async () => jsonResponse({ ok: false, error: 'not_in_channel' }));

    const defaulted = await captureError(slackPostMessage(TOKEN, 'C1', 'x'));
    expect(defaulted.step).toBe('post-message');

    mockFetch(async () => jsonResponse({ ok: false, error: 'not_in_channel' }));
    const explicit = await captureError(slackPostMessage(TOKEN, 'C1', 'x', 'welcome-post'));
    expect(explicit.step).toBe('welcome-post');
  });
});

describe('slackConversationsInfo', () => {
  it('classifies MPIMs and passes name/creator through', async () => {
    mockFetch(async () =>
      jsonResponse({ ok: true, channel: { is_mpim: true, name: 'mpdm-a--b--c-1', creator: 'U1' } }),
    );

    await expect(slackConversationsInfo(TOKEN, 'G123', 's')).resolves.toEqual({
      isMpim: true,
      name: 'mpdm-a--b--c-1',
      creator: 'U1',
    });
  });

  it('defaults isMpim to false and omits absent fields', async () => {
    mockFetch(async () => jsonResponse({ ok: true, channel: {} }));

    await expect(slackConversationsInfo(TOKEN, 'C123', 's')).resolves.toEqual({
      isMpim: false,
      name: undefined,
      creator: undefined,
    });
  });
});

describe('slackConversationsMembers', () => {
  it('follows next_cursor pagination and concatenates string member ids', async () => {
    const pages = [
      jsonResponse({ ok: true, members: ['U1', 'U2', 42], response_metadata: { next_cursor: 'cur2' } }),
      jsonResponse({ ok: true, members: ['U3'], response_metadata: { next_cursor: '' } }),
    ];
    const fetchMock = mockFetch(async () => {
      const page = pages.shift();
      if (!page) throw new Error('unexpected extra page fetch');
      return page;
    });

    await expect(slackConversationsMembers(TOKEN, 'G1', 's')).resolves.toEqual(['U1', 'U2', 'U3']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const secondBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(firstBody).toEqual({ channel: 'G1', limit: 200 });
    expect(secondBody).toEqual({ channel: 'G1', limit: 200, cursor: 'cur2' });
  });

  it('stops at the page cap even if Slack keeps returning cursors', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse({ ok: true, members: ['U1'], response_metadata: { next_cursor: 'again' } }),
    );

    const members = await slackConversationsMembers(TOKEN, 'G1', 's');

    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(members).toHaveLength(10);
  });
});

describe('botTokenKeyForChannelType', () => {
  it('maps the default channel type to SLACK_BOT_TOKEN', () => {
    expect(botTokenKeyForChannelType('slack')).toBe('SLACK_BOT_TOKEN');
  });

  it('strips a leading slack- prefix and uppercases the remainder', () => {
    expect(botTokenKeyForChannelType('slack-zulu')).toBe('SLACK_BOT_TOKEN_ZULU');
  });

  it('normalizes dashes to underscores', () => {
    expect(botTokenKeyForChannelType('slack-growth-bot')).toBe('SLACK_BOT_TOKEN_GROWTH_BOT');
  });

  it('normalizes case', () => {
    expect(botTokenKeyForChannelType('slack-Zulu')).toBe('SLACK_BOT_TOKEN_ZULU');
  });

  it('strips only the leading slack- prefix, not interior occurrences', () => {
    expect(botTokenKeyForChannelType('slack-slack-two')).toBe('SLACK_BOT_TOKEN_SLACK_TWO');
  });
});

describe('appTokenKeyForChannelType', () => {
  it('maps the default channel type to SLACK_APP_TOKEN', () => {
    expect(appTokenKeyForChannelType('slack')).toBe('SLACK_APP_TOKEN');
  });

  it('mirrors the bot-token suffix so a provisioned pair lands under one suffix', () => {
    expect(appTokenKeyForChannelType('slack-growth-bot')).toBe('SLACK_APP_TOKEN_GROWTH_BOT');
  });
});

describe('slackChannelTypeForSlug / slugForSlackChannelType', () => {
  it('round-trips a slug through the channel type', () => {
    for (const slug of ['zulu', 'growth-bot', 'research-2', 'slack']) {
      expect(slugForSlackChannelType(slackChannelTypeForSlug(slug))).toBe(slug);
    }
  });

  it('reserves only the empty slug for the unsuffixed adapter', () => {
    expect(slackChannelTypeForSlug('')).toBe('slack');
    expect(slugForSlackChannelType('slack')).toBe('');
  });

  it('an agent named "Slack" gets its own adapter, not the default one', () => {
    // normalizeName('Slack') is the legal slug 'slack'. Mapping it onto the
    // default channel type would point the token helpers at the unsuffixed
    // SLACK_BOT_TOKEN, and provisioning would overwrite the install's existing
    // default Slack app instead of creating a new bot.
    const channelType = slackChannelTypeForSlug(normalizeName('Slack'));
    expect(channelType).toBe('slack-slack');
    expect(botTokenKeyForChannelType(channelType)).toBe('SLACK_BOT_TOKEN_SLACK');
    expect(appTokenKeyForChannelType(channelType)).toBe('SLACK_APP_TOKEN_SLACK');
    expect(botTokenKeyForChannelType(channelType)).not.toBe(botTokenKeyForChannelType('slack'));
    expect(parseSlackWorkspaces({ SLACK_BOT_TOKEN_SLACK: 'xoxb', SLACK_APP_TOKEN_SLACK: 'xapp' })[0].channelType).toBe(
      'slack-slack',
    );
  });
});

/**
 * Acceptance case 1 of the T6 scope: "a slug round-trips through env suffix
 * and channel type", pinned against `parseSlackWorkspaces` — the function that
 * actually decides which channel type a token pair registers as. Restating its
 * regex here would let the two derivations drift silently, which is the exact
 * failure mode the SLACK_ENV_PATTERN comment in slack.ts records.
 */
describe('slug ↔ env suffix ↔ channel type, pinned against parseSlackWorkspaces', () => {
  const slugs = ['zulu', 'growth-bot', 'research-2', 'slack', normalizeName('Research 2'), normalizeName('Demo Bot')];

  it.each(slugs)('a %s token pair parses back to slackChannelTypeForSlug of the same slug', (slug) => {
    const channelType = slackChannelTypeForSlug(slug);
    const workspaces = parseSlackWorkspaces({
      [botTokenKeyForChannelType(channelType)]: 'xoxb-test',
      [appTokenKeyForChannelType(channelType)]: 'xapp-test',
    });

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].channelType).toBe(channelType);
    expect(workspaces[0].appToken).toBe('xapp-test');
  });

  it('the default channel type parses back as the unsuffixed adapter', () => {
    const workspaces = parseSlackWorkspaces({
      [botTokenKeyForChannelType('slack')]: 'xoxb-test',
      [appTokenKeyForChannelType('slack')]: 'xapp-test',
    });

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].channelType).toBe('slack');
  });

  it('every normalizeName output is a legal env suffix, so no slug can escape the round trip', () => {
    for (const raw of ['Demo Bot', 'research_2', '  Growth  Bot  ', 'Ops/Bot']) {
      const slug = normalizeName(raw);
      const channelType = slackChannelTypeForSlug(slug);
      expect(botTokenKeyForChannelType(channelType)).toMatch(/^SLACK_BOT_TOKEN_[A-Z0-9_]+$/);
      expect(
        parseSlackWorkspaces({
          [botTokenKeyForChannelType(channelType)]: 'xoxb-test',
          [appTokenKeyForChannelType(channelType)]: 'xapp-test',
        })[0].channelType,
      ).toBe(channelType);
    }
  });
});
