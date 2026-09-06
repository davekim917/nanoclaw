import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb, getRawDb } from './index.js';
import {
  getProviderHealth,
  isProviderUnavailable,
  markProviderAvailable,
  markProviderUnavailable,
  parseProviderResetAt,
} from './provider-health.js';

const GID = 'ag-health';
const NOW = Date.parse('2026-08-05T12:00:00.000Z');

describe('provider health cooldown', () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    await createAgentGroup({
      id: GID,
      name: 'health',
      folder: 'health',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });
  afterEach(() => closeDb());

  it('absence of a row means available — bookkeeping gaps must fail open', async () => {
    expect(await isProviderUnavailable(GID, 'codex', { nowMs: NOW })).toBe(false);
    expect(await getProviderHealth(GID, 'codex')).toBeUndefined();
  });

  it('honors a SHORT stated reset — the provider knows better than the backoff', async () => {
    const resetAt = new Date(NOW + 5 * 60_000).toISOString();
    const until = await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW, resetAt });
    // Floor is 1 minute; 5 minutes is under the 15-minute first backoff, so
    // the provider's own word wins.
    expect(Date.parse(until) - NOW).toBe(5 * 60_000);
    expect(await isProviderUnavailable(GID, 'codex', { nowMs: NOW })).toBe(true);
    // One millisecond past the window it is available again — no cron needed.
    expect(await isProviderUnavailable(GID, 'codex', { nowMs: Date.parse(until) })).toBe(false);
  });

  it('treats a LONG stated reset as an upper bound, not a schedule', async () => {
    // Codex quoting a date ~60h out must not pin the group to its fallback
    // until then: accounts are often restored early, and the retry is cheap.
    const resetAt = new Date(NOW + 60 * 60 * 60_000).toISOString();
    const first = await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW, resetAt });
    expect(Date.parse(first) - NOW).toBe(15 * 60_000);
    const second = await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW, resetAt });
    expect(Date.parse(second) - NOW).toBe(30 * 60_000);
  });

  it('backs off on the failure streak when no reset time is given', async () => {
    const first = await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    expect(Date.parse(first) - NOW).toBe(15 * 60_000);
    const second = await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    expect(Date.parse(second) - NOW).toBe(30 * 60_000);
    const third = await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    expect(Date.parse(third) - NOW).toBe(60 * 60_000);
    expect((await getProviderHealth(GID, 'codex'))?.consecutive_failures).toBe(3);
  });

  it('never lets a provider park a group on its fallback for a year', async () => {
    const silly = new Date(NOW + 400 * 24 * 60 * 60_000).toISOString();
    const until = await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW, resetAt: silly });
    // Bounded by the backoff schedule, and in every case by the 7-day ceiling.
    expect(Date.parse(until) - NOW).toBe(15 * 60_000);
    expect(Date.parse(until) - NOW).toBeLessThanOrEqual(7 * 24 * 60 * 60_000);
  });

  it('a success clears the cooldown and the streak', async () => {
    await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    await markProviderAvailable(GID, 'codex', { nowMs: NOW });
    expect(await isProviderUnavailable(GID, 'codex', { nowMs: NOW })).toBe(false);
    expect((await getProviderHealth(GID, 'codex'))?.consecutive_failures).toBe(0);
  });

  it('does not clear a cooldown written between its read and its write (#460 P2)', async () => {
    await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    const seen = await getProviderHealth(GID, 'codex');
    expect(seen?.consecutive_failures).toBe(1);
    // A concurrent failure lands after the success path has read the row but
    // before it writes: the newer, longer cooldown must stand.
    await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW + 1 });
    const raced = await getDb().run(
      `UPDATE provider_health SET unavailable_until = NULL, consecutive_failures = 0, updated_at = ?
        WHERE agent_group_id = ? AND provider = ? AND updated_at = ? AND unavailable_until IS ? AND consecutive_failures = ?`,
      new Date(NOW).toISOString(),
      GID,
      'codex',
      seen!.updated_at,
      seen!.unavailable_until,
      seen!.consecutive_failures,
    );
    expect(raced.changes).toBe(0);
    const after = await getProviderHealth(GID, 'codex');
    expect(after?.consecutive_failures).toBe(2);
    expect(await isProviderUnavailable(GID, 'codex', { nowMs: NOW })).toBe(true);
    // The same clear against the CURRENT row applies and reports it.
    expect(await markProviderAvailable(GID, 'codex', { nowMs: NOW + 2 })).toBe(true);
    expect(await markProviderAvailable(GID, 'codex', { nowMs: NOW + 3 })).toBe(false);
  });

  it('a fresh episode starts at the first backoff, not where the last one ended', async () => {
    // The streak must reset once an outage is over, or a provider healthy for
    // weeks would reopen at the 6h cap. markProviderAvailable is what the
    // spawn path calls when it gives the primary another go.
    await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    expect((await getProviderHealth(GID, 'codex'))?.consecutive_failures).toBe(2);
    await markProviderAvailable(GID, 'codex', { nowMs: NOW });
    const reopened = await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    expect(Date.parse(reopened) - NOW).toBe(15 * 60_000);
  });

  it('tracks providers independently — a codex outage never gates claude', async () => {
    await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    expect(await isProviderUnavailable(GID, 'codex', { nowMs: NOW })).toBe(true);
    expect(await isProviderUnavailable(GID, 'claude', { nowMs: NOW })).toBe(false);
  });

  it("parses codex's real usage-limit sentence, ordinal suffix and all", async () => {
    const msg =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 12:42 AM.";
    const parsed = parseProviderResetAt(msg, NOW);
    expect(parsed).not.toBeNull();
    expect(Date.parse(parsed as string)).toBe(Date.parse('Aug 8, 2026 12:42 AM'));
  });

  it('returns null for unparseable or past reset times so backoff takes over', async () => {
    expect(parseProviderResetAt('You have hit your usage limit.', NOW)).toBeNull();
    expect(parseProviderResetAt('try again at some point soon', NOW)).toBeNull();
    expect(parseProviderResetAt('try again at Aug 1st, 2020 12:00 AM', NOW)).toBeNull();
    expect(parseProviderResetAt(null, NOW)).toBeNull();
  });
});
