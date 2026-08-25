/**
 * Recall projection — per-workgroup SQLite projection of the pre-turn memory
 * candidate set (docs/specs/workgroup-cerebro/plan.md §P2.5, steps 1 and 2).
 *
 * This module owns the WRITE side only: the schema, the build that replays
 * `readMemoryEvidence`'s candidate-generation pipeline, and the promote
 * protocol. Nothing here is wired into the per-turn read path yet — that seam
 * is §P2.5.6 step 6 and lands in a later phase.
 *
 * Three things about the shape are load-bearing and easy to "improve" into a
 * silent divergence:
 *
 * - EVERY DERIVATION IS THE LIVE FUNCTION, NOT A COPY. `headingsOf`,
 *   `readBoundedFile`, `listMarkdownFiles`, `listTopicFiles`,
 *   `missingGeneratedMemoryPath`, `capturedAtOf`, `tokenStreamForRecall` and
 *   `passageWindows` are imported from `pre-turn-context.ts`. The delivered
 *   contract is byte-identical output (P2.5-I1), and a second implementation of
 *   any of them is a drift generator. Only the ORCHESTRATION loop is restated
 *   here — and that duplicate loop is a live drift surface TODAY, not a
 *   hypothetical one, until step 6 collapses it by calling
 *   `buildProjectionCandidates` from `readMemoryEvidence` itself. Until then
 *   every behavioral difference between the two loops is a byte-identity bug;
 *   the vanished-file case below was one, and AC1's differential harness is
 *   what would catch the next.
 * - THE TOKEN STREAM AND THE PASSAGE WINDOWS ARE PERSISTED (decision 3,
 *   P2.5-I9). Storing only path/headings/content/searchable/capturedAt would
 *   leave scoring re-tokenizing every candidate every turn through the
 *   process-wide `TOKEN_STREAM_CACHE`, which is the cross-workgroup contention
 *   this pillar exists to remove.
 * - QUIRKS ARE REPRODUCED, NOT FIXED (decision 15). `headingsOf`'s truncation,
 *   `capturedAt` as a raw unparsed string, the fact lane's ONE shared headings
 *   array, and `scan_order` from the real Set-union/`.sort()`/splice pipeline
 *   rather than a build-time counter. Correcting any of them changes delivered
 *   text relative to the filesystem path.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { GENERATED_MEMORY_MAX_BYTES, GENERATED_MEMORY_RELATIVE_PATH } from './curator-contract.js';
import {
  capturedAtOf,
  CORE_PATHS,
  headingsOf,
  listMarkdownFiles,
  listTopicFiles,
  missingGeneratedMemoryPath,
  NON_RECALL_PATHS,
  passageWindows,
  PRE_TURN_BOUNDS,
  PREFERENCES_DIR,
  readBoundedFile,
  tokenStreamForRecall,
  type ContextNotice,
  type RecallToken,
  type SearchableCandidate,
} from './pre-turn-context.js';

/**
 * Mirrors `WorkgroupGraphStore`'s guard (`src/graphify/store.ts:27`). A
 * mismatch is a REBUILD TRIGGER, never an error surfaced to a turn
 * (decision 14) — enforcing that is the reader's job in step 6; this module
 * only stamps and exposes the value.
 */
export const RECALL_PROJECTION_SCHEMA_VERSION = 1;

/** Files and facts are ranked as separate pools, each with its own scan order. */
export type RecallLane = 'file' | 'fact';

/**
 * `bestPassage`'s `maxChars` per lane, taken from the live `rankAll`
 * (`pre-turn-context.ts:1227-1229`). Windows are maxChars-dependent, so the
 * build must precompute them at the width its lane will actually score at.
 */
export const LANE_EXCERPT_CHARS: Readonly<Record<RecallLane, number>> = Object.freeze({
  file: PRE_TURN_BOUNDS.markdownExcerptChars,
  fact: PRE_TURN_BOUNDS.generatedFactExcerptChars,
});

/**
 * Every live constant the BUILD's output depends on, frozen into the file.
 *
 * S1: recording these without enforcing them is worse than not recording them —
 * it reads as a guard that is not one. `schema_version` only moves when the
 * TABLE shape changes, so widening `markdownExcerptChars` (or any of these)
 * leaves a version-1 projection serving windows the live path would never
 * produce. Compared as one JSON string at open; a mismatch is rebuild-required,
 * exactly like a schema mismatch, never an error surfaced to a turn.
 *
 * The set is the real dependency set, not a sample: file/heading widths shape
 * `searchable`, the two lane widths shape every stored passage window, and the
 * byte bounds shape which candidates exist at all.
 */
