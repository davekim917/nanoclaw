/**
 * Raw session-DB access scanner for the mailbox-seam ratchet test
 * (src/mailbox-seam-ratchet.test.ts, docs/specs/upstream-mailbox-seam/plan.md §4.6.2).
 *
 * Finds every non-test .ts file under the two source trees, outside the mailbox
 * modules, that still touches session-DB internals directly: raw session-db
 * imports, raw opener imports, a `new Database(...)` call on an inbound/outbound
 * path, or a variable/parameter named like a passed-in session handle. The set
 * this reports must be a SUBSET of the committed RATCHET.json (the allowlist
 * only shrinks, one caller batch at a time, across PRs 2-7/R1-R3).
 *
 * Heuristic, not a parser — over-counts are acceptable (the brief allows it);
 * false negatives are not, so keep the patterns broad.
 *
 * Lives under src/ (not scripts/) so src/mailbox-seam-ratchet.test.ts can import
 * it — the host tsconfig's rootDir is src/. scripts/mailbox-seam-ratchet-scan.ts
 * is a thin CLI shim over this module (same split as
 * src/design-artifact-loop-vendor.ts + scripts/vendor-design-artifact-loop.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const RATCHET_SCAN_ROOTS: readonly string[] = ['src', 'container/agent-runner/src'];

/** Directories exempt from the scan — the mailbox driver and its fork module. */
export const RATCHET_EXCLUDED_DIRS: readonly string[] = [
  'src/mailbox/sqlite',
  'src/modules/mailbox',
  'container/agent-runner/src/mailbox/sqlite',
  'container/agent-runner/src/modules/mailbox',
];

/**
 * Files exempt from the scan by exact path.
 *
 *  - src/mailbox-seam-ratchet.ts (this module): names pattern (d)'s handle
 *    identifiers as string literals to search for them, which otherwise
 *    self-matches once this file lives under src/ (rootDir requires that —
 *    see the module doc comment above).
 *  - src/mailbox-seam-manifest.ts (sibling module): UPSTREAM_FILES /
 *    DEFERRED_UPSTREAM_FILES legitimately list upstream path strings like
 *    'src/mailbox/sqlite/session-db.ts' and 'session-db.test.ts' — pattern
 *    (a)'s whole-file 'session-db' substring check (round 5) otherwise
 *    self-matches on those string literals.
 *  - src/dashboard-pusher.ts: NOT present in the base tree — it only exists
 *    after a user runs the separate /add-dashboard skill, which copies
 *    .claude/skills/add-dashboard/resources/dashboard-pusher.ts here
 *    verbatim. That resource does raw session-DB reads for the dashboard's
 *    own message-volume charts; migrating it onto NanoclawAgentMailbox isn't
 *    buildable in this PR — the seam doesn't exist yet (host: PR 2, runner:
 *    R1). Tracked as a real, deliberate exclusion, not an oversight: this
 *    ratchet covers the mailbox-seam migration's own surface, not every
 *    skill-installed resource with its own install lifecycle and test file
 *    (dashboard-pusher.test.ts, alongside it in the skill resources dir).
 */
const RATCHET_EXCLUDED_FILES: readonly string[] = [
  'src/mailbox-seam-ratchet.ts',
  'src/mailbox-seam-manifest.ts',
  'src/dashboard-pusher.ts',
];

const RAW_OPENER_NAMES = [
  'openInboundDb',
  'openOutboundDb',
  'openOutboundDbRw',
  'openOutboundDbWritable',
  'withInboundDb',
  'inboundDbPath',
  'outboundDbPath',
  'getInboundDb',
  'getOutboundDb',
];

const HANDLE_IDENTIFIERS = ['inDb', 'outDb', 'inboundDb', 'outboundDb'];

function isExcluded(relPath: string): boolean {
  return RATCHET_EXCLUDED_DIRS.some((dir) => relPath === dir || relPath.startsWith(dir + '/'));
}

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const relDir = path.relative(REPO_ROOT, dir).split(path.sep).join('/');
    if (isExcluded(relDir)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const rel = path.relative(REPO_ROOT, full).split(path.sep).join('/');
        if (!isExcluded(path.dirname(rel)) && !RATCHET_EXCLUDED_FILES.includes(rel)) out.push(rel);
      }
    }
  };
  walk(path.join(REPO_ROOT, root));
  return out;
}

/** Naive comment strip — good enough for an allowlist scan, not a compiler. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function matchesPatternA(src: string): boolean {
  // (a) the literal 'session-db' appears anywhere in the file (comments already
  // stripped). Broadened from "an import from a path ending in session-db.js"
  // (PR #249 review round 5): a static-import-shaped regex misses a dynamic
  // `await import('.../session-db.js')`, a destructured re-export, or an alias
  // — a whole-file substring check covers all of those in one rule, so there is
  // no import-shape evasion of this class left to find.
  return src.includes('session-db');
}

function matchesPatternB(src: string): boolean {
  // (b) any raw opener/path-helper name appears anywhere in the file as a whole
  // word (comments already stripped). Broadened from "an import of any raw
  // opener/path helper name" (PR #249 review round 5, same reasoning as (a)):
  // covers static imports, dynamic import() with destructuring, and re-export
  // aliases in one rule.
  const re = new RegExp(`\\b(?:${RAW_OPENER_NAMES.join('|')})\\b`);
  return re.test(src);
}

function matchesPatternC(src: string): boolean {
  // (c) `new Database(` where either (c1) the constructor argument expression
  // itself names an inbound/outbound path — `new Database(inboundDbPath, ...)`,
  // `new Database(outboundPath, ...)` — regardless of where that variable was
  // built, or (c2) the inbound.db/outbound.db literal appears ANYWHERE in the
  // same file as a `new Database(` call — not just a 3-line window. A caller
  // can filter/validate a generically-named path variable (e.g. `filePath`)
  // against the literal in one function and open it with `new Database(...)`
  // in a completely different one; a same-file check still catches that
  // without tracking dataflow across functions.
  if (!/new\s+Database\s*\(/.test(src)) return false;
  const lines = src.split('\n');
  for (const line of lines) {
    const dbCall = line.match(/new\s+Database\s*\(\s*([^,)]*)/);
    if (dbCall && /inbound|outbound/i.test(dbCall[1])) return true;
  }
  return src.includes('inbound.db') || src.includes('outbound.db');
}

function matchesPatternD(src: string): boolean {
  // (d) a parameter or variable named like a passed session handle
  const re = new RegExp(`\\b(?:${HANDLE_IDENTIFIERS.join('|')})\\b`);
  return re.test(src);
}

export interface OffenderMatch {
  file: string;
  patterns: string[]; // subset of 'a' | 'b' | 'c' | 'd'
}

export function computeOffenders(): OffenderMatch[] {
  const offenders: OffenderMatch[] = [];
  for (const root of RATCHET_SCAN_ROOTS) {
    for (const relFile of listTsFiles(root)) {
      const abs = path.join(REPO_ROOT, relFile);
      const raw = fs.readFileSync(abs, 'utf8');
      const src = stripComments(raw);
      const patterns: string[] = [];
      if (matchesPatternA(src)) patterns.push('a');
      if (matchesPatternB(src)) patterns.push('b');
      if (matchesPatternC(src)) patterns.push('c');
      if (matchesPatternD(src)) patterns.push('d');
      if (patterns.length > 0) offenders.push({ file: relFile, patterns });
    }
  }
  return offenders.sort((x, y) => x.file.localeCompare(y.file));
}
