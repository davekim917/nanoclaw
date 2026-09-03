#!/usr/bin/env tsx
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
        if (!isExcluded(path.dirname(rel))) out.push(rel);
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
  // (a) an import from a path ending in session-db.js
  return /from\s+['"][^'"]*session-db\.js['"]/.test(src);
}

function matchesPatternB(src: string): boolean {
  // (b) an import of any raw opener/path helper name
  const importBlockRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"][^'"]+['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importBlockRe.exec(src))) {
    const names = m[1].split(',').map((s) =>
      s
        .trim()
        .split(/\s+as\s+/)[0]
        .trim(),
    );
    if (names.some((n) => RAW_OPENER_NAMES.includes(n))) return true;
  }
  return false;
}

function matchesPatternC(src: string): boolean {
  // (c) new Database( where the same statement or the preceding 3 lines mention inbound.db/outbound.db
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/new\s+Database\s*\(/.test(lines[i])) continue;
    const windowStart = Math.max(0, i - 3);
    const window = lines.slice(windowStart, i + 1).join('\n');
    if (window.includes('inbound.db') || window.includes('outbound.db')) return true;
  }
  return false;
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const offenders = computeOffenders();
  for (const o of offenders) console.log(`${o.file}  [${o.patterns.join(',')}]`);
  console.log(`\n${offenders.length} offending file(s)`);
}
