import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const killed: Array<{ sessionId: string; reason: string }> = [];
vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  killContainer: vi.fn((sessionId: string, reason: string) => {
    killed.push({ sessionId, reason });
  }),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
  };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-provider-fallback') }));

import { initTestDb, closeDb, runMigrations, createAgentGroup, getRawDb } from '../../db/index.js';
import { getProviderHealth, isProviderUnavailable, markProviderUnavailable } from '../../db/provider-health.js';
import type { Session } from '../../types.js';
import { SYSTEM_ERROR_PARK_MAX_MS, handleProviderUnavailable, measuredResetAt } from './handler.js';

const GID = 'ag-pf';
const FOLDER = 'pf-group';
const QUOTA_MESSAGE =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2126 12:42 AM.";

const session = { id: 'sess-pf', agent_group_id: GID } as unknown as Session;

function writeConfig(config: Record<string, unknown>): void {
  const dir = `${TEST_DIR}/groups/${FOLDER}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/container.json`, JSON.stringify(config));
}

describe('provider_unavailable handler', () => {
  beforeEach(async () => {
    killed.length = 0;
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    await createAgentGroup({
      id: GID,
      name: FOLDER,
      folder: FOLDER,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });
  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('records the outage window and respawns the reporting session', async () => {
    writeConfig({ provider: 'codex', providerFallback: { provider: 'claude' } });
    await handleProviderUnavailable(
      { action: 'provider_unavailable', provider: 'codex', message: QUOTA_MESSAGE },
      session,
    );
    expect(await isProviderUnavailable(GID, 'codex')).toBe(true);
    // The stated reset parsed, but it is only an upper bound: the retry lands
    // on the backoff schedule so an early account restore is discovered
    // quickly instead of waiting out the quoted date.
    const row = await getProviderHealth(GID, 'codex');
    const windowMs = Date.parse(row!.unavailable_until as string) - Date.now();
    expect(windowMs).toBeGreaterThan(14 * 60_000);
    expect(windowMs).toBeLessThanOrEqual(15 * 60_000);
    expect(killed).toHaveLength(1);
    expect(killed[0].sessionId).toBe('sess-pf');
  });

  it('does nothing when the group declares no fallback — the outage stays loud', async () => {
    writeConfig({ provider: 'codex' });
    await handleProviderUnavailable({ provider: 'codex', message: QUOTA_MESSAGE }, session);
    expect(await isProviderUnavailable(GID, 'codex')).toBe(false);
    expect(killed).toHaveLength(0);
  });

  it('does not respawn when the fallback is exhausted too — no bounce loop', async () => {
    writeConfig({ provider: 'codex', providerFallback: { provider: 'claude' } });
    // The fallback died first (this container was already running on it).
    await markProviderUnavailable(GID, 'claude', 'quota', {});
    await handleProviderUnavailable({ provider: 'codex', message: QUOTA_MESSAGE }, session);
    expect(await isProviderUnavailable(GID, 'codex')).toBe(true);
    expect(killed).toHaveLength(0);
  });

  it('ignores a report with no provider', async () => {
    writeConfig({ provider: 'codex', providerFallback: { provider: 'claude' } });
    await handleProviderUnavailable({ message: QUOTA_MESSAGE }, session);
    expect(await getProviderHealth(GID, 'codex')).toBeUndefined();
    expect(killed).toHaveLength(0);
  });

  it('falls back to backoff when the provider states no reset time', async () => {
    writeConfig({ provider: 'codex', providerFallback: { provider: 'claude' } });
    await handleProviderUnavailable({ provider: 'codex', message: 'usage limit reached' }, session);
    const row = await getProviderHealth(GID, 'codex');
    expect(row?.consecutive_failures).toBe(1);
    expect(await isProviderUnavailable(GID, 'codex')).toBe(true);
  });

  // Read → park (plan item 0.7): the container's pre-turn Codex rate-limit
  // park arrives as a quota report carrying the window's own reset.
  it('parks until a MEASURED resetAt exactly, and names the reading in last_error_message', async () => {
    writeConfig({ provider: 'codex', providerFallback: { provider: 'claude' } });
    const resetAt = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();
    const message = `Codex rate limit reached (workspace_owner_usage_limit_reached) [seven_day] 100% used (resets ${resetAt})`;
    await handleProviderUnavailable(
      { action: 'provider_unavailable', provider: 'codex', classification: 'quota', message, resetAt },
      session,
    );
    const row = await getProviderHealth(GID, 'codex');
    expect(row?.unavailable_until).toBe(resetAt);
    expect(row?.last_error_class).toBe('quota');
    expect(row?.last_error_message).toBe(message);
    expect(killed).toHaveLength(1);
  });

  it('ignores a past or malformed resetAt and falls back to prose parsing / backoff', async () => {
    writeConfig({ provider: 'codex', providerFallback: { provider: 'claude' } });
    await handleProviderUnavailable(
      {
        provider: 'codex',
        classification: 'quota',
        message: 'usage limit reached',
        resetAt: '2001-01-01T00:00:00.000Z',
      },
      session,
    );
    const first = await getProviderHealth(GID, 'codex');
    expect(Date.parse(first!.unavailable_until as string) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    await handleProviderUnavailable(
      { provider: 'codex', classification: 'quota', message: 'usage limit reached', resetAt: 'soon-ish' },
      session,
    );
    const second = await getProviderHealth(GID, 'codex');
    expect(Date.parse(second!.unavailable_until as string) - Date.now()).toBeLessThanOrEqual(30 * 60_000);
  });

  it('does not honour a measured resetAt on a non-quota report', async () => {
    writeConfig({ provider: 'codex', providerFallback: { provider: 'claude' } });
    const resetAt = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();
    await handleProviderUnavailable(
      { provider: 'codex', classification: 'unavailable', message: 'stream disconnected', resetAt },
      session,
    );
    const row = await getProviderHealth(GID, 'codex');
    expect(Date.parse(row!.unavailable_until as string) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
  });

  it('bounds the coarse Codex systemError park at 60 minutes however long the streak', async () => {
    writeConfig({ provider: 'codex', providerFallback: { provider: 'claude' } });
    // Six prior unrecovered failures would put plain backoff at its 6h cap.
    for (let i = 0; i < 5; i++) await markProviderUnavailable(GID, 'codex', 'unavailable', {});
    await handleProviderUnavailable(
      {
        provider: 'codex',
        classification: 'unavailable',
        reason: 'system_error',
        message: 'codex_system_error: thread entered systemError state',
      },
      session,
    );
    const row = await getProviderHealth(GID, 'codex');
    expect(row?.consecutive_failures).toBe(6);
    const windowMs = Date.parse(row!.unavailable_until as string) - Date.now();
    expect(windowMs).toBeGreaterThan(SYSTEM_ERROR_PARK_MAX_MS - 60_000);
    expect(windowMs).toBeLessThanOrEqual(SYSTEM_ERROR_PARK_MAX_MS);
  });
});

describe('measuredResetAt', () => {
  const now = Date.parse('2026-09-14T12:00:00.000Z');
  it('accepts only a parseable future instant, normalized to ISO', () => {
    expect(measuredResetAt('2026-09-17T00:00:00Z', now)).toBe('2026-09-17T00:00:00.000Z');
    expect(measuredResetAt('2026-09-14T12:00:00.000Z', now)).toBeNull();
    expect(measuredResetAt('2026-09-01T00:00:00.000Z', now)).toBeNull();
    expect(measuredResetAt('not a date', now)).toBeNull();
    expect(measuredResetAt(1789603200, now)).toBeNull();
    expect(measuredResetAt(undefined, now)).toBeNull();
    expect(measuredResetAt('', now)).toBeNull();
  });
});
