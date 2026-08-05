import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './index.js';
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
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: GID,
      name: 'health',
      folder: 'health',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });
  afterEach(() => closeDb());

  it('absence of a row means available — bookkeeping gaps must fail open', () => {
    expect(isProviderUnavailable(GID, 'codex', { nowMs: NOW })).toBe(false);
    expect(getProviderHealth(GID, 'codex')).toBeUndefined();
  });

  it("honors the provider's own reset time when it gives one", () => {
    const resetAt = new Date(NOW + 6 * 60 * 60_000).toISOString();
    const until = markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW, resetAt });
    expect(until).toBe(resetAt);
    expect(isProviderUnavailable(GID, 'codex', { nowMs: NOW })).toBe(true);
    // One millisecond past the window it is available again — no cron needed.
    expect(isProviderUnavailable(GID, 'codex', { nowMs: Date.parse(resetAt) })).toBe(false);
  });

  it('backs off on the failure streak when no reset time is given', () => {
    const first = markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    expect(Date.parse(first) - NOW).toBe(15 * 60_000);
    const second = markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    expect(Date.parse(second) - NOW).toBe(30 * 60_000);
    const third = markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    expect(Date.parse(third) - NOW).toBe(60 * 60_000);
    expect(getProviderHealth(GID, 'codex')?.consecutive_failures).toBe(3);
  });

  it('clamps an absurd provider-stated window instead of trusting it', () => {
    const silly = new Date(NOW + 400 * 24 * 60 * 60_000).toISOString();
    const until = markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW, resetAt: silly });
    expect(Date.parse(until) - NOW).toBe(7 * 24 * 60 * 60_000);
  });

  it('a success clears the cooldown and the streak', () => {
    markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    markProviderAvailable(GID, 'codex', { nowMs: NOW });
    expect(isProviderUnavailable(GID, 'codex', { nowMs: NOW })).toBe(false);
    expect(getProviderHealth(GID, 'codex')?.consecutive_failures).toBe(0);
  });

  it('tracks providers independently — a codex outage never gates claude', () => {
    markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    expect(isProviderUnavailable(GID, 'codex', { nowMs: NOW })).toBe(true);
    expect(isProviderUnavailable(GID, 'claude', { nowMs: NOW })).toBe(false);
  });

  it("parses codex's real usage-limit sentence, ordinal suffix and all", () => {
    const msg =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 12:42 AM.";
    const parsed = parseProviderResetAt(msg, NOW);
    expect(parsed).not.toBeNull();
    expect(Date.parse(parsed as string)).toBe(Date.parse('Aug 8, 2026 12:42 AM'));
  });

  it('returns null for unparseable or past reset times so backoff takes over', () => {
    expect(parseProviderResetAt('You have hit your usage limit.', NOW)).toBeNull();
    expect(parseProviderResetAt('try again at some point soon', NOW)).toBeNull();
    expect(parseProviderResetAt('try again at Aug 1st, 2020 12:00 AM', NOW)).toBeNull();
    expect(parseProviderResetAt(null, NOW)).toBeNull();
  });
});