function frozenBounds(): Record<string, number> {
  return {
    markdownFileBytes: PRE_TURN_BOUNDS.markdownFileBytes,
    markdownScannedBytes: PRE_TURN_BOUNDS.markdownScannedBytes,
    markdownHeadings: PRE_TURN_BOUNDS.markdownHeadings,
    markdownHeadingChars: PRE_TURN_BOUNDS.markdownHeadingChars,
    fileExcerptChars: LANE_EXCERPT_CHARS.file,
    factExcerptChars: LANE_EXCERPT_CHARS.fact,
  };
}

export interface ProjectionWindow {
  text: string;
  tokens: RecallToken[];
}

export interface ProjectionCandidate extends SearchableCandidate {
  lane: RecallLane;
  /** 0-based position in this lane's ranked pool — `rankByBestPassage`'s `sourceOrder`. */
  scanOrder: number;
  /** `mem_<16-hex>` for a fact, null for a file. Keys decision 6's incremental update. */
  factId: string | null;
  /**
   * Whole-candidate `tokenStreamForRecall(searchable)` — the ordered
   * `{value,start,end}` stream, which is the primary persisted artifact.
   */
  stream: RecallToken[];
  /** `tokenizeForRecall(searchable)`, i.e. `[...new Set(stream.map(t => t.value))]`. */
  tokens: string[];
  /** Whole `passageWindows(searchable, LANE_EXCERPT_CHARS[lane])` output. */
  windows: ProjectionWindow[];
}

/**
 * One row per path in the build's tree listing — INCLUDING paths the scan loop
 * skipped, so decision 5's step-4 tree diff can see added/removed in both
 * directions. `size`/`mtimeNs`/`ino` are decimal strings: `mtimeNs` exceeds
 * `Number.MAX_SAFE_INTEGER` and a float round-trip would silently blunt the
 * nanosecond resolution the same-millisecond-edit case depends on.
 */
export interface ProjectionSourceFile {
  path: string;
  size: string;
  mtimeNs: string;
  ino: string;
  /** `headingsOf(content)` when the scan loop read this file; null when it skipped it. */
  headings: string[] | null;
}

export interface ProjectionCandidateSet {
  candidates: ProjectionCandidate[];
  sources: ProjectionSourceFile[];
  /** Bytes the ranked scan loop consumed, frozen for decision 16's read-time assertion. */
  scannedBytes: number;
  /** Build-time notices (P2.5-I5); persisted so step 6 can reproduce them. */
  notices: ContextNotice[];
}

export interface ProjectionBuildResult {
  /** Live path the candidate was promoted over. */
  path: string;
  fileCandidates: number;
  factCandidates: number;
  sourceFiles: number;
  termRows: number;
  /** Candidates whose windows could not be proven reconstructable and were stored whole. */
  windowsStoredWhole: number;
  scannedBytes: number;
  /** On-disk size of the promoted `index.db`, in bytes. */
  bytes: number;
  elapsedMs: number;
}

const FACT_ID_PATTERN = /id=(mem_[a-f0-9]{16})/;

const SCHEMA_SQL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE source_file (
  path          TEXT PRIMARY KEY,
  size          TEXT NOT NULL,
  mtime_ns      TEXT NOT NULL,
  ino           TEXT NOT NULL,
  headings_json TEXT
);

CREATE TABLE candidate (
  id           INTEGER PRIMARY KEY,
  lane         TEXT NOT NULL,
  scan_order   INTEGER NOT NULL,
  path         TEXT NOT NULL,
  content      TEXT NOT NULL,
  searchable   TEXT NOT NULL,
  captured_at  TEXT NOT NULL,
  fact_id      TEXT,
  stream_json  TEXT NOT NULL,
  -- 1: windows_json is a flat [start, end, tokenStart, tokenEnd, ...] run of
  -- offsets into searchable and index ranges into stream_json.
  -- 0: the offset form could not be PROVEN exact for this candidate, so
  --    windows_json holds the literal [{text, tokens}] shape instead.
  windows_encoded INTEGER NOT NULL,
  windows_json TEXT NOT NULL
);

