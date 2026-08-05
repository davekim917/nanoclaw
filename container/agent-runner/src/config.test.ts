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

  it('a provider override alone does not strip the declared model', () => {
    process.env.NANOCLAW_PROVIDER_OVERRIDE = 'claude';
    const config = parseRawConfig({ ...BASE });
    expect(config.provider).toBe('claude');
    expect(config.model).toBe('gpt-5.6-sol');
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
