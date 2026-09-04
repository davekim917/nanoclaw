/**
 * Upstream-ownership ratchet — the fork's divergence from nanocoai/nanoclaw.
 *
 * `src/upstream-ratchet.json` is an allowlist of every path upstream owns at one
 * PINNED upstream commit, each with the size of the fork's divergence in that
 * file (`diff`), the fork's file mode, and a sha256 of the fork's current bytes.
 * Growth in `diff` fails; shrink is always allowed; a file that was
 * byte-identical and is no longer is NEW divergence and fails.
 *
 * ── Reach, stated plainly ──────────────────────────────────────────────────
 *
 * This module, and the vitest suite that drives it, CANNOT measure diff size.
 * A test here has no git: `src/test-hermeticity.ts` mocks `child_process` for
 * every host suite, and the fork's CI clone carries no upstream commit objects
 * until the ratchet's own CI step fetches them (the same reason
 * `src/mailbox-seam-manifest.ts` ships a committed hash manifest). So the split
 * is three ways:
 *
 *  - THIS module verifies the manifest is CURRENT: every upstream-owned file
 *    still hashes AND still has the mode it had when its `diff` was measured,
 *    deleted stays deleted, present stays present, the pinned path set is
 *    complete, and every entry is internally well formed. That is what makes
 *    the recorded `diff` trustworthy without git.
 *  - `src/upstream-ratchet-core.ts` holds the pure arbitration — parsing git's
 *    output, building entries, classifying GROWTH / NEW / SHRINK / STALE, and
 *    the `--write` gate — so all of it has hermetic tests.
 *  - `scripts/upstream-ratchet-report.ts` runs git and picks an exit code.
 *
 * Paths the FORK added are out of scope — they are not upstream-owned, and
 * there is nothing to ratchet against. Only the paths in
 * `git ls-tree -r <pinned sha>` get an entry, and every one of them does: no
 * exclusions, and the `paths` seal below makes an omission fail rather than pass.
 *
 * ── Why an ignored path is recorded rather than checked ────────────────────
 *
 * An entry carrying `ignored: true` skips the presence, mode and hash checks.
 * That looks like a hole, and a reviewer read it as one, so the reasoning is
 * here rather than in a commit message.
 *
 * **The objection.** A deleted upstream path matched by an ignore rule can be
 * recreated with arbitrary bytes, and those bytes can change again later, and
 * neither the test nor the report says a word. Resurrection checks exist
 * precisely to catch a deleted upstream file coming back.
 *
 * **Why it does not apply.** Ordinary git operations leave an ignored path
 * untracked, so whatever is sitting there is not fork source. This tool measures
 * the divergence of the fork's SOURCE from upstream's; untracked bytes are
 * whatever the machine happened to be doing. The one real instance is a runtime
 * lock file that a running system recreates on its own checkout, so "did it come
 * back?" answers "is the system up?" — which is not a question about divergence,
 * and answering it made the host suite red on a production checkout.
 *
 * `git add -f` CAN track an ignored path, and that is not a hole. Once it is
 * tracked, `git check-ignore` stops reporting it (it is index-aware), so the
 * entry loses `ignored` on the next regeneration and the deleted → present
 * transition classifies as GROWTH, which needs an explicit `--accept`. Taking an
 * ignored upstream path back into the fork is therefore a reviewed act, exactly
 * like any other new divergence. Making the path source deliberately — by
 * editing `.gitignore` — goes through the ratchet too: `.gitignore` is itself an
 * upstream-owned file with its own entry, so that edit moves a diff.
 *
 * **What is NOT claimed.** That the tree is clean, or that nothing is sitting
 * there. Only that the fork's committed content is unchanged, which is the
 * property this whole file exists to check.
 *
 * **What holds it up.** The exemption is load-bearing only while `ignored`
 * really does mean untracked, so that is asserted rather than assumed:
 * `buildManifest` refuses at write time if an ignored path is in the fork index
 * (an ignore rule over a tracked file is a misconfiguration, and git honours the
 * index over the rule), `checkEntry` rejects an `ignored` entry that is not also
 * `deleted`, and the hermetic suite asserts that pairing over the real manifest.
 * A per-file exception list was considered and rejected: it would need a human
 * to maintain, and it would say nothing about why.
 *
 * Pure `fs` + `crypto` by construction. Do not import `child_process` here.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The three blob modes git records for a file.
 *
 * Lives here rather than in `src/upstream-ratchet-core.ts` because it is part of
 * the manifest's shape, and because the dependency between the two modules must
 * run one way only: core imports this module, never the reverse (the host is
 * ESM, where a cycle is a runtime trap — see CLAUDE.md, Module System).
 */
export type GitMode = '100644' | '100755' | '120000';

