/**
 * Upstream-ownership ratchet, pure half: parse git porcelain, build manifest entries, classify against the
 * committed manifest, gate `--write`. `scripts/upstream-ratchet-report.ts` is the shell (git, fs, exit code).
 * Split out because the host test setup mocks `child_process`, so the CLI itself is only exercised by the
 * nightly ci-full "Upstream divergence ratchet" job.
 */
import { createHash } from 'node:crypto';

import {
  GITLINK_MODE,
  isGitMode,
  MANIFEST_REL,
  REGENERATE_HINT,
  validateRelPath,
  type Finding,
  type GitMode,
  type UpstreamRatchetEntry,
  type UpstreamRatchetManifest,
} from './upstream-ratchet.js';

export class RatchetError extends Error {}

function fail(message: string): never {
  throw new RatchetError(message);
}

/** `git ls-tree -r -z <sha>` → path → mode. `-z` is required: git otherwise C-quotes unusual paths. */
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

export interface LsTreeEntry {
  mode: string;
  blob: string;
}

/**
 * `git ls-tree -r -z <ref>` → path → `{mode, blob}` for any tree. Unlike `parseLsTree` it accepts gitlinks: a
 * fork-side gitlink is caught by `assertNoGitlinkShadows` instead.
 */
export function parseLsTreeEntries(stdout: string): Map<string, LsTreeEntry> {
  const out = new Map<string, LsTreeEntry>();
  for (const record of stdout.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab === -1) fail(`could not parse ls-tree record: ${JSON.stringify(record)}`);
    const relPath = record.slice(tab + 1);
    const meta = record.slice(0, tab).split(' ');
    const mode = meta[0] ?? '';
    const blob = meta[2] ?? '';
    if (mode === '' || blob === '') fail(`could not parse ls-tree record: ${JSON.stringify(record)}`);
    out.set(relPath, { mode, blob });
  }
  return out;
}

/**
 * MALFORMED when the manifest is a symlink in `<ref>`'s tree, else `null` (absence is the caller's to report).
 * `cat-file --filters` returns a symlink's raw target while a checkout's readFileSync follows it, so the two
 * would measure different files.
 */
export function manifestSymlinkFinding(entries: ReadonlyMap<string, LsTreeEntry>): Finding | null {
  const entry = entries.get(MANIFEST_REL);
  if (entry === undefined || entry.mode !== '120000') return null;
  return {
    kind: 'malformed',
    path: MANIFEST_REL,
    detail: 'manifest must be a regular file, not a symlink',
    hint: `regenerate: ${REGENERATE_HINT}`,
  };
}

/**
 * `git cat-file --batch` output → object id → raw bytes (never decoded). `ids` must be exactly the list sent, in
 * order: the framing has no other record boundaries. RAW mode only: `--filters` reports the pre-filter size in the
 * header, which desyncs this framing (see `hashFilteredBlob` in the report script). Strict: id, type, trailing LF
 * and no leftover bytes are all checked, so a desync fails loudly.
 */
export function parseCatFileBatch(stdout: Buffer, ids: readonly string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let offset = 0;
  for (const id of ids) {
    const headerEnd = stdout.indexOf(0x0a, offset);
    if (headerEnd === -1) fail(`cat-file --batch output truncated while reading the header for ${id}`);
    const header = stdout.subarray(offset, headerEnd).toString('utf8');
    const parts = header.split(' ');
    if (parts[1] === 'missing') fail(`git object ${parts[0] ?? id} is missing from this clone`);
    if (parts.length !== 3) fail(`could not parse cat-file --batch header: ${JSON.stringify(header)}`);
    const [oid, type, sizeStr] = parts;
    if (oid !== id) {
      fail(
        `cat-file --batch returned object ${JSON.stringify(oid)} where ${JSON.stringify(id)} was requested — the ` +
          `response is out of sync with the request`,
      );
    }
    if (type !== 'blob') fail(`cat-file --batch returned type ${JSON.stringify(type)} for ${id}, expected blob`);
    const size = Number(sizeStr);
    if (!Number.isInteger(size) || size < 0) fail(`could not parse cat-file --batch header: ${JSON.stringify(header)}`);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    // Must index INTO the buffer and be LF: catches a dropped trailing LF, not just a short read.
    if (contentEnd >= stdout.length || stdout[contentEnd] !== 0x0a) {
      fail(`cat-file --batch output truncated or missing its trailing newline while reading the content for ${id}`);
    }
    out.set(id, stdout.subarray(contentStart, contentEnd));
    offset = contentEnd + 1;
  }
  if (offset !== stdout.length) {
    fail(
      `cat-file --batch output has ${stdout.length - offset} unexpected trailing byte(s) after the ${ids.length} ` +
        `requested record(s)`,
    );
  }
  return out;
}

