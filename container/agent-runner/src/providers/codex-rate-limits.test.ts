import { describe, expect, it } from 'bun:test';

import {
  CODEX_PARK_USED_PERCENT,
  classifyCodexRateLimitWindows,
  codexResetsAtIso,
  codexSnapshotToSamples,
  codexTurnRateLimit,
  decideCodexRateLimitPark,
  mergeCodexRateLimitSnapshot,
  parseCodexRateLimitsReadResponse,
  parseCodexRateLimitsUpdated,
  readCodexAccountIdFromAuthJson,
} from './codex-rate-limits.js';

const WHO = { account: 'acct-1', credentialSet: 'codex:.codex', lane: null };
// 2026-09-17T00:00:00Z as epoch seconds — the shape the schema declares (int64).
const RESET_S = 1789603200;
const RESET_ISO = '2026-09-17T00:00:00.000Z';

describe('classifyCodexRateLimitWindows', () => {
  it('names windows by duration: 300 → five_hour, 10080 → seven_day', () => {
    const out = classifyCodexRateLimitWindows({
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: RESET_S },
      secondary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: RESET_S },
    });
    expect(out).toEqual([
      { limitType: 'five_hour', usedPercent: 12, resetsAt: RESET_ISO, assumed: false },
      { limitType: 'seven_day', usedPercent: 88, resetsAt: RESET_ISO, assumed: false },
    ]);
  });

  it('classifies by duration even when the pair is swapped positionally', () => {
    const out = classifyCodexRateLimitWindows({
      primary: { usedPercent: 50, windowDurationMins: 10080 },
      secondary: { usedPercent: 5, windowDurationMins: 300 },
    });
    expect(out.map((w) => w.limitType)).toEqual(['seven_day', 'five_hour']);
  });

  it('falls back to position when windowDurationMins is null, and says so', () => {
    const out = classifyCodexRateLimitWindows({
      primary: { usedPercent: 1, windowDurationMins: null },
      secondary: { usedPercent: 2 },
    });
    expect(out).toEqual([
      { limitType: 'five_hour', usedPercent: 1, resetsAt: null, assumed: true },
      { limitType: 'seven_day', usedPercent: 2, resetsAt: null, assumed: true },
    ]);
  });

  it('records an unfamiliar duration verbatim instead of guessing a Claude name', () => {
    const out = classifyCodexRateLimitWindows({ primary: { usedPercent: 3, windowDurationMins: 1440 } });
    expect(out).toEqual([{ limitType: 'window_1440m', usedPercent: 3, resetsAt: null, assumed: false }]);
  });

  it('skips a window with no usable usedPercent and tolerates a missing snapshot', () => {
    expect(classifyCodexRateLimitWindows({ primary: { usedPercent: Number.NaN } })).toEqual([]);
    expect(classifyCodexRateLimitWindows({ primary: null, secondary: undefined })).toEqual([]);
    expect(classifyCodexRateLimitWindows(null)).toEqual([]);
  });
});

