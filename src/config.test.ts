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

describe('REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // Ten minutes, not the 120s that still applies to every other quiescence
  // caller: publish/transfer run off the serial delivery drain, so waiting
  // longer for siblings to reach a safe point no longer freezes the fleet.
  it('defaults to ten minutes when the env var is absent', async () => {
    vi.resetModules();
    delete process.env.NANOCLAW_REPOSITORY_QUIESCE_TIMEOUT_MS;
    const cfg = await import('./config.js');
    expect(cfg.REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS).toBe(600_000);
  });

  it('accepts an override, clamps an absurd one to thirty minutes, and rejects garbage', async () => {
    vi.resetModules();
    vi.stubEnv('NANOCLAW_REPOSITORY_QUIESCE_TIMEOUT_MS', '900000');
    let cfg = await import('./config.js');
    expect(cfg.REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS).toBe(900_000);

    vi.resetModules();
    vi.stubEnv('NANOCLAW_REPOSITORY_QUIESCE_TIMEOUT_MS', '120000000');
    cfg = await import('./config.js');
    expect(cfg.REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS).toBe(30 * 60_000);

    vi.resetModules();
    vi.stubEnv('NANOCLAW_REPOSITORY_QUIESCE_TIMEOUT_MS', 'not-a-number');
    cfg = await import('./config.js');
    expect(cfg.REPOSITORY_MOUNT_QUIESCENCE_TIMEOUT_MS).toBe(600_000);
  });

  it('leaves the task-script knob on its own default and ceiling', async () => {
    vi.resetModules();
    vi.stubEnv('NANOCLAW_TASK_SCRIPT_TIMEOUT_MS', '120000000');
    const cfg = await import('./config.js');
    expect(cfg.TASK_SCRIPT_TIMEOUT_MS).toBe(600_000);
  });
});
