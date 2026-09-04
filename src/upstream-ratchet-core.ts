/**
 * Upstream-ownership ratchet — the pure half of the git-side arbitrator.
 *
 * Everything here is a total function over strings and maps: parsing git's
 * porcelain output, turning it into manifest entries, classifying a recomputed
 * manifest against the committed one, and deciding what `--write` may write.
 * `scripts/upstream-ratchet-report.ts` is the shell around it — it runs git,
 * reads the filesystem, renders, and picks an exit code, and nothing else.
 *
 * The split exists so the arbitration has tests. `src/test-hermeticity.ts` mocks
 * `child_process` for every host suite, so a vitest test can never drive the
 * script end to end; extracting the decisions into pure functions is the only
 * way to exercise the GROWTH / NEW / SHRINK / STALE boundary matrix, the write
 * gate and the shadow check at all.
 *
 * RESIDUE, stated rather than papered over: there is no integration test that
 * builds a scratch git repo and asserts the CLI's exit codes, because a test
 * that shells out to git cannot exist in this suite. What is NOT covered here:
 * that git's real output matches the shapes `parseLsTree` / `parseLsFiles` /
 * `parseNumstat` expect, and that the script wires these functions together in
 * the right order. Those are covered by running the script for real — the CI job
 * (`.github/workflows/ci.yml`, "Upstream divergence ratchet") fetches the pinned
 * commit and runs the report on every PR, which is what makes the manifest's
 * numbers verified rather than self-reported.
 */
import {
  GITLINK_MODE,
  isGitMode,
  validateRelPath,
  type GitMode,
  type UpstreamRatchetEntry,
  type UpstreamRatchetManifest,
} from './upstream-ratchet.js';

export class RatchetError extends Error {}

function fail(message: string): never {
  throw new RatchetError(message);
}

// ── parsing git's porcelain output ───────────────────────────────────────────

/**
 * `git ls-tree -r -z <sha>` → path → mode.
 *
 * Records are `<mode> SP <type> SP <sha>TAB<path>\0`. `-z` matters: without it
 * git C-quotes any path with a space or a non-ASCII byte, and the quoted name
 * would silently not match the same path read from `-z` output elsewhere.
 */
export function parseLsTree(stdout: string): Map<string, GitMode> {
  const out = new Map<string, GitMode>();
  for (const record of stdout.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab === -1) fail(`could not parse ls-tree record: ${JSON.stringify(record)}`);
    const relPath = record.slice(tab + 1);
    const mode = record.slice(0, tab).split(' ')[0] ?? '';
    if (mode === GITLINK_MODE) {
      fail(`submodules are not supported by the ratchet: ${relPath} is a gitlink in the pinned upstream tree`);
    }
    if (!isGitMode(mode))
      fail(`unexpected git mode ${JSON.stringify(mode)} for ${relPath} in the pinned upstream tree`);
    out.set(relPath, mode);
  }
  return out;
}

/**
 * `git ls-files -s -z` → path → mode, for the fork's index.
 *
 * Records are `<mode> SP <sha> SP <stage>TAB<path>\0`. Used for two things: the
 * set of TRACKED paths (the shadow check below), and catching a gitlink on the
 * fork's side. The mode a manifest entry RECORDS comes from `lstat` instead —
 * see `fileModeOf` in src/upstream-ratchet.ts for why.
 */
export function parseLsFiles(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const record of stdout.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab === -1) fail(`could not parse ls-files record: ${JSON.stringify(record)}`);
    out.set(record.slice(tab + 1), record.slice(0, tab).split(' ')[0] ?? '');
  }
  return out;
}

export interface NumstatRecord {
  /** added + deleted lines, or `null` when git reported the path as binary. */
  lines: number | null;
}

/**
 * `git diff --numstat --no-renames -z <sha>` → path → line delta.
 *
 * Records are `<added>TAB<deleted>TAB<path>\0`. `--no-renames` keeps every
 * record to that one shape; with renames on, a record carries two paths and the
 * parse below would take the old one.
 */
export function parseNumstat(stdout: string): Map<string, NumstatRecord> {
  const out = new Map<string, NumstatRecord>();
  for (const record of stdout.split('\0')) {
    if (record === '') continue;
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab === -1 || secondTab === -1) fail(`could not parse numstat record: ${JSON.stringify(record)}`);
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    const relPath = record.slice(secondTab + 1);
    if (added === '-' || deleted === '-') {
      out.set(relPath, { lines: null });
      continue;
    }
    const lines = Number(added) + Number(deleted);
    if (!Number.isInteger(lines) || lines < 0) fail(`could not parse numstat counts: ${JSON.stringify(record)}`);
    out.set(relPath, { lines });
  }
  return out;
}

