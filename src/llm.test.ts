import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// callHaiku resolves credentials through structuredCredentials(), which
// merges in `.env`-file values via
// readEnvFileMatching() whenever passed process.env directly. Stub it out so
// tests never touch the real on-disk `.env` (which, on a live install, holds
// real OAuth tokens) — credential slots for these tests come exclusively
// from process.env, set explicitly per test below.
vi.mock('./env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env.js')>()),
  readEnvFileMatching: vi.fn(() => ({})),
}));

import { callHaiku, CallHaikuHttpError } from './llm.js';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function authHeader(call: unknown[]): string | undefined {
  const init = call[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.authorization;
}

describe('callHaiku', () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalOauthPrimary = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const originalOauth2 = process.env.CLAUDE_CODE_OAUTH_TOKEN_2;
  const originalHttpsProxy = process.env.HTTPS_PROXY;
  const originalHttpProxy = process.env.HTTP_PROXY;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    // No OAuth slots by default — single api-key:primary slot, matching the
    // pre-rotation test expectations below.
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN_2;
    // No proxy dispatcher — makes callHaikuOnce use bare global `fetch`
    // directly, which is what we stub below.
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    if (originalOauthPrimary === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauthPrimary;
    if (originalOauth2 === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN_2;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN_2 = originalOauth2;
    if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = originalHttpsProxy;
    if (originalHttpProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = originalHttpProxy;
  });

  it('makes one request and throws when the only configured key fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'retry-after': '2' } }));

    const promise = callHaiku('hello');
    promise.catch(() => {});

    await expect(promise).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('carries the provider error type and message into the thrown error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { type: 'rate_limit_error', message: 'This request would exceed your rate limit' } },
        { status: 429, headers: { 'retry-after': '3600' } },
      ),
    );

    const err = await callHaiku('hello').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CallHaikuHttpError);
    expect((err as Error).message).toBe(
      'callHaiku: Anthropic returned 429 rate_limit_error: This request would exceed your rate limit',
    );
  });

  describe('trying each key in turn', () => {
    beforeEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-slot-1-token';
      process.env.CLAUDE_CODE_OAUTH_TOKEN_2 = 'oauth-slot-2-token';
    });

    it.each([
      ['a weekly-quota 429', () => jsonResponse({}, { status: 429, headers: { 'retry-after': '400000' } })],
      ['a short-retry 429', () => jsonResponse({}, { status: 429, headers: { 'retry-after': '1' } })],
      ['a 401', () => jsonResponse({}, { status: 401 })],
      ['a 529', () => jsonResponse({}, { status: 529 })],
    ])('moves to the next key on %s', async (_label, failure) => {
      fetchMock
        .mockResolvedValueOnce(failure())
        .mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'from slot 2' }] }));

      expect(await callHaiku('hello')).toBe('from slot 2');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(authHeader(fetchMock.mock.calls[0])).toBe('Bearer oauth-slot-1-token');
      expect(authHeader(fetchMock.mock.calls[1])).toBe('Bearer oauth-slot-2-token');
    });

    it('rethrows a 429 over a later key’s different failure', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, { status: 429 }))
        .mockResolvedValueOnce(jsonResponse({}, { status: 401 }));

      await expect(callHaiku('hello')).rejects.toMatchObject({ status: 429 });
    });

    it('throws the last error after one request per key', async () => {
      fetchMock.mockImplementation(() => jsonResponse({}, { status: 429, headers: { 'retry-after': '3600' } }));

      await expect(callHaiku('hello')).rejects.toMatchObject({ status: 429 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('starts from the first key on every call', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, { status: 429 }))
        .mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'first' }] }))
        .mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'second' }] }));

      expect(await callHaiku('hello')).toBe('first');
      expect(await callHaiku('hello again')).toBe('second');
      expect(authHeader(fetchMock.mock.calls[2])).toBe('Bearer oauth-slot-1-token');
    });

    it('sends the optional system prompt and model', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));

      await callHaiku('user text', { system: 'be brief', model: 'claude-test-model' });

      const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as Record<string, unknown>;
      expect(body).toMatchObject({ system: 'be brief', model: 'claude-test-model' });
    });
  });
});
