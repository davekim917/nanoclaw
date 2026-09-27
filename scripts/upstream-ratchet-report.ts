#!/usr/bin/env tsx
/**
 * Upstream-ownership ratchet, the git half: every upstream-owned path's divergence against the
 * PINNED commit, compared to the committed manifest. GROWTH and NEW fail; SHRINK, STALE (manifest
 * owes a regeneration), UNCHANGED and DROPPED (re-pin only) do not.
 *
 * Modes: default reports; `--write` regenerates src/upstream-ratchet.json, REFUSING while a GROWTH
 * or NEW path is not named by `--accept <path>` / `--accept-all`; `--upstream <rev>` re-pins
 * (implies both); `--check <ref>` evaluates <ref>'s committed tree with no writes, plus a
 * STALE-MANIFEST check (docs/upstream-ratchet.md); `--root <dir>`; `--json`.
 *
 * Exit 2, not 1, when the pinned commit is not in the clone or a `--check` ref does not resolve or
 * carries no manifest: "cannot measure" is not "the ratchet failed", and CI tells them apart.
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
import { walkArgs } from './lib/cli-args.js';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Options {
  root: string;
  write: boolean;
  accept: Set<string>;
  acceptAll: boolean;
  upstream: string | null;
  json: boolean;
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
  walkArgs(argv, fail, (name, arg, value) => {
    if (name === '--root') options.root = path.resolve(value());
    else if (name === '--write') options.write = true;
    else if (name === '--accept') options.accept.add(normalizeRel(value()));
    else if (name === '--accept-all') options.acceptAll = true;
    else if (name === '--upstream') options.upstream = value();
    else if (name === '--json') options.json = true;
    else if (name === '--check') options.check = value();
    else if (name === '--help' || name === '-h') usage();
    // `pnpm run ratchet:report -- --write` can forward a bare `--`.
    else if (arg !== '--') fail(`unknown argument: ${arg}`);
  });
  if (options.upstream !== null) {
    options.write = true;
    options.acceptAll = true;
  }
  if (options.check !== null) {
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

function git(root: string, args: string[], quiet = false): string {
  return execFileSync('git', ['-C', root, ...args], {
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
    // An EXPECTED failure: git's own `fatal:` line would bury the actionable message.
    stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'inherit'],
  });
}

/** Exit 2 with the fetch to run. A branch name persisted verbatim would make the pin move under the fork. */
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

/** `--attr-source` needs git 2.40+: without it `.gitattributes` silently resolves from the running checkout. */
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

/** Index-aware: never reports a tracked path, so `ignored` implies `deleted`. Exit 1 means no match. */
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
    // Exit 1 with stdout is "none ignored"; anything without stdout is a real failure.
    const output = (error as { stdout?: string }).stdout;
    if (typeof output !== 'string') throw error;
    stdout = output;
  }
  return new Set(stdout.split('\0').filter(Boolean));
}

