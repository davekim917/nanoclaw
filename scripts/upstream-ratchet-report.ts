#!/usr/bin/env tsx
/**
 * Upstream-ownership ratchet — the git half.
 *
 * `src/upstream-ratchet.ts` (and the vitest suite over it) can only prove the
 * manifest is CURRENT: it has no git and, in CI, no upstream commit objects
 * until this tool's own CI step fetches them. This script is where the
 * arbitration runs. It recomputes every upstream-owned path's divergence against
 * the PINNED commit and compares that to the committed manifest:
 *
 *   GROWTH     the fork diverged further in that file        → fails
 *   NEW        the file was byte-identical and no longer is,
 *              or was present and is now deleted             → fails
 *   SHRINK     the fork moved back toward upstream           → always allowed
 *   STALE      recorded as divergent, now byte-identical     → allowed, but the
 *              manifest owes a regeneration
 *   UNCHANGED  same divergence as recorded
 *   DROPPED    the path left upstream's tree (re-pin only)   → never a failure
 *
 * Modes:
 *   (default)              report; exit 1 on any GROWTH or NEW, else 0
 *   --write                regenerate src/upstream-ratchet.json; REFUSES while
 *                          any GROWTH or NEW path is not named by --accept
 *   --accept <path>        (repeatable, `--accept=<path>` too) permit one path
 *   --accept-all           permit all of them
 *   --upstream <rev>       re-pin; resolves <rev> with `git rev-parse --verify`
 *                          and persists the full 40-hex commit id. Implies
 *                          --write and --accept-all, because re-pinning changes
 *                          every number for reasons outside the fork
 *   --root <dir>           repo to operate on (default: this script's checkout)
 *   --json                 machine-readable output
 *   --check <ref>          evaluate <ref>'s own committed tree instead of the
 *                          working tree — the merge-gate mode: no writes, no
 *                          working-tree dependence. Also runs a STALE-MANIFEST
 *                          currency check (sha256/mode/deleted vs <ref>'s real
 *                          tree). Incompatible with --write, --accept,
 *                          --accept-all and --upstream. See "Checking a PR
 *                          head before merge" in docs/upstream-ratchet.md.
 *
 * Exit 2 (not 1) when the pinned commit is not in the clone: that is "cannot
 * measure", not "the ratchet failed", and CI needs to tell them apart. Same
 * code when a `--check` ref does not resolve, or carries no manifest.
 *
 * This file holds NO decisions. Parsing, entry building, classification and the
 * write gate all live in `src/upstream-ratchet-core.ts` so they can be tested
 * without a subprocess; what is left here is git invocation, filesystem access,
 * rendering and the exit code.
 *
 * Cost: five whole-tree git calls (`rev-parse`, `ls-tree`, `ls-files`,
 * `diff --numstat`, `check-ignore --stdin`), never a per-file one. `--check`
 * costs four (`rev-parse`, `show`, two `ls-tree`, `diff --numstat`) plus ONE
 * `cat-file --batch` over <ref>'s blob ids, in place of `ls-files`/lstat/
 * `check-ignore` — there is no working tree or index for a bare commit.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildManifest,
  classify,
  decideCheckOutcome,
  findDirectoryShadows,
  findUntrackedShadows,
  hashBlobContent,
  hashCatFileBatch,
  manifestSymlinkFinding,
  parseLsFiles,
  parseLsTree,
  parseLsTreeEntries,
  parseNumstat,
  RatchetError,
  writeGate,
  type Row,
  type Verdict,
} from '../src/upstream-ratchet-core.js';
import {
  acceptFlag,
  checkTree,
  divergentEntries,
  fileModeOf,
  hashFile,
  isGitMode,
  isManifestSymlink,
  manifestPath,
  MANIFEST_REL,
  pathExists,
  readManifest,
  REGENERATE_HINT,
  sealManifest,
  shellQuote,
  totalDiffLines,
  validateManifestShape,
  writeManifest,
  type Finding,
  type GitMode,
  type TreeReader,
  type UpstreamRatchetManifest,
} from '../src/upstream-ratchet.js';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Options {
  root: string;
  write: boolean;
  accept: Set<string>;
  acceptAll: boolean;
  upstream: string | null;
  json: boolean;
  /** `--check <ref>`: evaluate `<ref>`'s own tree instead of the working tree. */
  check: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    root: SCRIPT_ROOT,
    write: false,
    accept: new Set<string>(),
    acceptAll: false,
    upstream: null,
    json: false,
    check: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      // A path may legitimately begin with a dash, so `--accept -- -weird.md`
      // has to stay possible; only a missing value is an error.
      if (value === undefined) fail(`${arg} needs a value`);
      i += 1;
      return value;
    };
    // `--flag=value` as well as `--flag value`: a path starting with a dash is
    // unambiguous in the first form, and shells and CI configs prefer it.
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);

    if (name === '--root') options.root = path.resolve(inline ?? next());
    else if (name === '--write') options.write = true;
    else if (name === '--accept') options.accept.add(normalizeRel(inline ?? next()));
    else if (name === '--accept-all') options.acceptAll = true;
    else if (name === '--upstream') options.upstream = inline ?? next();
    else if (name === '--json') options.json = true;
    else if (name === '--check') options.check = inline ?? next();
    else if (name === '--help' || name === '-h') usage();
    // `pnpm run ratchet:report -- --write` can forward a bare `--`.
    else if (arg !== '--') fail(`unknown argument: ${arg}`);
  }
  if (options.upstream !== null) {
    // Re-pinning moves the base under every path at once. There is no honest
    // per-path arbitration to do, so it writes and accepts everything, with the
    // full delta printed for review.
    options.write = true;
    options.acceptAll = true;
  }
  if (options.check !== null) {
    // `--check` evaluates a fixed commit with no writes and no working-tree
    // dependence — the four flags below all either write or move the pin, none
    // of which make sense against a ref that is not this checkout's HEAD.
    if (options.write || options.accept.size > 0 || options.acceptAll || options.upstream !== null) {
      usageError('--check is incompatible with --write, --accept, --accept-all and --upstream');
    }
  }
  return options;
}

