/**
 * Banned-pattern scan for the always-on instruction surface: point-in-time content. Kept out of
 * `fleet-drift.ts` so importing it does not load `better-sqlite3`. Deliberately no byte ceilings:
 * truncating a standing file to hit a number is not a quality bar.
 */

const BANNED_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'iso_date', re: /\b20\d{2}-\d{2}-\d{2}\b/ },
  { name: 'issue_or_pr_ref', re: /(?:^|[\s(])#\d{2,}\b/ },
  { name: 'xzo_ref', re: /\bXZO-\d+\b/ },
  { name: 'current_focus_header', re: /^#+\s*Current Focus/im },
];

export function scanBannedPatterns(content: string): string[] {
  return BANNED_PATTERNS.filter(({ re }) => re.test(content)).map(({ name }) => name);
}
