/**
 * Byte ceilings and the banned-pattern scan for the always-on instruction surface
 * (docs/specs/instruction-stack-prune/plan.md).
 *
 * Split out of `fleet-drift.ts` so the CI gate in `check-instruction-ceilings.ts`
 * can enforce these without importing the fleet-drift module, which pulls in
 * `better-sqlite3` at load. Comparing two byte counts must not need a DB driver.
 * `fleet-drift.ts` re-exports everything here, so its existing callers are unchanged.
 */

/** container/CLAUDE.md alone (shared base, not persona/fragments). */
export const CONTAINER_BYTES_CEILING = 10_240;
/** Repo-root CLAUDE.md alone — loads into every host session and any container agent working on the nanoclaw repo itself. */
export const TRUNK_DOC_BYTES_CEILING = 16_384;
/** Per group: its standing-instructions/persona file(s) + CLAUDE.local.md. */
export const GROUP_STANDING_BYTES_CEILING = 8_192;

const BANNED_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'iso_date', re: /\b20\d{2}-\d{2}-\d{2}\b/ },
  { name: 'issue_or_pr_ref', re: /(?:^|[\s(])#\d{2,}\b/ },
  { name: 'xzo_ref', re: /\bXZO-\d+\b/ },
  { name: 'current_focus_header', re: /^#+\s*Current Focus/im },
];

/** Names every banned pattern found in `content` — point-in-time facts that don't belong in a standing instruction file. */
export function scanBannedPatterns(content: string): string[] {
  return BANNED_PATTERNS.filter(({ re }) => re.test(content)).map(({ name }) => name);
}
