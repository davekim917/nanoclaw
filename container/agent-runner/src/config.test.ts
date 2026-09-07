import { describe, expect, it, afterEach } from 'bun:test';

import { parseRawConfig } from './config.js';

const BASE = { provider: 'codex', model: 'gpt-5.6-sol' };

function clearEnv(): void {
  delete process.env.NANOCLAW_PROVIDER_OVERRIDE;
  delete process.env.NANOCLAW_MODEL_OVERRIDE;
  delete process.env.NANOCLAW_CODEX_MODEL_OVERRIDE;
  delete process.env.NANOCLAW_CODEX_EFFORT_OVERRIDE;
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

  it('lets a Claude primary run on its declared Codex fallback', () => {
    process.env.NANOCLAW_PROVIDER_OVERRIDE = 'codex';
    const config = parseRawConfig({
      provider: 'claude',
      providerConfig: { model: 'claude-opus-5[1m]', effort: 'high' },
      providerFallback: { provider: 'codex' },
    });
    expect(config.provider).toBe('codex');
    expect(config.providerConfig).toEqual({});
    expect(config.providerFallback).toEqual({ provider: 'codex' });
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

  it('carries a Codex fallback declaration onto config.model/effort', () => {
    // The codex direction of the same bridge. `providerConfig` is emptied
    // (claude's sticky config is the wrong provider's), so these two fields
    // are the ONLY carrier of the fallback's declared model/effort into the
    // container — CodexProvider folds them into its sticky config.
    clearEnv();
    process.env.NANOCLAW_PROVIDER_OVERRIDE = 'codex';
    const config = parseRawConfig({
      provider: 'claude',
      providerConfig: { model: 'claude-opus-5[1m]', effort: 'high' },
      providerFallback: { provider: 'codex', model: 'gpt-5.5-pro', effort: 'xhigh' },
    });
    expect(config.provider).toBe('codex');
    expect(config.providerConfig).toEqual({});
    expect(config.model).toBe('gpt-5.5-pro');
    expect(config.effort).toBe('xhigh');
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
    // Codex consumes its sticky model from providerConfig; the top-level
    // container model is mirrored there at parse time so `ncl groups config`
    // changes are effective on the next spawn.
    expect(config.providerConfig).toEqual({ model: 'gpt-5.6-sol', reasoning_effort: 'high' });
  });

  it('applies a primary Codex channel model and effort over the file config', () => {
    clearEnv();
    process.env.NANOCLAW_CODEX_MODEL_OVERRIDE = 'gpt-5.6-luna';
    process.env.NANOCLAW_CODEX_EFFORT_OVERRIDE = 'max';
    const config = parseRawConfig({
      ...BASE,
      model: 'gpt-5.6-sol',
      effort: 'high',
      providerConfig: { model: 'gpt-5.6-sol', reasoning_effort: 'high' },
    });
    expect(config.model).toBe('gpt-5.6-luna');
    expect(config.effort).toBe('max');
    expect(config.providerConfig).toMatchObject({ model: 'gpt-5.6-luna', reasoning_effort: 'max' });
  });

  it('does not leak Codex channel overrides into a provider fallback', () => {
    clearEnv();
    process.env.NANOCLAW_PROVIDER_OVERRIDE = 'claude';
    process.env.NANOCLAW_CODEX_MODEL_OVERRIDE = 'gpt-5.6-luna';
    process.env.NANOCLAW_CODEX_EFFORT_OVERRIDE = 'max';
    const config = parseRawConfig({
      ...BASE,
      providerFallback: { provider: 'claude', model: 'claude-opus-5[1m]', effort: 'high' },
    });
    expect(config.provider).toBe('claude');
    expect(config.model).toBe('claude-opus-5[1m]');
    expect(config.effort).toBe('high');
    expect(config.providerConfig).toEqual({});
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

  it('marks a fallback spawn with onFallback so providers can gate on it', () => {
    // The claude provider folds `model`/`effort` into its sticky config ONLY
    // under this flag. On the primary path those two fields carry the group's
    // OWN container.json values, which already reach the turn through the
    // host's ANTHROPIC_DEFAULT_OPUS_MODEL / NANOCLAW_EFFORT_OVERRIDE spawn
    // env — folding them in there would add a second, higher-precedence route
    // and change behavior for every primary claude group.
    process.env.NANOCLAW_PROVIDER_OVERRIDE = 'claude';
    const fallback = parseRawConfig({
      ...BASE,
      providerFallback: { provider: 'claude', model: 'claude-fable-5-1[1m]', effort: 'medium' },
    });
    expect(fallback.onFallback).toBe(true);
    expect(fallback.model).toBe('claude-fable-5-1[1m]');
    expect(fallback.effort).toBe('medium');

    clearEnv();
    const primary = parseRawConfig({
      provider: 'claude',
      model: 'claude-fable-5-1[1m]',
      effort: 'medium',
      providerFallback: { provider: 'codex' },
    });
    expect(primary.onFallback).toBe(false);
    // Still surfaced — the host env is what consumes them on the primary path.
    expect(primary.model).toBe('claude-fable-5-1[1m]');
    expect(primary.effort).toBe('medium');
  });
});
