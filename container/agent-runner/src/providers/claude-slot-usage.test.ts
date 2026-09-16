/**
 * Per-slot OAuth plan-utilization telemetry at session start — and the proof
 * that it never picks the credential (slots run in numbered order).
 *
 * Fixtures are raw `/api/oauth/usage` bodies (utilization 0-100) as the CLI
 * passes them through to `get_usage`'s `rate_limits`. The runner makes NO
 * network call any more — the host surveys and hands the readings over in
 * `NANOCLAW_SLOT_USAGE_SURVEY` (see `src/slot-usage-survey.ts` and its test,
 * which is where request volume is pinned).
 */
import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ClaudeProvider, usageResponseToSamples } from './claude.js';
import {
  SLOT_USAGE_SURVEY_ENV,
  SLOT_USAGE_SURVEY_MAX_AGE_MS,
  parseSlotUsageSurvey,
  surveyEntryToUsageResponse,
} from './claude-slot-usage.js';
import { getRateLimitSampleRows } from '../modules/mailbox/index.js';
import { getCredentialSlot, setCredentialSlot } from '../modules/mailbox/session-state.js';
import { initTestSessionDb } from '../modules/mailbox/testing.js';
import { getOutboundDb } from '../mailbox/sqlite/connection.js';

const WHO = { account: 'x', credentialSet: null, lane: null };

const win = (utilization: number, resets_at = '2026-09-17T00:00:00Z') => ({ utilization, resets_at });

describe('parseSlotUsageSurvey — reading what the host handed over', () => {
  const now = Date.parse('2026-09-15T06:00:00.000Z');
  const entry = (fetchedAt: string, seven: number) => ({
    fetchedAt,
    rateLimits: { five_hour: win(4), seven_day: win(seven) },
  });

  it('keeps a fresh reading and hands it over in the shape usageResponseToSamples consumes', () => {
    const parsed = parseSlotUsageSurvey(
      JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN_2: entry('2026-09-15T05:58:00.000Z', 87) }),
      { now },
    );
    expect(parsed.problem).toBeNull();
    expect(parsed.staleSlots).toEqual([]);
    const rows = usageResponseToSamples(surveyEntryToUsageResponse(parsed.fresh.CLAUDE_CODE_OAUTH_TOKEN_2!), WHO);
    // 0-100 in the payload, 0-1 in storage — one normalization seam, unchanged.
    expect(rows.find((r) => r.limitType === 'seven_day')!.utilization).toBeCloseTo(0.87);
    expect(rows.find((r) => r.limitType === 'seven_day')!.resetsAt).toBe('2026-09-17T00:00:00Z');
  });

  it('drops a reading older than the max age rather than recording it', () => {
    const old = new Date(now - SLOT_USAGE_SURVEY_MAX_AGE_MS - 1000).toISOString();
    const fresh = new Date(now - 60_000).toISOString();
    const parsed = parseSlotUsageSurvey(
      JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: entry(old, 91), CLAUDE_CODE_OAUTH_TOKEN_2: entry(fresh, 40) }),
      { now },
    );
    expect(Object.keys(parsed.fresh)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN_2']);
    expect(parsed.staleSlots).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
  });

  it('is total: every malformed shape yields no reading and no throw', () => {
    const cases: Array<string | undefined> = [undefined, '', '{nope', '[]', '7', 'null'];
    for (const raw of cases) {
      const parsed = parseSlotUsageSurvey(raw, { now });
      expect(parsed.fresh).toEqual({});
      expect(parsed.problem).toBeTruthy();
    }
    // Per-slot junk is skipped without poisoning its neighbours.
    const mixed = parseSlotUsageSurvey(
      JSON.stringify({
        A: null,
        B: { fetchedAt: 42, rateLimits: {} },
        C: { fetchedAt: 'not-a-date', rateLimits: {} },
        D: { fetchedAt: '2026-09-15T05:59:00.000Z', rateLimits: 'nope' },
        E: entry('2026-09-15T05:59:00.000Z', 55),
      }),
      { now },
    );
    expect(Object.keys(mixed.fresh)).toEqual(['E']);
    expect(mixed.problem).toBeNull();
  });

  it('never echoes the variable’s contents into the problem string', () => {
    const parsed = parseSlotUsageSurvey('{"leaked":"sk-live-SECRET"', { now });
    expect(parsed.problem).toBe('NANOCLAW_SLOT_USAGE_SURVEY is not JSON');
    expect(parsed.problem).not.toContain('SECRET');
  });

  it('keeps only windows carrying a numeric utilization', () => {
    const parsed = parseSlotUsageSurvey(
      JSON.stringify({
        A: {
          fetchedAt: '2026-09-15T05:59:00.000Z',
          rateLimits: { seven_day: win(70), opus: { utilization: null }, limits: [], nope: 'x' },
        },
      }),
      { now },
    );
    expect(Object.keys(parsed.fresh.A!.rateLimits)).toEqual(['seven_day']);
  });
});