describe('codexResetsAtIso', () => {
  it('converts epoch seconds and tolerates epoch milliseconds', () => {
    expect(codexResetsAtIso(RESET_S)).toBe(RESET_ISO);
    expect(codexResetsAtIso(RESET_S * 1000)).toBe(RESET_ISO);
  });
  it('answers null for absent, zero, or non-finite values', () => {
    expect(codexResetsAtIso(null)).toBeNull();
    expect(codexResetsAtIso(undefined)).toBeNull();
    expect(codexResetsAtIso(0)).toBeNull();
    expect(codexResetsAtIso(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('mergeCodexRateLimitSnapshot (sparse rolling update)', () => {
  const base = {
    primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: RESET_S },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: RESET_S },
    planType: 'pro',
    rateLimitReachedType: null,
  };

  it('replaces a window the update carries and keeps the one it omits', () => {
    const merged = mergeCodexRateLimitSnapshot(base, { secondary: { usedPercent: 91, windowDurationMins: 10080 } });
    expect(merged?.primary).toEqual(base.primary);
    expect(merged?.secondary).toEqual({ usedPercent: 91, windowDurationMins: 10080 });
    expect(merged?.planType).toBe('pro');
  });

  it('never lets a null in the update clear a previously observed value', () => {
    const merged = mergeCodexRateLimitSnapshot(
      { ...base, rateLimitReachedType: 'rate_limit_reached' },
      { primary: null, planType: null, rateLimitReachedType: null },
    );
    expect(merged?.primary).toEqual(base.primary);
    expect(merged?.planType).toBe('pro');
    expect(merged?.rateLimitReachedType).toBe('rate_limit_reached');
  });

  it('starts a snapshot from an update when there was no prior read', () => {
    const merged = mergeCodexRateLimitSnapshot(null, { secondary: { usedPercent: 5 } });
    expect(merged).toEqual({ secondary: { usedPercent: 5 } });
  });

  it('ignores a malformed window in the update and a non-object update', () => {
    expect(mergeCodexRateLimitSnapshot(base, { primary: { nope: true } as never })?.primary).toEqual(base.primary);
    expect(mergeCodexRateLimitSnapshot(base, null)).toBe(base);
    expect(mergeCodexRateLimitSnapshot(base, undefined)).toBe(base);
  });
});

describe('codexSnapshotToSamples', () => {
  it('writes one row per window in the Claude row shape: 0-1 utilization, ISO reset, plan as subscription', () => {
    const rows = codexSnapshotToSamples(
      {
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: RESET_S },
        secondary: { usedPercent: 88, windowDurationMins: 10080 },
        planType: 'pro',
      },
      WHO,
      'usage_pull',
    );
    expect(rows).toEqual([
      {
        source: 'usage_pull',
        ...WHO,
        subscriptionType: 'pro',
        available: true,
        limitType: 'five_hour',
        utilization: 0.12,
        resetsAt: RESET_ISO,
        status: null,
      },
      {
        source: 'usage_pull',
        ...WHO,
        subscriptionType: 'pro',
        available: true,
        limitType: 'seven_day',
        utilization: 0.88,
        resetsAt: null,
        status: null,
      },
    ]);
  });

  it('carries the reached-limit enum in status on every window row', () => {
    const rows = codexSnapshotToSamples(
      { secondary: { usedPercent: 100, windowDurationMins: 10080 }, rateLimitReachedType: 'rate_limit_reached' },
      WHO,
      'rate_limit_event',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'rate_limit_event', limitType: 'seven_day', status: 'rate_limit_reached' });
  });

  it('records that the pull happened even when it named no window', () => {
    expect(codexSnapshotToSamples({}, WHO, 'usage_pull')).toEqual([
      {
        source: 'usage_pull',
        ...WHO,
        subscriptionType: null,
        available: true,
        limitType: null,
        utilization: null,
        resetsAt: null,
        status: 'no_window',
      },
    ]);
  });

  it('keeps the enum on a window-less push, which may carry nothing else', () => {
    const rows = codexSnapshotToSamples(
      { rateLimitReachedType: 'workspace_owner_credits_depleted' },
      WHO,
      'rate_limit_event',
    );
    expect(rows[0]).toMatchObject({ limitType: null, utilization: null, status: 'workspace_owner_credits_depleted' });
  });
});

describe('decideCodexRateLimitPark', () => {
  const healthy = {
    primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: RESET_S - 3600 },
    secondary: { usedPercent: 94, windowDurationMins: 10080, resetsAt: RESET_S },
  };

  it('does not park a healthy account — including a weekly window one point under the threshold', () => {
    // 95, not 90: the 5% headroom rule shared with the Claude side (#811).
    expect(CODEX_PARK_USED_PERCENT).toBe(95);
    expect(decideCodexRateLimitPark(healthy)).toBeNull();
    expect(
      decideCodexRateLimitPark({ ...healthy, secondary: { usedPercent: 92, windowDurationMins: 10080 } }),
    ).toBeNull();
    expect(decideCodexRateLimitPark(null)).toBeNull();
    expect(decideCodexRateLimitPark({})).toBeNull();
  });

  it('parks at exactly the weekly threshold with that window as the reset', () => {
    const park = decideCodexRateLimitPark({
      ...healthy,
      secondary: { usedPercent: 95, windowDurationMins: 10080, resetsAt: RESET_S },
    });
    expect(park).toMatchObject({
      reason: 'seven_day_threshold',
      reachedType: null,
      limitType: 'seven_day',
      usedPercent: 95,
      resetsAt: RESET_ISO,
    });
    expect(park?.message).toBe(
      `Codex rate limit [seven_day] 95% used, at or past the 95% park threshold (resets ${RESET_ISO})`,
    );
    expect(
      decideCodexRateLimitPark({ ...healthy, secondary: { usedPercent: 96, windowDurationMins: 10080 } })?.usedPercent,
    ).toBe(96);
  });

  it('does not park on the five-hour window alone — it is a rate, not the weekly wall', () => {
    expect(
      decideCodexRateLimitPark({
        primary: { usedPercent: 99, windowDurationMins: 300 },
        secondary: { usedPercent: 10, windowDurationMins: 10080 },
      }),
    ).toBeNull();
  });

  it('parks on any rateLimitReachedType and names the enum value', () => {
    const park = decideCodexRateLimitPark({
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: RESET_S - 3600 },
      secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: RESET_S },
      rateLimitReachedType: 'rate_limit_reached',
    });
    expect(park).toMatchObject({
      reason: 'rate_limit_reached',
      reachedType: 'rate_limit_reached',
      limitType: 'five_hour',
      usedPercent: 100,
      // The exhausted window's reset, not the weekly one's.
      resetsAt: new Date((RESET_S - 3600) * 1000).toISOString(),
    });
    expect(park?.message).toContain('Codex rate limit reached (rate_limit_reached) [five_hour] 100% used');
  });

  it('parks on depleted workspace credits with no reset — the host backoff takes over', () => {
    const park = decideCodexRateLimitPark({
      primary: { usedPercent: 3, windowDurationMins: 300 },
      rateLimitReachedType: 'workspace_owner_credits_depleted',
    });
    expect(park).toMatchObject({
      reason: 'rate_limit_reached',
      reachedType: 'workspace_owner_credits_depleted',
      resetsAt: null,
    });
    expect(park?.message).toContain('(workspace_owner_credits_depleted)');
  });

  it('with a reached limit but no window at 100%, uses the earliest stated reset', () => {
    const park = decideCodexRateLimitPark({
      primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: RESET_S + 60 },
      secondary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: RESET_S },
      rateLimitReachedType: 'workspace_member_usage_limit_reached',
    });
    expect(park?.resetsAt).toBe(RESET_ISO);
    expect(park?.reachedType).toBe('workspace_member_usage_limit_reached');
  });
});

