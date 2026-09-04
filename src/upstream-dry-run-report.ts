/**
 * Weekly upstream dry-run report: read-only triage of what upstream has
 * shipped since the fork's merge-base, without ever touching the working
 * tree (`git merge-tree`, never `git merge` / `git checkout`).
 *
 * This module is split for testability: the `parse*`/`classify*`/`build*`
 * functions below are pure (string in, data out) and are what
 * `upstream-dry-run-report.test.ts` exercises against real `git merge-tree`
 * output fixtures. `generateDryRunReport` is the impure orchestrator that
 * shells out to `git`/`pnpm` — it is not unit tested (no git in tests; the
 * hermeticity tripwire mocks child_process) and is exercised only via the
 * `scripts/upstream-dry-run-report.ts` CLI shim.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { TIMEZONE } from './config.js';
import { formatLocalTime } from './timezone.js';

export type ConflictArea =
  | 'agent-runner/src'
  | `src/modules/${string}`
  | 'setup'
  | '.claude'
  | 'docs'
  | 'src/cli'
  | 'other';

export interface ConflictCounts {
  /** Area -> conflict count, insertion-ordered by first occurrence. */
  byArea: Map<string, number>;
  total: number;
  paths: string[];
}

export interface NewMigration {
  file: string;
  ordinal: number | null;
  name: string | null;
}

export interface MigrationCollision {
  file: string;
  ordinal: number;
  name: string | null;
  collidesWithForkFile: string;
}

/** A fork migration file that is ordinal-numbered: `{ordinal}-{slug}.ts`. */
export interface ForkOrdinalMigrationFile {
  file: string;
  ordinal: number;
}

/**
 * An upstream new migration whose `name:` already matches a fork migration
 * (any fork migration file, ordinal-numbered or not — the migration runner
 * dedupes by `name`, not file number, and this fork has same-name ports
 * registered under a different ordinal, e.g. `module-*.ts` files). Not a
 * collision: the migration is already present, nothing to renumber.
 */
export interface AlreadyPortedMigration {
  file: string;
  ordinal: number | null;
  name: string;
  forkFile: string;
}

export interface MigrationTriage {
  collisions: MigrationCollision[];
  alreadyPorted: AlreadyPortedMigration[];
}

/**
 * Classify a repo-relative path into one of the report's fixed buckets.
 * Order matters: agent-runner/src is checked before the generic src/
 * buckets since it lives under container/, and src/modules/<name> before
 * the plain src/ catch-alls.
 */
export function classifyArea(filePath: string): ConflictArea {
  if (filePath.includes('agent-runner/src/')) return 'agent-runner/src';
  const modulesMatch = filePath.match(/^src\/modules\/([^/]+)\//);
  if (modulesMatch) return `src/modules/${modulesMatch[1]}`;
  if (filePath === 'setup.sh' || filePath.startsWith('setup/')) return 'setup';
  if (filePath.startsWith('.claude/')) return '.claude';
  if (filePath.startsWith('docs/')) return 'docs';
  if (filePath.startsWith('src/cli/')) return 'src/cli';
  return 'other';
}

/**
 * One `git merge-tree --write-tree --name-only <ours> <theirs>` line ->
 * the path(s) it concerns. Handles the four CONFLICT phrasings git emits:
 *   - "CONFLICT (content|add/add): Merge conflict in <path>"
 *   - "CONFLICT (modify/delete): <path> deleted in ... and modified in ..."
 *   - "CONFLICT (rename involved in collision): rename of <a> -> <b> has ..."
 *   - "CONFLICT (rename/delete): <a> renamed to <b> in <ref>, but deleted in <ref>."
 * The last two each name two paths; the destination (post-rename) path is
 * used, since that's where the conflict lands in the resulting tree and
 * therefore what area triage should attribute it to (verified against a
 * real `git merge-tree` run: git substitutes the actual ref names passed
 * as arguments in place of the literal words "ours"/"theirs").
 * Returns null for a line that isn't a CONFLICT line at all.
 */
export function extractConflictPath(line: string): string | null {
  if (!line.startsWith('CONFLICT')) return null;

  const mergeConflictIn = line.match(/Merge conflict in (\S+)$/);
  if (mergeConflictIn) return mergeConflictIn[1];

  const modifyDelete = line.match(/^CONFLICT \([^)]*\): (\S+) deleted in/);
  if (modifyDelete) return modifyDelete[1];

  // Rename-into-collision: two paths are named; the destination is where
  // the conflict actually lands in the resulting tree.
  const renameCollision = line.match(/rename of \S+ -> (\S+) has content conflicts/);
  if (renameCollision) return renameCollision[1];

  // Rename/delete: one side renamed the file, the other deleted the
  // original — attribute to the renamed (destination) path.
  const renameDelete = line.match(/^CONFLICT \(rename\/delete\): \S+ renamed to (\S+) in \S+, but deleted in \S+\.$/);
  if (renameDelete) return renameDelete[1];

  return null;
}

