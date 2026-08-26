/**
 * Recall projection STORE — schema, encoding, and the SQLite primitives both
 * sides of the projection use (docs/specs/workgroup-cerebro/plan.md §P2.5).
 *
 * WHY THIS IS ITS OWN FILE. `recall-projection.ts` (the build) imports the live
 * derivations from `pre-turn-context.ts`, and as of §P2.5.6 step 6
 * `pre-turn-context.ts` reads the projection on the turn path. Those two facts
 * together are a module cycle, and an ESM cycle here is not a style question:
 * `PRE_TURN_BOUNDS` is a top-level `const`, so whichever module lost the
 * execution race would see it in TDZ and throw at import time — the exact trap
 * CLAUDE.md's "use `await import()` for cycles" rule names, with no async
 * escape hatch available on a synchronous read path.
 *
 * So this file is a LEAF: `better-sqlite3` and `node:*` only, plus TYPE-ONLY
 * imports from `pre-turn-context.ts`, which erase at compile time and carry no
 * runtime edge. Both sides depend on it and it depends on neither. Everything
 * here is bounds-agnostic — the frozen-bounds string is passed in, never read
 * from `PRE_TURN_BOUNDS`, because reading it would reintroduce the edge.
 */
import Database from 'better-sqlite3';

import type { ContextNotice, RecallToken, SearchableCandidate } from './pre-turn-context.js';

import path from 'node:path';
import fs from 'node:fs';

/**
 * Mirrors `WorkgroupGraphStore`'s guard (`src/graphify/store.ts:27`). A
 * mismatch is a REBUILD TRIGGER, never an error surfaced to a turn
 * (decision 14).
 *
 * BUMP THIS when the table shape changes OR when what the columns MEAN
 * changes. Version 2 is the worked example: F4 changed window `start`/`end`
 * from an `indexOf` first-occurrence derivation to the true span, so on
 * `'aa bb?\naa bb?'` the third window stores `[7,13)` where it used to store
 * `[0,6)`. Same columns, same decoded text — which is exactly why the
 * round-trip check waves it through — but a consumer reading offsets rather
 * than slicing text gets a different answer per row vintage.
 *
 * THIS AND `frozenBounds` ARE INDEPENDENT GATES. `frozenBounds` covers the
 * build constants and the tokenizer's behaviour; this version covers table
 * shape and persisted semantics. F4's commit happened to move the tokenizer
 * fingerprint as well (1400294713 -> 2036328998, verified by computing
 * `frozenBounds()` at that commit and its parent — the same commit rewrote
 * `tokenizerFingerprint` to hash a probe corpus), so stores written before it
 * were in fact already refused as `stale-bounds`. That is coincidence, not
 * coverage: an offset-semantics change on its own moves neither a constant nor
 * the tokenizer. Bump this version for every semantic change, including the
 * ones some other gate would have caught anyway.
 */
export const RECALL_PROJECTION_SCHEMA_VERSION = 2;

/** Files and facts are ranked as separate pools, each with its own scan order. */
export type RecallLane = 'file' | 'fact';

