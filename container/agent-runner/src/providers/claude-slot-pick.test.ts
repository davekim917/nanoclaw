/**
 * Quota-burn 0.6: usage-maximizing OAuth slot pick at session start.
 *
 * Fixtures are raw `/api/oauth/usage` bodies (utilization 0-100) as the CLI
 * passes them through to `get_usage`'s `rate_limits`. No network: the fetch
 * is injected, and the hermeticity preload would trip on the global one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ClaudeProvider, usageResponseToSamples } from './claude.js';
import {
  OAUTH_BETA_HEADER,
  OAUTH_USAGE_URL,
  SLOT_PICK_HEADROOM,
  fetchSlotUsage,
  formatSlotRanking,
  pickSlotByUsage,
  type SlotUsageReading,
} from './claude-slot-pick.js';
import { getRateLimitSampleRows } from '../modules/mailbox/index.js';
import { getCredentialSlot, setCredentialSlot } from '../modules/mailbox/session-state.js';
import { initTestSessionDb } from '../modules/mailbox/testing.js';

const WHO = { account: 'x', credentialSet: null, lane: null };

/** Raw usage body → the sample rows the provider would record for one slot. */
function reading(name: string, body: Record<string, unknown> | null): SlotUsageReading {
  if (body === null) return { name, samples: null };
  return {
    name,
    samples: usageResponseToSamples(
      { subscription_type: null, rate_limits_available: true, rate_limits: body as never },
      { ...WHO, account: name },
    ),
  };
}

const win = (utilization: number, resets_at = '2026-09-17T00:00:00Z') => ({ utilization, resets_at });

