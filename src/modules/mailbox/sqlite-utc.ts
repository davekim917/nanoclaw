/**
 * SQLite TIMESTAMP columns store UTC without a zone marker, and Date.parse
 * reads a zoneless ISO string as LOCAL time. Append "Z" when no marker is present.
 */
export function parseSqliteUtc(s: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}

/**
 * Canonical ISO-8601 UTC. Columns hold both ISO and SQLite's naive
 * `YYYY-MM-DD HH:MM:SS`; normalize when copying between columns, since readers
 * compare as strings. Unparseable input is returned unchanged, never the epoch.
 */
export function sqliteUtcToIso(value: string): string {
  const milliseconds = parseSqliteUtc(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}
