/**
 * Upstream-ownership ratchet — the fork's divergence from nanocoai/nanoclaw.
 *
 * `src/upstream-ratchet.json` is an allowlist of every path upstream owns at one
 * PINNED upstream commit, each with the size of the fork's divergence in that
 * file (`diff`, added+deleted lines vs the pinned commit) and a sha256 of the
 * fork's current bytes. Growth in `diff` fails; shrink is always allowed; a file
 * that was byte-identical and is no longer is NEW divergence and fails.
 *
 * ── Reach, stated plainly ──────────────────────────────────────────────────
 *
 * This module, and the vitest suite that drives it, CANNOT measure diff size.
 * A test here has no git: `src/test-hermeticity.ts` mocks `child_process` for
 * every host suite, and the fork's CI clone carries no upstream commit objects
 * at all (the same reason `src/mailbox-seam-manifest.ts` ships a committed hash
 * manifest). So the split is:
 *
 *  - THIS module verifies the manifest is CURRENT: every upstream-owned file
 *    still hashes to what it hashed when its `diff` was measured, deleted stays
 *    deleted, present stays present, and every entry is internally well formed.
 *    That is what makes the recorded `diff` trustworthy without git.
 *  - `scripts/upstream-ratchet-report.ts` does the arbitration: it recomputes
 *    every `diff` against the pinned commit with one `git diff --numstat` and
 *    classifies each path as GROWTH / SHRINK / NEW / STALE / UNCHANGED.
 *
 * Paths the FORK added are out of scope — they are not upstream-owned, and
 * there is nothing to ratchet against. Only the paths in
 * `git ls-tree -r <pinned sha>` get an entry, and every one of them does: no
 * exclusions, so a divergence cannot hide by being left off the list.
 *
 * Pure `fs` + `crypto` by construction. Do not import `child_process` here.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo this module was loaded from — a worktree when it is loaded from one. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Manifest location, relative to a repo root. */
export const MANIFEST_REL = 'src/upstream-ratchet.json';

/** The command that regenerates the manifest, quoted in every finding's hint. */
export const REGENERATE_HINT = 'pnpm run ratchet:report -- --write';

/**
 * One upstream-owned path.
 *
 *  - `diff`   added+deleted lines vs the pinned commit. 0 means byte-identical.
 *             For a path the fork DELETED this is upstream's own line count
 *             (every line reads as deleted). For a binary path it is 1 when the
 *             bytes differ.
 *  - `sha256` sha256 of the FORK's current bytes, or `null` when the fork has
 *             deleted the path. For a symlink it is the sha256 of the link
 *             TARGET STRING, which is what git stores for a mode-120000 blob.
 *  - `deleted` present only when the fork deleted the path.
 *  - `binary`  present only when git reported the path as binary (`-` numstat).
 */
export interface UpstreamRatchetEntry {
  diff: number;
  sha256: string | null;
  deleted?: true;
  binary?: true;
}

export interface UpstreamRatchetManifest {
  /** The PINNED upstream commit. Never `upstream/main` — a moving base would
   *  measure upstream's activity rather than the fork's divergence. Re-pinning
   *  is a deliberate act: `--upstream <sha>`. */
  upstream: string;
  /** One entry per path in `git ls-tree -r <upstream>`, sorted by path. */
  files: Record<string, UpstreamRatchetEntry>;
}

export type FindingKind =
  /** The fork's bytes moved since `diff` was measured — `diff` is now unproven. */
  | 'changed'
  /** The entry is not marked deleted, but the file is absent from the tree. */
  | 'missing'
  /** The entry is marked deleted, but the file is present in the tree. */
  | 'resurrected'
  /** The manifest itself is not internally well formed. */
  | 'malformed';

export interface Finding {
  kind: FindingKind;
  /** The upstream-owned path, or the manifest itself for a manifest-level finding. */
  path: string;
  /** What is wrong, in one line. */
  detail: string;
  /** What to run to fix it, in one line. */
  hint: string;
}

export function manifestPath(repoRoot: string = REPO_ROOT): string {
  return path.join(repoRoot, MANIFEST_REL);
}

export function readManifest(repoRoot: string = REPO_ROOT): UpstreamRatchetManifest {
  return JSON.parse(fs.readFileSync(manifestPath(repoRoot), 'utf8')) as UpstreamRatchetManifest;
}

export function writeManifest(manifest: UpstreamRatchetManifest, repoRoot: string = REPO_ROOT): void {
  const target = manifestPath(repoRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(sortManifest(manifest), null, 2) + '\n');
}

/** The manifest with `files` in path order, so a regeneration produces a stable diff. */
export function sortManifest(manifest: UpstreamRatchetManifest): UpstreamRatchetManifest {
  const files: Record<string, UpstreamRatchetEntry> = {};
  for (const key of Object.keys(manifest.files).sort()) files[key] = manifest.files[key];
  return { upstream: manifest.upstream, files };
}

