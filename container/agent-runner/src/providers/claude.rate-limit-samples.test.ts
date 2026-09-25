/**
 * Plan-utilization capture from the response headers.
 *
 * Every OAuth slot is a `claude setup-token` credential scoped
 * `user:inference` only, so `/api/oauth/usage` (the SDK `get_usage` control
 * request) answers 403 and then 429 for it. The runner therefore never asks:
 * it records the per-window readings the CLI already parsed from the
 * `anthropic-ratelimit-unified-*` headers into `rate_limit_event`'s
 * `unifiedWindows`.
 *
 * `unifiedWindows` is internal to the SDK, and agent-runner is a
 * read-only bind mount with no build step, so a CLI that drops or reshapes it
 * must degrade to the top-level row — never throw inside a live container.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

const {
  ClaudeProvider,
  unifiedWindowsToSamples,
  rateLimitEventToSamples,
  laneForSlot,
  _setSdkQueryForTesting,
  _resetUnifiedWindowsWarningForTesting,
} = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { initTestSessionDb } = await import('../modules/mailbox/testing.js');
const { getRateLimitSampleRows } = await import('../modules/mailbox/index.js');

/** The SDK method that sends the `get_usage` control request (sdk.d.ts, 0.3.281). */
const USAGE_CONTROL_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

const sdkMessages: unknown[] = [];
/** Every property name the provider read off the SDK query object. */
const accessed = new Set<string>();
let usageCalls = 0;

/**
 * A fake SDK query that exposes the usage control method (as the real SDK
 * does) and records every property the provider touches, so "never sends
 * get_usage" is checked against the object itself, not against our own code.
 */
const fakeSdkQuery = (() => {
  const gen = (async function* () {
    for (const m of sdkMessages) yield m;
  })() as unknown as Record<string | symbol, unknown>;
  gen.interrupt = async () => {};
  gen[USAGE_CONTROL_METHOD] = async () => {
    usageCalls++;
    return { rate_limits_available: true, rate_limits: {} };
  };
  return new Proxy(gen, {
    get(target, prop) {
      if (typeof prop === 'string') accessed.add(prop);
      const value = target[prop];
      // Generator methods need their real receiver, not the proxy.
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as Query;
}) as unknown as NonNullable<Parameters<typeof _setSdkQueryForTesting>[0]>;

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rl-samples-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  initTestSessionDb();
  sdkMessages.length = 0;
  accessed.clear();
  usageCalls = 0;
  _resetUnifiedWindowsWarningForTesting();
  _setSdkQueryForTesting(fakeSdkQuery);
});

afterEach(() => {
  _setSdkQueryForTesting();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  delete process.env.NANOCLAW_OAUTH_CREDENTIAL_SET;
  delete process.env.CLAUDE_CODE_OAUTH_LANES;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function runTurn(env: Record<string, string> = {}): Promise<string[]> {
  const provider = new ClaudeProvider({ env });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  const kinds: string[] = [];
  for await (const e of q.events) kinds.push(e.type);
  // Anything fire-and-forget would land here; nothing should.
  await new Promise((r) => setTimeout(r, 5));
  return kinds;
}

const INIT_MSG = { type: 'system', subtype: 'init', session_id: 's1' };
const RESULT_MSG = { type: 'result', subtype: 'success', result: 'ok' };
const WHO = { account: 'CLAUDE_CODE_OAUTH_TOKEN_2', credentialSet: 'global', lane: 'agentic-primary' };
// 2026-09-25T18:00:00Z and 2026-09-29T00:00:00Z as epoch seconds, as the CLI sends them.
const FIVE_HOUR_RESET = 1790359200;
const SEVEN_DAY_RESET = 1790640000;

describe('laneForSlot', () => {
  const DECL = '1:agentic-primary,3:shared-dev';

  it('maps the unsuffixed primary to slot 1 and numbered slots to their index', () => {
    expect(laneForSlot(DECL, 'CLAUDE_CODE_OAUTH_TOKEN')).toBe('agentic-primary');
    expect(laneForSlot(DECL, 'CLAUDE_CODE_OAUTH_TOKEN_3')).toBe('shared-dev');
  });

  it('returns null for an UNDECLARED slot rather than guessing a default', () => {
    expect(laneForSlot(DECL, 'CLAUDE_CODE_OAUTH_TOKEN_2')).toBeNull();
    expect(laneForSlot(undefined, 'CLAUDE_CODE_OAUTH_TOKEN')).toBeNull();
    expect(laneForSlot(DECL, null)).toBeNull();
  });
});

describe('unifiedWindowsToSamples', () => {
  it('emits one rate_limit_headers row per window, utilization as the 0-1 fraction sent', () => {
    const rows = unifiedWindowsToSamples(
      {
        five_hour: { utilization: 0.12, resetsAt: FIVE_HOUR_RESET },
        seven_day: { utilization: 0.635, resetsAt: SEVEN_DAY_RESET },
        seven_day_overage_included: { utilization: 0, resetsAt: SEVEN_DAY_RESET },
      },
      WHO,
    );
    expect(rows).toEqual([
      {
        source: 'rate_limit_headers',
        ...WHO,
        subscriptionType: null,
        available: true,
        limitType: 'five_hour',
        utilization: 0.12,
        resetsAt: '2026-09-25T18:00:00.000Z',
        status: null,
      },
      {
        source: 'rate_limit_headers',
        ...WHO,
        subscriptionType: null,
        available: true,
        limitType: 'seven_day',
        utilization: 0.635,
        resetsAt: '2026-09-29T00:00:00.000Z',
        status: null,
      },
      {
        source: 'rate_limit_headers',
        ...WHO,
        subscriptionType: null,
        available: true,
        limitType: 'seven_day_overage_included',
        // A 0% window is a real reading — the baseline the top-level field never gave.
        utilization: 0,
        resetsAt: '2026-09-29T00:00:00.000Z',
        status: null,
      },
    ]);
  });

  it('keeps a reading above 1 (usage past the cap is legitimate) and a window name it has never seen', () => {
    const rows = unifiedWindowsToSamples(
      { five_hour: { utilization: 1.04 }, some_new_window: { utilization: 0.3 } },
      WHO,
    );
    expect(rows.map((r) => [r.limitType, r.utilization, r.resetsAt])).toEqual([
      ['five_hour', 1.04, null],
      ['some_new_window', 0.3, null],
    ]);
  });

  it('yields nothing — and never throws — for an absent or reshaped field', () => {
    for (const shape of [undefined, null, 'five_hour', 42, [], [{ utilization: 0.5 }]]) {
      expect(unifiedWindowsToSamples(shape, WHO)).toEqual([]);
    }
    // Entries it cannot read are skipped; the readable one survives.
    expect(
      unifiedWindowsToSamples(
        {
          five_hour: null,
          seven_day: { utilization: '0.5' },
          seven_day_opus: { utilization: Number.NaN },
          seven_day_sonnet: 'x',
          ok: { utilization: 0.2, resetsAt: 'soon' },
        },
        WHO,
      ).map((r) => [r.limitType, r.utilization, r.resetsAt]),
    ).toEqual([['ok', 0.2, null]]);
  });
});

describe('rateLimitEventToSamples', () => {
  it('keeps the top-level row first, then adds the windows', () => {
    const rows = rateLimitEventToSamples(
      {
        status: 'allowed',
        unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: FIVE_HOUR_RESET } },
      },
      WHO,
    );
    expect(rows.map((r) => [r.source, r.limitType, r.utilization, r.status])).toEqual([
      ['rate_limit_event', null, null, 'allowed'],
      ['rate_limit_headers', 'five_hour', 0.2, null],
    ]);
  });

  it('survives a field whose getter throws', () => {
    const hostile = {
      status: 'allowed',
      get unifiedWindows(): unknown {
        return new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('boom');
            },
          },
        );
      },
    };
    const rows = rateLimitEventToSamples(hostile, WHO);
    expect(rows.map((r) => r.source)).toEqual(['rate_limit_event']);
  });
});

