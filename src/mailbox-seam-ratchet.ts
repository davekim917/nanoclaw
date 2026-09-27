/**
 * Raw session-DB access scanner for the mailbox-seam ratchet test; what it reports must be a subset of
 * RATCHET.json. Heuristic: over-counts are acceptable, false negatives are not, so keep the patterns broad.
 * Lives under src/ because the host tsconfig's rootDir is src/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const RATCHET_SCAN_ROOTS: readonly string[] = ['src', 'container/agent-runner/src'];

const RATCHET_EXCLUDED_DIRS: readonly string[] = [
  'src/mailbox/sqlite',
  'src/modules/mailbox',
  'container/agent-runner/src/mailbox/sqlite',
  'container/agent-runner/src/modules/mailbox',
];

/**
 * This module and the manifest self-match on string literals naming the patterns. dashboard-pusher.ts exists only
 * after /add-dashboard installs it, with its own lifecycle; its exclusion is deliberate.
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
  // Deleted accessors kept as a tripwire against reintroduction.
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

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Length-preserving strip, for rules that report line numbers. Not merged with `stripComments`, whose deletion
 * also joins the text either side of a comment, which patterns (a)-(d) were reviewed against.
 */
function blankComments(src: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])(\/\/.*)$/gm, (_m, head, comment) => head + blank(comment));
}

function matchesPatternA(src: string): boolean {
  // Whole-file substring, not an import regex, so dynamic imports and re-export aliases can't evade it.
  return src.includes('session-db');
}

function matchesPatternB(src: string): boolean {
  const re = new RegExp(`\\b(?:${RAW_OPENER_NAMES.join('|')})\\b`);
  return re.test(src);
}

function matchesPatternC(src: string): boolean {
  // Same-file literal check, since a generically-named path can be validated in one function and opened in another.
  if (!/new\s+Database\s*\(/.test(src)) return false;
  const lines = src.split('\n');
  for (const line of lines) {
    const dbCall = line.match(/new\s+Database\s*\(\s*([^,)]*)/);
    if (dbCall && /inbound|outbound/i.test(dbCall[1])) return true;
  }
  return src.includes('inbound.db') || src.includes('outbound.db');
}

function matchesPatternD(src: string): boolean {
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

/**
 * A mailbox-session action using only outbound-side ops. The session's existence check is keyed on inbound.db,
 * so it answers `undefined` when only inbound.db is gone and outbound state reads as empty. Fix: use
 * `withExistingNanoclawOutbound`. Unclassifiable ops count as inbound, so this under-reports.
 */
export interface OutboundOnlySessionMatch {
  file: string;
  line: number;
  ops: string[];
}

const SESSION_OPENERS = ['withMailboxSession', 'withExistingMailboxSession'];

interface CallSite {
  name: string;
  index: number;
  end: number;
  body: string;
}

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

function sessionCallBodies(src: string): Array<{ index: number; body: string }> {
  return callSites(src, `(?:${SESSION_OPENERS.join('|')})`).map(({ index, body }) => ({ index, body }));
}

export function findOutboundOnlySessions(
  sources: Array<{ file: string; src: string }>,
  sides: { inbound: ReadonlySet<string>; outbound: ReadonlySet<string> },
): OutboundOnlySessionMatch[] {
  const found: OutboundOnlySessionMatch[] = [];
  for (const { file, src } of sources) {
    // Length-preserving, so the reported line is the line in the real file.
    const stripped = blankComments(src);
    for (const { index, body } of sessionCallBodies(stripped)) {
      const ops = [...body.matchAll(/\b[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\s*\(/g)].map((x) => x[1]);
      // Keep both sides, or a mixed action would read as outbound-only.
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

export function hostSourcesForOutboundScan(): Array<{ file: string; src: string }> {
  return listTsFiles('src').map((file) => ({ file, src: fs.readFileSync(path.join(REPO_ROOT, file), 'utf8') }));
}

/**
 * The one sanctioned way for the host to write `outbound.db`: the no-container check sits inside the session with
 * no await before the mutation, because opening a session yields and a wake in that gap starts an owner.
 */
export const OUTBOUND_WRITE_GUARD = 'withStoppedContainerSession';

/**
 * A host session action that mutates `outbound.db` without the guard. Lexical only: it does not see writes via a
 * callback parameter or helper, nor via `withExistingNanoclawOutbound`. Those are outside the rule, not exempt.
 */
export interface OutboundWriteMatch {
  file: string;
  line: number;
  opener: string;
  ops: string[];
}

export function findUnguardedOutboundWrites(
  sources: Array<{ file: string; src: string }>,
  writeOps: ReadonlySet<string>,
): OutboundWriteMatch[] {
  const found: OutboundWriteMatch[] = [];
  for (const { file, src } of sources) {
    // Length-preserving, so the reported line is the line in the real file.
    const stripped = blankComments(src);
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
