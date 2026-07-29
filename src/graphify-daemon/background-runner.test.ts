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
  it('runs freshness ahead of queued enrichment and preempts active enrichment', async () => {
    const runner = new BackgroundGraphRunner({
      sessionsRoot: '/nonexistent',
      pressure: () => false,
      freeMemory: () => 10_000_000_000,
      pollMs: 10,
    });
    const order: string[] = [];
    let enrichmentStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      enrichmentStarted = resolve;
    });
    const active = runner.run(async (signal) => {
      order.push('active-enrichment');
      enrichmentStarted();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    await started;
    const queued = runner.run(async () => {
      order.push('queued-enrichment');
    });
    const freshness = runner.run(
      async () => {
        order.push('freshness');
      },
      { priority: 'freshness', preemptActive: false },
    );

    expect((await active).status).toBe('preempted');
    expect((await freshness).status).toBe('completed');
    expect((await queued).status).toBe('completed');
    expect(order).toEqual(['active-enrichment', 'freshness', 'queued-enrichment']);
    await runner.stop();
  });

  it('preempts enrichment that arrives while the pressure probe is still pending', async () => {
    let releasePressure!: () => void;
    const pressureGate = new Promise<void>((resolve) => {
      releasePressure = resolve;
    });
    let probing!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      probing = resolve;
    });
    const runner = new BackgroundGraphRunner({
      sessionsRoot: '/nonexistent',
      freeMemory: () => 10_000_000_000,
      pollMs: 10,
      pressure: async () => {
        probing();
        await pressureGate;
        return false;
      },
    });
    const order: string[] = [];

    const enrichment = runner.run(async () => {
      order.push('enrichment-body');
    });
    // The enrichment job is inside execute(), awaiting the pressure probe. Its
    // abort controller must already be registered, or the freshness job below
    // has nothing to preempt and waits behind the batch it should have cut off.
    await probeStarted;
    const freshness = runner.run(
      async () => {
        order.push('freshness');
      },
      { priority: 'freshness', preemptActive: false },
    );
    releasePressure();

    expect((await enrichment).status).toBe('preempted');
    expect((await freshness).status).toBe('completed');
    expect(order).toEqual(['freshness']);
    await runner.stop();
  });

  it('settles the job when the pressure probe itself rejects', async () => {
    const runner = new BackgroundGraphRunner({
      sessionsRoot: '/nonexistent',
      freeMemory: () => 10_000_000_000,
      pollMs: 10,
      pressure: async () => {
        throw new Error('pressure scanner exited 1');
      },
    });
    let ran = false;

    // A rejecting probe used to escape execute(), so drain() threw after already
    // shifting the job off its queue and the run() promise never settled — the
    // semantic pump would then be latched forever.
    const first = await runner.run(async () => {
      ran = true;
    });
    expect(first.status).toBe('preempted');
    expect(ran).toBe(false);

    // The lane must still be usable afterwards.
    expect((await runner.run(async () => 'ok')).status).toBe('preempted');
    await runner.stop();
  });

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
