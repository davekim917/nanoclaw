/**
 * Banned-pattern scan for the always-on instruction surface: point-in-time content, and a per-PR push cap
 * (round 3 is the agent's pr-review-loop checkpoint; a cap only yields an escalation). Kept out of
 * `fleet-drift.ts` so importing it does not load `better-sqlite3`. No byte ceilings: trimming to a number is no bar.
 */

const BANNED_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'iso_date', re: /\b20\d{2}-\d{2}-\d{2}\b/ },
  { name: 'issue_or_pr_ref', re: /(?:^|[\s(])#\d{2,}\b/ },
  { name: 'xzo_ref', re: /\bXZO-\d+\b/ },
  { name: 'current_focus_header', re: /^#+\s*Current Focus/im },
  {
    name: 'push_cap',
    re: /\b(?:max(?:imum)?|at most|no more than|up to)\s+(?:\d+|one|two|three|four|five)\s+pushes\b|\b(?:\d+|one|two|three|four|five)[- ]push\s+(?:cap|limit|budget)\b/i,
  },
];

export function scanBannedPatterns(content: string): string[] {
  return BANNED_PATTERNS.filter(({ re }) => re.test(content)).map(({ name }) => name);
}
