/**
 * Graph scent lane — bounded, advisory graph pointers for pre-turn recall.
 *
 * Reads the Graphify workgroup graph (`index.db`) directly and synchronously:
 * the pre-turn path is sync end to end, so the async daemon client is unusable
 * here, and `store.query`'s `ORDER BY node_fts.node_id` is measured 125x slower
 * than `ORDER BY rank` on a broad term (92s vs 737ms on a 7.6GB graph). See
 * docs/specs/workgroup-cerebro/plan.md §4.
 *
 * Warm-gating replaces both a breaker and a result cache: a synchronous
 * better-sqlite3 query cannot be interrupted once started, so a cold graph
 * (~800ms measured) must be prevented from being queried on the message-write
 * path at all, not stopped midway. The host sweep probes one workgroup per
 * cycle; only a workgroup that answered a probe inside GRAPH_SCENT_BOUNDS
 * budgetMs is queried on a turn. Warmth tracks OS page-cache residency, which
 * measurement showed is the dominant cost term — a fixed probe term is an
 * approximation of a real query's cost, not a guarantee.
 *
 * Nothing is cached — not the handle, not the results — so a daemon index
 * promote (rename of index.next-* over index.db) is always observed.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';
import type { ContextNotice } from './pre-turn-context.js';

export const GRAPH_SCENT_BOUNDS = Object.freeze({
  /**
   * Longest N query tokens become exact FTS terms; also the OR fan-out cap.
   * 4 exact, NOT 8 prefix: the step-6 gate failed the original shape (replaying
   * 40 real queries: 8-prefix-OR p95 2.5s vs 4-exact-OR p95 231ms, identical
   * hit rate). Prefix expansion multiplies the match union bm25 must score.
   */
  terms: 4,
  /** Raw rows fetched before basename dedupe; matches the measured envelope. */
  queryLimit: 24,
  /** Pointers delivered after dedupe. */
  pointers: 5,
  /** A probe at or under this marks the workgroup warm. */
  budgetMs: 300,
  /** Serialized field budget, enforced by dropping lowest-ranked pointers. */
  chars: 600,
  /** Fail fast rather than stall a turn behind a WAL checkpoint. */
  busyTimeoutMs: 250,
});

export interface GraphScentPointer {
  /** Workgroup-relative canonical path, e.g. "workgroup/<repo>/.../file.ts". */
  path: string;
  /** Graph node type: code | structured | document_chunk | ... */
  type: string;
}

export interface GraphScent {
  /** The prefix terms actually searched, so the agent can widen or narrow. */
  terms: string[];
  pointers: GraphScentPointer[];
}

/**
 * Shared recall stopword list. Lives here rather than in pre-turn-context so
 * the value dependency runs one way (pre-turn-context imports this module for
 * readGraphScent); a two-way value import would be a module cycle.
 */
export const STOP_WORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'before',
  'by',
  'can',
  'com',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'i',
  'in',
  'into',
  'is',
  'it',
  'me',
  'of',
  'on',
  'our',
  'should',
  'that',
  'the',
  'their',
  'this',
  'to',
  'we',
  'what',
  'when',
  'where',
  'which',
  'who',
  'with',
  'http',
  'https',
  'www',
]);

interface GraphScentHooks {
  graphsRoot?: string;
  open?: (dbPath: string) => Database.Database;
  clock?: () => number;
  forceWarm?: string[];
}

const DEFAULT_GRAPHS_ROOT = path.join(DATA_DIR, 'graphify', 'workgroups');

let graphsRoot = DEFAULT_GRAPHS_ROOT;
let openGraph = (dbPath: string): Database.Database => new Database(dbPath, { readonly: true, fileMustExist: true });
let clock = (): number => Date.now();

/**
 * Workgroups whose last sweep probe answered inside budgetMs, keyed to the
 * IDENTITY of the index file that was probed (dev+ino+mtime). A daemon promote
 * renames a new index over the old path; a warm mark earned against the old
 * file must not authorize a query against the new, cold one. Identity is
 * revalidated on every read and any mismatch or failure unmarks.
 */
interface WarmMark {
  ino: number;
  mtimeMs: number;
}
const WARM = new Map<string, WarmMark>();