// ── untracked shadows ────────────────────────────────────────────────────────

/**
 * Upstream-owned paths that exist on disk but are not tracked by the fork.
 *
 * `git diff <commit>` only ever looks at TRACKED paths, so such a path reads as
 * fully deleted while `lstat` and `hashFile` happily consume whatever is there.
 * The entry would then record upstream's whole line count as the fork's
 * divergence and bless arbitrary content — the manifest would be measuring one
 * file and hashing another.
 *
 * Derived from the TRACKED set rather than from `git ls-files -o
 * --exclude-standard`: an enumeration of untracked files omits ignored ones by
 * default, and a fork-deleted upstream path recreated as an ignored file is
 * exactly the case worth catching. Asking "is this path tracked?" has no such
 * hole, and it catches a path that is now a DIRECTORY too — a directory is not
 * a tracked path, and it lstat-exists.
 */
export function findUntrackedShadows(
  upstreamPaths: readonly string[],
  tracked: ReadonlySet<string>,
  exists: (relPath: string) => boolean,
): string[] {
  return upstreamPaths.filter((relPath) => !tracked.has(relPath) && exists(relPath));
}

// ── building the current manifest ────────────────────────────────────────────

export interface BuildInput {
  /** The resolved 40-hex upstream commit. */
  upstream: string;
  /** Every path upstream owns at that commit, with its mode. */
  upstreamModes: ReadonlyMap<string, GitMode>;
  /** The fork's index, for the tracked set and gitlink detection. */
  forkIndex: ReadonlyMap<string, string>;
  /** `git diff --numstat` against the pinned commit. */
  numstat: ReadonlyMap<string, NumstatRecord>;
  /** The fork's working-tree mode for a path, or `null` when it is absent. */
  modeOf: (relPath: string) => GitMode | null;
  /** sha256 of the fork's current bytes, or `null` when the path is absent. */
  hashOf: (relPath: string) => string | null;
}

/**
 * The manifest the fork's working tree implies right now.
 *
 * `diff` folds two things into one number: the line delta git measured, and one
 * unit for a mode that differs from upstream's. A mode change carries no lines,
 * so without that term `chmod -x bin/foo` is invisible to every check here —
 * bytes unchanged, numstat empty, verdict UNCHANGED. Counting it as one unit
 * makes it classify like any other change, at the cost of reading as "one line"
 * in the totals; the entry's `mode` field says which it actually was.
 */
export function buildManifest(input: BuildInput): UpstreamRatchetManifest {
  const files: Record<string, UpstreamRatchetEntry> = {};
  for (const [relPath, upstreamMode] of input.upstreamModes) {
    const invalid = validateRelPath(relPath);
    if (invalid !== null)
      fail(`the pinned upstream tree contains an unusable path ${JSON.stringify(relPath)}: ${invalid}`);
    if (input.forkIndex.get(relPath) === GITLINK_MODE) {
      fail(`submodules are not supported by the ratchet: ${relPath} is a gitlink in the fork`);
    }
    const forkMode = input.modeOf(relPath);
    const stat = input.numstat.get(relPath);

    if (forkMode === null) {
      // Deleted in the fork. Its divergence is upstream's own line count, and
      // the mode recorded is upstream's — there is no fork mode to record.
      const entry: UpstreamRatchetEntry = {
        diff: stat === undefined ? 0 : (stat.lines ?? 1),
        mode: upstreamMode,
        sha256: null,
        deleted: true,
      };
      if (stat !== undefined && stat.lines === null) entry.binary = true;
      files[relPath] = entry;
      continue;
    }

    const modeDelta = forkMode === upstreamMode ? 0 : 1;
    const entry: UpstreamRatchetEntry = {
      diff: modeDelta,
      mode: forkMode,
      sha256: input.hashOf(relPath),
    };
    if (stat !== undefined) {
      if (stat.lines === null) {
        // Binary and differing: no lines to count, so one unit for the bytes.
        entry.binary = true;
        entry.diff += 1;
      } else {
        entry.diff += stat.lines;
      }
    }
    files[relPath] = entry;
  }
  return { upstream: input.upstream, paths: '', files };
}

// ── classification ───────────────────────────────────────────────────────────

export type Verdict = 'GROWTH' | 'NEW' | 'SHRINK' | 'STALE' | 'UNCHANGED' | 'DROPPED';

