import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getRawDb } from './db/index.js';
import { markProviderUnavailable } from './db/provider-health.js';
import { resolveSpawnProvider } from './provider-fallback.js';

const GID = 'ag-fallback';
const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const FALLBACK = { provider: 'claude', model: 'claude-opus-5[1m]', effort: 'high' };

function decide(overrides: Record<string, unknown> = {}) {
  return resolveSpawnProvider({
    agentGroupId: GID,
    sessionProvider: null,
    containerConfig: { provider: 'codex', providerFallback: FALLBACK, ...overrides },
    nowMs: NOW,
  });
}

describe('spawn-time provider fallback', () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    await createAgentGroup({
      id: GID,
      name: 'f',
      folder: 'f',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });
  afterEach(() => closeDb());

  it('stays on the primary while it is healthy', async () => {
    expect(await decide()).toMatchObject({ provider: 'codex', fallbackApplied: false });
  });

  it('routes to the fallback while the primary is in cooldown', async () => {
    await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    expect(await decide()).toMatchObject({
      provider: 'claude',
      model: 'claude-opus-5[1m]',
      effort: 'high',
      primaryProvider: 'codex',
      fallbackApplied: true,
    });
  });

  it('routes a Claude primary to Codex while Claude is in cooldown', async () => {
    await markProviderUnavailable(GID, 'claude', 'quota', { nowMs: NOW });
    expect(
      await resolveSpawnProvider({
        agentGroupId: GID,
        sessionProvider: null,
        containerConfig: { provider: 'claude', providerFallback: { provider: 'codex' } },
        nowMs: NOW,
      }),
    ).toMatchObject({
      provider: 'codex',
      primaryProvider: 'claude',
      fallbackApplied: true,
    });
  });

  it('returns to the primary once the window expires — no cron required', async () => {
    const until = await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    const after = Date.parse(until) + 1;
    expect(
      await resolveSpawnProvider({
        agentGroupId: GID,
        sessionProvider: null,
        containerConfig: { provider: 'codex', providerFallback: FALLBACK },
        nowMs: after,
      }),
    ).toMatchObject({ provider: 'codex', fallbackApplied: false });
  });

  it('beats a stamped session.agent_provider, which normally shadows the file', async () => {
    await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    const decision = await resolveSpawnProvider({
      agentGroupId: GID,
      sessionProvider: 'codex',
      containerConfig: { provider: 'claude', providerFallback: FALLBACK },
      nowMs: NOW,
    });
    expect(decision).toMatchObject({ provider: 'claude', primaryProvider: 'codex', fallbackApplied: true });
  });

  it('an undeclared fallback keeps the outage loud', async () => {
    await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    expect(await decide({ providerFallback: undefined })).toMatchObject({ provider: 'codex', fallbackApplied: false });
  });

  it('ignores a fallback that points back at the primary', async () => {
    await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    expect(await decide({ providerFallback: { provider: 'CODEX' } })).toMatchObject({
      provider: 'codex',
      fallbackApplied: false,
    });
  });

  it('does not thrash onto a fallback that is itself in cooldown', async () => {
    await markProviderUnavailable(GID, 'codex', 'quota', { nowMs: NOW });
    await markProviderUnavailable(GID, 'claude', 'quota', { nowMs: NOW });
    expect(await decide()).toMatchObject({ provider: 'codex', fallbackApplied: false });
  });
});
