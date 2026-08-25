import { afterEach, describe, expect, it, vi } from 'vitest';

describe('TASK_SCRIPT_TIMEOUT_MS', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // The constant is captured at module import (config.ts documents the
  // import-order trap itself), so each case re-imports with its own env.
  it('defaults to 120s when the env var is absent', async () => {
    vi.resetModules();
    delete process.env.NANOCLAW_TASK_SCRIPT_TIMEOUT_MS;
    const cfg = await import('./config.js');
    expect(cfg.TASK_SCRIPT_TIMEOUT_MS).toBe(120_000);
  });

  it('clamps absurd overrides to ten minutes', async () => {
    vi.resetModules();
    vi.stubEnv('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS', '120000000');
    const cfg = await import('./config.js');
    expect(cfg.TASK_SCRIPT_TIMEOUT_MS).toBe(600_000);
  });

  it('accepts a sane override and rejects garbage back to the default', async () => {
    vi.resetModules();
    vi.stubEnv('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS', '45000');
    let cfg = await import('./config.js');
    expect(cfg.TASK_SCRIPT_TIMEOUT_MS).toBe(45_000);

    vi.resetModules();
    vi.stubEnv('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS', 'not-a-number');
    cfg = await import('./config.js');
    expect(cfg.TASK_SCRIPT_TIMEOUT_MS).toBe(120_000);
  });
});
