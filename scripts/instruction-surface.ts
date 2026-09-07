/**
 * Banned-pattern scan for the always-on instruction surface
 * (docs/specs/instruction-stack-prune/plan.md).
 *
 * Kept out of `fleet-drift.ts` so the scan can be imported and reasoned about
 * on its own, without loading that module (and `better-sqlite3` with it).
 * `fleet-drift.ts` re-exports it, so its existing callers are unchanged.
 *
 * There are deliberately no byte ceilings here: truncating a standing file to
 * hit an arbitrary number is not a quality bar. What a file must never carry is
 * point-in-time content, which is what this scan is for.
 */

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
