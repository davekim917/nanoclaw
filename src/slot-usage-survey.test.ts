/**
 * The property under test is REQUEST VOLUME, not the shape of the cache.
 *
 * #811's survey ran inside the container, once per boot, so every token saw
 * one `/api/oauth/usage` request per Claude session start — ~25/hour on this
 * fleet, bursting 4-8 in a minute, and the endpoint answered 429 for every
 * slot at once with `retry-after: 3166`. The fix is only a fix if the number
 * of requests a token sees is a function of TIME, not of how many containers
 * start. So the headline test drives many spawns through the production seam
 * with a counting fetch and asserts the count, against the count the old code
 * would have produced.
 */
import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from './log.js';
import {
  SLOT_USAGE_429_DEFAULT_BACKOFF_MS,
  SLOT_USAGE_429_MAX_BACKOFF_MS,
  SLOT_USAGE_SURVEY_MIN_INTERVAL_MS,
  _resetSlotUsageSurveyForTesting,
  credentialFingerprint,
  encodeSlotUsageSurvey,
  fetchSlotUsage,
  parseRetryAfterMs,
  refreshSlotUsageSurvey,
  ringSlotsForSurvey,
  slotUsageSurveyForSpawn,
} from './slot-usage-survey.js';

const RING = [
  { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok-1' },
  { name: 'CLAUDE_CODE_OAUTH_TOKEN_2', value: 'tok-2' },
  { name: 'CLAUDE_CODE_OAUTH_TOKEN_3', value: 'tok-3' },
  { name: 'CLAUDE_CODE_OAUTH_TOKEN_4', value: 'tok-4' },
  { name: 'CLAUDE_CODE_OAUTH_TOKEN_5', value: 'tok-5' },
  { name: 'CLAUDE_CODE_OAUTH_TOKEN_6', value: 'tok-6' },
];

const win = (utilization: number, resets_at = '2026-09-22T00:00:00Z') => ({ utilization, resets_at });

function okBody(seven: number) {
  return { five_hour: win(3), seven_day: win(seven), limits: [], extra_usage: { is_enabled: false } };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Counts every request and reports which bearer it was made with. */
function countingFetch(reply: (token: string) => Response) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).Authorization;
    const token = auth.replace(/^Bearer /, '');
    calls.push(token);
    return reply(token);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(() => {
  _resetSlotUsageSurveyForTesting();
  vi.restoreAllMocks();
});

describe('request volume is a function of time, not of spawn count', () => {
  it('holds one pull per slot per interval across a burst of spawns', async () => {
    const { fetchImpl, calls } = countingFetch(() => jsonResponse(okBody(80)));
    // 30 minutes of fleet time, a spawn every 30 seconds — 60 spawns, which is
    // heavier than this fleet's real ~25/hour, and includes minutes with
    // several spawns back to back.
    const start = Date.parse('2026-09-15T05:00:00.000Z');
    const spawns = 60;
    const stepMs = 30_000;
    let clock = start;
    for (let i = 0; i < spawns; i += 1) {
      const now = () => clock;
      const { refreshed } = slotUsageSurveyForSpawn('global', RING, { fetchImpl, now });
      await refreshed;
      clock += stepMs;
    }

    const elapsedMs = stepMs * (spawns - 1);
    const rounds = Math.floor(elapsedMs / SLOT_USAGE_SURVEY_MIN_INTERVAL_MS) + 1;
    expect(calls).toHaveLength(RING.length * rounds);
    // What #811 did: one pull per slot per spawn.
    expect(calls.length).toBeLessThan(RING.length * spawns);
    expect(RING.length * spawns).toBe(360);
    // Pinned literally so tuning SLOT_USAGE_SURVEY_MIN_INTERVAL_MS is a visible
    // decision: 6 slots x 3 rounds in 29.5 minutes, against #811's 360.
    expect(calls).toHaveLength(18);

    // Every slot was pulled the same number of times — no slot starves.
    const perToken = new Map<string, number>();
    for (const token of calls) perToken.set(token, (perToken.get(token) ?? 0) + 1);
    expect([...perToken.values()]).toEqual(Array(RING.length).fill(rounds));
  });

  it('serves a complete survey to every spawn after the first, without pulling again', async () => {
    const seven: Record<string, number> = {
      'tok-1': 76,
      'tok-2': 87,
      'tok-3': 21,
      'tok-4': 99,
      'tok-5': 40,
      'tok-6': 18,
    };
    const { fetchImpl, calls } = countingFetch((token) => jsonResponse(okBody(seven[token]!)));
    let clock = Date.parse('2026-09-15T05:00:00.000Z');
    const now = () => clock;

    const first = slotUsageSurveyForSpawn('global', RING, { fetchImpl, now });
    expect(first.survey).toEqual({}); // cold host: nothing to hand over yet
    await first.refreshed;
    expect(calls).toHaveLength(6);

    // Five more spawns inside the interval: complete survey, zero new requests.
    for (let i = 0; i < 5; i += 1) {
      clock += 45_000;
      const { survey, refreshed } = slotUsageSurveyForSpawn('global', RING, { fetchImpl, now });
      await refreshed;
      expect(Object.keys(survey).sort()).toEqual(RING.map((s) => s.name).sort());
      expect(survey.CLAUDE_CODE_OAUTH_TOKEN_2!.rateLimits.seven_day!.utilization).toBe(87);
      expect(survey.CLAUDE_CODE_OAUTH_TOKEN_4!.rateLimits.seven_day!.utilization).toBe(99);
    }
    expect(calls).toHaveLength(6);
  });

  it('keys the interval per credential set, so one set cannot starve another', async () => {
    const { fetchImpl, calls } = countingFetch(() => jsonResponse(okBody(50)));
    const now = () => Date.parse('2026-09-15T05:00:00.000Z');
    // Same slot NAMES, different accounts.
    const setA = [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'global-1' }];
    const setB = [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'scoped-1' }];
    await slotUsageSurveyForSpawn('global', setA, { fetchImpl, now }).refreshed;
    await slotUsageSurveyForSpawn('group:scoped-example', setB, { fetchImpl, now }).refreshed;
    expect(calls).toEqual(['global-1', 'scoped-1']);
    expect(slotUsageSurveyForSpawn('global', setA, { fetchImpl, now }).survey.CLAUDE_CODE_OAUTH_TOKEN).toBeDefined();
    // And the reading does not bleed across sets.
    _resetSlotUsageSurveyForTesting();
    await slotUsageSurveyForSpawn('global', setA, { fetchImpl, now }).refreshed;
    expect(slotUsageSurveyForSpawn('group:scoped-example', setB, { fetchImpl, now }).survey).toEqual({});
  });
});

