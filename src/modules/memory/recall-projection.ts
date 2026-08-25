/**
 * Recall projection BUILD — per-workgroup SQLite projection of the pre-turn
 * memory candidate set (docs/specs/workgroup-cerebro/plan.md §P2.5).
 *
 * This module owns the write side: replaying `readMemoryEvidence`'s
 * candidate-generation pipeline and the promote protocol. The schema, the
 * encoding, and every SQLite primitive live in `recall-projection-store.ts` —
 * a leaf both this module and `pre-turn-context.ts` can depend on without a
 * cycle, which the read seam (§P2.5.6 step 6) needs.
 *
 * Three things about the shape are load-bearing and easy to "improve" into a
 * silent divergence:
 *
 * - THERE IS ONE DERIVATION, NOT TWO. `listRecallFiles`, `recallScanOrder` and
 *   `scanRecallCandidates` are imported from `pre-turn-context.ts` and are the
 *   SAME functions the live turn runs — the duplicate loop phase 1 left here
 *   (and which had already drifted once) is gone. The delivered contract is
 *   byte-identical output (P2.5-I1); a second implementation of any part of it
 *   is a drift generator.
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
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  frozenBoundsJson,
  LANE_EXCERPT_CHARS,
  listRecallFiles,
  passageWindows,
  recallScanOrder,
  recallScannedBytesBudget,
  scanRecallCandidates,
  statSourceIdentity,
  tokenStreamForRecall,
  type ContextNotice,
  type RecallSourceSink,
  type SearchableCandidate,
} from './pre-turn-context.js';
import {
  writeProjection,
  type ProjectionCandidate,
  type ProjectionCandidateSet,
  type ProjectionSourceFile,
  type RecallLane,
} from './recall-projection-store.js';

// The store's surface is the projection's public API; re-exported so callers
// (and phase 1's tests) do not have to know which half of the split a symbol
// landed in.
export {
  hydrateCandidates,
  hydrateStreams,
  hydrateLane,
  openProjectionDb,
  projectionDir,
  projectionPath,
  queryTermCandidates,
  readProjectionSummary,
  readSourceFiles,
  RECALL_PROJECTION_SCHEMA_VERSION,
  termsOf,
  windowsEqual,
  writeProjection,
  type ProjectionCandidate,
  type ProjectionCandidateSet,
  type ProjectionSourceFile,
  type ProjectionSummary,
  type ProjectionWindow,
  type RecallLane,
  type TurnCandidate,
} from './recall-projection-store.js';
export { frozenBounds, frozenBoundsJson, LANE_EXCERPT_CHARS } from './pre-turn-context.js';

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

/**
 * Replay of `readMemoryEvidence`'s candidate-generation block, minus the two
 * per-turn lanes it cannot freeze.
 *
 * Deliberately excluded, and why:
 * - CORE_PATHS reads are bootstrap-only and consume the shared byte budget
 *   before the scan loop. Their inclusion is a per-turn property.
 * - The preference lane depends on `involvedSenderNames`, i.e. on who is in the
 *   conversation (decision 16). A build cannot know that.
 *
 * Both mean the build starts the scan loop with `scannedBytes = 0` — the
 * maximum-budget case. The consumed total is returned so the read path can
 * assert decision 16's precondition still holds (P2.5-I8).
 */
export function buildProjectionCandidates(root: string): ProjectionCandidateSet {
  if (!fs.existsSync(root)) throw new Error(`canonical memory tree missing: ${root}`);
  const canonicalRoot = fs.realpathSync(root);
  if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error(`canonical memory tree is not a directory: ${root}`);

  const notices: ContextNotice[] = [];
  const scanOrder = recallScanOrder(root, listRecallFiles(root, notices));

  // One row per LISTED path, including the ones the scan skipped, so the tree
  // diff can see added and removed in both directions (decision 5).
  const sources: ProjectionSourceFile[] = [];
  const sink: RecallSourceSink = {
    skipped(relative, absolute) {
      // The live path never opens these, so a vanished one is not a divergence.
      const stats = statSourceIdentity(absolute);
      if (stats !== null) sources.push({ ...stats, path: relative, headings: null });
    },
    scanning(relative, absolute) {
      const before = statSourceIdentity(absolute);
      return (headings) => {
        const stats = before ?? statSourceIdentity(absolute);
        if (stats === null) throw new Error(`cannot stat ${relative} after reading it`);
        // `headings` is the SAME instance every fact from this file shares
        // (decision 15); stored on `source_file`, not per candidate row, so
        // hydration hands back one array the way the live path does.
        sources.push({ ...stats, path: relative, headings });
      };
    },
  };

  const scanned = scanRecallCandidates(root, canonicalRoot, scanOrder, notices, 0, sink);
  // Decision 16 / P2.5-I8, build half. A scan that exhausted the shared budget
  // starting from ZERO means the live path's candidate set depends on how many
  // bytes the core and preference lanes spent first — i.e. on who is in the
  // conversation. No frozen projection can reproduce that, and the read-side
  // assertion would reject this file on every turn anyway, so fail here rather
  // than spend eight seconds producing something unusable.
  if (scanned.scannedBytes >= recallScannedBytesBudget()) {
    throw new Error(
      `recall projection: the ranked scan exhausted the shared scannedBytes budget (${scanned.scannedBytes} of ${recallScannedBytesBudget()}); which candidates exist would depend on the turn's preference lane (decision 16)`,
    );
  }
  const candidates = [
    ...scanned.fileCandidates.map((candidate, scanOrderInLane) => project(candidate, 'file', scanOrderInLane)),
    ...scanned.factCandidates.map((candidate, scanOrderInLane) => project(candidate, 'fact', scanOrderInLane)),
  ];
  return { candidates, sources, scannedBytes: scanned.scannedBytes, notices };
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
 * renamed-but-markerless file; `openProjectionDb`'s marker check guards the
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
    written = writeProjection(nextPath, set, frozenBoundsJson());
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