function normalizeRel(p: string): string {
  return p.split(path.sep).join('/').replace(/^\.\//, '');
}

function fail(message: string): never {
  console.error(`upstream-ratchet: ${message}`);
  process.exit(1);
}

/** A malformed invocation — distinct exit code from `fail`'s "the ratchet failed" (1). */
function usageError(message: string): never {
  console.error(`upstream-ratchet: ${message}`);
  process.exit(2);
}

function usage(): never {
  console.log(
    [
      'Usage: tsx scripts/upstream-ratchet-report.ts [--root <dir>] [--json]',
      '       tsx scripts/upstream-ratchet-report.ts --write [--accept <path>]... [--accept-all]',
      '       tsx scripts/upstream-ratchet-report.ts --upstream <rev>',
      '       tsx scripts/upstream-ratchet-report.ts --check <ref> [--json]',
      '',
      'Reports the fork divergence recorded in src/upstream-ratchet.json against the pinned',
      'upstream commit. Exits 1 when any upstream-owned file grew its diff or became newly',
      'divergent; shrink is always allowed. Exits 2 when the pinned commit is not in this',
      'clone. See docs/upstream-ratchet.md.',
      '',
      '--check <ref> evaluates the tree of <ref> (a sha, a remote-tracking branch, FETCH_HEAD,',
      'anything git rev-parse understands) instead of the working tree, with no writes and no',
      'working-tree dependence. Incompatible with --write, --accept, --accept-all, --upstream.',
    ].join('\n'),
  );
  process.exit(0);
}

// ── git ──────────────────────────────────────────────────────────────────────

function git(root: string, args: string[], quiet = false): string {
  return execFileSync('git', ['-C', root, ...args], {
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
    // A probe that is EXPECTED to fail should not print git's own `fatal:` line
    // over the actionable message this script is about to give instead.
    stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'inherit'],
  });
}

/**
 * The full 40-hex commit id `rev` names, or exit 2 with the fetch to run.
 *
 * Everything downstream stores and compares this value, so a short sha, a tag or
 * a branch name has to be resolved here rather than written into the manifest
 * verbatim — `upstream/main` persisted literally would have made the pin move
 * under the fork, which is the one thing the pin exists to prevent.
 */
