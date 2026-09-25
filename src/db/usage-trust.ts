/**
 * The Claude usage window no reader may present as a figure.
 *
 * Until the 2026-09-22 runner fix, a Claude turn that touched ONE model recorded the SDK's
 * per-turn main-loop `result.usage` beside the query-cumulative
 * `total_cost_usd`. The runner's `toTurnDelta` resets a whole row when any field falls,
 * and per-turn token counts fall constantly — so those rows booked the running
 * cost total raw (measured: $125.38, $125.51, $125.64 … on ~$0.13 turns),
 * while the rows that did subtract got an honest cost delta and meaningless
 * "this turn minus last turn" tokens that also omit same-model subagents.
 * Rows before 2026-08-24 carry the older running-total inflation described at
 * the top of ./usage.ts. Neither cost_usd nor the token columns of any Claude
 * row before the cutoff is a usable number, and list-pricing those tokens is
 * no repair: it undercounts subagents. Transcripts are the full-fidelity
 * source for a figure in this window.
 *
 * The rows are flagged at read time and never rewritten — the stored values
 * stay available for forensics, and a reader shows the note instead of a sum.
 * Codex and OpenCode rows are unaffected: neither went through this path.
 */

export const UNTRUSTED_USAGE_NOTE = 'untrusted, see #1061';

/**
 * First instant every live Claude container ran the fixed writer. The host
 * restart at 2026-09-22T17:06Z shipped it, but a container adopted across a
 * restart keeps its spawn-time runner until it exits (CLAUDE.md, Container
 * Restart): the last pre-fix container (spawned 12:13Z, adopted across that
 * restart) exited at 18:35:08.6Z, and no container spawned before 17:06Z was
 * running afterwards. A few correct rows between 17:06Z and this instant are
 * flagged with the rest — one global instant beats a per-session cutoff no
 * table records.
 */
export const CLAUDE_USAGE_TRUSTED_FROM = '2026-09-22T18:35:09.000Z';

/** usage_daily buckets by UTC day, so the day the cutoff falls in is untrusted whole. */
const CLAUDE_USAGE_LAST_UNTRUSTED_DAY = CLAUDE_USAGE_TRUSTED_FROM.slice(0, 10);

/** For a per-turn row (`turn_usage`), keyed on its ISO-8601 UTC `ts`. */
export function isUntrustedTurnUsage(provider: string, ts: string): boolean {
  return provider === 'claude' && Date.parse(ts) < Date.parse(CLAUDE_USAGE_TRUSTED_FROM);
}

/** For a day bucket (`usage_daily`), keyed on its `YYYY-MM-DD` UTC date. */
export function isUntrustedUsageDay(provider: string, date: string): boolean {
  return provider === 'claude' && date <= CLAUDE_USAGE_LAST_UNTRUSTED_DAY;
}

/**
 * The same predicate as SQL over `turn_usage` columns (optionally
 * table-qualified), for readers that aggregate in the database. Both sides go
 * through datetime() per the repo's timestamp rule.
 */
export function untrustedTurnUsageSql(alias = ''): string {
  const col = (name: string): string => (alias ? `${alias}.${name}` : name);
  return `(${col('provider')} = 'claude' AND datetime(${col('ts')}) < datetime('${CLAUDE_USAGE_TRUSTED_FROM}'))`;
}
