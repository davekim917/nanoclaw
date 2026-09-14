import { describe, expect, it } from 'bun:test';

import type { RateLimitSample } from '../modules/mailbox/index.js';
import type { AppServer, JsonRpcNotification } from './codex-app-server.js';
import { CodexRateLimitTracker } from './codex-rate-limit-tracker.js';
import type { CodexRateLimitsReadResponse } from './codex-rate-limits.js';

const RESET_S = 1789603200;
const RESET_ISO = '2026-09-17T00:00:00.000Z';

function fakeServer(): AppServer {
  return { notificationHandlers: [], serverRequestHandlers: [], pending: new Map() } as unknown as AppServer;
}

function notify(server: AppServer, method: string, params: Record<string, unknown>): void {
  for (const h of server.notificationHandlers) h({ method, params } as JsonRpcNotification);
}

interface Harness {
  tracker: CodexRateLimitTracker;
  recorded: RateLimitSample[][];
  logs: string[];
  reads: number;
  clock: { now: number };
}

function harness(
  respond: (() => Promise<CodexRateLimitsReadResponse>) | (() => never),
  authJson: string | null = JSON.stringify({ tokens: { account_id: 'acct-auth' } }),
  refreshMs = 5 * 60_000,
): Harness {
  const recorded: RateLimitSample[][] = [];
  const logs: string[] = [];
  const clock = { now: 1_000_000 };
  const h: Harness = { recorded, logs, reads: 0, clock, tracker: null as unknown as CodexRateLimitTracker };
  h.tracker = new CodexRateLimitTracker({
    read: async () => {
      h.reads += 1;
      return respond();
    },
    readAuthJson: () => authJson,
    record: (rows) => recorded.push(rows),
    log: (m) => logs.push(m),
    now: () => clock.now,
    readTimeoutMs: 50,
    refreshMs,
  });
  return h;
}

const HEALTHY: CodexRateLimitsReadResponse = {
  rateLimits: {
    primary: { usedPercent: 10, windowDurationMins: 300 },
    secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: RESET_S },
    planType: 'pro',
  },
  accountId: null,
};

describe('CodexRateLimitTracker.bind', () => {
  it('pulls once, records usage_pull rows attributed to the auth.json account and the CODEX_HOME slot', async () => {
    const h = harness(async () => HEALTHY);
    const server = fakeServer();
    await h.tracker.bind(server, '/home/node/.codex');
    expect(h.reads).toBe(1);
    expect(h.tracker.identity).toEqual({ account: 'acct-auth', credentialSet: 'codex:.codex', lane: null });
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toEqual([
      expect.objectContaining({ source: 'usage_pull', account: 'acct-auth', limitType: 'five_hour', utilization: 0.1 }),
      expect.objectContaining({
        source: 'usage_pull',
        account: 'acct-auth',
        credentialSet: 'codex:.codex',
        subscriptionType: 'pro',
        limitType: 'seven_day',
        utilization: 0.2,
        resetsAt: RESET_ISO,
      }),
    ]);
    expect(h.tracker.parkDecision()).toBeNull();
    expect(h.tracker.turnRateLimit()).toEqual({ type: 'seven_day', utilization: 0.2, resetsAt: RESET_ISO });
    expect(server.notificationHandlers).toHaveLength(1);
  });

  it('prefers the accountId the backend supplies over the auth.json identity', async () => {
    const h = harness(async () => ({ ...HEALTHY, accountId: 'acct-backend' }));
    await h.tracker.bind(fakeServer(), '/home/node/.codex-fallback-1');
    expect(h.tracker.identity).toEqual({
      account: 'acct-backend',
      credentialSet: 'codex:.codex-fallback-1',
      lane: null,
    });
    expect(h.recorded[0][0]?.account).toBe('acct-backend');
  });

  it('writes unattributed rows for an API-key login with no account id anywhere', async () => {
    const h = harness(async () => HEALTHY, JSON.stringify({ auth_mode: 'apikey' }));
    await h.tracker.bind(fakeServer(), '/home/node/.codex');
    expect(h.recorded[0][0]?.account).toBeNull();
  });

  it('a failed read is NOT SAMPLED: no rows, no park, one log line, and the turn is not blocked', async () => {
    const h = harness(() => {
      throw new Error('account/rateLimits/read failed: method not found');
    });
    await h.tracker.bind(fakeServer(), '/home/node/.codex');
    expect(h.recorded).toEqual([]);
    expect(h.tracker.current).toBeNull();
    expect(h.tracker.parkDecision()).toBeNull();
    expect(h.tracker.turnRateLimit()).toBeNull();
    expect(h.logs.some((l) => l.includes('rate-limit read failed') && l.includes('method not found'))).toBe(true);
  });

  it('logs the multi-bucket view at debug and the positional assumption when durations are missing', async () => {
    const h = harness(async () => ({
      rateLimits: { primary: { usedPercent: 5 }, secondary: { usedPercent: 6 } },
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 5 } } },
    }));
    await h.tracker.bind(fakeServer(), '/home/node/.codex');
    expect(h.logs.some((l) => l.startsWith('rateLimitsByLimitId (debug):') && l.includes('"codex"'))).toBe(true);
    expect(h.logs.filter((l) => l.includes('windowDurationMins missing on read; assumed'))).toHaveLength(2);
    expect(h.recorded[0].map((r) => r.limitType)).toEqual(['five_hour', 'seven_day']);
  });

  it('rebinding to a new server drops the old subscription and the old account snapshot', async () => {
    let usedPercent = 95;
    const h = harness(async () => ({
      rateLimits: { secondary: { usedPercent, windowDurationMins: 10080, resetsAt: RESET_S } },
    }));
    const first = fakeServer();
    await h.tracker.bind(first, '/home/node/.codex');
    expect(h.tracker.parkDecision()?.reason).toBe('seven_day_threshold');

    usedPercent = 15;
    const second = fakeServer();
    await h.tracker.bind(second, '/home/node/.codex-fallback-1');
    expect(first.notificationHandlers).toHaveLength(0);
    expect(second.notificationHandlers).toHaveLength(1);
    expect(h.tracker.parkDecision()).toBeNull();
    expect(h.tracker.identity.credentialSet).toBe('codex:.codex-fallback-1');
    // A push on the OLD server no longer reaches the tracker.
    notify(first, 'account/rateLimits/updated', { rateLimits: { secondary: { usedPercent: 100 } } });
    expect(h.tracker.parkDecision()).toBeNull();
  });
});

