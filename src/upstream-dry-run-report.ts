/**
 * Weekly upstream dry-run report: read-only triage via `git merge-tree`, never `git merge`/`git checkout`.
 * `generateDryRunReport` and its git-reading helpers are impure and not unit tested; parsers and renderers are pure.
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
  /** Insertion-ordered by first occurrence. */
  byArea: Map<string, number>;
  total: number;
  paths: string[];
}

export interface NewMigration {
  file: string;
  ordinal: number | null;
  name: string | null;
}

interface MigrationCollision {
  file: string;
  ordinal: number;
  name: string | null;
  collidesWithForkFile: string;
}

export interface ForkOrdinalMigrationFile {
  file: string;
  ordinal: number;
}

/** Same `name:` as a fork migration: the runner dedupes by name, so it's present, not a collision. */
interface AlreadyPortedMigration {
  file: string;
  ordinal: number | null;
  name: string;
  forkFile: string;
}

export interface MigrationTriage {
  collisions: MigrationCollision[];
  alreadyPorted: AlreadyPortedMigration[];
}

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
 * The path a CONFLICT line concerns, or null. For renames, the fork-side destination: merge-tree is always run as
 * `<ours> <theirs>`, and git names the first argument's destination first.
 */
export function extractConflictPath(line: string): string | null {
  if (!line.startsWith('CONFLICT')) return null;

  const mergeConflictIn = line.match(/Merge conflict in (\S+)$/);
  if (mergeConflictIn) return mergeConflictIn[1];

  const modifyDelete = line.match(/^CONFLICT \([^)]*\): (\S+) deleted in/);
  if (modifyDelete) return modifyDelete[1];

  const renameCollision = line.match(/rename of \S+ -> (\S+) has content conflicts/);
  if (renameCollision) return renameCollision[1];

  const renameDelete = line.match(/^CONFLICT \(rename\/delete\): \S+ renamed to (\S+) in \S+, but deleted in \S+\.$/);
  if (renameDelete) return renameDelete[1];

  const renameRename = line.match(/^CONFLICT \(rename\/rename\): \S+ renamed to (\S+) in \S+ and to \S+ in \S+\.$/);
  if (renameRename) return renameRename[1];

  return null;
}

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

export function extractMigrationOrdinal(filename: string): number | null {
  const base = path.basename(filename);
  const match = base.match(/^(\d+)-/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function extractMigrationName(fileContent: string): string | null {
  const match = fileContent.match(/\bname:\s*['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

export function parseNewMigrationFiles(pathListing: string): string[] {
  return pathListing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => line.endsWith('.ts') && !line.endsWith('.test.ts'))
    .filter((line) => /\/\d+-/.test(line)); // ordinal-numbered migration files only, not index.ts/module-*.ts
}

/** Tree-ish `git grep` output is `<ref>:<path>:<rest>`; `refPrefix` is stripped before splitting. */
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

/** By name first, then ordinal: the migration runner dedupes by name, not file number. */
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
  /** ISO-8601 UTC; rendered in `timezone`, never shown raw. */
  generatedAt: string;
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
  const runner = known.filter(([area]) => area === 'agent-runner/src');
  const restKnown = known.filter(([area]) => area !== 'agent-runner/src' && area !== 'other');
  const other = known.filter(([area]) => area === 'other');
  return [...runner, ...modules, ...restKnown, ...other, ...rest];
}

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
 * Tolerates exactly one "not really an error" status; any other rethrows. For merge-tree only 1 (conflicts) is
 * safe: other statuses mean unspecified output, which could silently parse as zero conflicts.
 */
function execTolerant(cmd: string, args: string[], cwd: string, tolerateStatus: number, maxBuffer: number): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer });
  } catch (err) {
    const asExecErr = err as { status?: number; stdout?: string };
    if (asExecErr.status === tolerateStatus && typeof asExecErr.stdout === 'string') return asExecErr.stdout;
    throw err;
  }
}

function gitMergeTree(args: string[], cwd: string): string {
  return execTolerant('git', args, cwd, 1, 64 * 1024 * 1024);
}

function gitGrepAllowNoMatch(args: string[], cwd: string): string {
  return execTolerant('git', args, cwd, 1, 64 * 1024 * 1024);
}

/** Read from git, not the working tree, so a checkout of another branch can't leak into the collision math. */
function readForkOrdinalMigrationFiles(repoRoot: string, ref: string): ForkOrdinalMigrationFile[] {
  const lsTreeOutput = git(['ls-tree', '-r', '--name-only', ref, '--', 'src/db/migrations/'], repoRoot);
  return parseNewMigrationFiles(lsTreeOutput).map((file) => ({
    file,
    ordinal: extractMigrationOrdinal(file) as number,
  }));
}

/** Includes `module-*.ts` fixups: a same-name port can land under either shape. */
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
  ours?: string; // defaults to origin/main, not whatever HEAD happens to be checked out
  theirs?: string; // defaults to upstream/main
}

/** Read-only: merge-tree is in-memory. `origin` is fetched too, or a stale checkout would report a stale trunk. */
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

  // ratchet:report measures the physical working tree, not a ref, so it runs only when HEAD is `ours`; otherwise
  // its summary would contradict the rest of the report.
  const oursMatchesCheckout = git(['rev-parse', 'HEAD'], repoRoot).trim() === git(['rev-parse', ours], repoRoot).trim();

  let ratchetSummary: string | null = null;
  const packageJsonPath = path.join(repoRoot, 'package.json');
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
    if (oursMatchesCheckout && packageJson.scripts && 'ratchet:report' in packageJson.scripts) {
      const output = execTolerant('pnpm', ['run', 'ratchet:report'], repoRoot, 1, 16 * 1024 * 1024);
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
