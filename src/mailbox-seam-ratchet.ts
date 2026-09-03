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
  // The mailbox module's two transitional handle accessors. PR 7 deleted them,
  // and these entries stay as the tripwire: a caller that moves onto
  // withMailboxSession but then hands the open handle to a helper has not
  // finished migrating, and reintroducing an accessor under either name would
  // make that file an offender again rather than let it pass clean.
  'legacyInboundHandle',
  'legacyOutboundHandle',
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

/**
 * The same strip, but LENGTH-PRESERVING: every comment character becomes a
 * space and every newline survives, so an offset into the result is an offset
 * into the original.
 *
 * `stripComments` deletes, which shifts every offset after the first comment —
 * fine for the boolean pattern checks that consume it, wrong for any rule that
 * reports a line number. The two exist side by side rather than merged because
 * deleting also JOINS the text either side of a comment, and patterns (a)-(d)
 * were reviewed against that behaviour.
 */
function blankComments(src: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])(\/\/.*)$/gm, (_m, head, comment) => head + blank(comment));
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

/* ─── Inbound-keyed sessions doing outbound-only work ──────────────────────── */

/**
 * A `withMailboxSession` / `withExistingMailboxSession` action whose body uses
 * ONLY outbound-side ops.
 *
 * The mailbox session's existence check is keyed on inbound.db. An action that
 * needs nothing from inbound.db but is wrapped in one therefore answers
 * `undefined` for a real cohort — a session whose inbound.db is gone while
 * outbound.db remains — and the caller reports outbound state as empty when it
 * is not. That is not hypothetical: it is the bug the usage rollup carried
 * (fixed by reading through the outbound funnel) and the one
 * `thread-close.ts`'s done-proposal read carried.
 *
 * The fix for a flagged site is `withExistingNanoclawOutbound`, the
 * outbound-keyed funnel, which asks an outbound-only existence question.
 *
 * Heuristic by construction, and deliberately conservative in the safe
 * direction: an action mentioning even one inbound-side op is not reported, and
 * an op this scanner cannot classify counts as inbound (see op-sides.ts). So it
 * under-reports rather than crying wolf.
 */
export interface OutboundOnlySessionMatch {
  file: string;
  line: number;
  ops: string[];
}

const SESSION_OPENERS = ['withMailboxSession', 'withExistingMailboxSession'];

interface CallSite {
  /** The callee's name. */
  name: string;
  /** Offset of the callee name in `src`. */
  index: number;
  /** Offset of the closing paren, so one call's span can contain another's. */
  end: number;
  /** Everything between the parens — the arguments, action callback included. */
  body: string;
}

