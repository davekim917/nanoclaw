import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// callHaiku now resolves credentials through the same structuredCredentials()
// path callClaudeStructured uses, which merges in `.env`-file values via
// readEnvFileMatching() whenever passed process.env directly. Stub it out so
// tests never touch the real on-disk `.env` (which, on a live install, holds
// real OAuth tokens) — credential slots for these tests come exclusively
// from process.env, set explicitly per test below.
vi.mock('./env.js', () => ({
  readEnvFileMatching: vi.fn(() => ({})),
}));

import { callHaiku, CallHaikuHttpError, __resetCallHaikuSlotCacheForTest } from './llm.js';

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
    vi.useFakeTimers();
    __resetCallHaikuSlotCacheForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __resetCallHaikuSlotCacheForTest();
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

  it('honors the retry-after header and succeeds once the backend recovers', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'Rollout fix' }] }));

    const promise = callHaiku('hello');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('Rollout fix');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('stops after the attempt cap and throws the last error (previously: single immediate retry, both landed in the same 429 window)', async () => {
    // mockImplementation (not mockResolvedValue) — a fresh Response per call,
    // since callHaikuHttpError now reads the body once via .json() and a
    // shared Response instance can't be read twice.
    fetchMock.mockImplementation(async () => jsonResponse({}, { status: 429, headers: { 'retry-after': '1' } }));

    const promise = callHaiku('hello');
    // Avoid an unhandled-rejection warning while the timers below are still
    // draining and the assertion hasn't attached its own handler yet.
    promise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBeInstanceOf(CallHaikuHttpError);
    await expect(promise).rejects.toMatchObject({ status: 429 });
    // 4 total attempts: the original call + 3 retries — up from the old
    // single-immediate-retry behavior (2 total attempts). Only one
    // configured slot (api-key:primary), so there's nothing to rotate to.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry a non-transient (e.g. 400) error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'bad request' } }, { status: 400 }));

    const promise = callHaiku('hello');
    await expect(promise).rejects.toBeInstanceOf(CallHaikuHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to capped-exponential backoff with jitter when no retry-after is present', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { status: 529 }))
      .mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));

    const promise = callHaiku('hello');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('credential rotation across slots', () => {
    beforeEach(() => {
      // Two OAuth slots configured (oauth wins over the api-key fallback
      // set in the outer beforeEach) — synthetic values only, never real
      // token shapes.
      delete process.env.ANTHROPIC_API_KEY;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-slot-1-token';
      process.env.CLAUDE_CODE_OAUTH_TOKEN_2 = 'oauth-slot-2-token';
    });

    it('rotates to the next slot on a 429 with no retry-after, without sleeping', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: { type: 'rate_limit_error' } }, { status: 429 }))
        .mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'from slot 2' }] }));

      // No fake-timer advance needed: quota-exhaustion rotation must not
      // sleep. If it regressed to backing off instead, this call would hang
      // against unadvanced fake timers and fail the test on timeout.
      const result = await callHaiku('hello');

      expect(result).toBe('from slot 2');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(authHeader(fetchMock.mock.calls[0])).toBe('Bearer oauth-slot-1-token');
      expect(authHeader(fetchMock.mock.calls[1])).toBe('Bearer oauth-slot-2-token');
    });

    it('backs off on the same slot for a 429 WITH retry-after, and does not rotate', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'retry-after': '1' } }))
        .mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'from slot 1 again' }] }));

      const promise = callHaiku('hello');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('from slot 1 again');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Both attempts hit slot 1 — no rotation happened.
      expect(authHeader(fetchMock.mock.calls[0])).toBe('Bearer oauth-slot-1-token');
      expect(authHeader(fetchMock.mock.calls[1])).toBe('Bearer oauth-slot-1-token');
    });

    it('throws once every slot is exhausted', async () => {
      // mockImplementation for the same reason as above — a fresh Response
      // per call.
      fetchMock.mockImplementation(async () => jsonResponse({ error: { type: 'rate_limit_error' } }, { status: 429 }));

      const promise = callHaiku('hello');
      promise.catch(() => {});
      await vi.runAllTimersAsync();

      await expect(promise).rejects.toBeInstanceOf(CallHaikuHttpError);
      await expect(promise).rejects.toMatchObject({ status: 429 });
      // Quota-exhaustion on both slots — one attempt each, no backoff.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(authHeader(fetchMock.mock.calls[0])).toBe('Bearer oauth-slot-1-token');
      expect(authHeader(fetchMock.mock.calls[1])).toBe('Bearer oauth-slot-2-token');
    });

    it('reuses the last-known-good slot on the next call instead of re-failing through slot 1', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: { type: 'rate_limit_error' } }, { status: 429 }))
        .mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'first call, slot 2' }] }));

      const first = await callHaiku('hello');
      expect(first).toBe('first call, slot 2');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'second call, slot 2' }] }));

      const second = await callHaiku('hello again');

      expect(second).toBe('second call, slot 2');
      // Only one call this time — it started at slot 2 directly, skipping
      // the now-known-exhausted slot 1.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(authHeader(fetchMock.mock.calls[0])).toBe('Bearer oauth-slot-2-token');
    });
  });
});