export const GIT_MODES: readonly GitMode[] = ['100644', '100755', '120000'];

export function isGitMode(value: string): value is GitMode {
  return (GIT_MODES as readonly string[]).includes(value);
}

/**
 * A submodule. The ratchet cannot express one: there are no bytes to hash and no
 * lines to count, so every check it makes would be vacuous. Refused loudly on
 * either side rather than silently recorded as something it is not.
 */
export const GITLINK_MODE = '160000';

/** The repo this module was loaded from — a worktree when it is loaded from one. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Manifest location, relative to a repo root. */
export const MANIFEST_REL = 'src/upstream-ratchet.json';

/** The command that regenerates the manifest, quoted in every finding's hint. */
export const REGENERATE_HINT = 'pnpm run ratchet:report -- --write';

/**
 * One upstream-owned path.
 *
 *  - `diff`   added+deleted lines vs the pinned commit, plus one unit when the
 *             fork's file mode differs from upstream's. 0 means byte- and
 *             mode-identical. For a path the fork DELETED this is upstream's own
 *             line count. For a binary path it is 1 for the bytes (plus the mode
 *             unit if any), because there are no lines to count.
 *  - `mode`   the FORK's working-tree mode, or upstream's when the fork deleted
 *             the path. A mode change carries no bytes and no lines, so without
 *             this field `chmod -x` on an upstream-owned file is invisible.
 *  - `sha256` sha256 of the FORK's current bytes, or `null` when the fork has
 *             deleted the path. For a symlink it is the sha256 of the link
 *             TARGET STRING, which is what git stores for a mode-120000 blob.
 *  - `deleted` present only when the fork deleted the path.
 *  - `ignored` present only when the fork's `.gitignore` covers the path. Always
 *             together with `deleted`, because `git check-ignore` is index-aware
 *             and never reports a tracked path. See the note below.
 *  - `binary`  present only when git reported the path as binary (`-` numstat).
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
  /** The PINNED upstream commit, full 40-hex. Never `upstream/main` — a moving
   *  base would measure upstream's activity rather than the fork's divergence.
   *  Re-pinning is a deliberate act: `--upstream <rev>`. */
  upstream: string;
  /**
   * Coverage seal: sha256 of the pinned commit's sorted path list joined by
   * newlines.
   *
   * Without it, deleting one entry line leaves valid, sorted, canonical JSON
   * that every hermetic check passes — and that upstream-owned path is then
   * silently unprotected. The seal is computed from the path SET, not from the
   * entries' contents, so an ordinary regeneration never moves it; it changes
   * only on a re-pin, where upstream's own tree changed.
   */
  paths: string;
  /** One entry per path in `git ls-tree -r <upstream>`, sorted by path. */
  files: Record<string, UpstreamRatchetEntry>;
}

export type FindingKind =
  /** The fork's bytes moved since `diff` was measured — `diff` is now unproven. */
  | 'changed'
  /** The fork's file mode moved since `diff` was measured. */
  | 'mode'
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
  fs.writeFileSync(target, serializeManifest(manifest));
}

/**
 * The coverage seal for a set of upstream-owned paths.
 *
 * Sorted, joined by `\n` with no trailing newline, sha256'd. Deterministic and
 * order-independent, so two regenerations of the same pinned commit agree.
 */
export function pathsSeal(paths: readonly string[]): string {
  return createHash('sha256')
    .update([...paths].sort().join('\n'), 'utf8')
    .digest('hex');
}

/** The manifest with its seal recomputed from its own key set. */
export function sealManifest(manifest: UpstreamRatchetManifest): UpstreamRatchetManifest {
  return { ...manifest, paths: pathsSeal(Object.keys(manifest.files)) };
}

/**
 * The manifest's ON-DISK form: ONE LINE PER FILE ENTRY, sorted by path.
 *
 * `JSON.stringify(…, null, 2)` would spread every entry over four to six lines
 * and indent them, which makes this file a merge minefield: two PRs that each
 * regenerate it after touching unrelated upstream-owned files would collide on
 * the indented braces between their entries. One line per path means git's
 * line-level merge resolves them cleanly — two regenerations conflict only on
 * the paths they BOTH touched, which is exactly the case a human should look at.
 *
 * The file carries `upstream`, `paths` and `files` and nothing else. No totals,
 * no counts, no timestamps: an aggregate would change on every regeneration
 * regardless of which path moved, so every PR would conflict on it, and it would
 * be a second copy of a number `scripts/upstream-ratchet-report.ts` derives from
 * the entries anyway. (`paths` is a seal over the key set, not an aggregate over
 * their contents — it is stable across ordinary regenerations.)
 *
 * Deterministic by construction — sorted paths, fixed key order within an entry,
 * optional flags only when true — so `--write` twice on an unchanged tree
 * produces byte-identical output. `src/upstream-ratchet.json` is in
 * `.prettierignore`, because prettier would reflow it straight back into the
 * indented shape this avoids.
 *
 * Still ordinary JSON: `readManifest` is a plain `JSON.parse`.
 */
