/**
 * Upstream-ownership ratchet: `src/upstream-ratchet.json` records, for every path upstream owns at a pinned
 * commit, the fork's divergence (`diff`), mode and sha256. Growth in `diff` fails; shrink is allowed; a
 * byte-identical file that stops being so is NEW divergence and fails.
 *
 * This module cannot measure diff size (host suites mock `child_process`, and CI clones carry no upstream
 * objects); it only verifies the manifest is CURRENT. Arbitration lives in `src/upstream-ratchet-core.ts`, git
 * in `scripts/upstream-ratchet-report.ts`. Fork-added paths are out of scope.
 *
 * An `ignored: true` entry skips presence/mode/hash checks: an ignored path is untracked, so its bytes are not
 * fork source. That holds only while `ignored` means untracked: `buildManifest` refuses an ignored path in the
 * index, and `checkEntry` rejects `ignored` without `deleted`.
 *
 * Pure `fs` + `crypto` by construction. Do not import `child_process` here.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Defined here, not in core: core imports this module, never the reverse (an ESM cycle is a runtime trap). */
export type GitMode = '100644' | '100755' | '120000';

const GIT_MODES: readonly GitMode[] = ['100644', '100755', '120000'];

export function isGitMode(value: string): value is GitMode {
  return (GIT_MODES as readonly string[]).includes(value);
}

/** A submodule: nothing to hash or count, so it is refused on either side rather than recorded. */
export const GITLINK_MODE = '160000';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MANIFEST_REL = 'src/upstream-ratchet.json';

export const REGENERATE_HINT = 'pnpm run ratchet:report -- --write';

/**
 * - `diff`: added+deleted lines vs the pinned commit, +1 when the mode differs; upstream's line count for a
 *   path the fork deleted; 1 for binary bytes.
 * - `mode`: the fork's working-tree mode (upstream's when deleted); without it `chmod -x` would be invisible.
 * - `sha256`: of the fork's bytes, `null` when deleted; for a symlink, of the target string (git's 120000 blob).
 * - `ignored`: always together with `deleted`, because `git check-ignore` never reports a tracked path.
 */
export interface UpstreamRatchetEntry {
  diff: number;
  mode: GitMode;
  sha256: string | null;
  deleted?: true;
  ignored?: true;
  binary?: true;
}

export interface UpstreamRatchetManifest {
  /** The pinned upstream commit (40-hex), never a moving ref; re-pin with `--upstream <rev>`. */
  upstream: string;
  /**
   * sha256 of the pinned commit's sorted path list. Without it, deleting an entry leaves a manifest every check
   * passes; it moves only on a re-pin.
   */
  paths: string;
  files: Record<string, UpstreamRatchetEntry>;
}

type FindingKind = 'changed' | 'mode' | 'missing' | 'resurrected' | 'malformed';

export interface Finding {
  kind: FindingKind;
  path: string;
  detail: string;
  hint: string;
}

export function manifestPath(repoRoot: string = REPO_ROOT): string {
  return path.join(repoRoot, MANIFEST_REL);
}

export function readManifest(repoRoot: string = REPO_ROOT): UpstreamRatchetManifest {
  return JSON.parse(fs.readFileSync(manifestPath(repoRoot), 'utf8')) as UpstreamRatchetManifest;
}

/**
 * Whether the local manifest is a symlink (`lstat`, before `readManifest` follows it); `false` when missing.
 * Refused because `cat-file --filters` on a 120000 entry returns the target string while a checkout follows the
 * link, so the two would measure different files.
 */
export function isManifestSymlink(repoRoot: string = REPO_ROOT): boolean {
  try {
    return fs.lstatSync(manifestPath(repoRoot)).isSymbolicLink();
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return false;
  }
}

export function writeManifest(manifest: UpstreamRatchetManifest, repoRoot: string = REPO_ROOT): void {
  const target = manifestPath(repoRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, serializeManifest(manifest));
}