describe('429 handling', () => {
  it('parks a slot for the window the server named and resumes after it', async () => {
    let status = 429;
    const { fetchImpl, calls } = countingFetch(() =>
      status === 429
        ? jsonResponse({ error: { type: 'rate_limit_error' } }, 429, { 'retry-after': '3166' })
        : jsonResponse(okBody(70)),
    );
    let clock = Date.parse('2026-09-15T05:00:00.000Z');
    const now = () => clock;
    const slots = [RING[0]!];

    await refreshSlotUsageSurvey('global', slots, { fetchImpl, now });
    expect(calls).toHaveLength(1);

    // The ordinary interval passing is NOT enough — the park outlives it.
    clock += SLOT_USAGE_SURVEY_MIN_INTERVAL_MS * 3;
    await refreshSlotUsageSurvey('global', slots, { fetchImpl, now });
    expect(calls).toHaveLength(1);

    // One second past the server's own window, one request, and it takes.
    status = 200;
    clock = Date.parse('2026-09-15T05:00:00.000Z') + 3166_000 + 1000;
    await refreshSlotUsageSurvey('global', slots, { fetchImpl, now });
    expect(calls).toHaveLength(2);
    const { survey } = slotUsageSurveyForSpawn('global', slots, { fetchImpl, now });
    expect(survey.CLAUDE_CODE_OAUTH_TOKEN!.rateLimits.seven_day!.utilization).toBe(70);
  });

  it('backs off for the default window when the 429 carries no usable retry-after', async () => {
    const { fetchImpl, calls } = countingFetch(() => jsonResponse({}, 429, { 'retry-after': 'soon' }));
    let clock = Date.parse('2026-09-15T05:00:00.000Z');
    const now = () => clock;
    const slots = [RING[0]!];
    await refreshSlotUsageSurvey('global', slots, { fetchImpl, now });
    clock += SLOT_USAGE_429_DEFAULT_BACKOFF_MS - 1000;
    await refreshSlotUsageSurvey('global', slots, { fetchImpl, now });
    expect(calls).toHaveLength(1);
    clock += 2000;
    await refreshSlotUsageSurvey('global', slots, { fetchImpl, now });
    expect(calls).toHaveLength(2);
  });

  // anthropics/claude-code#30930 reports this endpoint answering 429 with
  // `retry-after: 0`, and #31637 reports pollers that then loop on 429 forever.
  // Zero is not permission to retry now. Mutation-checked, and the result is
  // worth recording: it is the ORDINARY interval guard (lastAttemptAt, advanced
  // before the await) that holds this, not the Math.max clamp on the backoff —
  // removing the clamp leaves this test green. The clamp is belt; the floor is
  // braces. The clamp's own bite is the Math.min case below.
  it('does not retry immediately on retry-after: 0 — the floor is the ordinary interval', async () => {
    const { fetchImpl, calls } = countingFetch(() => jsonResponse({}, 429, { 'retry-after': '0' }));
    let clock = Date.parse('2026-09-15T05:00:00.000Z');
    const now = () => clock;
    const slots = [RING[0]!];
    await refreshSlotUsageSurvey('global', slots, { fetchImpl, now });
    clock += 1000;
    await refreshSlotUsageSurvey('global', slots, { fetchImpl, now });
    expect(calls).toHaveLength(1);
    clock += SLOT_USAGE_SURVEY_MIN_INTERVAL_MS;
    await refreshSlotUsageSurvey('global', slots, { fetchImpl, now });
    expect(calls).toHaveLength(2);
  });

  it('clamps an absurd retry-after so a slot cannot be parked forever', async () => {
    const { fetchImpl, calls } = countingFetch(() => jsonResponse({}, 429, { 'retry-after': String(365 * 24 * 3600) }));
    let clock = Date.parse('2026-09-15T05:00:00.000Z');
    const now = () => clock;
    const slots = [RING[0]!];
    await refreshSlotUsageSurvey('global', slots, { fetchImpl, now });
    clock += SLOT_USAGE_429_MAX_BACKOFF_MS + 1000;
    await refreshSlotUsageSurvey('global', slots, { fetchImpl, now });
    expect(calls).toHaveLength(2);
  });

  it('parks only the rate-limited slot, and the rest of the ring keeps reporting', async () => {
    const { fetchImpl } = countingFetch((token) =>
      token === 'tok-2' ? jsonResponse({}, 429, { 'retry-after': '3166' }) : jsonResponse(okBody(60)),
    );
    const now = () => Date.parse('2026-09-15T05:00:00.000Z');
    await refreshSlotUsageSurvey('global', RING, { fetchImpl, now });
    const { survey } = slotUsageSurveyForSpawn('global', RING, { fetchImpl, now });
    expect(Object.keys(survey).sort()).toEqual(
      RING.filter((s) => s.value !== 'tok-2')
        .map((s) => s.name)
        .sort(),
    );
  });

  it('parseRetryAfterMs reads seconds and HTTP-dates, and refuses anything else', () => {
    const now = Date.parse('2026-09-15T05:00:00.000Z');
    expect(parseRetryAfterMs('3166', now)).toBe(3166_000);
    expect(parseRetryAfterMs('0', now)).toBe(0);
    expect(parseRetryAfterMs('Tue, 15 Sep 2026 05:10:00 GMT', now)).toBe(600_000);
    expect(parseRetryAfterMs('Tue, 15 Sep 2026 04:00:00 GMT', now)).toBe(0); // already past
    expect(parseRetryAfterMs('soon', now)).toBeNull();
    expect(parseRetryAfterMs('', now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
    // V8 reads `-5` as a real date in 2001, which would decode as "window
    // already over" and let a rate-limited slot be retried at once.
    expect(parseRetryAfterMs('-5', now)).toBeNull();
    expect(parseRetryAfterMs('+5', now)).toBeNull();
    expect(parseRetryAfterMs('1.5', now)).toBeNull();
  });
});

describe('failures never escape and never carry the credential', () => {
  it('never lets the fetch layer’s message — which can quote the Authorization header — reach a log (PR #811 F1)', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const fetchImpl = (async () => {
      throw new TypeError('Headers.append: "Bearer sk-live-SECRET" is an invalid header value');
    }) as unknown as typeof fetch;
    const now = () => Date.parse('2026-09-15T05:00:00.000Z');
    await refreshSlotUsageSurvey('global', [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'sk-live-SECRET' }], {
      fetchImpl,
      now,
    });
    expect(warn).toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('SECRET');
    expect(logged).toContain('TypeError');
  });

  it('sanitizes a body-parse failure the same way', async () => {
    const fetchImpl = (async () =>
      new Response('not json sk-live-SECRET', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    await expect(fetchSlotUsage('sk-live-SECRET', { fetchImpl, timeoutMs: 1000 })).rejects.toThrow(
      /^usage pull body unreadable: \w+$/,
    );
  });

  it('rejects a non-2xx by status alone', async () => {
    const fetchImpl = (async () => jsonResponse({ error: 'unauthorized' }, 401)) as unknown as typeof fetch;
    await expect(fetchSlotUsage('bad', { fetchImpl, timeoutMs: 1000 })).rejects.toThrow('usage pull HTTP 401');
  });

  it('aborts a hung pull at the deadline instead of holding a slot open', async () => {
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    await expect(fetchSlotUsage('t', { fetchImpl, timeoutMs: 20 })).rejects.toThrow(
      'usage pull transport error: Error',
    );
  });

  it('survives a fetch that throws synchronously, and still hands the spawn a survey', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const fetchImpl = (() => {
      throw new Error('fetch is broken');
    }) as unknown as typeof fetch;
    const now = () => Date.parse('2026-09-15T05:00:00.000Z');
    const { survey, refreshed } = slotUsageSurveyForSpawn('global', RING, { fetchImpl, now });
    await expect(refreshed).resolves.toBeUndefined();
    expect(survey).toEqual({});
    expect(encodeSlotUsageSurvey(survey)).toBe('{}');
  });

  it('keeps the last good reading when a later pull fails, and retries on the ordinary interval', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    let healthy = true;
    const { fetchImpl, calls } = countingFetch(() => (healthy ? jsonResponse(okBody(88)) : jsonResponse({}, 500)));
    let clock = Date.parse('2026-09-15T05:00:00.000Z');
    const now = () => clock;
    const slots = [RING[0]!];
    await refreshSlotUsageSurvey('global', slots, { fetchImpl, now });

    healthy = false;
    clock += SLOT_USAGE_SURVEY_MIN_INTERVAL_MS + 1000;
    await refreshSlotUsageSurvey('global', slots, { fetchImpl, now });
    expect(calls).toHaveLength(2);
    const { survey } = slotUsageSurveyForSpawn('global', slots, { fetchImpl, now });
    // A 500 is not evidence that the old number is wrong — it is still served,
    // and the consumer ages it out on its own clock.
    expect(survey.CLAUDE_CODE_OAUTH_TOKEN!.rateLimits.seven_day!.utilization).toBe(88);
  });
});

