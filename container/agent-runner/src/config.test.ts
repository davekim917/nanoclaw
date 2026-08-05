import { describe, expect, it, afterEach } from 'bun:test';

import { parseRawConfig } from './config.js';

const BASE = { provider: 'codex', model: 'gpt-5.6-sol' };

function clearEnv(): void {
  delete process.env.NANOCLAW_PROVIDER_OVERRIDE;
  delete process.env.NANOCLAW_MODEL_OVERRIDE;
}

describe('parseRawConfig provider fallback bridge', () => {
  afterEach(clearEnv);

  it('uses container.json when the host sends no override', () => {
    clearEnv();
    const config = parseRawConfig({ ...BASE });
    expect(config.provider).toBe('codex');
    expect(config.model).toBe('gpt-5.6-sol');
  });

  it('lets the spawn-time override beat the file — the file is static per group', () => {
    process.env.NANOCLAW_PROVIDER_OVERRIDE = 'claude';
    process.env.NANOCLAW_MODEL_OVERRIDE = 'claude-opus-5[1m]';
    const config = parseRawConfig({ ...BASE });
    expect(config.provider).toBe('claude');
    expect(config.model).toBe('claude-opus-5[1m]');
  });

  it('drops the primary provider-specific fields under an override — they are the wrong provider now', () => {
    // Live crash 2026-08-05: a codex group fell back to claude and every
    // spawn died with `Unrecognized key: "reasoning_effort"` — the file's codex
    // providerConfig was parsed by claude's strict schema. A codex model id
    // reaching the Anthropic API is the same class of failure.
    process.env.NANOCLAW_PROVIDER_OVERRIDE = 'claude';
    const config = parseRawConfig({
      ...BASE,
      effort: 'high',
      providerConfig: { model: 'gpt-5.6-sol', reasoning_effort: 'high' },
    });
    expect(config.provider).toBe('claude');
    expect(config.providerConfig).toEqual({});
    expect(config.model).toBeUndefined();
    expect(config.effort).toBeUndefined();
  });

  it('takes model and effort from the matching fallback declaration', () => {
    process.env.NANOCLAW_PROVIDER_OVERRIDE = 'claude';
    const config = parseRawConfig({
      ...BASE,
      effort: 'xhigh',
      providerConfig: { reasoning_effort: 'xhigh' },
      providerFallback: { provider: 'claude', model: 'claude-opus-5[1m]', effort: 'high' },
    });
    expect(config.model).toBe('claude-opus-5[1m]');
    expect(config.effort).toBe('high');
    expect(config.providerConfig).toEqual({});
  });

  it('keeps the file settings when no override is in play', () => {
    clearEnv();
    const config = parseRawConfig({
      ...BASE,
      effort: 'high',
      providerConfig: { reasoning_effort: 'high' },
    });
    expect(config.model).toBe('gpt-5.6-sol');
    expect(config.effort).toBe('high');
    expect(config.providerConfig).toEqual({ reasoning_effort: 'high' });
  });

  it('surfaces providerFallback so the loop can tell a recoverable outage from a dead end', () => {
    clearEnv();
    const config = parseRawConfig({
      ...BASE,
      providerFallback: { provider: 'claude', model: 'claude-opus-5[1m]', effort: 'high' },
    });
    expect(config.providerFallback).toEqual({ provider: 'claude', model: 'claude-opus-5[1m]', effort: 'high' });
    const none = parseRawConfig({ ...BASE });
    expect(none.providerFallback).toBeUndefined();
  });

  it('still defaults to claude when the file names no provider', () => {
    clearEnv();
    expect(parseRawConfig({}).provider).toBe('claude');
  });
});
