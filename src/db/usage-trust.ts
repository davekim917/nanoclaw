/**
 * The Claude usage window no reader may present as a figure. Before the 2026-09-22 runner fix, single-model Claude
 * turns booked the query-cumulative `total_cost_usd` as a per-turn delta, and token columns were likewise wrong (rows
 * before 2026-08-24 carry an older running-total inflation). Neither cost nor tokens of a Claude row before the
 * cutoff is usable, and list-pricing the tokens undercounts subagents; transcripts are the full-fidelity source.
 * Rows are flagged at read time, never rewritten. Codex and OpenCode rows are unaffected.
 */

export const UNTRUSTED_USAGE_NOTE = 'untrusted, see #1061';

/**
 * First instant every live Claude container ran the fixed writer. Later than the fixing restart because an adopted
 * container keeps its spawn-time runner until it exits; one global instant beats a per-session cutoff no table
 * records.
 */
export const CLAUDE_USAGE_TRUSTED_FROM = '2026-09-22T18:35:09.000Z';

/** usage_daily buckets by UTC day, so the cutoff day is untrusted whole. */
const CLAUDE_USAGE_LAST_UNTRUSTED_DAY = CLAUDE_USAGE_TRUSTED_FROM.slice(0, 10);

/** Keyed on the row's ISO-8601 UTC `ts`. */
export function isUntrustedTurnUsage(provider: string, ts: string): boolean {
  return provider === 'claude' && Date.parse(ts) < Date.parse(CLAUDE_USAGE_TRUSTED_FROM);
}

/** Keyed on the bucket's `YYYY-MM-DD` UTC date. */
export function isUntrustedUsageDay(provider: string, date: string): boolean {
  return provider === 'claude' && date <= CLAUDE_USAGE_LAST_UNTRUSTED_DAY;
}

/** The same predicate as SQL, optionally table-qualified; both sides go through datetime() per the timestamp rule. */
export function untrustedTurnUsageSql(alias = ''): string {
  const col = (name: string): string => (alias ? `${alias}.${name}` : name);
  return `(${col('provider')} = 'claude' AND datetime(${col('ts')}) < datetime('${CLAUDE_USAGE_TRUSTED_FROM}'))`;
}