describe('fetchSlotUsage shapes the payload the container will receive', () => {
  it('keeps only windows carrying a numeric utilization, and stamps the request the CLI way', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return jsonResponse({
        five_hour: win(12),
        seven_day: win(87),
        limits: [],
        extra_usage: { is_enabled: false },
        opus: { utilization: null },
      });
    }) as unknown as typeof fetch;

    const windows = await fetchSlotUsage('tok-2', { fetchImpl, timeoutMs: 1000 });
    expect(seen[0]!.url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(seen[0]!.init.method).toBe('GET');
    expect(seen[0]!.init.headers).toMatchObject({
      Authorization: 'Bearer tok-2',
      'anthropic-beta': 'oauth-2025-04-20',
    });
    expect(Object.keys(windows).sort()).toEqual(['five_hour', 'seven_day']);
    expect(windows.seven_day).toEqual({ utilization: 87, resets_at: '2026-09-22T00:00:00Z' });
  });

  it('records an empty window map rather than failing when the plan reports nothing', async () => {
    const fetchImpl = (async () => jsonResponse({ limits: [] })) as unknown as typeof fetch;
    const now = () => Date.parse('2026-09-15T05:00:00.000Z');
    await refreshSlotUsageSurvey('global', [RING[0]!], { fetchImpl, now });
    const { survey } = slotUsageSurveyForSpawn('global', [RING[0]!], { fetchImpl, now });
    expect(survey.CLAUDE_CODE_OAUTH_TOKEN).toEqual({
      fetchedAt: '2026-09-15T05:00:00.000Z',
      rateLimits: {},
    });
  });
});