/** Measures the WORKING TREE (deliberate), tracked paths only; the shadow check covers the rest. */
export function computeFromGit(root: string, sha: string): UpstreamRatchetManifest {
  const upstreamModes = parseLsTree(git(root, ['ls-tree', '-r', '-z', sha]));
  const forkIndex = parseLsFiles(git(root, ['ls-files', '-s', '-z']));
  const numstat = parseNumstat(git(root, ['diff', '--numstat', '--no-renames', '-z', sha]));
  const paths = [...upstreamModes.keys()];

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

/** Not routed through `git()`: its utf8 decoding would mangle non-UTF8 bytes. */
function catFileBatch(root: string, ref: string, ids: readonly string[]): Buffer {
  if (ids.length === 0) return Buffer.alloc(0);
  return execFileSync('git', ['-C', root, `--attr-source=${ref}`, 'cat-file', '--batch'], {
    input: ids.join('\n') + '\n',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  }) as Buffer;
}

/**
 * One subprocess per regular path: `check-attr` cannot enumerate every transform, and
 * `cat-file --batch --filters` reports the PRE-filter size. See docs/upstream-ratchet.md.
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

/** No index or working tree for a bare ref: `ignored` is always empty and the untracked-shadow check does not run. */
function computeFromRef(
  root: string,
  sha: string,
  ref: string,
): { manifest: UpstreamRatchetManifest; reader: TreeReader } {
  const upstreamModes = parseLsTree(git(root, ['ls-tree', '-r', '-z', sha]));
  const refEntries = parseLsTreeEntries(git(root, [`--attr-source=${ref}`, 'ls-tree', '-r', '-z', ref]));

  // A directory where an upstream-owned blob belongs cannot be measured: exit 2.
  const directoryShadows = findDirectoryShadows([...upstreamModes.keys()], [...refEntries.keys()]);
  if (directoryShadows.length > 0) {
    console.error(
      `upstream-ratchet: ${directoryShadows.length} upstream-owned path(s) are directories in ${ref}'s tree, ` +
        `not blobs — their divergence cannot be measured:\n` +
        directoryShadows.map((s) => `  ${s.upstreamPath} (e.g. ${s.example} exists under it)`).join('\n'),
    );
    process.exit(2);
  }

  // Symlinks are never filtered on checkout, so batching is safe for these.
  const symlinkBlobIds = [
    ...new Set(
      [...refEntries.entries()]
        .filter(([relPath, entry]) => upstreamModes.has(relPath) && entry.mode === '120000')
        .map(([, entry]) => entry.blob),
    ),
  ];
  const symlinkHashes = hashCatFileBatch(catFileBatch(root, ref, symlinkBlobIds), symlinkBlobIds);

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
  // NOT a no-op: `diff --numstat` reads binary-ness from attributes, which must come from `<ref>`.
  const numstat = parseNumstat(
    git(root, [`--attr-source=${ref}`, 'diff', '--numstat', '--no-renames', '-z', sha, ref]),
  );

  const manifest = sealManifest(
    buildManifest({ upstream: sha, upstreamModes, forkIndex, numstat, modeOf, hashOf, ignored: new Set<string>() }),
  );
  const reader: TreeReader = { exists: (relPath) => refEntries.has(relPath), modeOf, hashOf };
  return { manifest, reader };
}

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

function printVerdictGroups(rows: Row[]): void {
  for (const verdict of ORDER) {
    const group = rows.filter((r) => r.verdict === verdict);
    if (group.length === 0) continue;
    console.log(`${verdict} (${n(group.length)})`);
    for (const row of group) console.log(renderRow(row));
    console.log('');
  }
}

function printTotals(after: ReturnType<typeof counts>, sha: string): void {
  console.log(
    `${n(after.total)} upstream-owned files at ${sha.slice(0, 8)}: ` +
      `${n(after.modified)} modified, ${n(after.deleted)} deleted in fork, ` +
      `${n(after.identical)} byte-identical, ${n(after.binary)} binary`,
  );
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

function acceptCommand(rows: readonly Row[]): string {
  return `pnpm run ratchet:report -- --write ${rows.map((r) => acceptFlag(r.path)).join(' ')}`;
}

function renderCurrencyFinding(f: Finding): string {
  return `  STALE-MANIFEST ${f.path.padEnd(51)} ${f.detail}`;
}

/** Rendered through the `--json` shape, never a plain `fail()`. */
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

  // A symlinked manifest would diverge between modes, so it is refused in both.
  const symlinkFinding = manifestSymlinkFinding(
    parseLsTreeEntries(git(root, ['ls-tree', '-r', '-z', resolvedRef, '--', MANIFEST_REL], true)),
  );
  if (symlinkFinding !== null) reportUnusableCheckedManifest(ref, resolvedRef, [symlinkFinding], options.json);

  // Through the filtered path, not `git show`: a clean/smudge filter on the manifest would differ.
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

  // Validated before `committed.upstream` is dereferenced: `--check` reads an arbitrary ref's content.
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
    // A RatchetError is a refusal with a written-out reason; anything else is a bug and keeps its stack.
    if (error instanceof RatchetError) fail(error.message);
    throw error;
  }
  const elapsedMs = Date.now() - started;

  // `checkTree` reports a malformed manifest without throwing, where `classify` and `counts` throw.
  const malformed = currencyFindings.some((f) => f.kind === 'malformed');
  const rows = malformed ? [] : classify(committed, current);
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
    printVerdictGroups(rows);
    if (currencyFindings.length > 0) {
      console.log(`STALE-MANIFEST (${n(currencyFindings.length)})`);
      for (const f of currencyFindings) console.log(renderCurrencyFinding(f));
      console.log('');
    }
    printTotals(after, sha);
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

  // `readManifest` would follow a symlink, so this runs first.
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
  // Only the synthetic first-run baseline below may pass `unpinnedOk`; an on-disk manifest never does.
  let isBootstrap = false;
  try {
    committed = readManifest(root);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
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
    // First-run creation is a re-pin against an empty baseline: everything upstream owns reads as NEW.
    if (options.upstream === null) {
      fail(`could not read ${committedPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    committed = { upstream: '', paths: '', files: {} };
    isBootstrap = true;
  }

  const shapeFindings = validateManifestShape(committed, { unpinnedOk: isBootstrap });
  if (shapeFindings.length > 0) reportUnusableLocalManifest(committedPath, shapeFindings, options.json);

  const sha = resolveCommit(root, options.upstream ?? committed.upstream);
  const repinned = sha !== committed.upstream;
  const started = Date.now();
  let current: UpstreamRatchetManifest;
  try {
    current = computeFromGit(root, sha);
  } catch (error) {
    // A RatchetError is a refusal with a written-out reason; anything else is a bug and keeps its stack.
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
    printVerdictGroups(rows);
    printTotals(after, sha);
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
