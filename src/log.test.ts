import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log, LOG_STAMP_RE, parseLogStamp } from './log.js';

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
    const match = calls[0]!.match(LOG_STAMP_RE);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('2026-01-15 14:09:07.042');
    // The naive UTC hour (19) must not leak in — this is what would happen
    // if ts() regressed to getUTCHours()/toISOString() style formatting.
    expect(match![1]).not.toContain('19:09:07');
  });

  it('carries the numeric UTC offset, so the instant survives a foreign reader', () => {
    log.info('hello');

    const match = calls[0]!.match(LOG_STAMP_RE);
    expect(match![2]).toBe('-05:00');
    // The whole point: recovered WITHOUT reference to the reader's own zone.
    const parsed = parseLogStamp(match![1], match![2]);
    expect(parsed).toEqual({ ms: Date.parse('2026-01-15T19:09:07.042Z'), exact: true });
  });
});

describe('parseLogStamp', () => {
  it('resolves an offset stamp to one instant regardless of reader TZ', () => {
    const expected = Date.parse('2026-01-15T19:09:07.042Z');
    const originalTz = process.env.TZ;
    try {
      for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Asia/Kolkata']) {
        process.env.TZ = tz;
        expect(parseLogStamp('2026-01-15 14:09:07.042', '-05:00')).toEqual({
          ms: expected,
          exact: true,
        });
      }
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('flags an offset-less (pre-change) stamp as inexact rather than guessing', () => {
    const parsed = parseLogStamp('2026-01-15 14:09:07.042');
    expect(parsed?.exact).toBe(false);
    // Best-effort local reading — the same value the pre-change code produced,
    // which is all that is recoverable once the offset was never written.
    expect(parsed?.ms).toBe(new Date(2026, 0, 15, 14, 9, 7, 42).getTime());
  });

  it('returns null for a malformed stamp instead of NaN', () => {
    expect(parseLogStamp('not-a-stamp')).toBeNull();
    expect(parseLogStamp('2026-13-99 99:99:99.999')).toBeNull();
  });

  it('matches both shapes, so 30 days of rotated logs keep parsing', () => {
    expect('[2026-01-15 14:09:07.042] INFO x'.match(LOG_STAMP_RE)?.[2]).toBeUndefined();
    expect('[2026-01-15 14:09:07.042-05:00] INFO x'.match(LOG_STAMP_RE)?.[2]).toBe('-05:00');
  });
});