CREATE UNIQUE INDEX candidate_lane_scan ON candidate (lane, scan_order);
CREATE INDEX candidate_fact ON candidate (lane, fact_id);

CREATE TABLE term (
  token        TEXT NOT NULL,
  candidate_id INTEGER NOT NULL REFERENCES candidate (id) ON DELETE CASCADE,
  PRIMARY KEY (token, candidate_id)
) WITHOUT ROWID;
`;

/** Written LAST, inside the transaction that finalizes the build (decision 12). */
const COMPLETE_KEY = 'complete';

/**
 * Replay of `readMemoryEvidence`'s candidate-generation block
 * (`pre-turn-context.ts:1088-1210`), minus the two per-turn lanes it cannot
 * freeze.
 *
 * Deliberately excluded, and why:
 * - CORE_PATHS reads are bootstrap-only and consume the shared byte budget
 *   before the scan loop. Their inclusion is a per-turn property.
 * - The preference lane depends on `involvedSenderNames`, i.e. on who is in the
 *   conversation (decision 16). A build cannot know that.
 *
 * Both mean the build starts the scan loop with `scannedBytes = 0` — the
 * maximum-budget case. The consumed total is returned so the read path can
 * assert decision 16's precondition still holds (P2.5-I8, step 6).
 */
export function buildProjectionCandidates(root: string): ProjectionCandidateSet {
  if (!fs.existsSync(root)) throw new Error(`canonical memory tree missing: ${root}`);
  const canonicalRoot = fs.realpathSync(root);
  if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error(`canonical memory tree is not a directory: ${root}`);

  const notices: ContextNotice[] = [];
  // Exactly the live union: capped walk ∪ directly-listed topic dirs, deduped
  // and `.sort()`ed, then the conditional generated-memory splice pulled to
  // the front. `sourceOrder` is array position in THIS list's per-lane
  // projection, so any deviation here silently re-tie-breaks recall.
  const allFiles = [...new Set([...listMarkdownFiles(root, notices), ...listTopicFiles(root, notices)])].sort();
  const missingGeneratedMemory = missingGeneratedMemoryPath(root, allFiles);
  const scanOrder = (missingGeneratedMemory ? [...allFiles, missingGeneratedMemory] : allFiles).sort(
    (a, b) => Number(b === GENERATED_MEMORY_RELATIVE_PATH) - Number(a === GENERATED_MEMORY_RELATIVE_PATH),
  );

  const sources: ProjectionSourceFile[] = [];
  const fileCandidates: SearchableCandidate[] = [];
  const factCandidates: SearchableCandidate[] = [];
  let scannedBytes = 0;

  for (const relative of scanOrder) {
    const absolute = path.join(root, relative);
    // Skips first, exactly as the live loop orders them: CORE_PATHS,
    // NON_RECALL_PATHS, preferences/ — then the byte budget, then the read.
    if (
      (CORE_PATHS as readonly string[]).includes(relative) ||
      NON_RECALL_PATHS.has(relative) ||
      relative.startsWith(PREFERENCES_DIR)
    ) {
      // The live path never opens these, so a vanished one is not a divergence.
      const skippedStats = statSource(absolute);
      if (skippedStats !== null) sources.push({ ...skippedStats, path: relative, headings: null });
      continue;
    }
    const remaining = PRE_TURN_BOUNDS.markdownScannedBytes - scannedBytes;
    if (remaining <= 0) {
      notices.push({
        source: 'markdown',
        status: 'truncated',
        code: 'markdown-byte-limit',
        detail: `scanned ${PRE_TURN_BOUNDS.markdownScannedBytes} bytes`,
      });
      break;
    }
    // Stat BEFORE the read so staleness records the state the content came
    // from; a file changed between the two then reads as stale and rebuilds,
    // where the reverse order would record the new stat against old content.
    const before = statSource(absolute);
    // S5: NO swallow here. If the file vanished between listing and now, the
    // live path's `readBoundedFile` throws ENOENT, which propagates to
    // `readMemoryEvidence`'s outer catch (`pre-turn-context.ts:1681`) and
    // returns EMPTY evidence with `markdown-read-failed`. A build that skipped
    // the file instead would produce a projection the live path would never
    // agree with on the same tree — a byte-identity counterexample. Throwing
    // aborts this build; the sweep retries it, and the turn is served by the
    // filesystem path meanwhile.
    const read = readBoundedFile(
      absolute,
      canonicalRoot,
      remaining,
      relative === GENERATED_MEMORY_RELATIVE_PATH ? GENERATED_MEMORY_MAX_BYTES : PRE_TURN_BOUNDS.markdownFileBytes,
    );
    scannedBytes += read.bytes;
    const stats = before ?? statSource(absolute);
    if (stats === null) throw new Error(`cannot stat ${relative} after reading it`);
    // ONE array per source file, shared by reference across every fact drawn
    // from it (decision 15). Stored on `source_file`, not per candidate row,
    // so hydration hands back the same instance the live path does.
    const headings = headingsOf(read.content);
    sources.push({ ...stats, path: relative, headings });
    if (relative === GENERATED_MEMORY_RELATIVE_PATH) {
      for (const line of read.content.split('\n')) {
        if (!line.startsWith('- ')) continue;
        const markerAt = line.indexOf('<!--');
        factCandidates.push({
          path: relative,
          headings,
          content: line,
          searchable: markerAt < 0 ? line : line.slice(0, markerAt),
          capturedAt: capturedAtOf(line),
        });
      }
      continue;
    }
    fileCandidates.push({
      path: relative,
      headings,
      content: read.content,
      searchable: `${relative}\n${headings.join('\n')}\n${read.content}`,
      capturedAt: '',
    });
  }

  const candidates = [
    ...fileCandidates.map((candidate, scanOrderInLane) => project(candidate, 'file', scanOrderInLane)),
    ...factCandidates.map((candidate, scanOrderInLane) => project(candidate, 'fact', scanOrderInLane)),
  ];
  return { candidates, sources, scannedBytes, notices };
}

function statSource(absolute: string): { size: string; mtimeNs: string; ino: string } | null {
  try {
    const stats = fs.statSync(absolute, { bigint: true });
    return { size: String(stats.size), mtimeNs: String(stats.mtimeNs), ino: String(stats.ino) };
  } catch {
    // Vanished between listing and stat. The tree diff will treat it as
    // removed on the next check; a missing row is the honest record.
    return null;
  }
}

function project(candidate: SearchableCandidate, lane: RecallLane, scanOrder: number): ProjectionCandidate {
  const windows = passageWindows(candidate.searchable, LANE_EXCERPT_CHARS[lane]).map((window) => ({
    text: window.text,
    tokens: [...window.tokens],
  }));
  const stream = [...tokenStreamForRecall(candidate.searchable)];
  return {
    ...candidate,
    lane,
    scanOrder,
    factId: lane === 'fact' ? (FACT_ID_PATTERN.exec(candidate.content)?.[1] ?? null) : null,
    stream,
    // Exactly `tokenizeForRecall`'s body, so the derivation cannot drift from it.
    tokens: [...new Set(stream.map((token) => token.value))],
    windows,
  };
}

/**
 * Window storage (plan decision 3 as amended 2026-08-25).
 *
 * The plan originally said to store `passageWindows`' output verbatim. Measured
 * on the largest real workgroup that cost 158.1 MB of a 194.3 MB projection —
 * 81% — because the 1..3-sentence sweep re-covers the same characters ~2.9x and
 * every window shipped its own `{value,start,end}` triples. The amended contract
 * is that the HYDRATED shape must be exact, not the stored shape.
 *
 * So a window is stored as four integers: `[start, end]` into `searchable` and
 * `[tokenStart, tokenEnd]` into the persisted stream. On the offset-sliceable
 * path that is lossless by construction — `passageWindows` literally returns
 * `candidate.slice(start, end)` and `stream.slice(first, after)` there.
 *
 * It is not TRUSTED to be lossless, it is CHECKED: the build encodes, decodes,
 * and deep-compares against the real `passageWindows` output, and any candidate
 * that fails falls back to storing the literal shape. The non-sliceable path
 * (`sentenceSpans` hard-chopping a sentence mid-word) re-tokenizes each window
 * independently, so its token offsets index the WINDOW rather than the
 * candidate and it takes that fallback.
 */
function encodeWindows(
  searchable: string,
  stream: readonly RecallToken[],
  windows: readonly ProjectionWindow[],
): number[] | null {
  const indexByStart = new Map<number, number>();
  for (let index = 0; index < stream.length; index++) indexByStart.set(stream[index]!.start, index);
  const flat: number[] = [];
  let searchFrom = 0;
  for (const window of windows) {
    const start = searchable.indexOf(window.text, searchFrom);
    if (start < 0) return null;
    // Window starts are non-decreasing, so resuming the search here is safe.
    // A wrong-but-identical-text hit still fails the decode check below.
    searchFrom = start;
    const first = window.tokens[0];
    const tokenStart = first === undefined ? 0 : (indexByStart.get(first.start) ?? -1);
    if (tokenStart < 0) return null;
    flat.push(start, start + window.text.length, tokenStart, tokenStart + window.tokens.length);
  }
  return flat;
}

function decodeWindows(
  searchable: string,
  stream: readonly RecallToken[],
  flat: readonly number[],
): ProjectionWindow[] {
  const windows: ProjectionWindow[] = [];
  for (let index = 0; index < flat.length; index += 4) {
    windows.push({
      text: searchable.slice(flat[index]!, flat[index + 1]!),
      tokens: stream.slice(flat[index + 2]!, flat[index + 3]!) as RecallToken[],
    });
  }
  return windows;
}

function streamEqual(a: readonly RecallToken[], b: readonly RecallToken[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const one = a[index]!;
    const other = b[index]!;
    if (one.value !== other.value || one.start !== other.start || one.end !== other.end) return false;
  }
  return true;
}

/** Byte-identity check for the encode/decode round trip — value, start, end, and order. */
export function windowsEqual(a: readonly ProjectionWindow[], b: readonly ProjectionWindow[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const left = a[index]!;
    const right = b[index]!;
    if (left.text !== right.text || left.tokens.length !== right.tokens.length) return false;
    for (let position = 0; position < left.tokens.length; position++) {
      const one = left.tokens[position]!;
      const other = right.tokens[position]!;
      if (one.value !== other.value || one.start !== other.start || one.end !== other.end) return false;
    }
  }
  return true;
}

/**
 * Parallel arrays rather than an array of objects, and LENGTHS rather than end
 * offsets: both are pure encoding choices that shrink the JSON, and both are
 * exactly reversed by `decodeStream`.
 */
function encodeStream(stream: readonly RecallToken[]): string {
  const values: string[] = [];
  const starts: number[] = [];
  const lengths: number[] = [];
  for (const token of stream) {
    values.push(token.value);
    starts.push(token.start);
    lengths.push(token.end - token.start);
  }
  return JSON.stringify([values, starts, lengths]);
}

function decodeStream(json: string): RecallToken[] {
  const [values, starts, lengths] = JSON.parse(json) as [string[], number[], number[]];
  return values.map((value, index) => ({ value, start: starts[index]!, end: starts[index]! + lengths[index]! }));
}

/**
 * Term set for one candidate: the whole-candidate stream unioned with every
 * window's tokens (decision 8).
 *
 * The union is UNCONDITIONAL rather than gated on `offsetSliceable`, which is
 * equivalent and one branch shorter: on the sliceable path every window's
 * tokens are a `slice()` of the whole-candidate stream, so the union adds
 * nothing; on the fallback path `sentenceSpans` can hard-chop a sentence
 * mid-word and mint a window-only token (measured: 1 candidate in 9,001), and
 * that token must be searchable or the delivered set is not byte-identical.
 */
export function termsOf(candidate: ProjectionCandidate): string[] {
  const terms = new Set(candidate.tokens);
  for (const window of candidate.windows) for (const token of window.tokens) terms.add(token.value);
  return [...terms];
}

interface CandidateRow {
  lane: string;
  scan_order: number;
  path: string;
  content: string;
  searchable: string;
  captured_at: string;
  fact_id: string | null;
  stream_json: string;
  windows_encoded: number;
  windows_json: string;
}

/**
 * Read one just-inserted candidate back out and require it to be identical to
 * what the build meant to store (S2). Throws rather than degrading: a divergent
 * row cannot be repaired by falling back to the whole-window shape, because the
 * corruption is in the stored TEXT itself. Throwing aborts the transaction, so
 * the side file is discarded and the previous `index.db` stays servable.
 */
function assertStoredCandidateMatches(select: Database.Statement, id: number, candidate: ProjectionCandidate): void {
  const row = select.get(id) as CandidateRow | undefined;
  const fail = (what: string): never => {
    throw new Error(`recall projection storage round trip changed ${what} for ${candidate.lane} ${candidate.path}`);
  };
  if (!row) fail('the row itself (vanished)');
  if (row!.content !== candidate.content) fail('content');
  if (row!.searchable !== candidate.searchable) fail('searchable');
  if (row!.path !== candidate.path) fail('path');
  if (row!.captured_at !== candidate.capturedAt) fail('capturedAt');
  if (row!.fact_id !== candidate.factId) fail('factId');
  if (row!.scan_order !== candidate.scanOrder) fail('scanOrder');
  const storedStream = decodeStream(row!.stream_json);
  if (!streamEqual(storedStream, candidate.stream)) fail('the token stream');
  // Decode through the SAME path hydration uses, against the STORED base
  // string — that is what makes this a storage check and not a second
  // in-memory check.
  const parsed = JSON.parse(row!.windows_json) as number[] | ProjectionWindow[];
  const storedWindows =
    row!.windows_encoded === 1
      ? decodeWindows(row!.searchable, storedStream, parsed as number[])
      : (parsed as ProjectionWindow[]);
  if (!windowsEqual(storedWindows, candidate.windows)) fail('passage windows');
}

function openForWrite(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Write a full candidate set into a fresh database file and finalize it.
 *
 * The completeness marker is the LAST statement of the SAME transaction that
 * writes the rows (decision 12): "the file exists and opens" must not be
 * mistakable for "the build finished". A build killed anywhere before COMMIT
 * leaves a file with no marker, which `openRecallProjection` refuses.
 */
export function writeProjection(
  dbPath: string,
  set: ProjectionCandidateSet,
): { termRows: number; windowsStoredWhole: number } {
  const db = openForWrite(dbPath);
  let termRows = 0;
  let windowsStoredWhole = 0;
  try {
    db.exec(SCHEMA_SQL);
    const insertMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    const insertSource = db.prepare(
      'INSERT INTO source_file (path, size, mtime_ns, ino, headings_json) VALUES (?, ?, ?, ?, ?)',
    );
    const insertCandidate = db.prepare(
      `INSERT INTO candidate (lane, scan_order, path, content, searchable, captured_at, fact_id, stream_json, windows_encoded, windows_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTerm = db.prepare('INSERT OR IGNORE INTO term (token, candidate_id) VALUES (?, ?)');
    const selectCandidate = db.prepare(
      `SELECT lane, scan_order, path, content, searchable, captured_at, fact_id, stream_json, windows_encoded, windows_json
         FROM candidate WHERE id = ?`,
    );
    db.transaction(() => {
      insertMeta.run('schema_version', String(RECALL_PROJECTION_SCHEMA_VERSION));
      insertMeta.run('built_at', new Date().toISOString());
      insertMeta.run('scanned_bytes', String(set.scannedBytes));
      // Frozen bounds, ENFORCED at open (S1) — see `frozenBounds`.
      insertMeta.run('bounds_json', JSON.stringify(frozenBounds()));
      insertMeta.run('notices_json', JSON.stringify(set.notices));
      for (const source of set.sources) {
        insertSource.run(
          source.path,
          source.size,
          source.mtimeNs,
          source.ino,
          source.headings === null ? null : JSON.stringify(source.headings),
        );
      }
      for (const candidate of set.candidates) {
        // Choose the encoding in memory...
        const flat = encodeWindows(candidate.searchable, candidate.stream, candidate.windows);
        const encoded =
          flat !== null && windowsEqual(decodeWindows(candidate.searchable, candidate.stream, flat), candidate.windows);
        if (!encoded) windowsStoredWhole++;
        const id = Number(
          insertCandidate.run(
            candidate.lane,
            candidate.scanOrder,
            candidate.path,
            candidate.content,
            candidate.searchable,
            candidate.capturedAt,
            candidate.factId,
            encodeStream(candidate.stream),
            encoded ? 1 : 0,
            JSON.stringify(encoded ? flat : candidate.windows),
          ).lastInsertRowid,
        );
        // ...but PROVE it after the row has been through SQLite (S2).
        //
        // An in-memory-only check verifies the encoder, not the storage. The
        // offsets index the STORED `searchable`, so anything the TEXT binding
        // mutates shifts every window silently while the encoder's own check
        // stays green — and `stream_json` would keep the ORIGINAL coordinates,
        // because JSON escapes survive what a bare TEXT bind does not.
        // better-sqlite3 replaces unpaired surrogates with U+FFFD on bind
        // (measured), which is exactly that failure. Reading the row back
        // through the real hydration decode is the only check that covers the
        // storage boundary, and it is what makes P2.5-I1 a property of the
        // FILE rather than of the in-memory objects.
        assertStoredCandidateMatches(selectCandidate, id, candidate);
        for (const token of termsOf(candidate)) {
          insertTerm.run(token, id);
          termRows++;
        }
      }
      insertMeta.run(COMPLETE_KEY, '1');
    })();
  } finally {
    // Closing the last connection checkpoints and removes the -wal sidecar, so
    // the single file the promote renames carries the whole committed build.
    db.close();
  }
  return { termRows, windowsStoredWhole };
}

