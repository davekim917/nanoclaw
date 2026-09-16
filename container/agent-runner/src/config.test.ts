import { describe, expect, it, afterEach } from 'bun:test';

import { parseRawConfig } from './config.js';

const BASE = { provider: 'codex', model: 'gpt-5.6-sol' };

function clearEnv(): void {
  delete process.env.NANOCLAW_PROVIDER_OVERRIDE;
  delete process.env.NANOCLAW_MODEL_OVERRIDE;
  delete process.env.NANOCLAW_PROVIDER_FALLBACK_APPLIED;
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
    expect(config.fallbackApplied).toBe(false);
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
    expect(config.model).toBeUndefined();
    expect(config.effort).toBeUndefined();
    expect(config.providerFallback).toEqual({ provider: 'codex' });
    expect(config.fallbackApplied).toBe(true);
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

  it('drops Claude file settings when a Codex-pinned session falls back to its file provider', () => {
    // Provider equality alone is not enough: the session's primary was Codex,
    // but this group's file names Claude. The host's explicit fallback marker
    // preserves the source/target boundary across that env bridge.
    process.env.NANOCLAW_PROVIDER_OVERRIDE = 'claude';
    process.env.NANOCLAW_PROVIDER_FALLBACK_APPLIED = '1';
    const config = parseRawConfig({
      provider: 'claude',
      model: 'claude-fable-5-1[1m]',
      effort: 'medium',
      providerConfig: { model: 'claude-fable-5-1[1m]', effort: 'medium' },
      providerFallback: { provider: 'claude' },
    });
    expect(config.providerConfig).toEqual({});
    expect(config.model).toBeUndefined();
    expect(config.effort).toBeUndefined();
  });

  it('drops Codex file settings when a Claude-pinned session falls back to its file provider', () => {
    process.env.NANOCLAW_PROVIDER_OVERRIDE = 'codex';
    process.env.NANOCLAW_PROVIDER_FALLBACK_APPLIED = '1';
    const config = parseRawConfig({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      providerConfig: { model: 'gpt-5.6-sol', reasoning_effort: 'high' },
      providerFallback: { provider: 'codex' },
    });
    expect(config.providerConfig).toEqual({});
    expect(config.model).toBeUndefined();
    expect(config.effort).toBeUndefined();
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

  it('surfaces a claude fallback declaration on model/effort for the spawn env', () => {
    // These two fields are how a fallback declaration leaves parseRawConfig.
    // They used to be folded into ClaudeProvider's sticky config by a
    // container-side guard with its own copy of the host model vocabulary;
    // that guard is gone (it drew three findings in three rounds), because the
    // host already resolves and validates the declaration into
    // NANOCLAW_CLAUDE_MODEL, which the provider reads directly.
    process.env.NANOCLAW_PROVIDER_OVERRIDE = 'claude';
    const fallback = parseRawConfig({
      ...BASE,
      providerFallback: { provider: 'claude', model: 'claude-fable-5-1[1m]', effort: 'medium' },
    });
    expect(fallback.model).toBe('claude-fable-5-1[1m]');
    expect(fallback.effort).toBe('medium');
    // The primary's sticky config is dropped: it is the wrong provider's, and
    // codex's `reasoning_effort` key is a fatal boot error under claude's
    // strict schema.
    expect(fallback.providerConfig).toEqual({});

    clearEnv();
    const primary = parseRawConfig({
      provider: 'claude',
      model: 'claude-fable-5-1[1m]',
      effort: 'medium',
      providerFallback: { provider: 'codex' },
    });
    expect(primary.model).toBe('claude-fable-5-1[1m]');
    expect(primary.effort).toBe('medium');
  });
});