/**
 * The survey is only useful if it names the slots the RUNNER will actually
 * have in its ring. This mirrors `ClaudeProvider`'s constructor
 * (`container/agent-runner/src/providers/claude.ts:2224-2231`) — a name the
 * ring does not carry is a wasted request against a rate-limited endpoint,
 * and a ring slot the survey omits cannot be ranked.
 */
describe('ringSlotsForSurvey mirrors the ring the runner builds', () => {
  it('puts the primary first and the numbered fallbacks after it, in index order', () => {
    expect(
      ringSlotsForSurvey('p', [
        { index: 5, value: 'e' },
        { index: 2, value: 'b' },
        { index: 10, value: 'j' },
      ]),
    ).toEqual([
      { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'p' },
      { name: 'CLAUDE_CODE_OAUTH_TOKEN_2', value: 'b' },
      { name: 'CLAUDE_CODE_OAUTH_TOKEN_5', value: 'e' },
      { name: 'CLAUDE_CODE_OAUTH_TOKEN_10', value: 'j' },
    ]);
  });

  it('drops a duplicate VALUE, keeping the first name — the ring visits it once', () => {
    expect(
      ringSlotsForSurvey('p', [
        { index: 2, value: 'p' },
        { index: 3, value: 'c' },
      ]).map((s) => s.name),
    ).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_3']);
  });

  it('refuses the OneCLI placeholder sentinel and an empty slot', () => {
    expect(ringSlotsForSurvey('placeholder', [{ index: 2, value: 'b' }])).toEqual([]);
    expect(ringSlotsForSurvey(undefined, [{ index: 2, value: 'b' }])).toEqual([]);
    expect(
      ringSlotsForSurvey('p', [
        { index: 2, value: 'placeholder' },
        { index: 3, value: '' },
      ]),
    ).toEqual([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'p' }]);
  });
});

