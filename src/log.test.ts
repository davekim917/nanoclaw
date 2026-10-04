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

describe('log never throws on unserializable data', () => {
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let written: string[];

  // Patched directly for the same reason as the timestamp tests above.
  beforeEach(() => {
    written = [];
    const capture = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = capture;
    process.stderr.write = capture;
  });

  afterEach(() => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  });

  const throwingTraps: ProxyHandler<object> = {
    get: () => {
      throw new Error('get trap');
    },
    ownKeys: () => {
      throw new Error('ownKeys trap');
    },
    getOwnPropertyDescriptor: () => {
      throw new Error('descriptor trap');
    },
  };

  it('logs a circular non-Error err value', () => {
    const err: Record<string, unknown> = { code: 'E_SINK' };
    err.self = err;
    expect(() => log.warn('sink failed', { err })).not.toThrow();
    expect(written.join('')).toContain('[Circular');
  });

  it('logs a circular value under any other key', () => {
    const node: Record<string, unknown> = { id: 1 };
    node.parent = { child: node };
    expect(() => log.error('bad node', { node })).not.toThrow();
    expect(written.join('')).toContain('[Circular');
  });

  it('logs BigInt values', () => {
    expect(() => log.warn('big', { err: 10n })).not.toThrow();
    expect(written.join('')).toContain('10n');
  });

  it('honors a top-level toJSON when stringify throws on its result', () => {
    // The BigInt in toJSON's result makes stringify throw, so the inspect fallback runs.
    const value = {
      token: 'SECRET',
      toJSON() {
        return { id: 1n };
      },
    };
    expect(() => log.warn('redacted', { err: value })).not.toThrow();
    const out = written.join('');
    expect(out).toContain('1n');
    expect(out).not.toContain('SECRET');
  });

  it('passes the root key to toJSON, as JSON.stringify does', () => {
    const value = {
      token: 'SECRET',
      toJSON(key: string) {
        return key === '' ? { id: 1n } : this;
      },
    };
    log.warn('keyed', { err: value });
    expect(written.join('')).not.toContain('SECRET');
  });

  it('never prints the raw value when toJSON throws', () => {
    const value = {
      token: 'SECRET',
      toJSON() {
        throw new Error('no');
      },
    };
    expect(() => log.warn('throwing toJSON', { err: value })).not.toThrow();
    const out = written.join('');
    expect(out).not.toContain('SECRET');
    expect(out).toContain('[unserializable]');
  });

  it('keeps other fields, but not the value, when a toJSON getter throws', () => {
    const err = {
      token: 'SECRET',
      get toJSON(): never {
        throw new Error('getter');
      },
    };
    log.warn('getter toJSON', { requestId: 'req-123', err });
    const out = written.join('');
    expect(out).toContain('req-123');
    expect(out).not.toContain('SECRET');
  });

  it('does not call toJSON twice', () => {
    const value = {
      token: 'SECRET',
      toJSON() {
        delete (this as { toJSON?: unknown }).toJSON;
        return { id: 1n };
      },
    };
    log.warn('once', { err: value });
    const out = written.join('');
    expect(out).toContain('1n');
    expect(out).not.toContain('SECRET');
  });

  it('keeps fields four levels deep when a sibling is a BigInt', () => {
    const err = { n: 1n, a: { b: { c: { d: { code: 'E_DEEP' } } } } };
    log.warn('deep', { err });
    expect(written.join('')).toContain('E_DEEP');
  });

  it('applies a nested redacting toJSON when a sibling is a BigInt', () => {
    const err = {
      n: 1n,
      creds: {
        token: 'SECRET',
        toJSON() {
          return { token: '[redacted]' };
        },
      },
    };
    log.warn('nested', { err });
    const out = written.join('');
    expect(out).toContain('[redacted]');
    expect(out).toContain('1n');
    expect(out).not.toContain('SECRET');
  });

  it('marks only a true cycle, not a value referenced twice', () => {
    const shared = { code: 'E_SHARED' };
    log.warn('dag', { err: { a: shared, b: shared, n: 1n } });
    const out = written.join('');
    expect(out.match(/E_SHARED/g)).toHaveLength(2);
    expect(out).not.toContain('[Circular');
  });

  it('survives a Proxy with throwing traps, as a value or as the data bag', () => {
    expect(() => log.warn('proxy value', { err: new Proxy({}, throwingTraps) })).not.toThrow();
    expect(() => log.warn('proxy bag', new Proxy({}, throwingTraps) as Record<string, unknown>)).not.toThrow();
    const out = written.join('');
    expect(out).toContain('proxy value');
    expect(out).toContain('proxy bag');
  });

  it('survives a throwing getter on the data bag itself', () => {
    const data = {
      ok: 1,
      get boom(): never {
        throw new Error('getter');
      },
    };
    expect(() => log.error('bag', data)).not.toThrow();
    expect(written.join('')).toContain('[log data unserializable]');
  });
});