/** Sorted, joined by `\n` with no trailing newline, sha256'd, so regenerations of one pin agree. */
export function pathsSeal(paths: readonly string[]): string {
  return createHash('sha256')
    .update([...paths].sort().join('\n'), 'utf8')
    .digest('hex');
}

export function sealManifest(manifest: UpstreamRatchetManifest): UpstreamRatchetManifest {
  return { ...manifest, paths: pathsSeal(Object.keys(manifest.files)) };
}

/**
 * On-disk form: one line per entry, sorted, fixed key order, no aggregates, so two PRs regenerating it conflict
 * only on paths they both touched. The file is in `.prettierignore` because prettier would reflow it.
 */
export function serializeManifest(manifest: UpstreamRatchetManifest): string {
  const sorted = sortManifest(manifest);
  const paths = Object.keys(sorted.files);
  const lines = [`{"upstream":${JSON.stringify(sorted.upstream)},"paths":${JSON.stringify(sorted.paths)},"files":{`];
  paths.forEach((relPath, index) => {
    const entry = sorted.files[relPath];
    const fields = [
      `"diff":${entry.diff}`,
      `"mode":${JSON.stringify(entry.mode)}`,
      `"sha256":${JSON.stringify(entry.sha256)}`,
    ];
    if (entry.deleted === true) fields.push('"deleted":true');
    if (entry.ignored === true) fields.push('"ignored":true');
    if (entry.binary === true) fields.push('"binary":true');
    const comma = index === paths.length - 1 ? '' : ',';
    lines.push(`${JSON.stringify(relPath)}:{${fields.join(',')}}${comma}`);
  });
  lines.push('}}');
  return lines.join('\n') + '\n';
}

function sortManifest(manifest: UpstreamRatchetManifest): UpstreamRatchetManifest {
  const files: Record<string, UpstreamRatchetEntry> = {};
  for (const key of Object.keys(manifest.files).sort()) files[key] = manifest.files[key];
  return { upstream: manifest.upstream, paths: manifest.paths, files };
}

/**
 * Why a manifest key is not a usable repo-relative path, or `null`. Runs before any fs access: a hand-edited key
 * like `../../.ssh/id_rsa` would otherwise make the hermetic test read outside the checkout.
 */
export function validateRelPath(relPath: string, repoRoot: string = REPO_ROOT): string | null {
  if (relPath === '') return 'the path is empty';
  if (relPath.includes('\0')) return 'the path contains a NUL byte';
  // Git paths always use `/`; a backslash can only be a hand edit.
  if (relPath.includes('\\')) return 'the path contains a backslash';
  if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) return 'the path is absolute';
  const segments = relPath.split('/');
  if (segments.some((segment) => segment === '')) return 'the path has an empty segment';
  if (segments.some((segment) => segment === '.' || segment === '..')) return 'the path has a "." or ".." segment';
  const resolved = path.resolve(repoRoot, relPath);
  const root = path.resolve(repoRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return 'the path resolves outside the repository';
  return null;
}

/**
 * Why the entry's physical parent resolves outside the repo, or `null`: an ancestor directory can be a symlink
 * (`node_modules` is one here) even when every lexical rule passes. Never follows the final component, since
 * `hashFile` hashes a symlink's target string.
 */
export function ancestorEscape(relPath: string, repoRoot: string = REPO_ROOT): string | null {
  const root = realpath(repoRoot) ?? path.resolve(repoRoot);
  let dir = path.dirname(path.resolve(repoRoot, relPath));
  const below: string[] = [];
  for (let hop = 0; hop < 4096; hop += 1) {
    const real = realpath(dir);
    if (real !== null) {
      const resolved = path.join(real, ...below);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return `an ancestor directory resolves outside the repository (${resolved})`;
      }
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    below.unshift(path.basename(dir));
    dir = parent;
  }
  return 'the path has too many segments to resolve';
}

function realpath(abs: string): string | null {
  try {
    return fs.realpathSync(abs);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    void error; // Does not exist (yet) — the caller walks further up.
    return null;
  }
}