describe('pickSlotByUsage — the rule', () => {
  it('picks the highest seven_day utilization that is still below the headroom line (drain most-used first)', () => {
    const pick = pickSlotByUsage([
      reading('CLAUDE_CODE_OAUTH_TOKEN', { five_hour: win(10), seven_day: win(76) }),
      reading('CLAUDE_CODE_OAUTH_TOKEN_2', { five_hour: win(40), seven_day: win(87) }),
      reading('CLAUDE_CODE_OAUTH_TOKEN_3', { five_hour: win(5), seven_day: win(88) }),
      reading('CLAUDE_CODE_OAUTH_TOKEN_5', { five_hour: win(0), seven_day: win(21) }),
      reading('CLAUDE_CODE_OAUTH_TOKEN_6', { five_hour: win(60), seven_day: win(18) }),
    ]);
    expect(pick.chosen).toBe('CLAUDE_CODE_OAUTH_TOKEN_3');
  });

  it('leaves SLOT_PICK_HEADROOM: a slot at 0.96 is skipped in favour of one at 0.90', () => {
    expect(SLOT_PICK_HEADROOM).toBe(0.05);
    const pick = pickSlotByUsage([
      reading('A', { five_hour: win(1), seven_day: win(96) }),
      reading('B', { five_hour: win(1), seven_day: win(90) }),
    ]);
    expect(pick.chosen).toBe('B');
    expect(pick.ranking[0]).toMatchObject({ name: 'A', sevenDay: 0.96, skipped: 'seven_day_exhausted' });
  });

  it('a slot at 0.94 is still inside the headroom line and is picked over 0.90', () => {
    const pick = pickSlotByUsage([
      reading('A', { five_hour: win(1), seven_day: win(94) }),
      reading('B', { five_hour: win(1), seven_day: win(90) }),
    ]);
    expect(pick.chosen).toBe('A');
  });

  it('tiebreaks equal seven_day on the highest five_hour below 1.0', () => {
    const pick = pickSlotByUsage([
      reading('A', { five_hour: win(20), seven_day: win(50) }),
      reading('B', { five_hour: win(70), seven_day: win(50) }),
      reading('C', { five_hour: win(45), seven_day: win(50) }),
    ]);
    expect(pick.chosen).toBe('B');
  });

  it('falls back to ring order on an exact tie of both windows', () => {
    const pick = pickSlotByUsage([
      reading('A', { five_hour: win(20), seven_day: win(50) }),
      reading('B', { five_hour: win(20), seven_day: win(50) }),
    ]);
    expect(pick.chosen).toBe('A');
  });

  it('skips a slot whose seven_day is exhausted (>= 1.0), even though it ranks highest', () => {
    const pick = pickSlotByUsage([
      reading('A', { five_hour: win(3), seven_day: win(100) }),
      reading('B', { five_hour: win(50), seven_day: win(83) }),
    ]);
    expect(pick.chosen).toBe('B');
    expect(pick.ranking[0]).toMatchObject({ name: 'A', sevenDay: 1, skipped: 'seven_day_exhausted' });
  });

  it('skips a slot whose pull said plan limits do not apply (available: false)', () => {
    const notApplicable: SlotUsageReading = {
      name: 'A',
      samples: usageResponseToSamples({ rate_limits_available: false }, { ...WHO, account: 'A' }),
    };
    const pick = pickSlotByUsage([notApplicable, reading('B', { five_hour: win(1), seven_day: win(2) })]);
    expect(pick.chosen).toBe('B');
    expect(pick.ranking[0]!.skipped).toBe('not_applicable');
  });

  it('skips an unsampled slot (pull failed) rather than guessing its usage', () => {
    const pick = pickSlotByUsage([reading('A', null), reading('B', { five_hour: win(1), seven_day: win(2) })]);
    expect(pick.chosen).toBe('B');
    expect(pick.ranking[0]!.skipped).toBe('unsampled');
  });

  it('skips a slot with no seven_day window — it cannot be ranked', () => {
    const pick = pickSlotByUsage([reading('A', { five_hour: win(1) }), reading('B', { five_hour: win(1), seven_day: win(2) })]);
    expect(pick.chosen).toBe('B');
    expect(pick.ranking[0]!.skipped).toBe('no_seven_day');
  });

  it('skips a slot whose five_hour window is full — its first request would 429', () => {
    const pick = pickSlotByUsage([
      reading('A', { five_hour: win(100), seven_day: win(90) }),
      reading('B', { five_hour: win(10), seven_day: win(60) }),
    ]);
    expect(pick.chosen).toBe('B');
    expect(pick.ranking[0]!.skipped).toBe('five_hour_exhausted');
  });

  it('returns chosen: null when every slot is exhausted or unreadable (caller keeps today’s behaviour)', () => {
    const pick = pickSlotByUsage([
      reading('A', { five_hour: win(0), seven_day: win(100) }),
      reading('B', null),
      reading('C', { five_hour: win(0), seven_day: win(120) }),
    ]);
    expect(pick.chosen).toBeNull();
    expect(pick.ranking.map((r) => r.skipped)).toEqual(['seven_day_exhausted', 'unsampled', 'seven_day_exhausted']);
  });

  it('formats the ranking as one log line with percentages and skip reasons', () => {
    const pick = pickSlotByUsage([
      reading('CLAUDE_CODE_OAUTH_TOKEN_2', { five_hour: win(12), seven_day: win(87) }),
      reading('CLAUDE_CODE_OAUTH_TOKEN_4', { five_hour: win(3), seven_day: win(100) }),
    ]);
    expect(formatSlotRanking(pick.ranking)).toBe(
      'CLAUDE_CODE_OAUTH_TOKEN_2 7d=87% 5h=12% · CLAUDE_CODE_OAUTH_TOKEN_4 7d=100% 5h=3% skipped:seven_day_exhausted',
    );
  });
});

