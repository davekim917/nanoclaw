import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getRawDb } from './db/index.js';
import { markProviderUnavailable } from './db/provider-health.js';
import { applyProviderFallbackRuntime, providerFallbackRuntimeEnv, resolveSpawnProvider } from './provider-fallback.js';
import type { ContainerConfig } from './container-config.js';

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

describe('applyProviderFallbackRuntime', () => {
  it('drops every source-provider model and effort layer before an unpinned fallback resolves its native default', () => {
    const config: Pick<ContainerConfig, 'provider' | 'model' | 'effort' | 'defaultModel' | 'defaultEffort'> = {
      provider: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'xhigh',
      defaultModel: 'gpt-5.6-luna',
      defaultEffort: 'low',
    };

    applyProviderFallbackRuntime(config, { provider: 'claude', model: undefined, effort: undefined });

    expect(config).toEqual({
      provider: 'claude',
      model: undefined,
      effort: undefined,
      defaultModel: undefined,
      defaultEffort: undefined,
    });
  });

  it('keeps an explicit fallback model and effort while still removing legacy source defaults', () => {
    const config: Pick<ContainerConfig, 'provider' | 'model' | 'effort' | 'defaultModel' | 'defaultEffort'> = {
      provider: 'claude',
      model: 'claude-sonnet-5',
      effort: 'xhigh',
      defaultModel: 'claude-opus-5[1m]',
      defaultEffort: 'high',
    };

    applyProviderFallbackRuntime(config, { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' });

    expect(config).toEqual({
      provider: 'codex',
      model: 'gpt-6-astra',
      effort: 'medium',
      defaultModel: undefined,
      defaultEffort: undefined,
    });
  });

  it('marks the env bridge even when the fallback target equals the group file provider', () => {
    expect(providerFallbackRuntimeEnv({ provider: 'claude' })).toEqual({
      NANOCLAW_PROVIDER_OVERRIDE: 'claude',
      NANOCLAW_PROVIDER_FALLBACK_APPLIED: '1',
    });
  });

  it('carries an explicitly declared fallback model alongside the marker', () => {
    expect(providerFallbackRuntimeEnv({ provider: 'codex', model: 'gpt-6-astra' })).toEqual({
      NANOCLAW_PROVIDER_OVERRIDE: 'codex',
      NANOCLAW_PROVIDER_FALLBACK_APPLIED: '1',
      NANOCLAW_MODEL_OVERRIDE: 'gpt-6-astra',
    });
  });
});
