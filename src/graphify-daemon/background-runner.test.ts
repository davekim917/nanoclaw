import { describe, expect, it } from 'vitest';

import { BackgroundGraphRunner, linuxMemAvailableBytes } from './background-runner.js';

describe('Linux memory admission', () => {
  it('uses reclaim-aware MemAvailable capacity', () => {
    expect(
      linuxMemAvailableBytes(`MemTotal:       24550400 kB
MemFree:          336112 kB
MemAvailable:   16392504 kB
Cached:         14950632 kB`),
    ).toBe(16_392_504 * 1024);
  });

  it('rejects missing and unsafe MemAvailable values', () => {
    expect(linuxMemAvailableBytes('MemFree: 123 kB')).toBeUndefined();
    expect(linuxMemAvailableBytes('MemAvailable: not-a-number kB')).toBeUndefined();
    expect(linuxMemAvailableBytes('MemAvailable: 999999999999999999999 kB')).toBeUndefined();
  });
});

describe('BackgroundGraphRunner shutdown', () => {
  it('does not destroy an admitted non-preemptible job when pressure rises', async () => {
    let pressure = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runner = new BackgroundGraphRunner({
      sessionsRoot: '/nonexistent',
      pressure: () => pressure,
      freeMemory: () => 10_000_000_000,
      pollMs: 10,
    });
    let signalAborted = false;
    const result = runner.run(
      async (signal) => {
        markStarted();
        signal.addEventListener('abort', () => {
          signalAborted = true;
        });
        await gate;
        return 'complete';
      },
      { preemptActive: false },
    );
    await started;
    pressure = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signalAborted).toBe(false);
    release();
    expect(await result).toEqual({ status: 'completed', value: 'complete' });
    await runner.stop();
  });

  it('aborts active work and drains the serial lane before stop resolves', async () => {
    const runner = new BackgroundGraphRunner({
      sessionsRoot: '/nonexistent',
      pressure: () => false,
      freeMemory: () => 10_000_000_000,
      pollMs: 10,
    });
    let cleaned = false;
    const result = runner.run(async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      cleaned = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runner.stop();
    expect(cleaned).toBe(true);
    expect((await result).status).toBe('preempted');
  });
});
