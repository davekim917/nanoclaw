/**
 * Timezone-correct parsing of a session-DB TIMESTAMP column.
 *
 * Lives in the mailbox module because it is a property of how these two
 * SQLite files store time, not of any one caller. `src/host-sweep.ts`
 * re-exports it under its historical name so existing importers are unchanged.
 */

/**
 * SQLite TIMESTAMP columns store UTC without a timezone marker. Date.parse
 * treats timezoneless ISO strings as local time, so on non-UTC hosts every
 * timestamp looks (TZ offset) hours stale — leading to spurious kill-claim
 * decisions on freshly-claimed messages. Append "Z" when no zone marker is
 * present so Date.parse interprets the string as UTC.
 */
export function parseSqliteUtc(s: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}

/**
 * The same reading, rendered back as a canonical ISO-8601 UTC string.
 *
 * Session-DB timestamp columns hold two shapes: the ISO form every JS writer
 * produces, and SQLite's naive `YYYY-MM-DD HH:MM:SS` left behind by older
 * writers. A value read out of one column and written into another has to be
 * normalized on the way through, or the naive shape propagates into a column
 * whose readers compare it as a string against ISO values.
 *
 * Unparseable input is returned unchanged — a column holding something that is
 * not a timestamp at all is a different defect, and silently substituting the
 * epoch for it would hide that.
 */
export function sqliteUtcToIso(value: string): string {
  const milliseconds = parseSqliteUtc(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}