describe('fetchSlotUsage — the per-slot pull', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('GETs the usage endpoint authenticated as the given slot and maps the body to rate_limits', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return json({ five_hour: win(12), seven_day: win(87), limits: [], extra_usage: { is_enabled: false } });
    }) as unknown as typeof fetch;

    const res = await fetchSlotUsage('tok-2', { fetchImpl, timeoutMs: 1000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(OAUTH_USAGE_URL);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer tok-2', 'anthropic-beta': OAUTH_BETA_HEADER });
    expect(res.rate_limits_available).toBe(true);
    expect(res.rate_limits).toMatchObject({ five_hour: win(12), seven_day: win(87) });
    // Non-window keys pass through and are ignored downstream (no numeric utilization).
    const rows = usageResponseToSamples(res, WHO);
    expect(rows.map((r) => r.limitType).sort()).toEqual(['five_hour', 'seven_day']);
    expect(rows.find((r) => r.limitType === 'seven_day')!.utilization).toBeCloseTo(0.87);
  });

  it('rejects on a non-2xx status (expired or scope-less token) instead of recording a row', async () => {
    const fetchImpl = (async () => json({ error: 'unauthorized' }, 401)) as unknown as typeof fetch;
    await expect(fetchSlotUsage('bad', { fetchImpl, timeoutMs: 1000 })).rejects.toThrow('HTTP 401');
  });

  it('rejects on a non-object body', async () => {
    const fetchImpl = (async () => json([1, 2, 3])) as unknown as typeof fetch;
    await expect(fetchSlotUsage('t', { fetchImpl, timeoutMs: 1000 })).rejects.toThrow('non-object');
  });

  it('aborts a hung pull at the deadline', async () => {
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    await expect(fetchSlotUsage('t', { fetchImpl, timeoutMs: 20 })).rejects.toThrow('aborted');
  });
});

