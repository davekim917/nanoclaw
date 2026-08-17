import { describe, it, expect } from 'vitest';
import { cronToEnglish, formatEasternTime } from './cron-format.js';

describe('cronToEnglish', () => {
  it('daily at a fixed time', () => {
    expect(cronToEnglish('0 12 * * *')).toBe('daily at 12:00 PM');
  });

  it('every N minutes', () => {
    expect(cronToEnglish('*/15 * * * *')).toBe('every 15 minutes');
  });

  it('weekly on a weekday', () => {
    expect(cronToEnglish('0 22 * * 1')).toBe('weekly on Monday at 10:00 PM');
  });

  it('monthly on a day of month', () => {
    expect(cronToEnglish('30 4 1 * *')).toBe('monthly on day 1 at 4:30 AM');
  });

  it('falls back to null on an invalid string', () => {
    expect(cronToEnglish('not a cron')).toBeNull();
  });

  it('falls back to null on an irregular shape it does not cover', () => {
    // A list of hours — not one of the covered shapes — must not produce a
    // guessed sentence.
    expect(cronToEnglish('0 8,13,22 * * 1-5')).toBeNull();
  });

  it('every N hours', () => {
    expect(cronToEnglish('0 */2 * * *')).toBe('every 2 hours');
  });

  it('minute list, every hour', () => {
    expect(cronToEnglish('15,45 * * * *')).toBe('every hour at :15 and :45');
  });

  it('minute list, three values uses Oxford comma', () => {
    expect(cronToEnglish('0,20,40 * * * *')).toBe('every hour at :00, :20, and :40');
  });

  it('hour list, daily', () => {
    expect(cronToEnglish('0 9,17 * * *')).toBe('daily at 9:00 AM and 5:00 PM');
  });

  it('weekday list', () => {
    expect(cronToEnglish('0 12 * * 1,4')).toBe('Mondays and Thursdays at 12:00 PM');
  });

  it('minute step with an hour range', () => {
    expect(cronToEnglish('*/10 8-18 * * *')).toBe('every 10 minutes, 8 AM–6 PM');
  });

  it('falls back to null on an out-of-range hour list', () => {
    expect(cronToEnglish('0 9,25 * * *')).toBeNull();
  });

  it('falls back to null on an invalid hour range', () => {
    expect(cronToEnglish('*/10 18-8 * * *')).toBeNull();
  });
});

describe('formatEasternTime', () => {
  it('renders EST (winter) correctly from a UTC instant', () => {
    // 12:00 UTC in January is EST (UTC-5) → 7:00 AM ET.
    expect(formatEasternTime('2026-01-15T12:00:00.000Z')).toBe('7:00 AM ET');
  });

  it('renders EDT (summer) correctly from the same UTC hour — DST-sensitive', () => {
    // 16:00 UTC in August is EDT (UTC-4) → 12:00 PM ET, not the 11:00 AM
    // winter would give for the same clock hour.
    expect(formatEasternTime('2026-08-17T16:00:00.000Z')).toBe('12:00 PM ET');
  });

  it('returns null for no timestamp', () => {
    expect(formatEasternTime(null)).toBeNull();
  });

  it('returns null for an invalid timestamp', () => {
    expect(formatEasternTime('not a date')).toBeNull();
  });
});