/**
 * Parse the full output of `git merge-tree --write-tree --name-only`.
 * The format is: tree hash, blank-separated list of touched file names,
 * a blank line, then Auto-merging/CONFLICT status lines to EOF. We only
 * need the CONFLICT lines — total count matches `grep -c '^CONFLICT'`.
 */
export function parseMergeTreeConflicts(output: string): ConflictCounts {
  const byArea = new Map<string, number>();
  const paths: string[] = [];

  for (const line of output.split('\n')) {
    if (!line.startsWith('CONFLICT')) continue;
    const conflictPath = extractConflictPath(line);
    const area = conflictPath ? classifyArea(conflictPath) : 'other';
    byArea.set(area, (byArea.get(area) ?? 0) + 1);
    if (conflictPath) paths.push(conflictPath);
  }

  const total = [...byArea.values()].reduce((sum, n) => sum + n, 0);
  return { byArea, total, paths };
}

/** Leading digit run of a migration filename, e.g. "070-foo.ts" -> 70. */
export function extractMigrationOrdinal(filename: string): number | null {
  const base = path.basename(filename);
  const match = base.match(/^(\d+)-/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** The `name: '...'` / `name: "..."` field out of a migration file's source. */
export function extractMigrationName(fileContent: string): string | null {
  const match = fileContent.match(/\bname:\s*['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

/**
 * Filter a newline-separated path listing down to ordinal-numbered
 * migration source files — works on either `git diff --name-only
 * --diff-filter=A <base>..<ref> -- src/db/migrations/` output (new files
 * introduced by <ref>) or `git ls-tree -r --name-only <ref> --
 * src/db/migrations/` output (every file present at <ref>): both are one
 * path per line, and the filtering criteria (ordinal-numbered .ts, not
 * .test.ts, not index.ts/module-*.ts) don't depend on which.
 */
export function parseNewMigrationFiles(pathListing: string): string[] {
  return pathListing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => line.endsWith('.ts') && !line.endsWith('.test.ts'))
    .filter((line) => /\/\d+-/.test(line)); // ordinal-numbered migration files only, not index.ts/module-*.ts
}

/**
 * Parse `git grep -e 'name:' <ref> -- 'src/db/migrations/*.ts'
 * ':!src/db/migrations/*.test.ts'` output into a path -> registered
 * migration name map. Tree-ish `git grep` output is `<ref>:<path>:<rest>`
 * (vs. `<path>:<rest>` for a working-tree grep) — the `refPrefix` the
 * caller passed as `<ref>` is stripped before splitting path from content.
 * Lines whose content isn't a quoted `name:` field (a type declaration, a
 * runtime `name: m.name` reference) yield no match via
 * `extractMigrationName` and are silently dropped, including every line
 * from non-migration files like index.ts that this deliberately
 * unfiltered-by-ordinal pathspec still matches.
 */
export function parseGitGrepNameLines(grepOutput: string, refPrefix: string): Map<string, string> {
  const namesByFile = new Map<string, string>();
  const prefix = `${refPrefix}:`;
  for (const rawLine of grepOutput.split('\n')) {
    if (rawLine.length === 0) continue;
    const line = rawLine.startsWith(prefix) ? rawLine.slice(prefix.length) : rawLine;
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;
    const filePath = line.slice(0, separatorIndex);
    const rest = line.slice(separatorIndex + 1);
    const name = extractMigrationName(rest);
    if (name && !namesByFile.has(filePath)) namesByFile.set(filePath, name);
  }
  return namesByFile;
}

/**
 * Cross-reference new upstream migrations against the fork's migrations,
 * by name first and ordinal second — the migration runner dedupes by
 * `name` (src/db/migrations/index.ts), not file number, so an ordinal-only
 * check misclassifies a migration the fork already ported under a
 * different number as a collision instead of recognizing it needs no
 * action. Only once a migration's name doesn't match any fork migration
 * is it checked against the fork's next free ordinal and already-taken
 * ordinals — a collision there is an upstream new-file ordinal that is
 * < the fork's next-free ordinal (it would overwrite/shadow an
 * already-taken fork file number).
 */
export function detectMigrationCollisions(
  newMigrations: NewMigration[],
  forkOrdinalFiles: ForkOrdinalMigrationFile[],
  forkNamesByName: Map<string, string>,
  forkNextFreeOrdinal: number,
): MigrationTriage {
  const forkByOrdinal = new Map<number, string>();
  for (const { file, ordinal } of forkOrdinalFiles) forkByOrdinal.set(ordinal, file);

  const collisions: MigrationCollision[] = [];
  const alreadyPorted: AlreadyPortedMigration[] = [];

  for (const migration of newMigrations) {
    const forkFile = migration.name !== null ? forkNamesByName.get(migration.name) : undefined;
    if (forkFile) {
      alreadyPorted.push({
        file: migration.file,
        ordinal: migration.ordinal,
        name: migration.name as string,
        forkFile,
      });
      continue;
    }

    if (migration.ordinal === null) continue;
    const existing = forkByOrdinal.get(migration.ordinal);
    if (existing) {
      collisions.push({
        file: migration.file,
        ordinal: migration.ordinal,
        name: migration.name,
        collidesWithForkFile: existing,
      });
    } else if (migration.ordinal < forkNextFreeOrdinal) {
      // Ordinal falls below the fork's free range but doesn't match an
      // exact existing file (renumbered/gap case) — still flag it, no
      // specific colliding file to name.
      collisions.push({
        file: migration.file,
        ordinal: migration.ordinal,
        name: migration.name,
        collidesWithForkFile: '(none — below next-free ordinal)',
      });
    }
  }
  return { collisions, alreadyPorted };
}

/**
 * Added `[BREAKING]` lines (diff `+` lines) out of a
 * `git diff <base>..upstream/main -- CHANGELOG.md` unified diff.
 */
export function parseBreakingChangelogLines(changelogDiff: string): string[] {
  return changelogDiff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1).trim())
    .filter((line) => line.includes('[BREAKING]'));
}

export interface DryRunReportData {
  base: string;
  commitsBehind: number;
  commitsAhead: number;
  conflicts: ConflictCounts;
  newMigrations: NewMigration[];
  migrationCollisions: MigrationCollision[];
  alreadyPorted: AlreadyPortedMigration[];
  forkNextFreeOrdinal: number;
  breakingLines: string[];
  ratchetSummary: string | null;
  /** ISO-8601 UTC — storage form. Rendered in `timezone` for the heading; never shown raw. */
  generatedAt: string;
  /** IANA timezone the report heading is displayed in (the install timezone). */
  timezone: string;
}

const AREA_ORDER: string[] = ['agent-runner/src', 'setup', '.claude', 'docs', 'src/cli', 'other'];

function orderedAreaEntries(byArea: Map<string, number>): [string, number][] {
  const known = AREA_ORDER.filter((area) => byArea.has(area)).map((area): [string, number] => [
    area,
    byArea.get(area) as number,
  ]);
  const modules = [...byArea.entries()]
    .filter(([area]) => area.startsWith('src/modules/'))
    .sort(([a], [b]) => a.localeCompare(b));
  const rest = [...byArea.entries()].filter(([area]) => !AREA_ORDER.includes(area) && !area.startsWith('src/modules/'));
  // agent-runner/src, then src/modules/*, then setup/.claude/docs/src/cli, then other, then anything unforeseen.
  const runner = known.filter(([area]) => area === 'agent-runner/src');
  const restKnown = known.filter(([area]) => area !== 'agent-runner/src' && area !== 'other');
  const other = known.filter(([area]) => area === 'other');
  return [...runner, ...modules, ...restKnown, ...other, ...rest];
}

/** Assemble the final markdown report block from parsed data. */
export function buildReportMarkdown(data: DryRunReportData): string {
  const lines: string[] = [];
  lines.push(`## Upstream dry-run report — ${formatLocalTime(data.generatedAt, data.timezone)}`);
  lines.push('');
  lines.push(
    `Base: \`${data.base.slice(0, 12)}\` — ${data.commitsBehind} commits behind upstream/main, ${data.commitsAhead} ahead.`,
  );
  lines.push('');

  lines.push(`### Merge-tree conflicts (${data.conflicts.total} total)`);
  if (data.conflicts.total === 0) {
    lines.push('None.');
  } else {
    lines.push('');
    lines.push('| Area | Conflicts |');
    lines.push('|---|---|');
    for (const [area, count] of orderedAreaEntries(data.conflicts.byArea)) {
      lines.push(`| ${area} | ${count} |`);
    }
  }
  lines.push('');

  lines.push(`### New upstream migrations (${data.newMigrations.length})`);
  if (data.newMigrations.length === 0) {
    lines.push('None.');
  } else {
    for (const migration of data.newMigrations) {
      const ported = data.alreadyPorted.find((p) => p.file === migration.file);
      const collision = data.migrationCollisions.find((c) => c.file === migration.file);
      const suffix = ported
        ? ` — already ported as \`${ported.forkFile}\` (same name; no ordinal action needed)`
        : collision
          ? ` — **COLLISION** with ${collision.collidesWithForkFile} (fork next free ordinal: ${data.forkNextFreeOrdinal})`
          : '';
      lines.push(`- \`${migration.file}\` name: \`${migration.name ?? '(unparsed)'}\`${suffix}`);
    }
  }
  lines.push('');

  lines.push(`### Breaking changes (${data.breakingLines.length})`);
  if (data.breakingLines.length === 0) {
    lines.push('None.');
  } else {
    for (const line of data.breakingLines) lines.push(`- ${line}`);
  }

  if (data.ratchetSummary !== null) {
    lines.push('');
    lines.push('### Ratchet report');
    lines.push(data.ratchetSummary);
  }

  return lines.join('\n');
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Try `git merge-tree`, which exits non-zero when it finds conflicts (that
 * is not a failure of the command — see `git help merge-tree`).
 */
function gitMergeTree(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const asExecErr = err as { stdout?: string };
    if (typeof asExecErr.stdout === 'string') return asExecErr.stdout;
    throw err;
  }
}

/**
 * `git grep` exits 1 (not an error — see `git help grep`) when nothing
 * matches, e.g. src/db/migrations/ has no files at all at `ref`.
 */
function gitGrepAllowNoMatch(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const asExecErr = err as { status?: number; stdout?: string };
    if (asExecErr.status === 1 && typeof asExecErr.stdout === 'string') return asExecErr.stdout;
    throw err;
  }
}

/**
 * The fork's ordinal-numbered migration files at `ref`, read from git
 * (not the working tree) so the result matches whatever `ref` the report
 * is actually comparing — a worktree checked out to a different branch
 * must not leak checkout-only migrations into the ordinal/collision math.
 * `git ls-tree` exits 0 with empty output for a path absent at `ref`, so
 * no exit-code tolerance is needed here the way `git grep` needs one.
 */
function readForkOrdinalMigrationFiles(repoRoot: string, ref: string): ForkOrdinalMigrationFile[] {
  const lsTreeOutput = git(['ls-tree', '-r', '--name-only', ref, '--', 'src/db/migrations/'], repoRoot);
  return parseNewMigrationFiles(lsTreeOutput).map((file) => ({
    file,
    ordinal: extractMigrationOrdinal(file) as number,
  }));
}

/**
 * Every fork migration's registered name at `ref`, keyed by name — both
 * ordinal-numbered files AND `module-*.ts` fixups, since a same-name port
 * can land under either shape (sync-upstream skill: "upstream 021 == fork
 * 045").
 */
function readForkMigrationNames(repoRoot: string, ref: string): Map<string, string> {
  const grepOutput = gitGrepAllowNoMatch(
    ['grep', '-e', 'name:', ref, '--', 'src/db/migrations/*.ts', ':!src/db/migrations/*.test.ts'],
    repoRoot,
  );
  const nameByFile = parseGitGrepNameLines(grepOutput, ref);
  const forkNamesByName = new Map<string, string>();
  for (const [file, name] of nameByFile) forkNamesByName.set(name, file);
  return forkNamesByName;
}

function forkNextFreeOrdinal(forkOrdinalFiles: ForkOrdinalMigrationFile[]): number {
  const max = forkOrdinalFiles.reduce((acc, f) => Math.max(acc, f.ordinal), -1);
  return max + 1;
}

export interface GenerateOptions {
  repoRoot: string;
  ours?: string; // defaults to origin/main — the fork's stable trunk, not whatever HEAD happens to be checked out
  theirs?: string; // defaults to upstream/main
}

/**
 * Orchestrator: runs the actual git/pnpm commands and assembles the
 * report. Read-only — `git fetch` and `git merge-tree` are the only
 * mutating-looking calls, and merge-tree is explicitly in-memory (never
 * touches the working tree or index).
 *
 * `ours` defaults to `origin/main`, not `HEAD`: this script is documented
 * as safe to run from any worktree, and a feature-branch HEAD would report
 * that branch's ahead/behind and conflicts instead of the fork trunk's.
 * `origin` is fetched alongside `upstream` for the same reason: a
 * scheduled run against a live checkout that hasn't been `git pull`ed
 * since the last deploy would otherwise silently report a stale trunk.
 */
export function generateDryRunReport(opts: GenerateOptions): string {
  const { repoRoot } = opts;
  const ours = opts.ours ?? 'origin/main';
  const theirs = opts.theirs ?? 'upstream/main';

  git(['fetch', 'upstream', '--prune'], repoRoot);
  git(['fetch', 'origin', '--prune'], repoRoot);

  const base = git(['merge-base', ours, theirs], repoRoot).trim();
  const commitsBehind = Number.parseInt(git(['rev-list', '--count', `${base}..${theirs}`], repoRoot).trim(), 10);
  const commitsAhead = Number.parseInt(git(['rev-list', '--count', `${base}..${ours}`], repoRoot).trim(), 10);

  const mergeTreeOutput = gitMergeTree(['merge-tree', '--write-tree', '--name-only', ours, theirs], repoRoot);
  const conflicts = parseMergeTreeConflicts(mergeTreeOutput);

  const migrationDiffOutput = git(
    ['diff', '--name-only', '--diff-filter=A', `${base}..${theirs}`, '--', 'src/db/migrations/'],
    repoRoot,
  );
  const newMigrationFiles = parseNewMigrationFiles(migrationDiffOutput);
  const newMigrations: NewMigration[] = newMigrationFiles.map((file) => {
    let content: string;
    try {
      content = git(['show', `${theirs}:${file}`], repoRoot);
      // eslint-disable-next-line no-catch-all/no-catch-all -- a single unreadable migration file must not sink the whole report; it just loses its name: field.
    } catch {
      content = '';
    }
    return { file, ordinal: extractMigrationOrdinal(file), name: extractMigrationName(content) };
  });

  const forkOrdinalFiles = readForkOrdinalMigrationFiles(repoRoot, ours);
  const forkNamesByName = readForkMigrationNames(repoRoot, ours);
  const nextFree = forkNextFreeOrdinal(forkOrdinalFiles);
  const { collisions: migrationCollisions, alreadyPorted } = detectMigrationCollisions(
    newMigrations,
    forkOrdinalFiles,
    forkNamesByName,
    nextFree,
  );

  const changelogDiff = git(['diff', `${base}..${theirs}`, '--', 'CHANGELOG.md'], repoRoot);
  const breakingLines = parseBreakingChangelogLines(changelogDiff);

  let ratchetSummary: string | null = null;
  const packageJsonPath = path.join(repoRoot, 'package.json');
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
    if (packageJson.scripts && 'ratchet:report' in packageJson.scripts) {
      // Exit 1 means GROWTH or NEW findings (docs/upstream-ratchet.md) — the
      // most informative case for a weekly report, not a failure to swallow.
      // Exit 2 ("cannot measure" — pinned commit not fetched) and any other
      // failure fall through to the catch below and skip the section.
      let output: string;
      try {
        output = execFileSync('pnpm', ['run', 'ratchet:report'], {
          cwd: repoRoot,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        });
      } catch (err) {
        const asExecErr = err as { status?: number; stdout?: string };
        if (asExecErr.status === 1 && typeof asExecErr.stdout === 'string') output = asExecErr.stdout;
        else throw err;
      }
      const nonEmptyLines = output.split('\n').filter((l) => l.trim().length > 0);
      ratchetSummary =
        nonEmptyLines.length > 0 ? nonEmptyLines[nonEmptyLines.length - 1] : '(ratchet:report produced no output)';
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- package.json unreadable, ratchet:report not present, or itself failed for a reason other than reporting GROWTH/NEW findings: skip the section, per brief ("skip otherwise").
  } catch {
    ratchetSummary = null;
  }

  return buildReportMarkdown({
    base,
    commitsBehind,
    commitsAhead,
    conflicts,
    newMigrations,
    migrationCollisions,
    alreadyPorted,
    forkNextFreeOrdinal: nextFree,
    breakingLines,
    ratchetSummary,
    generatedAt: new Date().toISOString(),
    timezone: TIMEZONE,
  });
}
