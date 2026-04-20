# timezone: v1 vs v2

## Scope
- v1: `src/v1/timezone.ts` (37 LOC), `src/v1/timezone.test.ts` (64 LOC)
- v2 counterparts: `src/timezone.ts` (37 LOC), `src/timezone.test.ts` (64 LOC)

## Capability map

| v1 behavior | v2 location | Status | Notes |
|---|---|---|---|
| `isValidTimezone(tz)` | `src/timezone.ts:5-12` | kept | Byte-identical |
| `resolveTimezone(tz)` | `src/timezone.ts:17-19` | kept | Byte-identical |
| `formatLocalTime(utcIso, timezone)` | `src/timezone.ts:26-37` | kept | Byte-identical |

## Tests (byte-identical)
- `formatLocalTime`: UTC→local display with offset; DST awareness (EDT vs EST); fall back to UTC on invalid tz without throwing
- `isValidTimezone`: accepts `America/New_York`, `UTC`, `Asia/Tokyo`, `Asia/Jerusalem`; rejects `IST-2`, `XYZ+3`, empty/garbage
- `resolveTimezone`: returns tz if valid; falls back to UTC on invalid or empty

## Missing from v2
None — v1 and v2 files are byte-for-byte identical.

## Behavioral discrepancies
None.

## Worth preserving?
No action needed — v2 already mirrors v1 exactly. Minimal, correct, no external deps. No cron-time conversions in either version (that logic lived in `task-scheduler.ts`).