describe('ClaudeProvider.recordSlotUsageSurvey — telemetry, never selection', () => {
  const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const savedSet = process.env.NANOCLAW_OAUTH_CREDENTIAL_SET;
  const savedLanes = process.env.CLAUDE_CODE_OAUTH_LANES;
  const savedSurvey = process.env[SLOT_USAGE_SURVEY_ENV];

  beforeEach(() => {
    initTestSessionDb();
    delete process.env.NANOCLAW_OAUTH_CREDENTIAL_SET;
    delete process.env.CLAUDE_CODE_OAUTH_LANES;
    delete process.env[SLOT_USAGE_SURVEY_ENV];
  });
  afterEach(() => {
    const restore = (k: string, v: string | undefined) =>
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    restore('CLAUDE_CODE_OAUTH_TOKEN', savedToken);
    restore('NANOCLAW_OAUTH_CREDENTIAL_SET', savedSet);
    restore('CLAUDE_CODE_OAUTH_LANES', savedLanes);
    restore(SLOT_USAGE_SURVEY_ENV, savedSurvey);
  });

  const RING = {
    CLAUDE_CODE_OAUTH_TOKEN: 'tok-1',
    CLAUDE_CODE_OAUTH_TOKEN_2: 'tok-2',
    CLAUDE_CODE_OAUTH_TOKEN_3: 'tok-3',
  };

  const NOW = Date.parse('2026-09-15T06:00:00.000Z');

  /** Publish a survey the way the host's spawn push does. */
  function publishSurvey(bySlot: Record<string, Record<string, unknown> | null>, ageMs = 60_000) {
    const fetchedAt = new Date(NOW - ageMs).toISOString();
    const payload: Record<string, unknown> = {};
    for (const [slot, rateLimits] of Object.entries(bySlot)) {
      if (rateLimits === null) continue; // a slot the host could not read: simply absent
      payload[slot] = { fetchedAt, rateLimits };
    }
    process.env[SLOT_USAGE_SURVEY_ENV] = JSON.stringify(payload);
  }

  it('records a usage_pull row per slot per window and leaves the ring on slot 1', () => {
    process.env.NANOCLAW_OAUTH_CREDENTIAL_SET = 'group:example';
    process.env.CLAUDE_CODE_OAUTH_LANES = '1:agentic-primary,3:shared-dev';
    // _2 is the most used and slot 1 is not — usage must not matter.
    publishSurvey({
      CLAUDE_CODE_OAUTH_TOKEN: { five_hour: win(10), seven_day: win(76) },
      CLAUDE_CODE_OAUTH_TOKEN_2: { five_hour: win(40), seven_day: win(87) },
      CLAUDE_CODE_OAUTH_TOKEN_3: { five_hour: win(5), seven_day: win(21) },
    });
    const p = new ClaudeProvider({ env: RING });
    p.recordSlotUsageSurvey({ now: NOW });

    expect(getCredentialSlot('claude')).toBeUndefined();

    const rows = getRateLimitSampleRows();
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(['usage_pull']));
    expect(rows.every((r) => r.credential_set === 'group:example')).toBe(true);
    const sevenDay = Object.fromEntries(
      rows.filter((r) => r.limit_type === 'seven_day').map((r) => [r.account, r.utilization]),
    );
    expect(sevenDay).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 0.76,
      CLAUDE_CODE_OAUTH_TOKEN_2: 0.87,
      CLAUDE_CODE_OAUTH_TOKEN_3: 0.21,
    });
    const lanes = Object.fromEntries(rows.map((r) => [r.account, r.lane]));
    expect(lanes).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'agentic-primary',
      CLAUDE_CODE_OAUTH_TOKEN_2: null,
      CLAUDE_CODE_OAUTH_TOKEN_3: 'shared-dev',
    });
    expect(rows.every((r) => /^\d{4}-\d{2}-\d{2}T.*Z$/.test(r.ts))).toBe(true);

    // A wall on slot 1 moves to the next NUMBER, not the most-used slot.
    p.resetRotationCycle();
    expect(p.rotateApiKey()).toMatchObject({ rotated: true, slot: 'CLAUDE_CODE_OAUTH_TOKEN_2', position: 2 });
    expect(p.rotateApiKey()).toMatchObject({ rotated: true, slot: 'CLAUDE_CODE_OAUTH_TOKEN_3', position: 3 });
  });

  it('on resume, keeps the restored slot whatever the survey says', () => {
    setCredentialSlot('claude', 'CLAUDE_CODE_OAUTH_TOKEN_3'); // a previous container ended here
    publishSurvey({
      CLAUDE_CODE_OAUTH_TOKEN: { five_hour: win(1), seven_day: win(90) },
      CLAUDE_CODE_OAUTH_TOKEN_2: { five_hour: win(1), seven_day: win(30) },
      CLAUDE_CODE_OAUTH_TOKEN_3: { five_hour: win(1), seven_day: win(10) },
    });
    const p = new ClaudeProvider({ env: RING });
    p.restorePersistedCredentialSlot();
    p.recordSlotUsageSurvey({ now: NOW });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-3');
    expect(getCredentialSlot('claude')).toBe('CLAUDE_CODE_OAUTH_TOKEN_3');
    expect(getRateLimitSampleRows()).toHaveLength(6);
  });

  it('ignores a slot the retired usage pick persisted under the old key', () => {
    getOutboundDb()
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('credential_slot:claude', 'CLAUDE_CODE_OAUTH_TOKEN_3', new Date().toISOString());
    const p = new ClaudeProvider({ env: RING });
    p.restorePersistedCredentialSlot();
    expect(getCredentialSlot('claude')).toBeUndefined();
    p.resetRotationCycle();
    expect(p.rotateApiKey()).toMatchObject({ slot: 'CLAUDE_CODE_OAUTH_TOKEN_2' }); // was on slot 1
  });

  it('records nothing when the host has published nothing yet', () => {
    process.env[SLOT_USAGE_SURVEY_ENV] = '{}';
    const p = new ClaudeProvider({ env: RING });
    p.recordSlotUsageSurvey({ now: NOW });
    expect(getRateLimitSampleRows()).toHaveLength(0);
  });

  it('records nothing when the variable is missing entirely', () => {
    const p = new ClaudeProvider({ env: RING });
    p.recordSlotUsageSurvey({ now: NOW });
    expect(getRateLimitSampleRows()).toHaveLength(0);
  });

  it('ignores a survey the host stopped refreshing, rather than filing hour-old numbers', () => {
    publishSurvey(
      {
        CLAUDE_CODE_OAUTH_TOKEN: { five_hour: win(1), seven_day: win(90) },
        CLAUDE_CODE_OAUTH_TOKEN_3: { five_hour: win(1), seven_day: win(80) },
      },
      SLOT_USAGE_SURVEY_MAX_AGE_MS + 60_000,
    );
    const p = new ClaudeProvider({ env: RING });
    p.recordSlotUsageSurvey({ now: NOW });
    expect(getRateLimitSampleRows()).toHaveLength(0);
  });

  it('records a PARTIAL survey and leaves the unread slots unsampled', () => {
    publishSurvey({
      CLAUDE_CODE_OAUTH_TOKEN: null, // the host was 429'd on this one
      CLAUDE_CODE_OAUTH_TOKEN_2: { five_hour: win(1), seven_day: win(30) },
      CLAUDE_CODE_OAUTH_TOKEN_3: { five_hour: win(1), seven_day: win(66) },
    });
    const p = new ClaudeProvider({ env: RING });
    p.recordSlotUsageSurvey({ now: NOW });
    expect(new Set(getRateLimitSampleRows().map((r) => r.account))).toEqual(
      new Set(['CLAUDE_CODE_OAUTH_TOKEN_2', 'CLAUDE_CODE_OAUTH_TOKEN_3']),
    );
  });

  it('does nothing on the API-key auth path (no rows)', () => {
    publishSurvey({ CLAUDE_CODE_OAUTH_TOKEN: { five_hour: win(1), seven_day: win(2) } });
    const p = new ClaudeProvider({ env: { ANTHROPIC_API_KEY: 'sk-x', ...RING } });
    p.recordSlotUsageSurvey({ now: NOW });
    expect(getRateLimitSampleRows()).toHaveLength(0);
  });

  it('samples a single-slot ring', () => {
    publishSurvey({ CLAUDE_CODE_OAUTH_TOKEN: { five_hour: win(1), seven_day: win(2) } });
    const p = new ClaudeProvider({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'solo' } });
    p.recordSlotUsageSurvey({ now: NOW });
    expect(getRateLimitSampleRows()).toHaveLength(2);
    expect(getCredentialSlot('claude')).toBeUndefined();
  });

  it('never throws on a survey that is outright garbage', () => {
    process.env[SLOT_USAGE_SURVEY_ENV] = 'not json at all {';
    const p = new ClaudeProvider({ env: RING });
    expect(() => p.recordSlotUsageSurvey({ now: NOW })).not.toThrow();
    expect(getRateLimitSampleRows()).toHaveLength(0);
  });
});