function currentIndexIdentity(workgroupId: string): WarmMark | null {
  try {
    const stat = fs.statSync(graphPath(workgroupId));
    return { ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}
/** Round-robin cursor for the sweep probe. */
let probeCursor = 0;

export function _setGraphScentTestHooks(hooks: GraphScentHooks): void {
  if (hooks.graphsRoot !== undefined) graphsRoot = hooks.graphsRoot;
  openGraph = hooks.open ?? ((dbPath) => new Database(dbPath, { readonly: true, fileMustExist: true }));
  clock = hooks.clock ?? (() => Date.now());
  for (const workgroupId of hooks.forceWarm ?? []) WARM.set(workgroupId, { ino: -1, mtimeMs: -1 });
}

export function _resetGraphScentForTest(): void {
  graphsRoot = DEFAULT_GRAPHS_ROOT;
  openGraph = (dbPath) => new Database(dbPath, { readonly: true, fileMustExist: true });
  clock = () => Date.now();
  WARM.clear();
  probeCursor = 0;
}

/**
 * FTS terms from the raw query: longest non-stopword tokens, unstemmed, EXACT.
 * Deliberately NOT tokenizeForRecall — node_fts has no tokenize= clause, so it
 * is unstemmed unicode61, and canonicalToken both stems ("materialized" ->
 * "materializ" would never match) and collapses meaning ("manages" -> "host").
 * No prefix `*` either: prefix expansion cost the step-6 gate an 8x latency
 * overrun for zero measured hit-rate gain (see GRAPH_SCENT_BOUNDS.terms).
 */
export function graphScentTerms(query: string): string[] {
  const tokens = [
    ...query
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .matchAll(/[\p{L}\p{N}_-]{2,}/gu),
  ]
    .map((match) => match[0])
    .filter((token) => !STOP_WORDS.has(token));
  return [...new Set(tokens)]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, GRAPH_SCENT_BOUNDS.terms);
}

function ftsMatchExpression(terms: string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

const POINTER_SQL = `
  SELECT s.relative_path AS path, n.type AS type
    FROM node_fts
    JOIN sources s ON s.id = node_fts.source_id
    JOIN nodes   n ON n.id = node_fts.node_id
   WHERE node_fts MATCH ?
     AND s.workgroup_id = ?
     AND s.state = 'indexed'
     AND s.relative_path LIKE 'workgroup/%'
   ORDER BY rank
   LIMIT ${GRAPH_SCENT_BOUNDS.queryLimit}`;

function graphPath(workgroupId: string): string {
  return path.join(graphsRoot, workgroupId, 'index.db');
}

function queryPointers(workgroupId: string, terms: string[]): GraphScentPointer[] {
  const db = openGraph(graphPath(workgroupId));
  try {
    db.pragma(`busy_timeout = ${GRAPH_SCENT_BOUNDS.busyTimeoutMs}`);
    return db.prepare(POINTER_SQL).all(ftsMatchExpression(terms), workgroupId) as GraphScentPointer[];
  } finally {
    db.close();
  }
}

function pushNotice(notices: ContextNotice[], status: ContextNotice['status'], code: string, detail: string): void {
  notices.push({ source: 'graph', status, code, detail });
}

/**
 * Sync, bounded, never throws. Returns null when cold, unavailable, or empty.
 * Queries only a workgroup marked warm by a recent sweep probe — the cold cost
 * is paid by the sweep, never on the message-write path.
 */
export function readGraphScent(workgroupId: string, query: string, notices: ContextNotice[]): GraphScent | null {
  // Applicability BEFORE term validation (review finding): a workgroup with no
  // graph on disk stays SILENT whatever the input looks like — a per-turn
  // notice for an inapplicable lane is notice spam, the failure mode the
  // notice budget exists to prevent. Existence is checked via stat rather than
  // by classifying open errors: a missing parent directory and a missing file
  // throw different shapes from better-sqlite3, and mid-rename ENOENT is
  // indistinguishable from either. "Absent" is only degraded when the lane
  // believed the graph was there (warm) — the mid-rename / deleted-index case.
  const identity = currentIndexIdentity(workgroupId);
  if (identity === null) {
    if (WARM.delete(workgroupId)) {
      pushNotice(notices, 'degraded', 'graph-scent-unavailable', 'workgroup graph index is absent');
    }
    return null;
  }
  const terms = graphScentTerms(query);
  if (terms.length < 2) {
    pushNotice(notices, 'no-match', 'graph-scent-no-match', 'fewer than two searchable terms in the current input');
    return null;
  }
  // Identity mismatch = the daemon promoted a new index since the probe. The
  // warm mark was earned against a DIFFERENT file, so it proves nothing about
  // this one; treat as cold until the next sweep probe re-verifies. ino -1 is
  // the test-only forceWarm sentinel, which skips identity checking.
  const mark = WARM.get(workgroupId);
  const warmForThisIndex =
    mark !== undefined && (mark.ino === -1 || (mark.ino === identity.ino && mark.mtimeMs === identity.mtimeMs));
  if (!warmForThisIndex) {
    if (mark !== undefined) WARM.delete(workgroupId);
    pushNotice(notices, 'degraded', 'graph-scent-cold', 'workgroup graph not verified warm by a recent sweep probe');
    return null;
  }
  const started = clock();
  let rows: GraphScentPointer[];
  try {
    rows = queryPointers(workgroupId, terms);
  } catch (error) {
    // Any failure unmarks (review finding): leaving the mark would re-run a
    // failing or busy-locked read on every subsequent turn until reprobe.
    WARM.delete(workgroupId);
    pushNotice(notices, 'degraded', 'graph-scent-read-failed', error instanceof Error ? error.message : String(error));
    return null;
  }
  const elapsedMs = clock() - started;
  // Self-healing warmth: a real turn query that overran the budget is direct
  // evidence the probe's warmth signal was wrong for this graph right now.
  // Unmark it so the tail costs one turn per probe cycle, not every turn; the
  // next sweep probe re-verifies before the lane queries again.
  if (elapsedMs > GRAPH_SCENT_BOUNDS.budgetMs) WARM.delete(workgroupId);
  const seenBasenames = new Set<string>();
  const pointers: GraphScentPointer[] = [];
  for (const row of rows) {
    const basename = row.path.slice(row.path.lastIndexOf('/') + 1);
    if (seenBasenames.has(basename)) continue;
    seenBasenames.add(basename);
    pointers.push({ path: row.path, type: row.type });
    if (pointers.length >= GRAPH_SCENT_BOUNDS.pointers) break;
  }
  if (pointers.length === 0) {
    pushNotice(notices, 'no-match', 'graph-scent-no-match', 'no canonical graph source matched the current input');
    return null;
  }
  const scent: GraphScent = { terms, pointers };
  // The char bound is absolute (AC11): drop pointers all the way to zero if
  // needed — a single pathological path can exceed the whole budget on its
  // own, and an over-bound or clipped canonical pointer is worse than none.
  while (scent.pointers.length > 0 && JSON.stringify(scent).length > GRAPH_SCENT_BOUNDS.chars) {
    scent.pointers.pop();
  }
  if (scent.pointers.length === 0) {
    pushNotice(notices, 'no-match', 'graph-scent-no-match', 'every matching pointer exceeded the lane budget');
    return null;
  }
  log.info('graph-scent: populated', {
    workgroupId,
    termCount: terms.length,
    pointerCount: scent.pointers.length,
    elapsedMs,
    overBudget: elapsedMs > GRAPH_SCENT_BOUNDS.budgetMs,
  });
  return scent;
}

/** Fixed probe: broad enough to exercise open + FTS walk on any graph. */
const PROBE_TERMS = ['deploy', 'schema', 'pipeline'];

/**
 * One bounded probe query; marks the workgroup warm when it answers inside
 * budget, unmarks it otherwise. Called off the hot path (host sweep).
 */
export function probeGraphScentWarmth(workgroupId: string): number {
  const started = clock();
  try {
    queryPointers(workgroupId, PROBE_TERMS);
  } catch {
    WARM.delete(workgroupId);
    return clock() - started;
  }
  const elapsedMs = clock() - started;
  // Identity is captured AFTER the query so a promote racing the probe cannot
  // stamp the new file with the old file's timing. A stat failure here means
  // the index vanished mid-probe: stay unmarked.
  const identity = elapsedMs <= GRAPH_SCENT_BOUNDS.budgetMs ? currentIndexIdentity(workgroupId) : null;
  if (identity !== null) WARM.set(workgroupId, identity);
  else WARM.delete(workgroupId);
  return elapsedMs;
}

/**
 * Sweep entry point: probe the next workgroup that has a graph on disk,
 * round-robin, one per call. Returns what was probed for logging, or null
 * when no graphs exist.
 */
export function probeNextGraphScentWorkgroup(): { workgroupId: string; elapsedMs: number; warm: boolean } | null {
  let entries: string[];
  try {
    entries = fs
      .readdirSync(graphsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(graphsRoot, entry.name, 'index.db')))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  const workgroupId = entries[probeCursor % entries.length]!;
  probeCursor = (probeCursor + 1) % entries.length;
  const elapsedMs = probeGraphScentWarmth(workgroupId);
  const warm = WARM.has(workgroupId);
  log.info('graph-scent: warmth probe', { workgroupId, elapsedMs, warm });
  return { workgroupId, elapsedMs, warm };
}
