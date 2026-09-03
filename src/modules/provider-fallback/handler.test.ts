import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const killed: Array<{ sessionId: string; reason: string }> = [];
vi.mock('../../container-runner.js', () => ({
  killContainer: vi.fn((sessionId: string, reason: string) => {
    killed.push({ sessionId, reason });
  }),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-provider-fallback',
    GROUPS_DIR: '/tmp/nanoclaw-test-provider-fallback/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-provider-fallback';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { getProviderHealth, isProviderUnavailable, markProviderUnavailable } from '../../db/provider-health.js';
import type { Session } from '../../types.js';
import { handleProviderUnavailable } from './handler.js';

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
  beforeEach(() => {
    killed.length = 0;
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: GID,
      name: FOLDER,
      folder: FOLDER,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });
  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('records the outage window and respawns the reporting session', async () => {
    writeConfig({ provider: 'codex', providerFallback: { provider: 'claude' } });
    await handleProviderUnavailable(
      { action: 'provider_unavailable', provider: 'codex', message: QUOTA_MESSAGE },
      session,
    );
    expect(isProviderUnavailable(GID, 'codex')).toBe(true);
    // The stated reset parsed, but it is only an upper bound: the retry lands
    // on the backoff schedule so an early account restore is discovered
    // quickly instead of waiting out the quoted date.
    const row = getProviderHealth(GID, 'codex');
    const windowMs = Date.parse(row!.unavailable_until as string) - Date.now();
    expect(windowMs).toBeGreaterThan(14 * 60_000);
    expect(windowMs).toBeLessThanOrEqual(15 * 60_000);
    expect(killed).toHaveLength(1);
    expect(killed[0].sessionId).toBe('sess-pf');
  });

  it('does nothing when the group declares no fallback — the outage stays loud', async () => {
    writeConfig({ provider: 'codex' });
    await handleProviderUnavailable({ provider: 'codex', message: QUOTA_MESSAGE }, session);
    expect(isProviderUnavailable(GID, 'codex')).toBe(false);
    expect(killed).toHaveLength(0);
  });

  it('does not respawn when the fallback is exhausted too — no bounce loop', async () => {
    writeConfig({ provider: 'codex', providerFallback: { provider: 'claude' } });
    // The fallback died first (this container was already running on it).
    markProviderUnavailable(GID, 'claude', 'quota', {});
    await handleProviderUnavailable({ provider: 'codex', message: QUOTA_MESSAGE }, session);
    expect(isProviderUnavailable(GID, 'codex')).toBe(true);
    expect(killed).toHaveLength(0);
  });

  it('ignores a report with no provider', async () => {
    writeConfig({ provider: 'codex', providerFallback: { provider: 'claude' } });
    await handleProviderUnavailable({ message: QUOTA_MESSAGE }, session);
    expect(getProviderHealth(GID, 'codex')).toBeUndefined();
    expect(killed).toHaveLength(0);
  });

  it('falls back to backoff when the provider states no reset time', async () => {
    writeConfig({ provider: 'codex', providerFallback: { provider: 'claude' } });
    await handleProviderUnavailable({ provider: 'codex', message: 'usage limit reached' }, session);
    const row = getProviderHealth(GID, 'codex');
    expect(row?.consecutive_failures).toBe(1);
    expect(isProviderUnavailable(GID, 'codex')).toBe(true);
  });
});