describe('capture through the provider', () => {
  it('writes a row per window on the active slot and credential set when unifiedWindows is present', async () => {
    sdkMessages.push(
      INIT_MSG,
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          unifiedWindows: {
            five_hour: { utilization: 0.07, resetsAt: FIVE_HOUR_RESET },
            seven_day: { utilization: 0.41, resetsAt: SEVEN_DAY_RESET },
          },
        },
      },
      RESULT_MSG,
    );
    process.env.NANOCLAW_OAUTH_CREDENTIAL_SET = 'group:scoped-group';
    process.env.CLAUDE_CODE_OAUTH_LANES = '1:agentic-primary,3:shared-dev';

    const kinds = await runTurn({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-primary' });

    expect(kinds).toContain('result');
    const rows = getRateLimitSampleRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      source: 'rate_limit_event',
      account: 'CLAUDE_CODE_OAUTH_TOKEN',
      credential_set: 'group:scoped-group',
      status: 'allowed',
      utilization: null, // the top-level field is still only set past a threshold
    });
    expect(rows.slice(1)).toEqual([
      expect.objectContaining({
        source: 'rate_limit_headers',
        account: 'CLAUDE_CODE_OAUTH_TOKEN',
        credential_set: 'group:scoped-group',
        lane: 'agentic-primary',
        available: 1,
        limit_type: 'five_hour',
        utilization: 0.07,
        resets_at: '2026-09-25T18:00:00.000Z',
        status: null,
      }),
      expect.objectContaining({
        source: 'rate_limit_headers',
        limit_type: 'seven_day',
        utilization: 0.41,
        resets_at: '2026-09-29T00:00:00.000Z',
      }),
    ]);
  });

  it('falls back to the top-level row alone when unifiedWindows is absent, and the turn completes', async () => {
    sdkMessages.push(
      INIT_MSG,
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.91 },
      },
      RESULT_MSG,
    );

    const kinds = await runTurn({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-primary' });

    expect(kinds).toContain('result');
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

  it('does not crash on a reshaped unifiedWindows', async () => {
    sdkMessages.push(
      INIT_MSG,
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: ['five_hour', 0.5] } },
      RESULT_MSG,
    );

    const kinds = await runTurn({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-primary' });

    expect(kinds).toContain('result');
    expect(getRateLimitSampleRows().map((r) => r.source)).toEqual(['rate_limit_event']);
  });

  it('never sends the get_usage control request, across turns, with or without events', async () => {
    sdkMessages.push(
      INIT_MSG,
      RESULT_MSG,
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1 } } },
      },
      RESULT_MSG,
      RESULT_MSG,
    );

    await runTurn({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-primary' });

    // The method exists on the query object exactly as in the real SDK; the
    // provider must neither call it nor even look it up.
    expect(usageCalls).toBe(0);
    expect([...accessed].filter((k) => /usage/i.test(k))).toEqual([]);
    // And no row claims to come from a pull.
    expect(getRateLimitSampleRows().some((r) => r.source === 'usage_pull')).toBe(false);
  });
});
