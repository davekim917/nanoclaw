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

import { log } from './log.js';
import {
  callHaiku,
  callWithCredentialRotation,
  CallHaikuHttpError,
  AllCredentialSlotsParkedError,
  CredentialRotationGateTimeoutError,
  __resetCallHaikuSlotCacheForTest,
  __resetCredentialParkingForTest,
  __resetCredentialRotationGateForTest,
  __setCredentialRotationGateMinIntervalForTest,
  __getParkedUntilMsForTest,
} from './llm.js';

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
    __resetCredentialParkingForTest();
    __resetCredentialRotationGateForTest();
    // Existing tests below assert call counts/ordering with NO fake-timer
    // advance between multiple calls in the same test — they predate the
    // gate's real 1s minimum spacing (see the dedicated "credential rotation
    // gate" describe block, which restores the real interval). Disabling
    // spacing here keeps every test that doesn't care about gate timing from
    // having to advance fake timers just to let a second call through.
    __setCredentialRotationGateMinIntervalForTest(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __resetCallHaikuSlotCacheForTest();
    __resetCredentialParkingForTest();
    __resetCredentialRotationGateForTest();
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

  it('issues exactly one request when the only configured slot hits a (short) retry-after 429 — no in-process retry by default', async () => {
    // Previously this retried the SAME slot with backoff, honoring
    // retry-after, until it eventually succeeded — up to 4 attempts. A
    // single failed call could burn 4 requests per slot (16 across 4 slots),
    // amplifying enough to rate-limit otherwise-healthy credentials (see
    // src/llm.ts's CREDENTIAL_ROTATION_MAX_ATTEMPTS_PER_SLOT doc comment).
    // The default per-slot attempt budget is now 1: with only one configured
    // slot there's nothing to rotate to, so the call fails after ONE request
    // — the 60s host sweep is the real retry mechanism, not in-process
    // backoff.
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'retry-after': '2' } }));

    const promise = callHaiku('hello');
    promise.catch(() => {});

    await expect(promise).rejects.toBeInstanceOf(CallHaikuHttpError);
    await expect(promise).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops after ONE attempt on the only configured slot and throws (down from 4 — rotation, not in-process backoff, is the retry mechanism)', async () => {
    // mockImplementation (not mockResolvedValue) — a fresh Response per call,
    // since callHaikuHttpError now reads the body once via .json() and a
    // shared Response instance can't be read twice.
    fetchMock.mockImplementation(async () => jsonResponse({}, { status: 429, headers: { 'retry-after': '1' } }));

    const promise = callHaiku('hello');
    promise.catch(() => {});

    await expect(promise).rejects.toBeInstanceOf(CallHaikuHttpError);
    await expect(promise).rejects.toMatchObject({ status: 429 });
    // Exactly 1 attempt: only one configured slot (api-key:primary), and the
    // default per-slot attempt budget is 1.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-transient (e.g. 400) error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'bad request' } }, { status: 400 }));

    const promise = callHaiku('hello');
    await expect(promise).rejects.toBeInstanceOf(CallHaikuHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 529 (server overload) also exhausts its one-attempt budget immediately, without sleeping', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 529 }));

    const promise = callHaiku('hello');
    promise.catch(() => {});

    await expect(promise).rejects.toBeInstanceOf(CallHaikuHttpError);
    await expect(promise).rejects.toMatchObject({ status: 529 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

    it('rotates to the next slot on a 429 WITH a short retry-after too — the default one-attempt-per-slot budget applies regardless of classification', async () => {
      // Previously a retry-after (any length) meant "transient — back off and
      // retry the SAME slot", up to 4 attempts. With the default per-slot
      // budget now 1, a SHORT retry-after (below the park threshold) still
      // rotates immediately rather than sleeping in-process.
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'retry-after': '1' } }))
        .mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'from slot 2' }] }));

      const result = await callHaiku('hello');

      expect(result).toBe('from slot 2');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(authHeader(fetchMock.mock.calls[0])).toBe('Bearer oauth-slot-1-token');
      expect(authHeader(fetchMock.mock.calls[1])).toBe('Bearer oauth-slot-2-token');
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

  describe('credential parking (long retry-after)', () => {
    beforeEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-slot-1-token';
      process.env.CLAUDE_CODE_OAUTH_TOKEN_2 = 'oauth-slot-2-token';
    });

    it('parks a slot whose retry-after exceeds the short-retry threshold and rotates immediately, without sleeping', async () => {
      // retry-after=3600s (1 hour) is the "this credential is genuinely
      // exhausted" shape (live evidence showed 149184s / 41 hours) — not a
      // momentarily-busy backend. It must park, not back off.
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'retry-after': '3600' } }))
        .mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'from slot 2' }] }));

      const result = await callHaiku('hello');

      expect(result).toBe('from slot 2');
      // Exactly slots.length (2) requests — one per slot, no retry.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(authHeader(fetchMock.mock.calls[0])).toBe('Bearer oauth-slot-1-token');
      expect(authHeader(fetchMock.mock.calls[1])).toBe('Bearer oauth-slot-2-token');
    });

    it('skips a parked slot on the NEXT call entirely, rather than retrying it', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'retry-after': '3600' } }))
        .mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'first call, slot 2' }] }));

      const first = await callHaiku('hello');
      expect(first).toBe('first call, slot 2');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Reset the STICKY-slot cache but NOT the parking state, so the next
      // call's ordering falls back to [slot1, slot2] — this isolates
      // "slot 1 is skipped because it's parked" from "slot 1 is skipped
      // because slot 2 is the sticky last-known-good slot" (a different
      // mechanism that would also explain skipping slot 1).
      __resetCallHaikuSlotCacheForTest();
      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'second call, slot 2' }] }));

      const second = await callHaiku('hello again');

      expect(second).toBe('second call, slot 2');
      // Only ONE fetch call: slot 1 is still parked (1-hour retry-after from
      // the first call), so it is skipped entirely — never attempted.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(authHeader(fetchMock.mock.calls[0])).toBe('Bearer oauth-slot-2-token');
    });

    it('fails fast with AllCredentialSlotsParkedError when every slot is parked, without sleeping', async () => {
      // mockImplementation (not mockResolvedValue) — a fresh Response per
      // call, since the error body is read via .json() and a shared Response
      // instance can't be read twice.
      fetchMock.mockImplementation(async () => jsonResponse({}, { status: 429, headers: { 'retry-after': '3600' } }));

      const first = await callHaiku('hello').catch((err: unknown) => err);
      expect(first).toBeInstanceOf(CallHaikuHttpError);
      // Both slots tried (and parked) on this first call.
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockClear();
      const second = callHaiku('hello again');

      await expect(second).rejects.toBeInstanceOf(AllCredentialSlotsParkedError);
      // No request at all on the second call — both slots were already
      // known-parked, so it fails fast instead of sleeping or re-trying a
      // credential that just told us it's dead for the next hour.
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('credential rotation gate (process-wide serialization — fixes the burst-parking loop)', () => {
    // These tests exercise the gate directly via callWithCredentialRotation
    // rather than through callHaiku/fetch, to isolate gate mechanics
    // (queueing, spacing, timeout, park-clearing) from HTTP-mocking noise.
    // The outer beforeEach leaves ANTHROPIC_API_KEY set (single
    // api-key:primary slot) and disables gate spacing
    // (__setCredentialRotationGateMinIntervalForTest(0)); restore the REAL
    // interval here so these tests can prove real spacing behavior against
    // fake timers.
    beforeEach(() => {
      __setCredentialRotationGateMinIntervalForTest(1000);
    });

    function call<T>(attempt: () => Promise<T>) {
      return callWithCredentialRotation({
        attempt,
        logLabel: 'test-gate',
        noCredentialsMessage: 'no credentials configured',
      });
    }

    it('serializes concurrent calls and spaces them by the minimum interval — never more than one in flight', async () => {
      let active = 0;
      let peakActive = 0;
      const startTimes: number[] = [];

      async function attempt(n: number): Promise<number> {
        active++;
        peakActive = Math.max(peakActive, active);
        startTimes.push(Date.now());
        await Promise.resolve();
        active--;
        return n;
      }

      const p1 = call(() => attempt(1));
      const p2 = call(() => attempt(2));
      const p3 = call(() => attempt(3));

      await vi.advanceTimersByTimeAsync(3000);

      const results = await Promise.all([p1, p2, p3]);
      expect(results.map((r) => r.value)).toEqual([1, 2, 3]);
      expect(peakActive).toBe(1); // at most one in-flight request at a time
      expect(startTimes[1]! - startTimes[0]!).toBeGreaterThanOrEqual(1000);
      expect(startTimes[2]! - startTimes[1]!).toBeGreaterThanOrEqual(1000);
    });

    it('a throwing call releases the gate so the next queued call still proceeds (no deadlock)', async () => {
      const boom = Object.assign(new Error('boom'), { status: 400 }); // fatal — classify() rejects immediately
      const attempt1 = vi.fn(async () => {
        throw boom;
      });
      const attempt2 = vi.fn(async () => 'ok');

      const p1 = call(attempt1);
      p1.catch(() => {});
      const p2 = call(attempt2);

      await expect(p1).rejects.toBe(boom);
      await vi.advanceTimersByTimeAsync(1500);
      const result2 = await p2;

      expect(result2.value).toBe('ok');
      expect(attempt2).toHaveBeenCalledTimes(1);
    });

    it('fails fast with CredentialRotationGateTimeoutError when queued past the max wait, without deadlocking the queue for later callers', async () => {
      // A holder that never resolves on its own — released manually once
      // we've confirmed the queued-too-long caller gave up.
      let releaseHolder!: () => void;
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      const holder = call(async () => {
        await holderGate;
        return 'holder done';
      });

      const queuedTooLong = call(async () => 'should never run');
      queuedTooLong.catch(() => {});

      // Push past the 30s max-wait cap while the holder is still running —
      // queuedTooLong must give up rather than wait indefinitely for a
      // predecessor that's still in flight.
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(queuedTooLong).rejects.toBeInstanceOf(CredentialRotationGateTimeoutError);

      // Let the true holder finish and unwind the chain.
      releaseHolder();
      await vi.advanceTimersByTimeAsync(100);
      expect((await holder).value).toBe('holder done');

      // A FRESH call issued now (well after the timeout episode) must not be
      // stuck behind a corrupted queue — proving the timed-out caller's
      // bail-out didn't leave the mutex permanently held.
      const afterThat = call(async () => 'after');
      await vi.advanceTimersByTimeAsync(1500);
      expect((await afterThat).value).toBe('after');
    });

    it('caps a park at the 15-minute ceiling even when retry-after claims hours', async () => {
      const startMs = Date.now();
      const err = Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 41 * 3600_000 }); // 41h, live-observed shape
      const promise = call(async () => {
        throw err;
      });

      await expect(promise).rejects.toBe(err);

      const untilMs = __getParkedUntilMsForTest('api-key:primary');
      expect(untilMs).toBeDefined();
      expect(untilMs! - startMs).toBe(15 * 60_000); // capped, not the claimed 41 hours
    });

    it('clears a slot park and logs recovery once a call through it succeeds again', async () => {
      const infoSpy = vi.spyOn(log, 'info');
      const err = Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 90_000 }); // parks ~90s, under the 15-min ceiling
      const failingAttempt = vi.fn(async () => {
        throw err;
      });

      await expect(call(failingAttempt)).rejects.toBe(err);
      expect(__getParkedUntilMsForTest('api-key:primary')).toBeDefined();

      await vi.advanceTimersByTimeAsync(91_000); // past the park window
      const succeedingAttempt = vi.fn(async () => 'back online');
      const result = await call(succeedingAttempt);

      expect(result.value).toBe('back online');
      expect(__getParkedUntilMsForTest('api-key:primary')).toBeUndefined();
      expect(infoSpy.mock.calls.some(([msg]) => String(msg).includes('recovered'))).toBe(true);
    });
  });
});