describe('CodexRateLimitTracker pushes', () => {
  it('merges a sparse account/rateLimits/updated into the snapshot and records a rate_limit_event row per window carried', async () => {
    const h = harness(async () => HEALTHY);
    const server = fakeServer();
    await h.tracker.bind(server, '/home/node/.codex');
    notify(server, 'account/rateLimits/updated', {
      rateLimits: { secondary: { usedPercent: 96, windowDurationMins: 10080, resetsAt: RESET_S } },
    });
    // Five-hour window kept from the read; weekly replaced by the push.
    expect(h.tracker.current?.primary).toEqual({ usedPercent: 10, windowDurationMins: 300 });
    expect(h.tracker.current?.secondary?.usedPercent).toBe(96);
    expect(h.recorded).toHaveLength(2);
    expect(h.recorded[1]).toEqual([
      expect.objectContaining({
        source: 'rate_limit_event',
        limitType: 'seven_day',
        utilization: 0.96,
        resetsAt: RESET_ISO,
        // Plan comes from the merged snapshot when the sparse push omits it.
        subscriptionType: 'pro',
        account: 'acct-auth',
      }),
    ]);
    expect(h.tracker.parkDecision()).toMatchObject({ reason: 'seven_day_threshold', usedPercent: 96 });
    expect(h.logs.some((l) => l.startsWith('park condition after push:'))).toBe(true);
  });

  it('a reached-limit push parks and names the enum, even with no window attached', async () => {
    const h = harness(async () => HEALTHY);
    const server = fakeServer();
    await h.tracker.bind(server, '/home/node/.codex');
    notify(server, 'account/rateLimits/updated', {
      rateLimits: { rateLimitReachedType: 'workspace_owner_credits_depleted' },
    });
    expect(h.tracker.parkDecision()).toMatchObject({
      reason: 'rate_limit_reached',
      reachedType: 'workspace_owner_credits_depleted',
    });
    expect(h.recorded[1][0]).toMatchObject({ source: 'rate_limit_event', status: 'workspace_owner_credits_depleted' });
  });

  it('ignores unrelated notifications and malformed updates', async () => {
    const h = harness(async () => HEALTHY);
    const server = fakeServer();
    await h.tracker.bind(server, '/home/node/.codex');
    notify(server, 'item/agentMessage/delta', { delta: 'hi' });
    notify(server, 'account/rateLimits/updated', { nope: true });
    expect(h.recorded).toHaveLength(1);
    expect(h.tracker.current).toEqual(HEALTHY.rateLimits);
  });
});

describe('CodexRateLimitTracker.refreshIfStale', () => {
  it('re-reads only once the snapshot is older than the refresh interval', async () => {
    const h = harness(async () => HEALTHY, undefined, 1000);
    const server = fakeServer();
    await h.tracker.bind(server, '/home/node/.codex');
    expect(h.reads).toBe(1);
    h.clock.now += 999;
    await h.tracker.refreshIfStale();
    expect(h.reads).toBe(1);
    h.clock.now += 1;
    await h.tracker.refreshIfStale();
    expect(h.reads).toBe(2);
    expect(h.recorded).toHaveLength(2);
  });

  it('a push counts as fresh — a server that streams updates never re-reads', async () => {
    const h = harness(async () => HEALTHY, undefined, 1000);
    const server = fakeServer();
    await h.tracker.bind(server, '/home/node/.codex');
    h.clock.now += 900;
    notify(server, 'account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 11 } } });
    h.clock.now += 900;
    await h.tracker.refreshIfStale();
    expect(h.reads).toBe(1);
  });

  it('does nothing before a bind', async () => {
    const h = harness(async () => HEALTHY);
    await h.tracker.refreshIfStale();
    expect(h.reads).toBe(0);
  });
});