export function projectionDir(workgroupId: string, dataDir: string): string {
  return path.join(dataDir, 'memory-recall', 'workgroups', workgroupId);
}

export function projectionPath(workgroupId: string, dataDir: string): string {
  return path.join(projectionDir(workgroupId, dataDir), 'index.db');
}

/**
 * An `index.next-*` file this old cannot belong to a live build — the slowest
 * measured build is ~15 s — so it is a corpse from a killed one (S4).
 *
 * ponytail: age gate rather than real ownership tracking. A lock file or an
 * flock would be exact; this is two lines and cannot delete a sibling's
 * in-flight file, which was the actual bug. Upgrade if builds ever legitimately
 * run longer than the threshold.
 */
const STALE_SIDE_FILE_MS = 60 * 60 * 1000;

/** fsync a path (file or directory) and swallow nothing. */
function fsyncPath(target: string, flags: number): void {
  const fd = fs.openSync(target, flags);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Build a projection for `root` and promote it over `<directory>/index.db`.
 *
 * Promote protocol (decision 12, mirroring `daemon.ts:2344-2367`): write
 * `index.next-<uuid>`, fsync it, remove the live `-wal`/`-shm` sidecars, rename
 * over `index.db`, then fsync the directory. Dropping the sidecars is not
 * optional — a stale WAL left beside a freshly renamed database belongs to a
 * different file and is a corruption source, which is exactly why the graph
 * daemon removes them too.
 *
 * WHAT RECOVERY DEPENDS ON (S3). `rename(2)` is atomic against a crash, but not
 * against power loss unless the data is on disk first: without the fsyncs a
 * reader could find a renamed file whose pages never landed, and — because the
 * completeness marker lives in an early `meta` page — that file can pass the
 * marker check while its candidate pages are garbage. The fsync of the side
 * file orders data before the rename; the fsync of the directory makes the
 * rename itself durable. After both, the only post-power-loss states are the
 * old `index.db` or the new one, never a half of either.
 *
 * A build that dies before the rename leaves `index.db` untouched and fully
 * servable. The marker commits inside `writeProjection`'s transaction, which
 * returns before the rename can run, so this path cannot itself produce a
 * renamed-but-markerless file; `openRecallProjection`'s marker check guards the
 * file arriving any OTHER way — a torn write, a future incremental writer, or
 * an operator copying one in (P2.5-I6).
 */
export function buildAndPromoteProjection(options: { root: string; directory: string }): ProjectionBuildResult {
  const startedAt = Date.now();
  const livePath = path.join(options.directory, 'index.db');
  fs.mkdirSync(options.directory, { recursive: true });
  // Sweep corpses ONLY (S4). Deleting every `index.next-*` unconditionally took
  // a concurrent build's in-flight file out from under its open connection.
  for (const entry of fs.readdirSync(options.directory)) {
    if (!entry.startsWith('index.next-')) continue;
    const orphan = path.join(options.directory, entry);
    const age = Date.now() - fs.statSync(orphan).mtimeMs;
    if (age > STALE_SIDE_FILE_MS) fs.rmSync(orphan, { force: true });
  }
  // randomUUID, not Date.now()+pid: worker threads SHARE a pid, so two
  // concurrent builds of one workgroup in the same millisecond produced the
  // identical path and corrupted each other (S4).
  const nextPath = path.join(options.directory, `index.next-${randomUUID()}.db`);
  if (fs.existsSync(nextPath)) throw new Error(`recall projection side file already exists: ${nextPath}`);

  const set = buildProjectionCandidates(options.root);
  let written: { termRows: number; windowsStoredWhole: number };
  try {
    written = writeProjection(nextPath, set);
    fsyncPath(nextPath, fs.constants.O_RDONLY);
  } catch (error) {
    fs.rmSync(nextPath, { force: true });
    throw error;
  }
  fs.rmSync(`${livePath}-wal`, { force: true });
  fs.rmSync(`${livePath}-shm`, { force: true });
  fs.renameSync(nextPath, livePath);
  fsyncPath(options.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);

  return {
    path: livePath,
    fileCandidates: set.candidates.filter((candidate) => candidate.lane === 'file').length,
    factCandidates: set.candidates.filter((candidate) => candidate.lane === 'fact').length,
    sourceFiles: set.sources.length,
    termRows: written.termRows,
    windowsStoredWhole: written.windowsStoredWhole,
    scannedBytes: set.scannedBytes,
    bytes: fs.statSync(livePath).size,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Read-only handle, or null when the projection is absent, incomplete, of a
 * different schema version, or unopenable.
 *
 * Never throws: every one of those states is "serve the filesystem path this
 * turn" (P2.5-I4), and a schema mismatch is a rebuild trigger, not an error
 * (decision 14).
 */
export function openRecallProjection(dbPath: string): Database.Database | null {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    db.pragma('busy_timeout = 5000');
    const version = readMeta(db, 'schema_version');
    if (version !== String(RECALL_PROJECTION_SCHEMA_VERSION)) throw new Error(`schema_version ${version}`);
    if (readMeta(db, COMPLETE_KEY) !== '1') throw new Error('build never completed');
    const bounds = readMeta(db, 'bounds_json');
    if (bounds !== JSON.stringify(frozenBounds())) throw new Error(`stale bounds ${bounds}`);
    return db;
  } catch {
    db.close();
    return null;
  }
}

function readMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export interface ProjectionSummary {
  schemaVersion: string | null;
  scannedBytes: number;
  /** The bounds this projection was built under — see `frozenBounds`. */
  bounds: Record<string, number>;
  notices: ContextNotice[];
}

export function readProjectionSummary(db: Database.Database): ProjectionSummary {
  return {
    schemaVersion: readMeta(db, 'schema_version'),
    scannedBytes: Number(readMeta(db, 'scanned_bytes') ?? 0),
    bounds: JSON.parse(readMeta(db, 'bounds_json') ?? '{}') as Record<string, number>,
    notices: JSON.parse(readMeta(db, 'notices_json') ?? '[]') as ContextNotice[],
  };
}

/**
 * Hydrate a lane's candidates in `scan_order` — never term-index order, which
 * is what `sourceOrder` being the final tie-break requires (P2.5-I2).
 *
 * `headings` comes from `source_file` through a per-path memo, so every fact
 * drawn from the ledger gets the SAME array instance the live path shares by
 * reference (decision 15).
 */
export function hydrateLane(db: Database.Database, lane: RecallLane): ProjectionCandidate[] {
  const headingsByPath = new Map<string, string[]>();
  const headingsFor = (candidatePath: string): string[] => {
    const memo = headingsByPath.get(candidatePath);
    if (memo) return memo;
    const row = db.prepare('SELECT headings_json FROM source_file WHERE path = ?').get(candidatePath) as
      | { headings_json: string | null }
      | undefined;
    const headings = (row?.headings_json ? JSON.parse(row.headings_json) : []) as string[];
    headingsByPath.set(candidatePath, headings);
    return headings;
  };
  const rows = db
    .prepare(
      `SELECT lane, scan_order, path, content, searchable, captured_at, fact_id, stream_json, windows_encoded, windows_json
         FROM candidate WHERE lane = ? ORDER BY scan_order`,
    )
    .all(lane) as CandidateRow[];
  return rows.map((row) => {
    const stream = decodeStream(row.stream_json);
    const parsed = JSON.parse(row.windows_json) as number[] | ProjectionWindow[];
    return {
      lane,
      scanOrder: row.scan_order,
      path: row.path,
      headings: headingsFor(row.path),
      content: row.content,
      searchable: row.searchable,
      capturedAt: row.captured_at,
      factId: row.fact_id,
      stream,
      tokens: [...new Set(stream.map((token) => token.value))],
      windows:
        row.windows_encoded === 1
          ? decodeWindows(row.searchable, stream, parsed as number[])
          : (parsed as ProjectionWindow[]),
    };
  });
}