/**
 * sha256 of one path's content, or `null` when it does not exist.
 *
 * Symlink-aware: `lstat` first, and for a symlink hash the TARGET STRING rather
 * than following the link. Two of upstream's paths are mode-120000 blobs
 * (`.agents/skills`, `AGENTS.md`), and git's content for those is the target
 * string. Following them instead would hash the pointee, so a re-aimed symlink
 * would read as unchanged and a dangling one would read as deleted.
 */
export function hashFile(abs: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    void error; // ENOENT is the answer, not an error.
    return null;
  }
  const content = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(abs), 'utf8') : fs.readFileSync(abs);
  return createHash('sha256').update(content).digest('hex');
}

/** Whether a path exists, symlinks included (a dangling link still counts). */
export function pathExists(abs: string): boolean {
  try {
    fs.lstatSync(abs);
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    void error;
    return false;
  }
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

/**
 * Every way the working tree and the committed manifest disagree.
 *
 * An empty result means the manifest is CURRENT — not that the fork is at zero
 * divergence, and not that the recorded `diff` values are the smallest they
 * could be. See the reach note at the top of this file.
 */
export function checkTree(manifest: UpstreamRatchetManifest, repoRoot: string = REPO_ROOT): Finding[] {
  const findings: Finding[] = [];

  if (typeof manifest.upstream !== 'string' || !COMMIT_RE.test(manifest.upstream)) {
    findings.push({
      kind: 'malformed',
      path: MANIFEST_REL,
      detail: `"upstream" is not a 40-character commit sha: ${JSON.stringify(manifest.upstream)}`,
      hint: `re-pin deliberately: pnpm run ratchet:report -- --upstream <sha>`,
    });
  }
  if (manifest.files === null || typeof manifest.files !== 'object') {
    findings.push({
      kind: 'malformed',
      path: MANIFEST_REL,
      detail: '"files" is missing or is not an object',
      hint: `regenerate: ${REGENERATE_HINT}`,
    });
    return findings;
  }

  for (const [relPath, entry] of Object.entries(manifest.files)) {
    findings.push(...checkEntry(relPath, entry, repoRoot));
  }
  return findings;
}

function checkEntry(relPath: string, entry: UpstreamRatchetEntry, repoRoot: string): Finding[] {
  const findings: Finding[] = [];
  const malformed = (detail: string): void => {
    findings.push({ kind: 'malformed', path: relPath, detail, hint: `regenerate: ${REGENERATE_HINT}` });
  };

  if (!Number.isInteger(entry.diff) || entry.diff < 0) {
    malformed(`"diff" must be a non-negative integer, got ${JSON.stringify(entry.diff)}`);
  }
  if (entry.sha256 !== null && (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256))) {
    malformed(`"sha256" must be 64 lowercase hex characters or null, got ${JSON.stringify(entry.sha256)}`);
  }
  if (entry.deleted !== undefined && entry.deleted !== true) {
    malformed(`"deleted" may only be present as true, got ${JSON.stringify(entry.deleted)}`);
  }
  if (entry.binary !== undefined && entry.binary !== true) {
    malformed(`"binary" may only be present as true, got ${JSON.stringify(entry.binary)}`);
  }
  // A deleted path has no fork bytes to hash, and a present one always does.
  // These two are what let a reader trust `deleted` without stat-ing the tree.
  if (entry.deleted === true && entry.sha256 !== null) {
    malformed('a deleted entry must carry "sha256": null');
  }
  if (entry.deleted !== true && entry.sha256 === null) {
    malformed("a non-deleted entry must carry a sha256 of the fork's bytes");
  }
  if (findings.length > 0) return findings;

  const abs = path.join(repoRoot, relPath);
  const present = pathExists(abs);

  if (entry.deleted === true) {
    if (present) {
      findings.push({
        kind: 'resurrected',
        path: relPath,
        detail: 'the manifest records this upstream path as deleted in the fork, but it is present in the tree',
        hint: `re-adopting an upstream file is new divergence — regenerate and accept it: ${REGENERATE_HINT} --accept ${relPath}`,
      });
    }
    return findings;
  }

  if (!present) {
    findings.push({
      kind: 'missing',
      path: relPath,
      detail: 'the manifest records this upstream path as present in the fork, but it is absent from the tree',
      hint: `deleting an upstream file is new divergence — regenerate and accept it: ${REGENERATE_HINT} --accept ${relPath}`,
    });
    return findings;
  }

  const actual = hashFile(abs);
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

/** Findings rendered for a test failure message, one per line. */
export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `  ${f.kind} ${f.path}: ${f.detail}\n    fix: ${f.hint}`).join('\n');
}

/** Divergent = every entry the fork is not byte-identical to upstream on. */
export function divergentEntries(manifest: UpstreamRatchetManifest): Array<[string, UpstreamRatchetEntry]> {
  return Object.entries(manifest.files).filter(([, entry]) => entry.diff > 0);
}

/** Total added+deleted lines the fork carries against the pinned commit. */
export function totalDiffLines(manifest: UpstreamRatchetManifest): number {
  return Object.values(manifest.files).reduce((sum, entry) => sum + entry.diff, 0);
}
