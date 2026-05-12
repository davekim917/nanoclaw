import { describe, it, expect } from 'vitest';
import { nextDelayMs, formatElapsed, POLL_MS, MAX_BACKOFF_MS } from './container-rebuild-watcher.js';

describe('nextDelayMs', () => {
  it('returns POLL_MS at zero failures (healthy path)', () => {
    expect(nextDelayMs(0)).toBe(POLL_MS);
  });

  it('doubles each subsequent failure', () => {
    expect(nextDelayMs(1)).toBe(POLL_MS);          // 60s
    expect(nextDelayMs(2)).toBe(POLL_MS * 2);      // 2m
    expect(nextDelayMs(3)).toBe(POLL_MS * 4);      // 4m
    expect(nextDelayMs(4)).toBe(POLL_MS * 8);      // 8m
    expect(nextDelayMs(5)).toBe(POLL_MS * 16);     // 16m
    expect(nextDelayMs(6)).toBe(POLL_MS * 32);     // 32m
  });

  it('caps at MAX_BACKOFF_MS for high failure counts', () => {
    expect(nextDelayMs(7)).toBe(MAX_BACKOFF_MS);   // would be 64m, capped at 60m
    expect(nextDelayMs(100)).toBe(MAX_BACKOFF_MS);
    expect(nextDelayMs(1000)).toBe(MAX_BACKOFF_MS);
  });

  it('treats negative failures as zero', () => {
    expect(nextDelayMs(-1)).toBe(POLL_MS);
  });
});

describe('formatElapsed', () => {
  it('reports sub-1h in minutes, minimum 1', () => {
    expect(formatElapsed(0)).toBe('1m');
    expect(formatElapsed(60_000)).toBe('1m');
    expect(formatElapsed(5 * 60_000)).toBe('5m');
    expect(formatElapsed(59 * 60_000)).toBe('59m');
  });

  it('reports 1h-9h with one decimal place, trimmed', () => {
    expect(formatElapsed(3_600_000)).toBe('1h');
    expect(formatElapsed(4 * 3_600_000)).toBe('4h');
    expect(formatElapsed(4.5 * 3_600_000)).toBe('4.5h');
  });

  it('reports ≥10h as integer', () => {
    expect(formatElapsed(10 * 3_600_000)).toBe('10h');
    expect(formatElapsed(24 * 3_600_000)).toBe('24h');
  });
});
