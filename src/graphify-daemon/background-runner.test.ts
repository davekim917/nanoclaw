import { describe, expect, it } from 'vitest';

import { BackgroundGraphRunner } from './background-runner.js';

describe('BackgroundGraphRunner shutdown', () => {
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
