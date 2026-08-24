import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from './log.js';

// ts() itself isn't exported — the log line prefix is the observable contract,
// so we capture it the way a real reader (host-health.ts, clidash) would: off
// process.stdout.write. vi.spyOn doesn't intercept process.stdout.write in
// this runner (inherited Writable.prototype method), so patch it directly.
describe('log line timestamp prefix', () => {
  const originalTz = process.env.TZ;
  const originalWrite = process.stdout.write;
  let calls: string[];

  beforeEach(() => {
    // A fixed, non-UTC, non-zero-offset zone with no DST wrinkle in January —
    // proves the stamp is install-local time, not UTC.
    process.env.TZ = 'America/New_York';
    vi.useFakeTimers();
    // 2026-01-15T19:09:07.042Z == 2026-01-15 14:09:07.042 in America/New_York (UTC-5).
    vi.setSystemTime(new Date('2026-01-15T19:09:07.042Z'));
    calls = [];
    process.stdout.write = ((chunk: string) => {
      calls.push(chunk);
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    vi.useRealTimers();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('stamps YYYY-MM-DD HH:mm:ss.mmm in local time, not UTC', () => {
    log.info('hello');

    expect(calls).toHaveLength(1);
    const match = calls[0]!.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('2026-01-15 14:09:07.042');
    // The naive UTC hour (19) must not leak in — this is what would happen
    // if ts() regressed to getUTCHours()/toISOString() style formatting.
    expect(match![1]).not.toContain('19:09:07');
  });
});
