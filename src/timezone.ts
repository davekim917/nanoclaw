import fs from 'fs';
import path from 'path';

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
 * Fixed offsets do not: POSIX reads `TZ=+01:00` as UTC-1, the opposite sign.
 * Region-less abbreviations do not either, and are ambiguous besides: `CST`
 * is US Central to ICU and China Standard to plenty of humans.
 */
function isRegionZoneShape(tz: string): boolean {
  return tz === 'UTC' || tz.includes('/');
}

/**
 * The zone database POSIX consumers actually read. `TZ` is opened as a file
 * path under here, case-sensitively.
 */
const ZONEINFO_DIR = '/usr/share/zoneinfo';

/** Whether the zone database on disk has this exact spelling. */
function zoneFileExists(tz: string): boolean {
  const file = path.join(ZONEINFO_DIR, tz);
  // Reject traversal before touching the filesystem: `tz` reaches here from a
  // CLI flag and an approval payload.
  if (!path.resolve(file).startsWith(`${ZONEINFO_DIR}/`)) return false;
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Correctly-cased spellings that differ from `tz` only by case, for an error hint. */
function zoneSpellingHints(tz: string): string[] {
  const wanted = tz.toLowerCase();
  const hits: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), name);
      else if (name.toLowerCase() === wanted) hits.push(name);
    }
  };
  walk(ZONEINFO_DIR, '');
  return hits;
}

/**
 * The spelling of `tz` safe to persist as a per-group override, or null.
 *
 * The value is stored VERBATIM and handed to the container as POSIX `TZ`,
 * which opens it as a case-sensitive path under the zone database. So the
 * database on disk is the authority on which spellings work — and it is the
 * only authority that turned out to be right. Two earlier rules both failed,
 * in opposite directions:
 *
 * - Keeping whatever was typed accepted `asia/kolkata`, which no POSIX
 *   consumer can open.
 * - Storing ICU's `resolvedOptions().timeZone` accepted `Asia/Kolkata` and
 *   stored the legacy `Asia/Calcutta`, whose backward-link file current
 *   tzdata omits. On tzdata 2026c, `TZ=Asia/Calcutta` silently yields +0000
 *   while `TZ=Asia/Kolkata` yields IST — the host would have scheduled in
 *   India while the container ran on UTC.
 *
 * Intl still has to accept the value too, so a name the host has a file for
 * but the scheduler cannot use is refused rather than half-working.
 *
 * FAILS CLOSED. If the zone database is absent, every override is refused and
 * the group keeps the install timezone. There is no second authority to fall
 * back to: ICU accepts `asia/tokyo` and retired aliases that POSIX cannot
 * open, and ICU's own canonical list is not a substitute either — on this
 * host's Node 22 build `Intl.supportedValuesOf('timeZone')` omits both
 * `UTC` and `Asia/Kolkata` while listing the legacy `Asia/Calcutta`,
 * i.e. exactly the alias the paragraph above rejects. Accepting an unverified
 * name splits the host clock from the container's; refusing one leaves the
 * group exactly where it was.
 *
 * BOUNDARY: this checks the HOST's zone database, not the agent image's. The
 * two are independent filesystems, so a host carrying newer tzdata than an
 * older image can accept a recently added or renamed zone the container
 * cannot resolve. That exposure is not new and not specific to per-group
 * overrides — the install-wide `TIMEZONE` from `.env` has reached every
 * container as `TZ` with no validation at all — and this check narrows it
 * rather than widening it. Closing it properly means asking the image, which
 * is tracked separately.
 */
export function canonicalizeIanaTimezone(tz: string): string | null {
  if (!isValidTimezone(tz) || !isRegionZoneShape(tz)) return null;
  if (tz === 'UTC') return tz;
  return zoneFileExists(tz) ? tz : null;
}

/**
 * Whether a STORED override is safe to honour. Identical to the write-path
 * gate, so a hand-edited value that POSIX could not open — wrong case, a
 * retired alias, a fixed offset, an abbreviation — is ignored in favour of the
 * install timezone rather than splitting the host clock from the container's.
 */
export function isIanaTimezone(tz: string): boolean {
  return canonicalizeIanaTimezone(tz) === tz;
}

/**
 * Human-facing reason `tz` was refused, for the `ncl` error. Suggests the
 * correctly-cased spelling when the only problem is case.
 */
export function timezoneRejectionReason(tz: string): string {
  if (!isValidTimezone(tz)) return `"${tz}" is not a timezone this runtime knows`;
  if (!isRegionZoneShape(tz)) {
    return `"${tz}" does not name a region — use a "Region/City" id like "Europe/Lisbon" (a fixed offset means the opposite sign to POSIX, and an abbreviation like "CST" is ambiguous)`;
  }
  if (!fs.existsSync(ZONEINFO_DIR)) {
    return `"${tz}" cannot be verified: this host has no zone database at ${ZONEINFO_DIR}, so an unverified id would reach the container as a POSIX TZ path it may not be able to open`;
  }
  const hints = zoneSpellingHints(tz);
  if (hints.length > 0)
    return `"${tz}" is misspelled for the zone database — use ${hints.map((h) => `"${h}"`).join(' or ')}`;
  return `"${tz}" has no entry in the zone database, so the container could not resolve it as POSIX TZ`;
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
