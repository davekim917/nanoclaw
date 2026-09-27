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

/** Region/City or UTC: the only shapes Intl and POSIX `TZ` agree on (POSIX reads `TZ=+01:00` as UTC-1). */
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
 * The spelling of `tz` safe to persist as a per-group override, or null. Stored VERBATIM and opened by the
 * container as a case-sensitive POSIX `TZ` path, so the zone database on disk is the authority: ICU accepts
 * lowercase and retired aliases (`Asia/Calcutta` silently yields +0000 on current tzdata). Intl must accept it
 * too. FAILS CLOSED when the zone database is absent. Checks the HOST's database, not the agent image's.
 */
export function canonicalizeIanaTimezone(tz: string): string | null {
  if (!isValidTimezone(tz) || !isRegionZoneShape(tz)) return null;
  if (tz === 'UTC') return tz;
  return zoneFileExists(tz) ? tz : null;
}

/** Whether a STORED override is safe to honour: the write-path gate, so an unopenable hand-edited value falls back to the install timezone. */
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