export interface Row {
  verdict: Verdict;
  path: string;
  before: number;
  after: number;
  deletedBefore: boolean;
  deletedAfter: boolean;
  /** Why a flat-diff entry is still blocking, when it is. */
  reason: string | null;
}

/** Whether a verdict stops a plain report and gates `--write`. */
export function isBlocking(verdict: Verdict): boolean {
  return verdict === 'GROWTH' || verdict === 'NEW';
}

/**
 * Every upstream-owned path, judged against the committed manifest.
 *
 * Three things make a flat or shrinking `diff` blocking anyway, because for
 * these the line count is not the whole measurement:
 *
 *  - **mode changed** — folded into `diff` as one unit, so it usually surfaces
 *    as GROWTH on its own; this clause catches the case where a mode change and
 *    a one-line shrink cancel out.
 *  - **binary bytes changed** — every differing binary scores 1 forever, so
 *    swapping it for arbitrary new bytes moves no number at all.
 *  - **deleted → present or present → deleted** — a presence flip, not a size
 *    change.
 *
 * A TEXT file re-edited to the same line count is deliberately NOT blocking:
 * there, added+deleted IS the metric, and an equal-size edit has not grown the
 * fork's divergence. Treating it as growth would make every reformat need an
 * `--accept` and train people to pass `--accept-all`.
 */
export function classify(committed: UpstreamRatchetManifest, current: UpstreamRatchetManifest): Row[] {
  const rows: Row[] = [];
  for (const [relPath, after] of Object.entries(current.files)) {
    const before = committed.files[relPath];
    const beforeDiff = before?.diff ?? 0;
    const deletedBefore = before?.deleted === true;
    const deletedAfter = after.deleted === true;

    // NEW before GROWTH: `0 → >0` is arithmetically growth too, but it is the
    // case worth naming — the fork just took ownership of a file it had been
    // carrying byte-identical, or dropped one it had been carrying at all. An
    // unlisted path (only possible right after a re-pin) is new by the same
    // reading: nothing has audited it.
    const isNew = before === undefined || (beforeDiff === 0 && after.diff > 0) || (!deletedBefore && deletedAfter);

    let reason: string | null = null;
    if (before !== undefined && !isNew) {
      if (before.mode !== after.mode) reason = `mode ${before.mode} → ${after.mode}`;
      else if (after.binary === true && after.diff > 0 && after.diff === beforeDiff && before.sha256 !== after.sha256) {
        reason = 'binary bytes changed';
      } else if (deletedBefore && !deletedAfter) reason = 'restored in fork';
    }

    const verdict: Verdict = isNew
      ? 'NEW'
      : reason !== null
        ? 'GROWTH'
        : after.diff > beforeDiff
          ? 'GROWTH'
          : after.diff === 0 && beforeDiff > 0
            ? 'STALE'
            : after.diff < beforeDiff
              ? 'SHRINK'
              : 'UNCHANGED';

    rows.push({ verdict, path: relPath, before: beforeDiff, after: after.diff, deletedBefore, deletedAfter, reason });
  }

  // Paths that left upstream's tree between the committed pin and a new one.
  // Not a fork action, so never a failure — reported so a re-pin's delta is
  // complete. Impossible while the pin is fixed.
  for (const [relPath, before] of Object.entries(committed.files)) {
    if (current.files[relPath] !== undefined) continue;
    rows.push({
      verdict: 'DROPPED',
      path: relPath,
      before: before.diff,
      after: 0,
      deletedBefore: before.deleted === true,
      deletedAfter: false,
      reason: 'no longer in the pinned upstream tree',
    });
  }

  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

// ── the write gate ───────────────────────────────────────────────────────────

export interface WriteGate {
  /** Every blocking row, accepted or not. */
  blocking: Row[];
  /** The blocking rows no `--accept` covers. Non-empty means `--write` refuses. */
  unaccepted: Row[];
}

/**
 * Which rows stop a write, and which `--accept` clears.
 *
 * `--accept-all` clears everything, and is what `--upstream` implies: re-pinning
 * moves the base under every number at once, so there is no honest per-path
 * arbitration left to do.
 */
export function writeGate(rows: readonly Row[], accept: ReadonlySet<string>, acceptAll: boolean): WriteGate {
  const blocking = rows.filter((row) => isBlocking(row.verdict));
  return { blocking, unaccepted: acceptAll ? [] : blocking.filter((row) => !accept.has(row.path)) };
}