function resolveCommit(root: string, rev: string): string {
  let resolved: string;
  try {
    resolved = git(root, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`], true).trim();
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    void error;
    console.error(
      `upstream-ratchet: upstream commit ${rev} is not in this clone.\n` +
        `  run: git fetch upstream ${shellQuote(rev)}`,
    );
    process.exit(2);
  }
  if (!/^[0-9a-f]{40}$/.test(resolved)) fail(`git resolved ${rev} to ${JSON.stringify(resolved)}, not a commit sha`);
  return resolved;
}

/**
 * Refuses `--check` outright on a git older than 2.40 — the release that added
 * the global `--attr-source=<tree-ish>` flag every `<ref>`-scoped git call in
 * `computeFromRef` relies on to resolve `.gitattributes` from `<ref>`'s own
 * tree rather than the running checkout's (git otherwise always resolves
 * attributes from the CURRENT working tree/index, regardless of which commit's
 * content is being asked about — verified by hand for both `cat-file
 * --filters` and `git diff --numstat`'s binary/`-diff` detection). Without
 * this flag `--check` would silently measure with the wrong tree's attributes
 * rather than fail, which is worse than refusing up front. Checked lazily,
 * only for `--check` — every other mode of this script has no attribute
 * dependency and works on whatever git this fork already requires.
 */
function requireAttrSourceSupport(root: string): void {
  const raw = git(root, ['--version'], true).trim();
  const match = /git version (\d+)\.(\d+)/.exec(raw);
  if (match === null) fail(`--check could not parse a git version from ${JSON.stringify(raw)}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 2 || (major === 2 && minor < 40)) {
    fail(
      `--check requires git 2.40 or newer for --attr-source (installed: ${raw}). Upgrade git, or use the ` +
        `default report against a real checkout of the ref instead.`,
    );
  }
}

/**
 * Which of `paths` the fork's `.gitignore` covers.
 *
 * `git check-ignore` is INDEX-AWARE by default: it never reports a tracked path,
 * so every path this returns is one the fork does not track. That is what makes
 * `ignored` safe to imply `deleted` on the entry.
 *
 * One `--stdin` call for the whole set (53 ms for 959 paths), not one call per
 * path. It exits 1 when nothing matches, which is a normal answer and not a
 * failure — hence the catch.
 */
function gitIgnored(root: string, paths: readonly string[]): Set<string> {
  if (paths.length === 0) return new Set();
  let stdout: string;
  try {
    stdout = execFileSync('git', ['-C', root, 'check-ignore', '-z', '--stdin'], {
      input: paths.join('\0'),
      maxBuffer: 512 * 1024 * 1024,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (error) {
    // Exit 1 means "none of them are ignored", and the child still wrote its
    // (empty) stdout. Anything without stdout is a real failure.
    const output = (error as { stdout?: string }).stdout;
    if (typeof output !== 'string') throw error;
    stdout = output;
  }
  return new Set(stdout.split('\0').filter(Boolean));
}

/**
 * The manifest the working tree implies right now, measured against `sha`.
 *
 * `git diff <commit>` compares the commit to the WORKING TREE, so an uncommitted
 * edit is measured — that is deliberate: the report is meant to be run before a
 * commit as much as after one. It also only ever looks at TRACKED paths, which
 * is why the shadow check below exists.
 */
export function computeFromGit(root: string, sha: string): UpstreamRatchetManifest {
  const upstreamModes = parseLsTree(git(root, ['ls-tree', '-r', '-z', sha]));
  const forkIndex = parseLsFiles(git(root, ['ls-files', '-s', '-z']));
  const numstat = parseNumstat(git(root, ['diff', '--numstat', '--no-renames', '-z', sha]));
  const paths = [...upstreamModes.keys()];

  // Gitlink and ignored/tracked refusals live in buildManifest, so they are one
  // rule with unit tests rather than a lexical copy here that could drift. Its
  // exact-path check was also the weaker one: it missed a submodule standing
  // ABOVE upstream-owned files.
  const ignored = gitIgnored(root, paths);
  const shadowed = findUntrackedShadows(
    paths,
    new Set(forkIndex.keys()),
    (rel) => pathExists(path.join(root, rel)),
    ignored,
  );
  if (shadowed.length > 0) {
    fail(
      `${shadowed.length} upstream-owned path(s) exist on disk but are not tracked, so their divergence cannot ` +
        `be measured — git would report them as deleted while the file is read for its hash. Stage or remove ` +
        `them first:\n` +
        shadowed.map((p) => `  ${p}`).join('\n'),
    );
  }

  // The seal is over the manifest's own key set, which `buildManifest` fills
  // from exactly these paths — so it is the pinned commit's path list by
  // construction, not a second list that could drift from it.
  return sealManifest(
    buildManifest({
      upstream: sha,
      upstreamModes,
      forkIndex,
      numstat,
      modeOf: (rel) => fileModeOf(path.join(root, rel)),
      hashOf: (rel) => hashFile(path.join(root, rel)),
      ignored,
    }),
  );
}

/**
 * `git cat-file --batch` over an exact, deduplicated id list, as a raw `Buffer`.
 *
 * Not routed through `git()`: that helper forces `encoding: 'utf8'`, which is
 * right for the text porcelain output every other call here reads, and WRONG
 * for blob content — an upstream-owned binary file, or a symlink target in a
 * non-UTF8 byte sequence, would come back mangled. `parseCatFileBatch`
 * (src/upstream-ratchet-core.ts) needs the exact same id list back, in the
 * exact same order, to find each record's boundary in the framing.
 */
/**
 * Raw (unfiltered) blob content for a set of ids via ONE `cat-file --batch`
 * call — the only remaining caller is `computeFromRef`'s SYMLINK hashing.
 * Regular files no longer go through this: see `hashFilteredBlob`'s comment
 * for why `--batch --filters` cannot be trusted, which is what forces a
 * one-object-at-a-time call for every regular file instead of a batch.
 */
function catFileBatch(root: string, ref: string, ids: readonly string[]): Buffer {
  if (ids.length === 0) return Buffer.alloc(0);
  // Raw (unfiltered) content never actually consults attributes — `ref` is
  // threaded through for the "every <ref>-scoped call is attr-sourced"
  // invariant (see computeFromRef's comment), not because this call's
  // result would otherwise be wrong.
  return execFileSync('git', ['-C', root, `--attr-source=${ref}`, 'cat-file', '--batch'], {
    input: ids.join('\n') + '\n',
    // Bounded by construction: only ever called with upstream-owned symlink
    // blob ids (a target string, never large) — see computeFromRef.
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  }) as Buffer;
}

/**
 * The sha256 a real checkout of `<ref>:<relPath>` would hash to, per
 * `hashFile` — git's blob content AFTER the filters `<ref>`'s own
 * gitattributes declare (CRLF/eol conversion, working-tree-encoding, ident,
 * clean/smudge), using filter DRIVERS from the RUNNING repo's git config
 * (`filter.<name>.smudge` etc. are config, never committed) — exactly what a
 * real `git checkout <ref>` in THIS checkout would do.
 *
 * One subprocess PER REGULAR upstream-owned path, unconditionally — every one
 * of them, not a subset selected by querying which attributes are set.
 * Two things forced this design, in order:
 *
 * 1. There is no reliable selector. `git check-attr` only reports the FOUR
 *    named attributes (`text`/`eol`/`ident`/`filter`) it is asked about, but a
 *    real checkout's bytes can also move under `core.autocrlf` with NO
 *    attribute at all (`\n` → `\r\n` on write), under `working-tree-encoding`
 *    (a fifth attribute, UTF-8 ⇄ another codec), and a `filter=X` value can
 *    itself literally BE the string `"unspecified"` — a value distinct from
 *    check-attr's own "no rule applies" sentinel, indistinguishable from it by
 *    string comparison alone. A round-1 fix that grew the attribute list would
 *    still be one enumeration away from the next transform; hashing
 *    unconditionally has no such list to keep complete.
 * 2. `git cat-file --batch --filters` cannot be trusted at all, REGARDLESS of
 *    selection, and this was verified by hand rather than assumed: fed
 *    `<ref>:<path> <path>` (the documented batch+filters input shape) it
 *    writes the CORRECT, POST-filter bytes to stdout — but its header still
 *    reports the PRE-filter blob size (`blob 6` for a 6-byte LF blob that
 *    filters to 9 CRLF bytes). Every invocation shape was tried —
 *    `--batch-check --filters`, a custom `--batch=<format>` with
 *    `%(objectsize)`, `--batch-command --filters` with both `contents
 *    <object> <path>` and `contents <object>:<path> <path>` — and every one
 *    either reports the pre-filter size or refuses the record outright.
 *    Git's OWN test suite (`t8010-cat-file-filters.sh`, upstream) has no case
 *    for `--batch --filters` at all — only `--batch --textconv`, and that
 *    one test's fixture happens not to change length, which would hide this
 *    exact class of bug rather than catch it. A size that lies desyncs the
 *    framing every OTHER record in the same stream depends on, so there is no
 *    safe way to batch this on the git version this fork runs (2.43.0) — the
 *    one-shot fallback below was chosen deliberately, not as a shortcut.
 *
 * A single-object, non-batch `--filters` call has neither problem: its ENTIRE
 * stdout, to EOF, IS the filtered content — no header, no size field, nothing
 * to misparse. `--attr-source=<ref>` (the global flag; `cat-file` has no
 * per-invocation `--source`) pins ATTRIBUTE resolution to `<ref>`'s own
 * `.gitattributes` rather than the running checkout's — verified by hand:
 * without it, querying an attribute-bearing commit while HEAD carries none at
 * all silently returns the UNfiltered bytes. Filter DRIVERS are deliberately
 * NOT ref-sourced this way, because git itself does not source them that way:
 * `filter.<name>.smudge`/`.clean` live in git CONFIG, never in a commit, so a
 * real `git checkout <ref>` also runs whatever driver the CURRENT repo's
 * config defines — `--check` matching that (rather than trying to pin it) is
 * what "checkout-equivalent" has to mean for a filter driver specifically.
 * See "Checkout filters" in docs/upstream-ratchet.md.
 *
 * Never called for a symlink (120000): `--filters` returns a symlink's raw
 * target string byte-for-byte unchanged (verified by hand), so the plain
 * batched raw hash already agrees with `hashFile`'s (now byte-based, see
 * src/upstream-ratchet.ts) symlink handling with no extra work.
 */
function catFileFiltered(root: string, ref: string, relPath: string): Buffer {
  return execFileSync('git', ['-C', root, `--attr-source=${ref}`, 'cat-file', '--filters', `${ref}:${relPath}`], {
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  }) as Buffer;
}

function hashFilteredBlob(root: string, ref: string, relPath: string): string {
  return hashBlobContent(catFileFiltered(root, ref, relPath));
}

/**
 * The manifest `ref`'s own tree implies, measured against the pinned commit —
 * the `--check` counterpart to `computeFromGit`, sharing `buildManifest` (and
 * therefore `classify`/`writeGate`/rendering) as the one arbitration path so
 * there is no second implementation of GROWTH/NEW/SHRINK/STALE.
 *
 * Differs from the working-tree measurement in four ways, all because there is
 * no working tree and no index for a bare ref:
 *
 *  - `forkIndex`/`modeOf` come from `git ls-tree -r -z <ref>` (the FULL tree,
 *    kept in `refEntries` for gitlink-ancestor detection), not `ls-files`.
 *  - `hashOf` for a REGULAR upstream-owned file (100644/100755) is ALWAYS
 *    `hashFilteredBlob`'s checkout-equivalent hash — one subprocess per path,
 *    unconditionally, never a selected subset (see that function's comment
 *    for why). A 120000 (symlink) entry uses the raw batch hash instead:
 *    filters never apply to a symlink's content on checkout. Only
 *    UPSTREAM-OWNED, non-gitlink symlink blobs are ever batch-requested
 *    (never the fork's own added content, however large).
 *  - `ignored` is always empty: `git check-ignore` needs a live index and
 *    working tree, neither of which a bare commit has. An upstream path the
 *    fork deleted AND gitignored is simply absent from `ls-tree`, so it is
 *    classified as plain `deleted` here (not `deleted + ignored`) — the `diff`
 *    number `classify()` compares is the same numstat line count either way,
 *    so this does not change a GROWTH/NEW/SHRINK verdict, only the `ignored`
 *    flag on the recomputed (never written) entry.
 *  - the untracked-shadow check (`findUntrackedShadows`) does not run: it
 *    exists because a real working tree can hold bytes at a path the index
 *    does not track, which cannot happen inside a single commit's own tree.
 *
 * Returns the `TreeReader` alongside the manifest so the caller can also run
 * `checkTree` (the STALE-MANIFEST currency check) against the very same
 * `modeOf`/`hashOf`, with no second git round-trip.
 */
function computeFromRef(
  root: string,
  sha: string,
  ref: string,
): { manifest: UpstreamRatchetManifest; reader: TreeReader } {
  const upstreamModes = parseLsTree(git(root, ['ls-tree', '-r', '-z', sha]));
  // `--attr-source=<ref>` on every call below that is about `<ref>`'s OWN
  // content: `ls-tree` and the raw symlink `cat-file --batch` are no-ops for
  // it today (neither consults attributes), but `diff --numstat` is NOT — see
  // the comment on that call below. Applying it uniformly makes "every
  // <ref>-scoped git call in --check is attr-sourced to <ref>" a checkable
  // invariant rather than a per-call judgment call that could silently regress
  // if git ever starts consulting attributes somewhere it doesn't today.
  const refEntries = parseLsTreeEntries(git(root, [`--attr-source=${ref}`, 'ls-tree', '-r', '-z', ref]));

  // A directory shadow means there is no blob at all for an upstream-owned
  // path in <ref>'s tree — not "present", not "deleted", but a path an
  // ordinary lookup would misread as deleted while a real checkout of <ref>
  // would refuse outright (findUntrackedShadows' working-tree equivalent).
  // Refused the same way an unmeasurable pinned commit is: exit 2, "cannot
  // measure", not "the ratchet failed".
  const directoryShadows = findDirectoryShadows([...upstreamModes.keys()], [...refEntries.keys()]);
  if (directoryShadows.length > 0) {
    console.error(
      `upstream-ratchet: ${directoryShadows.length} upstream-owned path(s) are directories in ${ref}'s tree, ` +
        `not blobs — their divergence cannot be measured:\n` +
        directoryShadows.map((s) => `  ${s.upstreamPath} (e.g. ${s.example} exists under it)`).join('\n'),
    );
    process.exit(2);
  }

  // Symlinks only: never filtered on checkout, so the plain blob is already
  // checkout-equivalent, and a batch call is safe for these because raw
  // (unfiltered) `cat-file --batch` reports the correct size. Scoped to
  // upstream-owned, non-gitlink paths — never the fork's own added content.
  const symlinkBlobIds = [
    ...new Set(
      [...refEntries.entries()]
        .filter(([relPath, entry]) => upstreamModes.has(relPath) && entry.mode === '120000')
        .map(([, entry]) => entry.blob),
    ),
  ];
  const symlinkHashes = hashCatFileBatch(catFileBatch(root, ref, symlinkBlobIds), symlinkBlobIds);

  // Every regular upstream-owned file, unconditionally — see
  // hashFilteredBlob's comment for why there is no cheaper, safe selection.
  const regularPaths = [...upstreamModes.keys()].filter((relPath) => {
    const entry = refEntries.get(relPath);
    return entry !== undefined && (entry.mode === '100644' || entry.mode === '100755');
  });
  const filteredHashes = new Map<string, string>();
  for (const relPath of regularPaths) filteredHashes.set(relPath, hashFilteredBlob(root, ref, relPath));

  const modeOf = (relPath: string): GitMode | null => {
    const mode = refEntries.get(relPath)?.mode;
    return mode !== undefined && isGitMode(mode) ? mode : null;
  };
  const hashOf = (relPath: string): string | null => {
    const filtered = filteredHashes.get(relPath);
    if (filtered !== undefined) return filtered;
    const entry = refEntries.get(relPath);
    return entry === undefined ? null : (symlinkHashes.get(entry.blob) ?? null);
  };
  const forkIndex = new Map([...refEntries].map(([p, e]) => [p, e.mode]));
  // `--attr-source=<ref>` here is NOT a no-op like the calls above: `git diff
  // --numstat` decides whether a path is BINARY (the `-\t-` numstat marker
  // that flags a divergent entry `binary: true`) using `-diff`/`binary`/a
  // `diff=<driver>` gitattributes rule, and WITHOUT this flag that decision is
  // made from the RUNNING CHECKOUT's attributes, not `<ref>`'s own — verified
  // by hand: a `-diff` rule added only in `<ref>` was invisible to `numstat`
  // until `--attr-source=<ref>` was added, at which point the same file
  // correctly reported as binary. The default (working-tree) report is
  // DELIBERATELY left as it was: reading the WORKING TREE's own attributes is
  // exactly right there, because a real checkout is what a person or CI is
  // looking at.
  const numstat = parseNumstat(
    git(root, [`--attr-source=${ref}`, 'diff', '--numstat', '--no-renames', '-z', sha, ref]),
  );

  const manifest = sealManifest(
    buildManifest({ upstream: sha, upstreamModes, forkIndex, numstat, modeOf, hashOf, ignored: new Set<string>() }),
  );
  const reader: TreeReader = { exists: (relPath) => refEntries.has(relPath), modeOf, hashOf };
  return { manifest, reader };
}

// ── output ───────────────────────────────────────────────────────────────────

const ORDER: Verdict[] = ['NEW', 'GROWTH', 'STALE', 'SHRINK', 'DROPPED'];

function n(value: number): string {
  return value.toLocaleString('en-US');
}

function renderRow(row: Row): string {
  const delta = row.after - row.before;
  const sign = delta > 0 ? `+${n(delta)}` : n(delta);
  const state =
    row.deletedAfter && !row.deletedBefore
      ? 'deleted in fork'
      : row.deletedBefore && !row.deletedAfter
        ? 'restored in fork'
        : (row.reason ?? '');
  const note = state === '' ? '' : ` (${state})`;
  return `  ${row.verdict.padEnd(9)} ${row.path.padEnd(58)} ${n(row.before)} → ${n(row.after)} (${sign})${note}`;
}

function counts(manifest: UpstreamRatchetManifest): {
  total: number;
  divergent: number;
  identical: number;
  deleted: number;
  modified: number;
  binary: number;
  lines: number;
} {
  const entries = Object.values(manifest.files);
  const divergent = divergentEntries(manifest).length;
  const deleted = entries.filter((e) => e.deleted === true).length;
  return {
    total: entries.length,
    divergent,
    identical: entries.length - divergent,
    deleted,
    modified: divergent - deleted,
    binary: entries.filter((e) => e.binary === true).length,
    lines: totalDiffLines(manifest),
  };
}

/** The `--write --accept …` line to re-run, safe to paste into a shell. */
function acceptCommand(rows: readonly Row[]): string {
  return `pnpm run ratchet:report -- --write ${rows.map((r) => acceptFlag(r.path)).join(' ')}`;
}

/** One STALE-MANIFEST row: the manifest committed at the ref disagrees with the ref's own tree. */
function renderCurrencyFinding(f: Finding): string {
  return `  STALE-MANIFEST ${f.path.padEnd(51)} ${f.detail}`;
}

/**
 * `--check <ref>`'s manifest cannot be trusted at all — a symlink where a
 * regular file belongs, invalid JSON, or a shape that would crash the very
 * next property access. Nothing else about `<ref>` can be measured, but the
 * failure is still rendered through the SAME machine-readable shape every
 * other `--check` failure uses (`--json`'s `staleManifest`/`exitCode`), never
 * a plain-text-only `fail()` that `--json` callers cannot parse.
 */
function reportUnusableCheckedManifest(ref: string, resolvedRef: string, findings: Finding[], json: boolean): never {
  if (json) {
    console.log(
      JSON.stringify(
        {
          mode: 'check',
          ref,
          resolvedRef,
          staleManifest: findings.map((f) => ({ path: f.path, kind: f.kind, detail: f.detail })),
          exitCode: 1,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Checking ${ref} (${resolvedRef.slice(0, 8)}) — its own manifest at ${MANIFEST_REL} is not usable, so ` +
        `nothing else about it can be measured:\n`,
    );
    console.log(`STALE-MANIFEST (${n(findings.length)})`);
    for (const f of findings) console.log(renderCurrencyFinding(f));
    console.error(
      `\nupstream-ratchet: --check failing — the manifest committed at ${ref} is not usable; regenerate on ` +
        `that branch: ${REGENERATE_HINT}`,
    );
  }
  process.exit(1);
}

/** The working-tree counterpart to `reportUnusableCheckedManifest`, for `main()`'s local manifest. */
function reportUnusableLocalManifest(committedPath: string, findings: Finding[], json: boolean): never {
  if (json) {
    console.log(
      JSON.stringify(
        { staleManifest: findings.map((f) => ({ path: f.path, kind: f.kind, detail: f.detail })), exitCode: 1 },
        null,
        2,
      ),
    );
  } else {
    console.log(`${committedPath} is not usable, so nothing else about it can be measured:\n`);
    console.log(`STALE-MANIFEST (${n(findings.length)})`);
    for (const f of findings) console.log(renderCurrencyFinding(f));
    console.error(
      `\nupstream-ratchet: refusing to measure — ${committedPath} is not usable; regenerate: ${REGENERATE_HINT}`,
    );
  }
  process.exit(1);
}

/**
 * `--check <ref>`: evaluate `<ref>`'s tree exactly as the default report
 * evaluates the working tree, with no writes and no working-tree dependence.
 * See `computeFromRef` for what "commit-sourced measurement" means concretely.
 *
 * Two independent things can fail it, both surfaced as their own section:
 *
 *  - `classify()` against the manifest COMMITTED AT `<ref>` — the same
 *    GROWTH/NEW/SHRINK/STALE arbitration the default report runs, just pointed
 *    at a ref instead of a checkout. This is what would have caught "merged
 *    without regenerating the manifest, main went Δ 187" BEFORE the merge.
 *  - the STALE-MANIFEST currency check — `checkTree` (src/upstream-ratchet.ts)
 *    run with a ref-backed `TreeReader` instead of the filesystem — which
 *    catches a manifest whose sha256/mode/deleted bookkeeping disagrees with
 *    `<ref>`'s real tree even when the `diff` arithmetic alone would not (e.g.
 *    a same-line-count text edit, which `classify()` deliberately does not
 *    block). Reuses the exact per-entry logic `checkTree` already has for the
 *    local working tree — including the `ignored` skip — rather than a second
 *    implementation.
 */
function runCheck(options: Options): never {
  const root = options.root;
  const ref = options.check as string;
  requireAttrSourceSupport(root);
  const started = Date.now();

  let resolvedRef: string;
  try {
    resolvedRef = git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], true).trim();
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    void error;
    console.error(`upstream-ratchet: --check ref ${JSON.stringify(ref)} does not resolve to a commit in this clone.`);
    process.exit(2);
  }

  // A symlinked manifest would diverge between modes — see
  // `manifestSymlinkFinding`'s docstring — so refused outright here, in both
  // modes; `main()` runs the identical check (`isManifestSymlink`) on the
  // working tree below.
  const symlinkFinding = manifestSymlinkFinding(
    parseLsTreeEntries(git(root, ['ls-tree', '-r', '-z', resolvedRef, '--', MANIFEST_REL], true)),
  );
  if (symlinkFinding !== null) reportUnusableCheckedManifest(ref, resolvedRef, [symlinkFinding], options.json);

  // Read through the SAME filtered path every other regular file in <ref>
  // goes through (`hashFilteredBlob`/`catFileFiltered`), not `git show`: `git
  // show <ref>:<path>` returns the raw, UNfiltered blob, so a ref that assigns
  // a clean/smudge or LFS filter to src/upstream-ratchet.json itself would
  // have `--check` reading the CLEAN (stored) form while a real checkout of
  // that ref — and the working-tree report run against it — would see the
  // SMUDGED form. Proven by hand with a reversible base64 clean/smudge filter;
  // see docs/upstream-ratchet.md.
  let manifestText: string;
  try {
    manifestText = catFileFiltered(root, resolvedRef, MANIFEST_REL).toString('utf8');
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    void error;
    console.error(`upstream-ratchet: ${ref} (${resolvedRef.slice(0, 8)}) carries no manifest at ${MANIFEST_REL}`);
    process.exit(2);
  }
  let committed: UpstreamRatchetManifest;
  try {
    committed = JSON.parse(manifestText) as UpstreamRatchetManifest;
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    // Routed through the same JSON-aware path every other unusable-manifest
    // finding uses (not the plain-text-only `fail()`), so a `--json` caller
    // gets valid, complete JSON here too instead of a bare stderr line.
    reportUnusableCheckedManifest(
      ref,
      resolvedRef,
      [
        {
          kind: 'malformed',
          path: MANIFEST_REL,
          detail: `manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          hint: `regenerate: ${REGENERATE_HINT}`,
        },
      ],
      options.json,
    );
  }

  // `validateManifestShape` is what stands between here and a crash: a
  // top-level `null`/array/primitive, or a non-string `upstream`, would throw
  // on the very next line (`committed.upstream`) otherwise. It also validates
  // `upstream`/`paths`' own regex shape — including an EMPTY pin, which is
  // never legitimate on a checked ref's own committed manifest — so any
  // invalid pin is caught here, before `resolveCommit`'s `git rev-parse`
  // object lookup, with a structured MALFORMED finding rather than that
  // call's exit-2 stderr. No `unpinnedOk`: that exemption exists only for the
  // synthetic baseline `main()` builds in memory on a first run, never for a
  // ref's real committed content, which is what `--check` reads. `--check`
  // reads `committed` from an ARBITRARY ref's content, so this cannot be
  // skipped the way a trusted local file arguably could be — and `main()`'s
  // working-tree path runs the identical strict check on an EXISTING on-disk
  // manifest for the identical reason.
  const shapeFindings = validateManifestShape(committed);
  if (shapeFindings.length > 0) reportUnusableCheckedManifest(ref, resolvedRef, shapeFindings, options.json);

  const sha = resolveCommit(root, committed.upstream);

  let current: UpstreamRatchetManifest;
  let currencyFindings: Finding[];
  try {
    const result = computeFromRef(root, sha, resolvedRef);
    current = result.manifest;
    currencyFindings = checkTree(committed, root, result.reader);
  } catch (error) {
    // A RatchetError is a refusal with a written-out reason (a gitlink, an
    // unparseable record); anything else is a bug and keeps its stack.
    if (error instanceof RatchetError) fail(error.message);
    throw error;
  }
  const elapsedMs = Date.now() - started;

  // `checkTree` already validates the committed manifest's shape (a
  // `malformed` finding fires for `"files": null`, a non-object `files`, or
  // any entry that is `null`/non-object) WITHOUT crashing — it early-returns
  // at the manifest level, and `checkEntry` early-returns per entry. `classify`
  // and `counts` make no such promise: `classify`'s second loop does
  // `Object.entries(committed.files)` (throws on `null`/non-object) and reads
  // `before.diff` unguarded (throws on a `null` entry), and `counts` does
  // `Object.values(manifest.files)` (same throw). A `--check <ref>` reads
  // `committed` from `git show <ref>:...json` — an ARBITRARY ref's content,
  // never guaranteed well-formed the way the default report's local
  // `readManifest` effectively always is. Reusing `checkTree`'s own
  // `malformed` findings here (rather than a second shape-validator) is what
  // stops BEFORE either crashes: a malformed manifest means only that its
  // findings are shown and the run fails, not that it exits by throwing.
  const malformed = currencyFindings.some((f) => f.kind === 'malformed');
  const rows = malformed ? [] : classify(committed, current);
  // The exit decision is one pure function (src/upstream-ratchet-core.ts,
  // unit-tested there) — `runCheck` has no ad hoc `failing` computation of its
  // own to drop `currencyFindings` from by accident. Shadows the raw
  // `checkTree` result with the (identical) copy `decideCheckOutcome` returns,
  // so every render below reads from the one decision.
  const outcome = decideCheckOutcome(rows, currencyFindings);
  const { failing, blocking } = outcome;
  currencyFindings = outcome.currencyFindings;

  const before = malformed
    ? { total: 0, divergent: 0, identical: 0, deleted: 0, modified: 0, binary: 0, lines: 0 }
    : counts(committed);
  const after = counts(current);
  const deltaLines = after.lines - before.lines;
  const summary =
    `${n(after.divergent)} divergent files, ${n(after.lines)} diff lines vs ${sha.slice(0, 8)} ` +
    `(Δ ${deltaLines >= 0 ? '' : '-'}${n(Math.abs(deltaLines))})`;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          mode: 'check',
          ref,
          resolvedRef,
          upstream: sha,
          summary,
          elapsedMs,
          counts: after,
          delta: { lines: deltaLines, divergent: after.divergent - before.divergent },
          rows: rows.filter((r) => r.verdict !== 'UNCHANGED'),
          blocking: blocking.map((r) => r.path),
          staleManifest: currencyFindings.map((f) => ({ path: f.path, kind: f.kind, detail: f.detail })),
          exitCode: failing ? 1 : 0,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Checking ${ref} (${resolvedRef.slice(0, 8)}) against the manifest committed there, pinned upstream ` +
        `${sha.slice(0, 8)}.\n` +
        `Commit-source measurement: ignored-path detection and untracked-shadow checking do not apply to a ` +
        `bare ref and are skipped.\n`,
    );
    for (const verdict of ORDER) {
      const group = rows.filter((r) => r.verdict === verdict);
      if (group.length === 0) continue;
      console.log(`${verdict} (${n(group.length)})`);
      for (const row of group) console.log(renderRow(row));
      console.log('');
    }
    if (currencyFindings.length > 0) {
      console.log(`STALE-MANIFEST (${n(currencyFindings.length)})`);
      for (const f of currencyFindings) console.log(renderCurrencyFinding(f));
      console.log('');
    }
    console.log(
      `${n(after.total)} upstream-owned files at ${sha.slice(0, 8)}: ` +
        `${n(after.modified)} modified, ${n(after.deleted)} deleted in fork, ` +
        `${n(after.identical)} byte-identical, ${n(after.binary)} binary`,
    );
    console.log(`UNCHANGED ${n(rows.filter((r) => r.verdict === 'UNCHANGED').length)}   (measured in ${elapsedMs} ms)`);
    console.log(summary);

    if (failing) {
      const parts: string[] = [];
      if (blocking.length > 0)
        parts.push(`${n(blocking.length)} upstream-owned file(s) grew or became newly divergent`);
      if (currencyFindings.length > 0) {
        parts.push(
          `${n(currencyFindings.length)} manifest entr${currencyFindings.length === 1 ? 'y is' : 'ies are'} stale ` +
            `against ${ref}'s tree — regenerate on that branch: ${REGENERATE_HINT}`,
        );
      }
      console.error(`\nupstream-ratchet: --check failing — ${parts.join('; ')}.`);
    }
  }

  process.exit(failing ? 1 : 0);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.check !== null) runCheck(options);
  const root = options.root;
  const committedPath = manifestPath(root);

  // Same divergence `runCheck` refuses on the ref side (`manifestSymlinkFinding`'s
  // docstring), refused here too, before `readManifest`'s `fs.readFileSync`
  // (which FOLLOWS a symlink) ever reads through one.
  if (isManifestSymlink(root)) {
    reportUnusableLocalManifest(
      committedPath,
      [
        {
          kind: 'malformed',
          path: MANIFEST_REL,
          detail: 'manifest must be a regular file, not a symlink',
          hint: `regenerate: ${REGENERATE_HINT}`,
        },
      ],
      options.json,
    );
  }

  let committed: UpstreamRatchetManifest;
  // Set only for the synthetic first-run baseline constructed below — the ONE
  // value this tool builds itself rather than reads off disk, and therefore
  // the ONE call below allowed to pass `unpinnedOk` to `validateManifestShape`.
  // An on-disk manifest — including a hand-edited or corrupted one — gets no
  // such exemption: see that function's docstring for why an empty pin must
  // never reach `resolveCommit` uncaught.
  let isBootstrap = false;
  try {
    committed = readManifest(root);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    // Invalid JSON means the file EXISTS but cannot be trusted at all — routed
    // through the same JSON-aware "unusable manifest" path `--check` uses,
    // rather than treated as the "no manifest yet" first-run case below (that
    // case is a genuinely MISSING file, not a corrupted one).
    if (error instanceof SyntaxError) {
      reportUnusableLocalManifest(
        committedPath,
        [
          {
            kind: 'malformed',
            path: MANIFEST_REL,
            detail: `manifest is not valid JSON: ${error.message}`,
            hint: `regenerate: ${REGENERATE_HINT}`,
          },
        ],
        options.json,
      );
    }
    // Creating the manifest for the first time is a re-pin against an empty
    // baseline: everything upstream owns reads as NEW, which is exactly what an
    // unaudited starting point is. Any other mode needs the file to exist.
    if (options.upstream === null) {
      fail(`could not read ${committedPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    committed = { upstream: '', paths: '', files: {} };
    isBootstrap = true;
  }

  // Same guard as `runCheck`'s, for the same reason: `resolveCommit` on the
  // very next line dereferences `committed.upstream`, which throws instead of
  // reporting on a top-level `null`/array or a non-string `upstream`. It also
  // validates `upstream`/`paths`' own regex shape now, catching an invalid pin
  // here too. The local file is not exempt just because this tool is the only
  // thing that usually writes it — a hand-edited or corrupted one hits the
  // same crash, and gets the same STRICT check `runCheck` gives a `--check
  // <ref>`'s committed manifest: `unpinnedOk` is passed ONLY for the
  // synthetic bootstrap baseline this function built two lines above, never
  // for anything `readManifest` actually returned.
  const shapeFindings = validateManifestShape(committed, { unpinnedOk: isBootstrap });
  if (shapeFindings.length > 0) reportUnusableLocalManifest(committedPath, shapeFindings, options.json);

  const sha = resolveCommit(root, options.upstream ?? committed.upstream);
  const repinned = sha !== committed.upstream;
  const started = Date.now();
  let current: UpstreamRatchetManifest;
  try {
    current = computeFromGit(root, sha);
  } catch (error) {
    // A RatchetError is a refusal with a written-out reason (a gitlink, an
    // unparseable record); anything else is a bug and keeps its stack.
    if (error instanceof RatchetError) fail(error.message);
    throw error;
  }
  const elapsedMs = Date.now() - started;

  const rows = classify(committed, current);
  const { blocking, unaccepted } = writeGate(rows, options.accept, options.acceptAll);

  const before = counts(committed);
  const after = counts(current);
  const deltaLines = after.lines - before.lines;
  const summary =
    `${n(after.divergent)} divergent files, ${n(after.lines)} diff lines vs ${sha.slice(0, 8)} ` +
    `(Δ ${deltaLines >= 0 ? '' : '-'}${n(Math.abs(deltaLines))})`;

  // `--json` is emitted at the very end, so `wrote` reports what actually
  // happened rather than what was about to be attempted.
  const emitJson = (wrote: boolean): void => {
    console.log(
      JSON.stringify(
        {
          upstream: sha,
          repinnedFrom: options.upstream !== null && repinned ? committed.upstream : null,
          summary,
          elapsedMs,
          counts: after,
          delta: { lines: deltaLines, divergent: after.divergent - before.divergent },
          rows: rows.filter((r) => r.verdict !== 'UNCHANGED'),
          blocking: blocking.map((r) => r.path),
          unaccepted: unaccepted.map((r) => r.path),
          wrote,
        },
        null,
        2,
      ),
    );
  };

  if (!options.json) {
    if (options.upstream !== null && repinned) {
      console.log(
        `Re-pinning ${committed.upstream || '(no previous pin)'} → ${sha}` +
          (options.upstream === sha ? '' : ` (resolved from ${options.upstream})`) +
          `. Every number below moves for upstream's reasons, not the fork's.\n`,
      );
    }
    for (const verdict of ORDER) {
      const group = rows.filter((r) => r.verdict === verdict);
      if (group.length === 0) continue;
      console.log(`${verdict} (${n(group.length)})`);
      for (const row of group) console.log(renderRow(row));
      console.log('');
    }
    console.log(
      `${n(after.total)} upstream-owned files at ${sha.slice(0, 8)}: ` +
        `${n(after.modified)} modified, ${n(after.deleted)} deleted in fork, ` +
        `${n(after.identical)} byte-identical, ${n(after.binary)} binary`,
    );
    console.log(`UNCHANGED ${n(rows.filter((r) => r.verdict === 'UNCHANGED').length)}   (measured in ${elapsedMs} ms)`);
    console.log(summary);
  }

  if (options.write) {
    if (unaccepted.length > 0) {
      if (options.json) emitJson(false);
      console.error(
        `\nupstream-ratchet: refusing to write ${committedPath} — ${n(unaccepted.length)} path(s) grew or became ` +
          `newly divergent and were not accepted:\n` +
          unaccepted
            .map((r) => `  ${r.verdict} ${r.path} (${n(r.before)} → ${n(r.after)})${r.reason ? ` — ${r.reason}` : ''}`)
            .join('\n') +
          `\nRe-run with ${unaccepted.map((r) => acceptFlag(r.path)).join(' ')} (or --accept-all), and say why in ` +
          `the PR body.`,
      );
      process.exit(1);
    }
    writeManifest(current, root);
    if (options.json) emitJson(true);
    else console.log(`\nWrote ${committedPath} — ${n(after.total)} entries pinned at ${sha}.`);
    process.exit(0);
  }

  if (options.json) emitJson(false);

  if (blocking.length > 0) {
    console.error(
      `\nupstream-ratchet: ${n(blocking.length)} upstream-owned file(s) grew or became newly divergent. ` +
        `Shrink freely; growth is a deliberate act — regenerate with\n  ${acceptCommand(blocking)}\n` +
        `and justify it in the PR body.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

main();
