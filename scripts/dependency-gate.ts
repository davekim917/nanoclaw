/**
 * Dependency gate (docs/dependency-updates.md): a runtime version change needs a behaviour-change ledger, and a change
 * on a live I/O path needs a real-library test of that path, because mocked adapter tests pass through wire changes.
 *
 *   pnpm exec tsx scripts/dependency-gate.ts check [--base <rev>]   (default base: merge-base HEAD origin/main)
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { parse as parseYaml } from 'yaml';

import {
  DEPENDENCY_PATHS_FILE as REGISTRY_PATH,
  readDependencyPathRegistry,
  untestedLivePaths,
  type DependencyPathRegistry as Registry,
} from '../src/dependency-paths.js';

export const LEDGER_DIR = 'docs/dependency-changes';
const LIVE_PATH_TEST = /live-path[^/]*\.test\.ts$/;

export interface DependencyFiles {
  hostPackageJson: string | null;
  pnpmLock: string | null;
  runnerPackageJson: string | null;
  bunLock: string | null;
  remotionPackageJson: string | null;
  remotionLock: string | null;
  dockerfile: string | null;
  updateSources: string | null;
}

export const DEPENDENCY_FILE_PATHS: Record<keyof DependencyFiles, string> = {
  hostPackageJson: 'package.json',
  pnpmLock: 'pnpm-lock.yaml',
  runnerPackageJson: 'container/agent-runner/package.json',
  bunLock: 'container/agent-runner/bun.lock',
  remotionPackageJson: 'container/remotion/package.json',
  remotionLock: 'container/remotion/pnpm-lock.yaml',
  dockerfile: 'container/Dockerfile',
  updateSources: 'container/update-sources.json',
};

function add(map: Map<string, Set<string>>, name: string, version: string): void {
  let versions = map.get(name);
  if (!versions) {
    versions = new Set();
    map.set(name, versions);
  }
  versions.add(version);
}

/** `@scope/name@1.2.3` → [`@scope/name`, `1.2.3`]; the name's own leading `@` is not the separator. */
function splitSpec(spec: string): [string, string] | null {
  const at = spec.lastIndexOf('@');
  return at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : null;
}

function dockerPins(dockerfile: string, updateSources: string): Array<{ id: string; version: string }> {
  const items = (JSON.parse(updateSources) as { dockerfile?: Array<{ id: string; arg: string }> }).dockerfile ?? [];
  return items.flatMap(({ id, arg }) => {
    const match = new RegExp(`^ARG ${arg}=(\\S+)\\s*$`, 'm').exec(dockerfile);
    return match ? [{ id, version: match[1]! }] : [];
  });
}

export function lockedVersions(files: DependencyFiles): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  for (const pnpmLock of [files.pnpmLock, files.remotionLock]) {
    if (!pnpmLock) continue;
    const lock = parseYaml(pnpmLock) as { packages?: Record<string, unknown> };
    for (const key of Object.keys(lock.packages ?? {})) {
      const spec = splitSpec(key.replace(/\(.*$/, ''));
      if (spec) add(versions, spec[0], spec[1]);
    }
  }
  if (files.bunLock) {
    for (const match of files.bunLock.matchAll(/^\s+"[^"]+": \["([^"]+)"/gm)) {
      const spec = splitSpec(match[1]!);
      if (spec) add(versions, spec[0], spec[1]);
    }
  }
  if (files.dockerfile && files.updateSources) {
    for (const { id, version } of dockerPins(files.dockerfile, files.updateSources))
      add(versions, `docker:${id}`, version);
  }
  return versions;
}

export function directDependencies(files: DependencyFiles): Set<string> {
  const names = new Set<string>();
  for (const manifest of [files.hostPackageJson, files.runnerPackageJson, files.remotionPackageJson]) {
    if (!manifest) continue;
    const json = JSON.parse(manifest) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(json[field] ?? {})) names.add(name);
    }
  }
  if (files.updateSources) {
    const items = (JSON.parse(files.updateSources) as { dockerfile?: Array<{ id: string }> }).dockerfile ?? [];
    for (const { id } of items) names.add(`docker:${id}`);
  }
  return names;
}

/** `patches/@scope__name@1.2.3.patch` names `@scope/name`. */
export function patchedPackage(changedPath: string): string | null {
  const match = /^patches\/(.+)@[^@/]+\.patch$/.exec(changedPath);
  return match ? match[1]!.replace('__', '/') : null;
}