export function hashBlobContent(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Must agree with `hashFile` (src/upstream-ratchet.ts) byte for byte: a symlink's blob is its target string, which
 * `hashFile` also hashes. Raw content only (see `hashFilteredBlob`).
 */
export function hashCatFileBatch(stdout: Buffer, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, content] of parseCatFileBatch(stdout, ids)) out.set(id, hashBlobContent(content));
  return out;
}

/** `git ls-files -s -z` → path → mode: the tracked set and fork-side gitlinks. Recorded modes come from `lstat`. */
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

/** `git diff --numstat --no-renames -z <sha>`; with renames a record carries two paths. */
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

/**
 * Upstream-owned paths on disk but untracked (including a path that became a directory): `git diff` reads them as
 * deleted while `lstat`/`hashFile` consume whatever is there. Uses the tracked set because `ls-files -o` omits
 * ignored files. Ignored paths are exempt: that divergence is declared and counted in `.gitignore`'s own entry.
 */
export function findUntrackedShadows(
  upstreamPaths: readonly string[],
  tracked: ReadonlySet<string>,
  exists: (relPath: string) => boolean,
  ignored: ReadonlySet<string> = new Set(),
): string[] {
  // Ignored paths are runtime state (e.g. `.claude/scheduled_tasks.lock` on a live install).
  return upstreamPaths.filter((relPath) => !tracked.has(relPath) && !ignored.has(relPath) && exists(relPath));
}

export interface DirectoryShadow {
  upstreamPath: string;
  example: string;
}

/**
 * Upstream-owned paths that are directories in `<ref>`'s tree, the `--check` analogue of `findUntrackedShadows`.
 * `ls-tree -r` lists only blobs, so a file replaced by a directory would otherwise read as deleted.
 * `refPaths` must be the full blob list: the shadowing child path is usually fork-added.
 */
export function findDirectoryShadows(upstreamPaths: readonly string[], refPaths: readonly string[]): DirectoryShadow[] {
  const exampleByPrefix = new Map<string, string>();
  for (const refPath of refPaths) {
    const segments = refPath.split('/');
    for (let i = 1; i < segments.length; i += 1) {
      const prefix = segments.slice(0, i).join('/');
      if (!exampleByPrefix.has(prefix)) exampleByPrefix.set(prefix, refPath);
    }
  }
  const shadows: DirectoryShadow[] = [];
  for (const upstreamPath of upstreamPaths) {
    const example = exampleByPrefix.get(upstreamPath);
    if (example !== undefined) shadows.push({ upstreamPath, example });
  }
  return shadows;
}

export interface BuildInput {
  upstream: string;
  upstreamModes: ReadonlyMap<string, GitMode>;
  forkIndex: ReadonlyMap<string, string>;
  /** `git diff --numstat` against the pinned commit. */
  numstat: ReadonlyMap<string, NumstatRecord>;
  /** The fork's working-tree mode for a path, or `null` when it is absent. */
  modeOf: (relPath: string) => GitMode | null;
  /** sha256 of the fork's current bytes, or `null` when the path is absent. */
  hashOf: (relPath: string) => string | null;
  /** From `git check-ignore`, which is index-aware, so every member is untracked (deleted, for the manifest). */
  ignored: ReadonlySet<string>;
}

/**
 * Refuse a fork gitlink at, or an ANCESTOR of, an upstream-owned path: a gitlink has no bytes or lines, so every
 * check would be vacuously true.
 */
function assertNoGitlinkShadows(
  upstreamModes: ReadonlyMap<string, GitMode>,
  forkIndex: ReadonlyMap<string, string>,
): void {
  for (const [gitlink, mode] of forkIndex) {
    if (mode !== GITLINK_MODE) continue;
    const prefix = gitlink + '/';
    for (const relPath of upstreamModes.keys()) {
      if (relPath !== gitlink && !relPath.startsWith(prefix)) continue;
      fail(
        `submodules are not supported by the ratchet: ${gitlink} is a gitlink in the fork` +
          (relPath === gitlink ? '' : `, and it stands where upstream owns ${relPath}`),
      );
    }
  }
}

/**
 * Refuse an ignored path that is also tracked: the ignored flag waives presence/mode/hash checks on the premise
 * that untracked bytes are not fork source, so the premise is asserted rather than left to check-ignore's default.
 */
function assertIgnoredAreUntracked(ignored: ReadonlySet<string>, forkIndex: ReadonlyMap<string, string>): void {
  for (const relPath of ignored) {
    if (!forkIndex.has(relPath)) continue;
    fail(
      `${relPath} is matched by a .gitignore rule but is TRACKED in the fork. An ignore rule over a tracked ` +
        `file is a misconfiguration (git honours the index over the rule), and the ratchet will not waive its ` +
        `content checks for a file the fork really owns. Remove the rule or untrack the file.`,
    );
  }
}

