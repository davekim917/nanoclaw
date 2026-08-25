/**
 * Rate-limit TRAJECTORY capture: the `/usage` control request is a pull, so
 * it reports utilization for accounts that are nowhere near a warning — the
 * accounts `rate_limit_event` never says anything about.
 *
 * The load-bearing case here is the feature-detect fallback. The SDK method
 * is documented as renaming when it stabilizes, and agent-runner is a
 * read-only bind mount with no build step, so a rename throws inside every
 * live container rather than failing CI. "no method => degrade to event-only,
 * turn unaffected" is what keeps that from being a fleet outage.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sdkMessages: unknown[] = [];
/** Set to a response object to expose the usage control method on the query. */
let usageResponse: unknown = null;
let usageRejects = false;
let usageHangs = false;
let usageCalls = 0;

const USAGE_CONTROL_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const gen = (async function* () {
      for (const m of sdkMessages) yield m;
    })();
    if (usageResponse !== null) {
      (gen as unknown as Record<string, unknown>)[USAGE_CONTROL_METHOD] = async () => {
        usageCalls++;
        if (usageRejects) throw new Error('usage endpoint unreachable');
        // The 3am case: the SDK's control channel has NO deadline of its own
        // (Query.request settles only on a matching response or transport
        // close), so an unanswered get_usage never settles at all.
        if (usageHangs) return new Promise(() => {});
        return usageResponse;
      };
    }
    return gen;
  },
}));

const {
  ClaudeProvider,
  planUsagePuller,
  usageResponseToSamples,
  withDeadline,
  laneForSlot,
  _resetUsagePullThrottleForTesting,
} = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { initTestSessionDb } = await import('../db/connection.js');
const { getRateLimitSampleRows } = await import('../db/rate-limit-samples.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rl-samples-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  initTestSessionDb();
  _resetUsagePullThrottleForTesting();
  usageResponse = null;
  usageRejects = false;
  usageHangs = false;
  usageCalls = 0;
  sdkMessages.length = 0;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  delete process.env.NANOCLAW_OAUTH_CREDENTIAL_SET;
  delete process.env.CLAUDE_CODE_OAUTH_LANES;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Drain the provider's event stream, then let the fire-and-forget pull settle. */
async function runTurn(env: Record<string, string> = {}): Promise<void> {
  const provider = new ClaudeProvider({ env });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  for await (const _e of q.events) void _e;
  await new Promise((r) => setTimeout(r, 5));
}

const RESULT_MSG = { type: 'result', subtype: 'success', result: 'ok' };
const NO_IDENTITY = { account: null, credentialSet: null, lane: null };

describe('planUsagePuller — feature detection', () => {
  it('returns null when the SDK query has no usage method (post-rename fleet safety)', () => {
    expect(planUsagePuller({})).toBeNull();
    expect(planUsagePuller(null)).toBeNull();
    // A same-named non-function must not be called either.
    expect(planUsagePuller({ [USAGE_CONTROL_METHOD]: 'nope' })).toBeNull();
  });

  it('binds the method to its query when present', async () => {
    const q = { [USAGE_CONTROL_METHOD]: async function (this: unknown) { return { self: this }; } };
    const pull = planUsagePuller(q);
    expect(pull).not.toBeNull();
    expect((await pull!()) as unknown).toEqual({ self: q } as unknown as never);
  });
});

describe('withDeadline', () => {
  it('rejects a pull that never settles', async () => {
    const start = Date.now();
    await expect(withDeadline(new Promise(() => {}), 20)).rejects.toThrow('usage pull exceeded 20ms');
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('passes a value through and clears its timer', async () => {
    const real = globalThis.clearTimeout;
    let cleared = 0;
    globalThis.clearTimeout = ((t: Parameters<typeof real>[0]) => {
      cleared++;
      return real(t);
    }) as typeof real;
    try {
      await expect(withDeadline(Promise.resolve('ok'), 20)).resolves.toBe('ok');
    } finally {
      globalThis.clearTimeout = real;
    }
    // A fast pull must not leave a live timer behind for the full deadline.
    expect(cleared).toBeGreaterThan(0);
  });
});

describe('laneForSlot', () => {
  const DECL = '1:agentic-primary,3:shared-dev';

  it('maps the unsuffixed primary to slot 1 and numbered slots to their index', () => {
    expect(laneForSlot(DECL, 'CLAUDE_CODE_OAUTH_TOKEN')).toBe('agentic-primary');
    expect(laneForSlot(DECL, 'CLAUDE_CODE_OAUTH_TOKEN_3')).toBe('shared-dev');
  });

  it('returns null for an UNDECLARED slot rather than guessing a default', () => {
    // Slot 2 is absent from the declaration. Defaulting it to 'agentic-primary'
    // would invent a policy claim the operator never made.
    expect(laneForSlot(DECL, 'CLAUDE_CODE_OAUTH_TOKEN_2')).toBeNull();
    expect(laneForSlot(undefined, 'CLAUDE_CODE_OAUTH_TOKEN')).toBeNull();
    expect(laneForSlot(DECL, null)).toBeNull();
  });
});

describe('usageResponseToSamples', () => {
  it('emits one row per reported window, normalizing 0-100 to a 0-1 fraction', () => {
    const rows = usageResponseToSamples(
      {
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 12, resets_at: '2026-08-25T18:00:00.000Z' },
          seven_day: { utilization: 63.5, resets_at: '2026-08-29T00:00:00.000Z' },
          seven_day_opus: { utilization: 0, resets_at: null },
          seven_day_oauth_apps: null,
        },
      },
      { account: 'CLAUDE_CODE_OAUTH_TOKEN_2', credentialSet: 'global', lane: 'agentic-primary' },
    );
    expect(rows.map((r) => [r.limitType, r.utilization])).toEqual([
      ['five_hour', 0.12],
      ['seven_day', 0.635],
      ['seven_day_opus', 0],
    ]);
    expect(
      rows.every(
        (r) =>
          r.available &&
          r.account === 'CLAUDE_CODE_OAUTH_TOKEN_2' &&
          r.credentialSet === 'global' &&
          r.lane === 'agentic-primary' &&
          r.subscriptionType === 'max',
      ),
    ).toBe(true);
    // A 0% window is a real reading and must survive — that is the baseline
    // the event-gated path could never produce.
    expect(rows.some((r) => r.limitType === 'seven_day_opus')).toBe(true);
  });

  it('records rate_limits_available:false as NOT APPLICABLE, not as an error or a gap', () => {
    const rows = usageResponseToSamples(
      { subscription_type: null, rate_limits_available: false, rate_limits: null },
      NO_IDENTITY,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ available: false, limitType: null, utilization: null, resetsAt: null });
  });

  it('still records that a pull happened when the plan reports no usable window', () => {
    const rows = usageResponseToSamples({ rate_limits_available: true, rate_limits: { five_hour: null } }, NO_IDENTITY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ available: true, limitType: null, utilization: null });
  });
});