describe('codexTurnRateLimit', () => {
  it('stamps the weekly window when present, else the five-hour one, else nothing', () => {
    expect(
      codexTurnRateLimit({
        primary: { usedPercent: 12, windowDurationMins: 300 },
        secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: RESET_S },
      }),
    ).toEqual({ type: 'seven_day', utilization: 0.34, resetsAt: RESET_ISO });
    expect(codexTurnRateLimit({ primary: { usedPercent: 12, windowDurationMins: 300 } })).toEqual({
      type: 'five_hour',
      utilization: 0.12,
      resetsAt: null,
    });
    expect(codexTurnRateLimit({})).toBeNull();
    expect(codexTurnRateLimit(null)).toBeNull();
  });
});

describe('response and notification parsing', () => {
  it('parses a read response, keeping the multi-bucket view and account id', () => {
    const parsed = parseCodexRateLimitsReadResponse({
      rateLimits: { primary: { usedPercent: 1 } },
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 1 } } },
      accountId: 'acct-9',
    });
    expect(parsed).toEqual({
      rateLimits: { primary: { usedPercent: 1 } },
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 1 } } },
      accountId: 'acct-9',
    });
  });

  it('rejects a response without rateLimits and normalizes an empty account id to null', () => {
    expect(parseCodexRateLimitsReadResponse({})).toBeNull();
    expect(parseCodexRateLimitsReadResponse(null)).toBeNull();
    expect(parseCodexRateLimitsReadResponse({ rateLimits: {}, accountId: '' })?.accountId).toBeNull();
  });

  it('parses an updated notification and rejects anything else', () => {
    expect(parseCodexRateLimitsUpdated({ rateLimits: { secondary: { usedPercent: 7 } } })).toEqual({
      secondary: { usedPercent: 7 },
    });
    expect(parseCodexRateLimitsUpdated({})).toBeNull();
    expect(parseCodexRateLimitsUpdated('nope')).toBeNull();
  });
});

describe('readCodexAccountIdFromAuthJson', () => {
  it('reads tokens.account_id from a ChatGPT login', () => {
    expect(
      readCodexAccountIdFromAuthJson(
        JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x', account_id: ' acct-42 ' } }),
      ),
    ).toBe('acct-42');
  });
  it('answers null for an API-key login, malformed JSON, or an unreadable file', () => {
    expect(readCodexAccountIdFromAuthJson(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk' }))).toBeNull();
    expect(readCodexAccountIdFromAuthJson('{not json')).toBeNull();
    expect(readCodexAccountIdFromAuthJson(null)).toBeNull();
  });
});