/**
 * The host writes `NANOCLAW_SLOT_USAGE_SURVEY` and the agent-runner parses it,
 * and the two live in different package trees that cannot import each other
 * (Node/pnpm vs Bun). A fixture each side asserts against is the only thing
 * that can catch one of them changing shape — #817's lesson, where a wire shape
 * verified only against the code's own belief passed every test and failed in
 * production. This half pins what the host PRODUCES; the matching half, which
 * pins what the runner makes of it, is the fixture describe in
 * `container/agent-runner/src/providers/claude-slot-pick.test.ts`.
 *
 * If you change the payload shape, both halves must be updated in the same PR
 * or one of them goes red.
 */
describe('the host/runner survey wire shape', () => {
  const fixturePath = path.join(
    import.meta.dirname,
    '..',
    'container',
    'agent-runner',
    'src',
    'providers',
    'slot-usage-survey.fixture.json',
  );

  it('produces exactly the payload the runner-side fixture describes', async () => {
    const fetchedAt = Date.parse('2026-09-15T06:00:00.000Z');
    const now = () => fetchedAt;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const token = (init?.headers as Record<string, string>).Authorization.replace(/^Bearer /, '');
      // slot 1: two real windows plus the non-window keys the endpoint returns.
      if (token === 'tok-1') {
        return jsonResponse({
          five_hour: { utilization: 12, resets_at: '2026-09-15T10:00:00Z' },
          seven_day: { utilization: 87, resets_at: '2026-09-22T00:00:00Z' },
          limits: [],
          extra_usage: { is_enabled: false },
        });
      }
      // slot 3: a plan that reports no numeric window at all.
      return jsonResponse({ limits: [] });
    }) as unknown as typeof fetch;

    await refreshSlotUsageSurvey(
      'global',
      [
        { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok-1' },
        { name: 'CLAUDE_CODE_OAUTH_TOKEN_3', value: 'tok-3' },
      ],
      { fetchImpl, now },
    );
    const { survey } = slotUsageSurveyForSpawn(
      'global',
      [
        { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok-1' },
        { name: 'CLAUDE_CODE_OAUTH_TOKEN_3', value: 'tok-3' },
      ],
      { fetchImpl, now },
    );

    const encoded = encodeSlotUsageSurvey(survey);
    expect(JSON.parse(encoded)).toEqual(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
  });
});

/**
 * A cached reading is evidence about a CREDENTIAL. The spawn path re-reads
 * `.env` every spawn so an operator's slot edit takes effect on the next
 * respawn (`src/container-runner.ts`, the `readEnvFileMatching` argument to
 * `resolveAnthropicAuth`), which means the account behind a slot NAME can
 * change with nothing else changing. A reading that outlives its credential is
 * worse than no reading: it ranks the new account on the old one's numbers and
 * files the old one's utilization against the new one's slot. PR #821 review r1.
 */
describe('a reading does not outlive the credential it describes', () => {
  const SLOT = 'CLAUDE_CODE_OAUTH_TOKEN_2';
  const OTHER = 'CLAUDE_CODE_OAUTH_TOKEN';

  it('the exact reported sequence: cache A at 90%, swap in exhausted B, next spawn must not pick B on A’s number', async () => {
    let clock = Date.parse('2026-09-15T05:00:00.000Z');
    const now = () => clock;
    // `_1` sits at 40%; `_2` holds account A at 90%.
    const { fetchImpl, calls } = countingFetch((token) => {
      if (token === 'tok-1') return jsonResponse(okBody(40));
      if (token === 'account-A') return jsonResponse(okBody(90));
      return jsonResponse(okBody(99)); // account B, effectively exhausted
    });

    const before = [
      { name: OTHER, value: 'tok-1' },
      { name: SLOT, value: 'account-A' },
    ];
    await slotUsageSurveyForSpawn('global', before, { fetchImpl, now }).refreshed;
    expect(
      slotUsageSurveyForSpawn('global', before, { fetchImpl, now }).survey[SLOT]!.rateLimits.seven_day!.utilization,
    ).toBe(90);

    // A minute later the operator replaces `_2`'s token with account B. The
    // reading is a minute old — the age guard cannot see anything wrong.
    clock += 60_000;
    const after = [
      { name: OTHER, value: 'tok-1' },
      { name: SLOT, value: 'account-B' },
    ];
    const { survey } = slotUsageSurveyForSpawn('global', after, { fetchImpl, now });

    // The consequence that matters: nothing is handed over for that slot, so
    // the pick cannot rank B on A's 90% (and cannot record A's number as B's).
    expect(survey[SLOT]).toBeUndefined();
    expect(Object.keys(survey)).toEqual([OTHER]);
    expect(survey[OTHER]!.rateLimits.seven_day!.utilization).toBe(40);
    // And the entry we did hand over is the one whose credential is unchanged.
    expect(calls).toEqual(['tok-1', 'account-A']);
  });

  it('gives the replacement a clean slate: the old account’s interval does not silence the new one', async () => {
    let clock = Date.parse('2026-09-15T05:00:00.000Z');
    const now = () => clock;
    const { fetchImpl, calls } = countingFetch(() => jsonResponse(okBody(50)));
    const slots = (value: string) => [{ name: SLOT, value }];

    await refreshSlotUsageSurvey('global', slots('account-A'), { fetchImpl, now });
    expect(calls).toEqual(['account-A']);

    // Well inside the interval — for account A this would be refused.
    clock += 60_000;
    await refreshSlotUsageSurvey('global', slots('account-A'), { fetchImpl, now });
    expect(calls).toEqual(['account-A']);

    // A different credential is a different rate-limit identity, so it gets its
    // own budget rather than inheriting A's cooldown.
    await refreshSlotUsageSurvey('global', slots('account-B'), { fetchImpl, now });
    expect(calls).toEqual(['account-A', 'account-B']);
    expect(slotUsageSurveyForSpawn('global', slots('account-B'), { fetchImpl, now }).survey[SLOT]).toBeDefined();
  });

  it('does not make the replacement serve the old account’s 429 park', async () => {
    let clock = Date.parse('2026-09-15T05:00:00.000Z');
    const now = () => clock;
    const { fetchImpl, calls } = countingFetch((token) =>
      token === 'account-A' ? jsonResponse({}, 429, { 'retry-after': '3166' }) : jsonResponse(okBody(30)),
    );
    await refreshSlotUsageSurvey('global', [{ name: SLOT, value: 'account-A' }], { fetchImpl, now });
    expect(calls).toEqual(['account-A']);

    clock += 5_000;
    await refreshSlotUsageSurvey('global', [{ name: SLOT, value: 'account-B' }], { fetchImpl, now });
    expect(calls).toEqual(['account-A', 'account-B']);
    expect(
      slotUsageSurveyForSpawn('global', [{ name: SLOT, value: 'account-B' }], { fetchImpl, now }).survey[SLOT]!
        .rateLimits.seven_day!.utilization,
    ).toBe(30);
  });

  it('an in-flight pull that resolves after the swap publishes under its OWN credential, never the new one', async () => {
    const clock = Date.parse('2026-09-15T05:00:00.000Z');
    const now = () => clock;
    let releaseA: ((r: Response) => void) | null = null;
    const seen: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const token = (init?.headers as Record<string, string>).Authorization.replace(/^Bearer /, '');
      seen.push(token);
      if (token === 'account-A') return new Promise<Response>((resolve) => (releaseA = resolve));
      return jsonResponse(okBody(30));
    }) as unknown as typeof fetch;

    // A's pull is started and left hanging.
    const pass = refreshSlotUsageSurvey('global', [{ name: SLOT, value: 'account-A' }], { fetchImpl, now });
    await Promise.resolve();
    expect(seen).toEqual(['account-A']);

    // `.env` is swapped mid-flight; A's answer only arrives afterwards.
    releaseA!(jsonResponse(okBody(90)));
    await pass;

    // B must see nothing: A's 90% did land in the cache, but under A's
    // fingerprint, so the reader holding B's token finds no match.
    const afterSwap = slotUsageSurveyForSpawn('global', [{ name: SLOT, value: 'account-B' }], { fetchImpl, now });
    expect(afterSwap.survey[SLOT]).toBeUndefined();
    await afterSwap.refreshed;

    // The documented trade-off of one entry per slot: B's pass displaced A's
    // reading, so flipping back to A costs one fresh pull rather than serving a
    // mismatch. Cheap, and it keeps the map from growing an entry per token
    // ever seen.
    const backToA = slotUsageSurveyForSpawn('global', [{ name: SLOT, value: 'account-A' }], { fetchImpl, now });
    expect(backToA.survey[SLOT]).toBeUndefined();
    expect(seen).toEqual(['account-A', 'account-B', 'account-A']);
  });

  it('never lets the token itself become a fingerprint, a key, or a log line', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const TOKEN = 'sk-ant-oat01-SECRETVALUE';
    const fp = credentialFingerprint(TOKEN);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain('SECRET');
    expect(TOKEN).not.toContain(fp);
    // Same input, same handle; different input, different handle.
    expect(credentialFingerprint(TOKEN)).toBe(fp);
    expect(credentialFingerprint(TOKEN + 'x')).not.toBe(fp);

    // Drive both a success and a failure and scrape everything they emit.
    const fetchImpl = (async () => {
      throw new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value`);
    }) as unknown as typeof fetch;
    const now = () => Date.parse('2026-09-15T05:00:00.000Z');
    await refreshSlotUsageSurvey('global', [{ name: SLOT, value: TOKEN }], { fetchImpl, now });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('SECRET');
    expect(logged).not.toContain(fp);

    // …and nothing the container is handed carries either.
    const { survey } = slotUsageSurveyForSpawn('global', [{ name: SLOT, value: TOKEN }], { fetchImpl, now });
    const encoded = encodeSlotUsageSurvey(survey);
    expect(encoded).not.toContain('SECRET');
    expect(encoded).not.toContain(fp);
  });
});