export interface ProjectionWindow {
  text: string;
  tokens: RecallToken[];
  /** True `[start, end)` into `searchable`, as `passageWindows` emitted it. */
  start: number;
  end: number;
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
 * skipped, so decision 5's tree diff can see added/removed in both directions.
 * `size`/`mtimeNs`/`ino` are decimal strings: `mtimeNs` exceeds
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
  /** Build-time notices (P2.5-I5); persisted so the read path can reproduce them. */
  notices: ContextNotice[];
}

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
  for (const window of windows) {
    // The span comes from `passageWindows`, which computed it. An earlier
    // version recovered it with `indexOf` from the previous window's start,
    // and that is NOT safe: windows overlap and repeat, so the search can land
    // on an earlier identical occurrence. On `'aa bb?\naa bb?'` the third
    // window's true [7,13) was stored as [0,6) — and because the decoded text
    // is byte-identical, the round-trip check below waved it through. The
    // comment there used to claim the opposite; it was wrong, which is why the
    // derivation is gone rather than patched.
    if (searchable.slice(window.start, window.end) !== window.text) return null;
    const first = window.tokens[0];
    const tokenStart = first === undefined ? 0 : (indexByStart.get(first.start) ?? -1);
    if (tokenStart < 0) return null;
    flat.push(window.start, window.end, tokenStart, tokenStart + window.tokens.length);
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
      start: flat[index]!,
      end: flat[index + 1]!,
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

/**
 * Byte-identity check for the encode/decode round trip — window span, token
 * value/start/end, and order.
 *
 * The SPAN comparison is not decoration: text equality alone cannot see a
 * window stored against a different occurrence of identical text, which is
 * exactly the drift `encodeWindows` used to produce.
 */
export function windowsEqual(a: readonly ProjectionWindow[], b: readonly ProjectionWindow[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const left = a[index]!;
    const right = b[index]!;
    if (left.start !== right.start || left.end !== right.end) return false;
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

const CANDIDATE_COLUMNS = `lane, scan_order, path, content, searchable, captured_at, fact_id, stream_json, windows_encoded, windows_json`;

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
 * leaves a file with no marker, which `openProjectionDb` refuses.
 *
 * `boundsJson` is the caller's frozen-bounds string, stored verbatim and
 * compared verbatim at open (S1) — see `frozenBounds` in `pre-turn-context.ts`.
 */
export function writeProjection(
  dbPath: string,
  set: ProjectionCandidateSet,
  boundsJson: string,
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
    const selectCandidate = db.prepare(`SELECT ${CANDIDATE_COLUMNS} FROM candidate WHERE id = ?`);
    db.transaction(() => {
      insertMeta.run('schema_version', String(RECALL_PROJECTION_SCHEMA_VERSION));
      insertMeta.run('built_at', new Date().toISOString());
      insertMeta.run('scanned_bytes', String(set.scannedBytes));
      // Frozen bounds, ENFORCED at open (S1).
      insertMeta.run('bounds_json', boundsJson);
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
 * Read-only handle, or null when the projection is absent, incomplete, of a
 * different schema version, built under different bounds, or unopenable.
 *
 * Never throws: every one of those states is "serve the filesystem path this
 * turn" (P2.5-I4), and a schema mismatch is a rebuild trigger, not an error
 * (decision 14). `onReject` reports WHICH state it was, so the turn's telemetry
 * can name the fallback reason (decision 17, P2.5-AC19) — without it a bounds
 * change after a build is indistinguishable from a missing file.
 */
export function openProjectionDb(
  dbPath: string,
  expectedBoundsJson: string,
  onReject?: (reason: string) => void,
): Database.Database | null {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    onReject?.(`open-failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  try {
    db.pragma('busy_timeout = 5000');
    const version = readMeta(db, 'schema_version');
    if (version !== String(RECALL_PROJECTION_SCHEMA_VERSION)) throw new Error(`schema-version: ${version}`);
    if (readMeta(db, COMPLETE_KEY) !== '1') throw new Error('incomplete: build never completed');
    const bounds = readMeta(db, 'bounds_json');
    if (bounds !== expectedBoundsJson) throw new Error(`stale-bounds: ${bounds}`);
    return db;
  } catch (error) {
    db.close();
    const message = error instanceof Error ? error.message : String(error);
    // The three throws above are tagged so the turn's telemetry can tell a
    // rebuild trigger from a defect; anything else reaching here came out of
    // SQLite itself (a truncated page, a file that is not a database) and gets
    // its own tag rather than an untagged message.
    onReject?.(/^(schema-version|incomplete|stale-bounds):/.test(message) ? message : `unreadable: ${message}`);
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
 * `headings` comes from `source_file` through a per-path memo, so every fact
 * drawn from the ledger gets the SAME array instance the live path shares by
 * reference (decision 15). One memo per hydration pass, which is why the
 * batched path threads a single instance through every batch.
 */
function headingsMemo(db: Database.Database): (candidatePath: string) => string[] {
  const byPath = new Map<string, string[]>();
  const select = db.prepare('SELECT headings_json FROM source_file WHERE path = ?');
  return (candidatePath) => {
    const memo = byPath.get(candidatePath);
    if (memo) return memo;
    const row = select.get(candidatePath) as { headings_json: string | null } | undefined;
    const headings = (row?.headings_json ? JSON.parse(row.headings_json) : []) as string[];
    byPath.set(candidatePath, headings);
    return headings;
  };
}

function toCandidate(row: CandidateRow, headingsFor: (candidatePath: string) => string[]): ProjectionCandidate {
  const stream = decodeStream(row.stream_json);
  const parsed = JSON.parse(row.windows_json) as number[] | ProjectionWindow[];
  return {
    lane: row.lane as RecallLane,
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
}

/**
 * Hydrate a whole lane in `scan_order` — never term-index order, which is what
 * `sourceOrder` being the final tie-break requires (P2.5-I2). Used by the build
 * round-trip checks and the differential harness; the turn path uses
 * `hydrateCandidates`, which hydrates only the term-index survivors.
 */
export function hydrateLane(db: Database.Database, lane: RecallLane): ProjectionCandidate[] {
  const headingsFor = headingsMemo(db);
  const rows = db
    .prepare(`SELECT ${CANDIDATE_COLUMNS} FROM candidate WHERE lane = ? ORDER BY scan_order`)
    .all(lane) as CandidateRow[];
  return rows.map((row) => toCandidate(row, headingsFor));
}

/**
 * SQLite's compiled parameter ceiling is 32,766 in the builds this project
 * ships, but a single 30k-placeholder statement also re-prepares a 300 KB SQL
 * string. Batching keeps every statement small AND gives decision 14 a real
 * unit to wrap: a batch that throws mid-hydration is caught by the read seam
 * and the turn falls back, rather than reaching `readMemoryEvidence`'s outer
 * catch (P2.5-I4).
 */
export const PROJECTION_BATCH = 900;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < values.length; at += size) out.push(values.slice(at, at + size));
  return out;
}

/**
 * Candidate ids whose term set contains at least `minimumOverlap` of `tokens`.
 *
 * This is a PREFILTER, not the ranking: `bestPassage` requires the overlap
 * inside a single passage WINDOW, and the term set is the union of the whole
 * candidate's tokens with every window's tokens, so every candidate
 * `bestPassage` would keep is necessarily in this result and some that it
 * would drop are too. Extra members score to `null` and are filtered by
 * `rankByBestPassage` exactly as they would be on the filesystem path, which
 * is what makes the prefilter invisible to the delivered set.
 *
 * `tokens` is chunked and the per-chunk counts are summed in JS. The
 * alternative — one giant `IN` list — is the same answer with a parameter-limit
 * cliff, and merging per-token rows in JS instead of counting in SQL would ship
 * the whole posting list over the boundary.
 */
export function queryTermCandidates(
  db: Database.Database,
  tokens: readonly string[],
  minimumOverlap: number,
): number[] {
  if (tokens.length === 0) return [];
  const counts = new Map<number, number>();
  for (const chunk of chunks([...new Set(tokens)], PROJECTION_BATCH)) {
    const rows = db
      .prepare(
        `SELECT candidate_id AS id, COUNT(*) AS n FROM term WHERE token IN (${chunk.map(() => '?').join(',')}) GROUP BY candidate_id`,
      )
      .all(...chunk) as Array<{ id: number; n: number }>;
    for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + row.n);
  }
  const ids: number[] = [];
  for (const [id, n] of counts) if (n >= minimumOverlap) ids.push(id);
  return ids;
}

/** What a turn actually consumes: a `SearchableCandidate` plus its lane and scan order. */
export interface TurnCandidate extends SearchableCandidate {
  id: number;
  lane: RecallLane;
  scanOrder: number;
}

/**
 * Hydrate the given candidate ids, returned sorted by lane then `scan_order`.
 *
 * ORDER IS THE CONTRACT. `sourceOrder` is array position in the pool handed to
 * `rankByBestPassage` and is compared relatively (`a.sourceOrder -
 * b.sourceOrder`), so a subset in scan order tie-breaks identically to the full
 * walk even though the absolute indices differ (P2.5-I2). Returning term-index
 * order instead would silently re-rank every tie.
 *
 * `stream_json` and `windows_json` are deliberately NOT selected here. The turn
 * needs the token stream only for candidates the process-wide cache has already
 * evicted (`hydrateStreams`), and it never needs the stored windows at all —
 * `bestPassage` rebuilds them from `searchable`, and the persisted copies exist
 * for the build's term-set union and its round-trip proof. Selecting them
 * anyway MEASURED as the dominant cost of the read: on the largest workgroup
 * those two columns are ~50 MB of JSON, and materializing plus parsing the
 * broad-query slice of them made a projection turn slower than the warm
 * filesystem walk it replaces.
 */
export function hydrateCandidates(db: Database.Database, ids: readonly number[]): TurnCandidate[] {
  if (ids.length === 0) return [];
  const headingsFor = headingsMemo(db);
  const hydrated: TurnCandidate[] = [];
  for (const chunk of chunks(ids, PROJECTION_BATCH)) {
    const rows = db
      .prepare(
        `SELECT id, lane, scan_order, path, content, searchable, captured_at FROM candidate WHERE id IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(...chunk) as Array<{
      id: number;
      lane: string;
      scan_order: number;
      path: string;
      content: string;
      searchable: string;
      captured_at: string;
    }>;
    for (const row of rows) {
      hydrated.push({
        id: row.id,
        lane: row.lane as RecallLane,
        scanOrder: row.scan_order,
        path: row.path,
        headings: headingsFor(row.path),
        content: row.content,
        searchable: row.searchable,
        capturedAt: row.captured_at,
      });
    }
  }
  return hydrated.sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : a.scanOrder - b.scanOrder));
}

/** Persisted token streams for the ids that still need one, keyed by candidate id. */
export function hydrateStreams(db: Database.Database, ids: readonly number[]): Map<number, RecallToken[]> {
  const streams = new Map<number, RecallToken[]>();
  for (const chunk of chunks(ids, PROJECTION_BATCH)) {
    const rows = db
      .prepare(`SELECT id, stream_json FROM candidate WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk) as Array<{ id: number; stream_json: string }>;
    for (const row of rows) streams.set(row.id, decodeStream(row.stream_json));
  }
  return streams;
}

/** Every `source_file` row, keyed by path — the stored side of the tree diff. */
export function readSourceFiles(db: Database.Database): Map<string, { size: string; mtimeNs: string; ino: string }> {
  const rows = db.prepare('SELECT path, size, mtime_ns, ino FROM source_file').all() as Array<{
    path: string;
    size: string;
    mtime_ns: string;
    ino: string;
  }>;
  return new Map(rows.map((row) => [row.path, { size: row.size, mtimeNs: row.mtime_ns, ino: row.ino }]));
}
