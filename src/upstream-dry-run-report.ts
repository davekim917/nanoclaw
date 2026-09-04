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
 * Filter a `git diff --name-only --diff-filter=A <base>..upstream/main --
 * src/db/migrations/` listing down to migration source files (drop
 * .test.ts and non-.ts entries like index.ts helpers are left in — callers
 * pass file contents to extractMigrationName and get null for non-migration
 * files, which is filtered out below).
 */
export function parseNewMigrationFiles(diffNameOnlyOutput: string): string[] {
  return diffNameOnlyOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => line.endsWith('.ts') && !line.endsWith('.test.ts'))
    .filter((line) => /\/\d+-/.test(line)); // ordinal-numbered migration files only, not index.ts/module-*.ts
}

/**
 * Cross-reference new upstream migration ordinals against the fork's next
 * free ordinal and its already-registered ordinals. A collision is an
 * upstream new-file ordinal that is < the fork's next-free ordinal (i.e.
 * it would overwrite/shadow an already-taken fork file number).
 */
export function detectMigrationCollisions(
  newMigrations: NewMigration[],
  forkExistingFiles: string[],
  forkNextFreeOrdinal: number,
): MigrationCollision[] {
  const forkByOrdinal = new Map<number, string>();
  for (const file of forkExistingFiles) {
    const ordinal = extractMigrationOrdinal(file);
    if (ordinal !== null) forkByOrdinal.set(ordinal, file);
  }

  const collisions: MigrationCollision[] = [];
  for (const migration of newMigrations) {
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
  return collisions;
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
      const collision = data.migrationCollisions.find((c) => c.file === migration.file);
      const suffix = collision
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

/** Read the fork's next-free migration ordinal by walking src/db/migrations/. */
function readForkMigrationFiles(repoRoot: string): string[] {
  const dir = path.join(repoRoot, 'src', 'db', 'migrations');
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+-.*\.ts$/.test(f) && !f.endsWith('.test.ts'))
    .map((f) => `src/db/migrations/${f}`);
}

function forkNextFreeOrdinal(forkFiles: string[]): number {
  const max = forkFiles.reduce((acc, f) => Math.max(acc, extractMigrationOrdinal(f) ?? -1), -1);
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
 */
export function generateDryRunReport(opts: GenerateOptions): string {
  const { repoRoot } = opts;
  const ours = opts.ours ?? 'origin/main';
  const theirs = opts.theirs ?? 'upstream/main';

  git(['fetch', 'upstream', '--prune'], repoRoot);

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

  const forkFiles = readForkMigrationFiles(repoRoot);
  const nextFree = forkNextFreeOrdinal(forkFiles);
  const migrationCollisions = detectMigrationCollisions(newMigrations, forkFiles, nextFree);

  const changelogDiff = git(['diff', `${base}..${theirs}`, '--', 'CHANGELOG.md'], repoRoot);
  const breakingLines = parseBreakingChangelogLines(changelogDiff);

  let ratchetSummary: string | null = null;
  const packageJsonPath = path.join(repoRoot, 'package.json');
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
    if (packageJson.scripts && 'ratchet:report' in packageJson.scripts) {
      const output = execFileSync('pnpm', ['run', 'ratchet:report'], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      const nonEmptyLines = output.split('\n').filter((l) => l.trim().length > 0);
      ratchetSummary =
        nonEmptyLines.length > 0 ? nonEmptyLines[nonEmptyLines.length - 1] : '(ratchet:report produced no output)';
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- package.json unreadable, or ratchet:report not present / itself failed: skip the section, per brief ("skip otherwise").
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
    forkNextFreeOrdinal: nextFree,
    breakingLines,
    ratchetSummary,
    generatedAt: new Date().toISOString(),
    timezone: TIMEZONE,
  });
}