describe('capture through the provider', () => {
  it('writes usage_pull rows for an account with no rate_limit_event at all', async () => {
    sdkMessages.push({ type: 'system', subtype: 'init', session_id: 's1' }, RESULT_MSG);
    usageResponse = {
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 7, resets_at: '2026-08-25T18:00:00.000Z' } },
    };

    process.env.NANOCLAW_OAUTH_CREDENTIAL_SET = 'global';
    process.env.CLAUDE_CODE_OAUTH_LANES = '1:agentic-primary,3:shared-dev';

    await runTurn({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-primary' });

    const rows = getRateLimitSampleRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'usage_pull',
      account: 'CLAUDE_CODE_OAUTH_TOKEN',
      credential_set: 'global',
      lane: 'agentic-primary',
      subscription_type: 'max',
      available: 1,
      limit_type: 'five_hour',
      utilization: 0.07,
      resets_at: '2026-08-25T18:00:00.000Z',
      status: null,
    });
  });

  it('distinguishes a per-group credential set from the global pool on the SAME slot name', async () => {
    // The misread this exists to prevent: a scoped group's tokens are
    // forwarded under the same unscoped `_N` names as the global pool, so
    // `account` alone makes two different Anthropic accounts look like one
    // series. Only (credential_set, account) is an identity.
    sdkMessages.push({ type: 'system', subtype: 'init', session_id: 's1' }, RESULT_MSG);
    usageResponse = { rate_limits_available: true, rate_limits: { seven_day: { utilization: 40, resets_at: null } } };
    process.env.NANOCLAW_OAUTH_CREDENTIAL_SET = 'group:scoped-group';
    process.env.CLAUDE_CODE_OAUTH_LANES = '1:agentic-primary,3:shared-dev';

    await runTurn({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-scoped' });

    const rows = getRateLimitSampleRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].account).toBe('CLAUDE_CODE_OAUTH_TOKEN'); // same slot name as a global-pool row
    expect(rows[0].credential_set).toBe('group:scoped-group'); // ...but a different account set
  });

  it('degrades to event-only capture when the SDK has no usage method, and the turn still completes', async () => {
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 's1' },
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.91 },
      },
      RESULT_MSG,
    );
    usageResponse = null; // no method on the query object at all

    const provider = new ClaudeProvider({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-primary' } });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });
    const kinds: string[] = [];
    for await (const e of q.events) kinds.push(e.type);
    await new Promise((r) => setTimeout(r, 5));

    expect(kinds).toContain('result'); // the turn was not delayed or failed
    expect(usageCalls).toBe(0);
    const rows = getRateLimitSampleRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'rate_limit_event',
      account: 'CLAUDE_CODE_OAUTH_TOKEN',
      available: 1,
      limit_type: 'seven_day',
      utilization: 0.91,
      status: 'allowed_warning',
    });
  });

  it('throttles the pull to one per interval across turns in the same session', async () => {
    sdkMessages.push({ type: 'system', subtype: 'init', session_id: 's1' }, RESULT_MSG, RESULT_MSG, RESULT_MSG);
    usageResponse = { rate_limits_available: true, rate_limits: { five_hour: { utilization: 7, resets_at: null } } };

    await runTurn({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-primary' });

    expect(usageCalls).toBe(1);
    expect(getRateLimitSampleRows()).toHaveLength(1);
  });

  it('completes the turn on time when the pull HANGS forever, and records nothing', async () => {
    sdkMessages.push({ type: 'system', subtype: 'init', session_id: 's1' }, RESULT_MSG);
    usageHangs = true;
    usageResponse = { rate_limits_available: true, rate_limits: {} };

    const provider = new ClaudeProvider({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-primary' } });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });
    const start = Date.now();
    const kinds: string[] = [];
    for await (const e of q.events) kinds.push(e.type);
    const elapsed = Date.now() - start;
    await new Promise((r) => setTimeout(r, 5));

    expect(kinds).toContain('result');
    expect(usageCalls).toBe(1);
    // Nowhere near USAGE_PULL_TIMEOUT_MS (10s) — the turn never waited on it
    // at all, and the deadline only bounds the leaked pending promise.
    expect(elapsed).toBeLessThan(1000);
    // Timed out => NOT SAMPLED. No row, and specifically not an
    // `available: 0` row, which would falsely mean "plan limits do not apply".
    expect(getRateLimitSampleRows()).toHaveLength(0);
  });

  it('gives the hung pull a deadline so it does not leak forever', async () => {
    // Short deadline so the case does not sit for USAGE_PULL_TIMEOUT_MS.
    _resetUsagePullThrottleForTesting(20);
    sdkMessages.push({ type: 'system', subtype: 'init', session_id: 's1' }, RESULT_MSG);
    usageHangs = true;
    usageResponse = { rate_limits_available: true, rate_limits: {} }; // attaches the method; never returned

    const errors: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(' '));
    try {
      await runTurn({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-primary' });
      await new Promise((r) => setTimeout(r, 80));
    } finally {
      console.error = realError;
    }

    // Without the deadline the SDK never settles this promise (verified in
    // sdk.mjs: Query.request has no timer), so nothing is ever logged.
    expect(errors.some((e) => e.includes('usage pull exceeded 20ms'))).toBe(true);
    expect(getRateLimitSampleRows()).toHaveLength(0);
  });

  it('never fails the turn when the pull rejects, and records nothing', async () => {
    sdkMessages.push({ type: 'system', subtype: 'init', session_id: 's1' }, RESULT_MSG);
    usageRejects = true;
    usageResponse = { rate_limits_available: true, rate_limits: {} };

    const provider = new ClaudeProvider({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-primary' } });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });
    const kinds: string[] = [];
    for await (const e of q.events) kinds.push(e.type);
    await new Promise((r) => setTimeout(r, 5));

    expect(kinds).toContain('result');
    expect(usageCalls).toBe(1);
    expect(getRateLimitSampleRows()).toHaveLength(0);
  });
});