export interface PackageChange {
  name: string;
  from: string;
  to: string;
}

function versionList(versions: Set<string> | undefined): string {
  return versions && versions.size > 0 ? [...versions].sort().join(',') : 'none';
}

export function packageChanges(
  base: Map<string, Set<string>>,
  head: Map<string, Set<string>>,
  patched: Iterable<string>,
): PackageChange[] {
  const names = new Set([...base.keys(), ...head.keys(), ...patched]);
  const patchedSet = new Set(patched);
  const changes: PackageChange[] = [];
  for (const name of [...names].sort()) {
    const from = versionList(base.get(name));
    const to = versionList(head.get(name));
    if (from !== to || patchedSet.has(name)) changes.push({ name, from, to });
  }
  return changes;
}

export function registryProblems(registry: Registry, direct: Set<string>, exists: (file: string) => boolean): string[] {
  const problems: string[] = [];
  for (const name of [...direct].sort()) {
    if (!registry.packages[name]) {
      problems.push(
        `${name} is a direct dependency with no entry in ${REGISTRY_PATH}; classify it as dev, runtime, or live with the live paths it is on`,
      );
    }
  }
  for (const [name, cls] of Object.entries(registry.packages)) {
    if (cls.kind !== 'live') continue;
    if (cls.paths.length === 0) problems.push(`${name} is classified live but names no live path`);
    for (const id of cls.paths) {
      if (!registry.livePaths[id])
        problems.push(`${name} names live path ${id}, which ${REGISTRY_PATH} does not define`);
    }
  }
  for (const [id, livePath] of Object.entries(registry.livePaths)) {
    for (const test of livePath.tests) {
      if (!LIVE_PATH_TEST.test(test)) {
        problems.push(
          `live path ${id} lists ${test}; a live-path test's file name must contain "live-path" so CI runs it`,
        );
      } else if (!exists(test)) {
        problems.push(`live path ${id} lists ${test}, which does not exist`);
      }
    }
  }
  return problems;
}

type Coverage = { kind: 'test'; path: string } | { kind: 'uncovered'; reason: string } | null;

export interface LedgerSection {
  from: string;
  to: string;
  source: string;
  entries: Array<{ text: string; coverage: Coverage }>;
  file: string;
}

/**
 * A ledger section per package: `## <name> <from> → <to>`, a `Source:` line naming the changelog read, then one
 * bullet per behaviour change ending in `· test: <path>` or `· not covered: <reason>`.
 */