/** Every call to a function whose name matches `namePattern`, with its span. */
function callSites(src: string, namePattern: string): CallSite[] {
  const out: CallSite[] = [];
  const re = new RegExp(`\\b(${namePattern})\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) {
          out.push({ name: m[1], index: m.index, end: i, body: src.slice(open + 1, i) });
          break;
        }
      }
    }
  }
  return out;
}

/** The action body of one session call, found by balancing from its open paren. */
function sessionCallBodies(src: string): Array<{ index: number; body: string }> {
  return callSites(src, `(?:${SESSION_OPENERS.join('|')})`).map(({ index, body }) => ({ index, body }));
}

/**
 * Every inbound-keyed session call in `roots` whose action uses only
 * outbound-side ops. `outboundOps` is injected so a test can drive the checker
 * over a string without touching the real module.
 */
export function findOutboundOnlySessions(
  sources: Array<{ file: string; src: string }>,
  sides: { inbound: ReadonlySet<string>; outbound: ReadonlySet<string> },
): OutboundOnlySessionMatch[] {
  const found: OutboundOnlySessionMatch[] = [];
  for (const { file, src } of sources) {
    const stripped = stripComments(src);
    for (const { index, body } of sessionCallBodies(stripped)) {
      // Ops invoked on whatever the action named its parameter. Matching
      // `<ident>.<op>(` rather than a fixed `mailbox.` keeps it working for the
      // handful of sites that name it something else.
      const ops = [...body.matchAll(/\b[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\s*\(/g)].map((x) => x[1]);
      // BOTH sides, or a mixed action reads as outbound-only: filtering the
      // inbound ops out before the `every` below made the check vacuously true
      // for exactly the actions it must not flag.
      const sessionOps = ops.filter((op) => sides.outbound.has(op) || sides.inbound.has(op));
      if (sessionOps.length === 0) continue;
      if (!sessionOps.every((op) => sides.outbound.has(op))) continue;
      found.push({
        file,
        line: stripped.slice(0, index).split('\n').length,
        ops: [...new Set(sessionOps)],
      });
    }
  }
  return found;
}

/** Non-test host sources, for the check above. */
export function hostSourcesForOutboundScan(): Array<{ file: string; src: string }> {
  return listTsFiles('src').map((file) => ({ file, src: fs.readFileSync(path.join(REPO_ROOT, file), 'utf8') }));
}

/* ─── Host outbound writes outside the stopped-container guard ─────────────── */

/**
 * The one sanctioned way for the host to write a session's `outbound.db`.
 *
 * `outbound.db` has a single writer. The host may write it only while no
 * container owns the session, and the check has to sit INSIDE the session and
 * immediately before the mutation, with no await between the two: opening a
 * mailbox session is a yield, and a wake landing in that gap starts a container
 * that now owns the file. `withStoppedContainerSession` (src/host-sweep.ts) is
 * that shape — it re-checks `containerOwnsOutbound()` inside the session and
 * resolves `undefined` when a container took it.
 */
export const OUTBOUND_WRITE_GUARD = 'withStoppedContainerSession';

/**
 * A host-side session action that MUTATES `outbound.db` without that guard.
 *
 * This is a structural close on a defect class rather than a lint: four
 * separate review rounds found instances of it by reading, and reading is not
 * a repeatable check. Each instance costs the same way — the write lands on a
 * file a live container owns, deleting the fresh runner's processing claim,
 * pushing its continuation back to `queued`, or contending for the write lock.
 *
 * Reach, stated plainly so the residue is not mistaken for coverage: the check
 * is LEXICAL. It sees a write op called on a session inside a `with*Session(…)`
 * action. It does NOT see a write reached through a `SessionRunner`-style
 * callback parameter, or one made by a helper the action calls, because the op
 * name is not in the body it scans. Those sites carry the ownership check
 * inline instead; they are outside this rule, not exempt from the property.
 */
export interface OutboundWriteMatch {
  file: string;
  line: number;
  /** The session opener the action was passed to. */
  opener: string;
  ops: string[];
}

/**
 * Every host-side session action that writes `outbound.db` outside the guard.
 *
 * `writeOps` is injected (from `outboundWriteOps()`) so a test can drive the
 * checker over a fixture string without touching the real module.
 */
export function findUnguardedOutboundWrites(
  sources: Array<{ file: string; src: string }>,
  writeOps: ReadonlySet<string>,
): OutboundWriteMatch[] {
  const found: OutboundWriteMatch[] = [];
  for (const { file, src } of sources) {
    // Length-preserving, so the reported line is the line in the real file.
    const stripped = blankComments(src);
    // Spans of every guarded session, so a write nested inside one is exempt
    // however deeply it is wrapped.
    const guarded = callSites(stripped, OUTBOUND_WRITE_GUARD).map((c) => ({ from: c.index, to: c.end }));
    for (const call of callSites(stripped, 'with[A-Za-z0-9_$]*Session')) {
      if (call.name === OUTBOUND_WRITE_GUARD) continue;
      if (guarded.some((g) => call.index > g.from && call.index < g.to)) continue;
      const ops = [...call.body.matchAll(/\b[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\s*\(/g)]
        .map((x) => x[1])
        .filter((op) => writeOps.has(op));
      if (ops.length === 0) continue;
      found.push({
        file,
        line: stripped.slice(0, call.index).split('\n').length,
        opener: call.name,
        ops: [...new Set(ops)],
      });
    }
  }
  return found;
}
