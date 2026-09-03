/**
 * Check whether a timezone string is a valid IANA identifier
 * that Intl.DateTimeFormat can use.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Region/City, or UTC — the only shapes Intl and POSIX `TZ` agree on.
 *
 * A per-group override is handed to the container verbatim as POSIX `TZ`
 * while the host schedules through Intl, so the two must read the same string
 * the same way. Fixed offsets do not: POSIX `TZ=+01:00` means UTC-1, the
 * opposite sign. Region-less abbreviations do not either: POSIX reads a bare
 * `CST` as a zero-offset abbreviation, while Intl maps it to America/Chicago.
 */
function isRegionZoneShape(tz: string): boolean {
  return tz === 'UTC' || tz.includes('/');
}

/**
 * The spelling of `tz` safe to persist as a per-group override, or null.
 *
 * `isValidTimezone` is deliberately looser — it asks only whether Intl can
 * format with the value. This is the write-path gate, and what it returns is
 * what gets stored.
 *
 * Two rules, and the second one is why an earlier version of this was wrong:
 *
 * 1. The INPUT must name a region. An abbreviation is ambiguous — `CST` is US
 *    Central to ICU and China Standard to plenty of humans — so the operator
 *    is asked to say which, rather than having one picked for them. Fixed
 *    offsets are refused outright: POSIX reads `TZ=+01:00` as UTC-1.
 * 2. The STORED value is always what the resolver returns, never what was
 *    typed. Keeping the typed spelling looked friendlier and did not work:
 *    `asia/kolkata` resolves to `Asia/Calcutta`, so it cannot be case-corrected
 *    from its own resolution, and POSIX zoneinfo lookup is case-sensitive —
 *    the host would have scheduled on Kolkata time while the container read an
 *    unresolvable `TZ` and fell back to UTC. The resolver's answer is always a
 *    real tzdata name in the casing POSIX needs.
 *
 * The visible cost of rule 2 is that `Asia/Kolkata` is stored as its ICU
 * canonical `Asia/Calcutta`. Both are the same zone and both ship in tzdata;
 * `ncl groups config get` shows what was stored.
 */
export function canonicalizeIanaTimezone(tz: string): string | null {
  if (!isValidTimezone(tz)) return null;
  if (tz.toUpperCase() !== 'UTC' && !tz.includes('/')) return null;
  const resolved = Intl.DateTimeFormat(undefined, { timeZone: tz }).resolvedOptions().timeZone;
  return isRegionZoneShape(resolved) ? resolved : null;
}

/**
 * Whether a STORED override is safe to honour. Anything the write path would
 * have rewritten or refused — wrong case, an alias spelling, a fixed offset,
 * an abbreviation — is ignored in favour of the install timezone, so a
 * hand-edited value cannot split the host clock from the container clock.
 */
export function isIanaTimezone(tz: string): boolean {
  return canonicalizeIanaTimezone(tz) === tz;
}

/**
 * Return the given timezone if valid IANA, otherwise fall back to UTC.
 */
export function resolveTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : 'UTC';
}

/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 * Falls back to UTC if the timezone is invalid.
 */
export function formatLocalTime(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  return date.toLocaleString('en-US', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Compact sortable local stamp for log lines: "YYYY-MM-DD HH:mm" in `timezone`.
 * (sv-SE is the one locale whose default rendering is this exact shape.)
 */
export function formatLocalStamp(date: Date, timezone: string): string {
  return date.toLocaleString('sv-SE', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Interpret a naive ISO-like timestamp (no trailing `Z`, no offset) as wall-clock
 * time in `tz` and return the corresponding UTC Date. Strings that already carry
 * offset info (`Z` or `+-HH:MM`) are passed through to the Date constructor.
 */
export function parseZonedToUtc(input: string, tz: string): Date {
  const hasOffset = /Z$|[+-]\d{2}:?\d{2}$/.test(input.trim());
  if (hasOffset) return new Date(input);

  const zone = resolveTimezone(tz);
  const asIfUtc = new Date(input + 'Z');
  if (Number.isNaN(asIfUtc.getTime())) return asIfUtc;

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt
      .formatToParts(asIfUtc)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const zonedAsUtcMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMs = zonedAsUtcMs - asIfUtc.getTime();
  return new Date(asIfUtc.getTime() - offsetMs);
}