/**
 * sha256 of one path's content, or `null` when absent. A symlink hashes its target string as raw bytes (git's
 * 120000 blob content); following it or decoding it as UTF-8 would disagree with `--check <ref>`.
 */
export function hashFile(abs: string): string | null {
  const stat = lstat(abs);
  if (stat === null) return null;
  const content = stat.isSymbolicLink() ? fs.readlinkSync(abs, { encoding: 'buffer' }) : fs.readFileSync(abs);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * The working-tree mode from `lstat`, or `null` when absent. Not from the index: every other measurement is
 * against the working tree, and an unstaged `chmod +x` would leave the index mode permanently stale.
 */
export function fileModeOf(abs: string): GitMode | null {
  const stat = lstat(abs);
  if (stat === null) return null;
  if (stat.isSymbolicLink()) return '120000';
  if (!stat.isFile()) return null;
  // Git records the owner execute bit and nothing else.
  return (stat.mode & 0o100) !== 0 ? '100755' : '100644';
}

/** Whether a path exists; a dangling symlink counts. */
export function pathExists(abs: string): boolean {
  return lstat(abs) !== null;
}

function lstat(abs: string): fs.Stats | null {
  try {
    return fs.lstatSync(abs);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    void error; // ENOENT is the answer, not an error.
    return null;
  }
}

/**
 * One argument, single-quoted for a POSIX shell: hints are pasted verbatim and a path may hold spaces, quotes,
 * newlines or a leading dash.
 */
export function shellQuote(value: string): string {
  if (value !== '' && /^[A-Za-z0-9_./@:+-]+$/.test(value) && !value.startsWith('-')) return value;
  return `'${value.split("'").join(`'\\''`)}'`;
}

export function acceptFlag(relPath: string): string {
  return `--accept ${shellQuote(relPath)}`;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

/**
 * Where `checkTree`/`checkEntry` read presence, mode and content: the working tree by default, or a git commit
 * (`--check <ref>`) so the same per-entry logic runs without a checkout.
 */
export interface TreeReader {
  exists(relPath: string): boolean;
  modeOf(relPath: string): GitMode | null;
  hashOf(relPath: string): string | null;
}

function fsTreeReader(repoRoot: string): TreeReader {
  return {
    exists: (relPath) => pathExists(path.join(repoRoot, relPath)),
    modeOf: (relPath) => fileModeOf(path.join(repoRoot, relPath)),
    hashOf: (relPath) => hashFile(path.join(repoRoot, relPath)),
  };
}

/**
 * Whether `value` has the shape of a manifest: a plain object, `upstream` a 40-hex sha, `paths` a 64-hex digest,
 * `files` an object. Both `main()` and `--check <ref>` call it before any property read or `resolveCommit`, so a
 * malformed manifest yields a MALFORMED finding instead of a throw or a misdiagnosed `git fetch` hint.
 * `unpinnedOk` exists only for `main()`'s in-memory baseline when `--upstream` creates the first manifest; on-disk
 * and ref manifests are always checked strictly.
 */
export function validateManifestShape(value: unknown, opts: { unpinnedOk?: boolean } = {}): Finding[] {
  const unpinnedOk = opts.unpinnedOk ?? false;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [
      {
        kind: 'malformed',
        path: MANIFEST_REL,
        detail: `the manifest is not an object: ${JSON.stringify(value)}`,
        hint: `regenerate: ${REGENERATE_HINT}`,
      },
    ];
  }
  const manifest = value as { upstream?: unknown; paths?: unknown; files?: unknown };
  const findings: Finding[] = [];
  if (typeof manifest.upstream !== 'string') {
    findings.push({
      kind: 'malformed',
      path: MANIFEST_REL,
      detail: `"upstream" is not a string: ${JSON.stringify(manifest.upstream)}`,
      hint: `regenerate: ${REGENERATE_HINT}`,
    });
  } else if (!(unpinnedOk && manifest.upstream === '') && !COMMIT_RE.test(manifest.upstream)) {
    findings.push({
      kind: 'malformed',
      path: MANIFEST_REL,
      detail: `"upstream" is not a 40-character commit sha: ${JSON.stringify(manifest.upstream)}`,
      hint: 're-pin deliberately: pnpm run ratchet:report -- --upstream <rev>',
    });
  }
  if (typeof manifest.paths !== 'string') {
    findings.push({
      kind: 'malformed',
      path: MANIFEST_REL,
      detail: `"paths" is not a string: ${JSON.stringify(manifest.paths)}`,
      hint: `regenerate: ${REGENERATE_HINT}`,
    });
  } else if (!(unpinnedOk && manifest.paths === '') && !SHA256_RE.test(manifest.paths)) {
    findings.push({
      kind: 'malformed',
      path: MANIFEST_REL,
      detail: `"paths" is not a 64-character sha256 hex digest: ${JSON.stringify(manifest.paths)}`,
      hint: `regenerate: ${REGENERATE_HINT}`,
    });
  }
  if (manifest.files === null || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    findings.push({
      kind: 'malformed',
      path: MANIFEST_REL,
      detail: '"files" is missing or is not an object',
      hint: `regenerate: ${REGENERATE_HINT}`,
    });
  }
  return findings;
}

/**
 * Every way the tree and the committed manifest disagree. Empty means CURRENT, not zero divergence. The ancestor
 * symlink check runs only for the default fs reader.
 */
export function checkTree(
  manifest: UpstreamRatchetManifest,
  repoRoot: string = REPO_ROOT,
  reader?: TreeReader,
): Finding[] {
  // Any shape finding stops here: everything below assumes a plain object with a usable pin.
  const shapeFindings = validateManifestShape(manifest);
  if (shapeFindings.length > 0) return shapeFindings;

  const findings: Finding[] = [];

  // The seal is the only check that catches a deleted entry; per-entry checks have nothing left to check.
  const seal = pathsSeal(Object.keys(manifest.files));
  if (manifest.paths !== seal) {
    findings.push({
      kind: 'malformed',
      path: MANIFEST_REL,
      detail:
        `"paths" seal ${JSON.stringify(manifest.paths)} does not cover the ${Object.keys(manifest.files).length} ` +
        `entries present (expected ${seal}) — an entry was added or removed by hand`,
      hint: `regenerate from the pinned commit: ${REGENERATE_HINT}`,
    });
  }

  for (const [relPath, entry] of Object.entries(manifest.files)) {
    findings.push(...checkEntry(relPath, entry, repoRoot, reader));
  }
  return findings;
}

function checkEntry(relPath: string, entry: UpstreamRatchetEntry, repoRoot: string, reader?: TreeReader): Finding[] {
  const findings: Finding[] = [];
  const malformed = (detail: string): void => {
    findings.push({ kind: 'malformed', path: relPath, detail, hint: `regenerate: ${REGENERATE_HINT}` });
  };

  // Before any fs access. The physical ancestor check applies only to the fs reader; ls-tree paths are clean.
  const invalidPath = validateRelPath(relPath, repoRoot);
  if (invalidPath !== null) {
    malformed(`not a usable repo-relative path: ${invalidPath}`);
    return findings;
  }
  if (reader === undefined) {
    const escape = ancestorEscape(relPath, repoRoot);
    if (escape !== null) {
      malformed(`not a usable repo-relative path: ${escape}`);
      return findings;
    }
  }

  if (entry === null || typeof entry !== 'object') {
    malformed('the entry is not an object');
    return findings;
  }
  if (!Number.isInteger(entry.diff) || entry.diff < 0) {
    malformed(`"diff" must be a non-negative integer, got ${JSON.stringify(entry.diff)}`);
  }
  if (typeof entry.mode !== 'string' || !isGitMode(entry.mode)) {
    malformed(`"mode" must be 100644, 100755 or 120000, got ${JSON.stringify(entry.mode)}`);
  }
  if (entry.sha256 !== null && (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256))) {
    malformed(`"sha256" must be 64 lowercase hex characters or null, got ${JSON.stringify(entry.sha256)}`);
  }
  if (entry.deleted !== undefined && entry.deleted !== true) {
    malformed(`"deleted" may only be present as true, got ${JSON.stringify(entry.deleted)}`);
  }
  if (entry.ignored !== undefined && entry.ignored !== true) {
    malformed(`"ignored" may only be present as true, got ${JSON.stringify(entry.ignored)}`);
  }
  if (entry.binary !== undefined && entry.binary !== true) {
    malformed(`"binary" may only be present as true, got ${JSON.stringify(entry.binary)}`);
  }
  // `check-ignore` never reports a tracked path, so `ignored` without `deleted` could not have been generated.
  if (entry.ignored === true && entry.deleted !== true) {
    malformed('an "ignored" entry must also be "deleted" — check-ignore never reports a tracked path');
  }
  if (entry.deleted === true && entry.sha256 !== null) {
    malformed('a deleted entry must carry "sha256": null');
  }
  if (entry.deleted !== true && entry.sha256 === null) {
    malformed("a non-deleted entry must carry a sha256 of the fork's bytes");
  }
  if (findings.length > 0) return findings;

  // An ignored path's bytes are whatever the runtime last did (e.g. a lock file); the divergence is the
  // .gitignore rule, already counted on its own entry.
  if (entry.ignored === true) return findings;

  const active = reader ?? fsTreeReader(repoRoot);
  const present = active.exists(relPath);

  if (entry.deleted === true) {
    if (present) {
      findings.push({
        kind: 'resurrected',
        path: relPath,
        detail: 'the manifest records this upstream path as deleted in the fork, but it is present in the tree',
        hint: `re-adopting an upstream file is new divergence — regenerate and accept it: ${REGENERATE_HINT} ${acceptFlag(relPath)}`,
      });
    }
    return findings;
  }

  if (!present) {
    findings.push({
      kind: 'missing',
      path: relPath,
      detail: 'the manifest records this upstream path as present in the fork, but it is absent from the tree',
      hint: `deleting an upstream file is new divergence — regenerate and accept it: ${REGENERATE_HINT} ${acceptFlag(relPath)}`,
    });
    return findings;
  }

  const actualMode = active.modeOf(relPath);
  if (actualMode === null) {
    findings.push({
      kind: 'mode',
      path: relPath,
      detail: 'the path is neither a regular file nor a symlink, so it has no git blob mode',
      hint: `an upstream-owned path cannot be a directory or a device — restore it, then regenerate: ${REGENERATE_HINT}`,
    });
    return findings;
  }
  if (actualMode !== entry.mode) {
    findings.push({
      kind: 'mode',
      path: relPath,
      detail: `file mode changed since the manifest was written (expected ${entry.mode}, got ${actualMode})`,
      hint: `a mode change is divergence too — regenerate and accept it: ${REGENERATE_HINT} ${acceptFlag(relPath)}`,
    });
  }

  const actual = active.hashOf(relPath);
  if (actual !== entry.sha256) {
    findings.push({
      kind: 'changed',
      path: relPath,
      detail: `content changed since the manifest was written (expected sha256 ${entry.sha256}, got ${actual})`,
      hint: `regenerate so the recorded diff matches the file again: ${REGENERATE_HINT}`,
    });
  }
  return findings;
}

export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `  ${f.kind} ${f.path}: ${f.detail}\n    fix: ${f.hint}`).join('\n');
}

export function divergentEntries(manifest: UpstreamRatchetManifest): Array<[string, UpstreamRatchetEntry]> {
  return Object.entries(manifest.files).filter(([, entry]) => entry.diff > 0);
}

export function totalDiffLines(manifest: UpstreamRatchetManifest): number {
  return Object.values(manifest.files).reduce((sum, entry) => sum + entry.diff, 0);
}
