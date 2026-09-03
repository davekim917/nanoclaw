import fs from 'fs';
import path from 'path';

import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  canonicalizeIanaTimezone,
  formatLocalTime,
  isIanaTimezone,
  isValidTimezone,
  parseZonedToUtc,
  resolveTimezone,
  timezoneRejectionReason,
} from './timezone.js';

// --- formatLocalTime ---

describe('formatLocalTime', () => {
  it('converts UTC to local time display', () => {
    // 2026-02-04T18:30:00Z in America/New_York (EST, UTC-5) = 1:30 PM
    const result = formatLocalTime('2026-02-04T18:30:00.000Z', 'America/New_York');
    expect(result).toContain('1:30');
    expect(result).toContain('PM');
    expect(result).toContain('Feb');
    expect(result).toContain('2026');
  });

  it('handles different timezones', () => {
    // Same UTC time should produce different local times
    const utc = '2026-06-15T12:00:00.000Z';
    const ny = formatLocalTime(utc, 'America/New_York');
    const tokyo = formatLocalTime(utc, 'Asia/Tokyo');
    // NY is UTC-4 in summer (EDT), Tokyo is UTC+9
    expect(ny).toContain('8:00');
    expect(tokyo).toContain('9:00');
  });

  it('does not throw on invalid timezone, falls back to UTC', () => {
    expect(() => formatLocalTime('2026-01-01T00:00:00.000Z', 'IST-2')).not.toThrow();
    const result = formatLocalTime('2026-01-01T12:00:00.000Z', 'IST-2');
    // Should format as UTC (noon UTC = 12:00 PM)
    expect(result).toContain('12:00');
    expect(result).toContain('PM');
  });
});

describe('isValidTimezone', () => {
  it('accepts valid IANA identifiers', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    expect(isValidTimezone('Asia/Jerusalem')).toBe(true);
  });

  it('rejects invalid timezone strings', () => {
    expect(isValidTimezone('IST-2')).toBe(false);
    expect(isValidTimezone('XYZ+3')).toBe(false);
  });

  it('rejects empty and garbage strings', () => {
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('NotATimezone')).toBe(false);
  });
});

describe('resolveTimezone', () => {
  it('returns the timezone if valid', () => {
    expect(resolveTimezone('America/New_York')).toBe('America/New_York');
  });

  it('falls back to UTC for invalid timezone', () => {
    expect(resolveTimezone('IST-2')).toBe('UTC');
    expect(resolveTimezone('')).toBe('UTC');
  });
});

describe('parseZonedToUtc', () => {
  const iso = (s: string, tz: string): string => parseZonedToUtc(s, tz).toISOString();

  it('reads a naive timestamp as wall-clock in a fixed-offset zone', () => {
    expect(iso('2026-06-20T09:00:00', 'Asia/Tokyo')).toBe('2026-06-20T00:00:00.000Z'); // UTC+9
  });

  it('applies the correct seasonal offset (DST honored)', () => {
    // Same wall-clock time, different UTC offset by season — proves the offset
    // is computed against the zone's rules, not a fixed guess.
    expect(iso('2026-07-01T12:00:00', 'America/New_York')).toBe('2026-07-01T16:00:00.000Z'); // EDT -4
    expect(iso('2026-01-01T12:00:00', 'America/New_York')).toBe('2026-01-01T17:00:00.000Z'); // EST -5
  });

  it('passes a trailing-Z timestamp through unchanged', () => {
    expect(iso('2026-06-20T09:00:00Z', 'Asia/Tokyo')).toBe('2026-06-20T09:00:00.000Z');
  });

  it('passes an explicit offset through', () => {
    expect(iso('2026-06-20T09:00:00+02:00', 'Asia/Tokyo')).toBe('2026-06-20T07:00:00.000Z');
  });

  it('falls back to UTC for an invalid zone', () => {
    expect(iso('2026-06-20T09:00:00', 'Not/AZone')).toBe('2026-06-20T09:00:00.000Z');
  });
});

// --- canonicalizeIanaTimezone / isIanaTimezone ---

const ZONEINFO_DIR = '/usr/share/zoneinfo';

/**
 * A zone this host's database actually has, so the suite asserts against the
 * same authority the code consults rather than against one machine's tzdata
 * vintage. Undefined only if the host has no zone database at all, which the
 * fail-closed tests below cover on their own.
 */
function anyLocalZone(): string | undefined {
  return ['Europe/Lisbon', 'Asia/Tokyo', 'America/New_York'].find((tz) => fs.existsSync(path.join(ZONEINFO_DIR, tz)));
}

describe('canonicalizeIanaTimezone', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a spelling the host zone database has', () => {
    const tz = anyLocalZone();
    if (!tz) return;
    expect(canonicalizeIanaTimezone(tz)).toBe(tz);
    expect(isIanaTimezone(tz)).toBe(true);
  });

  it('accepts UTC without consulting the zone database', () => {
    expect(canonicalizeIanaTimezone('UTC')).toBe('UTC');
  });

  it('rejects what POSIX TZ cannot open, however lenient ICU is', () => {
    // ICU accepts all three; none is a file the container can open.
    expect(canonicalizeIanaTimezone('asia/tokyo')).toBeNull(); // wrong case
    expect(canonicalizeIanaTimezone('+01:00')).toBeNull(); // opposite sign to POSIX
    expect(canonicalizeIanaTimezone('CST')).toBeNull(); // ambiguous abbreviation
  });

  it('FAILS CLOSED on a host with no zone database', () => {
    // The whole point of the check is that the stored string is handed to the
    // container as a POSIX `TZ` path. With no database to confirm a spelling
    // there is no second authority to fall back on — ICU would take
    // `asia/tokyo` and retired aliases — so nothing is honoured and the group
    // keeps the install timezone.
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => !String(p).startsWith(ZONEINFO_DIR));
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p).startsWith(ZONEINFO_DIR)) throw enoent;
      throw enoent;
    }) as typeof fs.statSync);

    expect(canonicalizeIanaTimezone('Europe/Lisbon')).toBeNull();
    expect(canonicalizeIanaTimezone('Asia/Tokyo')).toBeNull();
    expect(isIanaTimezone('Europe/Lisbon')).toBe(false);
    // UTC needs no database entry and stays available.
    expect(canonicalizeIanaTimezone('UTC')).toBe('UTC');
    expect(timezoneRejectionReason('Europe/Lisbon')).toContain('no zone database');
  });
});