export function parseLedger(file: string, text: string): Map<string, LedgerSection> {
  const sections = new Map<string, LedgerSection>();
  let current: LedgerSection | null = null;
  for (const line of text.split('\n')) {
    const heading = /^## (\S+) (\S+) → (\S+)\s*$/.exec(line);
    if (heading) {
      current = { from: heading[2]!, to: heading[3]!, source: '', entries: [], file };
      sections.set(heading[1]!, current);
      continue;
    }
    if (/^#{1,2} /.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const source = /^Source:\s*(\S.*)$/.exec(line);
    if (source) {
      current.source = source[1]!.trim();
      continue;
    }
    const bullet = /^- (.+)$/.exec(line);
    if (!bullet) continue;
    const test = /^(.*\S)\s+· test: (\S+)\s*$/.exec(bullet[1]!);
    const uncovered = /^(.*\S)\s+· not covered: (\S.*)$/.exec(bullet[1]!);
    current.entries.push(
      test
        ? { text: test[1]!, coverage: { kind: 'test', path: test[2]! } }
        : uncovered
          ? { text: uncovered[1]!, coverage: { kind: 'uncovered', reason: uncovered[2]!.trim() } }
          : { text: bullet[1]!, coverage: null },
    );
  }
  return sections;
}

export function changeProblems(
  registry: Registry,
  changes: PackageChange[],
  ledgers: Array<{ file: string; text: string }>,
  exists: (file: string) => boolean,
): string[] {
  const problems: string[] = [];
  const sections = new Map<string, LedgerSection>();
  for (const { file, text } of ledgers) {
    for (const [name, section] of parseLedger(file, text)) sections.set(name, section);
  }
  for (const change of changes) {
    const cls = registry.packages[change.name];
    if (!cls || cls.kind === 'dev') continue;
    const label = `${change.name} ${change.from} → ${change.to}`;

    if (cls.kind === 'live') {
      const untested = untestedLivePaths(registry, change.name);
      if (untested.length > 0) {
        problems.push(
          `${label} is on live I/O path(s) with no real-library test: ${untested.map((id) => `${id} (${registry.livePaths[id]!.description})`).join('; ')}. Add a test for each and list it in ${REGISTRY_PATH} before this change can merge`,
        );
      }
    }

    const section = sections.get(change.name);
    if (!section) {
      problems.push(
        `${label} changes runtime behaviour but no ${LEDGER_DIR}/ file this change adds or edits has a "## ${label}" section`,
      );
      continue;
    }
    const where = `${section.file}, ${change.name}`;
    if (section.from !== change.from || section.to !== change.to) {
      problems.push(
        `${where}: the heading says ${section.from} → ${section.to}, the lockfiles say ${change.from} → ${change.to}`,
      );
    }
    if (!section.source) problems.push(`${where}: no "Source:" line naming the changelog or release notes read`);
    if (section.entries.length === 0) {
      problems.push(
        `${where}: no entries; list each behaviour change, or one entry saying the changelog lists none, each ending in "· test: <path>" or "· not covered: <reason>"`,
      );
    }
    for (const entry of section.entries) {
      if (!entry.coverage) {
        problems.push(`${where}: "${entry.text}" ends in neither "· test: <path>" nor "· not covered: <reason>"`);
      } else if (entry.coverage.kind === 'test' && !exists(entry.coverage.path)) {
        problems.push(`${where}: "${entry.text}" cites ${entry.coverage.path}, which does not exist`);
      }
    }
  }
  return problems;
}

function git(root: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function filesAt(root: string, rev: string | null): DependencyFiles {
  const read = (file: string): string | null => {
    if (rev === null) {
      const full = path.join(root, file);
      return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    }
    const shown = git(root, ['show', `${rev}:${file}`]);
    return shown.ok ? shown.stdout : null;
  };
  return Object.fromEntries(
    Object.entries(DEPENDENCY_FILE_PATHS).map(([key, file]) => [key, read(file)]),
  ) as unknown as DependencyFiles;
}

export function runCheck(root: string, base: string): string[] {
  const exists = (file: string): boolean => fs.existsSync(path.join(root, file));
  const registry = readDependencyPathRegistry(root);
  if (!registry) throw new Error(`dependency-gate: ${REGISTRY_PATH} is missing`);
  const head = filesAt(root, null);
  const problems = registryProblems(registry, directDependencies(head), exists);

  const diff = git(root, ['diff', '--name-only', '--no-renames', base]);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']);
  if (!diff.ok || !untracked.ok) throw new Error(`dependency-gate: cannot diff against ${base}: ${diff.stderr}`);
  const changedFiles = [...diff.stdout.split('\n'), ...untracked.stdout.split('\n')].filter(Boolean);
  const patched = changedFiles.map(patchedPackage).filter((name): name is string => name !== null);
  const changes = packageChanges(lockedVersions(filesAt(root, base)), lockedVersions(head), patched);
  const ledgers = changedFiles
    .filter((file) => file.startsWith(`${LEDGER_DIR}/`) && file.endsWith('.md') && exists(file))
    .map((file) => ({ file, text: fs.readFileSync(path.join(root, file), 'utf8') }));
  return [...problems, ...changeProblems(registry, changes, ledgers, exists)];
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command !== 'check') {
    console.error('usage: tsx scripts/dependency-gate.ts check [--base <rev>]');
    return 2;
  }
  const root = process.cwd();
  const baseFlag = rest.indexOf('--base');
  let base = baseFlag >= 0 ? rest[baseFlag + 1] : undefined;
  if (!base) {
    const mergeBase = git(root, ['merge-base', 'HEAD', 'origin/main']);
    if (!mergeBase.ok) {
      console.error(`dependency-gate: cannot find the merge base of HEAD and origin/main: ${mergeBase.stderr.trim()}`);
      return 1;
    }
    base = mergeBase.stdout.trim();
  }
  const problems = runCheck(root, base);
  for (const problem of problems) console.error(`dependency-gate: ${problem}`);
  console.log(`dependency-gate: ${problems.length} problem(s) against ${base.slice(0, 12)}`);
  return problems.length === 0 ? 0 : 1;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = main(process.argv.slice(2));
}
