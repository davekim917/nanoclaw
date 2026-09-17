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
 * (`.github/workflows/ci-full.yml`, "Upstream divergence ratchet") fetches the pinned
 * commit and runs the report nightly, which is what makes the manifest's
 * numbers verified rather than self-reported.
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

/** One `git ls-tree -r -z` record for an arbitrary (non-upstream) tree: its mode string and blob id. */
export interface LsTreeEntry {
  mode: string;
  blob: string;
}

/**
 * `git ls-tree -r -z <ref>` → path → `{mode, blob}`, for ANY tree — used to read
 * the CHECKED ref's own tree (a PR head, not the pinned upstream commit).
 *
 * Deliberately more permissive than `parseLsTree`: it does not reject a 160000
 * gitlink or validate the mode against `GIT_MODES`. `parseLsTree`'s gitlink
 * rejection is upstream-tree-specific wording ("gitlink in the pinned upstream
 * tree"), which would misdescribe a gitlink that is the FORK's own — that case
 * is caught by `assertNoGitlinkShadows` instead, exactly as `parseLsFiles`'s
 * fork-index parsing already leaves gitlink detection to the caller rather than
 * the parser. `blob` is the object id `git cat-file --batch` needs to read the
 * entry's content for hashing.
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
 * The MALFORMED finding for a manifest committed as a symlink (mode 120000)
 * in `<ref>`'s tree, or `null` when the manifest is a regular file there, or
 * absent entirely (a genuinely missing manifest is the caller's `cat-file`/
 * `show` attempt to report, not this check's).
 *
 * `src/upstream-ratchet.json` is a generated artifact this tool itself always
 * writes as a regular file: `cat-file --filters <ref>:<path>` on a 120000
 * entry returns the RAW TARGET STRING (filters never apply to a symlink's
 * content on checkout), while a real checkout's `fs.readFileSync` FOLLOWS the
 * link to whatever it points at — the two would silently measure two
 * different files. Refused outright here rather than reconciled; see
 * `isManifestSymlink` (`src/upstream-ratchet.ts`) for the working-tree
 * counterpart.
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
 * `git cat-file --batch` output framing → object id → raw content bytes.
 *
 * The format is `<sha> SP <type> SP <size> LF <content> LF`, repeated once per
 * requested id, in the order the ids were sent on stdin. Binary-safe by
 * construction — content is never decoded as text, because a blob's bytes may
 * be arbitrary (a binary file) or a symlink's target string in a non-UTF8
 * encoding.
 *
 * `ids` must be the exact list sent to `cat-file --batch`, in the same order —
 * the framing has no separators of its own between records other than the
 * fixed header/size/LF shape, so there is no way to recover record boundaries
 * without knowing how many records to expect. This is ONLY safe for the RAW
 * (unfiltered) batch mode: `--filters` reports the PRE-filter size in this
 * same header even though it writes POST-filter (larger or smaller) bytes,
 * which desyncs this exact framing — see `hashFilteredBlob` in
 * scripts/upstream-ratchet-report.ts for why filtered content is read one
 * object at a time instead, with no size field to trust.
 *
 * Strict by construction, so a desync fails loudly instead of silently
 * misreading a later record: the returned object id and type must match the
 * request (a git response is never reordered, but a caller that reorders
 * `ids` relative to what was actually sent would otherwise attribute one
 * blob's bytes to a different path), the mandatory trailing LF after the
 * declared `size` bytes must actually be present, and no bytes may remain
 * once every requested id has been read.
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
    // `contentEnd` must be a valid index INTO the buffer (room for the
    // mandatory trailing LF byte git appends after the content), and that
    // byte must actually be LF — catches a record whose content is present
    // but whose trailing LF was silently dropped, not just one that ran out
    // of bytes mid-content.
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

/** sha256 hex of raw content bytes — the fingerprint every hashing path in this module converges on. */
export function hashBlobContent(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * `parseCatFileBatch` output → object id → sha256 hex of its content.
 *
 * This MUST agree with `hashFile` (src/upstream-ratchet.ts) byte for byte: git
 * stores a symlink's blob content as the target string itself, which is
 * exactly what `hashFile` hashes for a symlink (`fs.readlinkSync`, not the
 * pointee) — so a manifest written from a worktree's working tree and one
 * measured here from the same commit's blobs must hash identically. Proven in
 * src/upstream-ratchet-core.test.ts by hashing one fixture both ways. Only
 * true for RAW (unfiltered) content — see `hashFilteredBlob` in the report
 * script for the regular-file paths a ref's own gitattributes could transform
 * on checkout.
 */
export function hashCatFileBatch(stdout: Buffer, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, content] of parseCatFileBatch(stdout, ids)) out.set(id, hashBlobContent(content));
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
 * --exclude-standard`, which omits ignored files by default and so cannot see
 * this at all. Asking "is this path tracked?" has no such hole, and it catches a
 * path that is now a DIRECTORY too — a directory is not a tracked path, and it
 * lstat-exists.
 *
 * Being IGNORED is the one exemption, and it is a different thing entirely from
 * being invisible: an ignore rule over an upstream path is divergence the fork
 * DECLARED, the manifest records it on the entry, and `.gitignore` is itself
 * upstream-owned so the rule is counted in its own diff. See the body.
 */
export function findUntrackedShadows(
  upstreamPaths: readonly string[],
  tracked: ReadonlySet<string>,
  exists: (relPath: string) => boolean,
  ignored: ReadonlySet<string> = new Set(),
): string[] {
  // An IGNORED path is exempt, and not as a special case bolted on: the fork
  // deleted it and then told git to ignore it, so something recreating it is
  // the runtime doing its job, not content sneaking past the measurement.
  // `.claude/scheduled_tasks.lock` is the live example — a lock file that
  // appears on the production checkout whenever the system is running. Refusing
  // there would make the whole tool unusable on a live install, and the
  // divergence that matters (the .gitignore rule) is counted in `.gitignore`'s
  // own entry.
  return upstreamPaths.filter((relPath) => !tracked.has(relPath) && !ignored.has(relPath) && exists(relPath));
}

/** One upstream-owned path that is a DIRECTORY in a ref's tree rather than a blob. */
export interface DirectoryShadow {
  /** The upstream-owned path — present or deleted, it does not matter which. */
  upstreamPath: string;
  /** One concrete path found under it in the ref's tree, as evidence. */
  example: string;
}

/**
 * Upstream-owned paths that are directories in `<ref>`'s tree rather than
 * blobs — the `--check <ref>` analogue of `findUntrackedShadows` above, for a
 * bare commit instead of a working tree.
 *
 * `git ls-tree -r` lists only BLOBS, never the directories that contain them:
 * if upstream owns `foo` (a file) and `<ref>` replaces it with a directory
 * (`foo/bar`, `foo/baz`), `ls-tree -r <ref>` lists `foo/bar` and `foo/baz` and
 * says nothing about `foo` itself — there is no entry for it to be absent OR
 * present. Reading that as "foo is deleted" (what an ordinary lookup of
 * `refEntries.get('foo')` would conclude) is wrong the same way
 * `findUntrackedShadows` exists to catch for a working tree: `foo`'s
 * divergence cannot be measured, because there is no blob there at all to
 * hash or count lines against — a real checkout of `<ref>` would refuse this
 * exact tree for the same reason `findUntrackedShadows` refuses one where an
 * upstream path went from a file to a directory on disk.
 *
 * `refPaths` must be the ref's FULL path list (every blob `ls-tree -r`
 * reports), not filtered to upstream-owned paths first — the shadowing path
 * (`foo/bar`) is typically a fork-added path, not an upstream-owned one, so
 * filtering it out before computing prefixes would hide exactly the case this
 * function exists to catch.
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
  /**
   * Upstream paths the fork's `.gitignore` covers, from `git check-ignore`.
   *
   * check-ignore is index-aware and never reports a tracked path, so every
   * member of this set is one the fork does not track — i.e. deleted, as far as
   * the manifest is concerned. The entry records that fact and the working tree
   * is never consulted for it; see `checkTree` in src/upstream-ratchet.ts.
   */
  ignored: ReadonlySet<string>;
}

/**
 * Refuse a fork submodule that stands where upstream owns files.
 *
 * Checking only for an EXACT path match misses the shape that actually happens:
 * upstream owns `vendor/a.ts`, the fork replaces the whole `vendor/` directory
 * with a submodule. Nothing in the index then matches `vendor/a.ts`, so every
 * path under the gitlink records as cleanly deleted, and moving the submodule
 * pointer afterwards changes no number in the manifest at all. A gitlink that is
 * a directory ANCESTOR of an upstream-owned path shadows it exactly as
 * completely as one that replaces it.
 *
 * Refused rather than modelled: a gitlink has no bytes to hash and no lines to
 * count, so every check the ratchet makes would be vacuously true for it.
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
 * Refuse an ignored path that is ALSO tracked.
 *
 * The `ignored` flag switches off the presence, mode and hash checks for an
 * entry (see the reasoning block at the top of src/upstream-ratchet.ts), and the
 * whole justification for that is that untracked bytes are not fork source. So
 * the premise is asserted here rather than assumed.
 *
 * `git check-ignore` is index-aware and does not report tracked paths, so this
 * should never fire — which is the point. It stops the exemption from resting on
 * one flag's default behaviour: if a future git, a `--no-index`, or a caller
 * supplying its own set ever hands over a tracked path, the tool refuses instead
 * of quietly waiving the checks on real committed content. An ignore rule over a
 * tracked file is a misconfiguration in the fork, not divergence to record.
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
  assertNoGitlinkShadows(input.upstreamModes, input.forkIndex);
  assertIgnoredAreUntracked(input.ignored, input.forkIndex);
  const files: Record<string, UpstreamRatchetEntry> = {};
  for (const [relPath, upstreamMode] of input.upstreamModes) {
    const invalid = validateRelPath(relPath);
    if (invalid !== null)
      fail(`the pinned upstream tree contains an unusable path ${JSON.stringify(relPath)}: ${invalid}`);
    const stat = input.numstat.get(relPath);

    if (input.ignored.has(relPath)) {
      // Deleted-and-ignored. `git diff` measures it as deleted (it is untracked),
      // so the line count is upstream's own, and the mode recorded is upstream's.
      // The working tree is deliberately not consulted: whatever is or is not
      // sitting at that path is runtime state, not fork content.
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
 *    swapping it for arbitrary new bytes moves no number at all. Checked when
 *    EITHER side is binary, because a binary at diff 1 turning into text at
 *    diff 1 is the same escape wearing a different flag.
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
      // Binary on EITHER side, not just the current one. A divergent binary
      // recorded at diff 1 can become divergent TEXT whose numstat is also 1:
      // the bytes changed, the binary flag went away, and every number stayed
      // put. Keying on `after.binary` alone let that through as UNCHANGED. The
      // rule is: while a path is divergent and its line count is not a
      // measurement on at least one of the two sides, the fingerprint is.
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

// ── the --check exit decision ────────────────────────────────────────────────

export interface CheckOutcome {
  /** Whether `--check` exits 1. Two independent things can set this — see below. */
  failing: boolean;
  /** Every GROWTH/NEW row from `classify()` — `--accept` never applies to `--check`. */
  blocking: Row[];
  /** Every currency finding from `checkTree` run against the ref's own tree. */
  currencyFindings: Finding[];
}

/**
 * `--check <ref>`'s exit decision, as one pure function — extracted so
 * `scripts/upstream-ratchet-report.ts` cannot drop `currencyFindings` from the
 * exit code (or from the STALE-MANIFEST section) by computing `failing`
 * ad hoc; `runCheck` has nothing left to get wrong here but call this once and
 * render exactly what it returns.
 *
 * Two independent things can fail `--check`, and NEITHER alone is the whole
 * story: `classify()`'s GROWTH/NEW rows (the same line-count arbitration the
 * default report runs, just pointed at a ref) miss a manifest whose recorded
 * sha256/mode/deleted state disagrees with the ref's real tree in a way that
 * does not move the `diff` total — a same-size text edit is the case
 * `classify()` deliberately lets through. `checkTree`'s currency findings miss
 * a case where the manifest's bookkeeping IS internally consistent but the
 * fork's own arbitration was never updated to reflect legitimate growth (a
 * `--write`-and-commit that under-counted). `--check` fails if either does.
 */
export function decideCheckOutcome(rows: readonly Row[], currencyFindings: readonly Finding[]): CheckOutcome {
  const { blocking } = writeGate(rows, new Set(), false);
  const findings = [...currencyFindings];
  return { failing: blocking.length > 0 || findings.length > 0, blocking, currencyFindings: findings };
}