export function serializeManifest(manifest: UpstreamRatchetManifest): string {
  const sorted = sortManifest(manifest);
  const paths = Object.keys(sorted.files);
  const lines = [`{"upstream":${JSON.stringify(sorted.upstream)},"paths":${JSON.stringify(sorted.paths)},"files":{`];
  paths.forEach((relPath, index) => {
    const entry = sorted.files[relPath];
    // Fixed key order, and an optional flag only when it is set — two runs over
    // the same tree must produce the same bytes.
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

/** The manifest with `files` in path order, so a regeneration produces a stable diff. */
export function sortManifest(manifest: UpstreamRatchetManifest): UpstreamRatchetManifest {
  const files: Record<string, UpstreamRatchetEntry> = {};
  for (const key of Object.keys(manifest.files).sort()) files[key] = manifest.files[key];
  return { upstream: manifest.upstream, paths: manifest.paths, files };
}

/**
 * Why a manifest key is not usable as a repo-relative path, or `null`.
 *
 * Called BEFORE any filesystem access. A manifest key is joined to the repo root
 * and then `lstat`-ed and read; `../../.ssh/id_rsa` as a key would make the
 * hermetic test read outside the checkout, and the hermeticity tripwire guards
 * WRITES, not reads. The manifest is generated, so none of this should ever
 * fire — it fires when someone hand-edits the file, which is precisely when the
 * check is worth having.
 */
export function validateRelPath(relPath: string, repoRoot: string = REPO_ROOT): string | null {
  if (relPath === '') return 'the path is empty';
  if (relPath.includes('\0')) return 'the path contains a NUL byte';
  // Git stores `/` on every platform. A backslash is a literal character in a
  // git path, not a separator, so a key containing one cannot have come from
  // `ls-tree` output on any host and is a hand edit or a Windows-ism.
  if (relPath.includes('\\')) return 'the path contains a backslash';
  if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) return 'the path is absolute';
  const segments = relPath.split('/');
  if (segments.some((segment) => segment === '')) return 'the path has an empty segment';
  if (segments.some((segment) => segment === '.' || segment === '..')) return 'the path has a "." or ".." segment';
  // Belt and braces: even with the lexical checks above, the resolved path must
  // land inside the repo.
  const resolved = path.resolve(repoRoot, relPath);
  const root = path.resolve(repoRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return 'the path resolves outside the repository';
  return null;
}

/**
 * Why the entry's PHYSICAL location is outside the repo, or `null`.
 *
 * `validateRelPath` is lexical, and `path.resolve` never touches the disk. That
 * is not enough on its own: an ancestor DIRECTORY can be a symlink pointing
 * anywhere. In this very checkout `node_modules` is a symlink to another tree,
 * so a hand-written key like `node_modules/<file>` passes every lexical rule and
 * is then read from outside the repository. The hermeticity tripwire guards
 * writes, not reads, so nothing else would catch it.
 *
 * Resolves the entry's PARENT and walks up to the nearest ancestor that exists,
 * deliberately never following the final component — the entry itself may well
 * be a symlink, and hashing the link target string rather than the pointee is
 * the whole point of `hashFile`. Segments that do not exist cannot be symlinks,
 * so re-joining them lexically is safe.
 */
export function ancestorEscape(relPath: string, repoRoot: string = REPO_ROOT): string | null {
  const root = realpath(repoRoot) ?? path.resolve(repoRoot);
  let dir = path.dirname(path.resolve(repoRoot, relPath));
  const below: string[] = [];
  // Bounded: one hop per path segment, and `dirname` is a fixed point at the
  // filesystem root, so this cannot spin.
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
    // Nothing along the path exists, so nothing can be a symlink and the lexical
    // check already settled it.
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
 * sha256 of one path's content, or `null` when it does not exist.
 *
 * Symlink-aware: `lstat` first, and for a symlink hash the TARGET STRING rather
 * than following the link. Two of upstream's paths are mode-120000 blobs
 * (`.agents/skills`, `AGENTS.md`), and git's content for those is the target
 * string. Following them instead would hash the pointee, so a re-aimed symlink
 * would read as unchanged and a dangling one would read as deleted.
 */
export function hashFile(abs: string): string | null {
  const stat = lstat(abs);
  if (stat === null) return null;
  const content = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(abs), 'utf8') : fs.readFileSync(abs);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * The git file mode of a path in the WORKING TREE, or `null` when it is absent.
 *
 * Deliberately derived from `lstat` rather than from `git ls-files -s`. Every
 * other measurement this tool makes is against the working tree — `git diff
 * <commit>` with no second commit, and `hashFile` on the bytes on disk — so
 * taking the mode from the INDEX would mix two different trees into one entry.
 * It would also wedge the hermetic check: an unstaged `chmod +x` leaves the
 * index at 100644 forever, so the recorded mode would permanently disagree with
 * the file, and regenerating could not fix it.
 *
 * A path that is neither a regular file nor a symlink (a directory, a socket)
 * has no blob mode; `null` there would read as "deleted", so it is reported by
 * the caller instead.
 */
export function fileModeOf(abs: string): GitMode | null {
  const stat = lstat(abs);
  if (stat === null) return null;
  if (stat.isSymbolicLink()) return '120000';
  if (!stat.isFile()) return null;
  // Git records the owner execute bit and nothing else.
  return (stat.mode & 0o100) !== 0 ? '100755' : '100644';
}

/** Whether a path exists, symlinks included (a dangling link still counts). */
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
 * One argument, safe to paste into a POSIX shell.
 *
 * The hints this module and the report script print are meant to be run
 * verbatim. An upstream path may hold a space, a quote, a newline or a leading
 * dash, and an unquoted one would split into two arguments or be read as an
 * option. Single quotes take everything literally; the only character that has
 * to be handled is the single quote itself.
 */
export function shellQuote(value: string): string {
  if (value !== '' && /^[A-Za-z0-9_./@:+-]+$/.test(value) && !value.startsWith('-')) return value;
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** `--accept <path>` for one path, quoted so it survives a copy-paste. */
export function acceptFlag(relPath: string): string {
  return `--accept ${shellQuote(relPath)}`;
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
      hint: 're-pin deliberately: pnpm run ratchet:report -- --upstream <rev>',
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

  // The coverage seal. This is the only check that can tell a complete manifest
  // from one an entry was deleted out of — every other check here is per-entry,
  // and a deleted entry has nothing left to check.
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
    findings.push(...checkEntry(relPath, entry, repoRoot));
  }
  return findings;
}

function checkEntry(relPath: string, entry: UpstreamRatchetEntry, repoRoot: string): Finding[] {
  const findings: Finding[] = [];
  const malformed = (detail: string): void => {
    findings.push({ kind: 'malformed', path: relPath, detail, hint: `regenerate: ${REGENERATE_HINT}` });
  };

  // BEFORE any filesystem access. Lexical rules first, then the physical check:
  // an ancestor directory can be a symlink out of the tree even when every
  // lexical rule passes.
  const invalidPath = validateRelPath(relPath, repoRoot);
  if (invalidPath !== null) {
    malformed(`not a usable repo-relative path: ${invalidPath}`);
    return findings;
  }
  const escape = ancestorEscape(relPath, repoRoot);
  if (escape !== null) {
    malformed(`not a usable repo-relative path: ${escape}`);
    return findings;
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
  // `git check-ignore` is index-aware: it never reports a tracked path, so an
  // ignored upstream path is always one the fork does not track — which this
  // manifest records as deleted. An `ignored` entry without `deleted` therefore
  // could not have been generated, and would switch off the presence and hash
  // checks for a file the tree really does own.
  if (entry.ignored === true && entry.deleted !== true) {
    malformed('an "ignored" entry must also be "deleted" — check-ignore never reports a tracked path');
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

  // An IGNORED upstream path is one the fork deleted and then told git to
  // ignore — `.claude/scheduled_tasks.lock` is the live example: a runtime lock
  // file some process recreates on a production checkout whenever the system is
  // running. Nothing about the tree can prove anything here, and asking would
  // make the host suite go red on a file that is not source: present, it reads
  // as `resurrected`; absent, it reads as deleted; both are just "whatever the
  // runtime last did". The DIVERGENCE is the .gitignore rule itself, and that is
  // already counted — `.gitignore` is an upstream-owned file with its own entry,
  // so adding or removing the rule moves a diff there. So: record the fact and
  // check nothing else about it.
  if (entry.ignored === true) return findings;

  const abs = path.join(repoRoot, relPath);
  const present = pathExists(abs);

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

  const actualMode = fileModeOf(abs);
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

/** Divergent = every entry the fork is not byte- and mode-identical to upstream on. */
export function divergentEntries(manifest: UpstreamRatchetManifest): Array<[string, UpstreamRatchetEntry]> {
  return Object.entries(manifest.files).filter(([, entry]) => entry.diff > 0);
}

/** Total added+deleted lines the fork carries against the pinned commit. */
export function totalDiffLines(manifest: UpstreamRatchetManifest): number {
  return Object.values(manifest.files).reduce((sum, entry) => sum + entry.diff, 0);
}
