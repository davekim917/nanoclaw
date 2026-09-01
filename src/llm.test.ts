import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callHaiku, CallHaikuHttpError } from './llm.js';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('callHaiku', () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalHttpsProxy = process.env.HTTPS_PROXY;
  const originalHttpProxy = process.env.HTTP_PROXY;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    // No proxy dispatcher — makes callHaikuOnce use bare global `fetch`
    // directly, which is what we stub below.
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
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
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 429, headers: { 'retry-after': '1' } }));

    const promise = callHaiku('hello');
    // Avoid an unhandled-rejection warning while the timers below are still
    // draining and the assertion hasn't attached its own handler yet.
    promise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toBeInstanceOf(CallHaikuHttpError);
    await expect(promise).rejects.toMatchObject({ status: 429 });
    // 4 total attempts: the original call + 3 retries — up from the old
    // single-immediate-retry behavior (2 total attempts).
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
});