describe('ClaudeProvider.pickCredentialSlotByUsage — ring integration', () => {
  const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const savedSet = process.env.NANOCLAW_OAUTH_CREDENTIAL_SET;
  const savedLanes = process.env.CLAUDE_CODE_OAUTH_LANES;

  beforeEach(() => {
    initTestSessionDb();
    delete process.env.NANOCLAW_OAUTH_CREDENTIAL_SET;
    delete process.env.CLAUDE_CODE_OAUTH_LANES;
  });
  afterEach(() => {
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore('CLAUDE_CODE_OAUTH_TOKEN', savedToken);
    restore('NANOCLAW_OAUTH_CREDENTIAL_SET', savedSet);
    restore('CLAUDE_CODE_OAUTH_LANES', savedLanes);
  });

  const RING = {
    CLAUDE_CODE_OAUTH_TOKEN: 'tok-1',
    CLAUDE_CODE_OAUTH_TOKEN_2: 'tok-2',
    CLAUDE_CODE_OAUTH_TOKEN_3: 'tok-3',
  };

  /** Fake fetch keyed by bearer token; `null` → HTTP 500 for that slot. */
  function fakeFetch(byToken: Record<string, Record<string, unknown> | null>) {
    const seen: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      const token = auth.replace(/^Bearer /, '');
      seen.push(token);
      const body = byToken[token];
      if (body === null || body === undefined) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  }

  it('samples every slot, records a usage_pull row per slot per window, and moves the ring onto the pick', async () => {
    process.env.NANOCLAW_OAUTH_CREDENTIAL_SET = 'group:example';
    process.env.CLAUDE_CODE_OAUTH_LANES = '1:agentic-primary,3:shared-dev';
    const { fetchImpl, seen } = fakeFetch({
      'tok-1': { five_hour: win(10), seven_day: win(76) },
      'tok-2': { five_hour: win(40), seven_day: win(87) },
      'tok-3': { five_hour: win(5), seven_day: win(21) },
    });
    const p = new ClaudeProvider({ env: RING });
    await p.pickCredentialSlotByUsage({ fetchImpl, timeoutMs: 1000 });

    expect(seen.sort()).toEqual(['tok-1', 'tok-2', 'tok-3']);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-2');
    expect(getCredentialSlot('claude')).toBe('CLAUDE_CODE_OAUTH_TOKEN_2');

    const rows = getRateLimitSampleRows();
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(['usage_pull']));
    expect(rows.every((r) => r.credential_set === 'group:example')).toBe(true);
    const sevenDay = Object.fromEntries(
      rows.filter((r) => r.limit_type === 'seven_day').map((r) => [r.account, r.utilization]),
    );
    expect(sevenDay).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 0.76, CLAUDE_CODE_OAUTH_TOKEN_2: 0.87, CLAUDE_CODE_OAUTH_TOKEN_3: 0.21 });
    const lanes = Object.fromEntries(rows.map((r) => [r.account, r.lane]));
    expect(lanes).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'agentic-primary', CLAUDE_CODE_OAUTH_TOKEN_2: null, CLAUDE_CODE_OAUTH_TOKEN_3: 'shared-dev' });
    expect(rows.every((r) => /^\d{4}-\d{2}-\d{2}T.*Z$/.test(r.ts))).toBe(true);

    // The pick is what the next query runs on, and rotation continues from it.
    p.resetRotationCycle();
    expect(p.rotateApiKey()).toMatchObject({ rotated: true, slot: 'CLAUDE_CODE_OAUTH_TOKEN_3', position: 3 });
  });

  it('on resume, re-picks rather than restoring the persisted slot blindly', async () => {
    setCredentialSlot('claude', 'CLAUDE_CODE_OAUTH_TOKEN_3'); // a previous container ended here
    const { fetchImpl } = fakeFetch({
      'tok-1': { five_hour: win(1), seven_day: win(90) },
      'tok-2': { five_hour: win(1), seven_day: win(30) },
      'tok-3': { five_hour: win(1), seven_day: win(10) },
    });
    const p = new ClaudeProvider({ env: RING });
    p.restorePersistedCredentialSlot();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-3');
    await p.pickCredentialSlotByUsage({ fetchImpl, timeoutMs: 1000 });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-1');
    expect(getCredentialSlot('claude')).toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('keeps today’s behaviour (restored position, hint untouched) when every slot is exhausted', async () => {
    setCredentialSlot('claude', 'CLAUDE_CODE_OAUTH_TOKEN_2');
    const { fetchImpl } = fakeFetch({
      'tok-1': { five_hour: win(0), seven_day: win(100) },
      'tok-2': { five_hour: win(0), seven_day: win(100) },
      'tok-3': null, // pull fails → unsampled
    });
    const p = new ClaudeProvider({ env: RING });
    p.restorePersistedCredentialSlot();
    await p.pickCredentialSlotByUsage({ fetchImpl, timeoutMs: 1000 });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-2');
    expect(getCredentialSlot('claude')).toBe('CLAUDE_CODE_OAUTH_TOKEN_2');
    // The two readable slots were still sampled — that is what stops idle slots going dark.
    expect(getRateLimitSampleRows().map((r) => r.account).sort()).toEqual([
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN_2',
      'CLAUDE_CODE_OAUTH_TOKEN_2',
    ]);
  });

  it('does nothing on the API-key auth path (no pulls, no rows)', async () => {
    const { fetchImpl, seen } = fakeFetch({});
    const p = new ClaudeProvider({ env: { ANTHROPIC_API_KEY: 'sk-x', ...RING } });
    await p.pickCredentialSlotByUsage({ fetchImpl, timeoutMs: 1000 });
    expect(seen).toEqual([]);
    expect(getRateLimitSampleRows()).toHaveLength(0);
  });

  it('samples a single-slot ring but has nothing to pick between', async () => {
    const { fetchImpl, seen } = fakeFetch({ solo: { five_hour: win(1), seven_day: win(2) } });
    const p = new ClaudeProvider({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'solo' } });
    await p.pickCredentialSlotByUsage({ fetchImpl, timeoutMs: 1000 });
    expect(seen).toEqual(['solo']);
    expect(getRateLimitSampleRows()).toHaveLength(2);
    expect(getCredentialSlot('claude')).toBeUndefined();
  });

  it('never throws when the fetch implementation itself throws synchronously', async () => {
    const fetchImpl = (() => {
      throw new Error('fetch is broken');
    }) as unknown as typeof fetch;
    const p = new ClaudeProvider({ env: RING });
    await expect(p.pickCredentialSlotByUsage({ fetchImpl, timeoutMs: 1000 })).resolves.toBeUndefined();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(savedToken);
  });
});