/**
 * The manifest the working tree implies now. `diff` adds one unit for a mode change, which carries no lines and
 * would otherwise be invisible; `mode` says which it was.
 */
export function buildManifest(input: BuildInput): UpstreamRatchetManifest {
  assertNoGitlinkShadows(input.upstreamModes, input.forkIndex);
  assertIgnoredAreUntracked(input.ignored, input.forkIndex);
  const files: Record<string, UpstreamRatchetEntry> = {};
  for (const [relPath, upstreamMode] of input.upstreamModes) {
    const invalid = validateRelPath(relPath);
    if (invalid !== null)
      fail(`the pinned upstream tree contains an unusable path ${JSON.stringify(relPath)}: ${invalid}`);
    const stat = input.numstat.get(relPath);

    if (input.ignored.has(relPath)) {
      // Deleted-and-ignored: upstream's line count and mode; the working tree is runtime state, never consulted.
      const entry: UpstreamRatchetEntry = {
        diff: stat === undefined ? 0 : (stat.lines ?? 1),
        mode: upstreamMode,
        sha256: null,
        deleted: true,
        ignored: true,
      };
      if (stat !== undefined && stat.lines === null) entry.binary = true;
      files[relPath] = entry;
      continue;
    }

    const forkMode = input.modeOf(relPath);

    if (forkMode === null) {
      // Deleted in the fork: upstream's line count and mode.
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

export function isBlocking(verdict: Verdict): boolean {
  return verdict === 'GROWTH' || verdict === 'NEW';
}

/**
 * Every upstream-owned path judged against the committed manifest. Blocking even when `diff` is flat or shrinking:
 *  - **mode changed** (a mode unit and a one-line shrink can cancel);
 *  - **binary bytes changed**, on EITHER side (a binary scores 1 forever, and binary→text at 1 is the same escape);
 *  - **presence flip** (deleted ↔ present).
 * A text file re-edited to the same line count is deliberately NOT blocking.
 */
export function classify(committed: UpstreamRatchetManifest, current: UpstreamRatchetManifest): Row[] {
  const rows: Row[] = [];
  for (const [relPath, after] of Object.entries(current.files)) {
    const before = committed.files[relPath];
    const beforeDiff = before?.diff ?? 0;
    const deletedBefore = before?.deleted === true;
    const deletedAfter = after.deleted === true;

    // NEW before GROWTH: taking ownership of a byte-identical file, dropping one, or an unaudited unlisted path.
    const isNew = before === undefined || (beforeDiff === 0 && after.diff > 0) || (!deletedBefore && deletedAfter);

    let reason: string | null = null;
    if (before !== undefined && !isNew) {
      if (before.mode !== after.mode) reason = `mode ${before.mode} → ${after.mode}`;
      // Either side binary: divergent binary at 1 can become divergent text at 1 with every number unchanged.
      else if (after.diff > 0 && (before.binary === true || after.binary === true) && before.sha256 !== after.sha256) {
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

  // Paths that left upstream between pins: reported, never failing.
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

export interface WriteGate {
  blocking: Row[];
  /** The blocking rows no `--accept` covers. Non-empty means `--write` refuses. */
  unaccepted: Row[];
}

/** `--accept-all` (implied by `--upstream`: re-pinning moves every number) clears everything. */
export function writeGate(rows: readonly Row[], accept: ReadonlySet<string>, acceptAll: boolean): WriteGate {
  const blocking = rows.filter((row) => isBlocking(row.verdict));
  return { blocking, unaccepted: acceptAll ? [] : blocking.filter((row) => !accept.has(row.path)) };
}

export interface CheckOutcome {
  failing: boolean;
  /** Every GROWTH/NEW row from `classify()` — `--accept` never applies to `--check`. */
  blocking: Row[];
  /** Every currency finding from `checkTree` run against the ref's own tree. */
  currencyFindings: Finding[];
}

/**
 * `--check <ref>` exit decision, kept pure so the script cannot drop `currencyFindings` from the exit code. Fails
 * on either: `classify()` misses a same-size edit with stale sha/mode; `checkTree` misses under-counted growth.
 */
export function decideCheckOutcome(rows: readonly Row[], currencyFindings: readonly Finding[]): CheckOutcome {
  const { blocking } = writeGate(rows, new Set(), false);
  const findings = [...currencyFindings];
  return { failing: blocking.length > 0 || findings.length > 0, blocking, currencyFindings: findings };
}
