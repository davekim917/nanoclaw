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