/**
 * The other half of the host/runner wire contract. The host writes
 * `NANOCLAW_SLOT_USAGE_SURVEY` from a different package tree that this one
 * cannot import (Node/pnpm vs Bun), so a fixture both sides assert against is
 * the only thing that catches one of them changing shape — #817's lesson,
 * where a wire shape verified only against the code's own belief passed every
 * test and failed in production.
 *
 * The producing half is the "the host/runner survey wire shape" describe in
 * `src/slot-usage-survey.test.ts`, which asserts the host emits EXACTLY this
 * file. Change the payload shape and both halves must move together.
 */
describe('the host/runner survey wire shape', () => {
  const fixture = readFileSync(new URL('./slot-usage-survey.fixture.json', import.meta.url), 'utf8');
  // The fixture is stamped 06:00:00Z; read it a minute later so age is not the
  // thing under test here.
  const now = Date.parse('2026-09-15T06:01:00.000Z');

  it('turns the host’s payload into the usage_pull rows', () => {
    const parsed = parseSlotUsageSurvey(fixture, { now });
    expect(parsed.problem).toBeNull();
    expect(parsed.staleSlots).toEqual([]);
    expect(Object.keys(parsed.fresh).sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_3']);

    const rows = usageResponseToSamples(surveyEntryToUsageResponse(parsed.fresh.CLAUDE_CODE_OAUTH_TOKEN!), {
      ...WHO,
      account: 'CLAUDE_CODE_OAUTH_TOKEN',
    });
    expect(rows.map((r) => r.limitType).sort()).toEqual(['five_hour', 'seven_day']);
    expect(rows.find((r) => r.limitType === 'seven_day')).toMatchObject({
      source: 'usage_pull',
      available: true,
      utilization: 0.87,
      resetsAt: '2026-09-22T00:00:00Z',
    });
    expect(rows.find((r) => r.limitType === 'five_hour')!.utilization).toBeCloseTo(0.12);

    // A plan reporting no numeric window still records that the pull happened.
    const none = usageResponseToSamples(surveyEntryToUsageResponse(parsed.fresh.CLAUDE_CODE_OAUTH_TOKEN_3!), {
      ...WHO,
      account: 'CLAUDE_CODE_OAUTH_TOKEN_3',
    });
    expect(none).toHaveLength(1);
    expect(none[0]).toMatchObject({ available: true, limitType: null, status: 'no_window' });
  });
});
